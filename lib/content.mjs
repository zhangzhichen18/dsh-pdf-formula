// Content-stream interpreter: walks a page's operators and produces positioned
// glyphs, text runs and vector paths in device space. It follows the PDF graphics
// model (CTM, text/line matrices, text state) so glyph boxes are exact, which the
// formula analyser depends on for detecting bars, radicals and scripts.

import { mul } from './raster.mjs';

const OPS_WITH_ARGS = new Set([
  'TJ', 'Tj', "'", '"', 'Tf', 'Tm', 'Td', 'TD', 'T*', 'TL', 'Tc', 'Tw', 'Tz', 'Ts', 'Tr',
  'cm', 'q', 'Q', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 're', 'm', 'l', 'c', 'v', 'y',
  'h', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*', 'BT', 'ET',
  'rg', 'RG', 'g', 'G', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'sh', 'Do', 'BI', 'EI', 'BX', 'EX',
]);

export function tokenizeContent(s) {
  const toks = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '(') {
      let depth = 1, j = i + 1, out = '';
      while (j < n) {
        const ch = s[j];
        if (ch === '\\') {
          const nx = s[j + 1];
          if (nx === '\n') { j += 2; continue; }
          if (nx === '\r') { j += 2; if (s[j] === '\n') j++; continue; }
          if (nx >= '0' && nx <= '7') {
            let oct = nx; j += 2;
            while (oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
            out += String.fromCharCode(parseInt(oct, 8));
            continue;
          }
          out += nx === 'n' ? '\n' : nx === 'r' ? '\r' : nx === 't' ? '\t'
            : nx === 'b' ? '\b' : nx === 'f' ? '\f' : nx;
          j += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) break; }
        out += ch;
        j++;
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') { toks.push({ t: 'dict', v: '<<' }); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { toks.push({ t: 'dict', v: '>>' }); i += 2; continue; }
    if (c === '<') {
      let j = i + 1, hex = '';
      while (j < n && s[j] !== '>') { hex += s[j]; j++; }
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      let out = '';
      for (let k = 0; k + 1 < clean.length; k += 2) out += String.fromCharCode(parseInt(clean.substr(k, 2), 16));
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (c === '[') { toks.push({ t: '[', v: '[' }); i++; continue; }
    if (c === ']') { toks.push({ t: ']', v: ']' }); i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !' \t\r\n\f\0()<>[]{}/%'.includes(s[j])) j++;
      toks.push({ t: 'name', v: s.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '{' || c === '}') { toks.push({ t: 'brace', v: c }); i++; continue; }
    if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
      if (m) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      i++;
      continue;
    }
    const m = /^(T\*|'|"|[A-Za-z*][A-Za-z0-9*]*)/.exec(s.slice(i, i + 32));
    if (m) { toks.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    i++;
  }
  return toks;
}

/**
 * Interpret one content stream.
 * @param content latin1 content string
 * @param opts.decodeGlyph  (fontName, code, ctx) -> { ch, confidence, source, exact }
 * @param opts.fonts        Map name -> { map: Map<code, number>, widths: {first,array,missing}, kind }
 * @param opts.collectPaths whether to record path geometry (needed for maths)
 */
export function interpretContent(content, opts) {
  const { fonts = new Map(), decodeGlyph = null, collectPaths = true, initialCtm = [1, 0, 0, 1, 0, 0] } = opts;
  const toks = tokenizeContent(content);
  const glyphs = [];
  const paths = [];
  const images = [];
  const textRuns = [];

  let ctm = initialCtm.slice();
  let gsStack = [];
  let lineWidth = 1;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0, fontSize = 1, charSpace = 0, wordSpace = 0, hScale = 1, rise = 0;
  let curFont = null;
  let stack = [];
  let inArray = null;
  let path = [];
  let curPt = null, startPt = null;
  let run = null;

  const pushNum = (v) => { stack.push({ t: 'num', v }); if (stack.length > 64) stack.shift(); };
  const numAt = (k) => {
    const e = stack[stack.length - k];
    return e && e.t === 'num' ? e.v : undefined;
  };
  const lastNums = (k) => {
    const out = [];
    for (let i = stack.length - k; i < stack.length; i++) {
      const e = stack[i];
      out.push(e && e.t === 'num' ? e.v : NaN);
    }
    return out.length === k && out.every((v) => Number.isFinite(v)) ? out : null;
  };

  const fontOf = (name) => fonts.get(name) ?? null;

  const widthOfCode = (font, code) => {
    if (!font) return 0.5;
    if (font.widths && font.widths.array && code >= font.widths.first) {
      const idx = code - font.widths.first;
      if (idx >= 0 && idx < font.widths.array.length) return font.widths.array[idx] / 1000;
    }
    if (font.defaultWidth !== undefined) return font.defaultWidth / 1000;
    return 0.5;
  };

  const startRun = (x, y, size) => {
    run = { x, y, size, glyphs: [], text: '' };
    textRuns.push(run);
  };

  const emitGlyph = (code, fontName) => {
    const font = fontOf(fontName);
    // text rendering matrix: Tfs * Tz * Tm * CTM
    const trm = mul(mul([fontSize * hScale, 0, 0, fontSize, 0, rise], tm), ctm);
    const scale = Math.hypot(trm[0], trm[1]) || fontSize;
    const skew = Math.abs(trm[2]) > 1e-6 || Math.abs(trm[3]) > 1e-6;
    const adv = widthOfCode(font, code);
    const decoded = decodeGlyph ? decodeGlyph(fontName, code, { fontSize, font, trm, scale: scale / (fontSize || 1) }) : null;
    const g = {
      code,
      font: fontName,
      ch: decoded?.ch ?? null,
      confidence: decoded?.confidence ?? 0,
      source: decoded?.source ?? null,
      x: trm[4],
      y: trm[5],
      size: fontSize,
      scale,
      italic: skew,
      adv,
      rise,
    };
    glyphs.push(g);
    if (run) run.glyphs.push(g);
    // advance the text matrix
    const tx = (adv * fontSize + charSpace + (code === 32 ? wordSpace : 0)) * hScale;
    tm = mul([1, 0, 0, 1, tx, 0], tm);
  };

  const handleTJArray = (arr) => {
    let pending = '';
    for (const it of arr) {
      if (it.t === 'str') {
        pending += it.v;
        for (const ch of it.v) emitGlyph(ch.charCodeAt(0) & 0xff, curFont);
      } else if (it.t === 'num') {
        const adj = (-it.v / 1000) * fontSize * hScale;
        tm = mul([1, 0, 0, 1, adj, 0], tm);
      }
      void pending;
    }
  };

  const closePath = () => {
    if (collectPaths && path.length) paths.push({ pts: path, lineWidth, ctm: ctm.slice(), closed: false });
    path = [];
  };

  for (const tk of toks) {
    if (tk.t === '[') { inArray = []; continue; }
    if (tk.t === ']') { stack.push({ t: 'array', v: inArray ?? [] }); inArray = null; continue; }
    if (inArray) { inArray.push(tk); continue; }
    if (tk.t !== 'op') {
      if (tk.t === 'num') pushNum(tk.v);
      else stack.push(tk);
      if (stack.length > 64) stack.shift();
      continue;
    }
    const op = tk.v;
    switch (op) {
      case 'q': gsStack.push({ ctm: ctm.slice(), lineWidth }); break;
      case 'Q': {
        const g = gsStack.pop();
        if (g) { ctm = g.ctm; lineWidth = g.lineWidth; }
        break;
      }
      case 'cm': {
        const m = lastNums(6);
        if (m) ctm = mul(m, ctm);
        break;
      }
      case 'w': { const v = numAt(1); if (v !== undefined) lineWidth = v; break; }
      case 'BT': { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break; }
      case 'ET': { run = null; break; }
      case 'Tf': {
        const nm = stack[stack.length - 2];
        const sz = numAt(1);
        if (nm && nm.t === 'name') curFont = nm.v;
        if (sz !== undefined) fontSize = sz;
        break;
      }
      case 'TL': { const v = numAt(1); if (v !== undefined) leading = v; break; }
      case 'Tc': { const v = numAt(1); if (v !== undefined) charSpace = v; break; }
      case 'Tw': { const v = numAt(1); if (v !== undefined) wordSpace = v; break; }
      case 'Tz': { const v = numAt(1); if (v !== undefined) hScale = v / 100; break; }
      case 'Ts': { const v = numAt(1); if (v !== undefined) rise = v; break; }
      case 'Tm': {
        const m = lastNums(6);
        if (m) { tm = m; tlm = m.slice(); run = null; }
        break;
      }
      case 'Td': case 'TD': {
        const m = lastNums(2);
        if (m) {
          if (op === 'TD') leading = -m[1];
          tlm = mul([1, 0, 0, 1, m[0], m[1]], tlm);
          tm = tlm.slice();
          run = null;
        }
        break;
      }
      case 'T*': { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); run = null; break; }
      case 'Tj': {
        const s = stack[stack.length - 1];
        if (s && s.t === 'str') for (const ch of s.v) emitGlyph(ch.charCodeAt(0) & 0xff, curFont);
        break;
      }
      case "'": case '"': {
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
        const s = stack[stack.length - 1];
        if (s && s.t === 'str') for (const ch of s.v) emitGlyph(ch.charCodeAt(0) & 0xff, curFont);
        break;
      }
      case 'TJ': {
        const a = stack[stack.length - 1];
        if (a && a.t === 'array') handleTJArray(a.v);
        break;
      }
      case 'm': {
        const m = lastNums(2);
        if (m) { closePath(); curPt = m; startPt = m; path.push(m); }
        break;
      }
      case 'l': {
        const m = lastNums(2);
        if (m) { curPt = m; path.push(m); }
        break;
      }
      case 'c': {
        const m = lastNums(6);
        if (m) {
          if (!path.length && curPt) path.push(curPt);
          path.push(m.slice(0, 2), m.slice(2, 4), m.slice(4, 6));
          curPt = m.slice(4, 6);
        }
        break;
      }
      case 'v': {
        const m = lastNums(4);
        if (m) {
          const p0 = curPt ?? [0, 0];
          path.push(p0, m.slice(0, 2), m.slice(2, 4));
          curPt = m.slice(2, 4);
        }
        break;
      }
      case 'y': {
        const m = lastNums(4);
        if (m) {
          if (!path.length && curPt) path.push(curPt);
          path.push(m.slice(0, 2), m.slice(2, 4), m.slice(2, 4));
          curPt = m.slice(2, 4);
        }
        break;
      }
      case 'h': { if (curPt && startPt) path.push(startPt.slice()); break; }
      case 're': {
        const m = lastNums(4);
        if (m) {
          const [x, y, w, h] = m;
          closePath();
          paths.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], lineWidth, ctm: ctm.slice(), rect: true, closed: true });
        }
        break;
      }
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
        if (collectPaths && path.length) {
          paths.push({ pts: path.slice(), lineWidth, ctm: ctm.slice(), closed: op === 's' || op === 'b' || op === 'b*' || op === 'B' || op === 'B*' || op === 'f' || op === 'F' || op === 'f*' });
        }
        path = [];
        break;
      }
      case 'n': case 'W': case 'W*': { path = []; break; }
      case 'Do': {
        const nm = stack[stack.length - 1];
        if (nm && nm.t === 'name') images.push({ name: nm.v, ctm: ctm.slice() });
        break;
      }
      default: break;
    }
    stack = [];
  }
  return { glyphs, paths, images, textRuns };
}
