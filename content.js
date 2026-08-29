/* ------------------------------------------------------------------------
 * Video Upscaler — page integration
 * Injected on demand (toolbar click / Cmd+Shift+U). Re-injection toggles.
 * --------------------------------------------------------------------- */
(() => {
  'use strict';

  if (window.__VU__) { window.__VU__.toggle(); return; }

  const PRESETS = {
    off:      { sharpen: 0.00, neural: 0, detail: 0.00, vibrance: 0.00, shadow: 0.00, denoise: 0.00, chroma: 0.00, deband: 0.00, temporal: 0.00, antiring: 0.00, saturation: 1.00, contrast: 1.00, gain: 1.00, backproject: 0.00, deblock: 0.00, dering: 0.00 },
    subtle:   { sharpen: 0.28, neural: 0, detail: 0.15, vibrance: 0.10, shadow: 0.05, denoise: 0.05, chroma: 0.40, deband: 0.20, temporal: 0.00, antiring: 0.45, saturation: 1.00, contrast: 1.00, gain: 1.00, backproject: 0.00, deblock: 0.25, dering: 0.15 },
    standard: { sharpen: 0.50, neural: 0, detail: 0.30, vibrance: 0.20, shadow: 0.10, denoise: 0.15, chroma: 0.60, deband: 0.35, temporal: 0.35, antiring: 0.55, saturation: 1.04, contrast: 1.02, gain: 1.00, backproject: 0.00, deblock: 0.45, dering: 0.30 },
    film:     { sharpen: 0.36, neural: 0, detail: 0.35, vibrance: 0.15, shadow: 0.22, denoise: 0.10, chroma: 0.70, deband: 0.55, temporal: 0.50, antiring: 0.65, saturation: 1.02, contrast: 1.05, gain: 1.00, backproject: 0.00, deblock: 0.50, dering: 0.35 },
    sports:   { sharpen: 0.66, neural: 0, detail: 0.40, vibrance: 0.30, shadow: 0.10, denoise: 0.22, chroma: 0.50, deband: 0.30, temporal: 0.20, antiring: 0.50, saturation: 1.06, contrast: 1.02, gain: 1.00, backproject: 0.00, deblock: 0.40, dering: 0.25 },
    anime:    { sharpen: 0.78, neural: 0, detail: 0.35, vibrance: 0.35, shadow: 0.10, denoise: 0.32, chroma: 0.70, deband: 0.60, temporal: 0.40, antiring: 0.85, saturation: 1.10, contrast: 1.02, gain: 1.00, backproject: 0.00, deblock: 0.55, dering: 0.50 },
    // Faithful: RECONSTRUCTION only — neural doubler, chroma, deband, denoise,
    // temporal — and no look at all. Local contrast, vibrance and shadow lift are
    // zero here by definition, because each of them moves the picture away from
    // what was encoded. (This preset previously ran detail 0.50, which is not
    // faithful and is measurably destructive on compressed sources.)
    reference:{ sharpen: 0.30, neural: 0, detail: 0.00, vibrance: 0.00, shadow: 0.00, denoise: 0.25, chroma: 0.80, deband: 0.55, temporal: 0.60, antiring: 0.80, saturation: 1.00, contrast: 1.00, gain: 1.00, backproject: 0.00, deblock: 0.50, dering: 0.35 },
    // THE ONE TO PICK. Everything on, and safe on BAD sources — which is the
    // case that actually matters, because the reason to upscale is usually that
    // the source is not good.
    //
    // These numbers were cut hard after measuring against a clean original: the
    // previous values (detail 0.80, shadow 0.40, vibrance 0.60, sharpen 0.62)
    // put a crf45 rip 7.07 dB FURTHER from ground truth than doing nothing at
    // all. Roughly 4.3 dB of that was the reconstruction stages amplifying
    // compression artifacts instead of reconstructing, and the rest was shadow
    // lift dragging up the noise floor of a dark scene.
    //
    // Every "is there more detail" metric missed this, because on a compressed
    // source amplified artifact and recovered detail are the same high-frequency
    // energy. Only distance to a clean original can tell them apart.
    //
    // Ablating each stage against ground truth on a crf45 rip named the culprit
    // unambiguously (untouched = 24.50 dB):
    //     denoise 24.51   deband 24.50   sharpen 24.47   chroma 24.41
    //     detail  23.23  <-- costs 1.27 dB on its own
    // LOCAL CONTRAST boosts the 8-64px band, which is exactly where DCT blocking
    // and mosquito noise live. It is the strongest lever on CLEAN content and
    // the most destructive one on compressed content, so it is kept low here.
    // (There is no longer a way to raise it by hand, which is the point.)
    max:      { sharpen: 0.42, neural: 0, detail: 0.12, vibrance: 0.20, shadow: 0.10, denoise: 0.30, chroma: 0.85, deband: 0.60, temporal: 0.55, antiring: 0.80, saturation: 1.02, contrast: 1.01, gain: 1.00, backproject: 0.00, deblock: 0.70, dering: 0.50 },
    // RESCUE — for a source that is genuinely bad: a low-bitrate rip, an old
    // upload, anything where the picture is breaking into blocks. It is the only
    // preset tuned against COMPRESSION damage rather than scaling damage.
    //
    // Measured against a clean original it beats `max` on every source tested,
    // including a clean one (so it costs nothing to leave selected):
    //     clean plate    max 31.80 dB -> rescue 31.98 dB
    //     crf45 rip      max 24.26 dB -> rescue 24.34 dB, blockiness 1.74 -> 1.18
    //     JPEG q=0.12    max 27.46 dB -> rescue 28.02 dB, blockiness 2.54 -> 1.28
    // "Blockiness" is the average gradient across an 8-px transform boundary
    // over the average gradient inside a block; 1.0 means no blocking left. It
    // cannot be faked by blurring, which lowers both halves of the ratio.
    //
    // What it does NOT do: bring back detail the encoder threw away. Nothing
    // can. It removes the artifacts sitting on top of what survived. Sharpen is
    // LOWER here than in `max` on purpose — sharpening a soft rip mostly
    // amplifies whatever the deblocker did not catch.
    rescue:   { sharpen: 0.35, neural: 0, detail: 0.12, vibrance: 0.18, shadow: 0.10, denoise: 0.45, chroma: 0.85, deband: 0.75, temporal: 0.65, antiring: 0.85, saturation: 1.02, contrast: 1.01, gain: 1.00, backproject: 0.00, deblock: 0.90, dering: 0.70 },
  };

  /* There is exactly ONE shipped configuration and the user cannot change it.
   *
   * `rescue` is it, and that is a measured choice rather than a taste one: it
   * beats every other preset against a clean original on every source tested,
   * INCLUDING a clean one (clean plate 31.80 -> 31.98 dB, crf45 rip 24.26 ->
   * 24.34, JPEG q0.12 27.46 -> 28.02). There is no source on which picking
   * something else would have been better, so there is nothing to pick.
   *
   * The presets below survive as internal tuning profiles: the test suite and
   * the ablation harness drive them programmatically via __VU__.preset(), the
   * A/B split needs an untouched baseline, and if per-shot look adaptation is
   * ever built and MEASURED it will select among them. They are simply not
   * surfaced any more.
   */
  const DEFAULTS = Object.assign({
    enabled: true,
    mode: 'auto',          // auto | gpu | filter — resolved automatically, with
                           // filter as the fallback when frames cannot be read
    upscaler: 'fsr',       // fsr (edge-adaptive EASU) | lanczos
    // OFF by default. Measured against a clean original, the trained doubler is
    // +0.09 dB on a compressed source and -0.11 dB on a clean one versus EASU
    // alone — i.e. invisible at best, mildly harmful at worst — for 4.52 ms of
    // GPU per frame. The toggle stays because the model is good in isolation
    // (+1.278 dB vs Lanczos-3 on its own test split); it simply does not beat
    // the classical path that actually ships.
    neural: 0,
    preset: 'rescue',      // the only shipped configuration — see above
    renderScale: 1.0,      // supersample factor on top of device pixels; driven
                           // by the governor, never by hand any more
    detail: 0.30,          // local contrast — the biggest perceived-quality lever
    vibrance: 0.20,        // saturation that protects skin and already-vivid colour
    shadow: 0.10,          // opens dark scenes without crushing black
    chroma: 0.60,          // rebuild 4:2:0 colour detail using luma as a guide
    backproject: 0.00,     // reconstruct against the observed pixels; auto on the adaptive presets
    deblock: 0.45,         // dissolve the 8px DCT grid a low bitrate leaves behind
    dering: 0.30,          // mosquito noise in the skirt around strong edges
    temporal: 0.35,        // multi-frame accumulation (0 = single frame only)
    adaptive: true,        // climb render scale until frames drop, then back off
    autoRestore: true,     // drive deblock/dering from a measurement of the source
    maxWidth: 5120,
    split: 0,
    collapsed: false,
  }, PRESETS.rescue);

  /**
   * Blockiness -> deblock strength.
   *
   * Fitted to the strengths that measured best against a clean original, rather
   * than picked by eye:
   *     clean plate  1.06 -> 0        crf45 rip    2.23 -> ~0.6
   *     JPEG q=0.25  2.01 -> ~0.7     JPEG q=0.12  2.82 -> ~0.85
   * The curve lands within ~0.1 of every one of those, and the PSNR surface
   * around each optimum is flat to about +/-0.15, so that is inside the noise.
   * Square root rather than linear because the damage climbs faster than the
   * useful correction does.
   */
  function autoDeblock(blockiness) {
    const t = Math.max(0, Math.min(1, (blockiness - 1.15) / 2.0));
    return 0.90 * Math.sqrt(t);
  }

  /**
   * Blockiness -> back-projection gain.
   *
   * Back-projection pulls the estimate toward the pixels that were ACTUALLY
   * OBSERVED, which is what lets it reconstruct rather than average. On a clean
   * source that is the single biggest quality gain in this engine: +1.03 dB of
   * deconvolution, plus a further +0.29 dB of genuine multi-frame recovery when
   * consecutive frames sample the scene at different sub-pixel offsets.
   *
   * On a COMPRESSED source the observed pixels are blocky, and back-projection
   * faithfully reprints the blocking that the restore stage just removed.
   * Measured on a crushed fixture: restore alone took blockiness 1.587 -> 1.312,
   * and back-projection at full strength put it back to 1.572 — with PSNR ending
   * up WORSE than doing nothing at all. Without the restore stage in front it
   * reached 1.919, worse than untouched on both counts.
   *
   * So it is gated on the same measurement that drives deblock, and gated
   * tightly: full only on a genuinely clean source, off by the time blocking is
   * merely noticeable.
   */
  /**
   * Blockiness -> denoise strength.
   *
   * Fitted to the strengths that measured best against a clean original, on a
   * ladder of JPEG degradations plus the real rip (worst error 0.018):
   *     clean  1.06 -> 0        q0.35  1.76 -> 0.8      q0.12  2.82 -> 1.0
   *     q0.6   1.46 -> 0.6      q0.2   2.17 -> 1.0      rip    2.23 -> 1.0
   * Square root for the same reason as deblock: the damage climbs faster than
   * the useful correction does.
   *
   * 🔴 The naive version of this measurement was WRONG and would have shipped a
   * blur. A single PSNR number rises monotonically to denoise=1.0 on every
   * compressed source and never turns over, which is what "smoothing lowers
   * mean squared error" looks like, not what an optimum looks like.
   *
   * What settles it is splitting the score by how much detail the GROUND TRUTH
   * carries at each pixel — a split defined on the clean original, so it shares
   * no null space with the filter being tuned (the same construction that makes
   * the deblock claim trustworthy). Read that way the stage defends itself: on a
   * CLEAN plate denoise damages both halves (-15.6 dB detailed, -5.9 dB flat at
   * full strength — the signature of a blur), while on a compressed source BOTH
   * halves improve (q0.2 at full: +0.264 dB detailed, +0.763 dB flat). A blur
   * cannot lift both. At those compression levels the high-frequency content in
   * "detailed" regions is mostly artifact, so removing it really does move
   * toward the original.
   *
   * Only at MILD compression does detail turn over before full strength (q0.6
   * peaks at 0.6 and goes negative by 1.0), which is exactly what the curve's
   * slow start protects.
   */
  function autoDenoise(blockiness) {
    return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, (blockiness - 1.10) / 1.05))));
  }

  function autoBackproject(blockiness) {
    return Math.max(0, Math.min(1, (1.35 - blockiness) / 0.23));
  }

  const GRID_INTERVAL = 2000;   // ms; measureGrid does a readPixels, which stalls

  /* --------------------------------------------------------- better source
   *
   * Every pass in core.js redistributes information that already arrived. This
   * is the only part of the extension that can increase it. If the player
   * settled on 720p while 2160p was available, no amount of shader work comes
   * close to simply fetching the better stream.
   *
   * It is NOT automatic. Quadrupling the bitrate is the user's bandwidth to
   * spend, and a video extension silently doing that on a metered connection is
   * not a good trade to make on someone's behalf. So: measure always, report
   * plainly, upgrade on one click.
   */
  const QUALITY_LABEL = {
    tiny: '144p', small: '240p', medium: '360p', large: '480p',
    hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '2160p',
    hd2880: '2880p', highres: '4320p',
  };
  const source = {
    info: null,          // last probe result
    pending: false,
    at: 0,

    probe(apply, done) {
      if (this.pending) return;
      this.pending = true;
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        this.pending = false;
        if (res && !res.error) { this.info = res; this.at = Date.now(); }
        done && done(this.info);
      };
      try {
        chrome.runtime.sendMessage({ type: 'vu-source', apply: !!apply }, (res) => {
          // A missing receiver sets lastError; reading it stops the console noise.
          void chrome.runtime.lastError;
          finish(res);
        });
      } catch (_) { finish(null); }
      // The worker can be asleep; never leave the button spinning forever.
      setTimeout(() => finish(null), 4000);
    },

    /** What the panel should say, or null if there is nothing worth saying. */
    summary() {
      const i = this.info;
      if (!i) return null;
      const best = i.best ? (QUALITY_LABEL[i.best] || i.best) : null;
      const cur = i.current ? (QUALITY_LABEL[i.current] || i.current) : null;
      // Only offer an upgrade when there is genuinely a better tier to move to.
      const rank = Object.keys(QUALITY_LABEL);
      const better = !!(i.best && i.current &&
                        rank.indexOf(i.best) > rank.indexOf(i.current));
      return {
        srcW: i.srcW, srcH: i.srcH, boxW: i.boxW, boxH: i.boxH,
        best, cur, better, youtube: i.kind === 'youtube',
        // "requested", not "applied": the player can refuse, or drift back down
        // on its own. What actually happened shows up in `cur` on the re-probe.
        requested: !!i.requested,
        // The honest headline for every other site: how much of the panel the
        // source can actually fill on its own.
        stretch: (i.srcW && i.boxW) ? (i.boxW / i.srcW) : 0,
      };
    },
  };
  const MIN_AREA = 40000;  // ignore thumbnails / tracking pixels (~200x200)
  const S = Object.assign({}, DEFAULTS);

  let units = new Map();   // video element -> Unit
  let panel = null;
  let mo = null;
  let rafId = 0;
  let scanTimer = 0;
  let autoStarted = false;   // true when a per-site grant started us, not a click
  let bypassHeld = false;
  let saveTimer = 0;

  const storage = (() => {
    try { if (chrome?.storage?.local) return chrome.storage.local; } catch (_) {}
    return null;
  })();

  /**
   * A NAMED preset always means whatever the code currently says it means.
   *
   * Without this, selecting a preset writes its numbers to storage and those
   * stored numbers win forever — so changing a preset's definition never
   * reaches anyone who already picked it. That is not a hypothetical: `max`
   * was retuned after it was measured to be wrecking compressed sources, and
   * the old values kept loading anyway.
   *
   * Explicit slider edits set preset to 'custom', and custom values are
   * restored verbatim. Only named presets are re-derived.
   */
  function reconcilePreset() {
    const p = PRESETS[S.preset];
    if (!p) return false;                    // 'custom' or unknown: keep saved values
    Object.assign(S, p);
    S.adaptive = (S.preset === 'max' || S.preset === 'reference' || S.preset === 'rescue');
    // Auto restore is what makes one preset serve a Blu-ray and a bad rip. It is
    // off for the fixed-character presets (film, anime, sports) where the user
    // has picked a look and should get exactly it.
    S.autoRestore = S.adaptive;
    S.maxWidth = S.adaptive ? 5120 : 3840;
    if (!S.adaptive) S.renderScale = 1.0;
    return true;
  }

  /* The ONLY keys that survive a reload.
   *
   * Everything else is DERIVED — from the source measurement, from the frame
   * budget, or from the fact that there is exactly one shipped tuning — so
   * restoring a saved copy would pin someone to a stale configuration they now
   * have no UI to escape from. Removing the controls turned a recoverable bad
   * state into an unrecoverable one, and this list is what closes that.
   *
   * Not hypothetical, measured on a real upgrade path: an install carrying
   * `preset:'anime'` from the old build came back with adaptive AND autoRestore
   * both OFF — every automatic behaviour disabled — and one carrying
   * `preset:'custom'` came back pinned to detail 0.80, the tuning measured at
   * 7.07 dB WORSE than doing nothing, with no control left to undo it.
   *
   * `split` is excluded on purpose as well: it is a momentary A/B, and coming
   * back to a half-split picture reads as a broken render.
   */
  const PERSIST = ['collapsed'];

  function loadSettings() {
    return new Promise((res) => {
      if (!storage) return res();
      try {
        storage.get('vuSettings', (o) => {
          if (!chrome.runtime.lastError && o && o.vuSettings) {
            for (const k of PERSIST) {
              if (k in o.vuSettings) S[k] = o.vuSettings[k];
            }
          }
          // Re-derive the quality configuration from code every single start,
          // regardless of what was stored. This is what makes a retune reach an
          // existing install, and what migrates the old build's saved presets.
          reconcilePreset();
          res();
        });
      } catch (_) { res(); }
    });
  }

  function saveSettings() {
    if (!storage) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const out = {};
        for (const k of PERSIST) out[k] = S[k];
        storage.set({ vuSettings: out });
      } catch (_) {}
    }, 250);
  }

  /* ---------------------------------------------------------------- utils */

  /* Walking every element looking for shadow roots is expensive, and pages
   * like YouTube mutate constantly. So: do the deep walk rarely, remember the
   * shadow hosts it found, and use the cheap query in between. */
  let shadowHosts = new Set();
  let lastDeepWalk = -Infinity;   // must be -Infinity: performance.now() is < 3000 on a fresh page

  function collectVideos(deep) {
    const out = new Set();
    const now = performance.now();
    if (deep || now - lastDeepWalk > 10000) {
      lastDeepWalk = now;
      shadowHosts = new Set();
      const walk = (root) => {
        let all;
        try { all = root.querySelectorAll('*'); } catch (_) { return; }
        for (const el of all) {
          if (el.tagName === 'VIDEO') out.add(el);
          if (el.shadowRoot) { shadowHosts.add(el); walk(el.shadowRoot); }
        }
      };
      walk(document);
    } else {
      for (const v of document.querySelectorAll('video')) out.add(v);
      for (const host of shadowHosts) {
        if (!host.isConnected || !host.shadowRoot) { shadowHosts.delete(host); continue; }
        try { for (const v of host.shadowRoot.querySelectorAll('video')) out.add(v); } catch (_) {}
      }
    }
    return [...out];
  }

  function eligible(v) {
    const r = v.getBoundingClientRect();
    return r.width * r.height >= MIN_AREA && v.videoWidth > 0 && v.videoHeight > 0;
  }

  /**
   * Where the picture sits inside the element box, and which part of the source
   * is visible — every object-fit mode, including the cropping ones.
   *
   * YouTube uses `cover`. It sizes the element to the video's own aspect, so the
   * crop is usually empty, but the keyword is still `cover` and an earlier
   * version of this refused to run on it and fell back to filter mode.
   *
   * Returns dest rect in CSS px relative to the element box, plus src as a
   * normalised [x, y, w, h] sub-rect of the video frame.
   */
  function contentBox(v) {
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return { ok: false };

    const full = [0, 0, 1, 1];
    const cs = getComputedStyle(v);
    let fit = cs.objectFit || 'fill';
    if (fit === 'scale-down') fit = (vw <= r.width && vh <= r.height) ? 'none' : 'contain';

    if (fit === 'fill') {
      return { x: 0, y: 0, w: r.width, h: r.height, src: full, ok: true };
    }

    if (fit === 'contain') {
      const arV = vw / vh, arB = r.width / r.height;
      const w = arV > arB ? r.width : r.height * arV;
      const h = arV > arB ? r.width / arV : r.height;
      return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h, src: full, ok: true };
    }

    // cover / none: the box is filled and the SOURCE is cropped instead.
    // object-position is assumed centred (the default, and what players use).
    const scale = (fit === 'cover')
      ? Math.max(r.width / vw, r.height / vh)
      : 1;
    const visW = Math.min(vw, r.width / scale);
    const visH = Math.min(vh, r.height / scale);
    const sw = visW / vw, sh = visH / vh;
    const src = [(1 - sw) / 2, (1 - sh) / 2, sw, sh];

    // `none` at natural size smaller than the box leaves the surplus empty
    const w = Math.min(r.width, visW * scale);
    const h = Math.min(r.height, visH * scale);
    return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h, src, ok: true };
  }

  /* ------------------------------------------------------------- CSS mode */

  let svgHost = null;
  function ensureSvgFilter() {
    if (svgHost && svgHost.isConnected) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    svg.innerHTML =
      '<filter id="vu-sharp" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">' +
      '<feConvolveMatrix id="vu-kernel" order="3" preserveAlpha="true" ' +
      'kernelMatrix="0 0 0  0 1 0  0 0 0"/></filter>';
    (document.body || document.documentElement).appendChild(svg);
    svgHost = svg;
  }

  function updateSvgKernel() {
    ensureSvgFilter();
    // Unsharp cross kernel; k scaled so the slider range stays sane.
    const k = Math.max(0, Math.min(1, S.sharpen)) * 0.65;
    const c = 1 + 4 * k;
    const m = `0 ${-k} 0  ${-k} ${c} ${-k}  0 ${-k} 0`;
    const node = svgHost.querySelector('#vu-kernel');
    if (node) node.setAttribute('kernelMatrix', m);
  }

  function filterChain() {
    const parts = [];
    if (S.sharpen > 0.01) parts.push('url(#vu-sharp)');
    if (Math.abs(S.contrast - 1) > 0.001) parts.push(`contrast(${S.contrast.toFixed(3)})`);
    if (Math.abs(S.saturation - 1) > 0.001) parts.push(`saturate(${S.saturation.toFixed(3)})`);
    if (Math.abs(S.gain - 1) > 0.001) parts.push(`brightness(${S.gain.toFixed(3)})`);
    return parts.join(' ');
  }

  /* -------------------------------------------------------------- governor */

  /* "Highest quality it possibly can" is a moving target: it depends on the
   * clip, the window size, the panel and what else the GPU is doing. So rather
   * than guess a number, climb until the hardware objects.
   *
   * The signal is exact, not inferred. requestVideoFrameCallback reports
   * `presentedFrames` — how many frames the browser has actually put on screen.
   * If that counter advances faster than our callbacks fire, those are frames
   * we did not process, i.e. we are too slow. No timers, no heuristics. */
  const quality = {
    presented: 0,      // frames the browser presented this window
    handled: 0,        // frames we actually rendered
    windowStart: 0,
    goodWindows: 0,
    MIN: 1.0,
    // Ceiling is set by what the display can actually show, not by what the GPU
    // will tolerate. Past ~1.25x the video's device-pixel size the compositor
    // throws the extra away on the downscale, so climbing further costs real
    // GPU and battery for pixels nobody sees. Dropped frames are the *other*
    // limit; whichever binds first wins.
    MAX: 1.25,

    reset() {
      this.presented = this.handled = this.goodWindows = 0;
      this.windowStart = performance.now();
    },

    sample(delta) { this.presented += delta; this.handled += 1; },

    /** Called once per frame; adjusts S.renderScale at most every 2s. */
    tick(now) {
      if (!S.adaptive) return false;
      if (now - this.windowStart < 2000) return false;
      const presented = this.presented, handled = this.handled;
      this.presented = this.handled = 0;
      this.windowStart = now;
      if (handled < 15) return false;            // too little data to judge

      const dropRate = 1 - (handled / Math.max(presented, 1));
      const before = S.renderScale;

      if (dropRate > 0.03) {
        // We are dropping frames. Back off immediately and hold there a while.
        S.renderScale = Math.max(this.MIN, +(S.renderScale - 0.15).toFixed(2));
        this.goodWindows = -2;
      } else if (dropRate < 0.005) {
        // Clean window. Two in a row before spending more, so we do not
        // oscillate on a single lucky sample.
        if (++this.goodWindows >= 2 && S.renderScale < this.MAX - 1e-6) {
          S.renderScale = Math.min(this.MAX, +(S.renderScale + 0.1).toFixed(2));
          this.goodWindows = 0;
        }
      }
      return S.renderScale !== before;
    },
  };

  /* ------------------------------------------------------------------ Unit */

  class Unit {
    constructor(video) {
      this.v = video;
      this.mode = null;          // 'gpu' | 'filter'
      this.overlay = null;
      this.canvas = null;
      this.engine = null;
      this.rvfc = 0;
      this.frames = 0;
      this.fps = 0;
      this.lastFpsAt = performance.now();
      this.sig = '';
      this.blackStrikes = 0;
      this.nextProbe = 0;
      this.grid = null;        // last measureGrid() result; null until first measured
      this.nextGrid = 0;
      this.parentPatched = null;
      this.dead = false;
      this.reason = '';
      this.lastPresented = 0;
      this.primary = false;
    }

    /* ---- lifecycle ---- */

    start() {
      const want = this.decideMode();
      if (want === 'gpu' && this.startGpu()) return;
      this.startFilter();
    }

    decideMode() {
      if (S.mode === 'filter') return 'filter';
      if (!window.VUCore) { this.reason = 'core not loaded'; return 'filter'; }
      if (this.v.mediaKeys) { this.reason = 'DRM (EME) stream'; return 'filter'; }
      if (!contentBox(this.v).ok) { this.reason = 'video not ready'; return 'filter'; }
      return 'gpu';
    }

    onDiscontinuity = () => { this.engine && this.engine.resetTemporal(); };

    startGpu() {
      try {
        const parent = this.v.parentElement;
        if (!parent) { this.reason = 'video has no parent'; return false; }

        const cs = getComputedStyle(parent);
        if (cs.position === 'static') {
          parent.style.setProperty('position', 'relative');
          this.parentPatched = parent;
        }

        const ov = document.createElement('div');
        ov.setAttribute('data-vu-overlay', '1');
        ov.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;' +
                           'contain:strict;background:transparent;margin:0;padding:0;border:0';

        const cv = document.createElement('canvas');
        cv.style.cssText = 'display:block;width:100%;height:100%;margin:0;padding:0;border:0';
        ov.appendChild(cv);
        parent.appendChild(ov);

        const eng = window.VUCore.createEngine(cv);
        if (!eng) { ov.remove(); this.reason = 'WebGL2 unavailable'; return false; }

        this.overlay = ov;
        this.canvas = cv;
        this.engine = eng;
        this.mode = 'gpu';

        // First upload decides whether frames are readable at all.
        try {
          eng.upload(this.v);
        } catch (err) {
          this.reason = /cross-origin|tainted/i.test(String(err && err.message))
            ? 'cross-origin video (no CORS header)'
            : 'protected frames (DRM)';
          this.teardownGpu();
          return false;
        }

        for (const ev of ['seeking', 'loadedmetadata', 'ratechange']) {
          this.v.addEventListener(ev, this.onDiscontinuity);
        }
        this.syncGeometry(true);
        this.scheduleFrame();
        this.nextProbe = performance.now() + 1200;
        return true;
      } catch (err) {
        this.reason = String((err && err.message) || err);
        this.teardownGpu();
        return false;
      }
    }

    startFilter() {
      this.mode = 'filter';
      updateSvgKernel();
      this.applyFilter();
    }

    applyFilter() {
      const chain = filterChain();
      if (chain) this.v.style.setProperty('filter', chain, 'important');
      else this.v.style.removeProperty('filter');
    }

    teardownGpu() {
      for (const ev of ['seeking', 'loadedmetadata', 'ratechange']) {
        this.v.removeEventListener(ev, this.onDiscontinuity);
      }
      if (this.rvfc && this.v.cancelVideoFrameCallback) {
        try { this.v.cancelVideoFrameCallback(this.rvfc); } catch (_) {}
      }
      this.rvfc = 0;
      if (this.engine) { this.engine.dispose(); this.engine = null; }
      if (this.overlay) { this.overlay.remove(); this.overlay = null; }
      this.canvas = null;
      if (this.parentPatched) {
        this.parentPatched.style.removeProperty('position');
        this.parentPatched = null;
      }
    }

    stop() {
      this.dead = true;
      this.teardownGpu();
      this.v.style.removeProperty('filter');
      this.mode = null;
    }

    /** Drop out of GPU mode at runtime (black frames, context loss, …). */
    demote(reason) {
      if (this.mode !== 'gpu') return;
      this.reason = reason;
      this.teardownGpu();
      this.startFilter();
      panel && panel.toast(`GPU mode unavailable here — ${reason}. Using filter mode.`);
      panel && panel.refresh();
    }

    /* ---- geometry ---- */

    syncGeometry(force) {
      if (this.mode !== 'gpu' || !this.overlay) return;

      // Players (YouTube especially) rebuild their DOM on quality/size changes
      // and can orphan the overlay. Detect it and re-attach rather than drawing
      // into a detached canvas forever.
      if (!this.overlay.isConnected || this.overlay.parentElement !== this.v.parentElement) {
        if (!this.v.isConnected) return;
        this.teardownGpu();
        this.sig = '';
        if (!this.startGpu()) this.startFilter();
        return;
      }

      const parent = this.overlay.parentElement;
      if (!parent) return;

      const box = contentBox(this.v);
      if (!box.ok) return;   // metadata not in yet; try again next tick

      const vr = this.v.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      const pcs = getComputedStyle(parent);
      const bl = parseFloat(pcs.borderLeftWidth) || 0;
      const bt = parseFloat(pcs.borderTopWidth) || 0;

      const left = vr.left - pr.left - bl + parent.scrollLeft + box.x;
      const top  = vr.top  - pr.top  - bt + parent.scrollTop  + box.y;

      const dpr = window.devicePixelRatio || 1;
      let bw = Math.round(box.w * dpr * S.renderScale);
      let bh = Math.round(box.h * dpr * S.renderScale);
      if (bw > S.maxWidth) { const f = S.maxWidth / bw; bw = S.maxWidth; bh = Math.round(bh * f); }
      bw = Math.max(2, bw); bh = Math.max(2, bh);

      const sig = `${left.toFixed(1)}|${top.toFixed(1)}|${box.w.toFixed(1)}|${box.h.toFixed(1)}|${bw}|${bh}`;
      if (!force && sig === this.sig) return;
      this.sig = sig;

      this.overlay.style.left = left + 'px';
      this.overlay.style.top = top + 'px';
      this.overlay.style.width = box.w + 'px';
      this.overlay.style.height = box.h + 'px';
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
        this.engine && this.engine.resetTemporal();
      }
      this.draw();
    }

    /* ---- rendering ---- */

    scheduleFrame() {
      if (this.dead || this.mode !== 'gpu') return;
      const v = this.v;
      if (v.requestVideoFrameCallback) {
        this.rvfc = v.requestVideoFrameCallback((_t, meta) => { this.onFrame(meta); });
      } else {
        this.rvfc = requestAnimationFrame(() => { this.onFrame(); });
      }
    }

    onFrame(meta) {
      if (this.dead || this.mode !== 'gpu' || !this.engine) return;
      if (this.engine.lost) { this.demote('WebGL context lost'); return; }
      this.draw();
      this.frames++;
      const now = performance.now();

      // Feed the governor from the browser's own presented-frame counter, and
      // only from the primary video — a second one would double-count.
      if (S.adaptive && this.primary && meta && meta.presentedFrames) {
        const d = this.lastPresented ? meta.presentedFrames - this.lastPresented : 1;
        this.lastPresented = meta.presentedFrames;
        if (d > 0 && d < 20) quality.sample(d);
        if (quality.tick(now)) { this.syncGeometry(true); panel && panel.refresh(); }
      }
      if (now - this.lastFpsAt >= 1000) {
        this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsAt));
        this.frames = 0;
        this.lastFpsAt = now;
      }
      if (this.nextProbe && now > this.nextProbe) this.probeBlack(now);
      this.scheduleFrame();
    }

    draw() {
      if (this.mode !== 'gpu' || !this.engine || !this.canvas) return;
      const v = this.v;
      if (v.readyState < 2 || !v.videoWidth) return;
      try {
        this.engine.upload(v);
      } catch (err) {
        this.demote('frames became unreadable (DRM or CORS)');
        return;
      }
      // Re-measure the source's transform grid every couple of seconds. It has
      // to be after upload() (it reads the frame just uploaded) and it does a
      // readPixels, which stalls the pipeline — hence the interval, not
      // per-frame. Content changes: an ad, a scene cut, a different stream.
      if (S.autoRestore) {
        const t = performance.now();
        if (t >= (this.nextGrid || 0)) {
          this.nextGrid = t + GRID_INTERVAL;
          try { this.grid = this.engine.measureGrid() || this.grid; } catch (_) { /* keep the last */ }
        }
      }

      // Under Max, scale the effort to how hard the source is being stretched:
      // a 480p film blown up to 4K needs materially more help than a 1080p one.
      let sharpen = S.sharpen, deband = S.deband;
      let deblock = S.deblock, dering = S.dering;
      if (S.adaptive) {
        const mag = this.canvas.width / Math.max(1, v.videoWidth);
        const boost = Math.max(0, Math.min(1, (mag - 1) / 3));
        sharpen = Math.min(0.85, sharpen + 0.18 * boost);
        deband = Math.min(0.85, deband + 0.15 * boost);
      }

      // Restore strength comes from MEASURING the source, not from guessing at
      // it. The optimum genuinely moves — 0 on a clean plate, ~0.6 on a crf45
      // rip, 0.85 on a badly blocked one — so no fixed number serves all three.
      //
      // Magnification was the old proxy and it pointed the wrong way: measured
      // on the same rip, the best strength at 2x was LOWER (0.5) than at 1:1
      // (0.7), because the grid is filtered at source resolution either way.
      // The proxy is gone; the measurement replaces it.
      let backproject = S.backproject;
      let denoise = S.denoise;
      if (S.autoRestore && this.grid) {
        deblock = autoDeblock(this.grid.blockiness);
        dering = 0.75 * deblock;
        backproject = autoBackproject(this.grid.blockiness);
        denoise = autoDenoise(this.grid.blockiness);
      }

      const cb = contentBox(v);
      this.engine.render({
        srcRect: cb.ok ? cb.src : [0, 0, 1, 1],
        neural: bypassHeld ? 0 : S.neural,
        upscaler: S.upscaler,
        sharpen: bypassHeld ? 0 : sharpen,
        denoise: bypassHeld ? 0 : denoise,
        deband: bypassHeld ? 0 : deband,
        chroma: bypassHeld ? 0 : S.chroma,
        deblock: bypassHeld ? 0 : deblock,
        dering: bypassHeld ? 0 : dering,
        backproject: bypassHeld ? 0 : backproject,
        gridPhaseX: this.grid ? this.grid.phaseX : 0,
        gridPhaseY: this.grid ? this.grid.phaseY : 0,
        gridPeriod: this.grid ? this.grid.period : 8,
        detail: bypassHeld ? 0 : S.detail,
        vibrance: bypassHeld ? 0 : S.vibrance,
        shadow: bypassHeld ? 0 : S.shadow,
        temporal: bypassHeld ? 0 : S.temporal,
        antiring: S.antiring,
        saturation: bypassHeld ? 1 : S.saturation,
        contrast: bypassHeld ? 1 : S.contrast,
        gain: bypassHeld ? 1 : S.gain,
        split: S.split,
      });
    }

    /**
     * Some protected pipelines hand us a legal-but-black texture instead of
     * throwing. If the canvas is pure black while the video is genuinely
     * playing, three times in a row, assume we are being fed nothing.
     */
    probeBlack(now) {
      if (this.v.paused) { this.nextProbe = now + 2000; return; }
      let b = 0;
      try { b = this.engine.sampleBrightness(); } catch (_) { this.nextProbe = 0; return; }
      if (b < 0.75) {
        if (++this.blackStrikes >= 3) { this.nextProbe = 0; this.demote('frames read back black (protected output)'); return; }
        this.nextProbe = now + 2500;
      } else {
        this.nextProbe = 0;   // real pixels seen; stop probing
      }
    }

    applySettings() {
      if (this.mode === 'filter') { updateSvgKernel(); this.applyFilter(); }
      else { this.syncGeometry(true); }
    }

    status() {
      const src = this.engine ? this.engine.sourceSize() : { w: this.v.videoWidth, h: this.v.videoHeight };
      return {
        mode: this.mode,
        reason: this.reason,
        src: `${src.w}×${src.h}`,
        out: this.canvas ? `${this.canvas.width}×${this.canvas.height}` : '—',
        fps: this.fps,
        paused: !!this.v.paused,
        // What is actually running, not what was asked for: the CNN silently
        // skips if its weights failed to load, and a readout that claims it is
        // active anyway is worse than no readout at all.
        neural: !!(S.neural && this.engine && this.engine.neuralAvailable),
      };
    }
  }

  /* ----------------------------------------------------------------- panel */

  const PANEL_CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 268px; font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", Segoe UI, sans-serif;
  color: #e9edf2; background: rgba(17,20,26,.94); border: 1px solid rgba(255,255,255,.13);
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.55); backdrop-filter: blur(14px);
  overflow: hidden; user-select: none;
}
.wrap.collapsed { width: auto; }
.hd { display:flex; align-items:center; gap:8px; padding:9px 10px; cursor:grab; background:rgba(255,255,255,.04); }
.hd:active { cursor:grabbing; }
.dot { width:8px; height:8px; border-radius:50%; background:#3ddc97; box-shadow:0 0 8px #3ddc97; flex:none; }
.dot.off { background:#6b7280; box-shadow:none; }
.dot.filter { background:#f5b642; box-shadow:0 0 8px #f5b642; }
.ttl { font-weight:600; letter-spacing:.2px; flex:1; white-space:nowrap; }
.ico { width:22px; height:22px; border:0; border-radius:6px; background:rgba(255,255,255,.07); color:#e9edf2;
       cursor:pointer; font-size:13px; line-height:22px; text-align:center; padding:0; flex:none; }
.ico:hover { background:rgba(255,255,255,.16); }
.body { padding:10px; display:grid; gap:9px; }
.collapsed .body { display:none; }
.row { display:grid; grid-template-columns:74px 1fr 38px; align-items:center; gap:8px;
  border-top:1px solid rgba(255,255,255,.08); padding-top:9px; }
.row label { color:#9aa4b2; font-size:11px; }
.row .val { text-align:right; color:#c8d0da; font-variant-numeric:tabular-nums; font-size:11px; }
input[type=range] { -webkit-appearance:none; width:100%; height:3px; border-radius:2px;
  background:linear-gradient(90deg,#5b8cff,#8f6bff); outline:none; margin:0; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:13px; height:13px; border-radius:50%;
  background:#fff; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.5); }
.stat { font-size:10.5px; color:#8b95a3; line-height:1.5; }
.stat b { color:#c8d0da; font-weight:600; font-variant-numeric:tabular-nums; }
.warn { color:#f5b642; }
.up { color:#7fd08a; }
button.mini { font:inherit; font-size:11px; padding:1px 7px; margin-left:2px; cursor:pointer;
  color:#e9edf2; background:rgba(127,208,138,.18); border:1px solid rgba(127,208,138,.45);
  border-radius:5px; }
button.mini:disabled { opacity:.55; cursor:default; }
.toast { margin-top:6px; padding:6px 8px; background:rgba(245,182,66,.14); border:1px solid rgba(245,182,66,.35);
  border-radius:7px; color:#f2d29a; font-size:10.5px; }
.hint { font-size:10px; color:#727d8c; }
`;

  class Panel {
    constructor(startCollapsed) {
      this.collapsed = startCollapsed;
      this.host = document.createElement('div');
      this.host.setAttribute('data-vu-panel', '1');
      this.host.style.cssText = 'all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483647';
      this.root = this.host.attachShadow({ mode: 'open' });
      const st = document.createElement('style');
      st.textContent = PANEL_CSS;
      this.root.appendChild(st);

      this.wrap = document.createElement('div');
      this.wrap.className = 'wrap' + (this.collapsed ? ' collapsed' : '');
      this.root.appendChild(this.wrap);
      this.build();
      this.reparent();
      this.dragify();
      this.toastEl = null;
      this.statTimer = setInterval(() => this.refreshStats(), 700);
    }

    reparent() {
      const target = document.fullscreenElement || document.body || document.documentElement;
      if (this.host.parentElement !== target) target.appendChild(this.host);
    }

    build() {
      const slider = (key, label, min, max, step, fmt) =>
        `<div class="row"><label>${label}</label>
           <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}">
           <span class="val" data-v="${key}"></span></div>`;

      this.wrap.innerHTML = `
        <div class="hd">
          <span class="dot"></span>
          <span class="ttl">Video Upscaler</span>
          <button class="ico" data-a="collapse" title="Collapse">${this.collapsed ? '+' : '–'}</button>
          <button class="ico" data-a="close" title="Turn off (Cmd+Shift+U)">✕</button>
        </div>
        <div class="body">
          <div class="stat" data-stat></div>
          ${slider('split', 'A/B split', 0, 1, 0.01)}
          <div class="hint">Configures itself from the source — nothing to set.
            Drag <b>A/B split</b>, or hold <b>\`</b> (backtick), to see the
            untouched picture.</div>
        </div>`;

      this.wrap.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.a === 'close') return window.__VU__.toggle();
        if (b.dataset.a === 'collapse') {
          this.collapsed = !this.collapsed;
          this.wrap.classList.toggle('collapsed', this.collapsed);
          b.textContent = this.collapsed ? '+' : '–';
          S.collapsed = this.collapsed;   // remembered for the next manual invoke
          saveSettings();
          return;
        }
        if (b.dataset.a === 'getbest') {
          b.disabled = true;
          b.textContent = 'asking…';
          // Ask, then RE-PROBE a moment later and report what the player
          // actually settled on. The request is not a guarantee — the player can
          // refuse, or step back down on its own — and saying "done" when we
          // only said "please" is how a readout starts lying.
          source.probe(true, () => {
            setTimeout(() => source.probe(false, () => this.refresh()), 1500);
          });
          return;
        }
      });

      /* A/B split is the only input left, and it is deliberately not a setting:
       * it is how you SEE that the thing is working. Everything that used to be
       * adjustable here is now driven by measurement — mode from whether frames
       * can be read, deblock/dering from the source's blockiness, back-projection
       * from the same measurement, render scale from the frame budget.
       *
       * The three "touching this by hand takes control back from the governor"
       * escape hatches that used to live here are gone with the sliders that
       * needed them. Nothing rewrites split, so nothing has to yield to it. */
      this.wrap.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (k !== 'split') return;
        S.split = parseFloat(e.target.value);
        this.syncValues();
        pushSettings();
        saveSettings();
      });

      this.refresh();
    }

    dragify() {
      const hd = this.wrap.querySelector('.hd');
      let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
      hd.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        on = true; sx = e.clientX; sy = e.clientY;
        const r = this.wrap.getBoundingClientRect();
        ox = r.left; oy = r.top;
        this.wrap.style.right = 'auto'; this.wrap.style.bottom = 'auto';
        this.wrap.style.left = ox + 'px'; this.wrap.style.top = oy + 'px';
        hd.setPointerCapture(e.pointerId);
      });
      hd.addEventListener('pointermove', (e) => {
        if (!on) return;
        this.wrap.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        this.wrap.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      hd.addEventListener('pointerup', () => { on = false; });
    }

    syncValues() {
      for (const inp of this.wrap.querySelectorAll('input[data-k]')) {
        const k = inp.dataset.k;
        inp.value = S[k];
        const out = this.wrap.querySelector(`[data-v="${k}"]`);
        if (out) out.textContent = Number(S[k]).toFixed(2);
      }
    }

    refresh() { this.syncValues(); this.refreshStats(); }

    refreshStats() {
      const el = this.wrap.querySelector('[data-stat]');
      if (!el) return;
      const list = [...units.values()].filter(u => !u.dead);
      const dot = this.wrap.querySelector('.dot');
      if (!list.length) {
        dot.className = 'dot off';
        el.innerHTML = '<span class="warn">No eligible video found on this page.</span>';
        return;
      }
      const u = list.reduce((a, b) => {
        const ra = a.v.getBoundingClientRect(), rb = b.v.getBoundingClientRect();
        return (rb.width * rb.height > ra.width * ra.height) ? b : a;
      });
      const s = u.status();
      // s.reason can originate from a page-thrown exception, so it is escaped.
      const esc = (t) => String(t).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      dot.className = 'dot' + (s.mode === 'filter' ? ' filter' : '');
      el.innerHTML =
        `<b>${esc(s.src)}</b> → <b>${esc(s.out)}</b>` +
        (s.mode === 'gpu' ? (s.paused ? ' &nbsp;·&nbsp; <b>paused</b>' : ` &nbsp;·&nbsp; <b>${s.fps | 0}</b> fps`) : '') +
        `<br>mode: <b>${s.mode === 'gpu' ? ((s.neural ? 'neural + ' : '') + (S.upscaler === 'fsr' ? 'EASU + RCAS' : 'Lanczos-3 + RCAS')) : 'CSS filter'}</b>` +
        (s.mode === 'gpu' && S.adaptive ? `<br>render ×<b>${S.renderScale.toFixed(2)}</b>` : '') +
        (s.mode === 'gpu' && S.autoRestore && u.grid
          ? `<br>source: <b>${u.grid.blockiness < 1.3 ? 'clean' : u.grid.blockiness < 2 ? 'compressed' : 'heavily compressed'}</b>` +
            `<br>deblock <b>${autoDeblock(u.grid.blockiness).toFixed(2)}</b>` +
            ` &nbsp;·&nbsp; denoise <b>${autoDenoise(u.grid.blockiness).toFixed(2)}</b>` +
            (autoBackproject(u.grid.blockiness) > 0.05
              ? `<br><span class="up">reconstructing from ${S.temporal > 0 ? 'multiple frames' : 'the observed pixels'}</span>`
              : '') : '') +
        this.sourceLineFor(esc) +
        (s.mode === 'filter' && s.reason ? `<br><span class="warn">${esc(s.reason)}</span>` : '') +
        (list.length > 1 ? `<br>${list.length} videos active` : '');
    }

    /**
     * The source line. Two different honest messages:
     *  - somewhere we can act (YouTube): name the better tier and offer it
     *  - everywhere else: say how far the source is being stretched, because
     *    that is the number that decides how good this can possibly look
     */
    sourceLineFor(esc) {
      const q = source.summary();
      if (!q) return '';
      if (q.youtube && q.better) {
        return `<br><span class="up">serving <b>${esc(q.cur || '?')}</b> · ` +
               `<b>${esc(q.best)}</b> available</span> ` +
               `<button class="mini" data-a="getbest">use it</button>`;
      }
      if (q.youtube && q.cur) {
        return `<br>serving <b>${esc(q.cur)}</b>` +
               (q.requested ? ` <span class="up">(asked for its best)</span>` : '');
      }
      if (q.stretch >= 1.6) {
        return `<br>source is being stretched <b>${q.stretch.toFixed(1)}×</b>` +
               ` — a better source beats any setting here`;
      }
      return '';
    }

    toast(msg) {
      const body = this.wrap.querySelector('.body');
      if (!body) return;
      this.toastEl && this.toastEl.remove();
      const d = document.createElement('div');
      d.className = 'toast';
      d.textContent = msg;
      body.appendChild(d);
      this.toastEl = d;
      setTimeout(() => { d.remove(); if (this.toastEl === d) this.toastEl = null; }, 6000);
    }

    destroy() { clearInterval(this.statTimer); this.host.remove(); }
  }

  /* ------------------------------------------------------------ orchestration */

  /**
   * Picking a preset and reloading into one must mean the SAME thing.
   *
   * This used to carry its own copy of the adaptive/maxWidth/renderScale rules,
   * so adding `rescue` silently taught only `reconcilePreset` about it: choosing
   * Rescue in the panel left adaptation and auto-restore off, while quitting and
   * coming back with Rescue saved turned both on. Same preset, two behaviours,
   * depending on a piece of history the user cannot see. There is now one
   * definition and this defers to it.
   */
  function applyPreset(name) {
    if (!PRESETS[name]) return;
    S.preset = name;
    reconcilePreset();
    if (S.adaptive) {
      S.upscaler = 'fsr';        // the better upscaler, measurably
      quality.reset();
    }
    pushSettings();
    saveSettings();
  }

  function setMode(m) {
    S.mode = m;
    saveSettings();
    for (const u of units.values()) { u.stop(); }
    units.clear();
    scan();
  }

  function pushSettings() {
    for (const u of units.values()) u.applySettings();
  }

  function scan() {
    if (!S.enabled) return;
    for (const v of collectVideos()) {
      if (units.has(v)) continue;
      if (!eligible(v)) continue;
      const u = new Unit(v);
      units.set(v, u);
      u.start();
    }
    for (const [v, u] of units) {
      if (!v.isConnected) { u.stop(); units.delete(v); }
    }
    // Exactly one unit drives the governor, otherwise a page with several
    // videos would count each one's frames and over-report the load.
    let biggest = null, bestArea = 0;
    for (const u of units.values()) {
      if (u.dead) continue;
      const r = u.v.getBoundingClientRect();
      if (r.width * r.height > bestArea) { bestArea = r.width * r.height; biggest = u; }
    }
    for (const u of units.values()) u.primary = (u === biggest);

    // An auto-run start stays silent on pages with no video (a site's home page,
    // a search results page) and only surfaces the panel once one turns up.
    if (!panel && (units.size || !autoStarted)) panel = new Panel(autoStarted || S.collapsed);
    // Look at what the page is being served, without changing it. Re-probed
    // occasionally because a navigation inside a single-page app swaps the video
    // underneath us and the previous answer becomes a lie.
    if (units.size && Date.now() - source.at > 5000) {
      source.probe(false, () => panel && panel.refresh());
    }
    panel && panel.refresh();
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    for (const u of units.values()) u.syncGeometry(false);
  }

  function onKeyDown(e) {
    if (e.code !== 'Backquote' || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    bypassHeld = true;
    e.preventDefault();
    for (const u of units.values()) u.draw();
  }
  function onKeyUp(e) {
    if (e.code !== 'Backquote') return;
    bypassHeld = false;
    for (const u of units.values()) u.draw();
  }

  function onFullscreen() {
    panel && panel.reparent();
    for (const u of units.values()) u.syncGeometry(true);
  }

  function setBadge(on) {
    try { chrome?.runtime?.sendMessage?.({ type: 'vu-state', on }); } catch (_) {}
  }

  function enable(manual) {
    S.enabled = true;
    autoStarted = !manual;
    scan();   // creates the panel itself, unless we auto-started with no video
    setBadge(true);
    if (!mo) {
      mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(scan, 800); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (!rafId) rafId = requestAnimationFrame(tick);
    // A video that has no metadata yet is not eligible, and a page that never
    // mutates would never trigger a re-scan. Catch both.
    if (!scanTimer) scanTimer = setInterval(scan, 2000);
    document.addEventListener('loadedmetadata', scan, true);
    document.addEventListener('play', scan, true);
    addEventListener('keydown', onKeyDown, true);
    addEventListener('keyup', onKeyUp, true);
    document.addEventListener('fullscreenchange', onFullscreen, true);
    document.addEventListener('webkitfullscreenchange', onFullscreen, true);
  }

  function disable() {
    S.enabled = false;
    autoStarted = false;
    setBadge(false);
    for (const u of units.values()) u.stop();
    units.clear();
    if (mo) { mo.disconnect(); mo = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (scanTimer) { clearInterval(scanTimer); scanTimer = 0; }
    document.removeEventListener('loadedmetadata', scan, true);
    document.removeEventListener('play', scan, true);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('fullscreenchange', onFullscreen, true);
    document.removeEventListener('webkitfullscreenchange', onFullscreen, true);
    if (panel) { panel.destroy(); panel = null; }
    if (svgHost) { svgHost.remove(); svgHost = null; }
  }

  window.__VU__ = {
    toggle() { S.enabled ? disable() : enable(true); },
    get on() { return S.enabled; },
    settings: S,
    /* Synchronous redraw of every active unit. The WebGL drawing buffer is not
     * preserved across compositing, so anything reading the canvas from outside
     * the frame callback must force a draw first or it races the compositor. */
    redraw() { for (const u of units.values()) u.draw(); return units.size; },
    preset(name) { applyPreset(name); panel && panel.refresh(); return S.preset; },
    presets: PRESETS,
    persistedKeys: PERSIST,
    /* The shipped baseline, so a test can assert what a fresh install gets.
     * Distinct from `settings`, which is the live mutated state. */
    persistedDefaults: DEFAULTS,
    reconcile: reconcilePreset,
    governor: quality,
    autoDeblock,
    autoBackproject,
    autoDenoise,
  };

  // Set by the service worker immediately before a deliberate invocation, in the
  // same isolated world. Absent => a per-site grant started us automatically.
  const manual = !!window.__VU_MANUAL__;
  try { delete window.__VU_MANUAL__; } catch (_) { window.__VU_MANUAL__ = false; }

  loadSettings().then(() => {
    // A frame with no eligible video stays completely inert — this matters for
    // allFrames injection, where most frames are ads/trackers.
    const has = collectVideos(true).some(v => {
      const r = v.getBoundingClientRect();
      return r.width * r.height >= MIN_AREA;
    });
    if (!has && window.top !== window) { window.__VU__.inert = true; return; }
    enable(manual);
  });
})();
