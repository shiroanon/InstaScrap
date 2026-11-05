'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   InstaScrap — Instagram API layer (runs in the service worker)

   Every Instagram request originates HERE, in the extension's service worker,
   never in the page. This mirrors the proven Bulk-Saver extension:

   1. Requests go to https://i.instagram.com — NOT www. Instagram gates
      www.instagram.com/graphql/query behind an HTML login wall, which is what
      produced the "HTML wall / schema error" symptom.
   2. Auth headers are the ones Instagram's own web app sends, captured
      verbatim per-tab via webRequest (see installCapture below). Nothing is
      guessed: a missing x-ig-app-id / x-asbd-id is a hard stop, and a missing
      x-ig-www-claim is omitted entirely rather than sent as "0" (Instagram
      rejects a zero claim with HTTP 400).
   3. redirect:'manual', so a login bounce is reported as "session expired"
      instead of masquerading as an HTML wall.
   4. profileMediaPage() reproduces Bulk-Saver's proven query construction and
      GraphQL -> REST feed fallback verbatim.
   ═══════════════════════════════════════════════════════════════════════════ */

const IG_WEB_ORIGIN  = 'https://www.instagram.com';
const IG_API_ORIGIN  = 'https://i.instagram.com';
const IG_GRAPHQL_URL = 'https://i.instagram.com/graphql/query';
const GQL_FIELD      = 'xdt_api__v1__feed__user_timeline_graphql_connection';

// doc_ids rotate without notice. These are the current known-good pair; the
// per-tab capture below overrides them with whatever the web app really sends.
const GQL_SPEC = {
  first: { name: 'PolarisProfilePostsQuery',                      id: '38154989454116081' },
  next:  { name: 'PolarisProfilePostsTabContentQuery_connection', id: '39535953862670189' },
};
const GQL_NAMES = Object.values(GQL_SPEC).map(s => s.name);

const REQUEST_TIMEOUT_MS = 30000;

class IgError extends Error {
  constructor(code, message, status, retryAfter) {
    super(message);
    this.name = 'IgError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const log = (...args) => console.info('[InstaScrap]', ...args);

/* ═══════════════════════════════════════════════════════════════════════════
   1. PER-TAB AUTH CAPTURE  (webRequest)
   ═══════════════════════════════════════════════════════════════════════════ */

const authKey = tabId => `ig_auth_${tabId}`;

let authChain = Promise.resolve();

function writeAuth(tabId, patch) {
  authChain = authChain.then(async () => {
    const key = authKey(tabId);
    const cur = (await chrome.storage.session.get(key))[key] || {};
    await chrome.storage.session.set({
      [key]: {
        ...cur,
        ...patch,
        at: patch.at || cur.at || Date.now(),
        headers: { ...(cur.headers || {}), ...(patch.headers || {}) },
        queries: { ...(cur.queries || {}), ...(patch.queries || {}) },
      },
    });
  }).catch(() => {});
  return authChain;
}

function isIgUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' &&
      (u.hostname === 'instagram.com' || u.hostname.endsWith('.instagram.com'));
  } catch { return false; }
}

function readFormBody(body) {
  if (!body) return new URLSearchParams();
  if (body.formData) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body.formData)) {
      if (typeof v[0] === 'string') p.set(k, v[0]);
    }
    return p;
  }
  const dec = new TextDecoder();
  const raw = (body.raw || [])
    .map(p => (p.bytes ? dec.decode(p.bytes, { stream: true }) : ''))
    .join('') + dec.decode();
  return new URLSearchParams(raw);
}

function installCapture() {
  // Auth headers Instagram's web app puts on its own XHRs.
  chrome.webRequest.onBeforeSendHeaders.addListener(details => {
    if (details.tabId < 0 || !isIgUrl(details.initiator)) return;
    const h = {};
    for (const hdr of details.requestHeaders || []) {
      const n = hdr.name.toLowerCase();
      if ((n === 'x-ig-app-id' || n === 'x-ig-www-claim' || n === 'x-asbd-id') && hdr.value) {
        h[n] = hdr.value;
      }
    }
    if (Object.keys(h).length) writeAuth(details.tabId, { headers: h });
  }, { urls: ['*://*.instagram.com/*'] }, ['requestHeaders', 'extraHeaders']);

  // Live doc_ids for the two profile-media queries we actually issue.
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.tabId < 0 || !isIgUrl(details.initiator)) return;
    const params  = readFormBody(details.requestBody);
    const friendly = params.get('fb_api_req_friendly_name');
    const docId    = params.get('doc_id');
    if (!GQL_NAMES.includes(friendly)) return;
    if (!docId || !/^\d{5,30}$/.test(docId)) return;
    writeAuth(details.tabId, { queries: { [friendly]: docId } });
  }, {
    urls: ['*://*.instagram.com/graphql/query*', '*://*.instagram.com/api/graphql*'],
    types: ['xmlhttprequest'],
  }, ['requestBody']);

  chrome.tabs.onRemoved.addListener(tabId => {
    authChain = authChain
      .then(() => chrome.storage.session.remove(authKey(tabId)))
      .catch(() => {});
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. AUTH RESOLUTION  — hard gate, never guesses
   ═══════════════════════════════════════════════════════════════════════════ */

const NO_AUTH = 'Open your profile on instagram.com and scroll once, then press Fetch again — Instagram auth is captured from the page itself.';

async function resolveAuth(tabId) {
  if (tabId == null) {
    return { error: { code: 'REQUEST', message: 'No Instagram tab is attached to this panel.' } };
  }
  try {
    await authChain;
    const key    = authKey(tabId);
    const record = (await chrome.storage.session.get(key))[key];
    const store  = (await chrome.cookies.getAllCookieStores()).find(s => s.tabIds.includes(tabId));

    if (!store) {
      return { error: { code: 'AUTH', message: 'Could not read this tab’s cookie store. Reload the Instagram tab and try again.' } };
    }
    const csrf = (await chrome.cookies.get({
      url: IG_WEB_ORIGIN, name: 'csrftoken', storeId: store.id,
    }))?.value;

    if (!csrf) {
      return { error: { code: 'AUTH', message: 'Not logged in to Instagram. Log in at instagram.com, reload the tab, then retry.' } };
    }

    const h = record?.headers || {};
    if (!h['x-ig-app-id'] || !h['x-asbd-id']) {
      return { error: { code: 'AUTH', message: NO_AUTH } };
    }

    const headers = {
      'x-ig-app-id':  h['x-ig-app-id'],
      'x-asbd-id':    h['x-asbd-id'],
      'x-csrftoken':  csrf,
    };
    // Omit rather than send "0" — Instagram rejects a zero claim with HTTP 400.
    if (h['x-ig-www-claim']) headers['x-ig-www-claim'] = h['x-ig-www-claim'];

    return { headers, queries: record.queries || {}, capturedAt: record.at || 0 };
  } catch (err) {
    return { error: { code: 'AUTH', message: 'Could not read Instagram auth: ' + (err?.message || err) } };
  }
}

/** Diagnostic snapshot for the launcher popup. */
async function authStatus(tabId) {
  if (tabId == null) {
    return { hasTab: false, ready: false, message: 'No Instagram tab found.' };
  }
  // A tab id that no longer resolves means the tab was closed between the
  // popup's query and this call.
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* closed */ }
  if (!tab) {
    return { hasTab: false, ready: false, message: 'That Instagram tab was closed — reopen it and try again.' };
  }

  const auth = await resolveAuth(tabId);
  if (auth.error) {
    return { hasTab: true, ready: false, code: auth.error.code, message: auth.error.message };
  }
  return {
    hasTab: true,
    ready: true,
    url: tab.url || '',
    ageSeconds: auth.capturedAt ? Math.round((Date.now() - auth.capturedAt) / 1000) : null,
    appId: auth.headers['x-ig-app-id'],
    hasClaim: !!auth.headers['x-ig-www-claim'],
    capturedDocIds: auth.queries,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. TRANSPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function doFetch(url, { method = 'GET', headers = {}, body = null, raw = false } = {}) {
  const ctl   = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      redirect: 'manual',
      signal: ctl.signal,
      body: body ? (typeof body === 'string' ? body : body.toString()) : undefined,
    });
  } catch (err) {
    return {
      success: false,
      error: ctl.signal.aborted
        ? { code: 'TIMEOUT', message: `Instagram did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.` }
        : { code: 'NETWORK', message: 'Could not reach Instagram: ' + (err?.message || err) },
    };
  } finally {
    clearTimeout(timer);
  }

  const redirected = res.type === 'opaqueredirect' ||
    res.redirected ||
    (res.status >= 300 && res.status < 400);

  log({ url: url.split('?')[0], status: res.status, redirected });

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('retry-after')) || 0;
    return {
      success: false,
      error: {
        code: 'IG_RATE_LIMITED', status: 429, retryAfter,
        message: `Instagram returned 429 (rate limited). Wait ~${retryAfter || 60}s before retrying.`,
      },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      success: false,
      error: {
        code: 'IG_AUTH_HTTP', status: res.status,
        message: `Instagram returned ${res.status} and refused the session. Log out of instagram.com, log back in, then reload the tab.`,
      },
    };
  }
  if (redirected) {
    return {
      success: false,
      error: {
        code: 'IG_REQUIRE_LOGIN', status: res.status,
        message: 'Instagram redirected the request (usually the login page). Log in at instagram.com and reload the tab.',
      },
    };
  }
  if (!res.ok) {
    return {
      success: false,
      error: { code: 'HTTP', status: res.status, message: `Instagram request failed (HTTP ${res.status}).` },
    };
  }

  let text = '';
  try { text = await res.text(); } catch { /* empty body is fine for raw html checks */ }

  if (raw) return { success: true, text };

  try {
    return { success: true, json: JSON.parse(text) };
  } catch {
    if ((res.headers.get('content-type') || '').includes('text/html') ||
        /^\s*<(!doctype|html)/i.test(text)) {
      return {
        success: false,
        error: {
          code: 'IG_HTML_WALL',
          message: 'Instagram returned an HTML page instead of data (login wall or rate limit). Log out and back in, or wait a few minutes.',
        },
      };
    }
    return {
      success: false,
      error: { code: 'NON_JSON', message: 'Instagram returned a non-JSON response.' },
    };
  }
}

/** Authenticated request against i.instagram.com. */
async function igFetchAuthed(auth, opts) {
  const res = await doFetch(opts.url, {
    method: opts.method || 'GET',
    headers: { ...auth.headers, ...(opts.headers || {}) },
    body: opts.body || null,
  });
  if (res.success) return res;
  return { success: false, error: { ...res.error, code: res.error.code } };
}

/**
 * Generic entry point used by the panel for every non-profile-media call
 * (web_profile_info, feed-by-id, clips, followings, profile HTML).
 *
 * kind: 'api'   -> https://i.instagram.com + path   (authenticated, mobile API)
 *       'web'   -> https://www.instagram.com + path (authenticated, web API:
 *                  web_profile_info lives here, not on i.instagram.com)
 *       'html'  -> https://www.instagram.com + path (plain HTML, no auth)
 */
async function igRequest(tabId, req) {
  const { path, method = 'GET', body = null, kind = 'api', raw = false, headers = {} } = req || {};

  if (!path || typeof path !== 'string') {
    return { success: false, error: { code: 'REQUEST', message: 'Invalid request path.' } };
  }
  if (kind !== 'api' && kind !== 'web' && kind !== 'html') {
    return { success: false, error: { code: 'REQUEST', message: `Unknown request kind "${kind}".` } };
  }

  if (kind === 'html') {
    return doFetch(path.startsWith('http') ? path : IG_WEB_ORIGIN + path, {
      method,
      headers: { Accept: 'text/html,application/xhtml+xml', ...headers },
      body, raw: true,
    });
  }

  const auth = await resolveAuth(tabId);
  if (auth.error) return { success: false, error: auth.error };

  const origin = kind === 'web' ? IG_WEB_ORIGIN : IG_API_ORIGIN;
  const url = path.startsWith('http') ? path : origin + path;
  const res = await doFetch(url, {
    method,
    headers: { ...auth.headers, ...headers },
    body,
    raw,
  });
  return res;
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. PROFILE MEDIA  (Bulk-Saver's proven query construction + fallback)
   ═══════════════════════════════════════════════════════════════════════════ */

function parseMediaPayload(json, provider, username) {
  if (json?.errors?.length) {
    throw new IgError('IG_SCHEMA_DELETED', 'Instagram rejected the profile query — reload the page and retry.');
  }

  const conn = json?.data?.[GQL_FIELD];
  const items = provider === 'graphql'
    ? (Array.isArray(conn?.edges) ? conn.edges.map(e => e?.node?.media ?? e?.node).filter(Boolean) : null)
    : json?.items;
  const hasNext = provider === 'graphql' ? conn?.page_info?.has_next_page : json?.more_available;
  const cursor  = provider === 'graphql' ? conn?.page_info?.end_cursor   : json?.next_max_id;

  if (!Array.isArray(items) || typeof hasNext !== 'boolean') {
    throw new IgError('IG_SCHEMA_DELETED', 'Instagram changed the response structure — InstaScrap needs updating.');
  }
  if (hasNext && !(typeof cursor === 'string' && cursor.trim())) {
    throw new IgError('CURSOR', 'Instagram did not return a pagination cursor — stopping.');
  }

  // Guard against silently mixing another account's posts into the results.
  const want = String(username || '').trim().toLowerCase();
  for (const it of items) {
    const owner = String(it?.user?.username || '').trim().toLowerCase();
    const coauthored = Array.isArray(it?.coauthor_producers) &&
      it.coauthor_producers.some(u => String(u?.username || '').trim().toLowerCase() === want);
    if (owner && owner !== want && !coauthored) {
      throw new IgError('OWNER', 'Instagram returned posts belonging to a different account than requested — stopping.');
    }
  }

  return { items, hasNext, cursor: hasNext ? cursor : null };
}

async function fetchMediaPage(username, cursor, provider, auth) {
  if (provider === 'graphql') {
    const spec  = cursor ? GQL_SPEC.next : GQL_SPEC.first;
    const docId = auth.queries?.[spec.name] || spec.id;

    const variables = {
      data: {
        count: 12,
        include_reel_media_seen_timestamp: true,
        include_relationship_info: true,
        latest_besties_reel_media: true,
        latest_reel_media: true,
      },
      username,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
      ...(cursor ? { after: cursor, first: 12 } : {}),
    };

    const res = await igFetchAuthed(auth, {
      url: IG_GRAPHQL_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-fb-friendly-name': spec.name,
        'x-root-field-name': GQL_FIELD,
      },
      body: new URLSearchParams({
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: spec.name,
        server_timestamps: 'true',
        doc_id: docId,
        variables: JSON.stringify(variables),
      }),
    });

    if (!res.success) {
      throw new IgError(res.error.code, res.error.message, res.error.status, res.error.retryAfter);
    }
    return parseMediaPayload(res.json, 'graphql', username);
  }

  // REST fallback: /api/v1/feed/user/<username>/username/?count=12
  let url = `${IG_API_ORIGIN}/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`;
  if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

  const res = await igFetchAuthed(auth, { url, method: 'GET', headers: {} });
  if (!res.success) {
    throw new IgError(res.error.code, res.error.message, res.error.status, res.error.retryAfter);
  }
  return parseMediaPayload(res.json, 'feed', username);
}

/** Soft check — the panel may legitimately run from any Instagram page. */
async function verifyTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch {
    return { code: 'PAGE_UNAVAILABLE', message: 'The Instagram tab was closed. Reopen the profile and try again.' };
  }
  if (!tab?.url) {
    return { code: 'PAGE_UNAVAILABLE', message: 'Could not read the Instagram tab address. Reload it and try again.' };
  }
  let u;
  try { u = new URL(tab.url); } catch { return null; }
  if (u.hostname !== 'instagram.com' && !u.hostname.endsWith('.instagram.com')) {
    return { code: 'REQUEST', message: 'The Instagram tab has navigated away from instagram.com — go back and reload.' };
  }
  return null;
}

// GraphQL problems worth retrying over the REST feed (first page only).
const FALLBACK_CODES = ['IG_HTML_WALL', 'NON_JSON', 'IG_REQUIRE_LOGIN', 'IG_SCHEMA_DELETED', 'IG_AUTH_HTTP', 'QUERY'];

async function profileMediaPage(tabId, req) {
  const username = String(req?.username || '').trim();
  const next     = req?.next || null;

  if (!/^[\w.]{1,30}$/.test(username)) {
    return { success: false, error: { code: 'REQUEST', message: 'That is not a valid Instagram username.' } };
  }
  if (next && next.provider !== 'graphql' && next.provider !== 'feed') {
    return { success: false, error: { code: 'CURSOR', message: 'Invalid pagination cursor.' } };
  }
  if (next && (typeof next.cursor !== 'string' || !next.cursor.trim() || next.cursor.length > 20000)) {
    return { success: false, error: { code: 'CURSOR', message: 'Invalid pagination cursor.' } };
  }

  const tabProblem = await verifyTab(tabId);
  if (tabProblem) return { success: false, error: tabProblem };

  const auth = await resolveAuth(tabId);
  if (auth.error) return { success: false, error: auth.error };

  const provider = next?.provider || 'graphql';
  const cursor   = next?.cursor || null;

  try {
    const page = await fetchMediaPage(username, cursor, provider, auth);
    if (page.cursor && cursor && page.cursor === cursor) {
      throw new IgError('CURSOR', 'Instagram repeated the same cursor — stopping to avoid an endless loop.');
    }
    log({ provider, posts: page.items.length, hasNext: page.hasNext });
    return {
      success: true,
      provider,
      items: page.items,
      postCount: page.items.length,
      next: page.hasNext ? { provider, cursor: page.cursor } : null,
    };
  } catch (err) {
    if (!(err instanceof IgError)) throw err;

    if (!next && FALLBACK_CODES.includes(err.code)) {
      log({ graphqlFailed: err.code, fallingBackTo: 'feed' });
      try {
        const page = await fetchMediaPage(username, null, 'feed', auth);
        log({ provider: 'feed', posts: page.items.length, hasNext: page.hasNext });
        return {
          success: true,
          provider: 'feed',
          items: page.items,
          postCount: page.items.length,
          next: page.hasNext ? { provider: 'feed', cursor: page.cursor } : null,
        };
      } catch (err2) {
        return { success: false, error: toErrorPayload(err2) };
      }
    }

    return { success: false, error: toErrorPayload(err) };
  }
}

function toErrorPayload(err) {
  return {
    code: err?.code || 'NETWORK',
    status: err?.status,
    retryAfter: err?.retryAfter,
    message: err?.message || String(err),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. MESSAGE API
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Guarantee exactly one sendResponse per message. Without this, a synchronous
 * throw or a rejected promise inside an async handler leaves the port unanswered
 * and Chrome reports "The message port closed before a response" to the panel,
 * which hides the real cause.
 */
function respondOnce(sendResponse) {
  let sent = false;
  return payload => {
    if (sent) return;
    sent = true;
    try { sendResponse(payload); }
    catch (err) { console.warn('[InstaScrap] sendResponse failed:', err); }
  };
}

const IG_API_ACTIONS = ['getProfileMediaPage', 'igRequest', 'igAuthStatus'];

function handleIgApiMessage(msg, sender, sendResponse) {
  const action = msg && msg.action;
  if (!IG_API_ACTIONS.includes(action)) return false;

  const tabId   = sender.tab?.id ?? msg.tabId ?? null;
  const respond = respondOnce(sendResponse);

  try {
    switch (action) {
      case 'getProfileMediaPage':
        profileMediaPage(tabId, msg)
          .then(respond, err => respond({ success: false, error: toErrorPayload(err) }));
        return true;

      case 'igRequest':
        igRequest(tabId, msg)
          .then(respond, err => respond({ success: false, error: toErrorPayload(err) }));
        return true;

      case 'igAuthStatus':
        authStatus(tabId)
          .then(respond, err => respond({
            hasTab: tabId != null, ready: false, message: err?.message || String(err),
          }));
        return true;
    }
  } catch (err) {
    // A synchronous failure inside the handler itself.
    respond({ success: false, error: toErrorPayload(err) });
    return true;
  }
  return false;
}
