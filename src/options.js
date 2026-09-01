'use strict';

const $ = (id) => document.getElementById(id);
const radio = (name, value) => {
  for (const el of document.querySelectorAll('input[name="' + name + '"]')) el.checked = el.value === value;
};
const radioValue = (name) => {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : null;
};
const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

function fill(cfg) {
  $('keywords').value = (cfg.keywords || []).join('\n');
  $('sites').value = (cfg.sites || []).join('\n');
  $('wholeWord').checked = cfg.wholeWord;
  $('caseSensitive').checked = cfg.caseSensitive;
  $('redactTitle').checked = cfg.redactTitle;
  $('redactAttributes').checked = cfg.redactAttributes;
  $('blockCopy').checked = cfg.blockCopy;
  $('cloak').checked = cfg.cloak;
  $('cloakTimeoutMs').value = cfg.cloakTimeoutMs;
  $('mimicCase').checked = cfg.mimicCase;
  $('network').checked = cfg.network;
  $('networkUrls').value = (cfg.networkUrls || []).join('\n');
  $('networkPaths').value = (cfg.networkPaths || []).join('\n');
  radio('mode', cfg.mode);
  radio('fill', cfg.fill);
  radio('substituteStyle', cfg.substituteStyle);
  radio('siteMode', cfg.siteMode);
  syncUi();
}

function collect() {
  const timeout = parseInt($('cloakTimeoutMs').value, 10);
  return {
    keywords: lines($('keywords').value),
    sites: lines($('sites').value),
    wholeWord: $('wholeWord').checked,
    caseSensitive: $('caseSensitive').checked,
    redactTitle: $('redactTitle').checked,
    redactAttributes: $('redactAttributes').checked,
    blockCopy: $('blockCopy').checked,
    cloak: $('cloak').checked,
    cloakTimeoutMs: Number.isFinite(timeout) ? Math.min(10000, Math.max(100, timeout)) : CR_DEFAULTS.cloakTimeoutMs,
    mimicCase: $('mimicCase').checked,
    network: $('network').checked,
    networkUrls: lines($('networkUrls').value),
    networkPaths: lines($('networkPaths').value),
    mode: radioValue('mode') || CR_DEFAULTS.mode,
    fill: radioValue('fill') || CR_DEFAULTS.fill,
    substituteStyle: radioValue('substituteStyle') || CR_DEFAULTS.substituteStyle,
    siteMode: radioValue('siteMode') || CR_DEFAULTS.siteMode
  };
}

function syncUi() {
  const mode = radioValue('mode');
  $('fillWrap').style.display = mode === 'replace' ? '' : 'none';
  $('subWrap').style.display = mode === 'substitute' ? '' : 'none';

  const entries = lines($('keywords').value).map(crParseEntry).filter(Boolean);
  const withReplacement = entries.filter((e) => e.replacement).length;
  const noun = entries.length === 1 ? 'phrase' : 'phrases';
  let text = entries.length + ' ' + noun;
  if (mode === 'substitute') {
    text += ', ' + withReplacement + ' with a replacement';
    const bare = entries.length - withReplacement;
    if (bare) text += ' (' + bare + ' will be boxed instead)';
  }
  $('count').textContent = text;
}

function flash(message) {
  $('status').textContent = message;
  setTimeout(() => { $('status').textContent = ''; }, 1800);
}

document.addEventListener('input', syncUi);
document.addEventListener('change', syncUi);

$('save').addEventListener('click', async () => {
  const before = await crLoadConfig();
  const next = collect();
  await crSaveConfig(next);

  // The DOM engine re-runs in open tabs on the storage change, but the network
  // hook is a content script the service worker registers or unregisters, and
  // that only takes effect on the next navigation.
  const netChanged = before.network !== next.network
    || JSON.stringify(before.networkUrls) !== JSON.stringify(next.networkUrls)
    || JSON.stringify(before.networkPaths) !== JSON.stringify(next.networkPaths);

  flash(netChanged
    ? 'Saved — network changes apply on the next page load.'
    : 'Saved — open tabs update immediately.');
});

$('reset').addEventListener('click', async () => {
  await crSaveConfig(CR_DEFAULTS);
  fill(CR_DEFAULTS);
  flash('Reset.');
});

crLoadConfig().then(fill);

/* ---------------- site access ---------------- */

function grantedOrigins() {
  return new Promise((resolve) => {
    chrome.permissions.getAll((p) => resolve((p && p.origins) || []));
  });
}

async function renderOrigins() {
  const origins = await grantedOrigins();
  const list = $('originList');
  list.textContent = '';

  if (!origins.length) {
    const empty = document.createElement('p');
    empty.className = 'bp-text-muted bp-text-small';
    empty.style.margin = '0';
    empty.textContent = 'No sites granted yet. Keyword Redact is not running anywhere.';
    list.appendChild(empty);
    $('grantAll').disabled = false;
    return;
  }

  const all = origins.some(crIsAllSites);
  $('grantAll').disabled = all;

  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'bp-inline-field';
    row.style.margin = '0 0 8px';

    const label = document.createElement('span');
    label.className = 'bp-tag bp-tag-minimal';
    label.textContent = crPatternLabel(origin);
    row.appendChild(label);

    const remove = document.createElement('button');
    remove.className = 'bp-button bp-button-minimal';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      chrome.permissions.remove({ origins: [origin] }, () => {
        renderOrigins();
        flashAccess('Access removed.');
      });
    });
    row.appendChild(remove);

    list.appendChild(row);
  }
}

function flashAccess(message) {
  $('accessStatus').textContent = message;
  setTimeout(() => { $('accessStatus').textContent = ''; }, 2500);
}

$('grantAll').addEventListener('click', () => {
  // Inside the click handler: Chrome only prompts for a request made during a
  // user gesture.
  chrome.permissions.request({ origins: ['*://*/*'] }, (granted) => {
    renderOrigins();
    if (granted) flashAccess('Granted. Open tabs need a reload.');
  });
});

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(renderOrigins);
  chrome.permissions.onRemoved.addListener(renderOrigins);
}

renderOrigins();
