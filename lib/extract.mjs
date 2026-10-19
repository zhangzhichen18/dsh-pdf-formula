// End-to-end extraction: PDF -> per-page text with 2-D formula structure.
//
// Pipeline: object layer -> content streams -> glyphs with exact geometry ->
// glyph decoding (ToUnicode / Differences / shape recognition) -> rule and
// structure analysis -> LaTeX for display equations and inline maths -> page
// text with word/line/column layout recovered.

import fs from 'node:fs';
import { PDFDocument } from './pdfobj.mjs';
import { interpretContent } from './content.mjs';
import { loadPageFonts, decodeGlyph } from './decode.mjs';
import { getTemplateLibrary } from './templates.mjs';
import { latexChar } from './structure.mjs';

const BIG_OPS = new Set(['\u2211', '\u220f', '\u2210', '\u22c3', '\u22c2',
  '\u2a01', '\u2a02', '\u2a00', '\u222b', '\u222c', '\u222d', '\u222e']);
const SURDS = new Set(['\u221a', '\u221b', '\u221c', '\u23b7']);
const INFIX_OPS = new Set([
  '+', '\u2212', '-', '=', '<', '>', '\u00b1', '\u2213', '\u00d7', '\u00f7', '\u22c5', '\u00b7',
  '\u2218', '\u2217', '*', '\u2264', '\u2265', '\u2260', '\u2248', '\u2261', '\u223c', '\u2243',
  '\u2245', '\u221d', '\u226a', '\u226b', '\u2192', '\u2190', '\u2194', '\u21d2', '\u21d4',
  '\u2208', '\u2209', '\u2282', '\u2283', '\u2286', '\u2287', '\u222a', '\u2229', '\u2227',
  '\u2228', '\u2295', '\u2297', '\u2234', '\u22a5', '\u2225',
]);

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function loadTemplateLibrarySafe() {
  try {
    return getTemplateLibrary();
  } catch {
    return null;
  }
}

function openDoc(filePath) {
  return new PDFDocument(fs.readFileSync(filePath));
}

function parsePageSelection(spec, total) {
  if (!spec || spec === 'all') return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) {
      const a = Math.max(1, +m[1]);
      const b = Math.min(total, +m[2]);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(t)) {
      const v = +t;
      if (v >= 1 && v <= total) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- geometry

function glyphWidth(g) { return (g.adv || 0.5) * g.scale; }
function glyphTop(g) { return g.y + 0.64 * g.scale; }
function glyphBot(g) { return g.y - 0.24 * g.scale; }
function glyphMid(g) { return g.y + 0.2 * g.scale; }

function ruleOf(path, pageSize) {
  if (!path || !path.pts || path.pts.length < 2) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of path.pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const w = x1 - x0, h = y1 - y0;
  // A fraction bar is a short, thin, horizontal rule; long horizontal rules are
  // page furniture and tall thin paths are not bars at all.
  if (w < Math.max(5, pageSize * 0.008)) return null;
  if (w > pageSize * 0.85) return null;
  if (h > Math.max(3, w * 0.05)) return null;
  if (w < h * 2) return null;
  return { x0, x1, y: (y0 + y1) / 2, w, h: Math.max(h, path.lineWidth || 0.4), used: false };
}

const MATH_FONT_RE = /math|symbol|pi\d|\bpi\b|cmsy|cmmi|cmex|msam|msbm|euclid|stix|mathematical/i;

/**
 * Classify glyphs as mathematical. Symbol fonts are also used for decorative
 * prose, so the font name alone is not decisive; recognised shapes that decode to
 * operators, Greek letters or big operators are counted too.
 */
function classifyMathGlyphs(model) {
  for (const g of model.glyphs) {
    const font = model.fonts.get(g.font);
    const base = font?.baseFont ?? '';
    g.mathFont = MATH_FONT_RE.test(base);
    g.math = g.mathFont && !/[A-Za-z]/.test(g.ch);
    if (!g.math && (INFIX_OPS.has(g.ch) || BIG_OPS.has(g.ch) || SURDS.has(g.ch)
      || /[\u0370-\u03ff\u2200-\u22ff\u2a00-\u2aff]/.test(g.ch))) g.math = true;
  }
}

// ---------------------------------------------------------------- page model

function buildPageModel(doc, page, pageNo, library) {
  const fonts = loadPageFonts(doc, page);
  const content = doc.pageContent(page);
  const decode = (fname, code) => decodeGlyph(fonts.get(fname), code, { library });
  const { glyphs, paths, images } = interpretContent(content, { fonts, decodeGlyph: decode, collectPaths: true });
  const media = page.mediaBox ?? [0, 0, 612, 792];
  const pw = Math.abs(media[2] - media[0]) || 612;
  const ph = Math.abs(media[3] - media[1]) || 792;
  const rules = [];
  for (const p of paths) {
    const r = ruleOf(p, Math.max(pw, ph));
    if (r) rules.push(r);
  }
  const model = {
    pageNo, fonts, rules, images, pw, ph, media,
    glyphs: glyphs.filter((g) => g.ch && g.ch !== '\u00a0'),
    allGlyphs: glyphs,
  };
  classifyMathGlyphs(model);
  return model;
}

// ---------------------------------------------------------------- layout

/**
 * Find a two-column gutter by voting: a column boundary shows up as a wide
 * horizontal gap on most body lines, while headers, figure captions and centred
 * equations span the page and simply do not vote.
 */
function findColumnGutter(model, lines) {
  const body = model.glyphs;
  if (body.length < 80 || !lines || lines.length < 6) return null;
  const pw = model.pw;
  const step = Math.max(1, pw / 600);
  const nb = Math.ceil(pw / step) + 2;
  const votes = new Int32Array(nb);
  let voters = 0;
  for (const l of lines) {
    if (l.x1 - l.x0 < pw * 0.08) continue;
    voters++;
    const gs = l.glyphs;
    // Word spaces are about 0.25 em, so half an em separates a word space from a
    // column gutter without hard-coding an absolute width.
    const minGap = Math.max(4, l.size * 0.5);
    let right = gs.length ? gs[0].x + glyphWidth(gs[0]) : 0;
    for (let i = 1; i < gs.length; i++) {
      const g = gs[i];
      if (g.x - right > minGap) {
        const a = Math.max(0, Math.floor(right / step));
        const b = Math.min(nb - 1, Math.ceil(g.x / step));
        for (let k = a; k <= b; k++) votes[k]++;
      }
      right = Math.max(right, g.x + glyphWidth(g));
    }
  }
  if (!voters) return null;
  const c0 = Math.floor(nb * 0.25), c1 = Math.ceil(nb * 0.75);
  let best = null;
  for (let k = c0; k < c1; k++) if (!best || votes[k] > best.votes) best = { x: k * step, votes: votes[k] };
  // Headers, figures and captions legitimately do not vote, so the bar is a
  // modest fraction of body lines rather than a majority.
  if (!best || best.votes < Math.max(6, voters * 0.12)) return null;
  const left = body.filter((g) => g.x + glyphWidth(g) <= best.x).length;
  const right = body.filter((g) => g.x >= best.x).length;
  if (left < body.length * 0.2 || right < body.length * 0.2) return null;
  const straddle = body.filter((g) => g.x < best.x && g.x + glyphWidth(g) > best.x).length;
  if (straddle > body.length * 0.04) return null;
  return best.x;
}

function linesOf(glyphs, pageNo) {
  const lines = [];
  const sorted = glyphs.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  for (const g of sorted) {
    const tol = Math.max(1.5, g.scale * 0.4);
    let line = null;
    for (const l of lines) {
      if (Math.abs(l.y - g.y) <= Math.max(tol, l.tol)) { line = l; break; }
    }
    if (!line) {
      line = { y: g.y, tol, glyphs: [], page: pageNo };
      lines.push(line);
    }
    line.glyphs.push(g);
    line.tol = Math.max(line.tol, tol);
  }
  for (const l of lines) {
    l.glyphs.sort((a, b) => a.x - b.x);
    l.y = median(l.glyphs.map((g) => g.y));
    l.size = median(l.glyphs.map((g) => g.scale));
    l.x0 = Math.min(...l.glyphs.map((g) => g.x));
    l.x1 = Math.max(...l.glyphs.map((g) => g.x + glyphWidth(g)));
    l.mathShare = l.glyphs.filter((g) => g.math || INFIX_OPS.has(g.ch) || BIG_OPS.has(g.ch)).length / l.glyphs.length;
  }
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

function groupLineBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    const gap = cur ? cur.lines[cur.lines.length - 1].y - l.y : 0;
    if (!cur || gap > Math.max(cur.size * 1.75, 8)) {
      cur = { lines: [l], size: l.size, top: l.y, bottom: l.y };
      blocks.push(cur);
    } else {
      cur.lines.push(l);
      cur.size = Math.max(cur.size, l.size);
      cur.bottom = l.y;
    }
  }
  return blocks;
}

/** Two glyphs stacked in one construction (a numerator over its bar, a limit over a sum). */
function verticallyConnected(a, b) {
  const ax0 = a.x, ax1 = a.x + glyphWidth(a);
  const bx0 = b.x, bx1 = b.x + glyphWidth(b);
  const overlap = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  if (overlap <= 0) return false;
  if (overlap < Math.min(ax1 - ax0, bx1 - bx0) * 0.5) return false;
  const size = Math.max(a.scale, b.scale);
  const yGap = Math.max(glyphBot(a) - glyphTop(b), glyphBot(b) - glyphTop(a));
  return yGap < size * 0.45;
}

function mergeDisplayLines(lines, model) {
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (!cur) { cur = { lines: [l] }; blocks.push(cur); continue; }
    const prev = cur.lines[cur.lines.length - 1];
    const size = Math.max(l.size, prev.size);
    if (prev.y - l.y > size * 2.1) { cur = { lines: [l] }; blocks.push(cur); continue; }
    const connected = l.glyphs.some((g) => prev.glyphs.some((p) => verticallyConnected(p, g)));
    const ruleBetween = model.rules.some((r) => r.y < prev.y + size * 0.4 && r.y > l.y - size * 0.4
      && r.x1 > Math.min(prev.x0, l.x0) && r.x0 < Math.max(prev.x1, l.x1));
    // Joining two lines into one equation needs a real horizontal relationship:
    // lines that merely share a few points of width (the two columns of a page)
    // must never merge.
    const narrower = Math.min(prev.x1 - prev.x0, l.x1 - l.x0);
    const overlap = Math.min(prev.x1, l.x1) - Math.max(prev.x0, l.x0);
    const aligned = overlap > narrower * 0.55;
    const mathy = (prev.mathShare ?? 0) > 0.2 && (l.mathShare ?? 0) > 0.2;
    const close = prev.y - l.y < size * 1.7;
    if (connected) cur.lines.push(l);
    else if (aligned && mathy && (ruleBetween || close)) cur.lines.push(l);
    else { cur = { lines: [l] }; blocks.push(cur); }
  }
  for (const b of blocks) {
    b.glyphs = b.lines.flatMap((l) => l.glyphs).sort((a, z) => a.x - z.x);
    b.size = median(b.glyphs.map((g) => g.scale));
    b.top = Math.max(...b.lines.map((l) => l.y));
    b.bottom = Math.min(...b.lines.map((l) => l.y));
    b.x0 = Math.min(...b.lines.map((l) => l.x0));
    b.x1 = Math.max(...b.lines.map((l) => l.x1));
    b.mathShare = b.glyphs.filter((g) => g.math).length / b.glyphs.length;
    b.ops = b.glyphs.filter((g) => BIG_OPS.has(g.ch) || INFIX_OPS.has(g.ch)).length;
    b.hasBigOp = b.glyphs.some((g) => BIG_OPS.has(g.ch));
    b.hasScript = b.glyphs.some((g) => g.scale < b.size * 0.72);
    b.hasRule = model.rules.some((r) => r.y <= b.top + b.size * 0.6 && r.y >= b.bottom - b.size * 0.6
      && r.x1 > b.x0 - 3 && r.x0 < b.x1 + 3);
    b.width = b.x1 - b.x0;
  }
  return blocks;
}

function isMathGlyph(g) {
  if (!g.ch) return false;
  return !!(g.math || INFIX_OPS.has(g.ch) || BIG_OPS.has(g.ch) || SURDS.has(g.ch)
    || /[\u0370-\u03ff]/.test(g.ch));
}

function isDisplayMathBlock(block, model) {
  const glyphs = block.glyphs ?? block.lines.flatMap((l) => l.glyphs);
  if (glyphs.length < 3) return false;
  // A formula is a compact construction, not a paragraph: reject anything that
  // runs on for many lines or spans a large vertical extent.
  if (block.lines.length > 4) return false;
  const yTop = Math.max(...block.lines.map((l) => l.y));
  const yBot = Math.min(...block.lines.map((l) => l.y));
  const size = block.size || median(glyphs.map((g) => g.scale));
  if (yTop - yBot > size * 3.5) return false;
  if (glyphs.length > 120) return false;
  // Count everything that is mathematical, not only glyphs from a maths font:
  // this document sets operators such as x and + in the symbol fonts, but a rule
  // with ink above and below is a fraction regardless of which font drew it.
  const mathShare = glyphs.filter(isMathGlyph).length / glyphs.length;
  const ops = glyphs.filter((g) => BIG_OPS.has(g.ch) || INFIX_OPS.has(g.ch)).length;
  const hasBigOp = block.hasBigOp ?? glyphs.some((g) => BIG_OPS.has(g.ch));
  const hasScript = block.hasScript ?? glyphs.some((g) => g.scale < size * 0.72);
  const x0 = block.x0 ?? Math.min(...block.lines.map((l) => l.x0));
  const x1 = block.x1 ?? Math.max(...block.lines.map((l) => l.x1));  const width = block.width || x1 - x0;
  const vSpan = block.lines.length > 1
    ? Math.max(...block.lines.map((l) => l.y)) - Math.min(...block.lines.map((l) => l.y))
    : 0;
  const hasRule = block.hasRule ?? model.rules.some((r) => r.y <= block.top + size * 0.6 && r.y >= block.bottom - size * 0.6
    && r.x1 > x0 - 3 && r.x0 < x1 + 3);
  const centered = x0 > model.pw * 0.1 && x1 < model.pw * 0.97;
  const wide = width > model.pw * 0.14;
  const stacked = vSpan > size * 1.15;
  // Keep figure captions and prose out of the formula list. Sentences carry
  // punctuation and long lowercase runs; equations are dense in operators,
  // relations and maths-font glyphs.
  const punctuation = glyphs.filter((g) => ',.;:".!?'.includes(g.ch ?? '')).length;
  const longRuns = glyphs.filter((g) => /[a-z]{2,}/.test(g.ch ?? '')).length;
  const proseWords = glyphs.filter((g) => /[A-Za-z]/.test(g.ch ?? '')).length;
  const symbolCount = ops + glyphs.filter((g) => BIG_OPS.has(g.ch) || SURDS.has(g.ch)
    || /[\u0370-\u03ff]/.test(g.ch ?? '')).length;
  const symbolShare = symbolCount / glyphs.length;
  if (punctuation >= 2 && longRuns >= 4 && symbolShare < 0.15) return false;
  if (proseWords > glyphs.length * 0.62 && symbolShare < 0.12) return false;
  // A rule with material above and below it is a fraction: structural proof, so
  // it does not need a high symbol density.
  if (hasRule && stacked && (glyphs.length >= 6 || symbolCount >= 3)) return true;
  if (symbolCount < 3) return false;
  if (hasBigOp) return true;
  if (hasRule && wide) return true;
  if (stacked && (ops >= 1 || hasScript)) return true;
  if (symbolShare >= 0.18 && ops >= 1 && centered && wide) return true;
  return false;
}

/**
 * Grow a display block until it owns its whole construction: numerators,
 * denominators, limits and equation numbers sit just outside the band that was
 * detected, and leaving them behind turns a fraction into fragments.
 */
function expandDisplayBlock(block, model, claimed) {
  const owned = new Set(block.glyphs);
  const size = block.size;
  let x0 = block.x0, x1 = block.x1, top = block.top, bottom = block.bottom;
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const g of model.glyphs) {
      if (owned.has(g) || claimed.has(g)) continue;
      const gwid = glyphWidth(g);
      // Grow vertically to pick up numerators, denominators and limits, but only
      // just past the ends of the equation: a wider reach would swallow the
      // neighbouring column.
      if (!(g.x + gwid > x0 - size * 0.5 && g.x < x1 + size * 0.5)) continue;
      if (glyphBot(g) < top - size * 1.6) continue;
      if (glyphTop(g) > bottom + size * 1.6) continue;
      if (Math.abs(g.y - (top + bottom) / 2) > size * 3.2) continue;
      owned.add(g);
      x0 = Math.min(x0, g.x);
      x1 = Math.max(x1, g.x + gwid);
      top = Math.max(top, g.y);
      bottom = Math.min(bottom, g.y);
      grew = true;
    }
    if (!grew) break;
  }
  return { ...block, glyphs: [...owned].sort((a, b) => a.x - b.x), x0, x1, top, bottom };
}

/** Decide whether a word is part of an inline formula rather than prose. */
function wordIsMath(word, model) {
  const glyphs = word.glyphs.filter((g) => g.ch && g.ch.trim());
  if (!glyphs.length) return false;
  const mathGlyphs = glyphs.filter((g) => g.math);
  const mathFont = mathGlyphs.length / glyphs.length;
  const ops = glyphs.filter((g) => BIG_OPS.has(g.ch) || INFIX_OPS.has(g.ch)).length;
  const greek = glyphs.filter((g) => /[\u0370-\u03ff]/.test(g.ch)).length;
  const letters = glyphs.map((g) => g.ch).filter((c) => /[A-Za-z]/.test(c));
  const hasScript = glyphs.some((g) => g.scale < Math.max(...glyphs.map((x) => x.scale)) * 0.75);
  const ruleNear = model.rules.some((r) => !r.used && r.x1 > word.x0 - 1 && r.x0 < word.x1 + 1
    && Math.abs(r.y - glyphs[0].y) < word.size * 1.2);
  const mathChars = mathGlyphs.filter((g) => BIG_OPS.has(g.ch) || INFIX_OPS.has(g.ch) || /[\u0370-\u03ff]/.test(g.ch)).length;
  // Symbol fonts are also used for prose decoration, so the font alone is not
  // enough: it must carry symbols rather than letters.
  if (mathFont > 0.5 && (mathChars > 0 || !letters.length)) return true;
  if (ops > 0 || greek > 0 || hasScript || ruleNear) return true;
  if (letters.length === 1 && glyphs.length === 1) {
    const g = glyphs[0];
    if (g.font && model.fonts.get(g.font)?.style === 'italic') return true;
  }
  return false;
}

// ---------------------------------------------------------------- math tree

function renderRegion(glyphs, rules, ctx) {
  if (!glyphs.length) return '';
  const pieces = [];
  const used = new Set();
  const sorted = glyphs.slice().sort((a, b) => a.x - b.x);
  const baseSize = ctx.baseSize || median(sorted.map((g) => g.scale));

  const fracBars = [];
  for (const r of rules) {
    if (r.used) continue;
    const above = sorted.filter((g) => !used.has(g) && glyphMid(g) > r.y + 0.6 && glyphMid(g) < r.y + r.w * 1.5
      && g.x + glyphWidth(g) > r.x0 - 1.5 && g.x < r.x1 + 1.5);
    const below = sorted.filter((g) => !used.has(g) && glyphMid(g) < r.y - 0.6 && glyphMid(g) > r.y - r.w * 1.5
      && g.x + glyphWidth(g) > r.x0 - 1.5 && g.x < r.x1 + 1.5);
    if (above.length && below.length) fracBars.push({ rule: r, above, below });
  }
  for (const fb of fracBars) for (const g of [...fb.above, ...fb.below]) used.add(g);

  let i = 0;
  while (i < sorted.length) {
    const g = sorted[i];
    if (used.has(g)) { i++; continue; }
    const fb = fracBars.find((f) => f.above.includes(g) || f.below.includes(g));
    if (fb) {
      const num = renderRegion(fb.above, [], { ...ctx, baseSize: median(fb.above.map((x) => x.scale)) });
      const den = renderRegion(fb.below, [], { ...ctx, baseSize: median(fb.below.map((x) => x.scale)) });
      pieces.push({ x: Math.min(...[...fb.above, ...fb.below].map((q) => q.x)), latex: `\\frac{${num}}{${den}}` });
      const next = sorted.findIndex((q) => !used.has(q) && q.x > fb.rule.x1);
      i = next < 0 ? sorted.length : next;
      continue;
    }
    if (SURDS.has(g.ch)) {
      const von = rules.find((r) => !r.used && r.x1 > g.x && r.x0 <= g.x + glyphWidth(g) * 1.6
        && r.y > g.y && r.y < glyphTop(g) + g.scale * 0.7);
      if (von) {
        const inner = sorted.filter((q) => q !== g && !used.has(q)
          && q.x >= von.x0 - 1 && q.x + glyphWidth(q) <= von.x1 + 2
          && glyphMid(q) < von.y + 0.5 && glyphMid(q) > von.y - von.w * 1.2);
        if (inner.length) {
          for (const q of inner) used.add(q);
          von.used = true;
          const body = renderRegion(inner, rules.filter((r) => r !== von), { ...ctx, baseSize: median(inner.map((q) => q.scale)) });
          pieces.push({ x: g.x, latex: `\\sqrt{${body}}` });
          const next = sorted.findIndex((q) => !used.has(q) && q.x > von.x1);
          i = next < 0 ? sorted.length : next;
          continue;
        }
      }
    }
    const sup = [];
    const sub = [];
    if (g.scale >= baseSize * 0.7 || BIG_OPS.has(g.ch)) {
      const w = glyphWidth(g);
      const top = glyphTop(g), bot = glyphBot(g);
      for (const q of sorted) {
        if (q === g || used.has(q)) continue;
        if (q.scale > baseSize * 0.82) continue;
        if (!(q.x + glyphWidth(q) > g.x - w * 0.3 && q.x < g.x + w * 1.3)) continue;
        if (glyphBot(q) >= top - q.scale * 0.35) { sup.push(q); used.add(q); }
        else if (glyphTop(q) <= bot + q.scale * 0.35) { sub.push(q); used.add(q); }
      }
    }
    let latex = latexChar(g.ch);
    if (sup.length || sub.length) {
      const supTex = sup.length ? renderRegion(sup, [], { ...ctx, baseSize: median(sup.map((q) => q.scale)) }) : '';
      const subTex = sub.length ? renderRegion(sub, [], { ...ctx, baseSize: median(sub.map((q) => q.scale)) }) : '';
      const base = latex.replace(/\s+$/, '');
      if (subTex && supTex) latex = `${base}_{${subTex}}^{${supTex}}`;
      else if (subTex) latex = `${base}_{${subTex}}`;
      else if (supTex) latex = `${base}^{${supTex}}`;
    }
    pieces.push({ x: g.x, latex });
    i++;
  }
  pieces.sort((a, b) => a.x - b.x);
  let out = '';
  let prevX1 = null;
  for (const p of pieces) {
    if (prevX1 !== null && p.x - prevX1 > baseSize * 0.45) {
      if (/[+\-=<>]$/.test(out.replace(/\s+$/, '')) || /^[+\-=<>]/.test(p.latex)) out += ' ';
    }
    out += p.latex;
    prevX1 = p.x + baseSize * 0.35;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- text

function groupWords(line) {
  const out = [];
  let cur = null;
  const gaps = [];
  for (let i = 1; i < line.glyphs.length; i++) {
    const prev = line.glyphs[i - 1];
    gaps.push(line.glyphs[i].x - (prev.x + glyphWidth(prev)));
  }
  const positive = gaps.filter((g) => g > 0.4).sort((a, b) => a - b);
  const spaceW = positive.length
    ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.25))]
    : Math.max(0.18, line.size * 0.22);
  for (const g of line.glyphs) {
    const gap = cur ? g.x - cur.x1 : 0;
    const size = Math.max(g.scale, cur?.size ?? g.scale);
    const breakGap = Math.max(1.1, spaceW * 1.25);
    const fontChanged = cur && cur.font !== g.font && gap > size * 0.12;
    if (!cur || gap > breakGap || fontChanged) {
      cur = { glyphs: [g], x0: g.x, x1: g.x + glyphWidth(g), size: g.scale, font: g.font };
      out.push(cur);
    } else {
      cur.glyphs.push(g);
      cur.x1 = Math.max(cur.x1, g.x + glyphWidth(g));
      cur.size = Math.max(cur.size, g.scale);
    }
  }
  return out;
}

function renderProseLine(line, model) {
  const words = groupWords(line);
  let out = '';
  let first = true;
  for (const w of words) {
    const glyphs = w.glyphs.filter((g) => g.ch && g.ch.trim());
    if (!glyphs.length) continue;
    if (!first) out += ' ';
    first = false;
    if (wordIsMath(w, model)) out += `$${renderRegion(glyphs, model.rules, { baseSize: w.size })}$`;
    else out += glyphs.map((g) => g.ch).join('');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function renderLine(line) {
  return groupWords(line)
    .map((w) => w.glyphs.filter((g) => g.ch && g.ch.trim()).map((g) => g.ch).join(''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHeadingLine(line) {
  const text = line.glyphs.map((g) => g.ch).join('');
  return /^\s*\d+(\.\d+)*\s+\S/.test(text) && text.length < 70 && line.glyphs.every((g) => !g.math);
}

function pageRegions(model, pageNo) {
  const allLines = linesOf(model.glyphs, pageNo);
  const gutter = findColumnGutter(model, allLines);
  if (gutter === null) return { gutter, regions: [allLines] };
  return {
    gutter,
    regions: [
      linesOf(model.glyphs.filter((g) => g.x + glyphWidth(g) <= gutter), pageNo),
      linesOf(model.glyphs.filter((g) => g.x >= gutter), pageNo),
    ],
  };
}

function detectDisplayBlocks(model, lines) {
  const claimed = new Set();
  const blocks = [];
  for (const b of mergeDisplayLines(lines, model)) {
    if (isDisplayMathBlock(b, model)) {
      const grown = expandDisplayBlock(b, model, claimed);
      for (const g of grown.glyphs) claimed.add(g);
      blocks.push({ ...grown, display: true });
    } else {
      // Claim the block's own glyphs: otherwise a glyph that a display block
      // later absorbs would be rendered twice.
      for (const g of b.glyphs) claimed.add(g);
      blocks.push({ ...b, display: false });
    }
  }
  for (const l of lines) {
    if (l.glyphs.some((g) => claimed.has(g))) continue;
    for (const g of l.glyphs) claimed.add(g);
    blocks.push({
      lines: [l], glyphs: l.glyphs, size: l.size, top: l.y, bottom: l.y,
      x0: l.x0, x1: l.x1, display: false,
    });
  }
  return blocks;
}

function renderPage(model, pageNo, formulas) {
  const { gutter, regions } = pageRegions(model, pageNo);
  const ordered = [];
  for (const lines of regions) {
    if (!formulas) {
      for (const b of groupLineBlocks(lines)) {
        ordered.push({
          lines: b.lines,
          glyphs: b.lines.flatMap((l) => l.glyphs),
          size: b.size,
          top: b.lines[0].y,
          bottom: b.lines[b.lines.length - 1].y,
          x0: Math.min(...b.lines.map((l) => l.x0)),
          x1: Math.max(...b.lines.map((l) => l.x1)),
          display: false,
        });
      }
      continue;
    }
    for (const b of detectDisplayBlocks(model, lines)) ordered.push(b);
  }
  ordered.sort((a, b) => b.top - a.top);

  const rendered = [];
  for (const b of ordered) {
    if (b.display) {
      const latex = renderRegion(b.glyphs, model.rules, { baseSize: b.size });
      if (latex) {
        rendered.push({ type: 'display', text: latex, display: true });
        continue;
      }
    }
    if (b.lines.length === 1 && isHeadingLine(b.lines[0])) {
      rendered.push({ type: 'heading', text: renderLine(b.lines[0]), display: false });
      continue;
    }
    const parts = [];
    for (let li = 0; li < b.lines.length; li++) {
      const l = b.lines[li];
      const t = formulas ? renderProseLine(l, model) : renderLine(l);
      if (!t) continue;
      if (li > 0 && parts.length) {
        const prevText = parts[parts.length - 1];
        if (/[A-Za-z]-$/.test(prevText) && /^[a-z]/.test(t)) {
          parts[parts.length - 1] = prevText.replace(/-$/, '') + t;
          continue;
        }
        if (/[A-Za-z]$/.test(prevText) && /^[a-z]/.test(t) && !/\$/.test(prevText)) {
          parts[parts.length - 1] = prevText + t;
          continue;
        }
      }
      parts.push(t);
    }
    if (parts.length) rendered.push({ type: 'paragraph', text: parts.join('\n'), display: false });
  }
  return { rendered, gutter };
}

// ---------------------------------------------------------------- public API

export async function pdfInfo(filePath) {
  const doc = openDoc(filePath);
  const pages = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const media = page.mediaBox ?? [0, 0, 612, 792];
    const fontsOut = [];
    for (const [name, obj] of doc.pageFonts(page)) {
      const d = doc.dict(obj);
      const descRef = /\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(d);
      const fd = descRef ? doc.dict(+descRef[1]) : '';
      fontsOut.push({
        name,
        baseFont: /\/BaseFont\s*\/([^\s/>]+)/.exec(d)?.[1] ?? null,
        subtype: /\/Subtype\s*\/(\w+)/.exec(d)?.[1] ?? null,
        embedded: /\/FontFile/.test(fd),
      });
    }
    const hasText = /(Tj|TJ)/.test(doc.pageContent(page));
    pages.push({
      page: i + 1,
      width: Math.abs(media[2] - media[0]),
      height: Math.abs(media[3] - media[1]),
      rotate: page.rotate ?? 0,
      fonts: fontsOut,
      hasTextLayer: hasText,
      likelyScanned: !hasText,
    });
  }
  return {
    pages: pages.length,
    pageSizes: pages.slice(0, 5).map((p) => ({ page: p.page, width: p.width, height: p.height })),
    details: pages,
  };
}

export async function extractText(filePath, { pages: pageSpec, mode = 'markdown', formulas = true } = {}) {
  void mode;
  const doc = openDoc(filePath);
  const library = loadTemplateLibrarySafe();
  const selected = parsePageSelection(pageSpec, doc.pages.length);
  const out = [];
  for (const pageNo of selected) {
    const model = buildPageModel(doc, doc.pages[pageNo - 1], pageNo, library);
    const { rendered, gutter } = renderPage(model, pageNo, formulas);
    const lines = rendered
      .map((r) => ({ type: r.type, text: r.type === 'display' ? `$$${r.text}$$` : r.text, display: r.type === 'display' }))
      .filter((r) => r.text);
    const uncertain = new Map();
    for (const g of model.glyphs) {
      if (!g.ch || (g.confidence ?? 1) >= 0.5) continue;
      const key = `${g.font}:${g.code}`;
      const e = uncertain.get(key) ?? { ch: g.ch, font: g.font, code: g.code, confidence: +(g.confidence ?? 0).toFixed(2), count: 0 };
      e.count++;
      uncertain.set(key, e);
    }
    const text = lines.map((r) => r.text).join('\n');
    out.push({
      page: pageNo, lines, text, markdown: text,
      columns: gutter === null ? 1 : 2,
      glyphCount: model.glyphs.length,
      ruleCount: model.rules.length,
      imageCount: model.images.length,
      uncertainSymbols: [...uncertain.values()],
    });
  }
  return { pages: out, pageCount: doc.pages.length };
}

export async function extractFormulas(filePath, { pages: pageSpec, minConfidence = 0.5, includeUncertain = true } = {}) {
  const doc = openDoc(filePath);
  const library = loadTemplateLibrarySafe();
  const selected = parsePageSelection(pageSpec, doc.pages.length);
  const out = [];
  for (const pageNo of selected) {
    const model = buildPageModel(doc, doc.pages[pageNo - 1], pageNo, library);
    const { regions } = pageRegions(model, pageNo);
    const formulas = [];
    for (const lines of regions) {
      for (const b of detectDisplayBlocks(model, lines)) {
        if (!b.display) continue;
        const latex = renderRegion(b.glyphs, model.rules, { baseSize: b.size });
        if (!latex) continue;
        const confs = b.glyphs.map((g) => g.confidence ?? 0.9);
        const confidence = confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : 0;
        const uncertain = b.glyphs
          .filter((g) => (g.confidence ?? 1) < minConfidence)
          .map((g) => ({ ch: g.ch, code: g.code, font: g.font, confidence: +(g.confidence ?? 0).toFixed(2), source: g.source }))
          .slice(0, 40);
        if (confidence < minConfidence && !includeUncertain) continue;
        formulas.push({
          latex,
          confidence: +confidence.toFixed(3),
          y: +b.top.toFixed(1),
          glyphCount: b.glyphs.length,
          uncertain,
        });
      }
    }
    out.push({ page: pageNo, formulas });
  }
  return { pages: out, pageCount: doc.pages.length };
}
