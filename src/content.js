'use strict';

/* Runs at document_start in every frame.
 *
 * The anti-flash contract, in order:
 *   1. Hide the page synchronously, before this script yields for anything.
 *      Nothing has been painted yet at document_start, so nothing has leaked.
 *   2. Await settings (storage is async -- this is the only reason a cloak is
 *      needed at all; it normally lasts a couple of milliseconds).
 *   3. Sweep whatever the parser has produced so far, then reveal.
 *   4. Everything after that is caught by the MutationObserver, whose callback
 *      runs as a microtask -- after the mutation, before the paint. Content
 *      streamed in by the parser or injected later is redacted in the same frame
 *      it appears in, so it never becomes visible unredacted.
 */

(() => {
  const root = document.documentElement;
  let cloaked = false;

  const cloak = () => {
    if (!cloaked && root) { root.classList.add('cr-cloak'); cloaked = true; }
  };
  const uncloak = () => {
    if (cloaked && root) { root.classList.remove('cr-cloak'); cloaked = false; }
  };

  cloak();
  // Never leave a page hidden because of a bug, a hung storage read, or a
  // keyword list that throws.
  let failsafe = setTimeout(uncloak, CR_DEFAULTS.cloakTimeoutMs);

  let redactor = null;
  let config = null;

  const enabledHere = (cfg) => cfg.enabled && crSiteAllowed(cfg, location.hostname);

  /* Hand the config to the MAIN-world network hook, if it is installed. It has
     no extension APIs of its own, and it holds requests back until this
     arrives, so a response can never be delivered before it can be redacted.
     A JSON string, because object payloads do not reliably survive a
     CustomEvent crossing the world boundary. */
  /* Everything the MAIN-world hook needs, compiled HERE and sent as plain data:
     regex sources, a replacements array, JSON path token arrays. The hook is a
     single self-contained file precisely because a second injected file could
     not be relied on to execute in the page context -- so nothing crosses the
     boundary as code.

     Dispatched on EVERY page, including ones where redaction is off or the site
     is excluded. The hook holds requests until briefed, so staying silent would
     hang every request on the page rather than leaving it unredacted. */
  const briefNetworkHook = (cfg) => {
    let brief = { active: false };

    if (cfg && cfg.network && enabledHere(cfg)) {
      const compiled = crCompile(cfg);
      const urlPatterns = (cfg.networkUrls || [])
        .map(crCompileUrlPattern)
        .filter(Boolean)
        .map((re) => re.source);

      // Both are required: no phrases means nothing to redact, no URL patterns
      // means no traffic is in scope.
      if (compiled.pattern && urlPatterns.length) {
        brief = {
          active: true,
          pattern: { source: compiled.pattern.source, flags: compiled.pattern.flags },
          replacements: Array.from(compiled.replacements.entries()),
          urlPatterns,
          paths: crCompilePaths(cfg.networkPaths),
          mode: cfg.mode,
          mimicCase: cfg.mimicCase,
          caseSensitive: cfg.caseSensitive
        };
      }
    }

    document.dispatchEvent(new CustomEvent('cr-redactor-net', {
      detail: JSON.stringify(brief)
    }));
  };

  const run = (cfg) => {
    config = cfg;
    briefNetworkHook(cfg);
    if (!enabledHere(cfg)) return;
    redactor = new CRRedactor(cfg);
    redactor.start(document);
  };

  const teardown = () => {
    if (!redactor) return;
    redactor.stop();
    redactor.restore();
    redactor = null;
  };

  crLoadConfig()
    .then((cfg) => {
      clearTimeout(failsafe);
      if (cfg.cloak && enabledHere(cfg)) {
        failsafe = setTimeout(uncloak, cfg.cloakTimeoutMs);
      } else {
        uncloak();
      }
      run(cfg);
    })
    .catch((err) => {
      console.error('[Redactor]', err);
      briefNetworkHook(null);   // release the network hook's hold
    })
    .finally(() => {
      clearTimeout(failsafe);
      uncloak();
    });

  /* Settings changes apply to open tabs without a reload: undo everything, then
     redo it under the new config. All synchronous, so nothing is painted
     half-redacted in between. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !config) return;
    crLoadConfig().then((cfg) => {
      teardown();
      run(cfg);
    });
  });
})();
