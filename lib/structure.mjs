// Two-dimensional math structure analysis.
//
// The hard part of reading typeset maths is not the symbols but the layout: a
// fraction is a rule with ink above and below it, a radical is a surd followed by
// its vinculum, scripts are smaller glyphs raised or lowered against a base, and
// big operators take limits above/below or beside them.  This module rebuilds
// that structure from exact glyph and path geometry and emits LaTeX.

const EPS = 1e-6;

const OPERATOR_CHARS = new Set([
  '+', '−', '-', '=', '<', '>', '±', '∓', '×', '÷', '⋅', '·', '∘', '∗', '*',
  '≤', '≥', '≠', '≈', '≡', '∼', '≃', '≅', '∝', '≪', '≫', '→', '←', '↔', '⇒', '⇔',
  '∈', '∉', '⊂', '⊃', '⊆', '⊇', '∪', '∩', '∧', '∨', '⊕', '⊗', '∴', '⊥', '∥', '|',
  ',', ';', ':', '!', '?', '′', '″', '…', '⋯', '‥',
]);
const BIG_OPS = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '⋃', '⋂', '⨁', '⨂', '⨀', 'lim', 'max', 'min']);
const LARGE_OPS = new Set(['∑', '∏', '∐', '⋃', '⋂', '⨁', '⨂', '⨀']);
const INTEGRALS = new Set(['∫', '∬', '∭', '∮', '∯', '∰', '∱', '∲', '∳']);
const DELIMS_OPEN = new Set(['(', '[', '{', '⟨', '⌈', '⌊', '⟦', '⟪', '⦃', '‖']);
const DELIMS_CLOSE = new Set([')', ']', '}', '⟩', '⌉', '⌋', '⟧', '⟫', '⦄', '‖']);
const SPACING_WORDS = /^(\\[a-zA-Z]+|[a-zA-Z]+)$/;

const LATEX_FOR = new Map(Object.entries({
  '−': '-', '−-': '-', '×': '\\times ', '÷': '\\div ', '⋅': '\\cdot ', '·': '\\cdot ',
  '±': '\\pm ', '∓': '\\mp ', '≤': '\\leq ', '≥': '\\geq ', '≠': '\\neq ', '≈': '\\approx ',
  '≡': '\\equiv ', '∝': '\\propto ', '∞': '\\infty ', '∂': '\\partial ', '∇': '\\nabla ',
  '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ',
  '√': '\\sqrt', '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ', '⊃': '\\supset ',
  '∪': '\\cup ', '∩': '\\cap ', '→': '\\to ', '←': '\\leftarrow ', '↔': '\\leftrightarrow ',
  '⇒': '\\Rightarrow ', '⇔': '\\Leftrightarrow ', '∀': '\\forall ', '∃': '\\exists ',
  '≈': '\\approx ', '⋅⋅': '\\cdot ', '′': "'", '″': "''", '…': '\\dots ', '⋯': '\\cdots ',
  '⟨': '\\langle ', '⟩': '\\rangle ', '⌈': '\\lceil ', '⌉': '\\rceil ', '⌊': '\\lfloor ', '⌋': '\\rfloor ',
  '⊥': '\\perp ', '∥': '\\parallel ', '∠': '\\angle ', '∘': '\\circ ', '⊕': '\\oplus ', '⊗': '\\otimes ',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\epsilon ', 'ζ': '\\zeta ',
  'η': '\\eta ', 'θ': '\\theta ', 'ι': '\\iota ', 'κ': '\\kappa ', 'λ': '\\lambda ', 'μ': '\\mu ',
  'ν': '\\nu ', 'ξ': '\\xi ', 'ο': 'o', 'π': '\\pi ', 'ρ': '\\rho ', 'σ': '\\sigma ', 'ς': '\\varsigma ',
  'τ': '\\tau ', 'υ': '\\upsilon ', 'φ': '\\phi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ',
  'Σ': '\\Sigma ', 'Υ': '\\Upsilon ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ', '∇∇': '\\nabla ',
  'ℏ': '\\hbar ', 'ℓ': '\\ell ', '℘': '\\wp ', 'ℑ': '\\Im ', 'ℜ': '\\Re ',
  '‖': '\\|', '∴': '\\therefore ', '≅': '\\cong ', '≃': '\\simeq ', '∼': '\\sim ',
  '≪': '\\ll ', '≫': '\\gg ', '∅': '\\emptyset ', '∧': '\\wedge ', '∨': '\\vee ',
  '†': '\\dagger ', '‡': '\\ddagger ', '§': '\\S ', '¶': '\\P ',
}));

/** Render a decoded character as LaTeX (without surrounding $). */
export function latexChar(ch) {
  if (!ch) return '\\square ';
  if (LATEX_FOR.has(ch)) return LATEX_FOR.get(ch);
  const code = ch.codePointAt(0);
  // ASCII letters, digits and a few safe symbols pass through
  if (/^[A-Za-z0-9]$/.test(ch)) return ch;
  if (ch === '(' || ch === ')' || ch === '[' || ch === ']') return ch;
  if (ch === '+' || ch === '=' || ch === '<' || ch === '>' || ch === '/' || ch === ':' || ch === ';'
    || ch === ',' || ch === '.' || ch === '!' || ch === '?' || ch === '|' || ch === "'") return ch;
  if (ch === '{') return '\\{';
  if (ch === '}') return '\\}';
  if (ch === ' ') return '\\;';
  const greekLike = code >= 0x370 && code <= 0x3ff;
  if (greekLike) return ch;
  // Unknown non-ASCII: keep the character, LaTeX engines with unicode-math accept it
  return ch;
}

function glyphBox(g) {
  const w = (g.adv || 0.5) * g.scale;
  const asc = 0.75 * g.scale * 0.8;
  const desc = -0.25 * g.scale;
  return { x0: g.x, x1: g.x + w, yTop: g.y + asc, yBot: g.y + desc, xMid: g.x + w / 2 };
}

function isRule(path) {
  if (!path || path.pts.length < 2) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of path.pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX, h = maxY - minY;
  if (w < 6 || h > Math.max(3.5, w * 0.06)) return null;
  const thickness = Math.max(h, path.lineWidth || 0.5);
  return { x0: minX, x1: maxX, y: (minY + maxY) / 2, y0: minY, y1: maxY, w, thickness };
}

/** Collect candidate rules (fraction bars and radicals' vinculum). */
export function findRules(paths) {
  const rules = [];
  for (const p of paths) {
    const r = isRule(p);
    if (r) rules.push(r);
  }
  return rules;
}

/**
 * Analyse one page's glyphs into blocks of text and maths.
 * @returns {{blocks: Array, glyphs: Array}}
 */
export function analysePage(glyphs, paths, fonts, options = {}) {
  const { mathFontNames = new Set() } = options;
  const usable = glyphs.filter((g) => g.ch && g.ch !== ' ' && g.ch !== '\u00a0');
  const spaces = glyphs.filter((g) => g.ch === ' ' || g.ch === '\u00a0');
  const rules = findRules(paths);
  const isMathFont = (g) => {
    const f = fonts.get(g.font);
    if (!f) return false;
    if (mathFontNames.has(g.font)) return true;
    return /math|symbol|pi\d|cmsy|cmmi|cmex|msam|msbm|euclid|stix/i.test(f.baseFont ?? '');
  };
  for (const g of usable) g.math = isMathFont(g);

  // ---- cluster into horizontal lines by baseline
  const lines = [];
  const sorted = usable.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  for (const g of sorted) {
    const tol = Math.max(1.6, g.scale * 0.35);
    let line = lines.find((l) => Math.abs(l.y - g.y) <= Math.max(tol, l.tol));
    if (!line) {
      line = { y: g.y, tol, glyphs: [] };
      lines.push(line);
    }
    line.glyphs.push(g);
    line.tol = Math.max(line.tol, tol);
  }
  for (const l of lines) {
    l.glyphs.sort((a, b) => a.x - b.x);
    l.y = median(l.glyphs.map((g) => g.y));
    l.x0 = Math.min(...l.glyphs.map((g) => g.x));
    l.x1 = Math.max(...l.glyphs.map((g) => box1(g)));
    l.size = median(l.glyphs.map((g) => g.scale));
    l.mathShare = l.glyphs.filter((g) => g.math).length / l.glyphs.length;
    l.symbolShare = l.glyphs.filter((g) => OPERATOR_CHARS.has(g.ch) || BIG_OPS.has(g.ch)).length / l.glyphs.length;
  }
  lines.sort((a, b) => b.y - a.y);

  // ---- group lines into blocks separated by large vertical gaps
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    const gap = cur ? cur.bottom - l.y : 0;
    const limit = Math.max(6, (cur?.size ?? l.size) * 0.9);
    if (!cur || gap > limit) {
      cur = { lines: [], top: l.y, bottom: l.y - l.size, size: l.size };
      blocks.push(cur);
    }
    cur.lines.push(l);
    cur.bottom = Math.min(cur.bottom, l.y - l.size * 0.3);
    cur.size = Math.max(cur.size, l.size);
  }

  for (const b of blocks) {
    b.isMath = b.lines.some((l) => l.mathShare > 0.35 || l.symbolShare > 0.15);
    b.y0 = Math.min(...b.lines.map((l) => l.y));
    b.y1 = Math.max(...b.lines.map((l) => l.y));
  }

  // ---- attach rules to lines
  for (const r of rules) {
    r.line = null;
    let best = null;
    for (const l of lines) {
      const d = l.y - r.y;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    r.dyFromLine = best;
  }

  return { lines, blocks, rules, spaces };
}

function box1(g) {
  return g.x + (g.adv || 0.5) * g.scale;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------- expression trees

/**
 * Build a LaTeX string for one horizontal band of glyphs, resolving fractions,
 * radicals, scripts and big-operator limits.
 */
export function buildExpression(items, rules, ctx) {
  // items: glyphs sorted by x, confined to one band (worked out by callers)
  const nodes = layoutNodes(items, ctx);
  const resolved = resolveFractions(nodes, rules, ctx);
  return emitSequence(resolved, ctx);
}

/** Group glyphs into lateral runs, attaching scripts to their base. */
function layoutNodes(items, ctx) {
  const nodes = [];
  const list = items.slice().sort((a, b) => a.x - b.x);
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const size = ctx.baseSize || g.scale;
    const isScript = g.scale < size * 0.78;
    const node = { kind: 'sym', g, sup: [], sub: [], children: [] };
    if (isScript) {
      // find the nearest preceding non-script base on the same band
      let base = null;
      for (let k = nodes.length - 1; k >= 0; k--) {
        const cand = nodes[k];
        if (cand.kind === 'sym' && cand.g.scale >= size * 0.78) { base = cand; break; }
        if (cand.kind === 'group') { base = cand; break; }
      }
      if (base) {
        const baseTop = base.kind === 'sym' ? boxTop(base.g) : base.top;
        const baseBot = base.kind === 'sym' ? boxBot(base.g) : base.bot;
        if (g.y >= (baseTop + baseBot) / 2) base.sup.push(node);
        else base.sub.push(node);
        continue;
      }
    }
    nodes.push(node);
  }
  return nodes;
}

function boxTop(g) { return g.y + 0.62 * g.scale; }
function boxBot(g) { return g.y - 0.22 * g.scale; }

/** Merge nodes that sit above and below a rule into a fraction node. */
function resolveFractions(nodes, rules, ctx) {
  if (!rules || !rules.length) return nodes;
  const out = nodes.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rules) {
      if (r.used) continue;
      const above = [];
      const below = [];
      const rest = [];
      for (const n of out) {
        if (n.kind !== 'sym') { rest.push(n); continue; }
        const b = n.g;
        const w = (b.adv || 0.5) * b.scale;
        const overlapsX = b.x + w > r.x0 - 1 && b.x < r.x1 + 1;
        const centerX = b.x + w / 2;
        const nearX = centerX > r.x0 - r.w * 0.9 && centerX < r.x1 + r.w * 0.9;
        if (!overlapsX && !nearX) { rest.push(n); continue; }
        const top = boxTop(b), bot = boxBot(b);
        if (bot >= r.y1 - 0.5) above.push(n);
        else if (top <= r.y0 + 0.5) below.push(n);
        else rest.push(n);
      }
      if (!above.length || !below.length) continue;
      // the rule must be between the two groups
      const aboveBot = Math.min(...above.map((n) => boxBot(n.g)));
      const belowTop = Math.max(...below.map((n) => boxTop(n.g)));
      if (!(aboveBot > r.y1 - 1.5 && belowTop < r.y0 + 1.5)) continue;
      r.used = true;
      const inner = ctx.withRules ? resolveFractions([...above, ...below], ctx.remainingRules ?? [], ctx) : null;
      const num = emitSequence(resolveFractions(above, ctx.remainingRules ?? [], ctx), ctx);
      const den = emitSequence(resolveFractions(below, ctx.remainingRules ?? [], ctx), ctx);
      void inner;
      out.length = 0;
      out.push(...rest, { kind: 'frac', num, den, x0: r.x0, x1: r.x1, y: r.y });
      out.sort((a, b) => nodeX0(a) - nodeX0(b));
      changed = true;
      break;
    }
  }
  return out;
}

function nodeX0(n) {
  if (n.kind === 'sym') return n.g.x;
  return n.x0 ?? 0;
}

function emitSequence(nodes, ctx) {
  let out = '';
  let prev = null;
  for (const n of nodes) {
    if (n.kind === 'frac') {
      out += `\\frac{${n.num}}{${n.den}}`;
      prev = n;
      continue;
    }
    const g = n.g;
    if (prev && needsSpace(prev, g)) out += ' ';
    let piece = latexChar(g.ch);
    if (n.sub.length || n.sup.length) {
      const sub = n.sub.length ? emitSequence(n.sub, ctx) : '';
      const sup = n.sup.length ? emitSequence(n.sup, ctx) : '';
      // big operators take limits above/below, ordinary symbols take scripts
      const base = (BIG_OPS.has(g.ch) || g.limits) ? piece.replace(/\s+$/, '') : piece;
      if (sub && sup) out += `${base}_{${sub}}^{${sup}}`;
      else if (sub) out += `${base}_{${sub}}`;
      else if (sup) out += `${base}^{${sup}}`;
    } else {
      out += piece;
    }
    prev = g;
  }
  return out.replace(/\s+$/, '');
}

function needsSpace(prev, g) {
  if (!prev || prev.kind === 'frac') return false;
  const a = prev.g.ch, b = g.ch;
  if (!a || !b) return false;
  if (OPERATOR_CHARS.has(a) || OPERATOR_CHARS.has(b)) return true;
  // keep function names attached to their argument
  if (/^[a-zA-Z]$/.test(a) && /^[a-zA-Z]$/.test(b)) {
    const gap = g.x - (prev.g.x + (prev.g.adv || 0.5) * prev.g.scale);
    return gap > g.scale * 0.22;
  }
  if (SPACING_WORDS.test(a) && b === '(') return false;
  return false;
}

void EPS;
void LARGE_OPS;
void INTEGRALS;
void DELIMS_OPEN;
void DELIMS_CLOSE;
