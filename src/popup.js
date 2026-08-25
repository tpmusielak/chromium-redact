'use strict';

const $ = (id) => document.getElementById(id);

let config = null;
let host = '';          // hostname of the active tab, for display
let originPattern = null;   // the host permission that would cover it, or null
let hasAccess = false;
let tabId = null;

/* The active tab's URL is readable because of "activeTab": opening the popup
   counts as invoking the action, which grants this one tab temporarily. That is
   deliberately not the same as being able to read the page -- it shows no
   install warning and lasts only for this interaction. */
function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
  });
}

function hasOrigin(pattern) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [pattern] }, (result) => resolve(!!result));
  });
}

function render() {
  $('accessGranted').hidden = true;
  $('accessMissing').hidden = true;
  $('accessUnavailable').hidden = true;

  if (!originPattern) {
    $('accessUnavailable').hidden = false;
  } else if (hasAccess) {
    $('accessGranted').hidden = false;
    $('hostGranted').textContent = host;
  } else {
    $('accessMissing').hidden = false;
    $('hostMissing').textContent = host;
  }

  // The per-site pause and the mode only mean anything where we actually run.
  $('controls').style.display = hasAccess ? '' : 'none';

  $('enabled').checked = config.enabled;
  $('host').textContent = host || 'this site';
  $('site').checked = host ? crSiteAllowed(config, host) : false;
  $('site').disabled = !host;
  for (const el of document.querySelectorAll('input[name="mode"]')) el.checked = el.value === config.mode;

  const entries = (config.keywords || []).map(crParseEntry).filter(Boolean);
  if (config.mode === 'substitute') {
    const withReplacement = entries.filter((e) => e.replacement).length;
    $('count').textContent = withReplacement + '/' + entries.length + ' with stand-ins';
  } else {
    $('count').textContent = entries.length === 1 ? '1 phrase' : entries.length + ' phrases';
  }
}

async function patch(changes) {
  Object.assign(config, changes);
  await crSaveConfig(changes);
  render();
}

/* One checkbox drives the three site modes: turning a site off from "every
   site" starts a blocklist, and under an allowlist the same checkbox adds or
   removes the host instead. This is the soft pause -- it does not touch the
   permission, so redaction can be stopped on a site without giving up access
   and having to re-grant it later. */
async function toggleSite(on) {
  if (!host) return;
  const sites = (config.sites || []).filter((s) => crNormalizeHost(s) !== host.toLowerCase());
  if (config.siteMode === 'allowlist') {
    if (on) sites.push(host);
    await patch({ sites });
    return;
  }
  if (on) {
    await patch({ siteMode: config.siteMode, sites });
  } else {
    sites.push(host);
    await patch({ siteMode: 'blocklist', sites });
  }
}

/* Must run inside the click handler: Chrome only shows the permission prompt
   for a request made during a user gesture. The service worker picks the grant
   up via permissions.onAdded, registers the content scripts for the new origin
   and reloads the tab -- which is why nothing here needs to do that itself, and
   why it still works if Chrome closes the popup to show the prompt. */
$('grant').addEventListener('click', () => {
  if (!originPattern) return;
  chrome.permissions.request({ origins: [originPattern] }, (granted) => {
    if (!granted) return;
    hasAccess = true;
    render();
    window.close();
  });
});

$('revoke').addEventListener('click', () => {
  if (!originPattern) return;
  chrome.permissions.remove({ origins: [originPattern] }, (removed) => {
    if (!removed) return;
    hasAccess = false;
    render();
    if (tabId != null) chrome.tabs.reload(tabId);
    window.close();
  });
});

$('enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
$('site').addEventListener('change', (e) => toggleSite(e.target.checked));
for (const el of document.querySelectorAll('input[name="mode"]')) {
  el.addEventListener('change', (e) => { if (e.target.checked) patch({ mode: e.target.value }); });
}
$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const [cfg, tab] = await Promise.all([crLoadConfig(), activeTab()]);
  config = cfg;
  tabId = tab ? tab.id : null;
  originPattern = tab ? crOriginPattern(tab.url) : null;
  try {
    host = tab && tab.url ? new URL(tab.url).hostname : '';
  } catch (e) {
    host = '';
  }
  hasAccess = originPattern ? await hasOrigin(originPattern) : false;
  render();
})();
