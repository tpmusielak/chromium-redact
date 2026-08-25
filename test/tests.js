'use strict';

const results = document.getElementById('results');
let failures = 0;

function log(name, ok, detail) {
  failures += ok ? 0 : 1;
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = (ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !detail ? '' : '  →  ' + detail);
  results.appendChild(li);
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log(name, ok, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

function fixture(html) {
  let el = document.getElementById('fixture');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'fixture';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function make(overrides) {
  const cfg = Object.assign({}, CR_DEFAULTS, overrides);
  const r = new CRRedactor(cfg);
  return r;
}

/* Drives the engine over one subtree instead of the whole document, so the test
   page's own text isn't redacted along with the fixture. */
function run(r, root) {
  r.active = true;
  r.sweep(root, null);
  r.observeRoot(root);
  return r;
}

const spans = (root) => Array.from(root.querySelectorAll('span[data-cr]'));
const spanTexts = (root, r) => spans(root).map((s) => r.originals.get(s));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  // 1. plain match inside one text node
  {
    const f = fixture('<p>Hello John Smith here</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('single node: one span', spans(f).length, 1);
    check('single node: covered text', spanTexts(f, r), ['John Smith']);
    check('overlay leaves textContent intact', f.textContent, 'Hello John Smith here');
    r.stop();
  }

  // 2. keyword split across inline elements
  {
    const f = fixture('<p>John <b>Smith</b> ends</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('cross-element: split into segments', spans(f).length, 2);
    check('cross-element: segments rejoin', spanTexts(f, r).join(''), 'John Smith');
    r.stop();
  }

  // 3. must not match across a block boundary
  {
    const f = fixture('<div><p>John</p><p>Smith</p></div>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('block boundary blocks the match', spans(f).length, 0);
    r.stop();
  }

  // 4. <br> is a boundary too
  {
    const f = fixture('<p>John<br>Smith</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('br blocks the match', spans(f).length, 0);
    r.stop();
  }

  // 5. keyword split over a newline in the source
  {
    const f = fixture('<p>call John\n   Smith today</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('whitespace run matches a single space', spanTexts(f, r), ['John\n   Smith']);
    r.stop();
  }

  // 6. whole-word handling
  {
    const f = fixture('<p>cat catalogue cat</p>');
    const r = run(make({ keywords: ['cat'], wholeWord: true }), f);
    check('whole words only', spans(f).length, 2);
    r.stop();
  }
  {
    const f = fixture('<p>cat catalogue cat</p>');
    const r = run(make({ keywords: ['cat'], wholeWord: false }), f);
    check('substring matching', spans(f).length, 3);
    r.stop();
  }

  // 7. longest keyword wins
  {
    const f = fixture('<p>John Smith</p>');
    const r = run(make({ keywords: ['John', 'John Smith'] }), f);
    check('longest alternative wins', spanTexts(f, r), ['John Smith']);
    r.stop();
  }

  // 8. several matches in one text node
  {
    const f = fixture('<p>a John Smith b John Smith c</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('repeated matches: count', spans(f).length, 2);
    check('repeated matches: surrounding text survives', f.textContent, 'a John Smith b John Smith c');
    r.stop();
  }

  // 9. case sensitivity
  {
    const f = fixture('<p>john JOHN John</p>');
    const r = run(make({ keywords: ['John'], caseSensitive: true }), f);
    check('case sensitive', spans(f).length, 1);
    r.stop();
  }

  // 10. replace mode really removes the text
  {
    const f = fixture('<p>Hello John Smith here</p>');
    const r = run(make({ keywords: ['John Smith'], mode: 'replace' }), f);
    const span = spans(f)[0];
    check('replace: text gone from the DOM', f.textContent.indexOf('John Smith'), -1);
    check('replace: text still recoverable in memory', r.originals.get(span), 'John Smith');
    log('replace: bar has a measured width', parseFloat(span.style.width) > 10, 'width=' + span.style.width);
    r.stop();
  }

  // 11. block-character fill
  {
    const f = fixture('<p>Hello John Smith here</p>');
    const r = run(make({ keywords: ['John Smith'], mode: 'replace', fill: 'blocks' }), f);
    const text = spans(f)[0].textContent;
    log('blocks: filled with U+2588', /^█+$/.test(text), JSON.stringify(text));
    log('blocks: plausible length', text.length >= 5 && text.length <= 14, 'length=' + text.length);
    r.stop();
  }

  // 12. content injected after the first pass
  {
    const f = fixture('<div id="host"></div>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    const p = document.createElement('p');
    p.textContent = 'later John Smith arrives';
    f.querySelector('#host').appendChild(p);
    await tick();
    check('injected block is redacted', spanTexts(f, r), ['John Smith']);
    r.stop();
  }

  // 13. text rewritten in place (framework-style update)
  {
    const f = fixture('<p id="t">nothing here</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    f.querySelector('#t').firstChild.data = 'now John Smith appears';
    await tick();
    check('characterData change is redacted', spanTexts(f, r), ['John Smith']);
    r.stop();
  }

  // 14. our own writes must not retrigger the observer
  {
    const f = fixture('<p>John Smith</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    await tick();
    await tick();
    check('no re-redaction loop', spans(f).length, 1);
    r.stop();
  }

  // 15. contenteditable is left alone
  {
    const f = fixture('<div contenteditable="true"><p>John Smith</p></div>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('contenteditable skipped', spans(f).length, 0);
    r.stop();
  }

  // 16. attributes
  {
    const f = fixture('<img alt="photo of John Smith" title="John Smith"><input placeholder="John Smith">');
    const r = run(make({ keywords: ['John Smith'], redactAttributes: true }), f);
    const img = f.querySelector('img');
    check('alt redacted', img.getAttribute('alt'), 'photo of ██████████');
    check('placeholder redacted', f.querySelector('input').getAttribute('placeholder'), '██████████');
    r.restore();
    check('attributes restored', img.getAttribute('alt'), 'photo of John Smith');
    r.stop();
  }

  // 17. restore, overlay and replace
  {
    const f = fixture('<p>Hello John Smith here</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    r.restore();
    check('overlay restore', f.textContent, 'Hello John Smith here');
    check('overlay restore removes spans', spans(f).length, 0);
    r.stop();
  }
  {
    const f = fixture('<p>Hello John Smith here</p>');
    const r = run(make({ keywords: ['John Smith'], mode: 'replace' }), f);
    r.restore();
    check('replace restore', f.textContent, 'Hello John Smith here');
    r.stop();
  }

  // 18. shadow DOM
  {
    const f = fixture('<div id="sd"></div>');
    const holder = f.querySelector('#sd');
    const shadow = holder.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>inside John Smith shadow</p>';
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('open shadow root redacted', shadow.querySelectorAll('span[data-cr]').length, 1);
    r.stop();
  }

  // 19. script and style contents are never touched
  {
    const f = fixture('<script>var x = "John Smith";<\/script><p>John Smith</p>');
    const r = run(make({ keywords: ['John Smith'] }), f);
    check('script skipped, paragraph redacted', spans(f).length, 1);
    r.stop();
  }

  // 20. list syntax parsing
  {
    const p1 = crParseEntry('Acme Corp/Contoso Ltd');
    check('parse: phrase', p1.phrase, 'Acme Corp');
    check('parse: replacement', p1.replacement, 'Contoso Ltd');
    check('parse: bare phrase', crParseEntry('Acme Corp').replacement, null);
    check('parse: empty replacement counts as none', crParseEntry('Acme Corp/').replacement, null);
    check('parse: slashes in the replacement survive', crParseEntry('a/b/c').replacement, 'b/c');
    check('parse: escaped slash in the phrase', crParseEntry(String.raw`example.com\/jobs/our site`).phrase, 'example.com/jobs');
    check('parse: blank line ignored', crParseEntry('   '), null);
  }

  // 21. substitute mode
  {
    const f = fixture('<p>Hello Acme Corp, goodbye Acme Corp</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute' }), f);
    check('substitute: text swapped', f.textContent, 'Hello Contoso Ltd, goodbye Contoso Ltd');
    check('substitute: marked as substitutions', f.querySelectorAll('span[data-cr="s"]').length, 2);
    check('substitute: original recoverable', spanTexts(f, r), ['Acme Corp', 'Acme Corp']);
    r.restore();
    check('substitute: restore', f.textContent, 'Hello Acme Corp, goodbye Acme Corp');
    r.stop();
  }

  // 22. a phrase split across elements must not repeat the replacement
  {
    const f = fixture('<p>x <strong>Acme</strong> <strong>Corp</strong> y</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute' }), f);
    check('substitute: split match swapped once', f.textContent, 'x Contoso Ltd y');
    r.restore();
    check('substitute: split match restored', f.textContent, 'x Acme Corp y');
    r.stop();
  }

  // 23. phrases with no replacement fall back to a box
  {
    const f = fixture('<p>Acme Corp and bluebird</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd', 'bluebird'], mode: 'substitute' }), f);
    check('mixed list: one of each', [f.querySelectorAll('span[data-cr="s"]').length, f.querySelectorAll('span[data-cr="r"]').length], [1, 1]);
    check('mixed list: substitution applied', f.textContent.indexOf('Contoso Ltd'), 0);
    check('mixed list: bare phrase removed', f.textContent.indexOf('bluebird'), -1);
    log('mixed list: fallback box is measured', parseFloat(f.querySelector('span[data-cr="r"]').style.width) > 10,
        f.querySelector('span[data-cr="r"]').style.width);
    r.stop();
  }

  // 24. capitalisation follows the text being replaced
  {
    const f = fixture('<p>ACME CORP / Acme Corp / acme corp</p>');
    const r = run(make({ keywords: ['Acme Corp/contoso ltd'], mode: 'substitute', mimicCase: true }), f);
    check('mimic case', f.textContent, 'CONTOSO LTD / Contoso ltd / contoso ltd');
    r.stop();
  }
  {
    const f = fixture('<p>ACME CORP</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute', mimicCase: false }), f);
    check('mimic case off', f.textContent, 'Contoso Ltd');
    r.stop();
  }

  // 25. the marked style is opt-in
  {
    const f = fixture('<p>Acme Corp</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute', substituteStyle: 'plain' }), f);
    check('plain leaves no marker', f.querySelectorAll('span[data-cr-m]').length, 0);
    r.stop();
  }
  {
    const f = fixture('<p>Acme Corp</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute', substituteStyle: 'marked' }), f);
    check('marked adds the marker', f.querySelectorAll('span[data-cr-m="1"]').length, 1);
    r.stop();
  }

  // 26. substitution reaches attributes and matches whitespace-split text
  {
    const f = fixture('<img alt="a photo of Acme Corp"><p>Acme\n   Corp</p>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute' }), f);
    check('substitute in attributes', f.querySelector('img').getAttribute('alt'), 'a photo of Contoso Ltd');
    check('substitute across a newline', f.querySelector('p').textContent, 'Contoso Ltd');
    r.stop();
  }

  // 27. a replacement containing a keyword is not re-redacted
  {
    const f = fixture('<p>Acme Corp</p>');
    const r = run(make({ keywords: ['Acme Corp/Acme Corporation'], mode: 'substitute' }), f);
    await tick();
    await tick();
    check('no substitution feedback loop', f.textContent, 'Acme Corporation');
    r.stop();
  }

  // 28. substitution applies to content injected later
  {
    const f = fixture('<div id="host2"></div>');
    const r = run(make({ keywords: ['Acme Corp/Contoso Ltd'], mode: 'substitute' }), f);
    const p = document.createElement('p');
    p.textContent = 'late news from Acme Corp';
    f.querySelector('#host2').appendChild(p);
    await tick();
    check('substitute on injected content', p.textContent, 'late news from Contoso Ltd');
    r.stop();
  }

  // 20. empty keyword list is a no-op
  {
    const r = make({ keywords: [] });
    check('no keywords means no pattern', r.pattern, null);
  }

  const summary = document.createElement('li');
  summary.className = failures ? 'fail' : 'pass';
  summary.textContent = failures ? failures + ' FAILING' : 'all tests passed';
  results.appendChild(summary);
  window.__testFailures = failures;
  window.__testDone = true;
}

main().catch((e) => {
  log('harness crashed', false, String(e && e.stack || e));
  window.__testDone = true;
  window.__testFailures = 999;
});
