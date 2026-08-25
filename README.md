# Redactor

A Chrome (MV3) extension that hides a list of keywords on every page you visit, as the page renders.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder
4. Click the extension icon → **Keywords & options**, and add some keywords

## The two modes

| | Overlay | Replace |
|---|---|---|
| What happens to the text | Stays in the DOM, painted over | Deleted from the DOM |
| Layout | Untouched | Preserved via a measured-width box |
| Selectable / copyable | Yes (unless "block selecting" is on) | Nothing to select |
| Visible in DevTools / view-source | Yes | No |
| Page's own scripts see | The original text | The redacted version |

**Overlay** is the compatible choice: the page behaves exactly as it did, and only the pixels change. Its weakness is that the text is still there for anyone who looks past the pixels.

**Replace** is a real removal. The original only ever exists in the extension's own memory (a `WeakMap` keyed by the replacement span), never in the page, which is also what lets settings changes un-redact an open tab without a reload. The cost is that a page reading its own `textContent` sees the redacted version — mostly harmless, occasionally not.

Replace mode offers two fills: a solid bar sized to the exact pixel width the text would have taken, or repeated `█` characters counted to the nearest equivalent width.

Bars take their colour from `currentColor`, so they follow the surrounding text and stay visible on dark themes instead of reading as a hole in the layout.

## How the flash is avoided

This is the part that's easy to get wrong, so it's worth being explicit about the ordering:

1. **`document_start`, synchronously**: add a `cr-cloak` class to `<html>`, whose `visibility: hidden` rule arrives with the manifest-injected CSS. Nothing has painted yet, so nothing has leaked.
2. **Read settings.** `chrome.storage` is async, and this is the *only* reason a cloak is needed at all. It typically lasts a couple of milliseconds. A failsafe timer (default 1500ms) guarantees the page is never left hidden by a bug or a hung read.
3. **Sweep whatever the parser has produced**, then reveal.
4. **Everything after that is the `MutationObserver`.** Its callback is a microtask: it runs after the mutation but *before* the browser paints that frame. Content streamed in by the parser or injected later by scripts is redacted in the same frame it appears in, so it is never painted unredacted.

Step 4 is why the observer callback is **synchronous and deliberately not debounced**. Deferring the work to a `setTimeout` or `requestAnimationFrame` — the usual reflex for "make it cheaper" — is exactly what puts the flash back.

## How it stays fast

Measured in Chrome on a synthetic 4000-paragraph page (~900KB of text, 8000 elements):

| Scenario | Time |
|---|---|
| Full sweep, no keyword matches (the common case) | **6–10 ms** |
| Full sweep, 16,887 matches, overlay | **89 ms** |
| Full sweep, 16,887 matches, replace (includes measuring every bar) | **138 ms** |
| Appending 200 new paragraphs to the already-redacted page | **~15 ms total** |

The techniques that get there:

- **One regex for the whole keyword list.** Keywords compile to a single alternation, longest-first, so each run of text costs one pass rather than one per keyword.
- **Text runs, not text nodes.** Text is grouped into runs uncrossed by a block boundary and matched as one string. This is both fewer regex calls *and* what makes `John<b>Smith</b>` matchable.
- **Reads and writes never interleave.** Each pass is collect → measure (computed styles, canvas) → apply. Mixing them would force a synchronous reflow per redaction; this costs at most one per batch.
- **Mutations are scoped to what changed.** An added block element is scanned on its own; only inline or bare-text insertions widen to the enclosing block. Appending to a long list therefore doesn't rescan the list.
- **Our own writes are dropped.** `observer.takeRecords()` at the end of each synchronous callback discards the records our edits just queued, so there's no feedback loop.
- **Caches** for computed fonts (`WeakMap` per element) and text measurements.

Replace-mode bars created before stylesheets and webfonts settled were measured against the wrong font, so widths are recomputed once on `document.fonts.ready`, once on `load`, and on a debounced `resize`.

## Limitations

- **Not a security boundary.** Anyone at this browser can read the original via DevTools, view-source, the network tab, or by disabling the extension. This is for screen sharing, demos, and shoulder-surfing — not for withholding data from the person at the keyboard.
- **No DOM, no redaction.** Text baked into `<canvas>`, WebGL, video, images, or the built-in PDF viewer is unreachable.
- **Skipped on purpose:** `contenteditable` regions and `<textarea>` (redacting what you're typing corrupts your own input), SVG and MathML (an HTML `<span>` wouldn't render there), `<option>` text, and closed shadow roots.
- **Matching is ASCII word-boundary based** when "whole words only" is on, so non-Latin scripts are better served with that setting off.
- **Framework hydration.** Modifying the DOM before React/Vue hydrate can cause a mismatch on some sites. Both modes carry this risk; overlay is the gentler of the two.
- Keywords are matched **literally** — no regular expressions in the UI.

## Files

```
manifest.json        MV3 manifest; content script at document_start, all frames
src/config.js        defaults, storage, keyword → regex compilation
src/engine.js        the redaction engine (collect / measure / apply, observer)
src/content.js       per-frame bootstrap and the cloak ordering
src/redact.css       cloak rule + redaction styles, injected at document_start
src/options.html|js  full settings
src/popup.html|js    quick toggles: on/off, per-site, mode
src/ui.css           shared styling for options and popup
test/harness.html    32 engine tests — serve the folder and open it
test/demo.html       side-by-side of all four treatments
```

Keywords are stored in `chrome.storage.local`, not `.sync`, deliberately: the keyword list *is* the sensitive data, and syncing would copy it to Google's servers. One line in `src/config.js` changes that if you'd rather have cross-device sync.

## Running the tests

```bash
python -m http.server 8731
```

Then open `http://localhost:8731/test/harness.html` (engine tests) and `http://localhost:8731/test/demo.html` (visual comparison). Both stub the `chrome.*` APIs, so no extension install is needed.
