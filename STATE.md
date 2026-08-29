# Video Upscaler — STATE

Chrome extension (MV3) that upscales and repairs whatever `<video>` is playing on
a page, compositing the result into the page so it survives screenshare, AirPlay
mirroring and HDMI.

**Read this file, then run `ledger status` here. The ledger is the machine-checked
truth; this prose is one session's account.**

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler"
ledger status
python3 test/run.py          # ~127-129 passed, 0 failed as of 2026-08-29
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
perf inside the 60 fps budget · the shipped tuning does not damage compressed
video · the neural stage is honestly characterised · **the restore stage
measurably removes compression damage** · **the shipped tuning beats every
alternative on every source** · **there are no settings to get wrong**.

⭐ **2026-08-29 — IT IS NOW FULLY AUTOMATIC. The settings are gone.** The panel
had a mode picker, a preset picker, an upscaler picker, a neural toggle and 16
sliders. It now has exactly one input (A/B split) and one key (backtick), and
NEITHER changes the picture — they exist so you can see it working. Everything
else is driven by measurement: mode from whether frames can be read, deblock and
dering from the source's blockiness, back-projection from the same measurement,
render scale from the frame budget, overall effort from how far the source is
being stretched.

The shipped tuning is `rescue`, and that is a MEASURED choice, not a taste one —
it beats every other preset against a clean original on every source tested,
including a clean one. There was no source on which picking differently would
have helped, so there was nothing to pick.

⚠️ **The PRESETS table still exists and must not be deleted.** It is now internal:
the test suite and the ablation harness drive profiles through `__VU__.preset()`,
the A/B split needs an untouched baseline, and if per-shot look adaptation is ever
built and measured it will select among them. They are simply not surfaced.

⚠️ **What is NOT automatic, deliberately:** fetching a better source. It is the
only lever that adds information, and it is the one thing left with a button,
because quadrupling someone's bitrate is their bandwidth and not ours.

**✅ The screenshare path is now PROVEN** (`tools/verify-screenshare.py`, a
ledger claim). Capturing the window with the upscaler off and then on, over a
still fixture whose frames are identical by construction, the video region moves
by a mean of 7.44/255 with 91.7% of sampled pixels changing. That is the same
window-server composite Zoom and Meet read. It matters because a plain `<video>`
does NOT always survive it — hardware overlay planes and protected pipelines are
why some screen recordings come out black, and compositing a canvas into the page
is precisely the design that avoids it.

**Where the entry points stand (2026-08-29):**

✅ **The extension loads and runs in a real Chrome, confirmed on live 4K YouTube**
(`loads-and-runs-in-real-chrome`, attested). Toolbar icon invoked it, the panel
followed the video into fullscreen, and every automatic decision behaved on a
source no fixture resembles: measured the source clean, deblock 0.16, denoise
0.33, back-projection gate open, governor at ×1.10, serving 2160p.

✅ **`Cmd+Shift+U` works** (`keyboard-shortcut-works`, attested). ⭐ **This closes
the oldest open worry in the project.** An earlier attempt to drive it via System
Events produced *nothing at all*, and that silence sat unexplained for weeks as
evidence the entry point might be broken. It was not broken. The original silence
still has no confirmed cause — the fixture was a black frame, the synthetic
keystroke may have needed Accessibility permission, and the black-frame probe
demotes after three strikes; any of those produces exactly that silence with
working code. Recorded rather than solved, because the code is fine.

✅ **Every decision the service worker makes is tested** (`invocation-wiring`, 15
checks against a mock `chrome.*`).

⬜ **`invocation-remaining-paths-v2`** — context menu, per-site auto-run, ON badge.
Untried, and **no longer suspected of anything**; the wiring behind all three
passes. Ten minutes with a browser whenever convenient.

📌 **`output-paths-external-display` — PARKED BY DECISION 2026-08-29.** Carter:
"put a pin in the hdmi cable test for now." It needs an HDMI cable or an AirPlay
receiver, neither of which is here. It consumes the same window-server composite
that `output-paths-screenshare` already proved, which is strong evidence and not
proof. Do not re-raise it as an open task — it is parked, not forgotten.

🔴 **Chrome 151 ignores `--load-extension`**, so none of the browser-integration
items can be automated. Verified the long way: headless AND headful, with
`--disable-features=DisableLoadExtensionCommandLineSwitch`, and with
`extensions.ui.developer_mode` pre-seeded into a fresh profile. The extension
never registers and its service worker never becomes a CDP target, while Chrome's
own component extensions do. Do not spend another session on the flag.

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

**🔴 Fixtures at the extremes do not calibrate the middle, and the middle is where
real sources live.** `autoDenoise` was first fitted with **nothing measured
between blockiness 1.06 and 1.46** — a pristine PNG and a badly crushed plate,
neither of which resembles a real stream. Carter's 2026-08-29 screenshot of live
4K YouTube read blockiness **~1.21**, dead centre of that gap: every decision the
curve made about good real-world content was interpolation dressed as a fit.
Densifying the ladder (11 JPEG levels instead of 5, dense at the HIGH-quality
end) moved the curve up by as much as **0.12** in that band and the worst error
from **0.118 to 0.043**. A test now pins what the curve does at 1.214 specifically,
so a retune cannot satisfy the extreme fixtures while quietly changing
real-world behaviour. Check where your real inputs land on the axis before
trusting a fit built from convenient fixtures.

**⚠️ Two instruments disagree about DEBLOCK strength, and it is NOT resolved.**
Swept the same way as denoise, the detail-split metric says the shipped deblock
curve runs about **0.15 hot** through the mid band (at blockiness 1.46 it applies
0.35 where detail peaks at 0.20; at 2.17 it applies 0.64 where detail peaks at
0.50). **Deblock was deliberately not retuned on that evidence.** The instrument
may structurally penalise a deblocker for doing its job: a grid artifact sitting
in a region the ground truth calls "detailed" reads as detail being removed, when
removing it is the point. Deblock's own claim uses the grid-vs-interior split —
a more targeted instrument — and says it is working (+0.85 dB on grid pixels vs
+0.13 dB on interiors). Reconciling the two needs a measurement designed for it,
not a judgement call. Do not retune deblock off the detail split alone.


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

🔴 **And on its own it was NOT enough to make the settings removal safe** — this
was caught by testing the upgrade path rather than the fresh install. It
re-derives from `PRESETS[S.preset]`, but `S.preset` was itself being restored
from storage, so an old install carrying `preset:'anime'` came back with
**adaptive AND autoRestore both off** (every automatic behaviour disabled) and
one carrying `preset:'custom'` came back pinned to **detail 0.80 — measured
7.07 dB worse than doing nothing** — with no control left to undo it. Removing
the UI turned a recoverable bad state into an unrecoverable one.

The fix is the `PERSIST` allowlist in content.js: **`collapsed` is the only key
that survives a reload.** Every quality value re-derives from code on every
start. Two checks in `test/integration.html` hold that line, and one of them is
deliberately INVERTED from the assertion it replaced — the old bug was a quality
key *missing* from the persisted set, the new bug is one *present* in it.

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
| **A runtime driver for CHROMA — three candidates, all dead** | **The diagnosis holds and the cure does not exist yet.** The chroma/luma ERROR ratio explains the phenomenon perfectly (JPEG sources 1.13-1.29, the rip 0.401) but needs the clean original. Three source-only substitutes were built and each fails the SAME way — beautiful inside one content family, wrong across two. (1) **Chroma bandwidth** — mean 1-step vs 2-step chroma difference, exploiting that 4:2:0 interpolates fine detail. Monotone within `clean.png`'s ladder and it separated the rip correctly (1.1061 vs 1.0359), but `darkrip.png`'s baseline sits 0.055 lower, and that content shift is **twice the entire useful range** (~0.028); interleaved, `darkrip:q0.95` at bw 1.0384 wants 0 while `clean:q0.6` at a HIGHER 1.0466 wants 0.4. (2) **Luma-normalised** version of the same — each family stays monotone but at different offsets, so normalising flipped the direction without removing the offset. (3) **A structural parity detector** (4:2:0 leaves one column parity interpolated, so its second difference collapses) — uninformative, everything within 0.99±0.01 and the two NEVER-subsampled sources landing at opposite ends. The fingerprint is gone by the time chroma returns through a canvas readback, because the browser already upsampled it. ⭐ **The next avenue is not a better statistic, it is asking instead of measuring:** WebCodecs `VideoFrame.format` names the sampling directly (`I420` vs `I444`), reachable through `MediaStreamTrackProcessor`. Chroma stays FIXED until someone tries that. |
| **"The detail split penalises deblock unfairly" — REFUTED** | **My own suspicion, and it was wrong.** The worry was that a grid artifact lying across a ground-truth-detailed region reads as detail being destroyed. `test/probe-deblock.html` settles it by building a source where the answer is known: the clean plate plus a constant offset per 8x8 block, which REMOVES NOTHING, so real detail is fully intact and the artifact is exactly the offset field we hold. The error then decomposes exactly, by projection onto that field, into residual artifact plus collateral damage. Result: below ~0.5 strength the deblocker damages detailed and flat regions **equally** (at 0.35: 0.885 vs 0.950 — detail is damaged slightly LESS), so the instrument is not structurally unfair. The asymmetry only appears above ~0.65 and then widens fast (at 1.0: 3.217 vs 2.445). The shipped curve lands at **0.683** on that fixture — at the crossover, not 0.15 hot. **Deblock was left unchanged.** ⚠️ Note the artifact metric has a floor: a DC offset spans a whole block while a deblocker only touches the seam, so "28% removed at full strength" is near the ceiling for this artifact type, not a deficiency. |
| **Auto-tuning DEBAND** | **Nothing to adapt, and PSNR cannot see it.** Swept 0..1 against ground truth across seven sources (clean, five JPEG levels, the real rip): the best achievable gain anywhere was **0.001 dB**, i.e. noise. That is NOT "deband is useless" — banding affects few pixels by small amounts, so a squared-error metric is blind to it, the same way it is blind to the look stages. It keeps its own instrument (banding-plateau length, already in the suite) and stays at a fixed strength. Do not re-pitch driving it from blockiness; there is no signal to drive. |
| **Auto-tuning CHROMA off blockiness** | **The optimum moves a lot, but blockiness is the WRONG driver — and this nearly shipped.** On a JPEG ladder the best chroma strength climbs beautifully with blockiness (1.46 -> 0.4, 2.17 -> 0.6, 2.82 -> 0.85, 4.46 -> 1.0), which is exactly the tidy fit that invites shipping. But `lowbitrate.png` at blockiness **2.234** wants **0.0**, where JPEG at blockiness **2.166** wants **0.6** — near-identical blockiness, opposite answers, and going up only hurts the rip (24.503 -> 24.388 monotonically). Measuring the thing the stage actually repairs explains it: every JPEG source carries chroma error ≳ luma error (ratio 1.13-1.29) because JPEG subsamples 4:2:0, while the rip's chroma is relatively intact (ratio **0.401**). **Blockiness is a luma-grid measurement and chroma bleed is a different axis.** Fitting to it would have looked perfect on the ladder and been actively wrong on the one real-world fixture. Chroma stays fixed until there is a runtime-computable chroma-resolution measurement — the ratio used here needs the clean original, which production does not have. |
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

**Nothing here is blocked, and nothing is suspected of being broken.** Every item
that used to sit in this list is done or attested — see "Where the entry points
stand" above. What is genuinely open, in the order I would take it:

1. **Measure whether per-shot look adaptation beats a fixed look** — step 3 of the
   automatic-upscaler plan below, and the last real design question. The
   project's own metric suggests it may not, which is exactly why it wants a
   cheap measurement rather than a build. `tools/sweep-auto.py` is the rig.
2. **A runtime-computable chroma-resolution measurement.** Chroma is the one
   stage whose optimum demonstrably moves but whose driver is still missing — the
   chroma/luma error ratio that explains it needs a clean original, which
   production does not have. Detecting 4:2:0 bleed without ground truth would
   unlock it. See the rejected table.
3. **Reconcile the two deblock instruments** — the detail-split says the shipped
   curve runs ~0.15 hot, grid-vs-interior says it is working. Unresolved on
   purpose; needs a measurement designed for the question, not a judgement call.
4. **`invocation-remaining-paths-v2`** — context menu, auto-run, ON badge. Ten
   minutes with a browser, low stakes, wiring already proven.

📌 Not on this list on purpose: `output-paths-external-display`, parked by
Carter's decision 2026-08-29.

### The live design question — a fully automatic upscaler

Carter's direction (2026-08-29): remove the settings entirely and have it adapt
on its own, marketed as a smart upscaler that adjusts to the scene. **Feasible,
and about 70% built** — but it splits in two and only one half is automatable:

- **Reconstruction** (deblock, dering, back-projection, grid phase/period, render
  scale, GPU/filter mode) already auto-tunes off a real measurement, and denoise
  / deband / chroma could join it. These have ground truth, so "best" is defined.
- **Look** (detail, vibrance, shadow) **cannot be automated by any metric in this
  project** — measured: distance-to-truth drives all three monotonically to zero
  on both clean and compressed sources. An optimiser using the only honest metric
  here converges on `reference`, which to a normal viewer looks *flatter* than
  what `max` gives them now. The look is a taste dial, not a measurement.

Two facts that shape the pitch. `rescue` already **beats every other preset on
every source tested, including a clean one** — so auto cannot honestly be sold as
"better than picking the right preset"; the right preset is already found. What
auto buys is that the user never has to know, plus **per-shot** adaptation within
one video, which no static preset can do and which is **not yet measured**.

Order to build it: ~~(1) ship `rescue` + auto as the only mode and delete the
preset picker~~ ✅ **DONE 2026-08-29** — see "IT IS NOW FULLY AUTOMATIC" above and
the `no-settings-to-get-wrong` claim. ~~(2) extend auto-tuning to denoise, deband and
chroma~~ ✅ **DONE 2026-08-29, and it split three ways** — denoise now auto-tunes
(`auto-denoise-fitted-on-detail-split-v2`); deband has nothing to adapt and PSNR
cannot see it; chroma's optimum moves but blockiness is the wrong driver. Both
negative results are in the rejected table above, with the numbers.
**(3) MEASURE whether per-shot look adaptation beats a fixed look** before
building it; the project's own metric suggests it may not — and note no metric
here can judge a look, so the verdict needs an eye, not a sweep.
~~(4) A runtime-computable chroma-resolution measurement~~ ❌ **ATTEMPTED AND
DEAD 2026-08-29** — three candidate signals, all content-dependent by more than
their useful range. See the rejected table. The remaining idea is `VideoFrame.format`
via WebCodecs, i.e. asking the browser rather than measuring pixels.

🔴 **Two risks worth writing down now.** Parameters that change mid-shot make the
picture *pump*, and there is **no test in the suite that would catch that** — the
render-scale governor already needed deliberate hysteresis for the same reason,
and look controls pump far more visibly. And `measureGrid()` runs only every
2000 ms because its `readPixels` stalls; reacting at a scene *cut* means making
that readback async, which is the one piece that could threaten the 10.54 ms
budget. Also: keep the readout, A/B split and bypass key. "No settings" must not
become "no way to tell it is working" — that is the uninstall path.

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
test/panel-look.html the panel, rendered for a human to look at. The DOM
                     assertions prove its structure; this proves it is legible
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
