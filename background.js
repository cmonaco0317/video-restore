/* Video Upscaler — MV3 service worker.
 *
 * Three ways in:
 *   1. toolbar icon / Cmd+Shift+U   -> inject into the active tab
 *   2. right-click a video or page  -> same, but discoverable
 *   3. per-site auto-run            -> registered content script, no invoking
 *
 * Re-injecting toggles, because content.js guards on window.__VU__.
 */

// vuProbeSource lives in its own file so the test suite can load it and drive
// it against a mock player; the worker picks it up here.
importScripts('source-probe.js');

const FILES = ['cnn-weights.js', 'core.js', 'content.js'];
const AUTO_ID = 'vu-auto';

async function inject(tabId) {
  if (tabId == null) return;
  // Mark this as a deliberate invocation before the content script loads. It
  // runs in the same isolated world, so content.js can read the flag and know
  // to show its panel — an auto-run start stays quiet instead.
  const mark = { target: { tabId, allFrames: true }, func: () => { window.__VU_MANUAL__ = true; } };
  try {
    await chrome.scripting.executeScript(mark);
    // allFrames catches same-origin embedded players. Cross-origin iframes need
    // a host grant and will throw here.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: FILES });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: mark.func });
      await chrome.scripting.executeScript({ target: { tabId }, files: FILES });
    } catch (e2) {
      console.warn('[VideoUpscaler] cannot inject into this tab:', e2.message);
    }
  }
}

chrome.action.onClicked.addListener((tab) => inject(tab.id));

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  inject(tab && tab.id);
});

/* ----------------------------------------------------------- context menu */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'vu-toggle',
      title: 'Upscale video on this page',
      contexts: ['video', 'page', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'vu-always',
      title: 'Always upscale on this site…',
      contexts: ['video', 'page', 'frame'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => { buildMenus(); syncAutoRun(); });
chrome.runtime.onStartup.addListener(() => { buildMenus(); syncAutoRun(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vu-toggle') return inject(tab && tab.id);
  if (info.menuItemId === 'vu-always') {
    // permissions.request needs a real document to show its dialog, so the
    // options page does the asking rather than the worker.
    let origin = '';
    try { origin = new URL(info.pageUrl || (tab && tab.url) || '').origin; } catch (_) {}
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + (origin ? '?add=' + encodeURIComponent(origin) : '') });
  }
});

/* -------------------------------------------------------------- auto-run */

/** Register (or clear) a content script for every origin we hold permission for. */
async function syncAutoRun() {
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins || []).filter((o) => o !== '*://*/*');

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_ID] });
  } catch (_) { /* nothing registered yet */ }

  if (!origins.length) return;
  try {
    await chrome.scripting.registerContentScripts([{
      id: AUTO_ID,
      matches: origins,
      js: FILES,
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
  } catch (e) {
    console.warn('[VideoUpscaler] could not register auto-run scripts:', e.message);
  }
}

chrome.permissions.onRemoved.addListener(syncAutoRun);

/* Registering a content script only affects FUTURE navigations, so a tab that
 * is already open on a site you just allowed would sit there doing nothing
 * until you reloaded it. Catch those up by hand. */
chrome.permissions.onAdded.addListener(async (added) => {
  await syncAutoRun();
  const origins = (added.origins || []).filter((o) => o !== '*://*/*');
  if (!origins.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: origins }); } catch (_) { return; }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: FILES });
    } catch (_) { /* a tab we still cannot touch; it will work on next load */ }
  }
});

/* ------------------------------------------------------ the better source
 *
 * The largest quality lever this extension has is not a shader. If the player
 * settled on 720p while 2160p was sitting there, fetching the better stream is
 * REAL extra information — every pass in core.js only ever redistributes what
 * already arrived.
 *
 * The player's quality API belongs to the page's own JavaScript, and content
 * scripts live in an isolated world where those methods are invisible, so this
 * has to run in the MAIN world. executeScript hands the return value straight
 * back, so no postMessage channel is needed.
 */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== 'vu-source' || !sender.tab) return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
    world: 'MAIN',
    func: vuProbeSource,
    args: [!!msg.apply],
  }).then((res) => reply(res && res[0] ? res[0].result : null))
    .catch((e) => reply({ error: e.message }));
  return true;    // reply is async
});

/* ------------------------------------------------------- on/off feedback */

// content.js reports its state so the toolbar icon shows whether it is active.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'vu-state' || !sender.tab) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: msg.on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b62d9' });
});
