'use strict';

const results = document.getElementById('results');
let failures = 0;

function log(name, ok, detail) {
  failures += ok ? 0 : 1;
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = (ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !detail ? '' : '  ->  ' + detail);
  results.appendChild(li);
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log(name, ok, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

/* Re-brief the hook with the same plain-data payload content.js sends. Built by
   hand rather than via config.js, so this file also runs in the solo harness
   where config.js is absent entirely -- which is the point: net.js must work
   with no second file present. */
const HAS_CONFIG = typeof crCompilePaths === 'function';

// Hand-written path tokens. When config.js IS loaded, a test below asserts its
// compiler produces exactly these, which pins the wire format.
const PATH_BY_TEXT = {
  accountName: [{ t: 'key', v: 'accountName' }],
  'contacts[*].name': [{ t: 'key', v: 'contacts' }, { t: 'anyIndex' }, { t: 'key', v: 'name' }],
  'contacts[1].name': [{ t: 'key', v: 'contacts' }, { t: 'index', v: 1 }, { t: 'key', v: 'name' }],
  contacts: [{ t: 'key', v: 'contacts' }],
  'nope.not.here': [{ t: 'key', v: 'nope' }, { t: 'key', v: 'not' }, { t: 'key', v: 'here' }],
  '**.email': [{ t: 'deep' }, { t: 'key', v: 'email' }],
  'a.email': [{ t: 'key', v: 'a' }, { t: 'key', v: 'email' }]
};

const PATHS = {
  accountName: [[{ t: 'key', v: 'accountName' }]],
  contactsEmail: [[{ t: 'key', v: 'contacts' }, { t: 'anyIndex' }, { t: 'key', v: 'email' }]],
  nestedLabel: [[{ t: 'key', v: 'nested' }, { t: 'key', v: 'deep' }, { t: 'key', v: 'label' }]]
};

const PHRASES = {
  plain: {
      source: '(?:\\bj\\.smith@example\\.com\\b)|(?:\\bproject[\\s\\u00a0]+bluebird\\b)|(?:\\bAcme[\\s\\u00a0]+Corp\\b)',
    replacements: []
  }
};

function configure(overrides) {
  const o = overrides || {};
  const brief = Object.assign({
    active: true,
    pattern: {
      source: '(?:\\bj\\.smith@example\\.com\\b)|(?:\\bproject[\\s\\u00a0]+bluebird\\b)|(?:\\bAcme[\\s\\u00a0]+Corp\\b)',
      flags: 'gi'
    },
    replacements: [],
    urlPatterns: ['^.*/fixtures/data\\.json.*$'],
    paths: [],
    mode: 'overlay',
    mimicCase: true,
    caseSensitive: false
  }, o);
  document.dispatchEvent(new CustomEvent('cr-redactor-net', { detail: JSON.stringify(brief) }));
  return brief;
}

const xhrGet = (url, responseType) => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest();
  x.open('GET', url);
  if (responseType) x.responseType = responseType;
  x.onload = () => resolve(x);
  x.onerror = reject;
  x.send();
});

const BLOCK = (n) => '█'.repeat(n);

async function main() {
  /* ---------------- URL pattern matching (config.js side) ---------------- */
  if (!HAS_CONFIG) {
    log('config.js suites skipped (solo harness)', true);
  } else {
    const m = crUrlMatcher(['https://app.example.com/api/*']);
    check('url: wildcard suffix', m('https://app.example.com/api/customers?q=1'), true);
    check('url: wrong host rejected', m('https://evil.example.com/api/customers'), false);
    check('url: prefix must match', m('https://app.example.com/static/app.js'), false);

    const m2 = crUrlMatcher(['*/api/customers*']);
    check('url: leading wildcard', m2('https://anything.test/api/customers/42'), true);

    const m3 = crUrlMatcher(['/api/orders']);
    check('url: bare pattern is a contains match', m3('https://x.test/v2/api/orders?id=3'), true);
    check('url: bare pattern still discriminates', m3('https://x.test/v2/api/invoices'), false);

    check('url: no patterns means no traffic', crUrlMatcher([])('https://x.test/anything'), false);
    check('url: blank lines ignored', crUrlMatcher(['  ', ''])('https://x.test/a'), false);

    const m4 = crUrlMatcher(['*/Data.JSON*']);
    check('url: case-insensitive', m4('https://x.test/data.json'), true);
  }

  /* ---------------- JSON path compilation (config.js side) ---------------- */
  if (HAS_CONFIG) {
    check('path: simple key', crCompilePath('accountName'), [{ t: 'key', v: 'accountName' }]);
    check('path: array wildcard', crCompilePath('contacts[*].name'),
      [{ t: 'key', v: 'contacts' }, { t: 'anyIndex' }, { t: 'key', v: 'name' }]);
    check('path: empty brackets alias', crCompilePath('contacts[].name'),
      [{ t: 'key', v: 'contacts' }, { t: 'anyIndex' }, { t: 'key', v: 'name' }]);
    check('path: explicit index', crCompilePath('contacts[1].email'),
      [{ t: 'key', v: 'contacts' }, { t: 'index', v: 1 }, { t: 'key', v: 'email' }]);
    check('path: single-level wildcard', crCompilePath('*.name'),
      [{ t: 'any' }, { t: 'key', v: 'name' }]);
    check('path: recursive', crCompilePath('**.email'), [{ t: 'deep' }, { t: 'key', v: 'email' }]);
    check('path: rubbish rejected', crCompilePath('contacts[abc]'), null);
    check('path: empty rejected', crCompilePath('   '), null);
  }

  /* ---------------- JSON redaction, in isolation ----------------
     Exercised through net.js's own copy, which is the one that actually runs. */
  {
    const crRedactJson = window.__crNetInternals.redactJson;
    const crCompilePaths = (list) => list.map((p) => PATH_BY_TEXT[p]);
    const doc = () => ({
      accountName: 'Acme Corp',
      acmeCorpId: 'Acme Corp',
      count: 2,
      contacts: [{ name: 'Acme Corp', id: 7 }, { name: 'Acme Corp', id: 8 }]
    });
    const redact = (s) => s.replace(/Acme Corp/g, 'XXX');

    const all = crRedactJson(doc(), [], redact);
    check('json: no paths redacts every string', [all.accountName, all.acmeCorpId, all.contacts[0].name],
      ['XXX', 'XXX', 'XXX']);
    check('json: numbers untouched', [all.count, all.contacts[0].id], [2, 7]);

    const scoped = crRedactJson(doc(), crCompilePaths(['accountName']), redact);
    check('json: path narrows to one field',
      [scoped.accountName, scoped.acmeCorpId, scoped.contacts[0].name],
      ['XXX', 'Acme Corp', 'Acme Corp']);

    const arr = crRedactJson(doc(), crCompilePaths(['contacts[*].name']), redact);
    check('json: array wildcard hits every element',
      [arr.contacts[0].name, arr.contacts[1].name, arr.accountName],
      ['XXX', 'XXX', 'Acme Corp']);

    const one = crRedactJson(doc(), crCompilePaths(['contacts[1].name']), redact);
    check('json: explicit index hits only that element',
      [one.contacts[0].name, one.contacts[1].name], ['Acme Corp', 'XXX']);

    const sub = crRedactJson(doc(), crCompilePaths(['contacts']), redact);
    check('json: a key names its whole subtree',
      [sub.contacts[0].name, sub.contacts[1].name, sub.accountName],
      ['XXX', 'XXX', 'Acme Corp']);

    const missing = crRedactJson(doc(), crCompilePaths(['nope.not.here']), redact);
    check('json: unmatched path is a no-op', missing.accountName, 'Acme Corp');

    // Keys are never rewritten, even when a key text matches.
    const keyDoc = crRedactJson({ 'Acme Corp': 'Acme Corp' }, [], redact);
    check('json: keys survive', Object.keys(keyDoc), ['Acme Corp']);
    check('json: value redacted', keyDoc['Acme Corp'], 'XXX');

    // A value reachable twice must be redacted once, not twice.
    let calls = 0;
    crRedactJson({ a: { email: 'x' } }, crCompilePaths(['**.email', 'a.email']), (s) => { calls++; return s; });
    check('json: overlapping paths redact once', calls, 1);
  }

  /* ---------------- XHR ---------------- */
  {
    configure({});
    const x = await xhrGet('fixtures/data.json');
    const body = JSON.parse(x.responseText);
    check('xhr: matched url redacted', body.accountName, BLOCK(9));
    check('xhr: still parses and keys survive', Object.keys(body).indexOf('acmeCorpId') !== -1, true);
    check('xhr: numbers survive', [body.count, body.contacts[0].id], [2, 4711]);
    check('xhr: nested value redacted', body.nested.deep.label, BLOCK(16));
    check('xhr: status untouched', x.status, 200);

    const again = x.responseText;
    check('xhr: repeated read is stable', again === x.responseText, true);
    check('xhr: repeated read not double-redacted', JSON.parse(again).accountName, BLOCK(9));
  }

  {
    configure({});
    const x = await xhrGet('fixtures/data.json', 'json');
    check('xhr: responseType json redacted', x.response.accountName, BLOCK(9));
    check('xhr: responseType json still an object', typeof x.response, 'object');
    check('xhr: responseType json keys survive', Object.keys(x.response).indexOf('acmeCorpId') !== -1, true);
  }

  {
    configure({ paths: PATHS.contactsEmail });
    const x = await xhrGet('fixtures/data.json');
    const body = JSON.parse(x.responseText);
    check('xhr: path narrows to the listed field', body.contacts[0].email, BLOCK(19));
    check('xhr: sibling field untouched', body.contacts[0].name, 'Acme Corp Ltd');
    check('xhr: unlisted top-level field untouched', body.accountName, 'Acme Corp');
  }

  {
    configure({});
    const x = await xhrGet('fixtures/other.json');
    check('xhr: non-matching url passes through', JSON.parse(x.responseText).accountName, 'Acme Corp');
  }

  {
    configure({ urlPatterns: ['^.*/fixtures/plain' + String.fromCharCode(92) + '.txt.*$'] });
    const x = await xhrGet('fixtures/plain.txt');
    check('xhr: non-json body redacted as text', x.responseText.indexOf('Acme Corp'), -1);
  }

  {
    configure({ urlPatterns: ['^.*/fixtures/plain' + String.fromCharCode(92) + '.txt.*$'], paths: PATHS.accountName });
    const x = await xhrGet('fixtures/plain.txt');
    check('xhr: paths set + non-json body is left alone', x.responseText.indexOf('Acme Corp') !== -1, true);
  }

  /* ---------------- fetch ---------------- */
  {
    configure({});
    const res = await fetch('fixtures/data.json');
    const body = await res.json();
    check('fetch: matched url redacted', body.accountName, BLOCK(9));
    check('fetch: inline mention redacted', body.publicNote, BLOCK(9) + ' is mentioned here too');
    check('fetch: status preserved', [res.status, res.ok], [200, true]);
    check('fetch: content-type preserved', /json/.test(res.headers.get('content-type')), true);
    check('fetch: url preserved', /fixtures\/data\.json$/.test(res.url), true);
  }

  {
    configure({});
    const res = await fetch('fixtures/other.json');
    const text = await res.text();
    check('fetch: non-matching url passes through', text.indexOf('Acme Corp') !== -1, true);
  }

  {
    configure({ paths: PATHS.nestedLabel });
    const res = await fetch('fixtures/data.json');
    const body = await res.json();
    check('fetch: deep path narrows correctly',
      [body.nested.deep.label, body.accountName], [BLOCK(16), 'Acme Corp']);
  }

  /* ---------------- substitute mode over the wire ---------------- */
  {
    configure({
      mode: 'substitute',
      replacements: [['acme corp', 'Contoso Ltd'], ['project bluebird', 'project kestrel']]
    });
    const res = await fetch('fixtures/data.json');
    const body = await res.json();
    check('substitute: stand-in over the wire', body.accountName, 'Contoso Ltd');
    check('substitute: deep value', body.nested.deep.label, 'project kestrel');
    check('substitute: payload still parses and keys survive',
      Object.keys(body).indexOf('acmeCorpId') !== -1, true);
    check('substitute: identifiers left alone', body.contacts[0].id, 4711);
  }

  /* ---------------- the MAIN-world contract ----------------
     net.js is the only file injected into the page. These pin the properties
     that broke on real installs: it must need nothing else present, and its
     private copies of the shared helpers must not drift from config.js. */
  {
    const src = await (await fetch('../src/net.js')).text();
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // Not one reference to anything config.js defines. This is the check that
    // would have caught both shipped bugs: the harness shares globals, a real
    // MAIN-world injection does not.
    const refs = [];
    const re = /\b(cr[A-Z]\w*|CR_[A-Z_]+)\b/g;
    let m;
    while ((m = re.exec(stripped)) !== null) refs.push(m[1]);
    check('solo: net.js references nothing from config.js', Array.from(new Set(refs)), []);

    check('solo: net.js is the only registered MAIN-world file',
      /js:\s*\['src\/net\.js'\]/.test(await (await fetch('../src/background.js')).text()), true);
  }

  {
    // net.js keeps private copies of matchKey and mimicCase because they cannot
    // cross the world boundary. They must not drift from config.js's versions.
    const net = window.__crNetInternals;
    const cases = [
      ['Acme Corp', 'Contoso Ltd'], ['ACME CORP', 'Contoso Ltd'], ['acme corp', 'Contoso Ltd'],
      ['Acme Corp', 'contoso ltd'], ['acme corp', 'CONTOSO LTD'], ['A', 'b'], ['4711', 'x']
    ];
    if (HAS_CONFIG) {
      const mimicDrift = cases.filter(([a, b]) => net.mimicCase(a, b) !== crMimicCase(a, b));
      check('solo: mimicCase matches config.js', mimicDrift, []);

      const keyInputs = ['Acme Corp', 'Acme\n  Corp', 'ACME CORP', 'a\u00a0b'];
      const keyDrift = keyInputs.filter((t) =>
        net.matchKey(t, false) !== crMatchKey(t, false) || net.matchKey(t, true) !== crMatchKey(t, true));
      check('solo: matchKey matches config.js', keyDrift, []);

      // The wire format: config.js's compiler must emit exactly what net.js reads.
      check('solo: path token wire format', crCompilePaths(['contacts[*].email']), PATHS.contactsEmail);
      check('solo: path token wire format, nested', crCompilePaths(['nested.deep.label']), PATHS.nestedLabel);
    } else {
      log('solo: config.js comparisons skipped (solo harness)', true);
      check('solo: mimicCase still works standalone', net.mimicCase('ACME CORP', 'Contoso Ltd'), 'CONTOSO LTD');
      check('solo: matchKey still works standalone', net.matchKey('Acme\n Corp', false), 'acme corp');
    }
  }

  {
    // An inert brief must release the request hold. net.js holds send() until it
    // is briefed; a page where redaction is off used to hang forever.
    configure({ active: false });
    const started = Date.now();
    const x = await xhrGet('fixtures/data.json');
    log('inert brief: request completes', x.status === 200, 'status=' + x.status);
    log('inert brief: not held', Date.now() - started < 1500, (Date.now() - started) + 'ms');
    check('inert brief: body passes through', JSON.parse(x.responseText).accountName, 'Acme Corp');

    const res = await fetch('fixtures/data.json');
    check('inert brief: fetch passes through', (await res.json()).accountName, 'Acme Corp');
  }

  {
    // A malformed brief must also release rather than wedge the page.
    document.dispatchEvent(new CustomEvent('cr-redactor-net', { detail: 'not json{' }));
    const x = await xhrGet('fixtures/data.json');
    check('bad brief: request still completes', x.status, 200);
    configure({});   // restore a working config
  }

  const summary = document.createElement('li');
  summary.className = failures ? 'fail' : 'pass';
  summary.textContent = failures ? failures + ' FAILING' : 'all tests passed';
  results.appendChild(summary);
  window.__netFailures = failures;
  window.__netDone = true;
}

main().catch((e) => {
  log('harness crashed', false, String((e && e.stack) || e));
  window.__netDone = true;
  window.__netFailures = 999;
});
