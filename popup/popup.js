'use strict';
/* ─── InstaScrap Launcher Popup ───────────────────────────────────────────────
   This popup is intentionally minimal. All download logic lives in the
   content script (content/panel.js) which runs inside the Instagram tab and
   survives popup open/close.
   ─────────────────────────────────────────────────────────────────────────── */

const dot     = document.getElementById('status-dot');
const txt     = document.getElementById('status-text');
const detail  = document.getElementById('status-detail');
const openBtn = document.getElementById('open-btn');

const IG_URL_RE = '*://*.instagram.com/*';

async function init() {
  const tabs = await chrome.tabs.query({ url: IG_URL_RE });

  if (!tabs.length) {
    dot.className      = 'dot dot-err';
    txt.textContent    = 'No Instagram tab';
    detail.textContent = 'Open instagram.com in any tab, then click the extension again.';
    openBtn.disabled   = false;
    openBtn.textContent = 'Open Instagram';
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.instagram.com/' });
      window.close();
    });
    return;
  }

  const igTab = tabs[0];

  // Ask the service worker whether Instagram auth has been captured for this
  // tab. This is the single most common reason Fetch does nothing: the profile
  // page has not been loaded since the extension was installed or reloaded.
  let auth = { ready: false };
  try {
    const res = await chrome.runtime.sendMessage({ action: 'igAuthStatus', tabId: igTab.id });
    if (res) auth = res;
  } catch (err) {
    auth = { ready: false, message: 'service worker unavailable — reload the extension' };
  }

  if (auth && auth.ready) {
    dot.className   = 'dot dot-ok';
    txt.textContent = 'Ready to scan';
    const age = auth.ageSeconds != null ? ` Captured ${formatAge(auth.ageSeconds)} ago.` : '';
    detail.textContent = `Instagram accepted this tab's session.${age}`;
  } else {
    dot.className   = 'dot dot-warn';
    txt.textContent = 'Session not ready';
    detail.textContent = (auth && auth.message) ||
      'Open a profile on instagram.com and scroll once, then reopen this popup.';
  }

  openBtn.disabled = false;
  openBtn.addEventListener('click', async () => {
    openBtn.disabled    = true;
    openBtn.textContent = 'Opening';

    // Try to message an already-running content script
    try {
      await chrome.tabs.sendMessage(igTab.id, { action: 'showPanel' });
    } catch {
      // Content script not injected (e.g. tab predates install) — inject, then show
      try {
        await chrome.scripting.executeScript({
          target: { tabId: igTab.id },
          files:  ['lib/jszip.min.js', 'content/panel.js'],
        });
        await delay(400);
        chrome.tabs.sendMessage(igTab.id, { action: 'showPanel' }).catch(() => {});
      } catch (err) {
        console.warn('[InstaScrap] Injection failed:', err);
        detail.textContent = 'Could not add the panel to that tab. Reload the Instagram tab and try again.';
        dot.className = 'dot dot-err';
        txt.textContent = 'Panel unavailable';
        openBtn.disabled = false;
        openBtn.textContent = 'Try again';
        return;
      }
    }

    await chrome.tabs.update(igTab.id, { active: true });
    chrome.windows.update(igTab.windowId, { focused: true });
    window.close();
  });
}

function formatAge(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

init().catch(err => {
  txt.textContent = 'Error: ' + err.message;
  dot.className   = 'dot dot-err';
});
