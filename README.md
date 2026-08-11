# Video Upscaler

A Chrome extension you invoke on a specific page to upscale and sharpen whatever
video is playing there. The processed picture is composited into the page, so it
survives screenshare, AirPlay **mirroring**, and HDMI.

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

| Output path | Works? | Why |
|---|---|---|
| **HDMI to a TV** | ✅ Yes | macOS composites the whole window to the display. The upscaled pixels are the window. |
| **AirPlay Screen Mirroring** (Control Center → Screen Mirroring) | ✅ Yes | Same — it mirrors the composited desktop. |
| **Screenshare** (Zoom, Meet, Teams, Discord) | ✅ Yes | Screen/window capture reads composited output. |
| **Native AirPlay video** (the AirPlay button *inside* the player) | ❌ **No** | This hands the raw stream URL to the Apple TV. Your Mac stops rendering the video entirely, so there is nothing for the extension to touch. **Use Screen Mirroring instead.** |
| **Picture-in-Picture** | ❌ No | The OS PiP window renders the raw video element directly, bypassing the page. |

The one thing to actually remember: **for AirPlay, use Screen Mirroring, not the
player's own AirPlay button.**

## Two modes

**GPU mode** (default where possible) — engine v2, three passes per frame:

1. **clean**, at source resolution — edge-preserving bilateral denoise, **deband**
   to dissolve the contour steps low-bitrate gradients break into, and **chroma
   reconstruction**. Video is 4:2:0: colour is stored at quarter resolution, so
   colour edges arrive soft and bleed past the luma edge they belong to. Luma
   survives at full resolution, so chroma is refit as a local linear function of
   luma (a guided filter — the same idea AV1 calls chroma-from-luma) and colour
   snaps back onto the structure it belongs to. Cleaning before magnification
   beats cleaning after.
2. **neural 2x luma doubler — OFF by default.** A 1540-parameter CNN trained on
   live-action video, running as four WebGL2 fragment passes. It beats Lanczos-3
   by +1.35 dB on its own benchmark, but measured against a clean original it is
   only **+0.09 dB** on a compressed source and **−0.25 dB** on a clean one
   versus the EASU path that actually ships — for ~5 ms/frame. It does not earn
   its cost, so the toggle exists and the default is off. The full story, and
   why every permissively-licensed alternative is anime-trained, is in
   `cnn/README.md`.
3. **upscale** — **FSR 1.0 EASU**, which orients its kernel along the local edge
   instead of filtering blindly, so diagonals stop staircasing. Separable
   **Lanczos-3** is still selectable in the panel.
4. **temporal accumulation** — the only stage that recovers real information
   rather than inferring it. Consecutive frames of the same scene carry slightly
   different sub-pixel samples, so averaging across time genuinely removes noise
   and firms up detail. With no motion vectors available it uses neighbourhood
   clamping: history is clipped to the local colour box of the current frame, so
   anything that moved is rejected outright. Big gain on static and slow shots,
   gracefully nothing on fast motion, no ghosting either way.
5. **local contrast, vibrance and shadow lift** — the perceived-quality layer.
   Local contrast works at the tens-of-pixels scale (a different thing from
   sharpening, which works at the pixel scale) and is what reads as depth and
   pop; it boosts the band between two cheap downsampled blurs, clamped so it
   cannot become a halo. Vibrance pushes muted colour hard and already-saturated
   colour barely at all, backing off on skin tones. Shadow lift opens dark scenes
   with a term that vanishes at both ends, so black is never crushed or clipped.
   **These push the image away from what was encoded, on purpose.**
6. **finish** — **RCAS** sharpening (its limiter is derived from the local
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

## Controls

Panel is draggable and collapsible. Everything persists across pages.

- **Auto / GPU / Filter** — force a mode
- **Neural ON / off** — the trained CNN doubler
- **FSR / EASU** vs **Lanczos** — swap the upscaler live and A/B it
- **Detail · Vibrance · Shadows** — the perceived-quality controls
- Presets: `subtle` · `standard` · `film` · `sports` · `anime` · `reference` · **`max`** · **`rescue`**
- Sharpen · Denoise · **Deblock** · **Dering** · **Deband** · **Colour fix** · **Temporal** · Anti-ring · Saturation · Contrast · Brightness
- **Render ×** — supersample above native pixels (1.0 is right for most cases)
- **A/B split** — drag to reveal the untouched source on the left
- Hold **`** (backtick) to bypass entirely while watching

The panel reads out `source → output` resolution and live fps, so you can confirm
it's doing something. It follows the video into fullscreen.

## Just pick `max`

**`max` is the one to pick.** Everything on, tuned to look its best. It is the
strongest preset in the panel — there is deliberately nothing better to choose,
and a test fails if any other preset ever scores higher on the perceived-quality
controls. Pick it once and it persists; a test also checks that every value it
sets survives a reload, because a setting that silently reverts is the reason
people end up re-picking their preferences every session.

It is *not* every-slider-at-100%. That rings, smears and wrecks colour. What
makes it the top setting is that everything is on and two things become adaptive:

**It climbs until it stops being visible — or until your GPU objects, whichever
comes first.** Render scale steps up every few seconds while frames are clean and
steps back down the moment they are not. The drop signal is exact rather than
guessed: `requestVideoFrameCallback` reports how many frames the browser actually
presented, so if that counter outruns our callbacks, those are frames we failed
to keep up with. Deliberate hysteresis stops it oscillating. The ceiling is
**x1.25 of the video's device-pixel size** — past that the compositor discards
the extra, so climbing further costs battery for pixels nobody sees.

**It scales effort to the source.** A 480p film stretched to 4K gets materially
more sharpening and deband than a 1080p one.

`max` is deliberately *not* the most faithful setting — local contrast, vibrance
and shadow lift push past what was encoded, which is what every TV ships doing.
If you ever want the source as authored, that is **`reference`**.

If max is too much on some content, the two sliders to pull back are **Detail**
and **Vibrance**; adaptation stays on when you do.

## …unless the source is genuinely bad, then pick `rescue`

Everything else in this extension repairs damage done by *scaling*. `rescue` is
the preset that goes after damage done by the *encoder* — the thing that actually
makes a low-bitrate rip look like a low-bitrate rip.

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
against 1.202 for period 8. Move the Deblock or Dering slider and you take
control back, exactly like Render ×.

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

Current: **55 passed, 0 failed, 1 skipped.** The skip is the perf check, which
headless cannot measure honestly (see below).

To watch them run, or to get a real perf number, serve the folder and open the
pages in a normal Chrome window instead:

```bash
cd "$HOME/Desktop/AI Projects/video-upscaler" && python3 -m http.server 8791
```

`http://127.0.0.1:8791/test/harness.html` (GPU pipeline) and
`.../test/integration.html` (DOM integration).

### Verification ledger

`ledger status` in this folder is the machine-checked truth:

| | claim |
|---|---|
| PASS | `pkg-loadable` — valid MV3 package Chrome can load unpacked |
| PASS | `render-pipeline` — GPU correctness + DOM integration, 55 checks |
| ATTD | `perf-4k` — 1080p→4K inside a 60 fps budget (vouched, not machine-checked) |
| **MANL** | `output-paths` — **unproven, needs your hardware** |
| **MANL** | `invocation-paths` — **unproven, needs a real Chrome profile** |

The two unproven ones are deliberately not marked green. Nothing here has been
through a real HDMI cable, a real AirPlay mirror, or a real Zoom call; and the
context menu, per-site auto-run and ON badge only exist inside a real extension
context, which the headless harness cannot create.

What the checks measured on this Mac (engine v2, 2026-08-04):

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
  0.035/255, border mean 0.039/255. Three bugs had to be fixed to get there. The
  engine uploads flipped, so the CNN's vertical kernel taps had to be negated
  (convolution is not flip-invariant) AND the pixel-shuffle row parity inverted —
  fixing either alone made the error *worse*. Separately the model had to be
  retrained with `padding_mode="replicate"` to match the shader's CLAMP_TO_EDGE
  sampling; with PyTorch's default zero padding the interior looked perfect while
  the border was out by 53.93/255.
- **1080p → 4K in 11.39 ms/frame with the CNN**, 6.52 ms without: the neural
  doubler alone costs **4.88 ms**, more than the rest of the chain combined. It
  fits 60 fps with 1.5x headroom rather than 2.6x, so it is a real trade.
- **1080p → 4K in 6.40 ms/frame running the classical Vivid chain** — every stage
  on — which is 2.6× headroom at 60 fps. Temporal costs 1.60 ms of that; chroma
  reconstruction and the multi-scale base are close to free because they fold
  into passes that were already running or work at 1/16 resolution.
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

**Not verified anywhere:** behaviour on real YouTube/Netflix/Twitch pages, in
real fullscreen, or through an actual HDMI / AirPlay / screenshare path. Those
need your hardware — that's the `output-paths` claim sitting unproven.

## Honest limits

- This is **classical** upscaling — edge-adaptive resampling, adaptive
  sharpening, denoise, deband, deblock and dering. It is not a neural upscaler. Real-ESRGAN-class models cannot run at 4K60 in a browser;
  shader-based methods are the realistic ceiling and this is a good one.
- It cannot add detail that isn't there. On a soft 480p source it will look
  cleaner and better-defined, not like a 4K master. `rescue` removes the
  artifacts sitting on top of a bad source; it does not reconstruct what the
  encoder deleted, and nothing at this speed can.
- Deblocking assumes the transform grid is 8-aligned from the picture origin,
  which is true of the MPEG family. AV1 and HEVC also use 4×4 transforms, whose
  odd boundaries are left alone.
- It is not a neural upscaler and the trained doubler stays off by default,
  because it does not beat the classical path for what it costs. Porting the
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
```
