// Outline path model, affine transforms, and an anti-aliased scanline rasterizer.
// Pure JS, no dependencies. Used for BOTH document glyphs and template glyphs, so a
// single rasterization convention guarantees comparable bitmaps.

export const IDENT = [1, 0, 0, 1, 0, 0];

/** a∘b : apply b first, then a.  [a b c d e f] maps (x,y) -> (a x + c y + e, b x + d y + f) */
export function mul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function applyPt(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function scaleOf(m) {
  return Math.hypot(m[0], m[1]) || 1;
}

/** A path is { cmds: [...], closed: boolean[] } with cmds of type
 *  ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Q',x1,y1,x,y] ['Z'] (Z unnecessary). */
export function transformPath(path, m) {
  const out = [];
  for (const c of path.cmds) {
    if (c[0] === 'M' || c[0] === 'L') {
      const [x, y] = applyPt(m, c[1], c[2]);
      out.push([c[0], x, y]);
    } else if (c[0] === 'C') {
      const [x1, y1] = applyPt(m, c[1], c[2]);
      const [x2, y2] = applyPt(m, c[3], c[4]);
      const [x, y] = applyPt(m, c[5], c[6]);
      out.push(['C', x1, y1, x2, y2, x, y]);
    } else if (c[0] === 'Q') {
      const [x1, y1] = applyPt(m, c[1], c[2]);
      const [x, y] = applyPt(m, c[3], c[4]);
      out.push(['Q', x1, y1, x, y]);
    }
  }
  return { cmds: out };
}

/** Flatten a path to polylines (arrays of [x,y]) in device space. */
export function flatten(path, tol = 0.08) {
  const polys = [];
  let cur = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const push = (px, py) => cur.push([px, py]);
  const finish = () => {
    if (cur.length > 1) polys.push(cur);
    cur = [];
  };
  for (const c of path.cmds) {
    if (c[0] === 'M') {
      finish();
      x = c[1]; y = c[2]; sx = x; sy = y;
      push(x, y);
    } else if (c[0] === 'L') {
      push(c[1], c[2]);
      x = c[1]; y = c[2];
    } else if (c[0] === 'C') {
      const [, x1, y1, x2, y2, xe, ye] = c;
      const n = curveSteps(x, y, x1, y1, x2, y2, xe, ye, tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const bx = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * xe;
        const by = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ye;
        push(bx, by);
      }
      x = xe; y = ye;
    } else if (c[0] === 'Q') {
      const [, x1, y1, xe, ye] = c;
      const n = curveSteps(x, y, x1, y1, x1, y1, xe, ye, tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const bx = u * u * x + 2 * u * t * x1 + t * t * xe;
        const by = u * u * y + 2 * u * t * y1 + t * t * ye;
        push(bx, by);
      }
      x = xe; y = ye;
    }
  }
  finish();
  return polys;
}

function curveSteps(x0, y0, x1, y1, x2, y2, x3, y3, tol) {
  const d = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(d / Math.max(tol, 0.01))) * 2));
}

export function pathBBox(path) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const upd = (x, y) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const c of path.cmds) {
    if (c[0] === 'M' || c[0] === 'L') upd(c[1], c[2]);
    else if (c[0] === 'C') { upd(c[1], c[2]); upd(c[3], c[4]); upd(c[5], c[6]); }
    else if (c[0] === 'Q') { upd(c[1], c[2]); upd(c[3], c[4]); }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * Rasterize flattened polylines over a box using the nonzero winding rule and
 * vertical supersampling. Returns { data: Float32Array(w*h) coverage 0..1, w, h }.
 * Coordinates are device space with y up; the output grid has y down (row 0 = top).
 */
export function rasterizePolys(polys, box, w, h, ss = 4) {
  const W = Math.max(1, Math.round(w * ss));
  const H = Math.max(1, Math.round(h * ss));
  const bw = Math.max(box.x1 - box.x0, 1e-9);
  const bh = Math.max(box.y1 - box.y0, 1e-9);
  const acc = new Float32Array(W * H);
  const sx = W / bw, sy = H / bh;
  const tx = (x) => (x - box.x0) * sx;
  // Flip vertically so row 0 is the top of the box; the box origin must be
  // subtracted here too, or every glyph is stretched by the box's y offset.
  const ty = (y) => (box.y1 - y) * sy;
  const edges = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const y0 = ty(ay), y1 = ty(by);
      if (y0 === y1) continue;
      edges.push({ x0: tx(ax), y0, x1: tx(bx), y1, dir: y1 > y0 ? 1 : -1 });
    }
  }
  if (!edges.length) return { data: acc, w: W, h: H, ss };
  let minRow = H, maxRow = 0;
  for (const e of edges) {
    minRow = Math.min(minRow, Math.floor(Math.min(e.y0, e.y1)));
    maxRow = Math.max(maxRow, Math.ceil(Math.max(e.y0, e.y1)));
  }
  minRow = Math.max(0, minRow);
  maxRow = Math.min(H, maxRow);
  const xs = [];
  for (let row = minRow; row < maxRow; row++) {
    const yc = row + 0.5;
    xs.length = 0;
    for (const e of edges) {
      const lo = Math.min(e.y0, e.y1), hi = Math.max(e.y0, e.y1);
      if (yc < lo || yc >= hi) continue;
      const t = (yc - e.y0) / (e.y1 - e.y0);
      xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].dir;
      if (wind === 0) continue;
      const a = xs[i].x, b = xs[i + 1].x;
      if (b <= 0 || a >= W) continue;
      const x0 = Math.max(0, Math.floor(a));
      const x1 = Math.min(W, Math.ceil(b));
      for (let x = x0; x < x1; x++) acc[row * W + x] = 1;
    }
  }
  return { data: acc, w: W, h: H, ss };
}

/** Downsample a supersampled coverage grid into a Float32 coverage map. */
export function downsample(r, w, h, ss = r.ss) {
  const out = new Float32Array(w * h);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < ss; dy++) {
        const row = (y * ss + dy) * r.w + x * ss;
        for (let dx = 0; dx < ss; dx++) s += r.data[row + dx];
      }
      out[y * w + x] = s * inv;
    }
  }
  return out;
}

/**
 * Rasterize a path into a w x h coverage bitmap over an explicit box (device space).
 * `box` is in the path's own coordinate space; y is flipped into raster rows.
 */
export function rasterToBitmap(path, box, w, h, ss = 4, tol = 0.08) {
  const polys = flatten(path, tol);
  const r = rasterizePolys(polys, box, w, h, ss);
  return downsample(r, w, h, ss);
}

/**
 * Normalize a path into a bitmap whose ink bounding box is scaled so the longer
 * side reaches `size`. Returns { bm, w, h, aspect, ink, fill, bbox } or null.
 * Both document glyphs and templates go through this, so comparisons are
 * scale-invariant and independent of the source font's units.
 */
export function normalizePath(path, size = 24, ss = 4, tol = 0.08, margin = 0) {
  const polys = flatten(path, tol);
  const box = bboxOfPolys(polys);
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const longest = Math.max(box.w, box.h);
  const scale = (size - 2 * margin) / longest;
  const w = Math.max(1, Math.round(box.w * scale) + 2 * margin);
  const h = Math.max(1, Math.round(box.h * scale) + 2 * margin);
  const inner = rasterToBitmap(path, box, w - 2 * margin, h - 2 * margin, ss, tol);
  const bm = new Float32Array(w * h);
  for (let y = 0; y < h - 2 * margin; y++) {
    for (let x = 0; x < w - 2 * margin; x++) {
      bm[(y + margin) * w + (x + margin)] = inner[y * (w - 2 * margin) + x];
    }
  }
  let ink = 0;
  for (const v of bm) ink += v;
  return { bm, w, h, aspect: box.w / box.h, ink, fill: ink / (w * h), bbox: box };
}

/**
 * Rasterize a path in font units (1 em tall, baseline at y=0) onto a w x h grid
 * whose vertical extent is the em box. The horizontal extent is deliberately
 * wider than one em: some producers place glyph ink outside the nominal advance
 * box, and clipping it would corrupt the shape used for recognition.
 */
export function emGridBitmap(path, w, h, ss = 4, tol = 0.06, ascent = 0.75, descent = -0.25, xMin = -1.5, xSpan = 4) {
  const box = { x0: xMin, x1: xMin + xSpan, y0: descent, y1: ascent };
  const cov = rasterizePolys(flatten(path, tol), box, w, h, ss);
  return downsample(cov, w, h, ss);
}

export function bboxOfPolys(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const p of polys) {
    for (const [x, y] of p) {
      any = true;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!any) return null;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Compare two normalized bitmaps that may differ in aspect; returns 0..1 similarity. */
export function bitmapSimilarity(a, b, aspectTol = 0.08) {
  if (!a || !b) return 0;
  const ar = Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect);
  if (ar > aspectTol) return 0;
  let inter = 0, uni = 0;
  for (let i = 0; i < a.bm.length; i++) {
    const x = a.bm[i], y = b.bm[i];
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni > 0 ? inter / uni : 0;
}

/** Coarse structural signature: 8x8 coverage grid, used for fast pre-filtering. */
export function signature(bm, w, h, n = 8) {
  const sig = new Float32Array(n * n);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(n - 1, Math.floor((y / h) * n));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(n - 1, Math.floor((x / w) * n));
      sig[gy * n + gx] += bm[y * w + x];
    }
  }
  let s = 0;
  for (const v of sig) s += v;
  if (s > 0) for (let i = 0; i < sig.length; i++) sig[i] /= s;
  return sig;
}

export function sigDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d; // 0 = identical
}

export function toAscii(bm, w, h, chars = ' .:-=+*#%@') {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const v = bm[y * w + x];
      s += chars[Math.max(0, Math.min(chars.length - 1, Math.round(v * (chars.length - 1))))];
    }
    rows.push(s);
  }
  return rows.join('\n');
}
