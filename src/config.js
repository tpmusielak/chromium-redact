'use strict';

/* Shared configuration: loaded by the content script, the options page and the popup. */

const CR_DEFAULTS = {
  enabled: true,
  mode: 'overlay',          // 'overlay' (painted over) | 'replace' (removed) | 'substitute' (swapped)
  fill: 'bar',              // replace mode only: 'bar' (solid measured-width box) | 'blocks' (repeated U+2588)
  substituteStyle: 'plain', // substitute mode: 'plain' (indistinguishable) | 'marked' (dotted underline)
  mimicCase: true,          // substitute mode: match the capitalisation of the text being replaced
  keywords: [],
  wholeWord: true,
  caseSensitive: false,
  redactAttributes: true,   // title / alt / placeholder / aria-label
  redactTitle: true,        // document.title (the tab label)
  blockCopy: true,          // overlay mode: make the covered text unselectable
  cloak: true,              // hide the page until the first sweep finishes
  cloakTimeoutMs: 1500,     // failsafe: never stay hidden longer than this
  siteMode: 'all',          // 'all' | 'blocklist' | 'allowlist'
  sites: [],

  /* Network response redaction. Opt-in, and inert without URL patterns: this
     rewrites application data rather than its presentation, so it is never on
     by default and never applies to "all traffic". */
  network: false,
  networkUrls: [],          // URL glob patterns; empty means the feature does nothing
  networkPaths: []          // JSON paths; empty means every string value in the body
};

/* storage.local rather than storage.sync, on purpose: the keyword list is by
   definition the set of words you are trying to keep off the screen, and syncing
   it would copy it to Google's servers. Switch to chrome.storage.sync here if
   you would rather have cross-device sync (note the 8KB-per-item quota). */
const CR_STORE = (typeof chrome !== 'undefined' && chrome.storage)
  ? chrome.storage.local
  : null;   // MAIN-world injection has no extension APIs; it is handed its config instead

/* Built from a string rather than a regex literal so the escape survives
   verbatim: U+00A0 is whitespace on screen but not to \s. */
const CR_WS = new RegExp('[\\s\\u00a0]+', 'g');

function crLoadConfig() {
  if (!CR_STORE) return Promise.resolve(Object.assign({}, CR_DEFAULTS));
  return new Promise((resolve) => CR_STORE.get(CR_DEFAULTS, (v) => resolve(v)));
}

function crSaveConfig(patch) {
  if (!CR_STORE) return Promise.resolve();
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

/* One list line -> {phrase, replacement}.
 *
 *   Acme Corp                     no replacement; boxed in every mode
 *   Acme Corp/Contoso Ltd         substituted in substitute mode
 *   example.com\/careers/our site  a literal slash in the phrase, escaped
 *
 * The split is on the first unescaped slash, so a replacement may contain
 * slashes freely. An empty replacement ("Acme Corp/") counts as none. */
function crParseEntry(line) {
  const raw = String(line);
  let phrase = '';
  let replacement = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && raw[i + 1] === '/') { phrase += '/'; i++; continue; }
    if (ch === '/') { replacement = raw.slice(i + 1).split('\\/').join('/').trim(); break; }
    phrase += ch;
  }
  phrase = phrase.trim();
  if (!phrase) return null;
  return { phrase, replacement: replacement ? replacement : null };
}

/* Matched text -> replacement lookup key. Whitespace is flattened because a
   phrase may have matched across a newline or a non-breaking space. */
function crMatchKey(text, caseSensitive) {
  const key = String(text).replace(CR_WS, ' ');
  return caseSensitive ? key : key.toLowerCase();
}

function crParseKeywords(cfg) {
  const phrases = [];
  const replacements = new Map();
  for (const line of cfg.keywords || []) {
    const entry = crParseEntry(line);
    if (!entry) continue;
    phrases.push(entry.phrase);
    if (entry.replacement) {
      replacements.set(crMatchKey(entry.phrase, cfg.caseSensitive), entry.replacement);
    }
  }
  return { phrases, replacements };
}

/* One alternation for the whole keyword list, so each run of text costs a single
   regex pass rather than one per keyword. Longest-first, so "John Smith" wins
   over "John". Literal spaces are widened to a whitespace run, which is what
   lets a phrase still match when the page has split it over a newline, source
   indentation, or a non-breaking space. */
function crBuildPatternFrom(phrases, cfg) {
  if (!phrases.length) return null;
  const unique = Array.from(new Set(phrases)).sort((a, b) => b.length - a.length);
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
    console.error('[Keyword Redact] could not build keyword pattern', e);
    return null;
  }
}

function crCompile(cfg) {
  const parsed = crParseKeywords(cfg);
  return { pattern: crBuildPatternFrom(parsed.phrases, cfg), replacements: parsed.replacements };
}

function crBuildPattern(cfg) {
  return crCompile(cfg).pattern;
}

/* "ACME CORP" -> "CONTOSO LTD", "acme corp" -> "contoso ltd". Keeps a
   substitution from standing out purely by its capitalisation. */
function crMimicCase(matched, replacement) {
  const letters = matched.replace(/[^A-Za-z]/g, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(matched) && /^[a-z]/.test(replacement)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  if (/^[a-z]/.test(matched) && /^[A-Z]/.test(replacement)) {
    return replacement.charAt(0).toLowerCase() + replacement.slice(1);
  }
  return replacement;
}


/* ---------------- network response redaction ---------------- */

// URL glob. "*" is the wildcard and the pattern must match the whole URL:
//
//   https://app.example.com/api/*
//   */api/customers*
//
// A pattern with no wildcard at all is treated as "contains", because that is
// what people type and expect. Matching is case-insensitive and always runs
// against the absolute URL -- xhr.open() is usually called with a relative
// path while a fetch Response reports an absolute one, and matching the raw
// argument would silently cover one path and not the other.
function crCompileUrlPattern(raw) {
  const p = String(raw).trim();
  if (!p) return null;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  const source = p.indexOf('*') === -1 ? '.*' + escaped + '.*' : '^' + escaped + '$';
  try {
    return new RegExp(source, 'i');
  } catch (e) {
    return null;
  }
}

function crUrlMatcher(patterns) {
  const compiled = (patterns || []).map(crCompileUrlPattern).filter(Boolean);
  if (!compiled.length) return () => false;   // no patterns means no traffic is touched
  return (url) => {
    const u = String(url || '');
    for (const re of compiled) { re.lastIndex = 0; if (re.test(u)) return true; }
    return false;
  };
}

/* JSON path into a token list.
 *
 *   accountName            a top-level key
 *   contacts[*].name       every element of an array  ([] is accepted for [*])
 *   contacts[0].email      one element
 *   customer               the whole subtree under a key
 *   *.name                 any key at this level
 *   **.email               any depth
 */
function crCompilePath(path) {
  const tokens = [];
  for (const segment of String(path).trim().split('.')) {
    if (!segment) continue;
    const parts = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(segment);
    if (!parts) return null;
    const name = parts[1];
    if (name === '**') tokens.push({ t: 'deep' });
    else if (name === '*') tokens.push({ t: 'any' });
    else if (name) tokens.push({ t: 'key', v: name });
    for (const bracket of parts[2].match(/\[[^\]]*\]/g) || []) {
      const inner = bracket.slice(1, -1).trim();
      if (inner === '' || inner === '*') tokens.push({ t: 'anyIndex' });
      else if (/^\d+$/.test(inner)) tokens.push({ t: 'index', v: parseInt(inner, 10) });
      else return null;
    }
  }
  return tokens.length ? tokens : null;
}

function crCompilePaths(paths) {
  return (paths || []).map(crCompilePath).filter(Boolean);
}

/* ---------------- site access ---------------- */

/* A page URL to the host permission that would cover it.
 *
 *   https://app.example.com/api/x?y  ->  https://app.example.com/*
 *
 * Deliberately the exact host, not *.example.com: the point of granting one
 * site at a time is that it stays narrow. Match patterns cannot carry a port,
 * so the hostname is used rather than the host. Anything that is not http(s)
 * -- chrome://, file://, extension pages, about:blank -- has no grantable
 * pattern and returns null. */
function crOriginPattern(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.protocol + '//' + parsed.hostname + '/*';
}

/* The host part of a match pattern, for display. */
function crPatternLabel(pattern) {
  const p = String(pattern);
  if (p === '*://*/*' || p === '<all_urls>') return 'All sites';
  return p.replace(/^\*:\/\//, '').replace(/^https?:\/\//, '').replace(/\/\*$/, '');
}

function crIsAllSites(pattern) {
  return pattern === '*://*/*' || pattern === '<all_urls>';
}

