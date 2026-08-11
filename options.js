/* Video Upscaler — options page.
 * Its whole job is holding the user gesture that chrome.permissions.request
 * needs; the service worker cannot show that dialog itself. */
'use strict';

const $ = (id) => document.getElementById(id);
const BROAD = '*://*/*';
const SUGGESTED = [
  'https://www.youtube.com', 'https://www.twitch.tv', 'https://vimeo.com',
  'https://www.netflix.com', 'https://www.max.com', 'https://tv.apple.com',
];

function say(text, cls) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = cls || '';
}

/** "https://www.youtube.com/watch?v=x" -> "https://www.youtube.com/*" */
function toPattern(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.protocol}//${u.hostname}/*`;
}

const pretty = (pattern) => pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '');

const hasApi = typeof chrome !== 'undefined' && !!(chrome.permissions && chrome.permissions.getAll);

async function granted() {
  if (!hasApi) return [];
  const p = await chrome.permissions.getAll();
  return (p.origins || []).filter((o) => o !== BROAD);
}

async function render() {
  const list = await granted();
  const ul = $('list');
  ul.innerHTML = '';

  if (!list.length) {
    const li = document.createElement('li');
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No sites yet — it only runs when you invoke it.';
    li.appendChild(d);
    ul.appendChild(li);
  } else {
    for (const origin of list.sort()) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = pretty(origin);
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const ok = await chrome.permissions.remove({ origins: [origin] });
        say(ok ? `Removed ${pretty(origin)}.` : 'Could not remove that permission.', ok ? '' : 'warn');
        render();
      });
      li.append(code, btn);
      ul.appendChild(li);
    }
  }

  // suggestions, minus anything already allowed
  const q = $('quick');
  q.innerHTML = '';
  for (const s of SUGGESTED) {
    const pat = toPattern(s);
    if (list.includes(pat)) continue;
    const b = document.createElement('button');
    b.textContent = '+ ' + pretty(pat);
    b.addEventListener('click', () => request(pat));
    q.appendChild(b);
  }
}

async function request(pattern) {
  if (!pattern) return say('That does not look like a site address.', 'warn');
  if (!hasApi) return say('Open this page from the extension (chrome://extensions → Details → Extension options).', 'warn');
  try {
    const ok = await chrome.permissions.request({ origins: [pattern] });
    if (ok) {
      say(`${pretty(pattern)} will now upscale automatically, including tabs you already have open.`, 'ok');
      $('site').value = '';
    } else {
      say('Permission declined — that site was not added.', 'warn');
    }
  } catch (e) {
    say('Chrome refused the request: ' + e.message, 'warn');
  }
  render();
}

$('addBtn').addEventListener('click', () => request(toPattern($('site').value)));
$('site').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') request(toPattern($('site').value));
});

// chrome:// links cannot be opened with a normal anchor
$('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Arriving from the "Always upscale on this site…" context-menu item.
const add = new URLSearchParams(location.search).get('add');
if (add) {
  const pat = toPattern(add);
  if (pat) {
    $('site').value = pretty(pat);
    say(`Click “Allow site” to always upscale on ${pretty(pat)}.`);
  }
}

render();
