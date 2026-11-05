'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   InstaScrap Content Script — panel.js
   Runs inside instagram.com permanently. Survives popup open/close.
   Downloads go via chrome.runtime.sendMessage → service_worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Guard: re-show if already injected, else init ────────────────────────
if (window.__isLoaded) {
  window.__isShow?.();
} else {
  window.__isLoaded = true;
  _isInit();
}

// ─── Main setup (runs once per tab lifetime) ───────────────────────────────
function _isInit() {
  const ICON = chrome.runtime.getURL('icons/icon48.png');

  /* ── Shadow DOM host ────────────────────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'instascrap-host';
  host.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;' +
    'z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = IS_CSS();
  shadow.appendChild(styleEl);

  // NOTE: previously InstaScrap injected `* { animation: none }` into document.head
  // which broke Instagram's own lazy-load/IntersectionObserver and triggered layout thrash.
  // Now scoped — no global style injection. Panel animations live only in shadow DOM.

  document.addEventListener('keydown', (e) => {
    if (e.key === 'MediaTrackNext') {
      e.preventDefault();
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    } else if (e.key === 'MediaTrackPrevious') {
      e.preventDefault();
      window.scrollBy({ top: -window.innerHeight, behavior: 'smooth' });
    }
  });

  const wrap = document.createElement('div');
  wrap.innerHTML = isHTML(ICON);
  shadow.appendChild(wrap);

  /* ── Icon set ────────────────────────────────────────────────────────────
     One 24px stroke set, used everywhere state changes so the panel never
     mixes emoji with line art. Callers pass the icon name, not markup. */
  const ICONS = {
    search:   '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>',
    spinner:  '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
    users:    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    check:    '<path d="M20 6L9 17l-5-5"/>',
    done:     '<path d="M20 6L9 17l-5-5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    alert:    '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    pause:    '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    link:     '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    archive:  '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    skip:     '<path d="M5 4l10 8-10 8V4z"/><path d="M19 5v14"/>',
    bolt:     '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  };
  const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  function svgIcon(name, cls) {
    const body = ICONS[name] || ICONS.alert;
    return `<svg ${ICON_ATTRS}${cls ? ` class="${cls}"` : ''} aria-hidden="true">${body}</svg>`;
  }
  /** Swap an element's contents for an icon, keeping any classes it has. */
  function setIcon(el, name) {
    if (!el) return;
    const keep = el.getAttribute('class') || '';
    el.innerHTML = svgIcon(name);
    if (keep) el.setAttribute('class', keep);
  }

  /* ── State ──────────────────────────────────────────────────────────────── */
  let isFetching    = false;
  let stopFetch     = false;
  let isDownloading = false;
  let bulkRunning   = false;
  let bulkStop      = false;
  let currentUser   = null;
  let fetchedPosts  = [];
  let dlHistory     = new Set();
  let followings    = [];
  const cnt         = { reel: 0, photo: 0, album: 0, files: 0 };
  let abortCtl      = null;

  async function pMap(items, fn, { concurrency = 5 } = {}) {
    // Fix: concurrency:1 must be strictly sequential (old code launched all at once when concurrency===1)
    if (concurrency === 1) {
      const results = [];
      for (const item of items) {
        if (stopFetch || bulkStop) break;
        try { const v = await fn(item); results.push({ status: 'fulfilled', value: v }); }
        catch (e) { results.push({ status: 'rejected', reason: e }); }
      }
      return results;
    }
    const results = [];
    const pool = new Set();
    for (const item of items) {
      if (stopFetch || bulkStop) break;
      const p = fn(item);
      results.push(p);
      if (items.length > 1) {
        const e = Promise.resolve(p).finally(() => pool.delete(e));
        pool.add(e);
        if (pool.size >= concurrency) await Promise.race(pool);
      }
    }
    if (pool.size) await Promise.allSettled([...pool]);
    return Promise.allSettled(results);
  }

  /* ── Token Bucket Rate Limiter ──────────────────────────────────────────── */
  class TokenBucket {
    constructor(capacity, refillMs) {
      this.capacity = capacity;
      this.tokens = capacity;
      this.refillMs = refillMs;
      this.lastRefill = performance.now();
    }
    _refill() {
      const now = performance.now();
      const elapsed = now - this.lastRefill;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.refillMs);
      this.lastRefill = now;
    }
    async take() {
      this._refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const wait = (1 - this.tokens) * this.refillMs;
      this.tokens = 0;
      this.lastRefill += wait;
      await sleep(wait);
    }
  }
  const dlBucket = new TokenBucket(2, 500);

  /* ── Global API Gate — one in-flight IG request at a time ───────────────── */
  class ApiGate {
    constructor(spacing = 900) {
      this.spacing = spacing;
      this.nextAllowed = 0;
      this.penaltyUntil = 0;
    }
    async take() {
      const now = performance.now();
      const barrier = Math.max(this.nextAllowed, this.penaltyUntil);
      if (now < barrier) await sleep(barrier - now);
      this.nextAllowed = performance.now() + this.spacing * (0.7 + Math.random() * 0.6);
    }
    penalize(ms) {
      this.penaltyUntil = Math.max(this.penaltyUntil, Math.min(performance.now() + ms, performance.now() + 300000));
    }
    cooldownSecs() {
      return Math.max(0, Math.ceil((Math.max(this.nextAllowed, this.penaltyUntil) - performance.now()) / 1000));
    }
  }
  const igGate = new ApiGate(1100); // was 5200 — too slow, users thought it was frozen (2026-09: 900-1300ms is polite enough)
  let last429At = 0;
  let consec429 = 0;

  /* ── DOM helper ─────────────────────────────────────────────────────────── */
  const $  = id => shadow.getElementById(id);
  const panel = $('is-panel');
  const fab   = $('is-fab');

  /* ── Message listener (popup → content script) ──────────────────────────── */
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'showPanel') showPanel();
  });

  /* ── Show / Minimize / Close ────────────────────────────────────────────── */
  function showPanel() {
    panel.classList.remove('is-hidden');
    fab.classList.add('is-hidden');
  }
  window.__isShow = showPanel;

  $('is-minimize').addEventListener('click', () => {
    panel.classList.add('is-hidden');
    fab.classList.remove('is-hidden');
  });
  $('is-close').addEventListener('click', () => {
    host.remove();
    window.__isLoaded = false;
    delete window.__isShow;
  });
  fab.addEventListener('click', showPanel);

  /* ── Drag ───────────────────────────────────────────────────────────────── */
  {
    let dragging = false, ox = 0, oy = 0;
    $('is-drag').addEventListener('mousedown', e => {
      if (e.target.closest('.is-hbtn')) return;
      dragging = true;
      const r  = panel.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = r.left + 'px';
      panel.style.top    = r.top  + 'px';
      const onMove = me => {
        panel.style.left = Math.max(0, Math.min(me.clientX - ox, innerWidth  - panel.offsetWidth))  + 'px';
        panel.style.top  = Math.max(0, Math.min(me.clientY - oy, innerHeight - panel.offsetHeight)) + 'px';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
      }, { once: true });
      e.preventDefault();
    });
  }

  /* ── Tab switching ──────────────────────────────────────────────────────── */
  function switchTab(tab) {
    $('tab-single').classList.toggle('active', tab === 'single');
    $('tab-fol').classList.toggle('active',    tab === 'fol');
    $('tab-set').classList.toggle('active',    tab === 'set');
    
    $('sec-single').classList.toggle('hidden', tab !== 'single');
    $('sec-fol').classList.toggle('hidden',    tab !== 'fol');
    $('sec-set').classList.toggle('hidden',    tab !== 'set');
    
    chrome.storage.session.set({ is_tab: tab }).catch(() => {});
  }
  $('tab-single').addEventListener('click', () => switchTab('single'));
  $('tab-fol').addEventListener('click',    () => switchTab('fol'));
  $('tab-set').addEventListener('click',    () => switchTab('set'));

  /* ═══════════════════════════════════════════════════════════════════════════
     API TRANSPORT — every Instagram request is delegated to the service
     worker (background/ig-api.js), which owns auth capture and talks to
     i.instagram.com. The panel never builds Instagram headers itself.
     ═══════════════════════════════════════════════════════════════════════════ */

  function swCall(payload) {
    return new Promise((resolve, reject) => {
      let responded = false;
      const fail = message => {
        if (responded) return;
        responded = true;
        reject(new Error(message));
      };
      try {
        chrome.runtime.sendMessage(payload, resp => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            const detail = lastErr.message || 'unknown messaging error';
            // The classic post-reload trap: reloading the extension at
            // chrome://extensions orphans every panel already open in a tab.
            // That orphan can never reach the new worker — only a tab reload
            // fixes it, so say exactly that.
            if (/extension context invalidated/i.test(detail)) {
              return fail(
                `SW_UNAVAILABLE: this panel was orphaned by an extension reload ("${payload.action}"). ` +
                `Reload THIS Instagram tab to inject a fresh panel.`
              );
            }
            return fail(
              `SW_UNAVAILABLE: InstaScrap's background worker did not answer "${payload.action}" (${detail}). ` +
              `Reload the extension at chrome://extensions, then reload this Instagram tab.`
            );
          }
          if (!resp) {
            return fail(
              `SW_UNAVAILABLE: the background worker returned nothing for "${payload.action}". ` +
              `Reload the extension and this tab.`
            );
          }
          responded = true;
          resolve(resp);
        });
      } catch (err) {
        fail(
          `SW_UNAVAILABLE: could not even send "${payload.action}" (${err && err.message ? err.message : err}). ` +
          `Reload this Instagram tab.`
        );
      }
    });
  }

  /** Turn a service-worker error payload into a thrown Error carrying `.code`. */
  function igFail(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.code = e.code || 'IG_UNKNOWN';
    return e;
  }

  /**
   * Authenticated JSON request via the service worker.
   * kind 'api' targets i.instagram.com (mobile API); kind 'web' targets
   * www.instagram.com (web API such as web_profile_info).
   */
  async function igRequest({ path, method = 'GET', params = null, headers = {}, kind = 'api' }) {
    const body = params ? new URLSearchParams(params).toString() : null;
    const resp = await swCall({ action: 'igRequest', path, method, body, headers, kind });
    if (!resp.success) return igFail(resp.error);
    return resp.json;
  }

  /** One page of profile media, GraphQL-first with REST feed fallback. */
  async function profileMediaPage(username, next) {
    const resp = await swCall({ action: 'getProfileMediaPage', username, next: next || null });
    if (!resp.success) return igFail(resp.error);
    return resp;
  }

  /** Diagnostic snapshot of the captured auth for this tab. */
  async function igAuthStatus() {
    try { return (await swCall({ action: 'igAuthStatus' })) || { hasTab: false, ready: false, message: 'service worker returned nothing — reload the extension and this tab' }; }
    catch { return { hasTab: false, ready: false, message: 'service worker unavailable' }; }
  }

  function setPreferredResolutionCookies() {
    // From Instagram-Downloader-5.1.21/src/js/utils.js setPreferredMediaResolutionCookies
    // Forces Instagram CDN to return 4K variants
    try { document.cookie = `wd=${Math.floor(3840/2)}x${Math.floor(2160/2)-100}; path=/`; } catch {}
    try { document.cookie = `dpr=2; path=/`; } catch {}
  }
  /** Logged-in numeric user id from the (non-HttpOnly) ds_user_id cookie.
      Used only to address the followings endpoint. */
  function getMyId() {
    try {
      return document.cookie.split(';').map(c => c.trim())
        .find(c => c.startsWith('ds_user_id='))?.split('=')[1] ?? null;
    } catch { return null; }
  }
  // Try to scrape userId directly from profile HTML (2026 fallback — web_profile_info gated)
  function parseUserIdFromHtml(html) {
    // Multiple patterns Instagram uses in 2024-2026
    let m = html.match(/"profilePage_(\d+)"/);
    if (m) return m[1];
    m = html.match(/"user_id"\s*:\s*"(\d+)"/);
    if (m) return m[1];
    m = html.match(/"owner"\s*:\s*\{\s*"id"\s*:\s*"(\d+)"/);
    if (m) return m[1];
    m = html.match(/instagram:\/\/user\?id=(\d+)/);
    if (m) return m[1];
    m = html.match(/"id"\s*:\s*"(\d+)"[^}]*"username"\s*:\s*"/);
    if (m) return m[1];
    return null;
  }
  async function fetchProfileHtml(username) {
    const resp = await swCall({
      action: 'igRequest',
      kind: 'html',
      path: '/' + encodeURIComponent(username) + '/',
    });
    if (!resp.success) throw igFail(resp.error);
    return resp.text || '';
  }
  async function igUserIdViaHtml(username) {
    const html = await fetchProfileHtml(username);
    const id = parseUserIdFromHtml(html);
    if (!id) throw new Error('Could not extract userId from HTML — profile may be private or rate-limited');
    return id;
  }
  async function igUserInfo(username) {
    // web_profile_info is a www-origin endpoint (not i.instagram.com).
    // 2026: it also returns IG_SCHEMA_DELETED for ~50% of accounts due to removed fields.
    // Try API first, then fall back to HTML scrape for ID + og:description stats.
    try {
      const d = await apiGetRetry(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, null, 'web');
      const u = d?.data?.user;
      if (u) {
        return {
          id: u.id, username: u.username, fullName: u.full_name,
          isPrivate: u.is_private, isVerified: u.is_verified,
          mediaCount: u.edge_owner_to_timeline_media?.count ?? 0,
          followCount: u.edge_followed_by?.count ?? 0,
          profilePic: u.profile_pic_url_hd || u.profile_pic_url || '',
        };
      }
      console.warn('[InstaScrap] web_profile_info returned no user for @' + username,
        'top-level keys:', d && typeof d === 'object' ? Object.keys(d).slice(0, 8).join(',') : typeof d);
    } catch (e) {
      // Re-throw gated errors so caller can do HTML fallback; but try HTML ID inline for 400-class
      if (/IG_SCHEMA_DELETED|IG_REQUIRE_LOGIN|IG_RATE_LIMITED|IG_HTML_WALL|HTTP 400/i.test(e.message||'')) {
        try {
          const htmlId = await igUserIdViaHtml(username);
          const meta = await fetchProfileMetaFallback(username);
          return {
            id: htmlId, username, fullName: meta?.title || username,
            isPrivate: false, isVerified: false,
            mediaCount: meta?.posts || 0, followCount: meta?.followers || 0,
            profilePic: meta?.ogImg || '',
          };
        } catch {}
      }
      throw e;
    }
    throw new Error('User not found.');
  }
  // Profile-media paging lives in the service worker (GraphQL + feed fallback).
  // These thin wrappers keep the existing call signatures so the pagination
  // orchestration below is unchanged.
  async function igFeedPage(userId, maxId, count, onCooldown) {
    return apiGetRetry(`/api/v1/feed/user/${userId}/?count=${count ?? 12}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, onCooldown);
  }
  async function igFeedByUsernamePage(username, maxId, count, onCooldown) {
    return apiGetRetry(`/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=${count ?? 12}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, onCooldown);
  }
  async function igClipsPage(userId, maxId, onCooldown) {
    const b = { target_user_id: userId, page_size: '33', include_feed_video: '1' };
    if (maxId) b.max_id = maxId;
    return igRequest({ path: '/api/v1/clips/user/', method: 'POST', params: b });
  }
  async function igFollowingsPage(userId, maxId, onCooldown) {
    return apiGetRetry(`/api/v1/friendships/${userId}/following/?count=200${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, onCooldown);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     POST PAGINATION — supports fallback to feed-by-username when web_profile_info fails
     ═══════════════════════════════════════════════════════════════════════════ */
  async function paginatePosts(userId, opts) {
    return paginatePostsWithUsername(userId, opts.username || currentUser?.username || null, opts);
  }
  async function paginatePostsWithUsername(userId, username, opts) {
    const seen = new Set(), all = [];
    await sleep(300 + Math.random() * 700);

    // ── PRIMARY: profile-media paging (GraphQL first, REST feed fallback) ──────
    // Handled entirely inside the service worker, which owns auth capture and
    // the i.instagram.com transport. Works without a userId.
    if (username) {
      try {
        await paginateProfileMedia(username, opts, seen, all);
        if (all.length) return all;
        console.warn('[InstaScrap] profile paging returned 0 posts, trying legacy feed');
      } catch (err) {
        const code = err.code || '';
        // Auth and page-state problems are terminal: the legacy feed below uses
        // the same captured headers, so retrying it would just fail again with
        // a less useful message.
        if (code === 'AUTH' || code === 'PAGE_UNAVAILABLE' || code === 'REQUEST') throw err;
        const m = err.message || '';
        const isFallback = /IG_SCHEMA_DELETED|IG_REQUIRE_LOGIN|IG_RATE_LIMITED|IG_HTML_WALL|IG_AUTH_HTTP|HTTP 42[49]|HTTP 40[013]|NON_JSON|CURSOR|OWNER|QUERY|TIMEOUT|NETWORK/i.test(m);
        if (!isFallback) throw err;
        if (!opts.silent) setFooter(`Profile query blocked (${code || m.slice(0, 40)}) — trying direct feed…`, 'warn');
      }
    }

    // ── FALLBACK: legacy feed/clips ─────────────────────────────────────────
    const onlyReels = opts.wantReels && !opts.wantPhotos && !opts.wantCarousels;
    const onlyFeed  = !opts.wantReels;
    const canUseId  = !!userId;

    if (onlyReels) {
      if (canUseId) {
        await paginateClips(userId, opts, seen, all);
      } else if (username) {
        await paginateFeedByUsername(username, opts, seen, all);
      }
    } else if (onlyFeed) {
      if (canUseId) {
        try {
          await paginateFeed(userId, opts, seen, all);
        } catch (err) {
          if (username && /IG_SCHEMA_DELETED|IG_REQUIRE_LOGIN|IG_RATE_LIMITED|IG_HTML_WALL|Rate limited|HTTP 42[49]|HTTP 400/i.test(err.message || '')) {
            if (!opts.silent) setFooter('Profile lookup blocked — trying direct feed…', 'warn');
            await paginateFeedByUsername(username, opts, seen, all);
          } else throw err;
        }
      } else if (username) {
        await paginateFeedByUsername(username, opts, seen, all);
      }
    } else {
      if (canUseId) {
        try {
          await paginateFeed(userId, opts, seen, all);
        } catch (err) {
          if (username && /IG_SCHEMA_DELETED|IG_REQUIRE_LOGIN|IG_RATE_LIMITED|IG_HTML_WALL|Rate limited|HTTP 42[49]|HTTP 400/i.test(err.message || '')) {
            if (!opts.silent) setFooter('Profile lookup blocked — trying direct feed…', 'warn');
            await paginateFeedByUsername(username, opts, seen, all);
          } else throw err;
        }
      } else if (username) {
        await paginateFeedByUsername(username, opts, seen, all);
      }
      if (isStopped(opts)) return all;
      if (canUseId) {
        try {
          await paginateClips(userId, opts, seen, all);
        } catch (err) {
          if (/Rate limited|HTTP 429/i.test(err.message || '') && all.length) {
            if (!opts.silent) setFooter('Feed scanned; reels were rate-limited — try again in a few minutes.', 'warn');
            return all;
          }
          if (/IG_REQUIRE_LOGIN|HTTP 40[01]/i.test(err.message || '') && all.length) return all;
          throw err;
        }
      } else {
        const derivedId = all[0]?.userId || null;
        if (derivedId) {
          try { await paginateClips(derivedId, opts, seen, all); } catch {}
        }
      }
    }
    return all;
  }

  function isStopped(opts) {
    return opts.silent ? bulkStop : stopFetch;
  }

  // Legacy REST feed stages. These only run when the profile-media query is
  // blocked outright; they page in steps of 12 like the reference so we don't
  // trip Instagram's rate limiter with count=50 requests.
  async function paginateFeed(userId, opts, seen, all) {
    let maxId = null, page = 0, more = true;
    const pgSize = () => 12;
    const dFrom = opts.dateFrom ? new Date(opts.dateFrom + 'T00:00:00') : null;
    const dTo   = opts.dateTo   ? new Date(opts.dateTo   + 'T23:59:59') : null;
    const onCooldown = opts.silent ? null : secs => setScan(`Rate limited — cooling down (~${secs}s)…`, all.length);
    while (more && all.length < opts.maxCount && !isStopped(opts)) {
      if (!opts.silent) setScan(`Scanning timeline page ${page + 1}…`, all.length);
      const data  = await igFeedPage(userId, maxId, pgSize(), onCooldown);
      const items = data.items || [];
      let done = false;
      for (const item of items) {
        const id   = String(item.id);
        const date = new Date(item.taken_at * 1000);
        if (dTo   && date > dTo)   continue;
        if (dFrom && date < dFrom) { done = true; break; }
        if (seen.has(id)) continue;
        const mt = item.media_type;
        if (mt === 2 && !opts.wantReels)     continue;
        if (mt === 1 && !opts.wantPhotos)    continue;
        if (mt === 8 && !opts.wantCarousels) continue;
        const post = parsePost(item);
        if (!post || !post.medias.length) continue;
        seen.add(id);
        all.push(post);
        if (!opts.silent) incrCounts(post);
        if (all.length >= opts.maxCount) { done = true; break; }
      }
      if (done || !data.more_available || !items.length) more = false;
      else { maxId = data.next_max_id; page++; }
    }
  }

  async function paginateFeedByUsername(username, opts, seen, all) {
    let maxId = null, page = 0, more = true;
    const pgSize = () => 12;
    const dFrom = opts.dateFrom ? new Date(opts.dateFrom + 'T00:00:00') : null;
    const dTo   = opts.dateTo   ? new Date(opts.dateTo   + 'T23:59:59') : null;
    const onCooldown = opts.silent ? null : secs => setScan(`Rate limited — cooling down (~${secs}s)…`, all.length);
    while (more && all.length < opts.maxCount && !isStopped(opts)) {
      if (!opts.silent) setScan(`Scanning @${username} page ${page + 1}…`, all.length);
      const data  = await igFeedByUsernamePage(username, maxId, pgSize(), onCooldown);
      // Debug: log empty but profile has posts
      if (!data.items || data.items.length === 0) {
        console.warn(`[InstaScrap] feedByUsername ${username} page ${page+1} returned ${data.items?.length ?? 0} items`, data);
      }
      const items = data.items || [];
      let done = false;
      for (const item of items) {
        const id   = String(item.id);
        const date = new Date(item.taken_at * 1000);
        if (dTo   && date > dTo)   continue;
        if (dFrom && date < dFrom) { done = true; break; }
        if (seen.has(id)) continue;
        const mt = item.media_type;
        if (mt === 2 && !opts.wantReels)     continue;
        if (mt === 1 && !opts.wantPhotos)    continue;
        if (mt === 8 && !opts.wantCarousels) continue;
        const post = parsePost(item);
        if (!post || !post.medias.length) continue;
        seen.add(id);
        // stash user.pk for later clips fallback
        post.userId = item.user?.pk || item.user?.id || null;
        all.push(post);
        if (!opts.silent) incrCounts(post);
        if (all.length >= opts.maxCount) { done = true; break; }
      }
      if (done || !data.more_available || !items.length) more = false;
      else { maxId = data.next_max_id; page++; }
    }
  }

  async function paginateProfileMedia(username, opts, seen, all) {
    let next = null, page = 0, more = true;
    const dFrom = opts.dateFrom ? new Date(opts.dateFrom + 'T00:00:00') : null;
    const dTo   = opts.dateTo   ? new Date(opts.dateTo   + 'T23:59:59') : null;
    while (more && all.length < opts.maxCount && !isStopped(opts)) {
      if (!opts.silent) setScan(`Scanning @${username} (page ${page + 1})…`, all.length);
      const res = await profileMediaPage(username, next);
      const items = res.items || [];
      if (!items.length) console.warn(`[InstaScrap] profileMedia @${username} p${page + 1} → 0 items via ${res.provider}`);
      let done = false;
      for (const item of items) {
        const id = String(item.id || item.pk);
        const date = new Date((item.taken_at || 0) * 1000);
        if (dTo && date > dTo) continue;
        if (dFrom && date < dFrom) { done = true; break; }
        if (seen.has(id)) continue;
        const mt = item.media_type;
        if (mt === 2 && !opts.wantReels) continue;
        if (mt === 1 && !opts.wantPhotos) continue;
        if (mt === 8 && !opts.wantCarousels) continue;
        item.user = item.user || { username };
        const post = parsePost(item);
        if (!post || !post.medias.length) continue;
        seen.add(id);
        post.userId = item.user?.pk || item.user?.id || null;
        all.push(post);
        if (!opts.silent) incrCounts(post);
        if (all.length >= opts.maxCount) { done = true; break; }
      }
      if (done || !res.next || !items.length) more = false;
      else { next = res.next; page++; }
    }
  }

  async function paginateClips(userId, opts, seen, all) {
    let maxId = null, page = 0, more = true;
    const dFrom = opts.dateFrom ? new Date(opts.dateFrom + 'T00:00:00') : null;
    const dTo   = opts.dateTo   ? new Date(opts.dateTo   + 'T23:59:59') : null;
    const onCooldown = opts.silent ? null : secs => setScan(`Rate limited — cooling down (~${secs}s)…`, all.length);
    while (more && all.length < opts.maxCount && !isStopped(opts)) {
      if (!opts.silent) setScan(`Scanning reels page ${page + 1}…`, all.length);
      const data  = await igClipsPage(userId, maxId, onCooldown).catch(err => {
        if (err.code === 'IG_RATE_LIMITED') throw err;
        console.warn('[InstaScrap] reels endpoint failed', err.code, err.message);
        return null;
      });
      if (!data) break;
      const items = (data.items || []).map(i => i.media || i).filter(m => m?.id);
      let done = false;
      for (const item of items) {
        const id   = String(item.id);
        const date = new Date(item.taken_at * 1000);
        if (dTo   && date > dTo)   continue;
        if (dFrom && date < dFrom) { done = true; break; }
        if (seen.has(id)) continue;
        const post = parsePost(item);
        if (!post || !post.medias.length) continue;
        seen.add(id);
        all.push(post);
        if (!opts.silent) incrCounts(post);
        if (all.length >= opts.maxCount) { done = true; break; }
      }
      if (done || !data.paging_info?.more_available || !items.length) more = false;
      else { maxId = data.paging_info?.max_id; page++; }
    }
  }

  /* ── Post parser ────────────────────────────────────────────────────────── */
  function parsePost(item) {
    const username = item.user?.username || currentUser?.username || 'unknown';
    const dateStr  = new Date(item.taken_at * 1000).toISOString().slice(0, 10);
    const code     = item.code || item.shortcode || String(item.pk || item.id);
    const base     = `${username}_${dateStr}_${code}`;
    const mtype    = item.media_type;
    const type     = mtype === 8 ? 'album' : mtype === 2 ? 'reel' : 'photo';
    const permalink = type === 'reel' ? `https://www.instagram.com/reel/${code}/` : `https://www.instagram.com/p/${code}/`;
    // July 30 2026 Graph change: media_url/video_versions can be omitted when
    // reel contains copyrighted audio or owner disabled downloads. Private
    // api/v1 still returns video_versions for many reels, but we treat missing
    // url as non-downloadable and surface reason instead of silently dropping.
    const isProtected = item.media_url === null || (item.video_versions && item.video_versions.length === 0 && item.media_type === 2);
    let medias     = [];
    let protectedReason = null;
    if (isProtected) {
      protectedReason = item.download_restricted_reason || 'copyright/download disabled (July 30 2026) — media_url omitted';
    }
    if (type === 'album') {
      // Instagram returns carousel_media as a non-array for some malformed
      // albums; treat that as "no slides" rather than crashing on .flatMap.
      const slides = Array.isArray(item.carousel_media) ? item.carousel_media : [];
      medias = slides.flatMap((m, i) => {
        if (!m) return [];
        if (m.media_type === 2) {
          const u = bestVideo(m);
          if (u) return [{ url: u, filename: `${base}_${i+1}.mp4`, dash: m.video_dash_manifest || null }];
          // Keep dash manifest even when progressive blocked — Instagram-Downloader-5.1.21 uses dash fallback
          if (m.video_dash_manifest) return [{ url: null, dash: m.video_dash_manifest, filename: `${base}_${i+1}.mp4`, protected: true, reason: protectedReason }];
          if (m.media_url === null) return [{ url: null, filename: `${base}_${i+1}.mp4`, protected: true, reason: protectedReason }];
          return [];
        }
        const u = bestImage(m); return u ? [{ url: u, filename: `${base}_${i+1}.jpg` }] : [];
      });
    } else if (type === 'reel') {
      const u = bestVideo(item);
      if (u) medias = [{ url: u, filename: `${base}.mp4`, dash: item.video_dash_manifest || null }];
      else if (item.video_dash_manifest) medias = [{ url: null, dash: item.video_dash_manifest, filename: `${base}.mp4`, protected: true, reason: protectedReason }];
      else if (protectedReason || isProtected) medias = [{ url: null, filename: `${base}.mp4`, protected: true, reason: protectedReason }];
    } else {
      const u = bestImage(item); if (u) medias = [{ url: u, filename: `${base}.jpg` }];
    }
    return { id: String(item.id), type, username, timestamp: item.taken_at, date: dateStr, permalink, medias, protected: !!protectedReason, protectedReason };
  }
  function bestImage(item) {
    const c = item?.image_versions2?.candidates;
    return c?.length ? c.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0]?.url : null;
  }
  function bestVideo(item) {
    const v = item?.video_versions;
    return v?.length ? v.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0]?.url : null;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SINGLE PROFILE FLOW
     ═══════════════════════════════════════════════════════════════════════════ */
  $('btn-fetch').addEventListener('click', onFetch);
  $('inp-username').addEventListener('keydown', e => { if (e.key === 'Enter') onFetch(); });
  $('btn-download').addEventListener('click', onDownload);
  $('btn-clear-hist').addEventListener('click', onClearHist);
  $('chk-skip').addEventListener('change', refreshDlBtn);
  $('btn-use-tab').addEventListener('click', useOpenProfile);

  /** Fill the username input from the profile open in this tab, if any. */
  function usernameFromTab() {
    try {
      const seg = decodeURIComponent((location.pathname.split('/').filter(Boolean)[0] || '')).trim();
      // Instagram chrome around a profile: /p/<code>, /reel/<code>, /explore, …
      const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'live', 'tv',
        'direct', 'inbox', 'accounts', 'about', 'developer', 'directory', 'collections',
        'guides', 'saved', 'challenge', 'embeds', 'media', 'share', 'reels_audio']);
      if (!seg || reserved.has(seg.toLowerCase())) return null;
      return /^[\w.]{1,30}$/.test(seg) ? seg : null;
    } catch { return null; }
  }
  function useOpenProfile() {
    const u = usernameFromTab();
    if (u) {
      $('inp-username').value = u;
      setFooter(`Using @${u} from this tab — press Fetch posts to scan.`, 'ok');
    } else {
      setFooter('This tab is not on a profile page — open a profile first.', 'warn');
    }
  }

  async function onFetch(e) {
    if (isFetching) { stopFetch = true; abortCtl?.abort(); return; }
    const username = $('inp-username').value.trim().replace(/^@/, '');
    if (!username) return;
    // Shift+Click = force DOM-only scrape (bypasses all /api/v1/*) — use for heroine_kr when session flagged
    const forceDom = !!(e && e.shiftKey);
    if (forceDom) {
      isFetching = true; stopFetch = false; abortCtl = new AbortController();
      resetResults(); setFetchLoading(true); setFooter('DOM-only scrape (Shift held)…', 'warn');
      $('scan-progress').classList.remove('hidden'); setScan('Scraping visible grid…', 0);
      try {
        dlHistory = await loadHistory(username);
        const domOpts = {
          dateFrom: $('inp-date-from').value || null,
          dateTo: $('inp-date-to').value || null,
          wantReels: false, wantPhotos: true, wantCarousels: true,
          maxCount: Math.max(1, parseInt($('inp-max').value) || 100),
          username,
        };
        let domPosts = domGridImageFallback(username, domOpts);
        // If grid hasn't rendered yet, nudge scroll then retry once
        if (!domPosts.length && location.pathname.toLowerCase().includes(username.toLowerCase())) {
          window.scrollBy({ top: 600, behavior: 'instant' });
          await sleep(800);
          domPosts = domGridImageFallback(username, domOpts);
        }
        $('scan-progress').classList.add('hidden');
        if (!domPosts.length) {
          setFooter('No visible images found — open https://www.instagram.com/'+username+'/ and scroll to load grid, then Shift+Click Fetch again.', 'warn');
        } else {
          domPosts.forEach(p => incrCounts(p));
          fetchedPosts = domPosts;
          currentUser = { id: null, username, fullName: username, isPrivate:false, isVerified:false, mediaCount: domPosts.length, followCount:0, profilePic: '' };
          const meta = await fetchProfileMetaFallback(username);
          if (meta?.title) currentUser.fullName = meta.title;
          if (meta?.ogImg) currentUser.profilePic = meta.ogImg;
          showUserCard(currentUser);
          $('results-count').textContent = countLabel(domPosts.length);
          $('results-section').classList.remove('hidden');
          showHistBar(); refreshDlBtn();
          setFooter(`${domPosts.length} images read from the loaded grid. Scroll further, then fetch again for more.`, 'ok');
          chrome.storage.session.set({ is_posts: fetchedPosts, is_user: currentUser, is_counts: { ...cnt } }).catch(()=>{});
        }
      } catch (err) { $('scan-progress').classList.add('hidden'); setFooter('DOM scrape failed: '+(err.message||err), 'err'); }
      finally { isFetching=false; setFetchLoading(false); }
      return;
    }
    // Global cooldown after 429
    if (last429At && performance.now() - last429At < 90000) {
      const wait = Math.ceil((90000 - (performance.now() - last429At)) / 1000);
      setFooter(`Instagram is rate-limiting you — wait ~${wait}s before retrying (don’t spam Fetch). Tip: Shift+Click Fetch = DOM-only scrape (no API, works while flagged).`, 'warn');
      return;
    }
    const authStatus = (await igAuthStatus()) || { ready: false, message: 'Instagram auth is not available.' };
    if (!authStatus.ready) {
      setFooter(`${authStatus.message || 'Instagram auth is not available.'}`, 'err');
      isFetching = true; stopFetch = false; abortCtl = new AbortController();
      resetResults(); setFetchLoading(true);
      $('scan-progress').classList.remove('hidden'); setScan('HTML fallback (no login)…', 0);
      try {
        dlHistory = await loadHistory(username);
        const optsNoAuth = {
          dateFrom: $('inp-date-from').value || null,
          dateTo: $('inp-date-to').value || null,
          wantReels: false, wantPhotos: true, wantCarousels: true,
          maxCount: Math.max(1, parseInt($('inp-max').value) || 100),
          username,
        };
        const htmlPosts = await htmlImageFallback(username, optsNoAuth);
        $('scan-progress').classList.add('hidden');
        if (!htmlPosts.length) { setFooter('No images found via HTML. Log in to Instagram then retry for full API access.', 'err'); }
        else {
          htmlPosts.forEach(p => incrCounts(p));
          fetchedPosts = htmlPosts;
          currentUser = { id: null, username, fullName: username, isPrivate:false, isVerified:false, mediaCount: htmlPosts.length, followCount:0, profilePic: '' };
          const meta = await fetchProfileMetaFallback(username);
          if (meta?.title) currentUser.fullName = meta.title;
          if (meta?.ogImg) currentUser.profilePic = meta.ogImg;
          if (meta?.posts) currentUser.mediaCount = meta.posts;
          if (meta?.followers) currentUser.followCount = meta.followers;
          showUserCard(currentUser);
          $('results-count').textContent = countLabel(htmlPosts.length);
          $('results-section').classList.remove('hidden');
          showHistBar(); refreshDlBtn();
          setFooter(`${htmlPosts.length} image posts recovered from the profile page. Reels need a signed-in session.`, 'ok');
          chrome.storage.session.set({ is_posts: fetchedPosts, is_user: currentUser, is_counts: { ...cnt } }).catch(()=>{});
        }
      } catch (e) { $('scan-progress').classList.add('hidden'); setFooter('HTML fallback failed: '+ (e.message||e), 'err'); }
      finally { isFetching=false; setFetchLoading(false); }
      return;
    }
    isFetching = true; stopFetch = false; abortCtl = new AbortController();
    resetResults(); setFetchLoading(true); setFooter('');
    setPreferredResolutionCookies();
    $('scan-progress').classList.remove('hidden'); setScan(`Looking up @${username}…`, 0);
    try {
      let userInfo = null;
      let userId = null;
      try {
        userInfo = await igUserInfo(username);
        userId = userInfo.id;
        currentUser = userInfo; showUserCard(userInfo);
      } catch (err) {
        const m = err.message || '';
        const isFallbackCase = /IG_SCHEMA_DELETED|IG_REQUIRE_LOGIN|IG_RATE_LIMITED|IG_HTML_WALL|IG_AUTH_HTTP|QUERY|User not found|Rate limited|HTTP 42[49]|HTTP 400|HTTP 404/i.test(m);
        if (isFallbackCase) {
          // Fallback: web_profile_info gated for this account — use placeholder card and feed-by-username
          if (/IG_SCHEMA_DELETED/i.test(m)) {
            setFooter('Instagram profile lookup is broken for this account — switching to direct feed…', 'warn');
          } else if (/IG_REQUIRE_LOGIN/i.test(m)) {
            setFooter('Instagram requires login for profile lookup — trying direct feed…', 'warn');
          } else if (/User not found/i.test(m)) {
            setFooter(`@${username} did not resolve via profile lookup — trying posts directly…`, 'warn');
          } else {
            setFooter('Profile lookup failed — trying direct feed…', 'warn');
          }
          // Minimal placeholder; try to enrich via HTML meta so card doesn't show 0/0
          userInfo = {
            id: null, username,
            fullName: username,
            isPrivate: false, isVerified: false,
            mediaCount: 0, followCount: 0,
            profilePic: '',
          };
          currentUser = userInfo; showUserCard(userInfo);
          userId = null;
          // Async enrich card from OG meta (doesn't block feed fetch)
          fetchProfileMetaFallback(username).then(meta => {
            if (meta && currentUser && currentUser.username === username) {
              if (meta.title) currentUser.fullName = meta.title;
              if (meta.ogImg) currentUser.profilePic = meta.ogImg;
              if (meta.posts) currentUser.mediaCount = meta.posts;
              if (meta.followers) currentUser.followCount = meta.followers;
              showUserCard(currentUser);
            }
          });
        } else {
          throw err;
        }
      }
      setScan(`Fetching posts for @${username}…`, 0);
      dlHistory = await loadHistory(username);
      const opts = {
        dateFrom:      $('inp-date-from').value || null,
        dateTo:        $('inp-date-to').value   || null,
        wantReels:     $('chk-reels').checked,
        wantPhotos:    $('chk-photos').checked,
        wantCarousels: $('chk-albums').checked,
        maxCount:      Math.max(1, parseInt($('inp-max').value) || 100),
        username,
      };
      // Always go through paginatePostsWithUsername: its first stage is the
      // service-worker's profile-media paging (GraphQL + feed fallback), which
      // needs no userId. userId is only used by the later legacy clips stage.
      fetchedPosts = await paginatePostsWithUsername(userId, username, opts);
      // If we fell back via placeholder, try to upgrade placeholder from first post's user data
      if (!userInfo.profilePic && fetchedPosts[0]?.username) {
        const fp = fetchedPosts[0];
        // item.user may have hd pic in image_versions2 but we don't have it; keep handle at least
        currentUser.username = fp.username;
        showUserCard(currentUser);
      }
      $('scan-progress').classList.add('hidden');
      // HTML fallback for image posts — works even when API is HTML-walled / session-flagged (2026-09)
      // heroine_kr is public but Instagram now flags sessions quickly; DOM scrape rescues photos+albums.
      if (!fetchedPosts.length) {
        if (opts.wantPhotos || opts.wantCarousels) {
          try {
            setFooter('API blocked — trying HTML image fallback…', 'warn');
            const htmlPosts = await htmlImageFallback(username, opts);
            if (htmlPosts.length) {
              fetchedPosts = htmlPosts;
              htmlPosts.forEach(p => incrCounts(p));
              setFooter(`Recovered ${htmlPosts.length} image posts from the profile page. Reels need a signed-in session.`, 'ok');
            }
          } catch (e) { console.warn('[InstaScrap] HTML fallback failed', e); }
        }
      }
      if (!fetchedPosts.length) {
        // If profile meta says posts exist but feed returned 0, it's a block/rate-limit, not empty
        const expected = currentUser?.mediaCount || 0;
        if (expected > 10) {
          setFooter(`The profile lists ${fmtNum(expected)} posts but the scan returned none. Instagram blocked the request — try again in a few minutes, or sign in again.`, 'warn');
        } else if (!userId) {
          // We never confirmed this account exists (profile lookup failed too).
          setFooter(`Could not confirm @${username} — it may be private, renamed, or blocking API access. Check the spelling or open the profile in Instagram first.`, 'warn');
        } else {
          setFooter('No posts matched filters. Try disabling date filters or enabling all media types.', 'warn');
        }
      } else {
        const newCount = fetchedPosts.filter(p => !dlHistory.has(p.id)).length;
        $('results-count').textContent = countLabel(fetchedPosts.length);
        $('results-section').classList.remove('hidden');
        showHistBar(); refreshDlBtn();
        setFooter(`${fetchedPosts.length} posts · ${newCount} new`, 'ok');
        chrome.storage.session.set({ is_posts: fetchedPosts, is_user: currentUser, is_counts: { ...cnt } }).catch(() => {});
      }
    } catch (err) {
      $('scan-progress').classList.add('hidden');
      const msg = err.message || String(err);
      if (err.code === 'AUTH') {
        // The service worker refused to guess headers — relay its exact reason.
        setFooter(msg, 'err');
      } else if (err.code === 'PAGE_UNAVAILABLE' || err.code === 'REQUEST') {
        setFooter(msg, 'err');
      } else if (/IG_REQUIRE_LOGIN|IG_AUTH_HTTP/i.test(msg)) {
        setFooter(msg || 'Instagram refused the session — log out and back in, then reload the tab.', 'err');
      } else if (/IG_SCHEMA_DELETED/i.test(msg)) {
        setFooter('Instagram changed its response structure for this profile. Try again shortly, or report the username.', 'err');
      } else if (/IG_HTML_WALL|NON_JSON/i.test(msg)) {
        setFooter('Instagram returned an HTML page instead of data (login wall or rate limit). Log out and back in, or wait a few minutes.', 'err');
      } else if (/IG_RATE_LIMITED|Rate limited|HTTP 429/i.test(msg)) {
        setFooter(consec429 >= 2
          ? 'Rate limited twice — the session is flagged. Close all instagram.com tabs, log out, log back in, then wait ~10 minutes.'
          : 'Rate limited — wait 5-10 minutes, then try again.', 'warn');
      } else {
        setFooter(msg, 'err');
      }
    } finally {
      isFetching = false; setFetchLoading(false);
    }
  }

  async function onDownload() {
    if (!fetchedPosts.length || isDownloading) return;
    const skip  = $('chk-skip').checked;
    const isZip = $('chk-zip').checked;
    const posts = skip ? fetchedPosts.filter(p => !dlHistory.has(p.id)) : fetchedPosts;
    if (!posts.length) { setFooter('Nothing new. Uncheck "Skip downloaded" to re-download.', 'warn'); return; }
    
    const username = currentUser?.username || 'posts';
    const folder = `InstaScrap/${username}`;
    const protectedPosts = posts.filter(p => p.protected || p.medias.some(m => m.protected || !m.url));
    const files  = posts.flatMap(p => p.medias.filter(m => m.url).map(m => ({ url: m.url, filename: `${folder}/${m.filename}` })));
    if (!files.length && protectedPosts.length) {
      setFooter(`${protectedPosts.length} reels have no downloadable file — the creator or Instagram blocked it. Open the permalink to watch, or use Export → Copy.`, 'warn');
      $('btn-download').disabled = false;
      $('dl-progress').classList.add('hidden');
      return;
    } else if (protectedPosts.length) {
      setFooter(`Note: ${protectedPosts.length} reels have no media_url (copyright/download off) — downloading ${files.length} files, ${protectedPosts.length} skipped.`, 'warn');
    }
    
    isDownloading = true;
    $('btn-download').disabled = true;
    $('dl-progress').classList.remove('hidden');
    stopFetch = false; abortCtl = new AbortController();
    
    let flatSaves = 0;
    if (isZip) {
      try {
        const workerUrl = chrome.runtime.getURL('content/zip-worker.js');
        let worker;
        try { worker = new Worker(workerUrl); } catch (_) { worker = null; }
        if (worker) {
          await new Promise((resolve, reject) => {
            worker.onmessage = async (e) => {
              if (e.data.type === 'progress') {
                setDlProg(`Zipping ${e.data.done} of ${e.data.total}`, e.data.done, e.data.total);
              } else if (e.data.type === 'done') {
                const zipPath = `InstaScrap/${username}/${e.data.zipFilename}`;
                try {
                  await swSaveBlob(e.data.blob, zipPath);
                  setDlProg(`${e.data.zipFilename} saved to Downloads/${zipPath}`, e.data.total, e.data.total);
                } catch (saveErr) {
                  console.warn('[InstaScrap] foldered ZIP save failed, saving flat instead:', saveErr);
                  try {
                    anchorSaveBlob(e.data.blob, e.data.zipFilename);
                    flatSaves++;
                    setDlProg(`${e.data.zipFilename} saved flat to Downloads/`, e.data.total, e.data.total);
                  } catch (flatErr) { reject(flatErr); return; }
                }
                resolve();
              } else if (e.data.type === 'error') {
                reject(new Error(e.data.message));
              }
            };
            worker.onerror = (err) => reject(new Error(err.message));
            worker.postMessage({
              files,
              zipFilename: `${username}_instascrap.zip`,
              jszipUrl: chrome.runtime.getURL('lib/jszip.min.js'),
            });
          });
          worker.terminate();
        } else {
          const how = await zipFilesLocally(files, username);
          if (how === 'anchor') flatSaves++;
        }
      } catch (err) {
        console.warn('ZIP failed, switching to individual downloads:', err);
        setFooter('ZIP failed — use individual download instead.', 'warn');
        isDownloading = false;
        $('btn-download').disabled = false;
        return;
      }
    } else {
      let done = 0;
      if (!stopFetch) {
        const results = await pMap(files, async (f) => {
          if (stopFetch) return 'skipped';
          const idx = done++;
          setDlProg(`Saving ${f.filename.split('/').pop()}`, idx, files.length);
          const how = await dlFile(f.url, f.filename);
          if (how === 'anchor') flatSaves++;
          return how;
        }, { concurrency: 3 });
        const succeeded = results.filter(r => r.status === 'fulfilled' && r.value !== 'skipped').length;
        setDlProg(`Saved ${succeeded} of ${files.length} files`, files.length, files.length);
      }
    }

    if (!stopFetch) {
      await saveHistory(currentUser.username, posts.map(p => p.id));
      dlHistory = await loadHistory(currentUser.username);
      showHistBar(); refreshDlBtn();
      if (flatSaves) {
        setFooter(isZip
          ? `Archive saved flat to Downloads/ — the foldered save failed.`
          : `Saved ${files.length} files, but ${flatSaves} landed flat in Downloads/ (foldered save failed).`, 'warn');
      } else {
        setFooter(isZip
          ? `Archive saved to Downloads/InstaScrap/${username}/`
          : `Saved ${files.length} files to Downloads/InstaScrap/${username}/`, 'ok');
      }
    }
    isDownloading = false; $('btn-download').disabled = false;
  }

  async function zipFilesLocally(files, username) {
    const zip = new JSZip();
    let done = 0;
    const results = await pMap(files, async (f) => {
      if (stopFetch) return null;
      setDlProg(`Zipping ${f.filename.split('/').pop()}`, done, files.length);
      try {
        await dlBucket.take();
        const resp = await fetch(f.url, { signal: abortCtl?.signal });
        const blob = await resp.blob();
        zip.file(f.filename.split('/').pop(), blob);
        done++;
        return true;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('Zip fetch failed', e);
        done++;
        return false;
      }
    }, { concurrency: 4 });
    if (stopFetch) return null;
    setDlProg('Finalizing the archive', done, files.length);
    const content = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const zipName = `${username}_instascrap.zip`;
    const zipPath = `InstaScrap/${username}/${zipName}`;
    try {
      await swSaveBlob(content, zipPath);
      setDlProg(`${zipName} saved to Downloads/${zipPath}`, files.length, files.length);
      return 'sw';
    } catch (err) {
      console.warn('[InstaScrap] foldered ZIP save failed, saving flat instead:', err);
      anchorSaveBlob(content, zipName);
      setDlProg(`${zipName} saved flat to Downloads/`, files.length, files.length);
      return 'anchor';
    }
  }

  async function onClearHist() {
    const u = $('inp-username').value.trim().replace(/^@/, '');
    if (!u) return;
    await chrome.storage.local.remove(`hist_${u.toLowerCase()}`);
    dlHistory = new Set();
    $('hist-bar').classList.add('hidden');
    $('btn-clear-hist').classList.add('hidden');
    refreshDlBtn();
    setFooter(`History cleared for @${u}`, 'ok');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     FOLLOWINGS FLOW
     ═══════════════════════════════════════════════════════════════════════════ */
  $('btn-fol-load').addEventListener('click',  loadFollowings);
  $('fol-search').addEventListener('input',    filterFolList);
  $('fol-sel-all').addEventListener('click',   () => setAllChecked(true));
  $('fol-sel-none').addEventListener('click',  () => setAllChecked(false));
  $('btn-fol-run').addEventListener('click',   () => bulkRun(false));
  $('btn-fol-links').addEventListener('click', () => bulkRun(true));
  $('btn-fol-stop').addEventListener('click',  () => {
    bulkStop = true; abortCtl?.abort();
    $('btn-fol-stop').disabled = true;
    $('fol-run-status').textContent = 'Stopping after current account…';
  });

  async function loadFollowings() {
    if (bulkRunning) return;
    const myId = getMyId();
    if (!myId) { setFooter('Not logged in to Instagram.', 'err'); return; }
    followings = [];
    $('fol-list').innerHTML = '';
    $('fol-list-section').classList.add('hidden');
    $('fol-load-prog').classList.remove('hidden');
    $('btn-fol-load').disabled = true;
    setIcon($('ico-fol-load'), 'spinner');
    $('txt-fol-load').textContent = 'Loading';
    bulkStop = false;
    await sleep(300 + Math.random() * 700);
    try {
      let cursor = null, hasMore = true, page = 0;
      while (hasMore && !bulkStop) {
        $('fol-load-label').textContent = `Fetching page ${page + 1}…`;
        $('fol-load-count').textContent = `${followings.length} accounts`;
        const data = await igFollowingsPage(myId, cursor);
        const users = (data.users || []).map(u => ({
          pk: String(u.pk), username: u.username,
          fullName: u.full_name || '', profilePic: u.profile_pic_url || '',
        }));
        followings.push(...users);
        cursor = data.next_max_id; hasMore = !!cursor; page++;
      }
      chrome.storage.session.set({ is_followings: followings }).catch(() => {});
      renderFolList();
      setFooter(`Loaded ${followings.length} followings`, 'ok');
    } catch (err) {
      setFooter(err.message, 'err');
    } finally {
      $('fol-load-prog').classList.add('hidden');
      $('btn-fol-load').disabled = false;
      setIcon($('ico-fol-load'), 'users');
      $('txt-fol-load').textContent = followings.length
        ? `Reload (${followings.length} accounts)`
        : 'Load my following';
    }
  }

  function renderFolList() {
    const list = $('fol-list');
    list.innerHTML = '';
    const term = $('fol-search').value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    followings.forEach((acc, idx) => {
      const hidden = term && !acc.username.includes(term) && !acc.fullName.toLowerCase().includes(term);
      const row = document.createElement('label');
      row.className = 'fol-item' + (hidden ? ' fol-hidden' : '');
      row.dataset.idx = idx;
      row.innerHTML = `
        <input class="fol-chk" type="checkbox" checked data-idx="${idx}" aria-label="Select @${esc(acc.username)}">
        <img class="fol-avatar" src="${esc(acc.profilePic)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="fol-info">
          <div class="fol-name">${esc(acc.fullName || acc.username)}</div>
          <div class="fol-handle">@${esc(acc.username)}</div>
        </div>
        <span class="fol-status" data-role="status"></span>`;
      row.querySelector('.fol-chk').addEventListener('change', updateFolCounts);
      frag.appendChild(row);
    });
    list.appendChild(frag);
    $('fol-list-section').classList.remove('hidden');
    updateFolCounts();
  }

  function filterFolList() {
    const term = $('fol-search').value.trim().toLowerCase();
    $('fol-list').querySelectorAll('.fol-item').forEach(row => {
      const acc   = followings[row.dataset.idx];
      const match = !term || acc?.username.includes(term) || acc?.fullName.toLowerCase().includes(term);
      row.classList.toggle('fol-hidden', !match);
    });
    updateFolCounts();
  }

  function setAllChecked(checked) {
    $('fol-list').querySelectorAll('.fol-item:not(.fol-hidden) .fol-chk')
      .forEach(c => { c.checked = checked; });
    updateFolCounts();
  }

  function updateFolCounts() {
    const selected = $('fol-list').querySelectorAll('.fol-item:not(.fol-hidden) .fol-chk:checked');
    $('fol-list-info').textContent = `${followings.length} accounts · ${selected.length} selected`;
    const n = selected.length;
    const isZip = $('chk-zip').checked;
    $('btn-fol-run').disabled = n === 0 || bulkRunning;
    if ($('btn-fol-links')) $('btn-fol-links').disabled = n === 0 || bulkRunning;
    
    const plural = n === 1 ? '' : 's';
    if (n === 0) {
      $('txt-fol-run').textContent = 'Select accounts first';
      if ($('txt-fol-links')) $('txt-fol-links').textContent = 'Select accounts first';
    } else if (isZip) {
      $('txt-fol-run').textContent = `Bundle ${n} account${plural} as ZIP`;
      if ($('txt-fol-links')) $('txt-fol-links').textContent = `Export links for ${n}`;
    } else {
      $('txt-fol-run').textContent = `Fetch and download ${n} account${plural}`;
      if ($('txt-fol-links')) $('txt-fol-links').textContent = `Export links for ${n}`;
    }
  }

  async function bulkRun(exportLinksMode = false) {
    if (bulkRunning) return;
    const rows = [...$('fol-list').querySelectorAll('.fol-item:not(.fol-hidden) .fol-chk:checked')]
      .map(chk => ({ acc: followings[parseInt(chk.dataset.idx, 10)], row: chk.closest('.fol-item') }));
    if (!rows.length) return;
    const opts = {
      wantReels:     $('fol-reels').checked,
      wantPhotos:    $('fol-photos').checked,
      wantCarousels: $('fol-albums').checked,
      maxCount:      Math.max(1, parseInt($('fol-max').value) || 50),
      silent: true,
    };
    bulkRunning = true; bulkStop = false; abortCtl = new AbortController();
    $('btn-fol-run').disabled  = true;
    if ($('btn-fol-links')) $('btn-fol-links').disabled = true;
    $('btn-fol-load').disabled = true;
    $('btn-fol-stop').disabled = false;
    $('fol-list-section').classList.add('hidden');
    $('fol-run-section').classList.remove('hidden');
    $('fol-run-log').innerHTML = '';

    const total = rows.length;
    const state = { done: 0, totalNew: 0, totalSkipped: 0, consec429: 0 };
    const allLinks = [];
    $('fol-run-status').textContent = exportLinksMode ? `Exporting links for ${total} accounts…` : `Bulk downloading ${total} accounts…`;
    setFolProg('Starting…', 0, total);

    await pMap(rows, async ({ acc, row }) => {
      if (bulkStop) return;
      if (state.done > 0) await sleep(7000 + Math.random() * 5000);
      setFolItemStatus(row, 'running', 'spinner');
      const logRow = addLogRow(acc, 'spinner', 'fetching…');
      // ── highly visible progress ──
      setFooter(`[${state.done+1}/${total}] @${acc.username} — fetching…`, 'ok');
      setFolProg(`Fetching @${acc.username} (${state.done+1}/${total})`, state.done, total);
      setDataLabel($('fol-run-label'), `@${acc.username} — fetching…`);
      $('fol-run-status').textContent = `Bulk ${state.done+1}/${total} — @${acc.username}`;
      try {
        // ── SKIP web_profile_info in bulk — it 429s after ~10 users and flags session (you saw consec 405→455)
        // Bulk-Saver never calls web_profile_info for bulk; it goes straight to GraphQL via username.
        // We do the same: no API call for profile, just username → GraphQL/feed/DOM.
        const userId = null;
        const history  = await loadHistory(acc.username);
        const optsWithUser = { ...opts, username: acc.username };
        const posts = await paginatePostsWithUsername(userId, acc.username, optsWithUser);
        const newPosts = posts.filter(p => !history.has(p.id));
        if (!newPosts.length) {
          setFolItemStatus(row, 'skip', 'skip');
          updateLogRow(logRow, 'skip', `up to date · ${posts.length} scanned`);
          setFooter(`[${state.done+1}/${total}] @${acc.username} — up to date (${posts.length} scanned)`, 'ok');
          state.totalSkipped++;
          return;
        }
        const isZip = $('chk-zip').checked;
        const folder = `InstaScrap/${acc.username}`;
        const files  = newPosts.flatMap(p => p.medias.map(m => ({ url: m.url, filename: `${folder}/${m.filename}` })));
        setFooter(`[${state.done+1}/${total}] @${acc.username} — ${newPosts.length} new posts / ${files.length} files — downloading…`, 'ok');
        setDataLabel($('fol-run-label'), `@${acc.username} — ${files.length} files`);

        if (exportLinksMode) {
          const links = newPosts.map(p => p.permalink);
          updateLogRow(logRow, 'link', `${links.length} links…`);
          const text = links.join('\n');
          const blob = new Blob([text], { type: 'text/plain' });
          const linksName = `${acc.username}_reels_links.txt`;
          try {
            await swSaveBlob(blob, `InstaScrap/${acc.username}/${linksName}`);
          } catch (err) {
            console.warn('[InstaScrap] foldered links save failed, saving flat instead:', err);
            anchorSaveBlob(blob, linksName);
          }
          allLinks.push(...links);
          state.totalNew += links.length;
          setFolItemStatus(row, 'done', 'link');
          updateLogRow(logRow, 'check', `${links.length} links`);
        } else if (isZip) {
          updateLogRow(logRow, 'archive', `zipping 0/${files.length}…`);
          const zip = new JSZip();
          let zipDone = 0;
          await pMap(files, async (f) => {
            if (bulkStop) return;
            try {
              await dlBucket.take();
              const resp = await fetch(f.url, { signal: abortCtl?.signal });
              const blob = await resp.blob();
              zip.file(f.filename.split('/').pop(), blob);
              zipDone++;
              updateLogRow(logRow, 'archive', `${zipDone}/${files.length}`);
              setDataLabel($('fol-run-label'), `@${acc.username} — zipping ${zipDone}/${files.length}`);
              setFooter(`[${state.done+1}/${total}] @${acc.username} — zipping ${zipDone}/${files.length}`, 'ok');
            } catch (e) { if (e.name !== 'AbortError') console.warn('Zip fetch failed', e); }
          }, { concurrency: 3 });
          if (!bulkStop) {
            updateLogRow(logRow, 'archive', 'finalizing…');
            setDataLabel($('fol-run-label'), `@${acc.username} — finalizing ZIP`);
            const content = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
            const zipName = `${acc.username}_instascrap.zip`;
            const zipPath = `InstaScrap/${acc.username}/${zipName}`;
            try {
              await swSaveBlob(content, zipPath);
            } catch (err) {
              console.warn('[InstaScrap] foldered ZIP save failed, saving flat instead:', err);
              anchorSaveBlob(content, zipName);
            }
            state.totalNew += files.length;
            setFolItemStatus(row, 'done', 'archive');
            updateLogRow(logRow, 'check', `ZIP ${files.length} files`);
            setFooter(`[${state.done+1}/${total}] @${acc.username} — ZIP saved to Downloads/${zipPath}`, 'ok');
          }
        } else {
          updateLogRow(logRow, 'download', `0/${files.length} files…`);
          let dlDone = 0, dlFlat = 0;
          await pMap(files, async (f) => {
            if (bulkStop) return;
            const how = await dlFile(f.url, f.filename);
            if (how === 'anchor') dlFlat++;
            dlDone++;
            updateLogRow(logRow, 'download', `${dlDone}/${files.length}`);
            setDataLabel($('fol-run-label'), `@${acc.username} — ${dlDone}/${files.length} files`);
            setFooter(`[${state.done+1}/${total}] @${acc.username} — ${dlDone}/${files.length} files`, 'ok');
    }, { concurrency: 1 });
          if (dlFlat) updateLogRow(logRow, 'download', `${dlDone}/${files.length} (${dlFlat} flat)`);
          state.totalNew += files.length;
          setFolItemStatus(row, 'done', 'download');
          updateLogRow(logRow, 'check', `${files.length} files downloaded`);
        }
        await saveHistory(acc.username, newPosts.map(p => p.id));
        state.consec429 = 0;
      } catch (err) {
        const is429 = err.code === 'IG_RATE_LIMITED' || /IG_RATE_LIMITED|Rate limited|HTTP 429/i.test(err.message || '');
        if (is429) state.consec429++; else state.consec429 = 0;
        setFolItemStatus(row, 'err', 'alert');
        updateLogRow(logRow, 'alert', (err.code ? err.code + ': ' : '') + (err.message || '').slice(0, 80));
        // Circuit-breaker: 2 consecutive 429s -> pause 5 min before next account
        if (state.consec429 >= 2 && !bulkStop) {
          const waitSec = 300;
          setFooter(`Rate limited twice — cooling down 5 min…`, 'warn');
          $('fol-run-status').textContent = `Rate limited — pausing 5 min (${state.consec429} consecutive)…`;
          updateLogRow(addLogRow({ username: 'system', profilePic: '' }, 'pause', `cooling down ${waitSec}s…`), 'pause', `waiting ${waitSec}s`);
          await sleep(waitSec * 1000);
          state.consec429 = 0;
        }
      } finally {
        state.done++;
        setFolProg(`@${acc.username} done`, state.done, total);
      }
    }, { concurrency: 1 });

    bulkRunning = false;
    $('btn-fol-run').disabled = false;
    if ($('btn-fol-links')) $('btn-fol-links').disabled = false;
    $('btn-fol-load').disabled = false;
    $('btn-fol-stop').disabled = true;
    $('fol-run-status').textContent = `Done — ${state.done}/${total} accounts · ${state.totalNew} ${exportLinksMode ? 'links' : 'files'}${bulkStop ? ' (stopped)' : ''}`;
    setFolProg('Finished', state.done, total);
    setFooter(`Bulk done: ${state.totalNew} files from ${state.done} accounts`, 'ok');
    $('fol-list-section').classList.remove('hidden');
    updateFolCounts();
  }

  /* ── Log row helpers ────────────────────────────────────────────────────── */
  function addLogRow(acc, icon, stat) {
    const d = document.createElement('div');
    d.className = 'log-row';
    d.innerHTML = `
      <img class="log-avatar" src="${esc(acc.profilePic)}" alt="" onerror="this.style.visibility='hidden'">
      <span class="log-name">@${esc(acc.username)}</span>
      <span class="log-stat" data-role="stat">${esc(stat)}</span>
      <span class="log-badge" data-role="badge">${svgIcon(icon)}</span>`;
    $('fol-run-log').prepend(d);
    return d;
  }
  function updateLogRow(row, icon, stat) {
    const s = row.querySelector('[data-role="stat"]');
    const b = row.querySelector('[data-role="badge"]');
    if (s) s.textContent = stat;
    if (b) b.innerHTML = svgIcon(icon);
  }
  function setFolItemStatus(row, state, icon) {
    const badge = row.querySelector('[data-role="status"]');
    if (!badge) return;
    badge.className = `fol-status fol-s-${state}`;
    badge.innerHTML = svgIcon(icon);
    badge.setAttribute('aria-label', state);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DOWNLOADS — foldered via the service worker (chrome.downloads is the only
     API that writes subfolders like InstaScrap/<user>/). The legacy in-page
     anchor save is kept as an automatic fallback: it can only land flat in
     the Downloads root, but a flat file beats no file.
     ═══════════════════════════════════════════════════════════════════════════ */
  async function fetchMediaBlob(url) {
    // CDN 403 often due to missing Referer/Origin; Instagram CDN checks referer
    const resp = await fetch(url, {
      signal: abortCtl?.signal,
      credentials: 'omit',
      headers: { 'Referer': 'https://www.instagram.com/', 'Accept': '*/*' },
    });
    if (!resp.ok) {
      // July 30 2026: image 403 can also mean URL expired (IG CDN URLs expire ~hours)
      if (resp.status === 403) throw new Error(`HTTP 403 — CDN URL expired or blocked (re-fetch posts to get fresh URLs)`);
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.blob();
  }
  function anchorSaveBlob(blob, basename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = basename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 500);
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('could not read file for upload'));
        fr.readAsDataURL(blob);
      } catch (err) { reject(err); }
    });
  }
  /** Save an in-memory blob to Downloads/<filename> (folders allowed). */
  async function swSaveBlob(blob, filename) {
    const dataUrl = await blobToDataURL(blob);
    const semi = dataUrl.indexOf(';');
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, semi);
    const base64 = dataUrl.slice(comma + 1);
    const id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    const CHUNK = 1000000;
    const total = Math.max(1, Math.ceil(base64.length / CHUNK));
    const start = await swCall({ action: 'downloadDataStart', id, filename, mime, total });
    if (!start.ok) throw new Error(start.error || 'upload rejected');
    for (let i = 0; i < total; i++) {
      const r = await swCall({ action: 'downloadDataChunk', id, index: i, chunk: base64.slice(i * CHUNK, (i + 1) * CHUNK) });
      if (!r.ok) throw new Error(r.error || `upload chunk ${i} rejected`);
    }
    const done = await swCall({ action: 'downloadDataEnd', id });
    if (!done.ok) throw new Error(done.error || 'download failed');
    return done.dlId;
  }
  /**
   * Download one CDN file to Downloads/<filename>.
   * Returns 'sw' when the foldered save worked, 'anchor' when the legacy
   * flat save was used instead. Throws only when aborted or both fail.
   */
  async function dlFile(url, filename) {
    await dlBucket.take();
    try {
      const resp = await swCall({ action: 'downloadFile', url, filename });
      if (!resp.ok) throw new Error(resp.error || 'download failed');
      return 'sw';
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      console.warn('[InstaScrap] foldered download failed, saving flat instead:', err);
      const blob = await fetchMediaBlob(url);
      anchorSaveBlob(blob, filename.split('/').pop());
      return 'anchor';
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HISTORY
     ═══════════════════════════════════════════════════════════════════════════ */
  async function loadHistory(username) {
    const key  = `hist_${username.toLowerCase()}`;
    const data = await chrome.storage.local.get(key);
    return new Set(data[key] || []);
  }
  async function saveHistory(username, ids) {
    const key  = `hist_${username.toLowerCase()}`;
    const prev = await loadHistory(username);
    for (const id of ids) prev.add(id);
    await chrome.storage.local.set({ [key]: [...prev] });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     UI HELPERS
     ═══════════════════════════════════════════════════════════════════════════ */
  async function fetchProfileMetaFallback(username) {
    try {
      const html = await fetchProfileHtml(username);
      const ogDesc = html.match(/property="og:description"[^>]*content="([^"]+)"/)?.[1] || '';
      const ogImg  = html.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1] || '';
      const title  = html.match(/<title>([^<]+)<\/title>/)?.[1]?.split('(')[0]?.trim() || username;
      // og:description like "4M Followers, 242 Following, 215 Posts - See..."
      let followers = 0, posts = 0;
      const m1 = ogDesc.match(/([\d,.KM]+)\s+Followers/);
      const m2 = ogDesc.match(/([\d,.KM]+)\s+Posts/);
      if (m1) followers = parseShorthand(m1[1]);
      if (m2) posts = parseShorthand(m2[1]);
      return { title, ogDesc, ogImg, followers, posts };
    } catch { return null; }
  }
  // HTML image fallback — extracts photos/albums directly from profile HTML without API.
  // Guarantees heroine_kr-style public accounts still return image posts when API is HTML-walled.
  async function htmlImageFallback(username, opts) {
    const html = await fetchProfileHtml(username);
    // Try to parse embedded JSON (Polaris/xdt_api payload) for richer data first
    const posts = [];
    const seenCode = new Set();
    // Pattern 1: xdt_api__v1__feed__user_timeline_graphql_connection edges contain shortcode + display_url
    // We brute-force extract shortcode→display_url pairs from the giant inline JSON.
    const codeRe = /"code"\s*:\s*"([A-Za-z0-9_-]{5,30})"/g;
    let m;
    const codes = [];
    while ((m = codeRe.exec(html)) !== null) {
      if (!seenCode.has(m[1])) { seenCode.add(m[1]); codes.push(m[1]); }
      if (codes.length > (opts.maxCount || 100) * 2) break;
    }
    // Also extract all scontent image URLs and marry to codes by proximity (best-effort)
    // For heroine_kr we need at least 12 image URLs even if code pairing imperfect.
    const urlRe = /"display_url"\s*:\s*"([^"]+)"/g;
    const urls = [];
    while ((m = urlRe.exec(html)) !== null) urls.push(m[1].replace(/\\u0026/g,'&').replace(/\\/g,''));
    // If we have both, interleave; otherwise fall back to raw scontent URLs
    if (!urls.length) {
      const rawRe = /https:\/\/scontent[^"'\s\\]*\.jpg[^"'\s\\]*/g;
      let rm;
      while ((rm = rawRe.exec(html)) !== null) {
        let u = rm[0].replace(/\\u0026/g,'&').replace(/&amp;/g,'&').replace(/\\/g,'');
        // keep high-res variants only (skip s150x150 tiny thumbs)
        if (u.includes('s150x150') || u.includes('s100x100')) continue;
        if (!urls.includes(u)) urls.push(u);
      }
    }
    const max = Math.min(opts.maxCount || 100, Math.max(codes.length, urls.length, 12));
    // Build synthetic photo posts — prioritize code↔url pairs
    for (let i = 0; i < max; i++) {
      if (stopFetch || bulkStop) break;
      const code = codes[i] || `html_${i}`;
      const url = urls[i] || urls[i % urls.length] || null;
      if (!url) continue;
      // Filter carousel if needed — without media_type we treat groups of 3 close URLs as album hints
      // For fallback we emit as photo (downloadable); album detection would need carousel_media JSON
      const dateStr = new Date().toISOString().slice(0,10);
      const filename = `${username}_${dateStr}_${code}.jpg`;
      const type = 'photo';
      if (type === 'photo' && !opts.wantPhotos && !opts.wantCarousels) continue;
      posts.push({
        id: `html_${code}_${i}`,
        type, username, timestamp: Math.floor(Date.now()/1000) - i*3600, date: dateStr,
        permalink: `https://www.instagram.com/p/${code}/`,
        medias: [{ url: url.replace(/&amp;/g,'&'), filename }],
        protected: false, protectedReason: null,
      });
      if (posts.length >= (opts.maxCount || 100)) break;
    }
    // Deduplicate by URL
    const byUrl = new Map();
    posts.forEach(p => { const u=p.medias[0]?.url; if (u && !byUrl.has(u)) byUrl.set(u,p); });
    const deduped = [...byUrl.values()];
    // If HTML JSON yielded nothing but DOM grid is visible on page, harvest grid as last resort
    if (!deduped.length) {
      try {
        const domPosts = domGridImageFallback(username, opts);
        if (domPosts.length) return domPosts;
      } catch {}
    }
    return deduped;
  }
  // DOM grid scraper — works even when every /api/v1/* is HTML-walled.
  // Requires user to be ON the profile page so <main> grid is rendered. No network needed.
  function domGridImageFallback(username, opts) {
    const max = opts.maxCount || 100;
    const posts = [];
    const seen = new Set();
    // Pass 1: anchor based (most reliable — has /p/<code>)
    const anchors = document.querySelectorAll(`a[href*="/p/"], a[href*="/reel/"]`);
    for (const a of anchors) {
      if (posts.length >= max) break;
      const href = a.getAttribute('href') || '';
      const codeMatch = href.match(/\/p\/([^\/]+)\/?/) || href.match(/\/reel\/([^\/]+)\/?/);
      const code = codeMatch ? codeMatch[1] : `dom_${posts.length}`;
      if (seen.has(code)) continue;
      const img = a.querySelector('img[src*="scontent"], img[srcset]');
      let url = img?.src || null;
      if (img?.srcset) {
        const parts = img.srcset.split(',').map(s=>s.trim().split(' ')[0]);
        if (parts.length) url = parts[parts.length-1];
      }
      if (!url) continue;
      if (url.includes('s150x150') || url.includes('s100x100') || url.includes('profile_pic')) continue;
      url = url.replace(/\/s640x640\//, '/s1080x1080/').replace(/\/p640x640\//,'/p1080x1080/');
      seen.add(code);
      const dateStr = new Date().toISOString().slice(0,10);
      posts.push({
        id: `dom_${code}`, type: 'photo', username, timestamp: Math.floor(Date.now()/1000)-posts.length*3600, date: dateStr,
        permalink: `https://www.instagram.com/p/${code}/`,
        medias: [{ url, filename: `${username}_${dateStr}_${code}.jpg` }],
        protected: false, protectedReason: null,
      });
    }
    // Pass 2: if still 0 (Instagram changed markup), brute force all scontent imgs in <main>
    if (!posts.length) {
      const imgs = document.querySelectorAll('main img[src*="scontent"], article img[src*="scontent"]');
      for (const img of imgs) {
        if (posts.length >= max) break;
        let url = img.src || (img.srcset ? img.srcset.split(',').pop().trim().split(' ')[0] : null);
        if (!url || url.includes('s150x150') || url.includes('s100x100') || url.includes('profile_pic')) continue;
        url = url.replace(/\/s640x640\//, '/s1080x1080/').replace(/\/p640x640\//,'/p1080x1080/');
        if (seen.has(url)) continue;
        seen.add(url);
        const code = `domimg_${posts.length}`;
        const dateStr = new Date().toISOString().slice(0,10);
        posts.push({
          id: code, type: 'photo', username, timestamp: Math.floor(Date.now()/1000)-posts.length*3600, date: dateStr,
          permalink: `https://www.instagram.com/${username}/`,
          medias: [{ url, filename: `${username}_${dateStr}_${code}.jpg` }],
          protected: false, protectedReason: null,
        });
      }
    }
    return posts;
  }
  function parseShorthand(s) {
    s = s.replace(/,/g, '').trim();
    if (s.endsWith('M')) return Math.round(parseFloat(s.slice(0,-1))*1_000_000);
    if (s.endsWith('K')) return Math.round(parseFloat(s.slice(0,-1))*1_000);
    return parseInt(s,10) || 0;
  }
  function showUserCard(u) {
    $('user-avatar').src               = u.profilePic || '';
    $('user-fullname').textContent     = u.fullName || u.username;
    $('user-handle').textContent       = '@' + u.username;
    $('user-stats').textContent        = `${fmtNum(u.mediaCount)} posts · ${fmtNum(u.followCount)} followers`;
    $('user-card').classList.remove('hidden');
  }

  function resetResults() {
    fetchedPosts = []; cnt.reel = cnt.photo = cnt.album = cnt.files = 0;
    $('results-section').classList.add('hidden');
    $('user-card').classList.add('hidden');
    $('dl-progress').classList.add('hidden');
    ['cnt-reels','cnt-photos','cnt-albums','cnt-files'].forEach(id => $(id).textContent = '0');
  }

  function incrCounts(post) {
    cnt[post.type]++; cnt.files += post.medias.length;
    $('cnt-reels').textContent  = cnt.reel;
    $('cnt-photos').textContent = cnt.photo;
    $('cnt-albums').textContent = cnt.album;
    $('cnt-files').textContent  = cnt.files;
    $('results-count').textContent = countLabel(fetchedPosts.length);
    $('results-section').classList.remove('hidden');
  }

  function showHistBar() {
    const newCount  = fetchedPosts.filter(p => !dlHistory.has(p.id)).length;
    const seenCount = fetchedPosts.length - newCount;
    if (!seenCount) { $('hist-bar').classList.add('hidden'); $('btn-clear-hist').classList.add('hidden'); return; }
    $('hist-new').textContent  = `${newCount} new`;
    $('hist-seen').textContent = `${seenCount} already downloaded`;
    $('hist-bar').classList.remove('hidden');
    $('btn-clear-hist').classList.remove('hidden');
  }

  function refreshDlBtn() {
    const skip  = $('chk-skip').checked;
    const isZip = $('chk-zip').checked;
    const posts = skip ? fetchedPosts.filter(p => !dlHistory.has(p.id)) : fetchedPosts;
    const nf    = posts.reduce((s, p) => s + p.medias.length, 0);
    $('btn-download').disabled = !posts.length;
    
    const plural = posts.length === 1 ? '' : 's';
    if (!posts.length) {
      $('txt-download').textContent = 'Nothing new to download';
    } else if (isZip) {
      $('txt-download').textContent = `Save ${nf} file${nf === 1 ? '' : 's'} as ZIP`;
    } else {
      $('txt-download').textContent = `Download ${nf} file${nf === 1 ? '' : 's'}`;
    }
  }

  function setFetchLoading(on) {
    $('btn-fetch').classList.toggle('loading', on);
    setIcon($('ico-fetch'), on ? 'spinner' : 'search');
    $('txt-fetch').textContent = on ? 'Scanning — click to stop' : 'Fetch posts';
  }

  function setScan(label, count) {
    $('scan-label').textContent = label;
    $('scan-count').textContent = count + ' posts';
  }

  function setDlProg(label, done, total) {
    setDataLabel($('dl-label'), label);
    $('dl-count').textContent = `${done} / ${total}`;
    $('dl-bar').style.width   = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
  }

  function setFolProg(label, done, total) {
    setDataLabel($('fol-run-label'), label);
    $('fol-run-count').textContent = `${done} / ${total}`;
    $('fol-run-bar').style.width   = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
  }

  /** Labels carrying a filename or @handle render as data, not as capitals. */
  function setDataLabel(el, text) {
    el.textContent = text;
    el.classList.toggle('is-data', /@|[\w-]+\.(jpg|mp4|png|webp|zip)\b/i.test(text));
  }

  function setFooter(msg, cls) {
    $('footer-msg').textContent = msg;
    $('footer-msg').className   = 'footer-msg' + (cls ? ' fm-' + cls : '');
  }

  /* ── Utils ──────────────────────────────────────────────────────────────── */
  function fmtNum(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  /** "1 post found" / "24 posts found" — the count reads first, always. */
  function countLabel(n) {
    return `${n} post${n === 1 ? '' : 's'} found`;
  }
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Retry wrappers — share the global gate, honor Retry-After ──────────── */
  const MAX_RETRY_WAIT = 120000;
  async function apiGetRetry(path, onCooldown, kind = 'api') {
    return fetchRetry('GET', path, null, onCooldown, kind);
  }
  async function fetchRetry(method, path, params, onCooldown, kind = 'api') {
    for (let attempt = 0; attempt < 4; attempt++) {
      await igGate.take();
      try {
        const json = await igRequest({ path, method, params, kind });
        consec429 = 0; last429At = 0;
        return json;
      } catch (err) {
        const code = err.code || '';
        if (code === 'NETWORK' || code === 'TIMEOUT') {
          if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
          throw err;
        }
        if (code === 'IG_RATE_LIMITED') {
          last429At = performance.now();
          consec429++;
          const retryAfter = err.retryAfter || [10000, 20000, 40000, 90000][attempt] || 90000;
          const waitMs = Math.min(retryAfter * 1000, MAX_RETRY_WAIT);
          if (consec429 >= 2) {
            igGate.penalize(60000);
            throw new Error('IG_RATE_LIMITED: Session flagged (429 twice) - log out and back in, or wait ~10 minutes.');
          }
          igGate.penalize(waitMs + Math.random() * 2000);
          if (attempt < 3) {
            onCooldown?.(Math.round(waitMs / 1000));
            await sleep(waitMs + Math.random() * 2000);
            continue;
          }
          throw new Error('IG_RATE_LIMITED: Instagram is rate limiting you - wait a few minutes and retry.');
        }
        // AUTH / IG_REQUIRE_LOGIN / IG_AUTH_HTTP / IG_HTML_WALL / SCHEMA /
        // CURSOR / OWNER / HTTP are terminal - surface them with their code so
        // the caller's fallback chain can decide what to try next.
        throw err;
      }
    }
    throw new Error('Request failed after 4 attempts');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKER HEALTH — ping once at boot so the footer names a dead worker
     immediately instead of failing later inside a fetch or fallback.
     ═══════════════════════════════════════════════════════════════════════════ */
  (function checkWorker() {
    let done = false;
    const ok = msg => { if (!done) { done = true; setFooter(msg, 'ok'); } };
    try {
      chrome.runtime.sendMessage({ action: 'ping' }, resp => {
        if (chrome.runtime.lastError || !resp) return; // swCall will explain on first real use
        if (resp.apiError) {
          done = true;
          setFooter(`Background worker is damaged: ${resp.apiError} — reload the extension.`, 'err');
        } else if (!/Restored/.test($('footer-msg').textContent || '')) {
          ok('Ready — background worker is reachable.');
        }
      });
    } catch {}
    // If even the send throws (orphaned panel), say so right away.
    setTimeout(() => {
      if (!done && /Ready/.test($('footer-msg').textContent || '')) {
        try {
          chrome.runtime.sendMessage({ action: 'ping' }, resp => {
            if (chrome.runtime.lastError || !resp) {
              done = true;
              setFooter('Background worker is unreachable — reload this Instagram tab.', 'err');
            }
          });
        } catch {
          done = true;
          setFooter('Panel lost contact with the extension — reload this Instagram tab.', 'err');
        }
      }
    }, 1500);
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     SESSION RESTORE
     ═══════════════════════════════════════════════════════════════════════════ */
  chrome.storage.session.get(['is_posts','is_user','is_counts','is_tab','is_followings'])
    .then(data => {
      if (data.is_posts?.length && data.is_user) {
        fetchedPosts = data.is_posts; currentUser = data.is_user;
        Object.assign(cnt, data.is_counts || {});
        $('inp-username').value = currentUser.username;
        showUserCard(currentUser);
        $('cnt-reels').textContent  = cnt.reel;
        $('cnt-photos').textContent = cnt.photo;
        $('cnt-albums').textContent = cnt.album;
        $('cnt-files').textContent  = cnt.files;
        $('results-count').textContent = countLabel(fetchedPosts.length);
        $('results-section').classList.remove('hidden');
        loadHistory(currentUser.username).then(h => { dlHistory = h; showHistBar(); refreshDlBtn(); });
        setFooter(`Restored your last scan of ${fetchedPosts.length} posts`, 'ok');
      }
      if (data.is_followings?.length) {
        followings = data.is_followings;
        renderFolList();
        $('txt-fol-load').textContent = `Reload (${followings.length} followings)`;
      }
      if (data.is_tab) switchTab(data.is_tab);
    }).catch(() => {});

  /* ═══════════════════════════════════════════════════════════════════════════
     EXPORT  — copy / save results to file
     ═══════════════════════════════════════════════════════════════════════════ */
  function bindDisclosure(btnId, bodyId, iconId) {
    const btn = $(btnId), body = $(bodyId), icon = $(iconId);
    if (!btn || !body) return;
    btn.addEventListener('click', () => {
      const open = body.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', String(open));
      if (icon) icon.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
    });
  }
  bindDisclosure('exp-toggle', 'exp-body', 'exp-chevron');
  // Settings tab has its own console-API toggle (ids suffixed -set)
  bindDisclosure('exp-toggle-set', 'exp-body-set', 'exp-chevron-set');

  $('btn-copy-exp').addEventListener('click', () => exportAction('copy'));
  $('btn-save-exp').addEventListener('click', () => exportAction('save'));
  function bindCopyApi(btnId) {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText("postMessage({__instascrap:'query'},'*')").catch(() => {});
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.style.color = 'var(--ok)';
      setTimeout(() => { btn.textContent = prev; btn.style.color = ''; }, 1500);
    });
  }
  bindCopyApi('btn-copy-api');
  bindCopyApi('btn-copy-api-set');

  function getExportFmt() {
    if ($('fmt-csv').checked)  return 'csv';
    if ($('fmt-json').checked) return 'json';
    return 'urls';
  }

  function buildExportContent(fmt) {
    if (!fetchedPosts.length) return { text: '', ext: 'txt', mime: 'text/plain' };
    const posts = fetchedPosts;
    if (fmt === 'urls') {
      const urls = posts.flatMap(p => p.medias.map(m => m.url));
      return { text: urls.join('\n'), ext: 'txt', mime: 'text/plain' };
    }
    if (fmt === 'csv') {
      const rows = [['id','type','username','date','url','filename']];
      posts.forEach(p => p.medias.forEach(m => rows.push([p.id, p.type, p.username, p.date, m.url, m.filename])));
      const text = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
      return { text, ext: 'csv', mime: 'text/csv' };
    }
    // json
    const data = posts.map(p => ({ id: p.id, type: p.type, username: p.username, date: p.date, urls: p.medias.map(m => m.url), filenames: p.medias.map(m => m.filename) }));
    return { text: JSON.stringify({ user: currentUser?.username, count: posts.length, posts: data }, null, 2), ext: 'json', mime: 'application/json' };
  }

  async function exportAction(mode) {
    const fmt = getExportFmt();
    const { text, ext, mime } = buildExportContent(fmt);
    if (!text) { setFooter('Nothing to export — fetch posts first.', 'warn'); return; }
    if (mode === 'copy') {
      navigator.clipboard.writeText(text)
        .then(() => setFooter(`Copied ${fmt === 'urls' ? fetchedPosts.reduce((s,p)=>s+p.medias.length,0) : fetchedPosts.length} items to the clipboard`, 'ok'))
        .catch(() => setFooter('Clipboard write failed.', 'err'));
    } else {
      const uname = currentUser?.username || 'export';
      const fname = `instascrap_${uname}_${new Date().toISOString().slice(0,10)}.${ext}`;
      const blob  = new Blob([text], { type: mime });
      const exportPath = `InstaScrap/${uname}/${fname}`;
      try {
        await swSaveBlob(blob, exportPath);
        setFooter(`Saved Downloads/${exportPath}`, 'ok');
      } catch (err) {
        console.warn('[InstaScrap] foldered export save failed, saving flat instead:', err);
        anchorSaveBlob(blob, fname);
        setFooter(`Saved ${fname} flat to Downloads/ (foldered save failed)`, 'warn');
      }
    }
  }

  $('btn-push-app').addEventListener('click', async () => {
    if (!fetchedPosts.length) { setFooter('Nothing to push — fetch posts first.', 'warn'); return; }
    
    // Prepare payload
    const payload = {
      user: currentUser?.username,
      count: fetchedPosts.length,
      timestamp: new Date().toISOString(),
      posts: fetchedPosts.map(p => ({
        id: p.id,
        type: p.type,
        username: p.username,
        date: p.date,
        urls: p.medias.map(m => m.url),
        filenames: p.medias.map(m => m.filename)
      }))
    };

    const b = $('btn-push-app');
    const oldText = b.textContent;
    b.textContent = 'Sending…';
    b.disabled = true;

    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'pushToApp', payload }, resolve);
      });

      if (resp && resp.ok) {
        setFooter(`Sent ${payload.count} posts to the bridge server.`, 'ok');
        b.textContent = 'Sent';
      } else {
        throw new Error(resp?.error || 'the server did not respond');
      }
    } catch (err) {
      console.error('[InstaScrap Bridge Error]', err);
      setFooter(`Bridge server did not accept the data (${err.message}). Start bridge_server.py and try again.`, 'err');
      b.textContent = 'Failed';
    } finally {
      setTimeout(() => {
        b.textContent = oldText;
        b.disabled = false;
      }, 2000);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     Bridge Polling 
     ═══════════════════════════════════════════════════════════════════════════ */
  let isPollingBridge = false;
  
  async function pollBridge() {
    if (!$('chk-sync').checked || isPollingBridge) {
      setTimeout(pollBridge, 2000);
      return;
    }
    
    isPollingBridge = true;
    try {
      const resp = await new Promise(r => chrome.runtime.sendMessage({ action: 'pollBridge' }, r));
      if (resp && resp.ok && resp.data && resp.data.command) {
        handleBridgeCommand(resp.data.command);
      }
    } catch (err) {
      console.warn('[InstaScrap] Bridge polling error:', err);
    }
    isPollingBridge = false;
    setTimeout(pollBridge, 2000);
  }
  
  function handleBridgeCommand(cmd) {
    if (!cmd || !cmd.action) return;
    console.log('[InstaScrap] Received command from bridge:', cmd);
    
    switch (cmd.action) {
      case 'scan':
        switchTab('single');
        if (cmd.username) $('inp-username').value = cmd.username;
        if (cmd.max) $('inp-max').value = cmd.max;
        onFetch();
        break;
      case 'download':
        if (!$('btn-download').disabled) onDownload();
        break;
      case 'push':
        if (!$('btn-push-app').disabled) $('btn-push-app').click();
        break;
    }
  }

  // Start polling loop
  setTimeout(pollBridge, 1000);

  /* ═══════════════════════════════════════════════════════════════════════════
     postMessage REST API  — queryable from browser console / userscripts
     ═══════════════════════════════════════════════════════════════════════════
     Usage (browser console on instagram.com):
       window.postMessage({ __instascrap: 'query' }, '*')
       window.addEventListener('message', e => {
         if (e.data?.__instascrap_response) console.log(e.data)
       })
     ═══════════════════════════════════════════════════════════════════════════ */
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const cmd = e.data?.__instascrap;
    if (!cmd) return;

    if (cmd === 'query' || cmd === 'getResults') {
      window.postMessage({
        __instascrap_response: 'results',
        user: currentUser?.username ?? null,
        count: fetchedPosts.length,
        posts: fetchedPosts.map(p => ({
          id: p.id, type: p.type, username: p.username, date: p.date,
          urls: p.medias.map(m => m.url),
          filenames: p.medias.map(m => m.filename),
        })),
      }, '*');
    }

    if (cmd === 'getFollowings') {
      window.postMessage({
        __instascrap_response: 'followings',
        count: followings.length,
        followings,
      }, '*');
    }

    if (cmd === 'getHistory') {
      const username = e.data.username;
      if (username) {
        loadHistory(username).then(hist =>
          window.postMessage({ __instascrap_response: 'history', username, count: hist.size, ids: [...hist] }, '*')
        );
      }
    }

    if (cmd === 'help') {
      window.postMessage({ __instascrap_response: 'help', commands: ['query','getResults','getFollowings','getHistory (+ username)','help'] }, '*');
    }
  });

  $('btn-clear-all-hist').addEventListener('click', onClearAllHist);
  $('btn-clear-all-quick').addEventListener('click', onClearAllHist);
  $('chk-zip').addEventListener('change', refreshDlBtn);
  $('chk-zip').addEventListener('change', updateFolCounts);

  async function onClearAllHist() {
    try {
      if (!confirm('This will delete the download history for ALL accounts. Continue?')) return;
      const data = await chrome.storage.local.get(null);
      const keys = Object.keys(data).filter(k => k.startsWith('hist_'));
      console.log('[InstaScrap] Clearing history keys:', keys);
      if (keys.length) {
        await chrome.storage.local.remove(keys);
      }
      dlHistory = new Set();
      $('hist-bar').classList.add('hidden');
      $('btn-clear-hist').classList.add('hidden');
      refreshDlBtn();
      setFooter(`Global history cleared (${keys.length} accounts)`, 'ok');
    } catch (err) {
      console.error('[InstaScrap] Failed to clear history:', err);
      setFooter('Failed to clear history: ' + err.message, 'err');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SETTINGS PERSISTENCE
     ═══════════════════════════════════════════════════════════════════════════ */
  function saveSettings() {
    const settings = {
      zip:  $('chk-zip').checked,
      skip: $('chk-skip').checked,
      sync: $('chk-sync').checked,
    };
    chrome.storage.local.set({ is_settings: settings }).catch(() => {});
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get('is_settings');
    const s = data.is_settings;
    if (s) {
      if (s.zip  !== undefined) $('chk-zip').checked  = s.zip;
      if (s.skip !== undefined) $('chk-skip').checked = s.skip;
      if (s.sync !== undefined) $('chk-sync').checked = s.sync;
      refreshDlBtn();
      updateFolCounts();
    }
  }

  $('chk-zip').addEventListener('change', saveSettings);
  $('chk-skip').addEventListener('change', saveSettings);
  $('chk-sync').addEventListener('change', saveSettings);

  // Initialize
  loadSettings().catch(() => {});

} // end _isInit


/* ═══════════════════════════════════════════════════════════════════════════
   CSS  (injected into shadow DOM — fully isolated from Instagram's styles)
   ═══════════════════════════════════════════════════════════════════════════ */
function IS_CSS() { return `
/* ═══════════════════════════════════════════════════════════════════════════
   InstaScrap — "Contact Sheet"
   A darkroom instrument panel for archiving a creator's published work.
   Warm graphite, one amber safelight accent, stencilled condensed labels,
   mono for every quantity. No gradients, no glass, no emoji.
   ═══════════════════════════════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

:host {
  --ink:        #16130F;
  --slate:      #1F1B16;
  --card:       #26211A;
  --card-hi:    #2E2820;
  --rule:       #332C23;
  --rule-hi:    #453C30;
  --paper:      #EFE7D9;
  --dim:        #8C8175;
  --faint:      #5C5347;
  --safelight:  #E8873C;
  --safelight-d:#B85F1E;
  --ok:         #7FA66B;
  --warn:       #D9A441;
  --err:        #C4614C;

  --sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --cond: 'Barlow Condensed', 'Arial Narrow', 'Oswald', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--rule-hi); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--faint); }

/* ── Panel shell ─────────────────────────────────────────────────────────── */
.is-panel {
  pointer-events: all;
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 404px;
  max-height: calc(100vh - 40px);
  background: #1F1B16;
  background: var(--slate, #1F1B16);
  border: 1px solid var(--rule);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.62), 0 2px 8px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.45;
  color: var(--paper);
  overflow: hidden;
  animation: panelIn 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes panelIn {
  from { opacity: 0; transform: translateY(14px) scale(0.985); }
  to   { opacity: 1; transform: none; }
}
.is-panel.is-hidden { display: none !important; }

/* ── Header ──────────────────────────────────────────────────────────────── */
.is-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 9px;
  background: var(--ink);
  cursor: grab; flex-shrink: 0; user-select: none;
}
.is-header:active { cursor: grabbing; }
/* film-rebate perforations under the header */
.is-header::after {
  content: ""; display: block; position: absolute; left: 0; right: 0; top: 100%;
  height: 4px;
  background-image: radial-gradient(circle, var(--ink) 1.5px, transparent 1.6px);
  background-size: 9px 4px; background-repeat: repeat-x;
  pointer-events: none;
}
.is-brand { display: flex; align-items: baseline; gap: 8px; }
.is-logo-img {
  width: 20px; height: 20px; border-radius: 4px;
  align-self: center; opacity: 0.9;
}
.is-title {
  font-family: var(--cond);
  font-size: 19px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; line-height: 1; color: var(--paper);
}
.is-subtitle {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--faint); align-self: center;
}
.is-header-btns { display: flex; gap: 3px; }
.is-hbtn {
  width: 24px; height: 24px; border: 1px solid transparent; background: none;
  border-radius: 5px; color: var(--faint); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.14s, color 0.14s, border-color 0.14s;
}
.is-hbtn:hover { background: var(--card); color: var(--paper); border-color: var(--rule-hi); }
.is-hbtn svg { width: 13px; height: 13px; }

/* ── Tabs ────────────────────────────────────────────────────────────────── */
.is-tabs {
  display: flex;
  background: var(--ink);
  border-bottom: 1px solid var(--rule);
  flex-shrink: 0;
}
.is-tab {
  flex: 1; padding: 9px 8px 8px; background: none; border: none;
  border-right: 1px solid var(--rule);
  color: var(--faint); font-family: var(--cond);
  font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  cursor: pointer; transition: color 0.14s, background 0.14s;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.is-tab:last-child { border-right: none; }
.is-tab svg { width: 13px; height: 13px; }
.is-tab:hover { color: var(--dim); background: var(--card); }
.is-tab.active {
  color: var(--safelight);
  background: var(--slate);
  box-shadow: inset 0 -2px 0 var(--safelight);
}

/* ── Scrollable body ─────────────────────────────────────────────────────── */
.is-body {
  flex: 1; overflow-y: auto; padding: 14px;
  display: flex; flex-direction: column; gap: 13px;
  scrollbar-width: thin; scrollbar-color: var(--rule-hi) transparent;
}
#sec-single, #sec-fol, #sec-set { display: flex; flex-direction: column; gap: 13px; }
.sec-intro { font-size: 11.5px; color: var(--dim); }

/* ── Footer ──────────────────────────────────────────────────────────────── */
.is-footer {
  padding: 0 12px; border-top: 1px solid var(--rule);
  min-height: 30px; flex-shrink: 0; display: flex; align-items: center;
  background: var(--ink);
}
.footer-msg {
  font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  width: 100%;
}
.footer-msg.fm-ok   { color: var(--ok); }
.footer-msg.fm-err  { color: var(--err); }
.footer-msg.fm-warn { color: var(--warn); }

/* ── FAB ─────────────────────────────────────────────────────────────────── */
.is-fab {
  pointer-events: all; position: fixed; bottom: 20px; right: 20px;
  width: 46px; height: 46px; border-radius: 11px;
  background: var(--card); border: 1px solid var(--rule-hi);
  cursor: pointer; padding: 0;
  box-shadow: 0 8px 26px rgba(0,0,0,0.55);
  transition: transform 0.18s, border-color 0.18s, background 0.18s;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.is-fab:hover { transform: translateY(-2px); border-color: var(--safelight-d); background: var(--card-hi); }
.is-fab img { width: 26px; height: 26px; border-radius: 4px; }
.is-hidden { display: none !important; }

/* ── Form ────────────────────────────────────────────────────────────────── */
.field-group { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
.field-label {
  font-family: var(--cond);
  font-size: 11px; font-weight: 600; color: var(--faint);
  text-transform: uppercase; letter-spacing: 0.11em; line-height: 1;
}
.field-row { display: flex; gap: 9px; }

.input-pill {
  display: flex; align-items: stretch;
  background: var(--ink); border: 1px solid var(--rule);
  border-radius: 7px; overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.input-pill:focus-within {
  border-color: var(--safelight-d);
  box-shadow: 0 0 0 3px rgba(232,135,60,0.13);
}
.pill-pre, .pill-suf {
  display: flex; align-items: center; padding: 0 9px;
  font-family: var(--mono); font-size: 11px; color: var(--faint);
  background: var(--card); user-select: none; flex-shrink: 0; white-space: nowrap;
}
.pill-pre { border-right: 1px solid var(--rule); }
.pill-suf { border-left: 1px solid var(--rule); font-size: 10px; }

/* ── Username row: input + "use open profile" ────────────────────────────── */
.username-row { display: flex; gap: 6px; align-items: stretch; }
.username-row .input-pill { flex: 1; min-width: 0; }
.use-tab-btn {
  flex-shrink: 0; width: 36px;
  display: flex; align-items: center; justify-content: center;
  background: var(--ink); border: 1px solid var(--rule); border-radius: 7px;
  color: var(--faint); cursor: pointer;
  transition: color 0.14s, border-color 0.14s, background 0.14s;
}
.use-tab-btn svg { width: 15px; height: 15px; }
.use-tab-btn:hover { color: var(--safelight); border-color: var(--safelight-d); background: var(--card); }

input[type="text"], input[type="number"] {
  flex: 1; min-width: 0; background: transparent; border: none; outline: none;
  color: var(--paper); font-family: var(--mono); font-size: 12.5px; padding: 8px 10px;
}
input[type="number"] { text-align: right; }
input::placeholder { color: var(--faint); }

.date-full {
  width: 100%; background: var(--ink); border: 1px solid var(--rule);
  border-radius: 7px; padding: 7px 9px; color: var(--paper);
  font-family: var(--mono); font-size: 11.5px; outline: none; cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.date-full:focus { border-color: var(--safelight-d); box-shadow: 0 0 0 3px rgba(232,135,60,0.13); }
.date-full::-webkit-calendar-picker-indicator { filter: invert(0.55) sepia(0.3); cursor: pointer; }

/* ── Media-type chips ────────────────────────────────────────────────────── */
.toggle-group { display: flex; gap: 6px; }
.toggle-chip {
  position: relative;
  display: flex; align-items: center; gap: 6px; flex: 1;
  justify-content: center; padding: 7px 8px;
  background: var(--ink); border: 1px solid var(--rule); border-radius: 7px;
  cursor: pointer; font-family: var(--cond);
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--dim); transition: all 0.14s; user-select: none;
}
.toggle-chip input[type="checkbox"] {
  position: absolute; opacity: 0; width: 100%; height: 100%;
  left: 0; top: 0; margin: 0; cursor: pointer;
}
.toggle-chip svg { width: 13px; height: 13px; flex-shrink: 0; }
.toggle-chip:hover { border-color: var(--rule-hi); color: var(--paper); }
.toggle-chip:has(input:checked) {
  background: rgba(232,135,60,0.09);
  border-color: var(--safelight-d);
  color: var(--safelight);
}
.toggle-chip:has(input:focus-visible) {
  box-shadow: 0 0 0 3px rgba(232,135,60,0.2);
}
.toggle-chip.sm { flex: none; width: 38px; padding: 7px 0; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.btn {
  width: 100%; padding: 10px 14px; border: 1px solid var(--rule-hi);
  border-radius: 7px; background: var(--card); color: var(--paper);
  font-family: var(--cond); font-size: 14px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
  flex-shrink: 0;
}
.btn svg { width: 14px; height: 14px; flex-shrink: 0; }
.btn:disabled { opacity: 0.34; cursor: not-allowed; }
.btn:not(:disabled):active { transform: translateY(1px); }

.btn-quiet { background: transparent; color: var(--dim); }
.btn-quiet:hover:not(:disabled) { background: var(--card); color: var(--paper); border-color: var(--rule-hi); }

.btn-primary {
  background: var(--safelight); border-color: var(--safelight);
  color: #1A1209;
}
.btn-primary:hover:not(:disabled) {
  background: #F09A55; border-color: #F09A55;
  box-shadow: 0 4px 16px rgba(232,135,60,0.26);
}
.btn-primary svg { stroke-width: 2.2; }

.btn.loading { position: relative; color: transparent; }
.btn.loading svg { position: absolute; color: #1A1209; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Link buttons ────────────────────────────────────────────────────────── */
.link-btn {
  background: none; border: none; padding: 0;
  color: var(--safelight); font-family: var(--mono); font-size: 10.5px;
  cursor: pointer; transition: color 0.14s;
}
.link-btn:hover { color: #F09A55; text-decoration: underline; }
.link-btn.dim { color: var(--faint); }
.link-btn.dim:hover { color: var(--err); }
.link-btn:focus-visible { outline: 2px solid var(--safelight); outline-offset: 2px; border-radius: 3px; }

/* ── Progress ────────────────────────────────────────────────────────────── */
.progress-block { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.progress-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.progress-label {
  font-family: var(--cond); font-size: 12px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase; color: var(--dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Filenames and handles are data, not labels — mono, never shouted. */
.progress-label.is-data {
  font-family: var(--mono); font-size: 10.5px; font-weight: 400;
  letter-spacing: 0; text-transform: none; color: var(--faint);
}
.progress-count {
  font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  font-variant-numeric: tabular-nums; flex-shrink: 0;
}
.progress-track { height: 3px; background: var(--ink); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 2px; transition: width 0.35s ease; }
.fill-primary { background: var(--safelight); }
.indeterminate { width: 40% !important; animation: indet 1.4s ease-in-out infinite; }
@keyframes indet { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }

/* ── User card ───────────────────────────────────────────────────────────── */
.user-card {
  display: flex; align-items: center; gap: 11px; padding: 10px;
  background: var(--ink); border: 1px solid var(--rule);
  border-radius: 8px; flex-shrink: 0; animation: fadeUp 0.2s ease;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.user-avatar {
  width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0;
  background: var(--card);
  box-shadow: 0 0 0 1px var(--rule-hi);
}
.user-fullname {
  font-family: var(--cond); font-size: 15px; font-weight: 600;
  letter-spacing: 0.02em; line-height: 1.15;
}
.user-handle { font-family: var(--mono); font-size: 11px; color: var(--safelight); margin-top: 1px; }
.user-stats  { font-family: var(--mono); font-size: 10px; color: var(--faint); margin-top: 3px; }

/* ── Signature: the contact-sheet frame strip ────────────────────────────── */
.stat-card {
  position: relative;
  display: flex; align-items: stretch;
  background: var(--card); border: 1px solid var(--rule-hi);
  border-radius: 8px; padding: 13px 6px 11px;
  flex-shrink: 0;
}
/* 35mm perforations, top and bottom */
.stat-card::before, .stat-card::after {
  content: ""; position: absolute; left: 7px; right: 7px; height: 5px;
  background-image: radial-gradient(circle, var(--ink) 1.7px, transparent 1.8px);
  background-size: 9px 5px; background-repeat: repeat-x;
}
.stat-card::before { top: 3px; }
.stat-card::after  { bottom: 3px; }
.stat-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
}
.stat-ico { width: 13px; height: 13px; color: var(--faint); display: block; }
.stat-num {
  font-family: var(--mono); font-size: 19px; font-weight: 500; line-height: 1;
  color: var(--paper); font-variant-numeric: tabular-nums;
}
.stat-lbl {
  font-family: var(--cond); font-size: 9.5px; font-weight: 600;
  color: var(--faint); text-transform: uppercase; letter-spacing: 0.13em;
}
.stat-div { width: 1px; background: var(--rule-hi); align-self: stretch; margin: 2px 0; flex-shrink: 0; }

/* ── History bar ─────────────────────────────────────────────────────────── */
.hist-bar {
  display: flex; align-items: center; gap: 6px; padding: 7px 10px;
  background: var(--ink); border: 1px solid var(--rule);
  border-left: 2px solid var(--ok);
  border-radius: 6px; flex-shrink: 0;
}
.hist-new  { font-family: var(--mono); font-size: 11px; color: var(--ok); }
.hist-seen { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.hist-sep  { color: var(--rule-hi); }

.setting-row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 0; cursor: pointer; user-select: none;
}
.setting-row + .setting-row { border-top: 1px solid var(--rule); }
.setting-row input[type="checkbox"] {
  width: 14px; height: 14px; margin: 2px 0 0; flex-shrink: 0;
  accent-color: var(--safelight); cursor: pointer;
}
.setting-text { display: flex; flex-direction: column; gap: 2px; }
.setting-title {
  font-family: var(--cond); font-size: 13.5px; font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase; color: var(--paper);
}
.setting-note { font-size: 11px; color: var(--faint); line-height: 1.45; }

/* ── Results header ──────────────────────────────────────────────────────── */
.results-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.results-count-txt {
  font-family: var(--mono); font-size: 11px; color: var(--dim);
}
.results-actions { display: flex; gap: 9px; flex-shrink: 0; }

/* ── Followings ──────────────────────────────────────────────────────────── */
.fol-controls { display: flex; align-items: center; gap: 8px; }
.fol-search-wrap {
  flex: 1; display: flex; align-items: center;
  background: var(--ink); border: 1px solid var(--rule);
  border-radius: 7px; overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.fol-search-wrap:focus-within {
  border-color: var(--safelight-d); box-shadow: 0 0 0 3px rgba(232,135,60,0.13);
}
.fol-search-icon { display: flex; padding: 0 8px; color: var(--faint); }
.fol-search-icon svg { width: 12px; height: 12px; }
#fol-search {
  flex: 1; min-width: 0; background: transparent; border: none; outline: none;
  color: var(--paper); font-family: var(--mono); font-size: 12px; padding: 8px 9px 8px 0;
}
.fol-sel-btns { display: flex; align-items: center; gap: 5px; white-space: nowrap; flex-shrink: 0; }
.fol-list-info { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }

.fol-list {
  max-height: 216px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: thin; scrollbar-color: var(--rule-hi) transparent;
}
.fol-item {
  display: flex; align-items: center; gap: 9px; padding: 6px 8px;
  background: var(--ink); border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; transition: background 0.12s, border-color 0.12s;
  user-select: none; flex-shrink: 0;
}
.fol-item:hover { background: var(--card); }
.fol-item:has(.fol-chk:checked) {
  background: rgba(232,135,60,0.07); border-color: var(--safelight-d);
}
.fol-item.fol-hidden { display: none; }
.fol-chk { width: 14px; height: 14px; accent-color: var(--safelight); cursor: pointer; flex-shrink: 0; }
.fol-avatar {
  width: 28px; height: 28px; border-radius: 6px; object-fit: cover;
  background: var(--card); flex-shrink: 0; box-shadow: 0 0 0 1px var(--rule);
}
.fol-info { flex: 1; min-width: 0; }
.fol-name {
  font-family: var(--cond); font-size: 13.5px; font-weight: 600; letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fol-handle {
  font-family: var(--mono); font-size: 10px; color: var(--faint); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fol-status {
  flex-shrink: 0; display: flex; align-items: center; gap: 4px;
  font-family: var(--mono); font-size: 10px; padding: 3px 7px;
  border-radius: 4px; white-space: nowrap;
}
.fol-status svg { width: 11px; height: 11px; }
.fol-s-running { background: rgba(217,164,65,0.14); color: var(--warn); }
.fol-s-done    { background: rgba(127,166,107,0.14); color: var(--ok); }
.fol-s-skip    { background: var(--card); color: var(--faint); }
.fol-s-err     { background: rgba(196,97,76,0.14); color: var(--err); }

/* ── Bulk run ────────────────────────────────────────────────────────────── */
.run-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.run-log {
  max-height: 184px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: thin; scrollbar-color: var(--rule-hi) transparent;
}
.log-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  background: var(--ink); border-radius: 5px;
  animation: fadeUp 0.15s ease;
}
.log-avatar { width: 18px; height: 18px; border-radius: 4px; background: var(--card); flex-shrink: 0; }
.log-name {
  font-family: var(--mono); font-size: 11px; color: var(--dim);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.log-stat {
  font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%;
}
.log-badge { display: flex; color: var(--faint); flex-shrink: 0; }
.log-badge svg { width: 12px; height: 12px; }

/* ── Misc ────────────────────────────────────────────────────────────────── */
.hidden { display: none !important; }
.sec-title {
  font-family: var(--cond); font-size: 13px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase; color: var(--dim);
}
.hint-line {
  font-size: 10.5px; color: var(--faint); line-height: 1.5; text-align: center;
}
.hint-line b { color: var(--dim); font-weight: 600; }

/* ── Export / developer section ──────────────────────────────────────────── */
.export-section {
  border: 1px solid var(--rule); border-radius: 7px; overflow: hidden; flex-shrink: 0;
  background: var(--ink);
}
.exp-toggle-btn {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  padding: 9px 11px; background: none; border: none; cursor: pointer;
  color: var(--dim); font-family: var(--cond);
  font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  transition: background 0.12s, color 0.12s;
}
.exp-toggle-btn:hover { background: var(--card); color: var(--paper); }
.exp-chevron { display: flex; color: var(--faint); transition: transform 0.18s; }
.exp-chevron svg { width: 12px; height: 12px; }
.exp-body {
  padding: 11px; display: flex; flex-direction: column; gap: 10px;
  border-top: 1px solid var(--rule);
}
.exp-fmt-row { display: flex; gap: 5px; }
.exp-chip {
  position: relative; flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 8px; background: var(--card); border: 1px solid var(--rule);
  border-radius: 6px; cursor: pointer;
  font-family: var(--cond); font-size: 12.5px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--dim); transition: all 0.12s; user-select: none;
}
.exp-chip input[type="radio"] {
  position: absolute; opacity: 0; width: 100%; height: 100%;
  left: 0; top: 0; margin: 0; cursor: pointer;
}
.exp-chip svg { width: 12px; height: 12px; }
.exp-chip:hover { border-color: var(--rule-hi); color: var(--paper); }
.exp-chip:has(input:checked) {
  background: rgba(232,135,60,0.09); border-color: var(--safelight-d); color: var(--safelight);
}
.exp-chip:has(input:focus-visible) { box-shadow: 0 0 0 3px rgba(232,135,60,0.2); }
.exp-action-row { display: flex; gap: 7px; }
.exp-action-row .btn { padding: 8px 12px; font-size: 12.5px; }

.api-hint-box {
  background: var(--card); border: 1px solid var(--rule);
  border-radius: 7px; padding: 11px;
  display: flex; flex-direction: column; gap: 8px;
}
.api-hint-title {
  font-family: var(--cond); font-size: 10px; font-weight: 600;
  color: var(--faint); text-transform: uppercase; letter-spacing: 0.12em;
}
.api-code-row { display: flex; align-items: center; gap: 8px; }
.api-code {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 10.5px;
  color: var(--safelight); background: transparent; border: none; outline: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.api-docs { font-size: 10.5px; color: var(--faint); line-height: 1.55; }
.api-docs code { font-family: var(--mono); color: var(--dim); font-size: 10px; }

/* ── Focus visibility ────────────────────────────────────────────────────── */
.is-panel :focus-visible {
  outline: 2px solid var(--safelight);
  outline-offset: 1px;
}

/* ── Reduced motion ──────────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .is-panel, .user-card, .log-row { animation: none; }
  .indeterminate { animation: none; width: 100% !important; opacity: 0.5; }
  .btn.loading svg { animation: none; }
  .is-fab:hover, .btn:not(:disabled):active { transform: none; }
  .progress-fill { transition: none; }
}
`; }

/* ═══════════════════════════════════════════════════════════════════════════
   HTML TEMPLATE
   ═══════════════════════════════════════════════════════════════════════════ */
function isHTML(ICON) { return `
<div id="is-panel" class="is-panel">

  <!-- Header / drag handle -->
  <div class="is-header" id="is-drag">
    <div class="is-brand">
      <img src="${ICON}" class="is-logo-img" alt="">
      <span class="is-title">InstaScrap</span>
      <span class="is-subtitle">v2.4</span>
    </div>
    <div class="is-header-btns">
      <button class="is-hbtn" id="is-minimize" title="Minimize" aria-label="Minimize">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <button class="is-hbtn" id="is-close" title="Remove panel" aria-label="Remove panel">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </div>

  <!-- Mode tabs -->
  <nav class="is-tabs" role="tablist">
    <button class="is-tab active" id="tab-single" role="tab" aria-selected="true">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Profile
    </button>
    <button class="is-tab" id="tab-fol" role="tab" aria-selected="false">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Following
    </button>
    <button class="is-tab" id="tab-set" role="tab" aria-selected="false">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.77 1.02 1.42 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </button>
  </nav>

  <!-- Body -->
  <div class="is-body">

    <!-- ══ SINGLE PROFILE ══ -->
    <div id="sec-single">
      <div class="field-group">
        <label class="field-label" for="inp-username">Username</label>
        <div class="username-row">
          <div class="input-pill">
            <span class="pill-pre">@</span>
            <input id="inp-username" aria-label="Instagram username" type="text" placeholder="username" autocomplete="off" spellcheck="false" enterkeyhint="go">
          </div>
          <button id="btn-use-tab" class="use-tab-btn" title="Fill in the profile open in this tab" aria-label="Use the profile open in this tab">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          </button>
        </div>
      </div>

      <div class="field-row">
        <div class="field-group">
          <label class="field-label" for="inp-date-from">Posted from</label>
          <input type="date" id="inp-date-from" aria-label="Filter: posted on or after this date" class="date-full">
        </div>
        <div class="field-group">
          <label class="field-label" for="inp-date-to">Posted to</label>
          <input type="date" id="inp-date-to" aria-label="Filter: posted on or before this date" class="date-full">
        </div>
      </div>

      <div class="field-group">
        <span class="field-label">Media types</span>
        <div class="toggle-group">
          <label class="toggle-chip"><input type="checkbox" id="chk-reels" aria-label="Reels" checked>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="2"/><path d="M22 8l-4 3 4 3V8z"/></svg>
            Reels</label>
          <label class="toggle-chip"><input type="checkbox" id="chk-photos" aria-label="Photos" checked>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            Photos</label>
          <label class="toggle-chip"><input type="checkbox" id="chk-albums" aria-label="Albums" checked>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
            Albums</label>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label" for="inp-max">Post limit</label>
        <div class="input-pill">
          <input type="number" id="inp-max" value="100" min="1" max="9999" aria-label="Maximum posts to scan">
          <span class="pill-suf">posts</span>
        </div>
      </div>

      <button id="btn-fetch" class="btn btn-primary" title="Fetch posts. Shift+click to scrape only the images already rendered in the page grid.">
        <span id="ico-fetch" class="btn-ico">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/></svg>
        </span><span id="txt-fetch">Fetch posts</span>
      </button>
      <p class="hint-line">Instagram needs a moment on the profile page before it hands over a session. If a fetch fails, open the profile, scroll once, then try again.</p>

      <div id="scan-progress" class="progress-block hidden">
        <div class="progress-meta">
          <span id="scan-label" class="progress-label">Scanning</span>
          <span id="scan-count" class="progress-count">0 posts</span>
        </div>
        <div class="progress-track"><div class="progress-fill fill-primary indeterminate"></div></div>
      </div>

      <div id="user-card" class="user-card hidden">
        <img id="user-avatar" src="" alt="" class="user-avatar">
        <div>
          <div id="user-fullname" class="user-fullname"></div>
          <div id="user-handle"   class="user-handle"></div>
          <div id="user-stats"    class="user-stats"></div>
        </div>
      </div>

      <div id="results-section" class="hidden">
        <div class="results-header">
          <span id="results-count" class="results-count-txt">0 posts found</span>
          <div class="results-actions">
            <button id="btn-clear-hist" class="link-btn dim hidden" title="Clear download history for this account">Clear this account</button>
            <button id="btn-clear-all-quick" class="link-btn dim" title="Clear download history for every account">Clear all</button>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-item">
            <svg aria-hidden="true" class="stat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="2"/><path d="M22 8l-4 3 4 3V8z"/></svg>
            <span id="cnt-reels"  class="stat-num">0</span><span class="stat-lbl">Reels</span>
          </div>
          <div class="stat-div"></div>
          <div class="stat-item">
            <svg aria-hidden="true" class="stat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <span id="cnt-photos" class="stat-num">0</span><span class="stat-lbl">Photos</span>
          </div>
          <div class="stat-div"></div>
          <div class="stat-item">
            <svg aria-hidden="true" class="stat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
            <span id="cnt-albums" class="stat-num">0</span><span class="stat-lbl">Albums</span>
          </div>
          <div class="stat-div"></div>
          <div class="stat-item">
            <svg aria-hidden="true" class="stat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            <span id="cnt-files"  class="stat-num">0</span><span class="stat-lbl">Files</span>
          </div>
        </div>

        <div id="hist-bar" class="hist-bar hidden">
          <span id="hist-new"  class="hist-new">0 new</span>
          <span class="hist-sep">/</span>
          <span id="hist-seen" class="hist-seen">0 already downloaded</span>
        </div>

        <button id="btn-download" class="btn btn-primary" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>
          <span id="txt-download">Download</span>
        </button>

        <div id="dl-progress" class="progress-block hidden">
          <div class="progress-meta">
            <span id="dl-label" class="progress-label">Preparing</span>
            <span id="dl-count" class="progress-count">0 / 0</span>
          </div>
          <div class="progress-track"><div id="dl-bar" class="progress-fill fill-primary" style="width:0%"></div></div>
        </div>

        <div class="export-section">
          <button class="exp-toggle-btn" id="exp-toggle" aria-expanded="false" aria-controls="exp-body">
            <span>Export and API</span>
            <span class="exp-chevron" id="exp-chevron">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </span>
          </button>
          <div id="exp-body" class="exp-body hidden">
            <div class="field-group">
              <span class="field-label">Format</span>
              <div class="exp-fmt-row">
                <label class="exp-chip"><input type="radio" name="exp-fmt" id="fmt-urls" aria-label="Export as URLs" checked>
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
                  URLs</label>
                <label class="exp-chip"><input type="radio" name="exp-fmt" id="fmt-json" aria-label="Export as JSON">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>
                  JSON</label>
                <label class="exp-chip"><input type="radio" name="exp-fmt" id="fmt-csv" aria-label="Export as CSV">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
                  CSV</label>
              </div>
            </div>
            <div class="exp-action-row">
              <button id="btn-copy-exp" class="btn btn-quiet" style="flex:1">Copy</button>
              <button id="btn-save-exp" class="btn btn-quiet" style="flex:1">Save file</button>
            </div>
            <div class="exp-action-row">
              <button id="btn-push-app" class="btn btn-quiet" style="flex:1">Send to bridge server</button>
            </div>
            <div class="api-hint-box">
              <span class="api-hint-title">Console API</span>
              <div class="api-code-row">
                <code class="api-code">postMessage({__instascrap:'query'},'*')</code>
                <button id="btn-copy-api" class="link-btn">Copy</button>
              </div>
              <p class="api-docs">Run in the console, then listen for <code>__instascrap_response</code>. Commands: <code>query</code> <code>getFollowings</code> <code>getHistory</code> <code>help</code></p>
            </div>
          </div>
        </div>
      </div>
    </div><!-- /sec-single -->

    <!-- ══ FOLLOWING ══ -->
    <div id="sec-fol" class="hidden">
      <div class="field-row">
        <div class="field-group">
          <label class="field-label" for="fol-max">Posts per account</label>
          <div class="input-pill">
            <input type="number" id="fol-max" aria-label="Maximum posts per account" value="50" min="1" max="99999">
            <span class="pill-suf">max</span>
          </div>
        </div>
        <div class="field-group">
          <span class="field-label">Media types</span>
          <div class="toggle-group">
            <label class="toggle-chip sm" title="Reels"><input type="checkbox" id="fol-reels" aria-label="Include reels" checked>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="2"/><path d="M22 8l-4 3 4 3V8z"/></svg></label>
            <label class="toggle-chip sm" title="Photos"><input type="checkbox" id="fol-photos" aria-label="Include photos" checked>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></label>
            <label class="toggle-chip sm" title="Albums"><input type="checkbox" id="fol-albums" aria-label="Include albums" checked>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg></label>
          </div>
        </div>
      </div>

      <button id="btn-fol-load" class="btn btn-quiet">
        <span id="ico-fol-load" class="btn-ico">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </span><span id="txt-fol-load">Load my following</span>
      </button>

      <div id="fol-load-prog" class="progress-block hidden">
        <div class="progress-meta">
          <span id="fol-load-label" class="progress-label">Loading</span>
          <span id="fol-load-count" class="progress-count"></span>
        </div>
        <div class="progress-track"><div class="progress-fill fill-primary indeterminate"></div></div>
      </div>

      <div id="fol-list-section" class="hidden">
        <div class="fol-controls">
          <div class="fol-search-wrap">
            <span class="fol-search-icon">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/></svg>
            </span>
            <input type="text" id="fol-search" aria-label="Filter the account list" placeholder="Filter accounts" autocomplete="off">
          </div>
          <div class="fol-sel-btns">
            <button class="link-btn" id="fol-sel-all">All</button>
            <span class="hist-sep">/</span>
            <button class="link-btn" id="fol-sel-none">None</button>
          </div>
        </div>
        <span id="fol-list-info" class="fol-list-info">0 accounts</span>
        <div id="fol-list" class="fol-list"></div>
        <button id="btn-fol-run" class="btn btn-primary" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <span id="txt-fol-run">Select accounts first</span>
        </button>
        <button id="btn-fol-links" class="btn btn-quiet" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
          <span id="txt-fol-links">Export links only</span>
        </button>
      </div>

      <div id="fol-run-section" class="hidden">
        <div class="run-header">
          <span id="fol-run-status" class="sec-title">Running</span>
          <button id="btn-fol-stop" class="link-btn dim" disabled>Stop</button>
        </div>
        <div class="progress-block">
          <div class="progress-meta">
            <span id="fol-run-label" class="progress-label">Starting</span>
            <span id="fol-run-count" class="progress-count">0 / 0</span>
          </div>
          <div class="progress-track"><div id="fol-run-bar" class="progress-fill fill-primary" style="width:0%"></div></div>
        </div>
        <div id="fol-run-log" class="run-log"></div>
      </div>
    </div><!-- /sec-fol -->

    <!-- ══ SETTINGS ══ -->
    <div id="sec-set" class="hidden">
      <p class="sec-intro">Applies to every scan in this panel.</p>

      <div class="api-hint-box">
        <label class="setting-row">
          <input type="checkbox" id="chk-skip" aria-label="Skip posts already downloaded" checked>
          <span class="setting-text">
            <span class="setting-title">Skip what I already have</span>
            <span class="setting-note">Leaves out posts you have downloaded from this account before.</span>
          </span>
        </label>
        <label class="setting-row">
          <input type="checkbox" id="chk-zip" aria-label="Bundle files into a ZIP archive">
          <span class="setting-text">
            <span class="setting-title">Bundle into one ZIP</span>
            <span class="setting-note">Saves a single archive instead of loose files. Large accounts take a moment.</span>
          </span>
        </label>
      </div>

      <div class="api-hint-box">
        <label class="setting-row">
          <input type="checkbox" id="chk-sync" aria-label="Enable bridge sync">
          <span class="setting-text">
            <span class="setting-title">Bridge sync</span>
            <span class="setting-note">Lets <code>bridge_server.py</code> exchange commands and receive results.</span>
          </span>
        </label>
      </div>

      <div class="field-group">
        <span class="field-label">History</span>
        <button id="btn-clear-all-hist" class="btn btn-quiet">Clear history for every account</button>
        <p class="setting-note">Marks every post as not downloaded, so the next scan offers them again.</p>
      </div>

      <div class="export-section">
        <button class="exp-toggle-btn" id="exp-toggle-set" aria-expanded="false" aria-controls="exp-body-set">
          <span>Console API</span>
          <span class="exp-chevron" id="exp-chevron-set">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </span>
        </button>
        <div id="exp-body-set" class="exp-body hidden">
          <div class="api-hint-box">
            <div class="api-code-row">
              <code class="api-code">postMessage({__instascrap:'query'},'*')</code>
              <button id="btn-copy-api-set" class="link-btn">Copy</button>
            </div>
            <p class="api-docs">Every request you send is answered with a <code>__instascrap_response</code> message on the same window.</p>
          </div>
        </div>
      </div>
    </div><!-- /sec-set -->

  </div><!-- /is-body -->

  <div class="is-footer">
    <span id="footer-msg" class="footer-msg">Ready</span>
  </div>
</div>

<!-- FAB (minimized) -->
<button id="is-fab" class="is-fab is-hidden" title="Open InstaScrap" aria-label="Open InstaScrap">
  <img src="${ICON}" alt="">
</button>
`; }
