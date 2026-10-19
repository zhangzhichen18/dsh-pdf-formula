// Self-contained font outline extraction: CFF (Type2 charstrings, incl. CID-keyed)
// and TrueType (glyf/loca with composite glyphs) + cmap lookup.
// No dependencies. Paths are returned as { cmds: [...] } in font units.

const CFF_STD = [
  '.notdef', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright',
  'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two',
  'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater',
  'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
  'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum',
  'underscore', 'quoteleft', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
  'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde',
  'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section', 'currency', 'quotesingle',
  'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', 'endash', 'dagger',
  'daggerdbl', 'periodcentered', 'paragraph', 'bullet', 'quotesinglbase', 'quotedblbase', 'quotedblright',
  'guillemotright', 'ellipsis', 'perthousand', 'questiondown', 'grave', 'acute', 'circumflex', 'tilde',
  'macron', 'breve', 'dotaccent', 'dieresis', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron', 'emdash',
  'AE', 'ordfeminine', 'Lslash', 'Oslash', 'OE', 'ordmasculine', 'ae', 'dotlessi', 'lslash', 'oslash', 'oe',
  'germandbls', 'onesuperior', 'logicalnot', 'mu', 'trademark', 'Eth', 'onehalf', 'plusminus', 'Thorn',
  'onequarter', 'divide', 'brokenbar', 'degree', 'thorn', 'threequarters', 'twosuperior', 'registered',
  'minus', 'eth', 'multiply', 'threesuperior', 'copyright', 'Aacute', 'Acircumflex', 'Adieresis', 'Agrave',
  'Aring', 'Atilde', 'Ccedilla', 'Eacute', 'Ecircumflex', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex',
  'Idieresis', 'Igrave', 'Ntilde', 'Oacute', 'Ocircumflex', 'Odieresis', 'Ograve', 'Otilde', 'Scaron',
  'Uacute', 'Ucircumflex', 'Udieresis', 'Ugrave', 'Yacute', 'Ydieresis', 'Zcaron', 'aacute', 'acircumflex',
  'adieresis', 'agrave', 'aring', 'atilde', 'ccedilla', 'eacute', 'ecircumflex', 'edieresis', 'egrave',
  'iacute', 'icircumflex', 'idieresis', 'igrave', 'ntilde', 'oacute', 'ocircumflex', 'odieresis', 'ograve',
  'otilde', 'scaron', 'uacute', 'ucircumflex', 'udieresis', 'ugrave', 'yacute', 'ydieresis', 'zcaron',
];

class Cursor {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  u8() { return this.b[this.p++]; }
  u16() { return (this.b[this.p++] << 8) | this.b[this.p++]; }
  i16() { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; }
  i32() { return (this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8(); }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  get eof() { return this.p >= this.b.length; }
}

function readIndex(cur) {
  const count = cur.u16();
  if (count === 0) return [];
  const offSize = cur.u8();
  const offs = [];
  for (let i = 0; i <= count; i++) {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | cur.u8();
    offs.push(v);
  }
  const base = cur.p - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(cur.b.subarray(base + offs[i], base + offs[i + 1]));
  cur.p = base + offs[count];
  return items;
}

function parseDict(buf) {
  const cur = new Cursor(buf);
  const d = new Map();
  const operands = [];
  while (!cur.eof) {
    const b0 = cur.u8();
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = 1200 + cur.u8();
      d.set(op, operands.slice());
      operands.length = 0;
    } else if (b0 === 28) {
      operands.push(cur.i16());
    } else if (b0 === 29) {
      operands.push(cur.i32());
    } else if (b0 === 30) {
      // real number
      let s = '';
      outer: for (;;) {
        const v = cur.u8();
        for (const nib of [v >> 4, v & 15]) {
          if (nib <= 9) s += nib;
          else if (nib === 10) s += '.';
          else if (nib === 11) s += 'E';
          else if (nib === 12) s += 'E-';
          else if (nib === 14) s += '-';
          else if (nib === 15) break outer;
        }
      }
      operands.push(parseFloat(s) || 0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + cur.u8() + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - cur.u8() - 108);
    }
  }
  return d;
}

export function parseCFF(buf) {
  const cur = new Cursor(buf);
  cur.u8(); cur.u8(); // major, minor
  const hdrSize = cur.u8();
  cur.u8(); // offSize
  cur.p = hdrSize;
  const nameIndex = readIndex(cur).map((b) => b.toString('latin1'));
  const topDicts = readIndex(cur).map(parseDict);
  const stringIndex = readIndex(cur).map((b) => b.toString('latin1'));
  const globalSubrs = readIndex(cur);

  const top = topDicts[0] ?? new Map();
  const cidKeyed = top.has(1230); // ROS
  const charstringsOff = top.get(17)?.[0] ?? 0;
  const charstrings = readIndex(new Cursor(buf, charstringsOff));

  const getSid = (sid) => (sid < CFF_STD.length ? CFF_STD[sid] : (stringIndex[sid - CFF_STD.length] ?? `sid${sid}`));

  // The charset operator may be absent from a subset top dict; in that case CFF
  // says the ISOAdobe charset applies, but a subset font's glyph names actually
  // live in the String INDEX, so fall back to those before giving up on names.
  let charsets = null;
  const csOff = top.get(15)?.[0];
  if (csOff !== undefined && csOff !== 0) {
    charsets = parseCharset(buf, csOff, charstrings.length).map((n) =>
      /^sid\d+$/.test(n) ? getSid(Number(n.slice(3))) : n);
  } else {
    charsets = Array.from({ length: charstrings.length }, (_, i) => CFF_STD[i] ?? `gid${i}`);
    if (stringIndex.length && charstrings.length <= stringIndex.length + 1) {
      const fromStrings = ['.notdef'];
      for (let i = 0; i < stringIndex.length && fromStrings.length < charstrings.length; i++) fromStrings.push(stringIndex[i]);
      if (fromStrings.length === charstrings.length) charsets = fromStrings;
    }
  }
  charsets = charsets.map((n, i) => n ?? `gid${i}`);

  let encodings = null;
  const encOff = top.get(16)?.[0];
  if (encOff !== undefined && encOff !== 0) encodings = parseEncoding(buf, encOff);

  const readPrivate = (pd) => {
    if (!pd || !pd.length) return { subrs: [], defaultWidthX: 0, nominalWidthX: 0 };
    const [size, off] = pd;
    const dict = parseDict(buf.subarray(off, off + size));
    const subrsOff = dict.get(19)?.[0];
    const subrs = subrsOff ? readIndex(new Cursor(buf, off + subrsOff)) : [];
    return { subrs, defaultWidthX: dict.get(20)?.[0] ?? 0, nominalWidthX: dict.get(21)?.[0] ?? 0 };
  };

  let privates = null;
  let fdSelect = null;
  const fdArrayOff = top.get(1236)?.[0];
  if (fdArrayOff) {
    const fdDicts = readIndex(new Cursor(buf, fdArrayOff)).map(parseDict);
    privates = fdDicts.map((d) => readPrivate(d.get(18)));
    const fdSelectOff = top.get(1237)?.[0];
    fdSelect = fdSelectOff ? parseFDSelect(buf, fdSelectOff, charstrings.length) : null;
  }
  const defaultPrivate = readPrivate(top.get(18));

  return {
    names: nameIndex,
    isCID: cidKeyed,
    charstrings,
    charsets,
    encodings,
    globalSubrs,
    defaultPrivate,
    privates,
    fdSelect,
    fontMatrix: top.get(1207) ?? [0.001, 0, 0, 0.001, 0, 0],
    fontBBox: top.get(5) ?? null,
    getSid,
    glyphName: (gid) => charsets[gid] ?? `gid${gid}`,
  };
}

function parseCharset(buf, off, nGlyphs) {
  const cur = new Cursor(buf, off);
  const fmt = cur.u8();
  const names = ['.notdef'];
  const sidOf = (sid) => (sid < CFF_STD.length ? CFF_STD[sid] : `sid${sid}`);
  if (fmt === 0) {
    while (names.length < nGlyphs) names.push(sidOf(cur.u16()));
  } else if (fmt === 1 || fmt === 2) {
    while (names.length < nGlyphs) {
      const first = cur.u16();
      const nLeft = fmt === 1 ? cur.u8() : cur.u16();
      for (let i = 0; i <= nLeft && names.length < nGlyphs; i++) names.push(sidOf(first + i));
    }
  }
  while (names.length < nGlyphs) names.push(`gid${names.length}`);
  return names;
}

function parseEncoding(buf, off) {
  const cur = new Cursor(buf, off);
  const fmt = cur.u8();
  const map = new Map();
  if (fmt & 0x80) {
    const nCodes = cur.u8();
    for (let i = 0; i < nCodes; i++) map.set(cur.u8(), i + 1);
    return map;
  }
  const nRanges = cur.u8();
  for (let i = 0; i < nRanges; i++) {
    const first = cur.u8();
    const nLeft = cur.u8();
    for (let k = 0; k <= nLeft; k++) map.set(first + k, map.size + 1);
  }
  return map;
}

function parseFDSelect(buf, off, nGlyphs) {
  const cur = new Cursor(buf, off);
  const fmt = cur.u8();
  const sel = new Uint8Array(nGlyphs);
  if (fmt === 0) {
    for (let i = 0; i < nGlyphs; i++) sel[i] = cur.u8();
  } else if (fmt === 3) {
    const nRanges = cur.u16();
    let first = cur.u16();
    for (let i = 0; i < nRanges; i++) {
      const fd = cur.u8();
      const next = cur.u16();
      for (let g = first; g < next && g < nGlyphs; g++) sel[g] = fd;
      first = next;
    }
  }
  return sel;
}

function biasFor(n) {
  return n < 1240 ? 107 : n < 33900 ? 1131 : 32768;
}

/** Execute a Type2 charstring and return { cmds, width }. */
export function runType2(charstring, ctx) {
  const { globalSubrs, localSubrs = [], defaultWidthX = 0, nominalWidthX = 0 } = ctx;
  const cmds = [];
  // The Type2 pen starts at (0,0) for every glyph: state must never leak between
  // charstrings, or each glyph comes out as a drifting fragment.
  let x = 0, y = 0, nStems = 0, haveWidth = false, width = defaultWidthX;
  const stack = [];
  let open = false;
  const gBias = biasFor(globalSubrs.length);
  const lBias = biasFor(localSubrs.length);

  const moveTo = (nx, ny) => { x = nx; y = ny; cmds.push(['M', x, y]); open = true; };
  const lineTo = (nx, ny) => { x = nx; y = ny; cmds.push(['L', x, y]); };
  const curveTo = (x1, y1, x2, y2, nx, ny) => {
    cmds.push(['C', x1, y1, x2, y2, nx, ny]);
    x = nx; y = ny;
  };
  const takeWidth = () => {
    if (!haveWidth) {
      haveWidth = true;
      if (stack.length % 2 === 1) width = nominalWidthX + stack.shift();
    }
  };

  const exec = (code, depth) => {
    if (depth > 10) return;
    const cur = new Cursor(code);
    while (!cur.eof) {
      const b0 = cur.u8();
      if (b0 >= 32 && b0 <= 246) stack.push(b0 - 139);
      else if (b0 >= 247 && b0 <= 250) stack.push((b0 - 247) * 256 + cur.u8() + 108);
      else if (b0 >= 251 && b0 <= 254) stack.push(-(b0 - 251) * 256 - cur.u8() - 108);
      else if (b0 === 28) stack.push(cur.i16());
      else if (b0 === 255) stack.push(cur.i32() / 65536);
      else if (b0 === 12) {
        const b1 = cur.u8();
        switch (b1) {
          case 35: { // flex
            const a = stack.splice(-13);
            curveTo(x + a[0], y + a[1], x + a[2], y + a[3], x + a[4], y + a[5]);
            curveTo(x + a[6], y + a[7], x + a[8], y + a[9], x + a[10], y + a[11]);
            break;
          }
          case 34: { // hflex
            const a = stack.splice(-7);
            const y0 = y;
            curveTo(x + a[0], y, x + a[1], y + a[2], x + a[3], y + a[2]);
            curveTo(x + a[4], y + a[2], x + a[5], y0, x + a[6], y0);
            break;
          }
          case 36: { // hflex1
            const a = stack.splice(-9);
            const y0 = y;
            curveTo(x + a[0], y + a[1], x + a[2], y + a[3], x + a[4], y + a[3]);
            curveTo(x + a[5], y + a[3], x + a[6], y0 + a[7], x + a[8], y0);
            break;
          }
          case 37: { // flex1
            const a = stack.splice(-11);
            const x0 = x, y0 = y;
            const dx = a[0] + a[2] + a[4] + a[6] + a[8];
            const dy = a[1] + a[3] + a[5] + a[7] + a[9];
            curveTo(x + a[0], y + a[1], x + a[2], y + a[3], x + a[4], y + a[5]);
            const ex = Math.abs(dx) > Math.abs(dy) ? x0 + dx + a[10] : x + a[10];
            const ey = Math.abs(dx) > Math.abs(dy) ? y + a[11] : y0 + dy + a[11];
            curveTo(x + a[6], y + a[7], x + a[8], y + a[9], ex, ey);
            break;
          }
          // Reserved/unimplemented escaped operators: drop operands and continue.
          // NOTE: 30 and 31 (vhcurveto/hvcurveto) must NOT be listed here.
          case 3: case 4: case 5: case 9: case 10: case 11: case 12: case 14: case 15:
          case 18: case 21: case 22: case 23: case 24: case 26: case 27: case 28: case 29:
            stack.length = 0;
            break;
          default:
            stack.length = 0;
        }
      } else {
        switch (b0) {
          case 1: case 3: case 18: case 23: {
            takeWidth();
            nStems += stack.length >> 1;
            stack.length = 0;
            break;
          }
          case 19: case 20: {
            takeWidth();
            nStems += stack.length >> 1;
            stack.length = 0;
            const nSubrs = (b0 === 19 ? cur.u8() : cur.u16()) + nStems;
            for (let i = 0; i < nSubrs; i++) cur.u8();
            break;
          }
          case 4: {
            takeWidth();
            if (stack.length > 1) { moveTo(x + stack[0], y + stack[1]); stack.splice(0, 2); }
            while (stack.length >= 2) lineTo(x + stack[0], y + stack[1]), stack.splice(0, 2);
            break;
          }
          case 5: {
            while (stack.length >= 2) lineTo(x + stack[0], y + stack[1]), stack.splice(0, 2);
            break;
          }
          case 21: {
            takeWidth();
            if (stack.length > 2) { moveTo(x + stack[0], y + stack[1]); stack.splice(0, 2); }
            while (stack.length >= 2) lineTo(x + stack[0], y + stack[1]), stack.splice(0, 2);
            break;
          }
          case 22: {
            if (stack.length > 1) moveTo(x + stack[0], y + stack[1]), stack.splice(0, 2);
            while (stack.length >= 2) lineTo(x + stack[0], y + stack[1]), stack.splice(0, 2);
            break;
          }
          case 6: case 7: {
            const horiz = b0 === 6;
            while (stack.length >= 1) {
              if (horiz) lineTo(x + stack[0], y); else lineTo(x, y + stack[0]);
              stack.shift();
            }
            break;
          }
          case 8: {
            while (stack.length >= 6) {
              curveTo(x + stack[0], y + stack[1], x + stack[2], y + stack[3], x + stack[4], y + stack[5]);
              stack.splice(0, 6);
            }
            break;
          }
          case 24: {
            while (stack.length >= 8) {
              curveTo(x + stack[0], y + stack[1], x + stack[2], y + stack[3], x + stack[4], y + stack[5]);
              lineTo(x + stack[6], y + stack[7]);
              stack.splice(0, 8);
            }
            break;
          }
          case 25: {
            while (stack.length >= 8) {
              lineTo(x + stack[0], y + stack[1]);
              curveTo(x + stack[2], y + stack[3], x + stack[4], y + stack[5], x + stack[6], y + stack[7]);
              stack.splice(0, 8);
            }
            break;
          }
          case 26: case 27: {
            const vert = b0 === 27;
            if (stack.length % 4 === 1) { if (vert) lineTo(x, y + stack[0]); else lineTo(x + stack[0], y); stack.shift(); }
            while (stack.length >= 4) {
              const [a, b, c, d] = stack;
              if (vert) curveTo(x, y + a, x + b, y + c, x + b, y + c + d);
              else curveTo(x + a, y, x + b, y + c, x + b + d, y + c);
              if (vert) y += c + d; else x += b + d;
              stack.splice(0, 4);
            }
            break;
          }
          // vhcurveto / hvcurveto: argument groups alternate 4,5,4,5,... between
          // vertical-then-horizontal and horizontal-then-vertical curves. Getting
          // this wrong desynchronises the stack and every glyph fills solid.
          case 30: case 31: {
            // startVertical === true for hvcurveto (31) per the Type2 spec:
            // both operators begin with the direction named second.
            let vertical = true;
            while (stack.length >= 4) {
              const take = stack.length >= 5 && (stack.length - 5) % 8 === 0 ? 5 : (stack.length % 8 === 5 ? 5 : 4);
              const g = stack.splice(0, take);
              const [d1, d2, d3, d4] = g;
              const d5 = g.length > 4 ? g[4] : null;
              if (vertical) {
                curveTo(x, y + d1, x + d2, y + d3, d5 === null ? x + d4 : x + d5, y + d4);
              } else {
                curveTo(x + d1, y, x + d2, y + d3, x + d4, d5 === null ? y + d4 : y + d5);
              }
              vertical = !vertical;
            }
            stack.length = 0;
            break;
          }
          case 10: {
            const idx = stack.pop() + lBias;
            if (localSubrs[idx]) exec(localSubrs[idx], depth + 1);
            break;
          }
          case 29: {
            const idx = stack.pop() + gBias;
            if (globalSubrs[idx]) exec(globalSubrs[idx], depth + 1);
            break;
          }
          case 11: case 14: return;
          default:
            stack.length = 0;
        }
      }
    }
  };
  exec(charstring, 0);
  return { cmds, width };
}

/** Build a gid -> path map for a CFF font (all glyphs). */
export function cffGlyphPaths(cff) {
  const paths = [];
  for (let gid = 0; gid < cff.charstrings.length; gid++) {
    const fd = cff.fdSelect ? cff.fdSelect[gid] : 0;
    const priv = cff.privates ? cff.privates[fd] : cff.defaultPrivate;
    const { cmds } = runType2(cff.charstrings[gid], {
      globalSubrs: cff.globalSubrs,
      localSubrs: priv.subrs,
      defaultWidthX: priv.defaultWidthX,
      nominalWidthX: priv.nominalWidthX,
    });
    paths.push({ cmds });
  }
  return paths;
}

/** Parse a CFF Encoding/Differences-style code->gid map, else use the font's charset. */
export function cffCodeToGid(cff, differences) {
  const byName = new Map();
  cff.charsets.forEach((n, gid) => { if (!byName.has(n)) byName.set(n, gid); });
  const map = new Map();
  if (differences && differences.size) {
    for (const [code, name] of differences) {
      const gid = byName.get(name);
      if (gid !== undefined) map.set(code, gid);
    }
  } else if (cff.encodings) {
    for (const [code, gid] of cff.encodings) map.set(code, gid);
  }
  if (!map.size) cff.charsets.forEach((_, gid) => map.set(gid, gid));
  return map;
}

// ---------------------------------------------------------------- TrueType

function u16(b, p) { return (b[p] << 8) | b[p + 1]; }
function i16(b, p) { const v = u16(b, p); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }

export function parseTTF(buf, faceIndex = 0) {
  let base = 0;
  let tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const numFonts = u32(buf, 8);
    const offs = [];
    for (let i = 0; i < numFonts; i++) offs.push(u32(buf, 12 + i * 4));
    base = offs[Math.min(faceIndex, numFonts - 1)] ?? 0;
  }
  const numTables = u16(buf, base + 4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const p = base + 12 + i * 16;
    const name = buf.toString('latin1', p, p + 4);
    tables.set(name, { offset: u32(buf, p + 8), length: u32(buf, p + 12) });
  }
  const head = tables.get('head');
  const unitsPerEm = head ? u16(buf, head.offset + 18) : 1000;
  const indexToLocFormat = head ? i16(buf, head.offset + 50) : 0;
  const maxp = tables.get('maxp');
  const numGlyphs = maxp ? u16(buf, maxp.offset + 4) : 0;
  const locaT = tables.get('loca');
  const glyfT = tables.get('glyf');
  const loca = [];
  if (locaT) {
    for (let i = 0; i <= numGlyphs; i++) {
      loca.push(indexToLocFormat === 0 ? u16(buf, locaT.offset + i * 2) * 2 : u32(buf, locaT.offset + i * 4));
    }
  }
  const cmapT = tables.get('cmap');
  const cmap = new Map();
  if (cmapT) {
    const nSub = u16(buf, cmapT.offset + 2);
    let best = -1, bestScore = -1;
    for (let i = 0; i < nSub; i++) {
      const p = cmapT.offset + 4 + i * 8;
      const platform = u16(buf, p);
      const encoding = u16(buf, p + 2);
      const sub = cmapT.offset + u32(buf, p + 4);
      const fmt = u16(buf, sub);
      let score = 0;
      if (platform === 3 && encoding === 10 && fmt === 12) score = 5;
      else if (platform === 3 && encoding === 1 && fmt === 4) score = 4;
      else if (platform === 0 && fmt === 12) score = 4;
      else if (platform === 0 && fmt === 4) score = 3;
      else if (fmt === 4) score = 2;
      else if (fmt === 12) score = 2;
      if (fmt !== 4 && fmt !== 12 && fmt !== 6 && fmt !== 0) score = -1;
      if (score > bestScore) { bestScore = score; best = sub; }
    }
    if (best >= 0) readCmap(buf, best, cmap);
  }
  return {
    unitsPerEm,
    numGlyphs,
    cmap,
    buf,
    glyphPath: (gid) => ttfGlyphPath(buf, loca, glyfT, gid, 0),
    tables,
  };
}

function readCmap(buf, sub, out) {
  const fmt = u16(buf, sub);
  if (fmt === 4) {
    const segX2 = u16(buf, sub + 6);
    const segs = segX2 / 2;
    const endP = sub + 14;
    const startP = endP + segX2 + 2;
    const deltaP = startP + segX2;
    const rangeP = deltaP + segX2;
    for (let s = 0; s < segs; s++) {
      const end = u16(buf, endP + s * 2);
      const start = u16(buf, startP + s * 2);
      const delta = i16(buf, deltaP + s * 2);
      const ro = u16(buf, rangeP + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const gp = rangeP + s * 2 + ro + (c - start) * 2;
          if (gp + 1 >= buf.length) continue;
          gid = u16(buf, gp);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid) out.set(c, gid);
        if (out.size > 100000) return;
      }
    }
  } else if (fmt === 12) {
    const nGroups = u32(buf, sub + 12);
    for (let g = 0; g < nGroups; g++) {
      const p = sub + 16 + g * 12;
      const s = u32(buf, p), e = u32(buf, p + 4), gid0 = u32(buf, p + 8);
      for (let c = s; c <= e; c++) out.set(c, gid0 + (c - s));
    }
  } else if (fmt === 6) {
    const first = u16(buf, sub + 6);
    const count = u16(buf, sub + 8);
    for (let i = 0; i < count; i++) out.set(first + i, u16(buf, sub + 10 + i * 2));
  } else if (fmt === 0) {
    for (let c = 0; c < 256; c++) out.set(c, buf[sub + 6 + c]);
  }
}

function ttfGlyphPath(buf, loca, glyfT, gid, depth) {
  if (!glyfT || gid < 0 || gid + 1 >= loca.length || depth > 5) return { cmds: [] };
  const start = glyfT.offset + loca[gid];
  const end = glyfT.offset + loca[gid + 1];
  if (end <= start) return { cmds: [] };
  const nContours = i16(buf, start);
  if (nContours < 0) {
    // composite
    const cmds = [];
    let p = start + 10;
    for (;;) {
      const flags = u16(buf, p);
      const glyphIndex = u16(buf, p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (flags & 1) { dx = i16(buf, p); dy = i16(buf, p + 2); p += 4; }
      else { dx = (buf[p] << 24) >> 24; dy = (buf[p + 1] << 24) >> 24; p += 2; }
      const sub = ttfGlyphPath(buf, loca, glyfT, glyphIndex, depth + 1);
      const m = [1, 0, 0, 1, dx, dy];
      if (flags & 8) {
        const a = i16(buf, p), b = i16(buf, p + 2), c = i16(buf, p + 4), d = i16(buf, p + 6);
        p += 8;
        m[0] = a / 16384; m[1] = b / 16384; m[2] = c / 16384; m[3] = d / 16384;
      } else if (flags & 64) {
        m[0] = i16(buf, p) / 16384; m[3] = i16(buf, p + 2) / 16384; p += 4;
      } else if (flags & 128) {
        m[0] = i16(buf, p) / 16384; m[1] = i16(buf, p + 2) / 16384;
        m[2] = i16(buf, p + 4) / 16384; m[3] = i16(buf, p + 6) / 16384; p += 8;
      }
      for (const c of sub.cmds) {
        if (c[0] === 'M' || c[0] === 'L') {
          cmds.push([c[0], m[0] * c[1] + m[2] * c[2] + m[4], m[1] * c[1] + m[3] * c[2] + m[5]]);
        } else if (c[0] === 'Q') {
          cmds.push(['Q',
            m[0] * c[1] + m[2] * c[2] + m[4], m[1] * c[1] + m[3] * c[2] + m[5],
            m[0] * c[3] + m[2] * c[4] + m[4], m[1] * c[3] + m[3] * c[4] + m[5]]);
        } else if (c[0] === 'C') {
          cmds.push(['C',
            m[0] * c[1] + m[2] * c[2] + m[4], m[1] * c[1] + m[3] * c[2] + m[5],
            m[0] * c[3] + m[2] * c[4] + m[4], m[1] * c[3] + m[3] * c[4] + m[5],
            m[0] * c[5] + m[2] * c[6] + m[4], m[1] * c[5] + m[3] * c[6] + m[5]]);
        }
      }
      if (!(flags & 32)) break;
    }
    return { cmds };
  }
  // simple glyph
  const endPts = [];
  for (let i = 0; i < nContours; i++) endPts.push(u16(buf, start + 10 + i * 2));
  const nPts = (endPts[endPts.length - 1] ?? -1) + 1;
  let p = start + 10 + nContours * 2;
  const insLen = u16(buf, p); p += 2 + insLen;
  const flags = [];
  while (flags.length < nPts) {
    const f = buf[p++];
    flags.push(f);
    if (f & 8) { let rep = buf[p++]; while (rep-- > 0) flags.push(f); }
  }
  const xs = [];
  let x = 0;
  for (const f of flags) {
    if (f & 2) { const d = buf[p++]; x += f & 16 ? d : -d; }
    else if (!(f & 16)) { x += i16(buf, p); p += 2; }
    xs.push(x);
  }
  const ys = [];
  let y = 0;
  for (const f of flags) {
    if (f & 4) { const d = buf[p++]; y += f & 32 ? d : -d; }
    else if (!(f & 32)) { y += i16(buf, p); p += 2; }
    ys.push(y);
  }
  const onCurve = flags.map((f) => (f & 1) === 1);
  const cmds = [];
  let ci = 0;
  for (let k = 0; k < nContours; k++) {
    const first = ci;
    const last = endPts[k];
    if (last < first) { ci = last + 1; continue; }
    const pts = [];
    for (let i = first; i <= last; i++) pts.push({ x: xs[i], y: ys[i], on: onCurve[i] });
    // find a starting on-curve point
    let s = pts.findIndex((q) => q.on);
    if (s === -1) {
      // all off-curve: synthesize midpoint start
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, on: true };
      pts.unshift(mid);
      s = 0;
    }
    const rot = pts.slice(s).concat(pts.slice(0, s));
    cmds.push(['M', rot[0].x, rot[0].y]);
    let i = 1;
    while (i < rot.length) {
      const cur = rot[i];
      if (cur.on) { cmds.push(['L', cur.x, cur.y]); i++; continue; }
      const nxt = rot[(i + 1) % rot.length];
      if (nxt.on) { cmds.push(['Q', cur.x, cur.y, nxt.x, nxt.y]); i += 2; }
      else {
        const mx = (cur.x + nxt.x) / 2, my = (cur.y + nxt.y) / 2;
        cmds.push(['Q', cur.x, cur.y, mx, my]);
        i += 1;
      }
    }
    ci = last + 1;
  }
  return { cmds };
}

export function gidForChar(ttf, codePoint) {
  return ttf.cmap.get(codePoint) ?? 0;
}
