#!/usr/bin/env python3
"""
Train the tiny luma-doubling CNN used by the extension's neural upscaler, and
export its weights as a GLSL shader.

Why this shape:

  * LUMA ONLY. Chroma is stored at quarter resolution in 4:2:0 anyway and the
    engine already has a dedicated chroma reconstruction pass. Every good mpv
    upscaler (FSRCNNX, RAVU, ArtCNN) is a luma doubler for the same reason.

  * 8 FILTERS, 4 LAYERS. 16 was tried and MEASURED, twice over. The fetch-cost
    objection to it was wrong (MRT amortises fetches, so 8 and 16 read the same
    36 per layer), but the ALU cost is real: 16 filters measured 14.62 ms/frame
    against 4.88 for 8, which breaks the 60 fps budget outright — and bought
    +0.19 dB on the case that matters. Not worth 3x the GPU. Do not "upgrade"
    this to 16 without re-running the perf gate.

  * RESIDUAL + PIXEL SHUFFLE. The net predicts 4 channels at source resolution
    which are rearranged into one 2x-resolution residual and ADDED to a plain
    upscale. Learning only the difference is far easier than learning the image.

Training pairs come from Tears of Steel (CC BY 3.0, Blender Foundation) — real
live-action video, which is the domain that actually matters here and the one
every permissively-licensed pretrained model gets wrong (ArtCNN and Anime4K are
both anime-trained).

Usage:  python train.py prepare | train | export | eval
"""

import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
VIDEO = DATA / "tos_720p.mov"
FRAMES = DATA / "frames"
PATCHES = DATA / "patches.npz"
CKPT = HERE / "model.pt"

# HR is a mild downscale of the 720p source: shrinking suppresses the h264
# artifacts that would otherwise become part of the reconstruction target and
# teach the model to *produce* compression artifacts.
# Source is 1280x534 (2.40:1 scope), NOT 16:9 — scaling to a 16:9 box would
# stretch every training frame and teach the model a distorted world.
HR_W, HR_H = 960, 400
PATCH_HR = 96  # HR patch size; LR patch is half this
SCALE = 2
FILTERS = 8
LAYERS = 4

torch.manual_seed(1234)
np.random.seed(1234)


# --------------------------------------------------------------------- data


def extract_frames(n=320):
    """Pull n frames spread across the whole film, as PNG."""
    if not VIDEO.exists():
        sys.exit(f"missing {VIDEO} — download it first")
    FRAMES.mkdir(parents=True, exist_ok=True)
    existing = sorted(FRAMES.glob("*.png"))
    if len(existing) >= n:
        print(f"  {len(existing)} frames already extracted")
        return existing

    dur = float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(VIDEO),
            ]
        )
        .decode()
        .strip()
    )
    # Skip the first and last 30s (titles / credit scroll are not representative)
    lo, hi = 30.0, max(60.0, dur - 30.0)
    fps = n / (hi - lo)
    print(f"  film is {dur:.0f}s; sampling {n} frames from {lo:.0f}-{hi:.0f}s")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            str(lo),
            "-to",
            str(hi),
            "-i",
            str(VIDEO),
            "-vf",
            f"fps={fps:.6f},scale={HR_W}:{HR_H}:flags=lanczos",
            "-frames:v",
            str(n),
            str(FRAMES / "f%04d.png"),
        ],
        check=True,
    )
    return sorted(FRAMES.glob("*.png"))


def luma_of(png_path):
    """BT.709 luma in [0,1], float32, from a PNG."""
    from PIL import Image

    im = Image.open(png_path).convert("RGB")
    a = np.asarray(im, dtype=np.float32) / 255.0
    return (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]).astype(
        np.float32
    )


def degrade(lr, rng):
    """Make LR look like a real source: compressed, not merely downsampled.

    THE point of this change. Training on clean->downsampled pairs teaches the
    network to invert DOWNSAMPLING, which is not the problem real footage has.
    A streamed or ripped file is wrecked by COMPRESSION — block edges, mosquito
    noise, smeared chroma — and a model that has never seen a block artifact in
    training has no reason to remove one. Encoding each LR patch as JPEG at a
    random quality puts exactly those artifacts in the input while the target
    stays clean, so the network learns to repair as well as magnify.

    A share of pairs are left untouched so a good source is not over-smoothed.
    """
    if rng.random() < 0.25:
        return lr  # keep some clean pairs
    import io
    from PIL import Image

    q = int(rng.integers(18, 72))  # spans "bad rip" to "decent stream"
    buf = io.BytesIO()
    Image.fromarray((np.clip(lr, 0, 1) * 255).astype(np.uint8), mode="L").save(
        buf, format="JPEG", quality=q
    )
    buf.seek(0)
    return np.asarray(Image.open(buf), dtype=np.float32) / 255.0


def downsample2(hr):
    """
    HR -> LR by exactly 2, in GAMMA light with a box filter.

    Gamma, not linear, on purpose: video is authored and displayed in gamma
    space and every comparable shader is trained that way. Training on linearly
    downsampled pairs produces a model that dilates darks and erodes brights
    when fed ordinary content, because it has learned to undo the wrong thing.
    """
    h, w = hr.shape
    hr = hr[: h - h % 2, : w - w % 2]
    return hr.reshape(hr.shape[0] // 2, 2, hr.shape[1] // 2, 2).mean(axis=(1, 3))


def build_patches(frames, per_frame=24):
    """Random HR/LR patch pairs, skipping flat patches that teach nothing.

    Also records the source frame of every patch. The train/val split MUST be by
    frame: patches cropped from the same frame share content, so splitting by
    patch leaks the validation set into training and flatters the score.
    """
    hrs, lrs, src = [], [], []
    rng = np.random.default_rng(7)
    for i, f in enumerate(frames):
        y = luma_of(f)
        lr_full = degrade(downsample2(y), rng)
        H, W = y.shape
        tries = 0
        got = 0
        while got < per_frame and tries < per_frame * 12:
            tries += 1
            ty = int(rng.integers(0, H - PATCH_HR))
            tx = int(rng.integers(0, W - PATCH_HR))
            ty -= ty % 2
            tx -= tx % 2
            hp = y[ty : ty + PATCH_HR, tx : tx + PATCH_HR]
            # A flat patch carries no super-resolution signal; it just biases
            # the model toward doing nothing.
            if hp.std() < 0.035:
                continue
            lp = lr_full[
                ty // 2 : ty // 2 + PATCH_HR // 2, tx // 2 : tx // 2 + PATCH_HR // 2
            ]
            hrs.append(hp)
            lrs.append(lp)
            src.append(i)
            got += 1
        if (i + 1) % 40 == 0:
            print(f"  {i+1}/{len(frames)} frames -> {len(hrs)} patches")
    return (
        np.stack(lrs).astype(np.float32),
        np.stack(hrs).astype(np.float32),
        np.asarray(src, dtype=np.int32),
    )


def cmd_prepare(args):
    print("extracting frames…")
    frames = extract_frames(args.frames)
    print(f"building patches from {len(frames)} frames…")
    lr, hr, src = build_patches(frames, args.per_frame)
    DATA.mkdir(exist_ok=True)
    np.savez_compressed(PATCHES, lr=lr, hr=hr, src=src)
    print(
        f"saved {lr.shape[0]} pairs -> {PATCHES} "
        f"(LR {lr.shape[1]}x{lr.shape[2]}, HR {hr.shape[1]}x{hr.shape[2]})"
    )


# -------------------------------------------------------------------- model


class TinySR(nn.Module):
    """conv(1->F) -> [conv(F->F)]*(L-2) -> conv(F->4) -> pixel-shuffle -> +bicubic"""

    def __init__(self, filters=FILTERS, layers=LAYERS, skip=False):
        super().__init__()
        # padding_mode="replicate", NOT the default zeros: the shader samples
        # with CLAMP_TO_EDGE, so zero padding would make the trained model and
        # its GLSL port disagree along every frame border. Replicate is also the
        # better behaviour on real frames — zero padding darkens the edge.
        #
        # `skip` adds ArtCNN's long skip connection: the first layer's features
        # are added back just before the output conv. Costs one extra texture
        # read in the cheapest pass and nothing in parameters. Width costs
        # QUADRATICALLY here ((N/4)^2 fetches) while depth costs LINEARLY, which
        # is why 8 filters x 6 layers is affordable where 16 x 4 was not — the
        # earlier search only ever tried widening.
        self.skip = skip
        ch = [1] + [filters] * (layers - 1)
        self.convs = nn.ModuleList(
            nn.Conv2d(ch[i], filters, 3, padding=1, padding_mode="replicate")
            for i in range(layers - 1)
        )
        self.out = nn.Conv2d(
            filters, SCALE * SCALE, 3, padding=1, padding_mode="replicate"
        )
        # Start as a no-op: the residual begins at zero, so the model starts
        # exactly at the bilinear baseline and can only improve from there.
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, x):
        base = F.interpolate(
            x, scale_factor=SCALE, mode="bilinear", align_corners=False
        )
        h = x
        first = None
        for i, c in enumerate(self.convs):
            h = F.relu(c(h))
            if i == 0:
                first = h
        if self.skip and first is not None:
            h = h + first
        res = F.pixel_shuffle(self.out(h), SCALE)
        return base + res


def split_frames(src):
    """Train / val / test, split by whole frame.

    THREE splits, not two. Once you compare several training configurations you
    are selecting on the validation set, and the winner's val score is optimistic
    by however hard you searched. The test frames are touched exactly once, to
    report — never to choose.
    """
    frames_all = np.unique(src)
    shuffled = np.random.default_rng(3).permutation(frames_all)
    k = max(1, int(len(shuffled) * 0.12))
    val_f = set(shuffled[:k].tolist())
    test_f = set(shuffled[k : 2 * k].tolist())
    mv = np.isin(src, list(val_f))
    mt = np.isin(src, list(test_f))
    return np.nonzero(~(mv | mt))[0], np.nonzero(mv)[0], np.nonzero(mt)[0]


def cmd_train(args):
    d = np.load(PATCHES)
    lr, hr, src = d["lr"], d["hr"], d["src"]
    n = lr.shape[0]
    # Hold out whole FRAMES. Splitting by patch would put crops of the same
    # shot on both sides of the split and inflate validation PSNR.
    tr, va, te = split_frames(src)
    print(
        f"{n} pairs from {len(np.unique(src))} frames -> "
        f"{len(tr)} train / {len(va)} val / {len(te)} test"
    )

    lr_t = torch.from_numpy(lr).unsqueeze(1)
    hr_t = torch.from_numpy(hr).unsqueeze(1)

    filters = getattr(args, 'filters', None) or FILTERS
    layers = getattr(args, 'layers', None) or LAYERS
    skip = bool(getattr(args, 'skip', False))
    torch.manual_seed(getattr(args, 'seed', 0))
    model = TinySR(filters, layers, skip)
    nparams = sum(p.numel() for p in model.parameters())
    print(f"model: {filters} filters x {layers} layers skip={skip} = {nparams} parameters")

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    def psnr(a, b):
        mse = float(((a - b) ** 2).mean())
        return 10 * math.log10(1.0 / max(mse, 1e-12))

    best = -1.0
    for ep in range(args.epochs):
        model.train()
        perm = np.random.default_rng(ep).permutation(len(tr))
        tot = 0.0
        for i in range(0, len(tr), args.batch):
            b = tr[perm[i : i + args.batch]]
            x, y = lr_t[b], hr_t[b]
            # HORIZONTAL FLIP ONLY. Full dihedral augmentation (adding vertical
            # flips and 90-degree rotations) was measured and made this model
            # WORSE: +1.253 dB vs +1.762 dB over Lanczos-3. Video is not
            # isotropic — horizons, gravity and motion blur all have direction —
            # and forcing 8-fold symmetry on 1540 parameters spends capacity on
            # symmetry instead of content. Augmentation that helps a large
            # network can hurt a capacity-starved one.
            if np.random.rand() < 0.5:
                x, y = torch.flip(x, [3]), torch.flip(y, [3])
            opt.zero_grad()
            out = model(x)
            loss = F.l1_loss(out, y)  # L1 beats L2 perceptually for SR
            loss.backward()
            opt.step()
            tot += float(loss) * len(b)
        sched.step()

        model.eval()
        with torch.no_grad():
            vo = model(lr_t[va])
            vp = psnr(vo.clamp(0, 1), hr_t[va])
            bp = psnr(
                F.interpolate(
                    lr_t[va], scale_factor=2, mode="bilinear", align_corners=False
                ).clamp(0, 1),
                hr_t[va],
            )
        print(
            f"  epoch {ep+1:3d}/{args.epochs}  train L1 {tot/len(tr):.5f}  "
            f"val PSNR {vp:.3f} dB  (bilinear {bp:.3f} dB, +{vp-bp:.3f})"
        )
        if vp > best:
            best = vp
            torch.save(
                {
                    "state": model.state_dict(),
                    "psnr": vp,
                    "bilinear": bp,
                    "filters": filters,
                    "layers": layers,
                    "skip": skip,
                },
                getattr(args, "ckpt", None) or CKPT,
            )
    print(f"best val PSNR {best:.3f} dB -> {getattr(args, 'ckpt', None) or CKPT}")


# ------------------------------------------------------------------- export


def cmd_export(args):
    ck = torch.load(CKPT, map_location="cpu", weights_only=True)
    model = TinySR(ck["filters"], ck["layers"], ck.get("skip", False))
    model.load_state_dict(ck["state"])
    model.eval()

    w = {k: v.detach().numpy() for k, v in model.state_dict().items()}
    out = {
        "filters": ck["filters"],
        "layers": ck["layers"],
        "scale": SCALE,
        "psnr": ck["psnr"],
        "bilinear": ck["bilinear"],
        "convs": [],
        "out": None,
    }
    for i in range(ck["layers"] - 1):
        out["convs"].append(
            {
                "w": w[f"convs.{i}.weight"].tolist(),
                "b": w[f"convs.{i}.bias"].tolist(),
            }
        )
    out["out"] = {"w": w["out.weight"].tolist(), "b": w["out.bias"].tolist()}
    (HERE / "weights.json").write_text(json.dumps(out))
    print(
        f"wrote weights.json  ({sum(v.size for v in w.values())} params, "
        f"val PSNR {ck['psnr']:.3f} dB vs bilinear {ck['bilinear']:.3f} dB)"
    )


def lanczos2x(x, a=3):
    """Separable Lanczos-3 2x upsample, matching the engine's classical path.

    Bilinear is a straw man — the engine already ships Lanczos-3 and EASU, so a
    neural upscaler only earns its place if it beats THOSE.
    """

    def kernel():
        # output sample centres land at -0.25 and +0.25 of a source pixel
        taps = []
        for phase in (-0.25, 0.25):
            w = []
            for i in range(-a, a + 1):
                d = i - phase
                if abs(d) >= a:
                    w.append(0.0)
                elif d == 0:
                    w.append(1.0)
                else:
                    pd = math.pi * d
                    w.append(math.sin(pd) / pd * math.sin(pd / a) / (pd / a))
            ssum = sum(w)
            taps.append([v / ssum for v in w])
        return taps

    taps = kernel()
    pad = a

    def interleave(parts, dim):
        lo, hi = parts
        shape = list(lo.shape)
        shape[dim] *= 2
        out = torch.empty(shape, dtype=lo.dtype)
        i0 = [slice(None)] * 4
        i1 = [slice(None)] * 4
        i0[dim] = slice(0, None, 2)
        i1[dim] = slice(1, None, 2)
        out[tuple(i0)] = lo
        out[tuple(i1)] = hi
        return out

    def axis(t, dim):
        padding = (pad, pad, 0, 0) if dim == 3 else (0, 0, pad, pad)
        t = F.pad(t, padding, mode="replicate")
        outs = []
        for ph in range(2):
            k = torch.tensor(taps[ph], dtype=t.dtype)
            k = k.view(1, 1, 1, -1) if dim == 3 else k.view(1, 1, -1, 1)
            outs.append(F.conv2d(t, k))
        return interleave(outs, dim)

    x = axis(x, 3)
    x = axis(x, 2)
    return x


def cmd_eval(args):
    ck = torch.load(getattr(args, "ckpt", None) or CKPT,
                   map_location="cpu", weights_only=True)
    model = TinySR(ck["filters"], ck["layers"], ck.get("skip", False))
    model.load_state_dict(ck["state"])
    model.eval()

    d = np.load(PATCHES)
    lr, hr, src = d["lr"], d["hr"], d["src"]
    _, _, te = split_frames(src)
    x = torch.from_numpy(lr[te]).unsqueeze(1)
    y = torch.from_numpy(hr[te]).unsqueeze(1)

    def psnr(a):
        mse = float(((a.clamp(0, 1) - y) ** 2).mean())
        return 10 * math.log10(1.0 / max(mse, 1e-12))

    with torch.no_grad():
        results = {
            "bilinear": psnr(
                F.interpolate(x, scale_factor=2, mode="bilinear", align_corners=False)
            ),
            "bicubic": psnr(
                F.interpolate(x, scale_factor=2, mode="bicubic", align_corners=False)
            ),
            "lanczos3": psnr(lanczos2x(x)),
            "TinySR (ours)": psnr(model(x)),
        }
    base = results["lanczos3"]
    print(f"TEST split (never used for selection): {len(te)} patches\n")
    for k, v in sorted(results.items(), key=lambda kv: kv[1]):
        print(f"  {k:16s} {v:7.3f} dB   ({v - base:+.3f} vs lanczos3)")
    gain = results["TinySR (ours)"] - base
    print(f"\nverdict: CNN beats Lanczos-3 by {gain:+.3f} dB")
    if gain < 0.15:
        print("  -> NOT worth the GPU cost; do not ship this.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--frames", type=int, default=320)
    p.add_argument("--per-frame", type=int, default=24)
    p.set_defaults(fn=cmd_prepare)
    p = sub.add_parser("train")
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--batch", type=int, default=64)
    p.add_argument("--lr", type=float, default=2e-3)
    p.add_argument("--filters", type=int, default=None)
    p.add_argument("--layers", type=int, default=None)
    p.add_argument("--skip", action="store_true",
                   help="ArtCNN-style long skip: add layer-1 features back before the output conv")
    p.add_argument("--ckpt", type=str, default=None,
                   help="write the checkpoint here instead of the default, so variants do not clobber each other")
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(fn=cmd_train)
    p = sub.add_parser("export")
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser("eval")
    p.add_argument("--ckpt", type=str, default=None)
    p.set_defaults(fn=cmd_eval)
    a = ap.parse_args()
    a.fn(a)
