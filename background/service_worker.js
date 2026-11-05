'use strict';
/* ─── InstaScrap Service Worker ──────────────────────────────────────────────
   Responsibilities:
     1. Import the Instagram API layer (background/ig-api.js) — all IG traffic,
        auth capture and the profile-media query live there.
     2. Download file requests (chrome.downloads)
     3. Badge management
     4. Local bridge to bridge_server.py
   ─────────────────────────────────────────────────────────────────────────── */

/* The worker must NEVER die before a message listener exists: an unanswered
   port is exactly the instant SW_UNAVAILABLE the panel reports. So:
   1. a minimal ping listener goes first (answers even if everything below fails),
   2. importScripts is wrapped — a missing ig-api.js must degrade, not kill,
   3. setAccessLevel never chains .catch() on a possibly-undefined return. */
let IG_API_ERROR = null;
try {
  importScripts('ig-api.js');
} catch (err) {
  IG_API_ERROR = err && err.message ? err.message : String(err);
  console.error('[InstaScrap] ig-api.js failed to load:', err);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'ping') {
    sendResponse({ ok: !IG_API_ERROR, version: '2.4.0', apiError: IG_API_ERROR });
    return true;
  }
  return false;
});

/* ─── Foldered downloads ────────────────────────────────────────────────────
   <a download> can only save to the Downloads root, so every file that must
   land in InstaScrap/<user>/ goes through chrome.downloads here.
   startDownload waits for the terminal state so the panel can fall back to a
   flat save when the CDN refuses the headerless fetch. */
const pendingDataUploads = new Map();

function startDownload({ url, filename }) {
  return new Promise((resolve, reject) => {
    let dlId = null;
    const timer = setTimeout(() => { cleanup(); reject(new Error('download timed out after 15 minutes')); }, 15 * 60 * 1000);
    const onChanged = delta => {
      if (delta == null || delta.id !== dlId) return;
      const state = delta.state && delta.state.current;
      if (state === 'complete') { cleanup(); resolve(dlId); }
      else if (state === 'interrupted' || (delta.error && delta.error.current)) {
        cleanup();
        reject(new Error(`download failed${delta.error && delta.error.current ? `: ${delta.error.current}` : ''}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch {}
    };
    try {
      chrome.downloads.onChanged.addListener(onChanged);
    } catch (err) { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); return; }
    try {
      chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }, newId => {
        if (chrome.runtime.lastError) { cleanup(); reject(new Error(chrome.runtime.lastError.message)); return; }
        dlId = newId;
      });
    } catch (err) { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); }
  });
}

// Content scripts write panel state (posts, followings, active tab) to
// chrome.storage.session. MV3 defaults that store to TRUSTED_CONTEXTS only, so
// without this every write and the session-restore read silently fail.
try {
  const p = chrome.storage.session &&
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  if (p && typeof p.catch === 'function') p.catch(() => {});
} catch {}

try {
  chrome.runtime.onInstalled.addListener(() => {
    try {
      const p = chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  });
} catch {}

/* ─── Message router ────────────────────────────────────────────────────────── */
/* Registered BEFORE installCapture on purpose. If a webRequest subscription
   ever throws, messaging must keep working — the panel would otherwise get
   "The message port closed before a response" for every request. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ig-api.js failed to load: say so explicitly instead of falling through to
  // the "does not handle" branch, which would hide the real cause.
  if (IG_API_ERROR && msg && ['getProfileMediaPage', 'igRequest', 'igAuthStatus'].includes(msg.action)) {
    sendResponse({
      success: false,
      error: {
        code: 'SW_BROKEN',
        message: `InstaScrap's background worker started without its API layer (${IG_API_ERROR}). Reload the extension at chrome://extensions.`,
      },
    });
    return true;
  }
  // Instagram API + auth capture → ig-api.js
  try {
    if (typeof handleIgApiMessage === 'function' && handleIgApiMessage(msg, sender, sendResponse)) return true;
  } catch (err) {
    sendResponse({
      success: false,
      error: { code: 'SW_BROKEN', message: `InstaScrap's request handler crashed: ${err && err.message ? err.message : err}` },
    });
    return true;
  }

  switch (msg.action) {
    case 'downloadFile': {
      const { url, filename } = msg;
      if (!url || !filename) { sendResponse({ ok: false, error: 'missing params' }); return true; }
      startDownload({ url, filename }).then(
        dlId => sendResponse({ ok: true, dlId }),
        err => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
      );
      return true;
    }

    // Chunked base64 upload of an in-memory blob (ZIPs, link lists, exports).
    // Keeps any single message small; the worker reassembles and saves it.
    case 'downloadDataStart': {
      const { id, filename, mime, total } = msg;
      if (!id || !filename) { sendResponse({ ok: false, error: 'missing params' }); return true; }
      pendingDataUploads.set(id, {
        filename, mime: mime || 'application/octet-stream',
        total: total || 0, parts: [],
      });
      sendResponse({ ok: true });
      return true;
    }

    case 'downloadDataChunk': {
      const rec = pendingDataUploads.get(msg.id);
      if (!rec || typeof msg.index !== 'number' || typeof msg.chunk !== 'string') {
        sendResponse({ ok: false, error: 'unknown upload — start the transfer again' });
        return true;
      }
      rec.parts[msg.index] = msg.chunk;
      sendResponse({ ok: true });
      return true;
    }

    case 'downloadDataEnd': {
      const rec = pendingDataUploads.get(msg.id);
      pendingDataUploads.delete(msg.id);
      if (!rec) { sendResponse({ ok: false, error: 'unknown upload — start the transfer again' }); return true; }
      const dataUrl = `data:${rec.mime};base64,${rec.parts.join('')}`;
      startDownload({ url: dataUrl, filename: rec.filename }).then(
        dlId => sendResponse({ ok: true, dlId }),
        err => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
      );
      return true;
    }

    case 'setBadge': {
      try {
        const p = chrome.action.setBadgeText({ text: msg.text != null ? String(msg.text) : '' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
      sendResponse({ ok: true });
      return;
    }

    case 'pushToApp':
      fetch('http://localhost:7432', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg.payload)
      }).then(async res => {
        if (res.ok) sendResponse({ ok: true });
        else sendResponse({ ok: false, error: `Server returned ${res.status}` });
      }).catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'pollBridge':
      fetch('http://localhost:7432/command')
        .then(res => res.json())
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    default:
      // Always answer. Returning false here makes Chrome close the port, and the
      // caller sees a cryptic port error instead of a nameable one.
      sendResponse({
        ok: false,
        error: `InstaScrap does not handle the "${msg && msg.action}" message. Reload the extension.`,
      });
      return true;
  }
});

// Auth capture is best-effort: never let it stop the worker from starting.
try {
  if (typeof installCapture === 'function') installCapture();
  else if (!IG_API_ERROR) console.error('[InstaScrap] installCapture is missing.');
} catch (err) {
  console.error('[InstaScrap] Auth capture failed to install:', err);
}

try {
  chrome.downloads.onChanged.addListener(delta => {
    if (delta.error?.current) {
      console.warn('[InstaScrap] Download failed:', delta.error.current, delta.id);
    }
  });
} catch {}
