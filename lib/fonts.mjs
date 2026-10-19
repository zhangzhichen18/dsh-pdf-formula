// System font registry used to build the glyph-template library.
// Absolute paths are resolved against the platform font directory; every entry is
// optional and simply skipped when the file is missing, so the plugin still runs
// (with degraded recognition) on machines without these fonts.
import fs from 'node:fs';
import path from 'node:path';
import { parseTTF } from './font.mjs';

export function fontDirs() {
  const dirs = [];
  const win = process.env.WINDIR || 'C:\\Windows';
  dirs.push(path.join(win, 'Fonts'));
  dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(process.env.HOME || '/root', '.fonts'));
  return dirs;
}

/** Ordered preference list; the first entry that provides a code point wins. */
export const TEMPLATE_SOURCES = [
  { file: 'cambria.ttc', face: 1, style: 'math-italic' },
  { file: 'cambria.ttc', face: 0, style: 'serif-upright' },
  { file: 'times.ttf', style: 'serif-upright' },
  { file: 'timesi.ttf', style: 'serif-italic' },
  { file: 'timesbd.ttf', style: 'serif-bold' },
  { file: 'cambriai.ttf', style: 'serif-italic' },
  { file: 'cambriab.ttf', style: 'serif-bold' },
  { file: 'seguisym.ttf', style: 'symbol' },
  { file: 'segoeui.ttf', style: 'sans' },
  { file: 'DejaVuSans.ttf', style: 'sans' },
  { file: 'DejaVuSerif.ttf', style: 'serif-upright' },
  { file: 'DejaVuSansMono.ttf', style: 'mono' },
];

const cache = new Map();

export function findFontFile(name) {
  for (const dir of fontDirs()) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** Lazily parsed faces keyed by `file#face`. */
export function loadFace(file, face = 0) {
  const key = `${file}#${face}`;
  if (cache.has(key)) return cache.get(key);
  const p = findFontFile(file);
  if (!p) { cache.set(key, null); return null; }
  let out = null;
  try {
    const buf = fs.readFileSync(p);
    const ttf = parseTTF(buf, face);
    const hhea = ttf.tables.get('hhea');
    const u = ttf.unitsPerEm || 1000;
    let ascent = 0.75, descent = -0.25;
    if (hhea) {
      const a = i16at(buf, hhea.offset + 4);
      const d = i16at(buf, hhea.offset + 6);
      if (a > 0) { ascent = a / u; descent = d / u; }
    }
    // collapse the vertical box so that ascent - descent is exactly 1 em
    const span = ascent - descent || 1;
    out = {
      path: p,
      ttf,
      unitsPerEm: u,
      ascent: ascent / span,
      descent: descent / span,
      glyphPath: ttf.glyphPath,
      cmap: ttf.cmap,
      style: TEMPLATE_SOURCES.find((s) => s.file === file && (s.face ?? 0) === face)?.style ?? 'serif-upright',
    };
  } catch {
    out = null;
  }
  cache.set(key, out);
  return out;
}

function i16at(buf, p) { const v = (buf[p] << 8) | buf[p + 1]; return v >= 0x8000 ? v - 0x10000 : v; }

/** Best available face for a code point, honouring the preference order. */
export function faceForCode(cp, preferStyles = null) {
  for (const src of TEMPLATE_SOURCES) {
    if (preferStyles && !preferStyles.includes(src.style)) continue;
    const face = loadFace(src.file, src.face ?? 0);
    if (face && face.cmap.has(cp)) return face;
  }
  return null;
}

export function listAvailableSources() {
  return TEMPLATE_SOURCES.map((s) => ({
    ...s,
    path: findFontFile(s.file),
    face: s.face ?? 0,
  })).filter((s) => s.path);
}
