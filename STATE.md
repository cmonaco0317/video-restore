# Video Upscaler — STATE

Chrome extension (MV3) that upscales and repairs whatever `<video>` is playing on
a page, compositing the result into the page so it survives screenshare, AirPlay
mirroring and HDMI.

**Read this file, then run `ledger status` here. The ledger is the machine-checked
truth; this prose is one session's account.**

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler"
ledger status
python3 test/run.py          # ~106-108 passed, 0 failed as of 2026-08-10
                             # (the count wobbles by 2: test/webgpu.html races the
                             #  headless runner's virtual clock during GPU init. It
                             #  never FAILS - one check is emitted synchronously so
                             #  'produced no checks at all' cannot fire.)
```

---

## Where it stands

Working and shipped. Load unpacked from this folder at `chrome://extensions`.
Full architecture, controls and the output-path matrix are in `README.md`; the
neural upscaler's whole story is in `cnn/README.md`.

**Verified (`ledger status`):** package loads · render pipeline correct ·
perf inside the 60 fps budget · max does not damage compressed video · the
neural stage is honestly characterised · **the restore stage measurably removes
compression damage** · **Rescue beats the old best preset on every source**.

**✅ The screenshare path is now PROVEN** (`tools/verify-screenshare.py`, a
ledger claim). Capturing the window with the upscaler off and then on, over a
still fixture whose frames are identical by construction, the video region moves
by a mean of 7.44/255 with 91.7% of sampled pixels changing. That is the same
window-server composite Zoom and Meet read. It matters because a plain `<video>`
does NOT always survive it — hardware overlay planes and protected pipelines are
why some screen recordings come out black, and compositing a canvas into the page
is precisely the design that avoids it.

**Still unproven, genuinely needs hardware:**
- `output-paths-external-display` — HDMI and AirPlay mirroring, plus the case
  where the player's own native AirPlay button is used and the upscale should be
  correctly ABSENT. This machine has one built-in display (`system_profiler`
  says Connection Type: Internal) and no AirPlay receivers were discoverable, so
  it cannot be tested here. Both consume the same composite the screenshare test
  just proved, which is strong evidence but not proof.
- `invocation-paths` — context menu, per-site auto-run, ON badge. **Still
  completely untested, and one attempt suggests it may be broken.** The
  screenshare probe first tried the real thing — extension loaded unpacked into a
  throwaway profile, `Cmd+Shift+U` sent via System Events — and *nothing
  happened*: no panel, no change in the capture. That is not evidence the
  shortcut is broken (the fixture was a black frame at the time, the keystroke
  may have needed Accessibility permission, and the extension's own black-frame
  probe demotes after three strikes), but it is a reason to test this properly
  rather than assume. The probe now loads `content.js` directly from the page,
  which exercises the RENDERING path and says nothing at all about injection.

---

## The honest quality verdict

Carter tested it on a low-bitrate movie rip and on YouTube 1080p. It looks
**better but not dramatically better**, and the measurements agree with him.

At ~1.6–2× magnification on an already-compressed source there is very little for
an upscaler to recover: the detail was destroyed by the encoder, not by the
scaler. Everything here repaired *scaling* damage; the dominant visual problem in
real footage is *compression* damage.

**2026-08-10: the artifact-removal half now exists** (`deblock` + `dering`, and
the `rescue` preset). It is the first stage in this project aimed at compression
rather than scaling, and it is measured, not asserted: on a plate crushed to
JPEG q=0.12 it removes **75% of the excess blockiness** and moves the pixels on
the transform grid **+0.85 dB** toward the clean original while the block
interiors move only +0.13 dB. It costs 1.40 ms/frame and moves a *clean* plate
by 1.38 of 255 levels, so it is safe to leave on.

**That changes the picture on a bad source. It does not change the ceiling.**
The lost detail is still lost — artifact removal takes the mess off the top of
what survived, it does not reconstruct what was thrown away. The remaining
levers are unchanged: a better source, then fullscreen (3–4× magnification).

**Do not promise "poor → genuinely great".** It is not achievable and saying so
cost credibility twice. "Visibly cleaner, still soft" is the truthful claim.

---

## Hard-won gotchas — read before changing anything

**🔴 Metrics: "more detail" is not "better".** On a compressed source, amplified
artifact and recovered detail are the *same high-frequency energy*. ~60 tests were
green while the picture was visibly wrecked, because every one of them asked "is
there more detail?". The only honest reconstruction metric is **distance to a
clean original** (`test/clean.png` + `test/lowbitrate.png` + `test/lr_*.png`).
That test caught `max` sitting **7.07 dB worse than doing nothing**.

**🔴 But PSNR cannot judge a LOOK.** Detail / Vibrance / Shadows deliberately
deviate from the original, so distance-to-truth drives them monotonically to
zero (measured: optimal detail = 0 on *both* clean and compressed). Use
ground-truth PSNR for reconstruction stages only (denoise, deband, chroma,
upscaler); the look stages are a taste dial no metric here can set.

**🔴 Local contrast is the destructive stage.** Ablated against ground truth on a
crf45 rip: denoise 24.51, deband 24.50, sharpen 24.47, chroma 24.41, **detail
23.23** (untouched 24.50). It boosts the 8–64 px band, exactly where DCT blocking
and mosquito noise live. `max` keeps it at 0.12.

**🔴 A tab reload does NOT reload an extension.** Chrome caches extension code
until you hit reload on `chrome://extensions`. Several "fixes didn't work" reports
traced to this.

**🔴 Named presets must re-derive from code.** Saved settings used to override
preset *definitions*, so retuning a preset never reached anyone who had already
picked it. `reconcilePreset()` fixes this; only `preset === 'custom'` restores
saved values verbatim.

**🔴 The engine uploads with `UNPACK_FLIP_Y_WEBGL`.** Convolution is *not*
flip-invariant, so the CNN's vertical kernel taps are negated AND the pixel-shuffle
row parity is inverted. Fixing either alone makes the error *worse*. Also train
with `padding_mode="replicate"` to match `CLAMP_TO_EDGE`, or borders are out by
~54/255 while the interior looks perfect.

**🔴 The DCT grid must be walked in PICTURE space, not texture space.** Same
flip trap as above, second victim. Frames upload flipped, so texture row 0 is the
bottom picture row; the transform grid is anchored at the picture's top-left, so
a deblocker that takes `mod(texture_row, 8)` is off by `height mod 8` rows. It
happens to be right on a 1080-high frame and silently wrong on anything else —
the worst kind of bug. `FRAG_RESTORE` computes `uSrcSize.y - 1 - gl_FragCoord.y`
and converts the step direction, rather than relying on the dimensions being
lucky.

**🔴 A metric defined on the same grid as the filter proves nothing.** Blockiness
measures gradients at `x % 8 == 0`; the deblocker edits pixels at `x % 8 == 0`.
They share a null space, so the metric will happily report success for a filter
that is simply smearing the grid. The check that carries the weight is
ground-truth PSNR **split into grid pixels and interior pixels**: a real
deblocker moves the grid much more than the interior (+0.85 vs +0.13 dB), a blur
moves both alike or moves them backwards. Keep both instruments.

**🔴 `object-fit: cover` is what YouTube uses.** An early build refused GPU mode
on that keyword and silently ran the whole site in CSS-filter mode.

**🔴 Benchmarks silently omit new stages.** The perf test has understated itself
twice by not enabling a stage that had just been added. `gl.finish()` is not a
reliable GPU sync on ANGLE/Metal — use a blocking `readPixels`.

---

## Measured and rejected (do not re-attempt)

| tried | result |
|---|---|
| Neural upscaler on by default | +0.09 dB compressed, **−0.11 dB clean** vs EASU, 4.52 ms/frame. Off by default: it fits the budget (15.06 ms of 16.7 with everything on) but does not earn the time. ⚠️ A reading of 17.11 ms that briefly suggested it no longer fits was taken while a CPU training job was saturating the machine — **perf numbers from a loaded machine are not perf numbers.** |
| **A bigger CNN** | Tried at 16 filters (14.62 ms, breaks the budget) and re-tested in WebGPU compute with f16 (11.11 ms, still breaks it). ✅ **The actual limiter was DATA:** the same architecture on 900 frames instead of 320 went from +1.016 to +1.278 dB over Lanczos-3. Retrained and shipped; still off by default because it still does not beat the classical path. |
| 16-filter CNN | 14.62 ms/frame vs 4.88, breaks 60 fps, for +0.19 dB. (The *fetch-cost* objection to 16 was wrong — MRT amortises fetches — but the ALU cost is real.) |
| Dihedral augmentation | +1.253 dB vs +1.762 dB. Video is not isotropic; 1540 params cannot afford symmetry. Horizontal flip only. |
| Luma-weighted chroma averaging | 0% bleed recovered. Averaging cannot deconvolve a low-pass. The guided filter (chroma-from-luma) recovers 83%. |
| Luma-adaptive deband | Investigated, no deficiency existed — dark 10% vs mid 9%. |
| Multi-frame fusion **by weighted averaging** | Does not work, and the reason is structural. Aligned accumulation of real sub-pixel-shifted frames scores 36.056 dB against the HR original; **copies of a single frame score 36.253** — the extra frames contribute nothing. Every LR pixel is an AREA average of the scene, and the mean of aligned area-averages is just another area average. TAA works only because renderers emit jittered POINT samples. ✅ **Solved by back-projection instead — see below.** |
| **A better CNN *architecture* at the same cost** | **Refuted by a controlled experiment — the shipped architecture already wins.** The reasoning was that ArtCNN beats this class of model at similar parameter counts, so the limiter might be architecture rather than capacity, and that depth is cheap here (linear) where width is not (quadratic — which is why the 16-filter test failed). Four variants, same data, same seed, same 60 epochs, val PSNR: **baseline 8f/4L 31.111** · +ArtCNN long skip 31.017 · 8f/**6L** 31.072 · 6L+skip 30.332. Neither the skip nor the extra depth helps; the deepest-plus-skip variant is much worse. Do not re-pitch "add a residual connection" or "make it deeper". |
| Optical flow with the sign of `d` unflipped | −5.8 dB, *worse than no alignment at all*. LK minimises Σ(∇c·d + It)² so A·d = −b; the positive solution warps history away from the match. It reads exactly like "multi-frame does not work" rather than like a one-character bug. |
| **Deblocking would make `detail` affordable** | **Wrong — the reason the restore stage was built, and the measurement killed it.** The argument was sound: local contrast amplifies the 8–64 px band, which is where blocking lives, so cleaning the grid first should let Detail run hard. Measured on a crf45 rip, Detail 0.30 costs 1.246 dB raw and 1.176 dB after restore — a 6% saving, not an unlock. Detail damages the block *interiors* more than the grid (−1.32 dB vs −1.10 dB), so block edges were never its main cost. **Detail stays at 0.12 in every heavy preset.** |
| Per-pixel deblock decisions | Blockiness 1.74 → 1.58 only, because per-pixel noise keeps the gate shut. Averaging the step ALONG the boundary (coherent = manufactured, incoherent = real) took the same source to 1.31 at the same strength. |

---

## 2026-08-10 — the whole day, in order

Three passes. Read this before the detail below; it is the arc.

**Pass 1 — the missing stage.** Everything in the engine repaired *scaling*
damage; nothing addressed *compression* damage, which is the dominant problem in
real footage. Added `deblock` + `dering` and the `rescue` preset.

**Pass 2 — research, then four builds.** Surveyed the field (mpv shader
ecosystem, real-time SR literature, browser GPU) and built all four directions
it suggested. Two shipped, two produced negative results.

**Pass 3 — the three things left.** Verified the YouTube lever on a live page,
tested whether a better *architecture* existed, and built real multi-frame
reconstruction. Then split the oldest unproven claim and proved a third of it.

**Score for the day: 5 hypotheses tested, 4 of mine were wrong.** The four wrong
ones cost hours and are all recorded in "measured and rejected"; the value is
that none of them became a rewrite. The one that was right — back-projection —
is the only mechanism in this project that adds information rather than
redistributing it.

**Ledger: 14 passing, 0 failing, 2 awaiting hardware.**

---

## Second pass — what the research turned into

All four directions from the research below were built and measured. Two paid
off, two produced negative results that are worth more than the features would
have been.

**Shipped and verified:**
1. **The restore stage now measures the source instead of assuming it.** Strength
   is driven by a blockiness measurement (fitted to the measured optima), and
   the transform grid's phase and period are detected per axis. Both pay off: on
   a picture shifted 3px, filtering the detected phase leaves blockiness 1.447
   where assuming the origin leaves 1.978; on a 4×4 grid, period 4 leaves 1.038
   against 1.202.
2. **The extension can see and request a better SOURCE** — the only lever that
   adds information rather than redistributing it. Probing is passive and free;
   upgrading is one click, because quadrupling someone's bitrate is not a
   decision to make on their behalf. ✅ **Verified live on a real 4K video
   2026-08-10:** the player was serving hd1080 with hd2160 available, the request
   moved it onto the 3840×2160 AV1 stream (its own stats confirmed), and the
   preference **persisted** across a reload.
   🔴 **`getPlaybackQuality()` lies for a while.** It went on returning "hd1080"
   for 40+ seconds after the switch had already happened. A readout built on it
   reports failure while the feature is working. The probe now reports the
   **decoded frame size**, which cannot lag because it *is* the output, and keeps
   the player's opinion only as a fallback before the first frame.
3. **Temporal accumulation is motion-compensated** (Lucas-Kanade, quarter-res
   solve on full-res taps). Recovers 77% of what motion was costing at feedback
   0.55. Costs ~1.7 ms.

**⭐ Multi-frame reconstruction now WORKS (2026-08-10, third pass).** Weighted
averaging could not fuse; **back-projection** can. It simulates the camera on the
current estimate — averages it back down over each source pixel's footprint — and
corrects against what was actually observed. The ablation separates the two
effects cleanly:

| | vs the HR original |
|---|---|
| single frame | 36.253 dB |
| back-projection on **copies** of one frame | 37.278 (+1.025) — deconvolution, a still image gets this too |
| back-projection on **real** sub-pixel-shifted frames | 37.569 (**+0.291 further**) — could only have come from the other frames |

🔴 **And it is gated OFF on compressed sources, which is not optional.** It pulls
the estimate toward the pixels actually observed, so on a blocky source it
reprints exactly what the restore stage just removed: forced on, blockiness went
1.312 → 1.570, and with no restore stage in front it reached 1.919 — worse than
doing nothing. `autoBackproject()` drives it from the same blockiness measurement
as deblock and is at zero by 1.35.

**Negative results — read these before re-attempting either:**
4. **WebGPU does not rescue the neural upscaler.** The hypothesis was that the
   16-filter model's 14.62 ms was a fragment-shader artifact. A compute
   implementation with `shader-f16` and workgroup tiling, verified against the
   same PyTorch reference, runs the shipped model at 4.25 ms vs 4.71 (1.11×) and
   16 filters at 11.11 vs 14.62 (1.32×) — against 7.14 ms of headroom. **The
   constraint is arithmetic, not API.** The engine port is not worth doing.
   `test/webgpu.html` keeps the measurement.
5. **Multi-frame fusion does not add detail.** See the rejected table below.

**Perf after all of it:** 9.56 ms/frame of the 16.7 ms budget with the classical
chain (was 7.85), 14.92 with the neural doubler additionally on.

## Research pass, 2026-08-10 — where the remaining quality actually is

Surveyed the current state of real-time video upscaling (mpv shader ecosystem,
real-time SR literature, browser GPU capabilities) against what this engine
already does. Findings, most valuable first:

**1. The biggest lever is still a better source, and it is completely untouched.**
This file has said "the biggest available lever is a better source" since the
first session, and nobody tried to *get* one. A browser extension can: YouTube
exposes `setPlaybackQualityRange` / `setPlaybackQuality` on the player element,
and several open extensions (avi12/youtube-auto-hd is the reference
implementation) already force max resolution *and* Premium enhanced bitrate.
Serving 1440p where the player settled on 1080p is **real extra information**,
not inferred detail — it beats every shader in this repo combined, and costs no
GPU. Caveat: `getAvailableQualityLevels()` under-reports the Premium tiers, so
the selection needs the workaround those projects already solved.

**2. The neural path was rejected on a cost that is an artifact of WebGL2, not
of the maths.** The measurement that killed it (16 filters = 14.62 ms/frame vs
4.88, for +0.19 dB) was taken with *fragment* shaders: no compute, no workgroup
shared memory, no FP16 arithmetic, so every 3x3 convolution re-fetches nine
texels per output with zero reuse between neighbouring pixels. ArtCNN — now the
best-measured real-time luma doubler in mpv, superseding FSRCNNX — runs 4 layers
x 16 filters (~12k params, 8x this engine's 1540) in real time precisely because
its GLSL is a **compute shader using FP16 and shared-memory tiling**. Verified on
this Mac 2026-08-10: WebGPU is available, `shader-f16` is supported, 32 KB
workgroup storage, 1024 invocations/workgroup, Apple metal-3.
*Honest expectation:* this removes the cost ceiling; it does not promise a big
win. This project's own capacity scaling measured +0.19 dB for 4x the parameters,
so extrapolating to 32 filters suggests roughly +0.4 dB — real, modest, and worth
having only because it would then be nearly free. Treat it as buying the ability
to find out, not as a known gain. ArtCNN is MIT, so its weights and architecture
can be ported outright, but it is trained on anime; live-action needs this repo's
own training pipeline.

**3. The training methodology here is already better than the ecosystem's** and
should not be "fixed". ArtCNN, RAVU, FSRCNNX and NNEDI3 are all trained on
cleanly downsampled pairs; `cnn/train.py` already degrades each LR patch with
JPEG compression first, on the explicit reasoning that a model trained on clean
downsampling "has no reason to remove" compression artifacts. The ecosystem
agrees — ArtCNN ships `DS` (denoise+sharpen, "usually useful for most web
sources") and `JPEG420`/`JPEG444` variants for exactly this. The gap here is
capacity, not method, which is what makes (2) worth doing.

**4. Multi-frame SR is the only legitimate way to ADD detail** rather than infer
it, and the literature proves it rather than asserting it: Tao et al. (ICCV 2017)
ran the decisive ablation — feed the network three *copies* of one frame and the
recovered text collapses back to single-frame quality; feed three *different*
frames and it resolves. The detail came from the other frames. Caballero et al.
(CVPR 2017) got this to real time; early fusion costs extra only in the first
layer, and motion compensation roughly doubles the gain over naive accumulation.
This engine's `temporal` stage is that naive accumulation — the missing piece is
sub-pixel alignment, which is the expensive part and why it was declined on
budget before. It only becomes affordable after (2).

**5. Already on the current best approach, no change needed:** chroma-from-luma
(the ecosystem moved KrigBilateral -> CfL_Prediction, which is the guided filter
already implemented here) and anti-ringing (measured "a net positive in general").

## Next, if picked up

1. **Prove `output-paths`** — still the only thing between "built" and "works",
   and now the oldest unproven thing here by a wide margin.
2. **Confirm the better-source lever on a real YouTube page.** It is the highest
   value feature added today and the only one whose live behaviour is unverified.
   One video, one click on "use it", check the readout reports a higher tier.
3. **Real multi-frame reconstruction**, if anyone wants to spend the effort:
   shift-and-add onto the HR grid plus iterative back-projection. The alignment
   it needs already exists and is verified. This is the only remaining path to
   genuinely *adding* detail, and the measurement rig to judge it — the
   copies-versus-real-frames ablation — is already in the suite.

---

## Layout

```
manifest.json        MV3; activeTab + per-site optional grants
background.js        injection, context menus, auto-run registration, ON badge
options.html/.js     per-site allow list (holds the user gesture permissions need)
core.js              WebGL2 engine — no chrome.* APIs, testable standalone
content.js           video discovery, overlay geometry, DRM fallback, panel
cnn-weights.js       GENERATED by cnn/make_shader.py — do not hand-edit
cnn/                 training pipeline (venv, CC-BY data, gitignored scratch)
test/run.py          one-command headless suite; tools/check-package.py
test/compare.html    visual A/B for the restore stage — serve the folder and open
                     it; the eye check the numbers cannot make
test/webgpu.html     the WebGPU-vs-WebGL2 measurement that retired the idea of
                     porting the engine; correctness runs headless, timings need
                     a real window
tools/verify-screenshare.py
                     proves the overlay survives an OS screen capture, i.e. the
                     Zoom/Meet path. Drives a real Chrome window; --slow in the
                     ledger, needs Screen Recording permission
source-probe.js      the MAIN-world better-source probe (page's world, not ours)
```

## Seeing it rather than reading numbers

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler" && python3 -m http.server 8731
# then open http://127.0.0.1:8731/test/compare.html
```

Also the only way to get a real perf number: `test/run.py` SKIPs the benchmark
because the headless runner fast-forwards timers, so `performance.now()` is
meaningless there. Load `test/harness.html` in a normal window for the ms/frame
figures.
