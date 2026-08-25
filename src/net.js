'use strict';

/* Network response redaction. Runs in the MAIN world, because XMLHttpRequest
 * and fetch live on the page's own prototypes -- patching them from the
 * isolated world would only patch our own copies.
 *
 * SELF-CONTAINED ON PURPOSE. This is the only file injected into the page
 * context. An earlier version also injected config.js and called into it, which
 * failed on real installs in two different ways: MAIN-world injection wraps
 * each file so top-level declarations are not shared, and then config.js turned
 * out not to execute in the page context at all. Rather than keep diagnosing
 * the page context from outside it, the dependency is gone. Everything needed
 * at runtime is either defined below or arrives as plain data in the brief, so
 * there is no second file whose absence, ordering or scoping can break this one.
 *
 * The isolated-world content script does all the compiling -- phrase pattern,
 * URL patterns, JSON paths -- and sends the results as strings and arrays.
 * Rebuilding a RegExp from a string is not eval and stays within page CSP.
 *
 * Registered dynamically by the service worker and only while the feature is
 * switched on, so a user who never enables it never gets MAIN-world injection.
 * That matters: anything here is readable by the page, including the phrases.
 *
 * Unlike the DOM engine this rewrites application data, not its presentation.
 * Hence the two hard narrowings: nothing happens without URL patterns, and JSON
 * paths restrict which fields are touched.
 */

(() => {
  if (window.__crNetInstalled) return;
  window.__crNetInstalled = true;

  /* ---------------- pure helpers ----------------
     matchKey and mimicCase mirror the versions in config.js that the DOM engine
     uses. They cannot be shared across the world boundary, so net-tests.js
     asserts the two implementations agree on a table of inputs. */

  // Built from a string rather than a regex literal so the escape survives
  // verbatim: U+00A0 is whitespace on screen but not to \s.
  const WS = new RegExp('[\\s\\u00a0]+', 'g');

  function matchKey(text, caseSensitive) {
    const key = String(text).replace(WS, ' ');
    return caseSensitive ? key : key.toLowerCase();
  }

  function mimicCase(matched, replacement) {
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

  function looksJson(contentType, body) {
    if (contentType && contentType.indexOf('json') !== -1) return true;
    return /^\s*[{[]/.test(body || '');
  }

  /* Bodies worth reading as text at all. Anything else passes through untouched
     rather than being buffered and rebuilt for nothing. */
  function textualContentType(contentType) {
    if (!contentType) return true;                       // servers do omit it
    const ct = String(contentType).toLowerCase();
    return ct.indexOf('json') !== -1
      || ct.indexOf('text/') === 0
      || ct.indexOf('xml') !== -1
      || ct.indexOf('x-www-form-urlencoded') !== -1
      || ct.indexOf('javascript') !== -1;
  }

  /* Collection, then application. Gathering [parent, key] targets first means a
     value reachable by two paths (or by both branches of a "**") is redacted
     once, not twice -- which matters in substitute mode, where a stand-in run
     through the pattern a second time could itself be replaced. */
  function collectAll(parent, key, targets) {
    const node = parent[key];
    if (typeof node === 'string') {
      let keys = targets.get(parent);
      if (!keys) targets.set(parent, (keys = new Set()));
      keys.add(key);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectAll(node, i, targets);
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) collectAll(node, k, targets);
    }
  }

  function collectPath(parent, key, tokens, i, targets) {
    const node = parent[key];
    if (node == null) return;
    if (i >= tokens.length) { collectAll(parent, key, targets); return; }

    const token = tokens[i];

    if (token.t === 'deep') {
      collectPath(parent, key, tokens, i + 1, targets);         // match zero levels
      if (Array.isArray(node)) {
        for (let k = 0; k < node.length; k++) collectPath(node, k, tokens, i, targets);
      } else if (typeof node === 'object') {
        for (const k of Object.keys(node)) collectPath(node, k, tokens, i, targets);
      }
      return;
    }

    if (token.t === 'anyIndex' || token.t === 'index') {
      if (!Array.isArray(node)) return;
      if (token.t === 'index') {
        if (token.v < node.length) collectPath(node, token.v, tokens, i + 1, targets);
      } else {
        for (let k = 0; k < node.length; k++) collectPath(node, k, tokens, i + 1, targets);
      }
      return;
    }

    if (Array.isArray(node) || typeof node !== 'object') return;
    if (token.t === 'any') {
      for (const k of Object.keys(node)) collectPath(node, k, tokens, i + 1, targets);
    } else if (Object.prototype.hasOwnProperty.call(node, token.v)) {
      collectPath(node, token.v, tokens, i + 1, targets);
    }
  }

  /* Redacts string VALUES only -- never keys, never numbers. A blanket regex
     over the raw JSON text would rewrite keys too, and would break parsing
     outright if a stand-in contained a quote or a backslash. */
  function redactJson(root, compiledPaths, redact) {
    const box = { root };
    const targets = new Map();
    if (!compiledPaths.length) collectAll(box, 'root', targets);
    else for (const tokens of compiledPaths) collectPath(box, 'root', tokens, 0, targets);

    for (const [parent, keys] of targets) {
      for (const key of keys) {
        const value = parent[key];
        if (typeof value === 'string') parent[key] = redact(value);
      }
    }
    return box.root;
  }

  /* ---------------- state ---------------- */

  let pattern = null;
  let replacements = new Map();
  let urlMatchers = [];
  let paths = [];
  let mode = 'overlay';
  let useMimicCase = true;
  let caseSensitive = false;
  let ready = false;
  const waiting = [];

  /* Requests are held until the brief arrives so a response can never be
     delivered while we are unable to redact it -- but a hold that never
     releases would hang every request on the page. It releases on the brief
     arriving, on an unreadable brief, or on this timeout. Passing traffic
     through is the lesser failure against breaking the page outright, and it is
     announced rather than silent. */
  const HOLD_TIMEOUT_MS = 2000;

  function release() {
    ready = true;
    while (waiting.length) waiting.shift()();
  }

  const holdTimer = setTimeout(() => {
    if (ready) return;
    console.warn('[Redactor] network hook: no configuration after '
      + HOLD_TIMEOUT_MS + 'ms; passing traffic through unredacted.');
    release();
  }, HOLD_TIMEOUT_MS);

  const whenReady = () => (ready ? Promise.resolve() : new Promise((r) => waiting.push(r)));

  function standDown() {
    pattern = null;
    replacements = new Map();
    urlMatchers = [];
    paths = [];
  }

  /* The isolated-world content script briefs us on every page, including ones
     where redaction is off or the site is excluded -- an inert brief releases
     the hold with no URL patterns, so traffic simply passes through. The
     payload is a JSON string of plain data: object payloads do not reliably
     survive a CustomEvent crossing the world boundary, strings do. */
  document.addEventListener('cr-redactor-net', (event) => {
    try {
      const brief = JSON.parse(event.detail);
      if (!brief || !brief.active) {
        standDown();
      } else {
        pattern = new RegExp(brief.pattern.source, brief.pattern.flags);
        replacements = new Map(brief.replacements || []);
        urlMatchers = (brief.urlPatterns || []).map((source) => new RegExp(source, 'i'));
        paths = brief.paths || [];
        mode = brief.mode;
        useMimicCase = !!brief.mimicCase;
        caseSensitive = !!brief.caseSensitive;
      }
    } catch (e) {
      console.error('[Redactor] network hook: unusable brief; passing traffic through.', e);
      standDown();
    }
    clearTimeout(holdTimer);
    release();
  });

  /* ---------------- redaction ---------------- */

  function matchesUrl(url) {
    if (!urlMatchers.length) return false;   // no patterns means no traffic is touched
    const u = String(url || '');
    for (const re of urlMatchers) {
      re.lastIndex = 0;
      if (re.test(u)) return true;
    }
    return false;
  }

  function swap(matched) {
    if (mode === 'substitute') {
      const value = replacements.get(matchKey(matched, caseSensitive));
      if (value !== undefined) return useMimicCase ? mimicCase(matched, value) : value;
    }
    return '█'.repeat(matched.length);
  }

  function redactText(text) {
    pattern.lastIndex = 0;
    return String(text).replace(pattern, swap);
  }

  function redactBody(text, contentType) {
    if (!pattern || !text) return text;
    if (looksJson(contentType, text)) {
      try {
        return JSON.stringify(redactJson(JSON.parse(text), paths, redactText));
      } catch (e) {
        /* not valid JSON after all -- fall through */
      }
    }
    // Paths are a JSON concept. If the author narrowed to specific fields and
    // the body is not JSON, honour the narrowing rather than redacting all of it.
    return paths.length ? text : redactText(text);
  }

  /* ---------------- XMLHttpRequest ---------------- */

  const xhrUrl = new WeakMap();
  const xhrCache = new WeakMap();

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    let absolute = String(url);
    try {
      absolute = new URL(absolute, document.baseURI).href;
    } catch (e) { /* keep the raw value */ }
    xhrUrl.set(this, absolute);
    return nativeOpen.apply(this, arguments);
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (ready) return nativeSend.apply(this, arguments);
    const self = this;
    const args = arguments;
    whenReady().then(() => nativeSend.apply(self, args));
  };

  function patchResponseGetter(name, transform) {
    const native = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, name);
    if (!native || !native.get) return;
    Object.defineProperty(XMLHttpRequest.prototype, name, {
      configurable: true,
      enumerable: native.enumerable,
      get() {
        const raw = native.get.call(this);
        if (!ready || !pattern || raw == null || !matchesUrl(xhrUrl.get(this) || '')) return raw;

        // Reads are synchronous and often repeated (and repeated during
        // LOADING, as the body grows), so memoise against the raw value.
        let entry = xhrCache.get(this);
        if (!entry) xhrCache.set(this, (entry = {}));
        const slot = entry[name];
        if (slot && slot.raw === raw) return slot.out;

        let out;
        try {
          out = transform(raw, this);
        } catch (e) {
          out = raw;
        }
        entry[name] = { raw, out };
        return out;
      }
    });
  }

  const contentTypeOf = (xhr) => {
    try {
      return xhr.getResponseHeader('content-type') || '';
    } catch (e) {
      return '';
    }
  };

  patchResponseGetter('responseText', (raw, xhr) => redactBody(raw, contentTypeOf(xhr)));

  patchResponseGetter('response', (raw, xhr) => {
    const type = xhr.responseType;
    if (type === '' || type === 'text') return redactBody(raw, contentTypeOf(xhr));
    if (type === 'json') return redactJson(raw, paths, redactText);
    // arraybuffer / blob / document are left alone; see the README.
    return raw;
  });

  /* ---------------- fetch ---------------- */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function (input, init) {
      if (!ready) await whenReady();
      const response = await nativeFetch.apply(this, arguments);
      if (!pattern) return response;

      let url = response.url;
      if (!url) {
        try {
          const raw = input && input.url ? input.url : String(input);
          url = new URL(raw, document.baseURI).href;
        } catch (e) { /* leave it empty; it simply will not match */ }
      }
      if (!matchesUrl(url)) return response;

      // Opaque and null-body responses have nothing to read, and the Response
      // constructor rejects a body for 204/205/304.
      if (response.type === 'opaque' || response.body === null) return response;
      if (response.status === 204 || response.status === 205 || response.status === 304) return response;

      const contentType = response.headers.get('content-type') || '';
      if (!textualContentType(contentType)) return response;

      let body;
      try {
        body = await response.clone().text();
      } catch (e) {
        return response;
      }

      const redacted = redactBody(body, contentType);
      if (redacted === body) return response;

      const rebuilt = new Response(redacted, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      // These are read-only on a constructed Response, so a page reading
      // res.url or checking res.type would otherwise see the wrong thing.
      for (const prop of ['url', 'redirected', 'type']) {
        try {
          Object.defineProperty(rebuilt, prop, { value: response[prop] });
        } catch (e) { /* non-fatal */ }
      }
      return rebuilt;
    };
  }

  /* Test hook, opt-in via an attribute the harness sets, so production pages get
     no extra surface. These are pure functions holding no configuration. */
  if (document.documentElement && document.documentElement.hasAttribute('data-cr-test')) {
    window.__crNetInternals = { matchKey, mimicCase, looksJson, textualContentType, redactJson };
  }
})();
