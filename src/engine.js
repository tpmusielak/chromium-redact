'use strict';

const CR_XHTML = 'http://www.w3.org/1999/xhtml';

/* Never descend into these. TEXTAREA and SELECT/OPTION can't hold markup,
   HEAD is handled via document.title, and script/style aren't rendered. */
const CR_SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE',
  'TEXTAREA', 'SELECT', 'OPTION', 'IFRAME', 'OBJECT', 'EMBED',
  'CANVAS', 'VIDEO', 'AUDIO'
]);

/* Block-level boundaries. Text either side of one is never visually contiguous,
   so a keyword may not match across it. Also used to scope re-scans. */
const CR_BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'BUTTON', 'CAPTION',
  'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
  'HTML', 'LEGEND', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

const CR_ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
const CR_BLOCK_CHAR = '█';

function crUpperBound(starts, value) {
  let lo = 0, hi = starts.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= value) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

class CRRedactor {
  constructor(cfg) {
    this.cfg = cfg;
    const compiled = crCompile(cfg);
    this.pattern = compiled.pattern;
    this.replacements = compiled.replacements;
    this.active = false;
    this.roots = new Set();
    this.fontCache = new WeakMap();     // element -> {font, ls}
    this.widthCache = new Map();        // "font ls text" -> px
    this.originals = new WeakMap();     // redaction span -> original text
    this.attrOriginals = new WeakMap(); // element -> {attr: original value}
    this.lastTitle = null;
    this.ctx = document.createElement('canvas').getContext('2d');
    this.observer = new MutationObserver((records) => this.onMutations(records));
  }

  /* ---------------- lifecycle ---------------- */

  start(doc) {
    if (!this.pattern) return;
    this.active = true;
    this.sweep(doc.documentElement || doc, doc);
    this.observeRoot(doc);
    this.installRemeasureHooks();
  }

  stop() {
    this.active = false;
    this.observer.disconnect();
  }

  /* Puts every redaction back, so a settings change updates open tabs without a
     reload. In replace mode the original text only ever lives in this script's
     memory, never in the DOM -- that is what makes that mode a real removal. */
  restore() {
    for (const root of this.roots) {
      for (const span of root.querySelectorAll('span[data-cr]')) {
        const text = this.originals.get(span);
        if (text == null) continue;
        const parent = span.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(text), span);
        parent.normalize();
      }
      for (const el of root.querySelectorAll('[data-cr-a]')) {
        const saved = this.attrOriginals.get(el);
        el.removeAttribute('data-cr-a');
        if (!saved) continue;
        for (const attr of Object.keys(saved)) el.setAttribute(attr, saved[attr]);
      }
    }
  }

  observeRoot(root) {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    const opts = { childList: true, subtree: true, characterData: true };
    if (this.cfg.redactAttributes) {
      opts.attributes = true;
      opts.attributeFilter = CR_ATTRS;
    }
    this.observer.observe(root, opts);
  }

  /* ---------------- the pass ---------------- */

  /* Three phases, deliberately not interleaved: collect (reads text only),
     measure (computed styles + canvas, still reads only), apply (writes only).
     Interleaving reads and writes would force a synchronous reflow per
     redaction; this way it costs at most one per batch. */
  sweep(node, doc) {
    const edits = [];
    this.collect(node, edits);
    if (edits.length) this.apply(edits);
    if (this.cfg.redactTitle && doc && window.top === window) this.fixTitle();
  }

  collect(node, out) {
    let group = null;
    const flush = () => {
      if (group) { this.scanGroup(group, out); group = null; }
    };
    const walk = (parent) => {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        const type = child.nodeType;
        if (type === 3) {
          if (child.data.length) (group || (group = [])).push(child);
          continue;
        }
        if (type !== 1) continue;
        // SVG / MathML: our wrapper is an HTML <span>, which wouldn't render there.
        if (child.namespaceURI !== CR_XHTML) { flush(); continue; }
        const tag = child.tagName;
        if (CR_SKIP.has(tag) || child.hasAttribute('data-cr') || child.hasAttribute('contenteditable')) {
          flush();
          continue;
        }
        if (this.cfg.redactAttributes) this.collectAttrs(child, out);
        const isBlock = CR_BLOCK.has(tag);
        if (isBlock) flush();
        if (child.shadowRoot) {
          flush();
          this.observeRoot(child.shadowRoot);
          walk(child.shadowRoot);
          flush();
        }
        walk(child);
        if (isBlock) flush();
      }
    };
    walk(node);
    flush();
  }

  /* A group is a run of text nodes with no block boundary between them, i.e. one
     continuous line of visible text. Matching the concatenation is what catches
     keywords split across inline elements: John<b>Smith</b>. */
  scanGroup(nodes, out) {
    const re = this.pattern;
    re.lastIndex = 0;

    if (nodes.length === 1) {
      const node = nodes[0];
      const data = node.data;
      let m;
      while ((m = re.exec(data)) !== null) {
        if (!m[0].length) { re.lastIndex++; continue; }
        out.push({ node, start: m.index, end: m.index + m[0].length, text: m[0], match: m[0], first: true });
      }
      return;
    }

    const starts = new Array(nodes.length);
    const parts = new Array(nodes.length);
    let acc = 0;
    for (let i = 0; i < nodes.length; i++) {
      starts[i] = acc;
      parts[i] = nodes[i].data;
      acc += parts[i].length;
    }
    const joined = parts.join('');
    let m;
    while ((m = re.exec(joined)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const from = m.index;
      const to = from + m[0].length;
      // A match may straddle nodes; emit one edit per node it touches. `first`
      // marks the leading segment, which is the one that carries a substitution
      // -- the others collapse to nothing, so the phrase isn't repeated once per
      // node it happened to be split over.
      let first = true;
      for (let i = crUpperBound(starts, from); i < nodes.length && starts[i] < to; i++) {
        const segStart = Math.max(from, starts[i]) - starts[i];
        const segEnd = Math.min(to, starts[i] + parts[i].length) - starts[i];
        if (segEnd > segStart) {
          out.push({
            node: nodes[i], start: segStart, end: segEnd,
            text: parts[i].slice(segStart, segEnd), match: m[0], first
          });
          first = false;
        }
      }
    }
  }

  collectAttrs(el, out) {
    const re = this.pattern;
    for (const attr of CR_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      re.lastIndex = 0;
      if (!re.test(value)) continue;
      re.lastIndex = 0;
      out.push({ el, attr, value, redacted: value.replace(re, (m) => this.swapText(m)) });
    }
    re.lastIndex = 0;
  }

  apply(edits) {
    const textEdits = [];
    const attrEdits = [];
    for (const edit of edits) (edit.attr ? attrEdits : textEdits).push(edit);

    // Read phase. Substitute mode only needs a measurement where it falls back
    // to a box, i.e. for phrases the list gave no replacement for.
    if (this.usesBars()) {
      for (const edit of textEdits) {
        if (this.substitutionFor(edit.match) != null) continue;
        edit.width = this.measureEdit(edit);
      }
    }

    // Write phase. Several edits on one node are applied back-to-front so the
    // offsets of the earlier ones stay valid across splitText().
    const byNode = new Map();
    for (const edit of textEdits) {
      let list = byNode.get(edit.node);
      if (!list) byNode.set(edit.node, (list = []));
      list.push(edit);
    }
    for (const list of byNode.values()) {
      list.sort((a, b) => b.start - a.start);
      for (const edit of list) this.wrap(edit);
    }
    for (const edit of attrEdits) {
      let saved = this.attrOriginals.get(edit.el);
      if (!saved) this.attrOriginals.set(edit.el, (saved = {}));
      if (!(edit.attr in saved)) saved[edit.attr] = edit.value;
      edit.el.setAttribute('data-cr-a', '1');
      edit.el.setAttribute(edit.attr, edit.redacted);
    }
  }

  wrap(edit) {
    const node = edit.node;
    if (!node.parentNode || edit.end > node.data.length) return;

    let target = node;
    if (edit.start > 0) target = target.splitText(edit.start);
    if (target.data.length > edit.end - edit.start) target.splitText(edit.end - edit.start);

    const text = target.data;
    const parentEl = target.parentElement;
    const span = document.createElement('span');
    this.originals.set(span, text);

    const substitution = this.substitutionFor(edit.match);
    if (substitution != null) {
      span.setAttribute('data-cr', 's');
      if (this.cfg.substituteStyle === 'marked') span.setAttribute('data-cr-m', '1');
      // Only the leading segment of a split match carries the replacement.
      span.textContent = edit.first ? substitution : '';
    } else if (this.usesBars()) {
      span.setAttribute('data-cr', 'r');
      this.paintBar(span, text, edit.width, parentEl);
    } else {
      span.setAttribute('data-cr', 'o');
      if (this.cfg.blockCopy) span.setAttribute('data-cr-nc', '1');
      span.textContent = text;
    }
    target.parentNode.replaceChild(span, target);
  }

  /* Replace mode: the text is gone, so the box has to carry the width that text
     would have had, or the rest of the line reflows. */
  paintBar(span, text, width, styleFrom) {
    if (this.cfg.fill === 'blocks') {
      span.setAttribute('data-cr-f', 'b');
      const font = styleFrom ? this.fontOf(styleFrom) : null;
      const unit = font && width != null ? this.measureText(CR_BLOCK_CHAR, font) : 0;
      const count = unit > 0 ? Math.max(1, Math.round(width / unit)) : text.length;
      span.textContent = CR_BLOCK_CHAR.repeat(count);
    } else {
      span.style.width = width != null
        ? Math.max(2, width).toFixed(2) + 'px'
        : (text.length * 0.55).toFixed(2) + 'em';
    }
  }

  /* Modes that may need a measured-width box: replace always, substitute only
     for phrases the list gave no replacement for. */
  usesBars() {
    return this.cfg.mode === 'replace' || this.cfg.mode === 'substitute';
  }

  /* The replacement for a matched phrase, or null if this mode or this list
     entry doesn't have one. Looked up by the matched text rather than by which
     alternative fired, so a phrase matched across a newline still resolves. */
  substitutionFor(matched) {
    if (this.cfg.mode !== 'substitute' || matched == null) return null;
    const value = this.replacements.get(crMatchKey(matched, this.cfg.caseSensitive));
    if (value === undefined) return null;
    return this.cfg.mimicCase ? crMimicCase(matched, value) : value;
  }

  /* Plain-text redaction, for places that can't hold markup: attributes and the
     tab title. */
  swapText(matched) {
    const substitution = this.substitutionFor(matched);
    return substitution != null ? substitution : CR_BLOCK_CHAR.repeat(matched.length);
  }

  measureEdit(edit) {
    const el = edit.node.parentElement;
    if (!el) return null;
    return this.measureText(edit.text, this.fontOf(el));
  }

  fontOf(el) {
    let font = this.fontCache.get(el);
    if (!font) {
      const cs = getComputedStyle(el);
      font = {
        font: cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily,
        ls: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
      };
      this.fontCache.set(el, font);
    }
    return font;
  }

  measureText(text, font) {
    const key = font.font + ' ' + font.ls + ' ' + text;
    let width = this.widthCache.get(key);
    if (width === undefined) {
      this.ctx.font = font.font;
      try { this.ctx.letterSpacing = font.ls; } catch (e) { /* pre-99 Chrome */ }
      width = this.ctx.measureText(text).width;
      if (this.widthCache.size > 4000) this.widthCache.clear();
      this.widthCache.set(key, width);
    }
    return width;
  }

  /* ---------------- reacting to page changes ---------------- */

  /* Deliberately synchronous, and deliberately not debounced. A MutationObserver
     callback is a microtask: it runs after the mutation but before the browser
     paints that frame, which is exactly why injected content never flashes.
     Deferring this to a timer or rAF would put the flash back. */
  onMutations(records) {
    if (!this.active || !this.pattern) return;
    const targets = new Set();

    for (const record of records) {
      const target = record.target;
      if (this.inRedaction(target)) continue;

      if (record.type === 'attributes') {
        if (this.cfg.redactAttributes && target.nodeType === 1) {
          const edits = [];
          this.collectAttrs(target, edits);
          if (edits.length) this.apply(edits);
        }
        continue;
      }

      if (record.type === 'characterData') {
        const block = this.blockAncestor(target.parentNode);
        if (block) targets.add(block);
        continue;
      }

      for (const added of record.addedNodes) {
        if (added.nodeType === 1 && added.namespaceURI === CR_XHTML && CR_BLOCK.has(added.tagName)) {
          // Self-contained block: scan just it. Stops appending to a long list
          // from degrading into a rescan of the whole list every time.
          if (!added.hasAttribute('data-cr')) targets.add(added);
        } else if (added.nodeType === 1 || added.nodeType === 3) {
          // Inline or bare text: widen to the block, so a keyword split across
          // the new node and its neighbours is still found.
          const block = this.blockAncestor(record.target);
          if (block) targets.add(block);
        }
      }
    }

    if (targets.size) {
      const edits = [];
      for (const node of targets) {
        if (this.hasAncestorIn(node, targets)) continue;
        this.collect(node, edits);
      }
      if (edits.length) this.apply(edits);
    }

    if (this.cfg.redactTitle && window.top === window) this.fixTitle();

    // Drop the records our own writes just queued. Safe because everything above
    // ran synchronously, so no page mutation can have interleaved with it.
    this.observer.takeRecords();
  }

  blockAncestor(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let found = null;
    while (el) {
      if (el.hasAttribute && el.hasAttribute('data-cr')) return null;
      if (!found && el.namespaceURI === CR_XHTML && CR_BLOCK.has(el.tagName)) found = el;
      el = el.parentElement;
    }
    return found;
  }

  hasAncestorIn(node, set) {
    let el = node.parentNode;
    while (el) {
      if (set.has(el)) return true;
      el = el.parentNode;
    }
    return false;
  }

  inRedaction(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (el.hasAttribute && el.hasAttribute('data-cr')) return true;
      el = el.parentElement;
    }
    return false;
  }

  fixTitle() {
    const title = document.title;
    if (title === this.lastTitle) return;
    const re = this.pattern;
    re.lastIndex = 0;
    if (re.test(title)) {
      re.lastIndex = 0;
      this.lastTitle = title.replace(re, (m) => this.swapText(m));
      document.title = this.lastTitle;
    } else {
      this.lastTitle = title;
    }
    re.lastIndex = 0;
  }

  /* ---------------- width upkeep (replace mode) ---------------- */

  /* Bars created while the page was still unstyled were measured against the
     wrong font. Re-measure once webfonts and stylesheets settle, and again when
     the viewport changes size under them. */
  installRemeasureHooks() {
    if (!this.usesBars()) return;
    const again = () => this.remeasure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(again).catch(() => {});
    window.addEventListener('load', again, { once: true });
    let timer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(again, 200);
    });
  }

  remeasure() {
    if (!this.active || !this.usesBars()) return;
    const pending = this.observer.takeRecords();
    if (pending.length) this.onMutations(pending);

    this.fontCache = new WeakMap();
    this.widthCache.clear();

    const jobs = [];
    for (const root of this.roots) {
      for (const span of root.querySelectorAll('span[data-cr="r"]')) {
        const text = this.originals.get(span);
        if (text == null || !span.parentElement) continue;
        const font = this.fontOf(span.parentElement);
        jobs.push({ span, text, width: this.measureText(text, font) });
      }
    }
    for (const job of jobs) this.paintBar(job.span, job.text, job.width, job.span.parentElement);

    this.observer.takeRecords();
  }
}
