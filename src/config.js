'use strict';

/* Shared configuration: loaded by the content script, the options page and the popup. */

const CR_DEFAULTS = {
  enabled: true,
  mode: 'overlay',          // 'overlay' (text stays in DOM, painted over) | 'replace' (text removed)
  fill: 'bar',              // replace mode only: 'bar' (solid measured-width box) | 'blocks' (repeated U+2588)
  keywords: [],
  wholeWord: true,
  caseSensitive: false,
  redactAttributes: true,   // title / alt / placeholder / aria-label
  redactTitle: true,        // document.title (the tab label)
  blockCopy: true,          // overlay mode: make the covered text unselectable
  cloak: true,              // hide the page until the first sweep finishes
  cloakTimeoutMs: 1500,     // failsafe: never stay hidden longer than this
  siteMode: 'all',          // 'all' | 'blocklist' | 'allowlist'
  sites: []
};

/* storage.local rather than storage.sync, on purpose: the keyword list is by
   definition the set of words you are trying to keep off the screen, and syncing
   it would copy it to Google's servers. Switch to chrome.storage.sync here if
   you would rather have cross-device sync (note the 8KB-per-item quota). */
const CR_STORE = chrome.storage.local;

function crLoadConfig() {
  return new Promise((resolve) => CR_STORE.get(CR_DEFAULTS, (v) => resolve(v)));
}

function crSaveConfig(patch) {
  return new Promise((resolve) => CR_STORE.set(patch, () => resolve()));
}

function crNormalizeHost(pattern) {
  return String(pattern).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');
}

function crHostMatch(list, host) {
  host = String(host || '').toLowerCase();
  for (const raw of list || []) {
    const p = crNormalizeHost(raw);
    if (p && (host === p || host.endsWith('.' + p))) return true;
  }
  return false;
}

function crSiteAllowed(cfg, host) {
  if (cfg.siteMode === 'blocklist') return !crHostMatch(cfg.sites, host);
  if (cfg.siteMode === 'allowlist') return crHostMatch(cfg.sites, host);
  return true;
}

/* One alternation for the whole keyword list, so each run of text costs a single
   regex pass rather than one per keyword. Longest-first, so "John Smith" wins
   over "John". Literal spaces are widened to a whitespace run, which is what
   lets a keyword still match when the page has split it over a newline, source
   indentation, or a non-breaking space. */
function crBuildPattern(cfg) {
  const words = (cfg.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (!words.length) return null;
  const unique = Array.from(new Set(words)).sort((a, b) => b.length - a.length);
  const parts = unique.map((k) => {
    let src = k
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s\\u00a0]+');
    if (cfg.wholeWord) {
      if (/^\w/.test(k)) src = '\\b' + src;
      if (/\w$/.test(k)) src = src + '\\b';
    }
    return '(?:' + src + ')';
  });
  try {
    return new RegExp(parts.join('|'), cfg.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    console.error('[Redactor] could not build keyword pattern', e);
    return null;
  }
}
