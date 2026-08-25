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
  radio('mode', cfg.mode);
  radio('fill', cfg.fill);
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
    mode: radioValue('mode') || CR_DEFAULTS.mode,
    fill: radioValue('fill') || CR_DEFAULTS.fill,
    siteMode: radioValue('siteMode') || CR_DEFAULTS.siteMode
  };
}

function syncUi() {
  $('fillWrap').style.display = radioValue('mode') === 'replace' ? '' : 'none';
  const n = lines($('keywords').value).length;
  $('count').textContent = n === 1 ? '1 keyword' : n + ' keywords';
}

function flash(message) {
  $('status').textContent = message;
  setTimeout(() => { $('status').textContent = ''; }, 1800);
}

document.addEventListener('input', syncUi);
document.addEventListener('change', syncUi);

$('save').addEventListener('click', async () => {
  await crSaveConfig(collect());
  flash('Saved — open tabs update immediately.');
});

$('reset').addEventListener('click', async () => {
  await crSaveConfig(CR_DEFAULTS);
  fill(CR_DEFAULTS);
  flash('Reset.');
});

crLoadConfig().then(fill);
