// Font model + glyph decoding.
//
// Decoding order, best evidence first:
//   1. /ToUnicode CMap                      (authoritative when present)
//   2. simple-font /Encoding /Differences   (glyph names known to be meaningful)
//   3. TrueType/CFF cmap via the code       (only when the code is a codepoint)
//   4. glyph outline shape recognition      (subset CFF with destroyed names)
// Recognition results are cached per (font, code) and carry a confidence so the
// caller can flag uncertain symbols instead of silently inventing them.

import fs from 'node:fs';
import { parseCFF, cffGlyphPaths, parseTTF } from './font.mjs';
import { transformPath } from './raster.mjs';
import { describeGlyphPath, matchGlyph, getTemplateLibrary } from './templates.mjs';
import { familyOf } from './symbols.mjs';

const AGL_SIMPLE = new Map(Object.entries({
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quoteright: '\u2019', quoteleft: '\u2018', parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  exclamdown: '¡', cent: '¢', sterling: '£', fraction: '⁄', yen: '¥', florin: 'ƒ', section: '§',
  currency: '¤', quotesingle: "'", quotedblleft: '\u201c', guillemotleft: '«', guilsinglleft: '‹',
  guilsinglright: '›', fi: 'ﬁ', fl: 'ﬂ', endash: '–', dagger: '†', daggerdbl: '‡', periodcentered: '·',
  paragraph: '¶', bullet: '•', quotesinglbase: '‚', quotedblbase: '„', quotedblright: '\u201d',
  guillemotright: '»', ellipsis: '…', perthousand: '‰', questiondown: '¿', acute: '´', circumflex: 'ˆ',
  tilde: '˜', macron: '¯', breve: '˘', dotaccent: '˙', dieresis: '¨', ring: '˚', cedilla: '¸',
  hungarumlaut: '˝', ogonek: '˛', caron: 'ˇ', emdash: '—', AE: 'Æ', ordfeminine: 'ª', Lslash: 'Ł',
  Oslash: 'Ø', OE: 'Œ', ordmasculine: 'º', ae: 'æ', dotlessi: 'ı', lslash: 'ł', oslash: 'ø', oe: 'œ',
  germandbls: 'ß', onesuperior: '¹', logicalnot: '¬', mu: 'µ', trademark: '™', Eth: 'Ð', onehalf: '½',
  plusminus: '±', Thorn: 'Þ', onequarter: '¼', divide: '÷', brokenbar: '¦', degree: '°', thorn: 'þ',
  threequarters: '¾', twosuperior: '²', registered: '®', minus: '−', eth: 'ð', multiply: '×',
  threesuperior: '³', copyright: '©', periodcentered_alt: '·',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu_gr: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
  Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ',
  Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω', nabla: '∇',
  infinity: '∞', partialdiff: '∂', integral: '∫', summation: '∑', product: '∏', radical: '√',
  approxequal: '≈', notequal: '≠', lessequal: '≤', greaterequal: '≥', equivalence: '≡',
  arrowright: '→', arrowleft: '←', arrowboth: '↔', arrowup: '↑', arrowdown: '↓', element: '∈',
  notelement: '∉', subset: '⊂', superset: '⊃', union: '∪', intersection: '∩', proportional: '∝',
  therefore: '∴', perpendicular: '⊥', dotmath: '⋅', circlemultiply: '⊗', circleplus: '⊕',
  emptyset: '∅', hbar: 'ℏ', angstrom: 'Å', lscript: 'ℓ', weierstrass: '℘', ifraktur: 'ℑ',
  Rfraktur: 'ℜ', universal: '∀', existential: '∃', angle: '∠', congruent: '≅', minus_alt: '−',
}));

function glyphNameToChar(name) {
  if (!name) return null;
  if (AGL_SIMPLE.has(name)) return AGL_SIMPLE.get(name);
  if (/^uni[0-9A-Fa-f]{4}$/.test(name)) return String.fromCodePoint(parseInt(name.slice(3), 16));
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 16));
  if (/^[A-Za-z]$/.test(name)) return name;
  if (/^f_(.)$/.test(name)) return name[2];
  return null;
}

/** Parse a /ToUnicode CMap into a Map<code, string>. */
export function parseToUnicode(text) {
  const map = new Map();
  if (!text) return map;
  const src = text.replace(/\r/g, '\n');
  const hexToStr = (h) => {
    const clean = h.replace(/[^0-9A-Fa-f]/g, '');
    let out = '';
    for (let i = 0; i + 1 < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.substr(i, 4), 16));
    return out;
  };
  let m;
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(src)) !== null) {
    for (const pair of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), hexToStr(pair[2]));
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(src)) !== null) {
    const body = m[1];
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      const dst = hexToStr(r[3]);
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        const d = dst ? String.fromCharCode(dst.charCodeAt(0) + (c - lo)) : '';
        if (d) map.set(c, d);
      }
    }
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g)) {
      const lo = parseInt(r[1], 16);
      const items = [...r[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]));
      items.forEach((d, i) => { if (d) map.set(lo + i, d); });
    }
  }
  return map;
}

function numArray(str) {
  return (str ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
}

/** Build the font model for one PDF font object. */
export function buildFont(doc, objNum, name) {
  const d = doc.dict(objNum);
  const subtype = /\/Subtype\s*\/(\w+)/.exec(d)?.[1] ?? 'Type1';
  const baseFont = /\/BaseFont\s*\/([^\s/>]+)/.exec(d)?.[1] ?? name;
  const isCID = /\/Subtype\s*\/Type0/.test(d);
  const first = +(/\/FirstChar\s+(\d+)/.exec(d)?.[1] ?? 0);
  const widthsRaw = /\/Widths\s*\[([\s\S]*?)\]/.exec(d)?.[1] ?? '';
  const widths = numArray(widthsRaw);
  const descRef = /\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(d);
  const fd = descRef ? doc.dict(+descRef[1]) : '';
  const missingWidth = +( /\/MissingWidth\s+(-?\d+)/.exec(fd)?.[1] ?? 500);
  const fontMatrix = numArray(/\/FontMatrix\s*\[([^\]]*)\]/.exec(d)?.[1] ?? '') ;
  const toUniRef = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(d);
  const toUnicode = toUniRef ? parseToUnicode(doc.streamText(+toUniRef[1])) : new Map();

  const encRef = /\/Encoding\s+(\d+)\s+0\s+R/.exec(d);
  const encStr = /\/Encoding\s*<<([\s\S]*?)>>/.exec(d)?.[1] ?? (encRef ? doc.dict(+encRef[1]) : '');
  const diffRaw = /\/Differences\s*\[([\s\S]*?)\]/.exec(encStr)?.[1];
  const differences = new Map();
  if (diffRaw) {
    let cur = 0;
    for (const t of diffRaw.trim().split(/\s+/)) {
      if (/^-?\d+$/.test(t)) cur = +t;
      else if (t.startsWith('/')) differences.set(cur++, t.slice(1));
    }
  }

  const font = {
    name, obj: objNum, subtype, baseFont, isCID, differences, toUnicode,
    widths: { first, array: widths },
    defaultWidth: missingWidth,
    fontMatrix,
    ttf: null, cff: null, cffPaths: null, cffMatrix: null,
    type3: null,
    embedded: false,
    style: guessStyle(baseFont),
    cache: new Map(),
  };

  // embedded font program
  const ff3 = /\/FontFile3\s+(\d+)\s+0\s+R/.exec(fd)?.[1];
  const ff2 = /\/FontFile2\s+(\d+)\s+0\s+R/.exec(fd)?.[1];
  const ff1 = /\/FontFile\s+(\d+)\s+0\s+R/.exec(fd)?.[1];
  if (ff3) {
    const data = doc.decodeStream(+ff3);
    if (data && data[0] === 1) {
      try {
        font.cff = parseCFF(data);
        font.cffPaths = cffGlyphPaths(font.cff);
        font.cffMatrix = font.cff.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
        font.embedded = true;
      } catch { font.cff = null; }
    } else if (data && /^\x00\x01\x00\x00|^OTTO|^\x74\x72\x75\x65/.test(data.toString('latin1', 0, 4))) {
      try { font.ttf = parseTTF(Buffer.from(data)); font.embedded = true; } catch { font.ttf = null; }
    }
  } else if (ff2) {
    const data = doc.decodeStream(+ff2);
    if (data) {
      try { font.ttf = parseTTF(Buffer.from(data)); font.embedded = true; } catch { font.ttf = null; }
    }
  } else if (ff1) {
    // bare Type1 (PFB/PFA) programs are not supported for outlines; the code
    // still decodes through /Differences, only shape matching is unavailable.
    font.embedded = false;
  }

  if (subtype === 'Type3') {
    const charProcs = /\/CharProcs\s*<<([\s\S]*?)>>/.exec(d)?.[1] ?? '';
    const map = new Map();
    for (const m of charProcs.matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) map.set(m[1], +m[2]);
    const encName = /\/Encoding\s+(\d+)\s+0\s+R/.exec(d);
    font.type3 = {
      charProcs: map,
      matrix: fontMatrix.length === 6 ? fontMatrix : [0.001, 0, 0, 0.001, 0, 0],
      encoding: encName ? doc.dict(+encName[1]) : encStr,
      resources: /\/Resources\s*<<([\s\S]*?)>>/.exec(d)?.[1] ?? '',
    };
  }
  return font;
}

function guessStyle(baseFont) {
  const n = (baseFont || '').toLowerCase();
  if (/italic|oblique/.test(n)) return 'italic';
  if (/bold/.test(n)) return 'bold';
  return 'upright';
}

/**
 * Decode one glyph of a font.
 * @returns {{ch: string|null, confidence: number, source: string}}
 */
export function decodeGlyph(font, code, { library = null, styleHint = null } = {}) {
  if (!font) return { ch: null, confidence: 0, source: 'nofont' };
  const key = code;
  if (font.cache.has(key)) return font.cache.get(key);
  const result = decodeUncached(font, code, library, styleHint);
  font.cache.set(key, result);
  return result;
}

function decodeUncached(font, code, library, styleHint) {
  // 1. ToUnicode
  if (font.toUnicode && font.toUnicode.has(code)) {
    const ch = font.toUnicode.get(code);
    if (ch) return { ch, confidence: 1, source: 'tounicode' };
  }
  // 2/3. simple font encoding
  const name = font.differences.get(code);
  if (name) {
    const ch = glyphNameToChar(name);
    if (ch) return { ch, confidence: 0.97, source: 'differences' };
    // a glyph name that is not a character (e.g. subset names) falls through
  }
  // Non-embedded base-14 text fonts carry no outlines, so shape matching cannot
  // help; their codes follow the font's built-in encoding, which for the
  // standard Latin faces is ASCII-compatible.
  if (!font.embedded && isStandardLatinFont(font.baseFont)) {
    if (code >= 32 && code <= 126) return { ch: String.fromCharCode(code), confidence: 0.9, source: 'standard-encoding' };
    const semi = SEMI_STANDARD.get(code);
    if (semi) return { ch: semi, confidence: 0.85, source: 'standard-encoding' };
  }
  // 4. shape recognition for embedded outline fonts
  const desc = descriptorForCode(font, code);
  if (desc) {
    // Symbol fonts draw symbols, not prose letters, so when the code itself does
    // not identify the glyph, prefer the plain operator repertoire: this is what
    // separates a radical from the visually similar logical-or.
    const symbolFont = /math|symbol|pi\d|mathematical/i.test(font.baseFont ?? '');
    const isSymbolLike = symbolFont
      || (font.differences.size === 0 && !/times|helvetica|arial|courier|roman/i.test(font.baseFont ?? ''));
    const m = matchGlyph(desc, library ?? getTemplateLibrary(), {
      styleHint: isSymbolLike ? 'symbol' : (styleHint ?? (font.style === 'italic' ? 'variable' : 'upright')),
      widthRatio: (() => {
        const idx = code - font.widths.first;
        const w = font.widths.array?.[idx];
        return Number.isFinite(w) ? w / 1000 : null;
      })(),
      familyHint: null,
      preferSymbols: isSymbolLike,
      topK: 4,
    });
    if (m.length) {
      const top = m[0];
      const second = m[1]?.score ?? 0;
      const margin = top.score - second;
      // Confidence blends absolute overlap with the margin over the runner-up.
      let confidence = Math.max(0, Math.min(0.95, top.score * 0.75 + Math.min(margin, 0.2) * 1.2));
      // The advance width is independent evidence: when the codes match the subset
      // layout, a candidate whose own width disagrees is probably the wrong glyph.
      const idx = code - font.widths.first;
      const declared = font.widths.array?.[idx];
      if (Number.isFinite(declared) && top.adv) {
        const actual = declared / 1000;
        const err = Math.abs(actual - top.adv) / Math.max(actual, top.adv);
        if (err > 0.25) confidence *= 0.6;
        else if (err > 0.12) confidence *= 0.85;
      }
      return { ch: top.ch, confidence, source: 'shape', alternatives: m.slice(0, 3).map((x) => x.ch) };
    }
    return { ch: null, confidence: 0, source: 'shape-unmatched' };
  }
  return { ch: null, confidence: 0, source: 'undecodable' };
}

const STANDARD_LATIN = /times|helvetica|arial|courier|newroman|garamond|palatino|bookman|century|schoolbook|georgia|verdana|tahoma|calibri|minion|nimbus|liberation/i;

function isStandardLatinFont(baseFont) {
  return STANDARD_LATIN.test(baseFont ?? '');
}

/** Codes above 126 in the Adobe standard/WinAnsi encodings of the base-14 faces. */
const SEMI_STANDARD = new Map([
  [161, '¡'], [162, '¢'], [163, '£'], [164, '¤'], [165, '¥'], [166, '¦'], [167, '§'], [168, '¨'],
  [169, '©'], [170, 'ª'], [171, '«'], [172, '¬'], [173, '\u00ad'], [174, '®'], [175, '¯'],
  [176, '°'], [177, '±'], [178, '²'], [179, '³'], [180, '´'], [181, 'µ'], [182, '¶'], [183, '·'],
  [184, '¸'], [185, '¹'], [186, 'º'], [187, '»'], [188, '¼'], [189, '½'], [190, '¾'], [191, '¿'],
  [192, 'À'], [193, 'Á'], [194, 'Â'], [195, 'Ã'], [196, 'Ä'], [197, 'Å'], [198, 'Æ'], [199, 'Ç'],
  [200, 'È'], [201, 'É'], [202, 'Ê'], [203, 'Ë'], [204, 'Ì'], [205, 'Í'], [206, 'Î'], [207, 'Ï'],
  [208, 'Ð'], [209, 'Ñ'], [210, 'Ò'], [211, 'Ó'], [212, 'Ô'], [213, 'Õ'], [214, 'Ö'], [215, '×'],
  [216, 'Ø'], [217, 'Ù'], [218, 'Ú'], [219, 'Û'], [220, 'Ü'], [221, 'Ý'], [222, 'Þ'], [223, 'ß'],
  [224, 'à'], [225, 'á'], [226, 'â'], [227, 'ã'], [228, 'ä'], [229, 'å'], [230, 'æ'], [231, 'ç'],
  [232, 'è'], [233, 'é'], [234, 'ê'], [235, 'ë'], [236, 'ì'], [237, 'í'], [238, 'î'], [239, 'ï'],
  [240, 'ð'], [241, 'ñ'], [242, 'ò'], [243, 'ó'], [244, 'ô'], [245, 'õ'], [246, 'ö'], [247, '÷'],
  [248, 'ø'], [249, 'ù'], [250, 'ú'], [251, 'û'], [252, 'ü'], [253, 'ý'], [254, 'þ'], [255, 'ÿ'],
]);

function descriptorForCode(font, code) {
  if (font.cffPaths && font.cffMatrix) {
    const gid = mapCodeToGid(font, code);
    if (gid === null || gid >= font.cffPaths.length) return null;
    const path = transformPath(font.cffPaths[gid], font.cffMatrix);
    return describeGlyphPath(path);
  }
  if (font.ttf) {
    const gid = mapCodeToGid(font, code);
    if (gid === null) return null;
    const upem = font.ttf.unitsPerEm || 1000;
    const path = font.ttf.glyphPath(gid);
    if (!path || !path.cmds.length) return null;
    const s = 1 / upem;
    return describeGlyphPath({
      cmds: path.cmds.map((c) => {
        const o = [c[0]];
        for (let i = 1; i < c.length; i += 2) o.push(c[i] * s, c[i + 1] * s);
        return o;
      }),
    });
  }
  return null;
}

function mapCodeToGid(font, code) {
  if (font.cff) {
    const byName = new Map();
    font.cff.charsets.forEach((n, gid) => { if (!byName.has(n)) byName.set(n, gid); });
    const nm = font.differences.get(code);
    if (nm) {
      if (byName.has(nm)) return byName.get(nm);
      const m = /^(?:cid|g|cidip|index)(\d+)$/i.exec(nm);
      if (m) return +m[1];
    }
    // Subset fonts produced by most tools lay glyphs out in ascending code
    // order starting at index 1; verify against /Widths when possible.
    if (font.cff.charsets.length > 1) {
      const guess = code - (font.widths.first ?? 0) + 1;
      if (guess > 0 && guess < font.cff.charsets.length) {
        const gidByName = byName.get(`cid${code}`) ?? byName.get(`g${code}`);
        if (gidByName !== undefined) return gidByName;
        return guess;
      }
    }
    return null;
  }
  if (font.ttf) {
    const byName = new Map();
    for (const [cp, gid] of font.ttf.cmap) if (!byName.has(gid)) byName.set(gid, cp);
    const nm = font.differences.get(code);
    if (nm) {
      const ch = glyphNameToChar(nm);
      if (ch) {
        const gid = font.ttf.cmap.get(ch.codePointAt(0));
        if (gid !== undefined) return gid;
      }
      const m = /^(?:cid|g|index)(\d+)$/i.exec(nm);
      if (m) return +m[1];
    }
    if (font.isCID) return code;
    const gid = font.ttf.cmap.get(code);
    if (gid !== undefined) return gid;
    const guess = code - (font.widths.first ?? 0) + 1;
    return guess >= 0 && guess < font.ttf.numGlyphs ? guess : null;
  }
  return null;
}

/** Load every font resource of a page. */
export function loadPageFonts(doc, page, options = {}) {
  const refs = doc.pageFonts(page);
  const fonts = new Map();
  for (const [name, obj] of refs) {
    try {
      fonts.set(name, buildFont(doc, obj, name));
    } catch {
      fonts.set(name, null);
    }
  }
  return fonts;
}

export function readFontFile(path) {
  return fs.readFileSync(path);
}

export { familyOf };
