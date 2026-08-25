# Redactor

A Chrome (MV3) extension that hides a list of phrases on every page you visit, as the page renders.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (Chrome 111 or newer)
3. **Load unpacked** → select this folder
4. Click the extension icon → **Phrases & options**, and add some phrases

## The list

One phrase per line. Matching is literal — no regular expressions.

```
Acme Corp/Contoso Ltd
project bluebird/project kestrel
j.smith@example.com/a.jones@example.net
internal-only-codename
example.com\/careers/our jobs page
```

Anything after the first unescaped `/` is the **stand-in text** used by substitute mode. A line without one still works everywhere — it just gets a box instead of a stand-in. Replacements may contain slashes freely; to put a literal slash in the *phrase*, escape it as `\/`.

The same list drives all three modes, so switching modes never means editing it.

## The three modes

| | Overlay | Replace | Substitute |
|---|---|---|---|
| What happens to the text | Stays in the DOM, painted over | Deleted from the DOM | Deleted, stand-in text put in its place |
| Layout | Untouched | Preserved via a measured-width box | Reflows to fit the stand-in |
| Selectable / copyable | Yes (unless "block selecting" is on) | Nothing to select | Yes — the stand-in |
| Visible in DevTools / view-source | Yes | No | No |
| Page's own scripts see | The original text | The redacted version | The stand-in |
| Reads as prose | No | No | Yes |

**Overlay** is the compatible choice: the page behaves exactly as it did, and only the pixels change. Its weakness is that the text is still there for anyone who looks past the pixels.

**Replace** is a real removal. The original only ever exists in the extension's own memory (a `WeakMap` keyed by the replacement span), never in the page — which is also what lets a settings change un-redact an open tab without a reload. The cost is that a page reading its own `textContent` sees the redacted version. Two fills: a solid bar sized to the exact pixel width the text would have taken, or repeated `█` counted to the nearest equivalent width.

**Substitute** swaps each phrase for its stand-in, so the page still reads as prose — the point being a screenshot or a demo that looks like a real page rather than a censored one. Phrases with no stand-in fall back to a box, so one list can mix "make this look plausible" with "just hide this".

Two options apply to substitute mode:

- **Follow capitalisation** (on by default) — `ACME CORP` becomes `CONTOSO LTD`, `acme corp` becomes `contoso ltd`, so a stand-in doesn't give itself away by its case.
- **Faint dotted underline** (off by default) — leaves a visible sign that a swap happened. Worth turning on if you'll be *reading* the page rather than only showing it, because a plain substitution silently changes what the page appears to say, including for you.

A phrase split across elements (`<strong>Acme</strong> <strong>Corp</strong>`) is substituted once, not once per fragment: the leading segment carries the stand-in and the rest collapse to nothing.

Bars take their colour from `currentColor`, so they follow the surrounding text and stay visible on dark themes instead of reading as a hole in the layout.

## How the flash is avoided

This is the part that's easy to get wrong, so it's worth being explicit about the ordering:

1. **`document_start`, synchronously**: add a `cr-cloak` class to `<html>`, whose `visibility: hidden` rule arrives with the manifest-injected CSS. Nothing has painted yet, so nothing has leaked.
2. **Read settings.** `chrome.storage` is async, and this is the *only* reason a cloak is needed at all. It typically lasts a couple of milliseconds. A failsafe timer (default 1500ms) guarantees the page is never left hidden by a bug or a hung read.
3. **Sweep whatever the parser has produced**, then reveal.
4. **Everything after that is the `MutationObserver`.** Its callback is a microtask: it runs after the mutation but *before* the browser paints that frame. Content streamed in by the parser or injected later by scripts is redacted in the same frame it appears in, so it is never painted unredacted.

Step 4 is why the observer callback is **synchronous and deliberately not debounced**. Deferring the work to a `setTimeout` or `requestAnimationFrame` — the usual reflex for "make it cheaper" — is exactly what puts the flash back. The cheapness has to come from elsewhere.

## How it stays fast

Measured in Chrome on a synthetic 4000-paragraph page (~900KB of text, 8000 elements, 16,887 matches — a redaction every ~55 characters, far denser than any real page):

| Scenario | Time |
|---|---|
| Full sweep, no matches (the common case) | **6–10 ms** |
| Full sweep, overlay | 60–90 ms |
| Full sweep, substitute | 84 ms |
| Full sweep, replace (measures every bar) | 107–138 ms |
| Appending 200 paragraphs to the already-redacted page | ~15 ms total |

That last row is the important one: mutations are scoped to what changed, so appending to a long list doesn't rescan the list.

The techniques that get there:

- **One regex for the whole list.** Phrases compile to a single alternation, longest-first, so each run of text costs one pass rather than one per phrase.
- **Text runs, not text nodes.** Text is grouped into runs uncrossed by a block boundary and matched as one string. This is both fewer regex calls *and* what makes `John<b>Smith</b>` matchable.
- **Reads and writes never interleave.** Each pass is collect → measure (computed styles, canvas) → apply. Mixing them would force a synchronous reflow per redaction; this costs at most one per batch. Substitute mode measures only the phrases that fall back to a box.
- **Mutations are scoped to what changed.** An added block element is scanned on its own; only inline or bare-text insertions widen to the enclosing block.
- **Our own writes are dropped.** `observer.takeRecords()` at the end of each synchronous callback discards the records our edits just queued, so there's no feedback loop — including when a stand-in happens to contain a listed phrase.
- **Caches** for computed fonts (`WeakMap` per element) and text measurements. Stand-ins are found by a `Map` lookup on the matched text, so identifying which list entry fired costs nothing per match.

Boxes created before stylesheets and webfonts settled were measured against the wrong font, so widths are recomputed on `document.fonts.ready`, on `load`, and on a debounced `resize`.

## Styling

The settings page and popup follow **BlueprintJS**: the Blueprint 5 core palette, the 10px
grid, 30px controls, 2px radii, the elevation shadows, and the real control anatomy
(gradient-sheened indicators, radial-gradient radio dots, 28x16 switches, intent-primary
buttons). Both themes are covered -- light on `#f6f7f9`, dark on `#252a31` -- switched by
`prefers-color-scheme`.

It is hand-rolled in `src/ui.css` rather than vendored. The extension CSP blocks CDN
stylesheets, so Blueprint would have to be bundled, and the full `blueprint.css` is ~250KB
for a settings page and a popup that between them use a dozen components. The tokens live in
CSS custom properties, so swapping in the real stylesheet later is a matter of renaming
classes, not rewriting layout.

The in-page redaction marks in `src/redact.css` are deliberately **not** Blueprint-styled.
They have to blend into whatever site you are looking at, which is why bars take their colour
from `currentColor` rather than from a fixed palette -- a Blueprint blue-gray box would look
like a rendering fault on a page that isn't a Blueprint app.

## Network responses (advanced, off by default)

Everything above changes how a page *looks*. This changes the data the page *receives*:
XMLHttpRequest and fetch responses are redacted in flight, before the application ever sees
them. That makes it the cleanest answer to content the DOM engine cannot reach -- a chart
drawn into a `<canvas>` never receives the name in the first place.

It is narrowed two ways, and both matter:

**URL patterns** decide which requests are touched. Nothing happens without them; there is no
"all traffic" option.

```
https://app.example.com/api/*
*/api/customers*
/api/orders
```

`*` is a wildcard and the pattern must match the whole URL. A line with no wildcard is
treated as "contains", because that is what people type. Matching is case-insensitive and
always runs against the **absolute** URL -- `xhr.open()` is normally called with a relative
path while a fetch `Response` reports an absolute one, so matching the raw argument would
silently cover one path and not the other.

**JSON paths** decide which fields inside a matched response are touched.

```
accountName             a top-level field
contacts[*].name        every element   (contacts[0].name for one)
customer                a key names its whole subtree
*.name                  any key at that level
**.email                any depth
```

Leave it empty to redact every string value in the body. Keys and numbers are never touched,
so the payload still parses and property lookups still work. If you set paths and the
response is not JSON, it is left alone -- paths are a JSON concept, and ignoring them would
defeat the narrowing you asked for.

Redaction is structure-aware: the body is parsed, string values are rewritten, and it is
re-serialised. A blanket regex over the raw JSON text would rewrite keys too, and would break
parsing outright if a stand-in contained a quote or a backslash. Values reachable by two
paths are redacted once, not twice.

### The MAIN world is not the isolated world

`net.js` is a **single self-contained file** with no dependency on any other. That is not
tidiness, it is the fix for two bugs that only appeared on a real install.

It originally injected `config.js` alongside it and called into it. First that failed because
MAIN-world injection wraps each file, so `config.js`'s top-level declarations were not visible
-- isolated-world content scripts share the world's global object, MAIN-world ones do not.
Exporting explicitly via `window` did not fix it either: `config.js` turned out not to execute
in the page context at all.

Rather than keep diagnosing the page context from outside it, the dependency is gone. The
isolated-world content script does all the compiling -- phrase pattern, URL patterns, JSON
paths -- and sends the results as **plain data**: regex sources, an array of replacement
pairs, arrays of path tokens. Nothing crosses the boundary as code. Rebuilding a `RegExp` from
a string is not eval, so it stays within page CSP.

`net.js` keeps private copies of two small helpers (`matchKey`, `mimicCase`) that the DOM
engine also needs and that cannot be shared across the boundary. Tests assert the two
implementations do not drift, and that `config.js`'s path compiler emits exactly the token
shape `net.js` reads.

Three tests pin this, all of which would have caught the shipped bugs:

- `test/net-solo-harness.html` runs the whole suite with **`net.js` and nothing else loaded**.
- A scan asserts `net.js` contains no reference to any `cr*`/`CR_*` identifier at all -- the
  normal harness loads both files as ordinary page scripts where they *do* share globals, so
  the mistake would pass there and fail only once installed.
- A check that the service worker registers exactly one file.

**A hold that never releases hangs the page.** `send()` and `fetch` wait for the brief so a
response cannot arrive before it can be redacted. If the brief never comes, every request on
the page hangs forever. It releases on the brief arriving, on an unreadable brief, or after
2s. The content script also briefs the hook on *every* page, including ones where redaction is
off or the site is excluded -- an inert brief carries no URL patterns, so traffic passes
through instead of stalling. Passing traffic through unredacted is the lesser failure against
breaking the page, and it is logged rather than silent.

### What it costs

- **You are corrupting application data, not its presentation.** A redacted identifier may
  404. In substitute mode an application may write the stand-in back to the server or into
  local storage. This is why the URL list is mandatory and the paths exist.
- **It does not clean the DevTools Network panel.** The hook runs after the browser has the
  response. Chrome offers no way around this: `webRequest` cannot rewrite bodies
  (`filterResponseData` is Firefox-only) and `declarativeNetRequest` only does blocking,
  redirects and headers.
- **The page can read your phrase list.** The hook has to run in the MAIN world, because
  `XMLHttpRequest` and `fetch` live on the page's own prototypes -- patching them from the
  isolated world would only patch our copies. So the script is registered dynamically by the
  service worker and only while the feature is on: users who never enable it never get
  MAIN-world injection at all.
- **Enabling or disabling takes effect on the next page load**, since registration is what
  changes, not the page.

Out of reach: requests made from Workers and ServiceWorkers (separate globals), `EventSource`,
WebSocket frames, `responseType` of `blob`/`arraybuffer`/`document`, and streaming consumers
using `res.body.getReader()` -- buffering those would break streaming semantics, which is
another reason to scope by URL.

Requests issued before the config arrives are held rather than leaked: `send()` and `fetch`
wait on the config handshake, which lands within a millisecond or two of `document_start`,
long before any request could complete.

## Limitations

- **Not a security boundary.** Anyone at this browser can read the original via DevTools, view-source, the network tab, or by disabling the extension. This is for screen sharing, demos, and shoulder-surfing — not for withholding data from the person at the keyboard.
- **Substitute mode changes what the page appears to say.** That is the feature, but it also means you can mislead yourself. The dotted-underline option exists for that reason.
- **No DOM, no redaction.** Text baked into `<canvas>`, WebGL, video, images, or the built-in PDF viewer is unreachable to the DOM engine. Where that content comes from an API response, network redaction reaches it before it is drawn.
- **Skipped on purpose:** `contenteditable` regions and `<textarea>` (redacting what you're typing corrupts your own input), SVG and MathML (an HTML `<span>` wouldn't render there), `<option>` text, and closed shadow roots.
- **Matching is ASCII word-boundary based** when "whole words only" is on, so non-Latin scripts are better served with that setting off.
- **Framework hydration.** Modifying the DOM before React/Vue hydrate can cause a mismatch on some sites. All three modes carry this risk; overlay is the gentlest.

## Files

```
manifest.json        MV3 manifest; content script at document_start, all frames
src/config.js        defaults, storage, list parsing, phrase → regex compilation
src/engine.js        the redaction engine (collect / measure / apply, observer)
src/content.js       per-frame bootstrap and the cloak ordering
src/redact.css       cloak rule + redaction styles, injected at document_start
src/background.js    service worker; registers the network hook only while it is on
src/net.js           MAIN-world XHR/fetch redaction; self-contained, no imports
src/options.html|js  full settings
src/popup.html|js    quick toggles: on/off, per-site, mode
src/ui.css           Blueprint-flavoured styling for options and popup
test/harness.html    57 engine tests — serve the folder and open it
test/net-harness.html 65 network tests (URL patterns, JSON paths, XHR, fetch)
test/net-solo-harness.html   the same suite with net.js and nothing else loaded
test/demo.html       side-by-side of all five treatments
test/ui-preview.html the options page and popup with chrome.* stubbed
```

Phrases are stored in `chrome.storage.local`, not `.sync`, deliberately: the list *is* the sensitive data, and syncing would copy it to Google's servers. One line in `src/config.js` changes that if you'd rather have cross-device sync.

## Running the tests

```bash
python -m http.server 8731
```

Then open `http://localhost:8731/test/harness.html` (engine tests), `http://localhost:8731/test/net-harness.html` and `net-solo-harness.html` (network tests) and `http://localhost:8731/test/demo.html` (visual comparison). Both stub the `chrome.*` APIs, so no extension install is needed.
