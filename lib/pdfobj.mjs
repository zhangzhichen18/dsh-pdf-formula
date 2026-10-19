// Compact PDF object layer: xref-free object scan, stream decoding (incl. object
// streams and PNG predictors), page tree, resource and font dictionaries.
// Deliberately small and dependency-free; content streams are returned as latin1
// byte strings so every later stage keeps working on raw PDF bytes.

import zlib from 'node:zlib';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export class PDFDocument {
  constructor(buf) {
    this.buf = buf;
    this.latin = buf.toString('latin1');
    this.objs = new Map();      // objNum -> { start, bodyStart }
    this.dictCache = new Map(); // objNum -> dict string
    this.streamCache = new Map();
    this._scanObjects();
    this._readObjectStreams();
    this._buildPages();
  }

  _scanObjects() {
    const re = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(this.latin)) !== null) {
      const num = +m[1];
      const bodyStart = m.index + m[0].length;
      const prev = this.objs.get(num);
      // later definitions (incremental updates) win
      if (!prev || bodyStart > prev.bodyStart) this.objs.set(num, { num, start: m.index, bodyStart });
    }
    this.order = [...this.objs.keys()].sort((a, b) => this.objs.get(a).bodyStart - this.objs.get(b).bodyStart);
    this.nextStart = new Map();
    for (let i = 0; i < this.order.length; i++) {
      const n = this.order[i];
      this.nextStart.set(n, i + 1 < this.order.length ? this.objs.get(this.order[i + 1]).bodyStart : this.latin.length);
    }
  }

  rawBody(num) {
    const o = this.objs.get(num);
    if (!o) return '';
    return this.latin.slice(o.bodyStart, this.nextStart.get(num));
  }

  /** Dictionary text (everything before `stream`, whitespace-normalized). */
  dict(num) {
    if (this.dictCache.has(num)) return this.dictCache.get(num);
    const o = this.objs.get(num);
    if (!o) return '';
    const body = this.rawBody(num);
    const sIdx = body.indexOf('stream');
    let d = sIdx === -1 ? body : body.slice(0, sIdx);
    d = balanceDict(d.replace(/\s+/g, ' ').trim());
    this.dictCache.set(num, d);
    return d;
  }

  /** Raw (still encoded) stream bytes for an object, or null. */
  rawStream(num) {
    const o = this.objs.get(num);
    if (!o) return null;
    const body = this.rawBody(num);
    const sIdx = body.indexOf('stream');
    if (sIdx === -1) return null;
    const dict = body.slice(0, sIdx);
    let p = o.bodyStart + sIdx + 6;
    if (this.buf[p] === 0x0d) p++;
    if (this.buf[p] === 0x0a) p++;
    let end = this.latin.indexOf('endstream', p);
    if (end === -1) end = this.nextStart.get(num);
    let e = end;
    while (e > p && (this.buf[e - 1] === 0x0a || this.buf[e - 1] === 0x0d)) e--;
    return { dict, data: this.buf.subarray(p, e) };
  }

  /** Decoded stream as a latin1 string, or null when the filter is not supported here. */
  streamText(num) {
    if (this.streamCache.has(num)) return this.streamCache.get(num);
    const r = this.decodeStream(num);
    const out = r === null ? null : r.toString('latin1');
    this.streamCache.set(num, out);
    return out;
  }

  decodeStream(num) {
    const rs = this.rawStream(num);
    if (!rs) return null;
    let data = rs.data;
    const filt = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(rs.dict);
    const filters = filt ? [...filt[1].matchAll(/\/(\w+)/g)].map((m) => m[1]) : [];
    const parms = /\/DecodeParms\s*(\[[^\]]*\]|<<[^>]*>>)/.exec(rs.dict)?.[1] ?? '';
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (f === 'FlateDecode' || f === 'Fl') {
        try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data); } catch { return null; } }
      } else if (f === 'LZWDecode' || f === 'LZW') {
        data = lzwDecode(data);
      } else if (f === 'ASCII85Decode' || f === 'A85') {
        data = ascii85Decode(data);
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        data = asciiHexDecode(data);
      } else if (f === 'DCTDecode' || f === 'JPXDecode' || f === 'CCITTFaxDecode' || f === 'JBIG2Decode' || f === 'RunLengthDecode') {
        return f === 'RunLengthDecode' ? runLengthDecode(data) : null;
      } else {
        return null;
      }
      const pm = predictorParams(parms, i);
      if (pm && pm.predictor >= 10) data = applyPngPredictor(data, pm);
    }
    return data;
  }

  _readObjectStreams() {
    for (const num of this.order) {
      const d = this.dict(num);
      if (!/\/Type\s*\/ObjStm/.test(d)) continue;
      const txt = this.streamText(num);
      if (!txt) continue;
      const n = +(/\/N\s+(\d+)/.exec(d)?.[1] ?? 0);
      const first = +(/\/First\s+(\d+)/.exec(d)?.[1] ?? 0);
      const header = txt.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k + 1 < header.length && k / 2 < n; k += 2) {
        const onum = header[k], off = header[k + 1];
        const nextOff = k + 3 < header.length ? header[k + 3] : txt.length - first;
        const body = txt.slice(first + off, first + nextOff).replace(/\s+/g, ' ').trim();
        if (!this.dictCache.has(onum)) this.dictCache.set(onum, body);
      }
    }
  }

  _buildPages() {
    let root = null;
    for (const num of this.order) {
      const d = this.dict(num);
      if (/\/Type\s*\/Catalog/.test(d)) {
        const m = /\/Pages\s+(\d+)\s+0\s+R/.exec(d);
        if (m) { root = +m[1]; break; }
      }
    }
    this.pages = [];
    const seen = new Set();
    const walk = (num, inherited) => {
      if (seen.has(num)) return;
      seen.add(num);
      const d = this.dict(num);
      const inh = { ...inherited };
      const res = /\/Resources\s+(\d+)\s+0\s+R/.exec(d);
      if (res) inh.resources = +res[1];
      const rot = /\/Rotate\s+(-?\d+)/.exec(d);
      if (rot) inh.rotate = +rot[1];
      const mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(d);
      if (mb) inh.mediaBox = mb[1].trim().split(/\s+/).map(Number);
      const cb = /\/CropBox\s*\[([^\]]*)\]/.exec(d);
      if (cb) inh.cropBox = cb[1].trim().split(/\s+/).map(Number);
      const isPage = /\/Type\s*\/Page\b/.test(d) || (!/\/Kids/.test(d) && /\/Contents/.test(d));
      if (isPage) { this.pages.push({ obj: num, ...inh }); return; }
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d);
      if (kids) for (const m of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(+m[1], inh);
    };
    if (root !== null) walk(root, {});
    if (!this.pages.length) {
      for (const num of this.order) {
        const d = this.dict(num);
        if (/\/Type\s*\/Page\b/.test(d)) this.pages.push({ obj: num, mediaBox: [0, 0, 612, 792] });
      }
    }
  }

  /** Page content stream text (concatenated when /Contents is an array). */
  pageContent(page) {
    const d = this.dict(page.obj);
    const refs = [];
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(d);
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(d);
    if (single) refs.push(+single[1]);
    else if (arr) for (const m of arr[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(+m[1]);
    let out = '';
    for (const r of refs) out += (this.streamText(r) ?? '') + '\n';
    return out;
  }

  resources(page) {
    const d = this.dict(page.obj);
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(d);
    if (resRef) return this.dict(+resRef[1]);
    if (page.resources) return this.dict(page.resources);
    return d;
  }

  /** name -> object number for /Font resources. */
  pageFonts(page) {
    const res = this.resources(page);
    const direct = /\/Font\s*<<([^>]*)>>/.exec(res)?.[1];
    let block = direct;
    if (block === undefined) {
      const ref = /\/Font\s+(\d+)\s+0\s+R/.exec(res);
      if (ref) block = /<<([\s\S]*)>>/.exec(this.dict(+ref[1]))?.[1] ?? '';
      else block = '';
    }
    const out = new Map();
    for (const m of block.matchAll(/\/([^\s/<>]+)\s+(\d+)\s+0\s+R/g)) out.set(m[1], +m[2]);
    return out;
  }

  pageXObjects(page) {
    const res = this.resources(page);
    const direct = /\/XObject\s*<<([^>]*)>>/.exec(res)?.[1] ?? '';
    const out = new Map();
    for (const m of direct.matchAll(/\/([^\s/<>]+)\s+(\d+)\s+0\s+R/g)) out.set(m[1], +m[2]);
    return out;
  }

  /** Resolve an object reference or return the literal number. */
  deref(num) {
    const d = this.dict(num);
    const m = /^\s*(\d+)\s+0\s+R\s*$/.exec(d);
    return m ? +m[1] : num;
  }
}

/**
 * Keep a dictionary literal balanced. A naive "up to the first >>" cut truncates
 * nested dictionaries such as /Encoding<</Differences[...]>> or /Font<</F1 1 0 R>>,
 * which silently loses /Differences and nested resources.
 */
export function balanceDict(s) {
  const start = s.indexOf('<<');
  if (start === -1) return s;
  let depth = 0;
  let i = start;
  let inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === ')') inStr = false;
      i++;
      continue;
    }
    if (c === '(') { inStr = true; i++; continue; }
    if (c === '<' && s[i + 1] === '<') { depth++; i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') {
      depth--;
      i += 2;
      if (depth === 0) return s.slice(start, i);
      continue;
    }
    i++;
  }
  return s.slice(start);
}

function predictorParams(parms, index) {  if (!parms) return null;
  let seg = parms;
  if (parms.startsWith('[')) {
    const parts = [...parms.matchAll(/<<[^>]*>>|\d+\s+0\s+R|\/\w+/g)].map((m) => m[0]);
    seg = parts[index] ?? '';
    if (!seg.startsWith('<<')) return null;
  }
  const predictor = +( /\/Predictor\s+(\d+)/.exec(seg)?.[1] ?? 1);
  if (predictor < 2) return null;
  return {
    predictor,
    colors: +(/\/Colors\s+(\d+)/.exec(seg)?.[1] ?? 1),
    bpc: +(/\/BitsPerComponent\s+(\d+)/.exec(seg)?.[1] ?? 8),
    columns: +(/\/Columns\s+(\d+)/.exec(seg)?.[1] ?? 1),
  };
}

export function applyPngPredictor(data, { colors = 1, bpc = 8, columns = 1 }) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = Buffer.from(row);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (ft === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}

export function lzwDecode(input) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([]); dict.push([]);
  };
  reset();
  let bitPos = 0, codeLen = 9, prev = null;
  const total = input.length * 8;
  const readCode = () => {
    if (bitPos + codeLen > total) return null;
    let v = 0;
    for (let i = 0; i < codeLen; i++) {
      const byte = input[(bitPos + i) >> 3];
      const bit = (byte >> (7 - ((bitPos + i) & 7))) & 1;
      v = (v << 1) | bit;
    }
    bitPos += codeLen;
    return v;
  };
  for (;;) {
    const code = readCode();
    if (code === null) break;
    if (code === 256) { reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length + 1 >= (1 << codeLen) && codeLen < 12) codeLen++;
    }
    prev = entry;
    if (out.length > 60_000_000) break;
  }
  return Buffer.from(out);
}

export function ascii85Decode(input) {
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break; // ~>
    if (WS.has(c)) continue;
    if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 33);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

export function asciiHexDecode(input) {
  const s = input.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
  return Buffer.from(s.length % 2 ? s + '0' : s, 'hex');
}

export function runLengthDecode(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    const l = input[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k <= l; k++) out.push(input[i++]); }
    else { const b = input[i++]; for (let k = 0; k < 257 - l; k++) out.push(b); }
  }
  return Buffer.from(out);
}
