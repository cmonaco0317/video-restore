/* ------------------------------------------------------------------------
 * Video Upscaler — the better-source probe.
 *
 * Runs in the PAGE's world, not the extension's. The player's quality API is
 * added to the DOM element by the site's own JavaScript, and content scripts
 * live in an isolated world where those methods simply are not there — so this
 * is handed to chrome.scripting.executeScript with world:'MAIN', which
 * serialises it. That is why it takes no imports and closes over nothing.
 *
 * Why it exists at all: every pass in core.js redistributes information that
 * already arrived. This is the only part of the extension that can increase it.
 * A player sitting on 720p while 2160p is available is a bigger quality problem
 * than anything a shader can fix.
 *
 * Kept in its own file so the test suite can load it and drive it against a
 * mock player. Nothing here may touch chrome.* — it does not run in a context
 * that has it.
 * --------------------------------------------------------------------- */
function vuProbeSource(apply) {
  const out = { host: location.hostname, kind: 'generic' };

  const v = document.querySelector('video');
  if (v) {
    const r = v.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    out.srcW = v.videoWidth || 0;
    out.srcH = v.videoHeight || 0;
    out.boxW = Math.round(r.width * dpr);
    out.boxH = Math.round(r.height * dpr);
  }

  // YouTube's player object carries the quality API. Other sites keep quality
  // selection inside their own UI, which cannot be driven generically or
  // safely, so for those this only REPORTS what is being served.
  const p = document.getElementById('movie_player') ||
            document.querySelector('.html5-video-player');
  if (p && typeof p.getAvailableQualityLevels === 'function') {
    out.kind = 'youtube';
    try {
      const levels = (p.getAvailableQualityLevels() || []).filter((l) => l && l !== 'auto');
      out.levels = levels;
      out.best = levels[0] || null;            // YouTube lists best-first
      if (typeof p.getPlaybackQuality === 'function') out.reported = p.getPlaybackQuality();

      // DO NOT trust getPlaybackQuality() as the answer.
      //
      // Verified on a real video 2026-08-10: after requesting the best tier the
      // player had already selected the 3840x2160 stream — its own stats said
      // so — while getPlaybackQuality() went on returning "hd1080" for more than
      // forty seconds. A readout built on it reports failure while the thing is
      // working, which is the most expensive kind of wrong.
      //
      // The frame the decoder is actually producing cannot lag, because it IS
      // the output. Use it whenever there is one and keep the player's opinion
      // only as a fallback for before the first frame arrives.
      const H = [[2160, 'hd2160'], [1440, 'hd1440'], [1080, 'hd1080'], [720, 'hd720'],
                 [480, 'large'], [360, 'medium'], [240, 'small'], [0, 'tiny']];
      if (out.srcH) {
        out.current = (H.find(([h]) => out.srcH >= h - 8) || H[H.length - 1])[1];
        out.currentFrom = 'decoded';
      } else {
        out.current = out.reported || null;
        out.currentFrom = 'player';
      }
    } catch (e) { out.err = String((e && e.message) || e); }

    if (apply && out.best) {
      try {
        // Ask for MORE than is listed, on purpose. getAvailableQualityLevels()
        // under-reports: it omits the Premium enhanced-bitrate tiers, so a
        // player that can serve one still lists hd1080 as its best. Naming a
        // ceiling above anything real makes the player clamp to its true best
        // rather than to the best it admitted to.
        p.setPlaybackQualityRange(out.best, 'highres');
        if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality('highres');
        out.requested = true;
      } catch (e) { out.applyErr = String((e && e.message) || e); }
    }
  }
  return out;
}

// Available to the service worker via importScripts, and to the test page as a
// plain global. Guarded because neither context has the other's globals.
if (typeof window !== 'undefined') window.vuProbeSource = vuProbeSource;
