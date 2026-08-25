'use strict';

const $ = (id) => document.getElementById(id);
let config = null;
let host = '';

function currentHost() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs && tabs[0] && tabs[0].url;
      try { resolve(url ? new URL(url).hostname : ''); } catch (e) { resolve(''); }
    });
  });
}

function render() {
  $('enabled').checked = config.enabled;
  $('host').textContent = host || 'this page';
  $('site').checked = host ? crSiteAllowed(config, host) : false;
  $('site').disabled = !host;
  for (const el of document.querySelectorAll('input[name="mode"]')) el.checked = el.value === config.mode;
  const n = (config.keywords || []).length;
  $('count').textContent = n === 1 ? '1 keyword' : n + ' keywords';
}

async function patch(changes) {
  Object.assign(config, changes);
  await crSaveConfig(changes);
  render();
}

/* One checkbox drives the three site modes: turning a site off from "every site"
   starts a blocklist, and under an allowlist the same checkbox adds or removes
   the host instead. */
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

$('enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
$('site').addEventListener('change', (e) => toggleSite(e.target.checked));
for (const el of document.querySelectorAll('input[name="mode"]')) {
  el.addEventListener('change', (e) => { if (e.target.checked) patch({ mode: e.target.value }); });
}
$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

Promise.all([crLoadConfig(), currentHost()]).then(([cfg, h]) => {
  config = cfg;
  host = h;
  render();
});
