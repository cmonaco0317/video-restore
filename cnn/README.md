# TinySR — the neural upscaler

A 1540-parameter luma-doubling CNN, trained here and shipped as generated WebGL2
fragment shaders (`../cnn-weights.js`).

## Why train instead of porting

Every permissively-licensed real-time upscaler is **anime-trained** (ArtCNN and
Anime4K, both MIT). The two trained on live action are **FSRCNNX (GPL-3.0)** and
**RAVU (LGPL-3.0)** — embedding either would relicense the extension as copyleft.
And ArtCNN's GLSL is *compute* shaders, which **WebGL2 does not have at all**.

So: own architecture, own weights, live-action training data.

## Why this size

WebGL2 has no compute shaders, so feature maps are RGBA textures and a conv
layer costs `(N/4)` output passes x 9 offsets x `(N/4)` input textures of texture
fetches per pixel — 36 at N=8 but **144 at N=16**. Eight filters fits the frame
budget; sixteen does not. Multiple Render Targets let one pass write both
feature halves, and ReLU is applied on read, so four layers are four passes.

## Data

Tears of Steel (2012), **CC BY 3.0, (CC) Blender Foundation | mango.blender.org**
— a live-action VFX production, which is the domain that matters. HR targets are
a mild downscale of the 720p release, because shrinking suppresses the h264
artifacts that would otherwise teach the model to *produce* compression
artifacts. LR is a box downsample in gamma light (video is authored and shown in
gamma; training on linearly-downsampled pairs teaches the model to undo the
wrong thing).

Splits are by **whole frame**, never by patch — crops from one frame share
content, and splitting by patch leaks validation into training.

There are **three** splits. Once several training configurations are compared,
picking the winner by validation score makes that score optimistic by however
hard you searched. The test frames are read exactly once, to report.

## Results (TEST split — frames that influenced no decision)

Trained on **900 frames** (21,534 patches) as of 2026-08-10:

| upscaler | PSNR | vs Lanczos-3 |
|---|---|---|
| bilinear | 26.655 dB | −0.414 |
| lanczos3 | 27.069 dB | — |
| bicubic | 27.080 dB | +0.011 |
| **TinySR** | **28.347 dB** | **+1.278** |

Compare like for like — *gain over Lanczos-3 on each model's own untouched test
split*, so differences in split difficulty cancel. Raw PSNR across different
splits is not comparable.

**It was DATA-limited, not architecture-limited.** The same architecture trained
on 320 frames scored **+1.016**; 900 frames scored **+1.278**. Before finding
that, four architectures were compared under identical conditions and the
shipped one won outright (validation): baseline 8f/4L **31.111**, plus ArtCNN's
long skip 31.017, six layers 31.072, six layers plus skip 30.332. Adding a
residual connection and adding depth were both tried; neither helps.

An earlier **+1.762 dB** was a *validation* figure taken after three runs had
been compared, i.e. inflated by selection. Never quote it.

## One thing that was measured and rejected

**Dihedral augmentation made it worse** — +1.253 dB with vertical flips and 90°
rotations versus +1.762 dB without (both validation, same conditions). Video is
not isotropic, and forcing 8-fold symmetry on 1540 parameters spends capacity on
symmetry rather than content. Horizontal flip only. Do not re-add rotations
because they "obviously" help; they were tried.

## …and one that was rejected here and then built anyway

This file used to say *"motion-compensated temporal was not built — the chain
already costs 11.4 ms of the 16.7 ms budget, and motion estimation would push it
over."* That was a budget judgement, and it was wrong.

It was built: Lucas-Kanade sub-pixel alignment solved at quarter resolution with
full-resolution taps, feeding iterative back-projection. Together they cost
**1.59 ms**, and the shipped chain sits at **10.54 ms** of the 16.7 ms budget —
so the pass that was declined as unaffordable turned out to fit with 6 ms to
spare. It is also the only stage in the whole engine that adds information rather
than redistributing it (+0.29 dB isolated by the copies-vs-real-frames ablation).

The lesson is not "motion estimation is cheap". It is that a cost estimated
rather than measured is a guess, and this one was out by roughly 4×. See
`../STATE.md`.

## Reproduce

```bash
python3 -m venv .venv && .venv/bin/pip install numpy torch pillow \
  --index-url https://download.pytorch.org/whl/cpu
curl -L -o data/tos_720p.mov \
  https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov
.venv/bin/python train.py prepare
.venv/bin/python train.py train
.venv/bin/python train.py eval
.venv/bin/python train.py export && .venv/bin/python make_shader.py
.venv/bin/python dump_ref.py     # refresh the GLSL-vs-PyTorch fixture
```

CPU only — PyTorch MPS is known to freeze this machine, and the model is far too
small to need a GPU.
