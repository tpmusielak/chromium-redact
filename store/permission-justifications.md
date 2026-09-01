# Chrome Web Store listing copy

Paste-ready text for the Privacy tab of the developer dashboard. One section per
field. Keep this in step with manifest.json when permissions change.

**Privacy policy URL** (paste into the dashboard's Privacy policy field):

    https://tpmusielak.github.io/chromium-redact/

Served by GitHub Pages from `docs/` on `main` — see docs/index.html, which is the
single source of truth for the policy text.

---

## Single purpose

> Keyword Redact hides a user-supplied list of keywords from web pages as they
> render, so that sensitive words are not visible on screen during screen
> sharing, screenshots, or presentations. That is its only function.

---

## Permission justifications

### `storage`

> Stores the user's own settings — their keyword list, redaction mode, and the
> list of sites they have granted access to. This is written with
> `chrome.storage.local` only, never `chrome.storage.sync`, so the keyword list
> stays on the user's machine and is never copied to Google's servers. Nothing
> else is stored and nothing is transmitted anywhere.

### `scripting`

> The extension registers its redaction content script only for the specific
> origins the user has explicitly granted from the popup. Because site access is
> entirely opt-in, the script list has to be built at runtime via
> `chrome.scripting.registerContentScripts` rather than declared statically in
> the manifest — a static `content_scripts` block would force host access to be
> granted at install time, which is exactly what this extension avoids.

### `activeTab`

> Lets the popup read the current tab's origin so it can show which site you are
> on and offer a one-click "grant access to this site" button. Without it the
> popup cannot tell the user which origin they are about to grant.

### Host permissions (`*://*/*`, optional)

> Declared as `optional_host_permissions`, so **no site access is requested or
> granted at install time** — the install prompt asks for no site access at all,
> and the extension is completely inert until the user grants a specific origin
> from the popup. The pattern is broad only because redaction is a user choice
> that can apply to any site they pick; the extension cannot know in advance
> which sites a given user wants redacted. Access is granted one origin at a
> time by the user, and revoking it in Chrome's settings immediately
> unregisters the content script for that origin.

### Remote code

> No. All code is contained in the package. There is no `eval`, no `new
> Function`, no remotely hosted script, and no network request of any kind made
> by the extension.

---

## Reviewer note (worth adding to the submission notes field)

> Two things a reviewer may flag, explained up front:
>
> 1. **Broad optional host pattern.** Nothing is granted at install. Site access
>    is requested per-origin at runtime through `chrome.permissions.request`,
>    driven by the user clicking a button in the popup. See `src/background.js`,
>    which rebuilds the content-script registrations from
>    `chrome.permissions.getAll()` and registers nothing when no origin has been
>    granted.
>
> 2. **`MAIN` world injection.** The optional network-redaction feature injects
>    `src/net.js` into the page's main world in order to wrap `XMLHttpRequest`
>    and `fetch` so keyword matches can be redacted out of API responses before
>    the page renders them. This is used purely to hook page-level APIs — it does
>    not fetch, evaluate, or execute any code from outside the package. The
>    feature is off by default and stays inert unless the user both enables it
>    and supplies URL patterns.

---

## Data-use disclosures

All three certification checkboxes can be answered truthfully:

- **I do not sell or transfer user data to third parties** outside of approved use cases — ✅
- **I do not use or transfer user data for purposes unrelated to my item's single purpose** — ✅
- **I do not use or transfer user data to determine creditworthiness or for lending purposes** — ✅

Every "data collected" category should be left **unchecked**. The extension
collects nothing and transmits nothing.
