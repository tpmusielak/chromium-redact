'use strict';

importScripts('config.js');

/* Site access is opt-in. The manifest requests no host permissions at all, so a
 * fresh install can read nothing: the install prompt asks for no site access,
 * and the extension is inert until you grant a site from the popup.
 *
 * Everything therefore hangs off chrome.permissions rather than a static
 * content_scripts block -- a static block would force host access at install
 * time, which is exactly what we are avoiding. This worker keeps the registered
 * content scripts in step with whatever has actually been granted.
 */

const CR_DOM_SCRIPT_ID = 'cr-dom';
const CR_NET_SCRIPT_ID = 'cr-net';
const CR_ALL_IDS = [CR_DOM_SCRIPT_ID, CR_NET_SCRIPT_ID];

async function crGrantedOrigins() {
  try {
    const granted = await chrome.permissions.getAll();
    return granted.origins || [];
  } catch (e) {
    return [];
  }
}

async function crClearRegistrations() {
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: CR_ALL_IDS });
  } catch (e) {
    existing = [];
  }
  if (!existing.length) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  } catch (e) { /* already gone */ }
}

/* Rebuilt from scratch every time rather than patched. Registrations persist
   across sessions and across extension updates, so a stale one -- pointing at
   an origin since revoked, or at an older file list -- would otherwise survive
   indefinitely. */
async function crSyncScripts() {
  await crClearRegistrations();

  const origins = await crGrantedOrigins();
  if (!origins.length) return;   // nothing granted, nothing runs

  const cfg = await crLoadConfig();
  const scripts = [{
    id: CR_DOM_SCRIPT_ID,
    matches: origins,
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    css: ['src/redact.css'],
    js: ['src/config.js', 'src/engine.js', 'src/content.js'],
    persistAcrossSessions: true
  }];

  const netWanted = !!cfg.network && (cfg.networkUrls || []).some((p) => String(p).trim());
  if (netWanted) {
    scripts.push({
      id: CR_NET_SCRIPT_ID,
      matches: origins,
      allFrames: true,
      runAt: 'document_start',
      world: 'MAIN',
      // One file, deliberately. net.js is self-contained: a second injected
      // file could not be relied on to execute in the page context.
      js: ['src/net.js'],
      persistAcrossSessions: true
    });
  }

  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (e) {
    console.error('[Redactor] could not register content scripts', e);
  }
}

/* Granting from the popup should take effect on the page you are looking at,
   not merely on the next navigation. Scoped to the origins just added. */
async function crReloadMatching(origins) {
  for (const origin of origins || []) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: origin });
    } catch (e) {
      continue;
    }
    for (const tab of tabs) {
      try {
        await chrome.tabs.reload(tab.id);
      } catch (e) { /* tab went away */ }
    }
  }
}

chrome.runtime.onInstalled.addListener(crSyncScripts);
chrome.runtime.onStartup.addListener(crSyncScripts);

chrome.permissions.onAdded.addListener(async (permissions) => {
  await crSyncScripts();
  await crReloadMatching(permissions.origins);
});

chrome.permissions.onRemoved.addListener(crSyncScripts);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Only the network hook's registration depends on settings; the DOM script's
  // does not, and re-registering it on every keyword edit would be wasteful.
  if ('network' in changes || 'networkUrls' in changes) crSyncScripts();
});
