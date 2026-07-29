// Shared HTML/URL escaping helpers — the single source of truth for every
// static app under web/ (admin, portal, arena).
//
// Why this file exists: escapeHtml was hand-copied into admin.js, portal.js and
// arena.js, and isSafeUrl/safeHref into only two of the three. That drift was
// not cosmetic — it was the defect. The 2026-07-29 review found three href sinks
// built with escapeHtml alone, one of them in portal.js precisely because that
// file had no safeHref to reach for. Copying a security helper by hand
// guarantees the copies diverge; keeping one copy here means a fix lands
// everywhere at once.
//
// No build step in this repo (see rules/frontend.md), so this loads as a plain
// <script> before each app's own script and publishes `DSText` on window. The
// CommonJS tail is what lets api/test require it directly — the shipped file and
// the tested file are then literally the same bytes, with no bundler in between.
(function (root, factory) {
  const api = factory();
  root.DSText = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Is this URL safe to put in an href? Allows http(s), mailto, and relative
  // forms (anchor, path, protocol-relative); rejects everything else by
  // detecting a scheme colon before the first path separator.
  //
  // Keying off that colon rather than a scheme allowlist is deliberate: it also
  // catches whitespace and control-character obfuscation ("java\nscript:…"),
  // because the colon still precedes any slash. This matters because escapeHtml
  // does NOT touch ':' — an attacker-supplied `javascript:` URL survives HTML
  // escaping completely intact, which is exactly how the three sinks above
  // stayed exploitable despite looking escaped.
  function isSafeUrl(url) {
    const u = String(url || '');
    if (/^\s*(https?:|mailto:)/i.test(u)) return true;
    return !u.split(/[/?#]/)[0].includes(':');
  }

  // href value for an untrusted URL: the escaped URL when safe, else '#'.
  // Anything whose URL originates outside the tenant — scraped pages, ingested
  // documents, CRM fields, AI-extracted findings — must go through this, not
  // through escapeHtml alone.
  function safeHref(url) {
    return isSafeUrl(url) ? escapeHtml(url) : '#';
  }

  return { escapeHtml, isSafeUrl, safeHref };
});
