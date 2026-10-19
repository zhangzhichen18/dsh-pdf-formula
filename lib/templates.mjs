// Glyph template library and shape matcher.
//
// The document's maths fonts are subset CFF faces whose glyph names were destroyed
// by the subsetter (/H6036, sid391, ...) and which carry no ToUnicode map, while
// the text faces (Times-Roman/Bold/Italic) are not embedded at all.  Codepoints
// therefore cannot be recovered from names or maps: they are recovered from the
// glyph's *outline shape*, matched against templates rendered from system fonts.
import { emGridBitmap, normalizePath, transformPath, signature, sigDistance, bboxOfPolys, flatten } from './raster.mjs';
import { ALL_CODES, STYLE_GROUPS, familyOf } from './symbols.mjs';
import { loadFace, faceForCode } from './fonts.mjs';

export const NORM = 32;        // comparison grid
export const EM_GRID = 48;     // rasterization grid for a template em box

let libCache = null;

function binarize(bm, w, h, thr = 0.45) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < bm.length; i++) out[i] = bm[i] >= thr ? 1 : 0;
  return out;
}

/**
 * Re-sample a coverage bitmap onto an n x n binary grid covering its ink box.
 * bm is a Float32Array of w*h coverage values (y-major).
 */
export function normInk(bm, w, h, n = NORM) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bm[y * w + x] >= 0.45) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const out = new Uint8Array(n * n);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      // majority ink vote over the source-area cell
      const sy0 = y0 + (gy * bh) / n, sy1 = y0 + ((gy + 1) * bh) / n;
      const sx0 = x0 + (gx * bw) / n, sx1 = x0 + ((gx + 1) * bw) / n;
      let acc = 0, count = 0;
      for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++) {
        for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          acc += bm[y * w + x] >= 0.45 ? 1 : 0;
          count++;
        }
      }
      out[gy * n + gx] = count && acc / count >= 0.5 ? 1 : 0;
    }
  }
  return { grid: out, aspect: bw / bh, bw, bh };
}

/** True for codepoints that are mathematical symbols rather than letters or marks. */
export function isSymbolCode(cp) {
  return (cp >= 0x2190 && cp <= 0x2bff) || (cp >= 0x00b1 && cp <= 0x00f7) || cp === 0x2032 || cp === 0x2033;
}

function iou(a, b) {  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x | y) { uni++; if (x & y) inter++; }
  }
  return uni ? inter / uni : 0;
}

/** Majority-vote resample of an n x n binary mask to size m (debug/diagnostics). */
export function resampleGrid(grid, n, m) {
  const out = new Uint8Array(m * m);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      let acc = 0, cnt = 0;
      const y0 = Math.floor((y * n) / m), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * n) / m));
      const x0 = Math.floor((x * n) / m), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * n) / m));
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) { acc += grid[sy * n + sx]; cnt++; }
      out[y * m + x] = cnt && acc / cnt >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

/**
 * A compact descriptor used for every template and every document glyph.
 * The mask is normalized by the glyph's own ink bounding box (scale-invariant);
 * the em-relative numbers are kept for the structural analyser.
 */
export function describeGlyphPath(path, { n = NORM, tol = 0.06, descent = -0.25, ascent = 0.75 } = {}) {
  const polys = flatten(path, tol);
  const box = bboxOfPolys(polys);
  if (!box || box.w <= 1e-6 || box.h <= 1e-6) return null;
  const norm = normalizePath(path, n, 4, tol);
  if (!norm) return null;
  const grid = new Uint8Array(n * n);
  const stride = n + 1; // normalizePath draws the shape into an (n+1)-wide mask
  const w = norm.w, h = norm.h;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // nearest-neighbour sample of the normalized mask
      const sx = Math.min(w - 1, Math.round((x / n) * w));
      const sy = Math.min(h - 1, Math.round((y / n) * h));
      grid[y * n + x] = norm.bm[sy * w + sx] >= 0.45 ? 1 : 0;
    }
  }
  void stride;
  return {
    grid,
    aspect: box.w / box.h,
    emHeight: box.h / (ascent - descent),
    emWidth: box.w / (ascent - descent),
    baselineOffset: -box.y0 / (ascent - descent),
    sig: signature(grid, n, n, 6),
    bbox: box,
  };
}

function inkOccupancy(bm, n) {
  let s = 0;
  for (const v of bm) s += v;
  return s / (n * n);
}

/** Descriptor for a document glyph: a path already in device (page) space. */
export function describeDevicePath(path, options) {
  return describeGlyphPath(path, options);
}

export function buildTemplateLibrary({ codes = ALL_CODES, verbose = false } = {}) {
  const templates = [];
  const missing = [];
  for (const cp of codes) {
    const face = faceForCode(cp);
    if (!face) { missing.push(cp); continue; }
    const gid = face.cmap.get(cp);
    const path = face.ttf.glyphPath(gid);
    if (!path || !path.cmds.length) { missing.push(cp); continue; }
    const scale = 1 / (face.unitsPerEm || 1000);
    const scaled = { cmds: path.cmds.map((c) => {
      const o = [c[0]];
      for (let i = 1; i < c.length; i += 2) { o.push(c[i] * scale, c[i + 1] * scale); }
      return o;
    }) };
    const desc = describeGlyphPath(scaled, { ascent: face.ascent, descent: face.descent });
    if (!desc) { missing.push(cp); continue; }
    // advance width in em units, for width-based disambiguation
    let adv = null;
    const hmtx = face.ttf.tables.get('hmtx');
    const hhea = face.ttf.tables.get('hhea');
    if (hmtx && hhea) {
      const buf = face.ttf.buf;
      const numH = ((buf[hhea.offset + 34] << 8) | buf[hhea.offset + 35]);
      const p = hmtx.offset + Math.min(gid, numH - 1) * 4;
      const aw = (buf[p] << 8) | buf[p + 1];
      adv = aw / (face.unitsPerEm || 1000);
    }
    templates.push({
      cp, ch: String.fromCodePoint(cp), style: face.style, font: face.path,
      family: familyOf(cp),
      ...desc, adv,
    });
  }
  if (verbose) console.error(`templates: ${templates.length} built, ${missing.length} codes unavailable`);
  return { templates, missing };
}

export function getTemplateLibrary(opts) {
  if (!libCache) libCache = buildTemplateLibrary(opts);
  return libCache;
}

let counter = 0;

/**
 * Rank templates against a document glyph descriptor.
 * score = IoU of ink-normalized masks, penalized by aspect mismatch, and boosted
 * when the glyph's advance width (when known) agrees with the template's.
 */
export function matchGlyph(desc, library, { styleHint = null, widthRatio = null, familyHint = null, preferSymbols = false, topK = 5, sigPrune = 0.55 } = {}) {
  if (!desc || !library) return [];
  const wantStyles = styleHint ? STYLE_GROUPS[styleHint] ?? null : null;

  // Two passes: first require a close aspect match, then relax only if the strict
  // pass found nothing (tall delimiters and wide operators need the loose pass).
  for (const maxAspect of [1.35, 2.4]) {
    const cands = [];
    for (const t of library.templates) {
      const aspectRatio = desc.aspect / t.aspect;
      if (aspectRatio > maxAspect || aspectRatio < 1 / maxAspect) continue;
      if (wantStyles && !wantStyles.includes(t.style)) continue;
      const sd = sigDistance(desc.sig, t.sig);
      if (sd > sigPrune) continue;
      cands.push({ t, sd });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.sd - b.sd);
    const shortlist = cands.slice(0, 300);
    const scored = [];
    for (const { t } of shortlist) {
      let s = iou(desc.grid, t.grid);
      const ar = Math.abs(Math.log(desc.aspect / t.aspect));
      s -= Math.min(0.3, ar * 0.45);
      if (wantStyles) {
        const rank = wantStyles.indexOf(t.style);
        s += 0.02 * (wantStyles.length - Math.max(rank, 0));
      }
      if (familyHint !== null && t.family === familyHint) s += 0.09;
      // A symbol font draws symbols, so a symbol candidate is more plausible than
      // an accented or letterlike look-alike (radical over logical-or, and so on).
      if (preferSymbols && isSymbolCode(t.cp)) s += 0.05;
      if (widthRatio !== null && t.adv) {
        const wr = Math.abs(Math.log((widthRatio || 0.5) / t.adv));
        s -= Math.min(0.25, wr * 0.18);
      }
      scored.push({ cp: t.cp, ch: t.ch, style: t.style, score: s, adv: t.adv, family: t.family });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    const seen = new Set();
    for (const c of scored) {
      if (out.length >= topK) break;
      if (seen.has(c.ch)) continue;
      seen.add(c.ch);
      out.push(c);
    }
    if (out.length) return out;
  }
  return [];
}
