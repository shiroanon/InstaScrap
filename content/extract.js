'use strict';
// MAIN world – extracts Instagram's own appId / www-claim via window.require
// Mirrors Bulk-Saver parse.js but minimal. Runs at document_start.
(() => {
  const K = { APP_ID: '__ig_app_id', WWW_CLAIM: '__ig_www_claim', HAS_REQUIRE: '__ig_has_require' };
  function tryAppId() {
    try {
      if (typeof window.require === 'function') {
        const id = window.require('PolarisConfig').getIGAppID();
        if (id) sessionStorage.setItem(K.APP_ID, id);
      }
    } catch {}
  }
  function tryClaim() {
    try {
      if (typeof window.require === 'function') {
        const claim = window.require('PolarisWWWClaim').getWWWClaim();
        if (claim) sessionStorage.setItem(K.WWW_CLAIM, claim);
      }
    } catch {}
  }
  function checkRequire() {
    try {
      const has = typeof window.require === 'function' ? '1' : '';
      if (sessionStorage.getItem(K.HAS_REQUIRE) !== has) sessionStorage.setItem(K.HAS_REQUIRE, has);
    } catch {}
  }
  // retry
  let ap = setInterval(tryAppId, 120);
  let wc = setInterval(tryClaim, 120);
  let rq = setInterval(checkRequire, 1000);
  setTimeout(() => { clearInterval(ap); clearInterval(wc); }, 15000);
  // storage listener – if IG rotates claim, re-extract
  window.addEventListener('storage', (e) => {
    if (e.key && !e.key.startsWith('__ig_') && e.oldValue && e.newValue && (e.oldValue === '0' || e.newValue.startsWith('hmac.') || e.key.includes('www'))) {
      tryClaim();
    }
  });
  // eager
  tryAppId(); tryClaim(); checkRequire();
})();
