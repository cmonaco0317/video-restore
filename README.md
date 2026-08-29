# Video Upscaler

A Chrome extension that upscales and repairs whatever video is playing on the
page, on the GPU, in real time. The processed picture is composited *into* the
page, so it survives screen sharing and display mirroring.

It fits 1080p→4K in **10.54 ms of a 16.7 ms frame budget**, removes **75% of the
blocking** from a badly compressed source, and does genuine multi-frame
reconstruction. But that is not the interesting part.

## The interesting part is what didn't work

Most of what I was confident about turned out to be wrong, and the measurements
are in the repository rather than the summary. Four examples, all with the
numbers that killed them in [`STATE.md`](STATE.md):

- **"WebGPU compute will make a bigger neural model affordable."** The model was
  retired because 16 filters cost 14.62 ms in a fragment shader, and fragment
  shaders have no shared memory or FP16. So I built the compute version with
  both, verified it against the same PyTorch reference — and got **1.11×** on the
  shipped model, **1.32×** at 16 filters. Still doesn't fit. The constraint was
  arithmetic, not the API. That killed an engine rewrite I was one step from
  recommending. ([`test/webgpu.html`](test/webgpu.html) keeps the measurement.)

- **"Fusing several frames will recover real detail."** True in the literature,
  false as I first built it. Aligned accumulation of real sub-pixel-shifted
  frames scored **36.056 dB**; feeding it *copies of a single frame* scored
  **36.253**. The extra frames contributed nothing, because every low-res pixel
  is an area average and the mean of aligned area averages is just another area
  average. It took **back-projection** — simulate the camera, correct against
  what was actually observed — to make the extra frames matter.

- **"A better architecture at the same cost."** ArtCNN beats this class of model
  at similar parameter counts, so the limiter looked architectural. Four
  variants, same data, same seed: baseline **31.111**, ArtCNN's long skip
  **31.017**, deeper **31.072**, both **30.332**. The shipped one won. The real
  limiter was *data* — 320→900 training frames moved it +1.016→**+1.278 dB**.

- **"Cleaning up blocking will make local contrast affordable."** The reasoning
  was sound and the measurement said 6%, not an unlock.

**Why this is in the README:** on a compressed source, amplified artifact and
recovered detail are the same high-frequency energy, so any metric that asks "is
there more detail?" will call a wrecked picture an improvement. About 60 tests
here were green while the output was visibly ruined. Everything now measures
**distance to a clean original**, and the load-bearing checks are ablations
designed so that the pleasant answer and the true answer come apart.

## What it will not do

Make a bad source look great. The detail is not hiding under the artifacts — the
encoder discarded it, and nothing at this speed reconstructs it. Expect *visibly
cleaner*, not *sharper*. The single biggest quality lever remains getting a
better source, which is why the extension now goes and asks for one.

It also does not circumvent anything. It reads frames the page has already
decoded, through the ordinary canvas API, and when a protected pipeline hands
back black frames it detects that and steps out of the way. There is no DRM
involved on either side of that.

## Licence

MIT — see [LICENSE](LICENSE). **Read [THIRD-PARTY.md](THIRD-PARTY.md) before
redistributing:** the upscaling kernels are adapted from AMD's FidelityFX FSR
(MIT), and the test fixtures, the training data and the shipped model weights are
all derived from *Tears of Steel* ((CC) Blender Foundation, CC BY 3.0), whose
attribution travels with any copy — including screenshots of the comparison page.

---

## Getting at it

Four ways in, easiest first:

1. **Allow a site once, never think about it again.** Open the extension's
   options page (`chrome://extensions` → Video Upscaler → *Details* → *Extension
   options*, or right-click a video → *Always upscale on this site…*). Click
   `+ www.youtube.com`, approve the prompt. From then on it turns itself on
   automatically on that site — no shortcut, no clicking. It starts collapsed and
   stays out of the way, and stays quiet entirely on pages with no video.
2. **Right-click** a video or the page → *Upscale video on this page*.
3. **Pin the toolbar icon** — click the puzzle-piece 🧩 in Chrome's toolbar, then
   the pin next to Video Upscaler. One click after that, and the icon shows a
   blue **ON** badge whenever it's active.
4. **`Cmd+Shift+U`** — remappable at `chrome://extensions/shortcuts`.

Per-site auto-run is granted one site at a time, at runtime. Nothing broad is
granted at install, and removing a site revokes the permission with it.

---

## Does it survive my output path?

This is the point of the whole design, so the table separates what has been
**measured** from what is only **reasoned**. A plain `<video>` does not always
survive these paths — video can be handed to a hardware overlay plane or a
protected pipeline the compositor never sees, which is why some screen recordings
come out black. Compositing a canvas into the page is the thing that avoids it.

| Output path | Works? | Evidence |
|---|---|---|
| **Screenshare** (Zoom, Meet, Teams, Discord) | ✅ **Measured** | `python3 tools/verify-screenshare.py` captures the window with the upscaler off and then on, over a still fixture whose frames are identical by construction: the video region moves by a mean of 7.44/255 with **91.7%** of sampled pixels changing. Same window-server composite these apps read. |
| **HDMI to a TV** | ⚠️ Reasoned, untested | macOS composites the whole window to the display, and that is the same composite the screenshare test just proved. Strong, but nobody has plugged in a TV. |
| **AirPlay Screen Mirroring** (Control Center → Screen Mirroring) | ⚠️ Reasoned, untested | Same argument — it mirrors the composited desktop. No AirPlay receiver was available to confirm it. |
| **Native AirPlay video** (the AirPlay button *inside* the player) | ❌ **No**, by design | This hands the raw stream URL to the Apple TV. Your Mac stops rendering the video entirely, so there is nothing for the extension to touch. **Use Screen Mirroring instead.** |
| **Picture-in-Picture** | ❌ No | The OS PiP window renders the raw video element directly, bypassing the page. |

The one thing to actually remember: **for AirPlay, use Screen Mirroring, not the
player's own AirPlay button.**

## Two modes

**GPU mode** (default where possible) — eight stages. Several fold into one GPU
pass and several are skipped when their strength is zero, so a presented frame
costs 5–7 passes depending on what the source needs:

1. **restore**, at source resolution and **first in the chain** — **deblock** and
   **dering**, the only stage that repairs damage done by the *encoder* rather
   than by scaling. It runs before everything else because otherwise the rest of
   the chain amplifies the artifacts instead of the picture. Its strength, and
   the transform grid's phase and period, are **measured off the source** rather
   than assumed. Full detail under
   [when the source is genuinely bad](#when-the-source-is-genuinely-bad) below.
2. **clean**, at source resolution — edge-preserving bilateral denoise, **deband**
   to dissolve the contour steps low-bitrate gradients break into, and **chroma
   reconstruction**. Video is 4:2:0: colour is stored at quarter resolution, so
   colour edges arrive soft and bleed past the luma edge they belong to. Luma
   survives at full resolution, so chroma is refit as a local linear function of
   luma (a guided filter — the same idea AV1 calls chroma-from-luma) and colour
   snaps back onto the structure it belongs to. Cleaning before magnification
   beats cleaning after.
3. **neural 2x luma doubler — OFF by default.** A 1540-parameter CNN trained on
   live-action video, running as four WebGL2 fragment passes. It beats Lanczos-3
   by **+1.278 dB** on its own test split, but measured against a clean original
   it is only **+0.09 dB** on a compressed source and **−0.11 dB** on a clean one
   versus the EASU path that actually ships — for **4.52 ms/frame**. It does not
   earn its cost, so the toggle exists and the default is off. The full story,
   and why every permissively-licensed alternative is anime-trained, is in
   `cnn/README.md`.
4. **upscale** — **FSR 1.0 EASU**, which orients its kernel along the local edge
   instead of filtering blindly, so diagonals stop staircasing. Separable
   **Lanczos-3** is still selectable in the panel.
5. **motion-compensated temporal accumulation** — **removes noise; does not add
   detail.** Lucas-Kanade optical flow estimates sub-pixel motion (solved at
   quarter resolution, sampled at full), so history follows the scene instead of
   being thrown away whenever anything moves — that recovers 77% of what motion
   was costing. It cuts noise 71% over 24 frames and adopts a hard cut on the
   very next frame, so it does not ghost. What it does **not** do is add detail,
   and that was measured rather than assumed: real sub-pixel-shifted frames score
   36.056 dB where *copies of a single frame* score 36.253. Averaging aligned
   area-samples cannot deconvolve — the mean of area averages is just another
   area average.
6. **back-projection** — **the stage that does add detail.** Instead of averaging,
   it simulates the camera on the current estimate and corrects it against the
   pixels actually observed. The copies-vs-real-frames ablation separates the two
   effects cleanly: **+1.03 dB** of deconvolution (which a still image gets too)
   plus a further **+0.29 dB** that could only have come from the neighbouring
   frames. It is **automatically gated off on compressed sources**, and has to
   be — it pulls toward the observed pixels, so on a blocky source it faithfully
   reprints the blocking that stage 1 just removed.
7. **local contrast, vibrance and shadow lift** — the perceived-quality layer.
   Local contrast works at the tens-of-pixels scale (a different thing from
   sharpening, which works at the pixel scale) and is what reads as depth and
   pop; it boosts the band between two cheap downsampled blurs, clamped so it
   cannot become a halo. Vibrance pushes muted colour hard and already-saturated
   colour barely at all, backing off on skin tones. Shadow lift opens dark scenes
   with a term that vanishes at both ends, so black is never crushed or clipped.
   **These push the image away from what was encoded, on purpose.**
8. **finish** — **RCAS** sharpening (its limiter is derived from the local
   extremes, so the lobe cannot overshoot into a ring), colour grade, and
   triangular dither.

Intermediates are **RGBA16F** where the GPU supports it, so the chain doesn't
quantise to 8 bits at every stage; the dither handles the trip back down.

**Filter mode** (automatic fallback) — a GPU-composited CSS/SVG unsharp mask plus
colour controls. No resolution gain, but sharpening and local contrast are where
most of the perceived "upscale" lives on a TV, and it works on content GPU mode
can't read.

It falls back to Filter mode automatically, and tells you why in the panel, when:

- the stream is **DRM-protected** (Netflix, Disney+, Max, Prime). The extension
  cannot read protected frames and does not try to — it detects the condition and
  backs off. Filter mode still applies.
- the video is **cross-origin without CORS headers** (a plain `.mp4` on another
  domain). Note most real players use MSE/blob sources, which are fine.
- WebGL2 is unavailable.

Separately: DRM video shows up **black in any screen capture** on macOS regardless
of this extension. That's the OS and the DRM stack, and nothing here changes it.

## Nothing to configure

**There are no settings.** The panel has one control and one key, and neither of
them changes the picture — they exist so you can *see* that it is working:

- **A/B split** — drag to reveal the untouched source on the left
- Hold **`** (backtick) to bypass entirely while watching

It reads out `source → output` resolution, live fps, what it measured your source
to be, and what it decided to do about it. It is draggable, collapsible, and
follows the video into fullscreen.

### What it decides, and what it decides from

| Decision | Driven by |
|---|---|
| GPU or CSS-filter mode | whether frames can actually be read (DRM, cross-origin, no WebGL2) |
| Deblock strength | measured blockiness of the source, on a curve fitted to four measured optima |
| Denoise strength | the same measurement — zero on a clean source, full on a badly compressed one |
| Which grid to deblock | the transform grid's phase and period, **detected per axis** |
| Back-projection gain | the same blockiness measurement — full on a clean source, zero by the time blocking is merely noticeable |
| Render scale | the frame budget, closed-loop |
| Effort overall | how far the source is being stretched — a 480p film going to 4K gets materially more sharpening and deband than a 1080p one |

**Render scale climbs until it stops being visible — or until your GPU objects,
whichever comes first.** It steps up every few seconds while frames are clean and
steps back down the moment they are not. The drop signal is exact rather than
guessed: `requestVideoFrameCallback` reports how many frames the browser actually
presented, so if that counter outruns our callbacks, those are frames we failed
to keep up with. Deliberate hysteresis stops it oscillating. The ceiling is
**×1.25 of the video's device-pixel size** — past that the compositor discards the
extra, so climbing further costs battery for pixels nobody sees.

### Why there is only one configuration

Because the best one was already found, and it is not a close call. The tuning
that ships beats every alternative **on every source measured against a clean
original, including a clean source** — 31.80 → 31.98 dB on a clean plate,
27.46 → 28.02 on a badly blocked one. There is no source on which picking
something else would have been better, so there is nothing to pick.

What no measurement here can set is the *look*. Local contrast, vibrance and
shadow lift deliberately push the picture away from what was encoded, so
distance-to-truth drives all three to zero — measured, on both clean and
compressed sources. They ship at fixed conservative values (local contrast at
0.12, cut hard after the old tuning was measured putting a crf45 rip **7.07 dB
further from ground truth than doing nothing**). Calling that automatic would be
a lie: it is one taste decision, made once, and held.

### The one thing it will not decide for you

Fetching a better source is the only lever that adds information rather than
redistributing it — and it is the one thing left with a button. Quadrupling
someone's bitrate is their bandwidth, not ours, so when a better stream is
available the panel says so and waits. Probing is passive and costs nothing.


## When the source is genuinely bad

Everything else in this extension repairs damage done by *scaling*. The restore
stage goes after damage done by the *encoder* — the thing that actually makes a
low-bitrate rip look like a low-bitrate rip. It is always on, and how hard it
works is measured from your source rather than chosen.

Two artifacts, two mechanisms, both new:

**Deblock.** A codec transforms the picture in 8×8 tiles, and at low bitrate each
tile gets quantised toward its own average until the tiles stop lining up. You
see a faint grid, and it gets worse the more you magnify. An ordinary
edge-preserving denoise cannot touch this, because the tile edge *is* an edge and
an edge-preserving filter preserves it. This works on the grid instead, and its
test for "was this step manufactured?" is whether the step is **coherent along
the boundary** — quantisation shifts a whole tile, so a false edge points the
same way down its whole length, while real texture crossing the line does not.

**Dering.** Throwing away high-frequency coefficients makes strong edges ring, so
they sit in a skirt of shimmer. It is found by position rather than shape:
moderate roughness *next to* a strong edge but not *on* one. Only the skirt is
touched, and the correction is clamped to a few levels, so open texture is safe.

Measured against a clean original (`python3 test/run.py`):

| | blocking left | vs the clean original |
|---|---|---|
| badly blocked source, untouched | 2.51 | — |
| …restored | **1.37** (75% of the excess gone) | grid pixels **+0.85 dB**, interiors +0.13 dB |
| a *clean* source, restored | — | moves 1.38 of 255 levels (sub-visible) |

That second column is the one that matters. "Blocking left" is measured on the
same 8-px grid the filter edits, so on its own it could be reporting nothing but
its own definition — a blur would score well. Distance to the clean original
cannot be gamed that way, and a real deblocker has a signature a blur cannot
fake: **the pixels on the grid move much closer to the original than the block
interiors do.** They do, by 6.5×.

Costs 1.10 ms/frame. Beats `max` on every source tested including a clean one, so
there is no penalty for leaving it selected.

**It measures the source rather than assuming it.** Under `rescue`, `max` and
`reference` the strength is set from a live measurement of how blocky the source
actually is — the best strength genuinely moves (0 on a clean plate, ~0.6 on a
crf45 rip, ~0.85 on a badly blocked one), so one preset serves a Blu-ray and a
bad rip. The panel tells you which it thinks it is. The grid's **phase and
period are detected too**, per axis: a stream that has been cropped or
re-encoded can carry its transform grid anywhere, and filtering the wrong phase
smooths real detail while leaving the artifact. On a picture shifted 3px,
detecting the phase leaves blockiness 1.447 where assuming the origin leaves
1.978; on a 4×4 transform grid (AV1/HEVC), treating it as period 4 leaves 1.038
against 1.202 for period 8. There is no way to override any of this by hand,
which is deliberate: every one of these numbers came out of a measurement, and a
slider next to it would only offer you the chance to be wrong.

**What it will not do is make a bad source look great.** The detail is not
hiding under the artifacts; the encoder discarded it. This takes the mess off the
top of what survived. Expect *visibly cleaner*, not *sharper* — and if you want
the single biggest improvement available, it is still a better source.

## Which is why it now goes and gets one

Every pass in this extension redistributes information that already arrived.
Only one thing increases it: fetching a better stream. If the player settled on
720p while 2160p was sitting there, that beats every shader here combined, and
costs no GPU at all.

So the panel reports what you are actually being served, and on YouTube offers
the better tier on one click. It deliberately asks for a ceiling *above* the
best tier the player admits to, because `getAvailableQualityLevels()` omits the
Premium enhanced-bitrate variants — a player that can serve one still lists
1080p as its best.

It is **not** automatic, and that is deliberate: quadrupling your bitrate is
your bandwidth to spend, not a decision an extension should make quietly on a
metered connection. Probing changes nothing and costs nothing; upgrading is one
click. And because a player can refuse or drift back down, the readout says
"asked for its best" and then re-checks what actually happened rather than
claiming success.

On sites whose quality cannot be driven, it reports the honest number instead:
how far the source is being stretched to fill the box.

## Moving footage

Temporal accumulation now follows the motion. It estimates sub-pixel
displacement (Lucas-Kanade, solved at quarter resolution on full-resolution
taps) and aligns history before fusing. Without that, accumulation pairs a pixel
with whatever has since moved into its place, the rejection clamp correctly
throws it away, and the whole stage quietly degrades into "averages noise on the
parts of the frame that were not moving". Measured on a moving sequence at
feedback 0.55, alignment recovers **77%** of what motion was costing.

## …and then actually reconstructs from them

Alignment alone recovers no information. Averaging aligned frames cannot: every
low-res pixel is an *area average* of the scene, so the mean of aligned area
averages is just another area average. Measured, real sub-pixel-shifted frames
scored no better than copies of a single frame.

**Back-projection asks a different question.** It takes the current
high-resolution estimate, *simulates the camera* — averages it back down over
each source pixel's footprint — and compares that against what was actually
observed. Where the simulation disagrees, the estimate is wrong, and the
disagreement is corrected. Because the estimate carries content from several
frames at different sub-pixel offsets, each new observation is a genuinely new
equation about the same surface.

The standard ablation separates what this buys, because the honest question is
whether the *extra frames* are contributing anything:

| | vs the high-resolution original |
|---|---|
| single frame | 36.253 dB |
| back-projection on **copies** of one frame | 37.278 (**+1.03**) — deconvolution; a still image gets this too |
| back-projection on **real** shifted frames | 37.569 (**+0.29 further**) — could only have come from the other frames |

That +0.29 dB is the first genuine multi-frame detail recovery in this project.
The larger +1.03 dB is deconvolution and is not multi-frame at all — worth
having, worth not mislabelling.

**It is off unless the source is clean, and that is not a tuning preference.**
Back-projection pulls the picture toward the pixels actually observed; on a
compressed source those pixels are blocky, so it faithfully reprints the
artifacts the restore stage just removed. Forced on, blockiness went 1.312 back
to 1.570 — the entire restore stage undone — and with no restore stage in front
it reached 1.919, worse than doing nothing at all. It is driven from the same
blockiness measurement as Deblock and reaches zero by 1.35.

## Install

```bash
open -a "Google Chrome" --args --new-window "chrome://extensions"
```

Turn on **Developer mode**, click **Load unpacked**, choose this folder.

Cross-origin *embedded* players (an iframe player on someone's blog) need a
broader grant than `activeTab` gives. If you want those, rename
`"_host_permissions"` to `"host_permissions"` in `manifest.json` and reload. It's
off by default on purpose — it's a broad permission and you don't need it for
YouTube, Netflix, Twitch, or anything else that hosts its own player.

## Tests

One command, no setup — it serves the project, drives headless Chrome through
both harnesses, and exits non-zero on any failure:

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler" && python3 test/run.py
```

Current: **128 passed, 0 failed, 1 skipped.** The skip is the perf check, which
headless cannot measure honestly (see below). The count wobbles by two:
`test/webgpu.html` races the headless runner's virtual clock during GPU init. It
never *fails* — one check is emitted synchronously, so "produced no checks at
all" cannot pass silently.

To watch them run, or to get a real perf number, serve the folder and open the
pages in a normal Chrome window instead:

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler" && python3 -m http.server 8791
```

`http://127.0.0.1:8791/test/harness.html` (GPU pipeline) and
`.../test/integration.html` (DOM integration).

### Verification ledger

`ledger status` in this folder is the machine-checked truth:

**20 active claims: 17 passing, 0 failing, 2 awaiting a human, 1 attested.**

| | claim |
|---|---|
| PASS | `pkg-loadable` — valid MV3 package Chrome can load unpacked |
| PASS | `render-pipeline` — GPU correctness + DOM integration |
| PASS | **`no-settings-to-get-wrong`** — one input, zero pickers, and no quality value survives a reload |
| PASS | `perf-budget-reconstruction` — 1080p→4K in 10.54 ms of a 16.7 ms budget |
| PASS | `no-harm-on-bad-sources` — `max` stays within 1.0 dB of untouched on a crf45 rip |
| PASS | `restore-removes-compression-damage` — 75% of the excess blocking, with the signature a blur cannot fake |
| PASS | `restore-measures-the-source` — strength, grid phase and grid period are all measured, not assumed |
| PASS | **`auto-denoise-fitted-on-detail-split-v2`** — denoise auto-tunes too, on a metric a blur cannot fool |
| ATTD | **`loads-and-runs-in-real-chrome`** — confirmed on live 4K YouTube, in fullscreen |
| **MANL** | `invocation-remaining-paths` — context menu, auto-run, Cmd+Shift+U, ON badge |
| PASS | `rescue-preset-dominates` — beats the previous best preset on every source, including clean |
| PASS | `multiframe-reconstruction` — real detail from neighbouring frames, isolated by the copies-vs-real ablation |
| PASS | `backprojection-gated-on-source-quality` — and it has to be; ungated it reprints the blocking |
| PASS | `cnn-was-data-limited` — 320→900 frames moved it +1.016→+1.278 dB |
| PASS | `cnn-architecture-is-not-the-limiter` — four controlled variants; the shipped one won |
| PASS | `webgpu-does-not-rescue-the-cnn-v2` — 1.11×/1.32×, still doesn't fit |
| PASS | `better-source-verified-live` — verified on a real 4K YouTube video |
| PASS | **`output-paths-screenshare`** — **proven**: the picture reaches an OS screen capture |
| **MANL** | `output-paths-external-display` — **unproven, needs HDMI / an AirPlay receiver** |
| PASS | **`invocation-wiring`** — every decision the service worker makes, against a mock `chrome.*` |
| **MANL** | `invocation-in-real-chrome` — **unproven; Chrome 151 ignores `--load-extension`, so this needs a person** |

Fourteen further claims have been **retired** rather than deleted, each with the
reason recorded in `LEDGER.json` — mostly figures that were true when measured
and stopped describing the code once a stage was added. A retired claim is not a
deleted one; the reason it stopped being true is the interesting part.

The two remaining unproven ones are deliberately not marked green. Nothing here
has been through a real HDMI cable or a real AirPlay mirror; and the context
menu, per-site auto-run and ON badge only exist inside a real extension context,
which the headless harness cannot create.

What the checks measured on this Mac:

- **EASU is 31% straighter on a diagonal edge than Lanczos** — edge-position RMS
  1.278px → 0.884px across 296 rows. This is the whole reason for the swap.
- EASU **does not ring**: output stays inside the source range (24..236 vs
  25..235, the ±3 being dither).
- **RCAS adds +28% high-frequency energy** (the old CAS managed +14%).
- 1:1 resample still **pixel-identical**, mean |Δ| 0.219/255 — all of which is
  dither. This catches half-pixel kernel drift, the classic resampler bug.
- **Minification was aliasing badly and is now fixed.** A fixed-width kernel
  skips most of the source pixels an output pixel covers when shrinking. On a 3x
  downscale of a 2px checkerboard — which carries no representable detail, so a
  correct filter returns flat grey — the old path measured **sd 104.98 (moire)**
  and the fixed path measures **sd 0.52**. This mattered in practice: a video
  playing in a window smaller than its source is being minified, which is what
  windowed YouTube does.
- **Local contrast raises mid-scale structure +11%**, shadow lift opens a dark
  region from luma 14 to 67 without washing it out, and vibrance takes a muted
  patch from saturation 30 to 48 while leaving neutral grey exactly neutral.
- **Chroma reconstruction removes 83% of 4:2:0 colour bleed** — a simulated
  colour edge blurred to 6px wide comes back at 1px, with luma untouched (drift
  0.03/255) and no desaturation away from edges (0.0%). Plain luma-weighted
  *averaging* of chroma was tried first and recovered 0%: contaminated and clean
  pixels on the same side of an edge share a luma value, so a similarity weight
  cannot separate them and merely spreads the fringe. Averaging cannot undo a
  low-pass; a local linear fit against sharp luma can.
- **Temporal accumulation cuts noise 71%** over 24 frames (11.77 → 3.38 measured
  against a noise-free ground truth) while holding true edge contrast to within
  2% — and a hard cut is adopted on the very next frame (|Δ| 2.52/255 against a
  clean render), so it does not ghost.
- **The GLSL port matches PyTorch across the WHOLE frame** — interior mean
  0.0379/255, border mean 0.0214/255. Three bugs had to be fixed to get there. The
  engine uploads flipped, so the CNN's vertical kernel taps had to be negated
  (convolution is not flip-invariant) AND the pixel-shuffle row parity inverted —
  fixing either alone made the error *worse*. Separately the model had to be
  retrained with `padding_mode="replicate"` to match the shader's CLAMP_TO_EDGE
  sampling; with PyTorch's default zero padding the interior looked perfect while
  the border was out by 53.93/255.
- **1080p → 4K in 10.54 ms/frame** with every classical stage on, against a
  16.7 ms budget — 6.16 ms of headroom. The restore pass costs 1.37 ms of that
  and optical flow plus back-projection 1.59 ms; chroma reconstruction and the
  multi-scale base are close to free, because they fold into passes that were
  already running or work at 1/16 resolution. **With the neural doubler
  additionally on it is 15.06 ms**, which still fits — the doubler alone costs
  4.52 ms, and it stays off because +0.09 dB does not earn that, not because it
  cannot run.
  *(This figure has been restated four times as stages were added — 3.58 → 6.28
  → 7.85 → 9.56 → 10.54 ms. Each superseded version is a retired claim in
  `LEDGER.json` rather than an edit, because a perf number is only meaningful
  next to the chain it was measured on.)*
- Deband is honest but modest: longest banding plateau 12.6px → 11.4px (9%,
  averaged over 28 rows), and it leaves dense detail alone (|Δ| 0.020/255 across
  a zone plate). **The dither does most of the debanding**; this pass refines on
  top. Measured equally effective on dark and mid-tone ramps (10% vs 9%) — an
  earlier single-row measurement suggested dark scenes were under-treated, and
  averaging properly showed that was noise.
- overlay lands exactly on the `object-fit: contain` picture box (not the element
  box) inside a bordered, padded, statically-positioned parent
- **every `object-fit` mode runs on the GPU**, including the cropping ones
  (`cover`, `none`). YouTube sets `object-fit: cover`, and an earlier build
  refused GPU mode on that keyword outright — so the entire engine was inactive
  on YouTube and it silently ran in filter mode. The renderer now takes a source
  sub-rect and crops properly.

Three caveats on how that was verified, since each one started as a false green:

- Throughput uses a blocking `readPixels`, because `gl.finish()` does not
  reliably sync on ANGLE/Metal — it first reported an impossible 0.03 ms/frame.
- Under headless Chrome, `--virtual-time-budget` fakes the clock, so the perf
  assertion passed *vacuously* at "0.00 ms/frame, ~Infinity fps". `test/run.py`
  now reports SKIP there rather than banking a green it didn't earn.
- Click-through is asserted via computed `pointer-events`, not a hit-test: the
  headless pane reports a 0×0 layout viewport where every `elementFromPoint`
  returns null.

**Verified since:** the screenshare path is now **proven** — `python3
tools/verify-screenshare.py` drives a real Chrome window and captures it through
the OS compositor, the same path Zoom and Meet read. And the better-source lever
was confirmed on a **real 4K YouTube video**, which is what caught
`getPlaybackQuality()` lying about the tier for 40+ seconds after the switch had
already happened.

**Still not verified anywhere:** behaviour on real Netflix or Twitch pages (the
DRM fallback is exercised only against a synthetic black-frame source), real
fullscreen, an actual HDMI cable or AirPlay mirror, and the extension running as
a loaded extension in a browser.

That last one used to read "the three invocation paths are completely untested".
They are now covered as far as this machine can cover them: `invocation-wiring`
drives the service worker against a mock `chrome.*` API and checks every decision
it makes — menu items, the injection order, the origin handed to the options
page, the per-site auto-run registration and teardown, the cross-origin fallback,
the ON badge. What is left is whether the browser loads the thing and delivers
those events, and that is genuinely not automatable here: **Chrome 151 ignores
`--load-extension` from the command line**, headless or headful, with the feature
flag re-enabled and developer mode pre-seeded. So `invocation-in-real-chrome`
stays manual, and it wants a person with a browser rather than a better script.

## Honest limits

- This is **classical** upscaling — edge-adaptive resampling, adaptive
  sharpening, denoise, deband, deblock, dering, and multi-frame back-projection.
  Real-ESRGAN-class models cannot run at 4K60 in a browser; shader-based methods
  are the realistic ceiling and this is a good one.
- **It recovers a little real detail, and only a little.** Back-projection
  genuinely reconstructs from neighbouring frames — the copies-vs-real-frames
  ablation isolates **+0.29 dB** that could only have come from the other frames.
  That is a real effect and a small one. It does not reconstruct what the encoder
  deleted, and nothing at this speed can. On a soft 480p source expect *cleaner
  and better-defined*, not a 4K master.
- Deblocking **detects** the transform grid rather than assuming it — phase and
  period are measured per axis, so a 4×4 transform (AV1, HEVC) and a picture
  whose grid is offset from the origin are both handled. What it cannot do is
  filter a grid that has been resampled into non-integer spacing, e.g. a rip
  that was scaled after encoding.
- The trained doubler ships but stays **off by default**, because it does not
  beat the classical path for what it costs. Porting the
  engine to WebGPU compute was measured as a way to afford a bigger model and
  **does not work**: with `shader-f16` and workgroup tiling it runs the shipped
  model 1.11× faster and a 16-filter model 1.32× faster, which still does not
  fit the frame budget. The constraint is arithmetic, not the graphics API.
  `test/webgpu.html` keeps that measurement so nobody has to re-derive it.
- 5–7 GPU passes per presented frame depending on settings. On battery, expect measurable drain.

## Layout

```
manifest.json      MV3; activeTab + per-site optional grants
background.js      injection, context menus, auto-run registration, ON badge
options.html/.js   per-site allow list; holds the user gesture permissions need
core.js            WebGL2 engine — no chrome.* APIs, so it is testable standalone
content.js         video discovery, overlay geometry, DRM fallback, control panel
tools/make-icons.py  generates icons/ from scratch, no deps
test/              harness.html (GPU) · integration.html (DOM)
                   background.html — the service worker's wiring, against a
                   mock chrome.* API
                   compare.html / look.html / panel-look.html — serve the folder
                   and open them; the eye checks the numbers cannot make
```
