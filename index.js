// dsh-pdf-formula -- Host-only Cordis plugin exposing three agent-facing tools
// backed by the recognition engine in ./lib/*.mjs.
//
// Shape: `export const name` + `export const inject` + `export function apply`
// with an optional `export const Config`. Tools are registered through the
// injected `tools` service (ToolDefinition: { name, description, parameters,
// output: { schema, render }, execute }).
//
// Two properties this file guarantees:
//   1. `apply` never throws. Registration problems are collected and reported
//      once through ctx.logger (or console), and the plugin still loads.
//   2. Every `execute` resolves to a plain JSON-serialisable object. Engine
//      failures come back as `{ ok: false, error }` instead of rejecting.
//
// The engine modules are imported dynamically so that a broken or still-being
// written engine file cannot break plugin activation.

import { isAbsolute, relative, resolve as resolveFsPath } from 'node:path';

export const name = 'pdf-formula';

export const inject = ['tools'];

// NOTE: no `Config` export. Cordis resolves a plugin's config schema through
// schemastery (`Config.validate`), so a plain JSON-Schema object makes activation
// fail with "Cannot read properties of undefined (reading 'validate')". Every
// setting this plugin supports is a tool argument with its own default.

/* ------------------------------------------------------------------ helpers */

const TEXT_LIMIT = 6000;
const FORMULA_LIMIT = 400;

function errorMessage(error) {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value.forEach === 'function' && typeof value !== 'string') {
    try {
      const out = [];
      value.forEach((entry) => out.push(entry));
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value) {
  return text(value).replace(/\s+/g, ' ').trim();
}

function truncate(value, limit) {
  const s = text(value);
  return s.length > limit ? `${s.slice(0, limit)}\n... [truncated, ${s.length} characters total]` : s;
}

/**
 * Resolve a caller-supplied path to a host path.
 *
 * Relative paths anchor at the **session workspace** (`exec.agent.session.header.cwd`),
 * which is what every other workspace-facing tool in the Harness uses. The host
 * process's own cwd is the directory `dsh` was launched from and usually has nothing
 * to do with the session, so a relative path must never be resolved against it.
 * The session filesystem service is consulted when it is mounted, so the path is
 * canonicalised the way the built-in file tools do it; a service that refuses or is
 * absent falls back to the lexical path, which the containment check below already
 * vetted. Without a session (standalone boot, unit tests) the anchor degrades to
 * `process.cwd()`.
 *
 * Absolute paths are used verbatim, exactly as before.
 */
async function resolvePdfPath(ctx, exec, input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('a non-empty "path" is required');
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) return raw;

  const sessionCwd = exec?.agent?.session?.header?.cwd;
  const root = resolveFsPath(sessionCwd ? String(sessionCwd) : process.cwd());
  const lexical = resolveFsPath(root, raw);
  const rel = relative(root, lexical);
  if (rel === '') throw new Error(`path "${raw}" names the session workspace itself, not a file inside it`);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${raw}" escapes the session workspace "${root}"; pass an absolute path to read outside it`);
  }

  const fs = optionalService(ctx, 'fs');
  if (fs && typeof fs.resolve === 'function' && typeof fs.processPath === 'function') {
    try {
      const target = await fs.resolve(raw, { cwd: root, signal: exec?.signal });
      return fs.processPath(target);
    } catch {
      // A filesystem service that disagrees must never cost a readable file: the
      // lexical path below is already contained in the session workspace, and the
      // sandbox fences writes, not reads, so this stays defence-in-depth only.
      return lexical;
    }
  }
  return lexical;
}

/* ------------------------------------------------------- engine (lazy load) */

let enginePromise = null;

function engine() {
  if (!enginePromise) {
    enginePromise = import('./lib/extract.mjs').catch((error) => {
      enginePromise = null;
      throw new Error(`pdf-formula engine ./lib/extract.mjs is unavailable: ${errorMessage(error)}`);
    });
  }
  return enginePromise;
}

/** Call one engine function, tolerating both promise- and value-returning forms. */
async function callEngine(fn, ...args) {
  const mod = await engine();
  if (typeof mod[fn] !== 'function') throw new Error(`pdf-formula engine does not export ${fn}()`);
  const out = mod[fn](...args);
  return out && typeof out.then === 'function' ? await out : out;
}

/* ------------------------------------------------------------ normalisation */

function normalizeFont(raw) {
  const font = raw && typeof raw === 'object' ? raw : {};
  return {
    name: text(firstString(font.name, font.resource, font.ref, '') ?? ''),
    baseFont: text(firstString(font.baseFont, font.base, font.fontName, font.name, '') ?? ''),
    subtype: text(firstString(font.subtype, font.type, '') ?? ''),
    embedded: font.embedded === true,
  };
}

function collectPageRecords(result) {
  if (!result || typeof result !== 'object') return [];
  for (const key of ['details', 'pageInfo', 'pageDetails', 'pageSizes', 'pageList', 'pages']) {
    const value = result[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value.forEach === 'function' && typeof value !== 'string') {
      const list = asArray(value);
      if (list.length > 0) return list;
    }
  }
  return [];
}

function pageCountOf(result, fallback) {
  const source = result && typeof result === 'object' ? result : {};
  const direct = firstNumber(source.pageCount, source.numPages, source.count, source.totalPages);
  if (direct !== undefined) return Math.round(direct);
  // pdfInfo reports the bare page count in `pages`, not an array of pages.
  if (typeof source.pages === 'number') return Math.round(source.pages);
  const records = collectPageRecords(source);
  if (records.length > 0) return records.length;
  return fallback;
}

/** Merge parallel per-page lists (details, pageSizes, text) into one record set. */
function mergePageRecords(...lists) {
  const merged = new Map();
  let index = 0;
  for (const list of lists) {
    for (const raw of asArray(list)) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const number = firstNumber(record.page, record.index, record.number, index + 1);
      const key = number ?? index + 1;
      merged.set(key, { ...(merged.get(key) ?? {}), ...record });
      index += 1;
    }
  }
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, record]) => ({ number, record }));
}

function normalizeInfoPage(number, record) {
  const page = record && typeof record === 'object' ? record : {};
  const sm = page.size && typeof page.size === 'object' ? page.size : {};
  const width = firstNumber(page.width, sm.width, page.w, page.mediaBox?.[2], page.mediaBox?.[0]);
  const height = firstNumber(page.height, sm.height, page.h, page.mediaBox?.[3], page.mediaBox?.[1]);
  const fonts = asArray(page.fonts).map(normalizeFont);
  const imageCount = firstNumber(page.imageCount, page.images, asArray(page.imageList).length);
  const glyphCount = firstNumber(page.glyphCount, page.glyphs);
  const out = {
    page: Math.round(number),
    fonts,
  };
  if (width !== undefined) out.width = Math.round(width * 100) / 100;
  if (height !== undefined) out.height = Math.round(height * 100) / 100;
  const rotation = firstNumber(page.rotate, page.rotation);
  if (rotation !== undefined) out.rotation = Math.round(rotation);

  // Scanned = no text layer / image-only. Only signals the engine actually
  // produced are used, so an unknown page stays unknown rather than guessed.
  if (typeof page.scanned === 'boolean') out.scanned = page.scanned;
  else if (typeof page.likelyScanned === 'boolean') out.scanned = page.likelyScanned;
  else if (typeof page.imageOnly === 'boolean') out.scanned = page.imageOnly;
  else if (typeof page.hasTextLayer === 'boolean') out.scanned = page.hasTextLayer === false;
  else if (typeof page.hasText === 'boolean') out.scanned = page.hasText === false;
  else if (typeof page.text === 'string') out.scanned = page.text.trim().length === 0;
  else if (glyphCount !== undefined) out.scanned = glyphCount === 0;
  else if (imageCount !== undefined && imageCount > 0) out.scanned = true;

  if (imageCount !== undefined) out.imageCount = Math.round(imageCount);
  if (glyphCount !== undefined) out.glyphCount = Math.round(glyphCount);
  return out;
}

function normalizeTextPage(raw, index, mode) {
  const page = raw && typeof raw === 'object' ? raw : {};
  const markdown = text(firstString(page.markdown, page.md, '') ?? '');
  const plain = text(firstString(page.text, page.plain, page.raw) ?? '');
  return {
    page: firstNumber(page.page, page.index, page.number, index + 1),
    text: plain,
    markdown: markdown || (mode === 'markdown' ? plain : ''),
    formulas: asArray(page.formulas).length,
    uncertain: asArray(page.uncertainSymbols ?? page.uncertain).map(normalizeUncertain),
    glyphCount: firstNumber(page.glyphCount, page.glyphs),
    imageCount: firstNumber(page.imageCount, page.images),
  };
}

function normalizeUncertain(raw) {
  const symbol = raw && typeof raw === 'object' ? raw : { ch: raw };
  const confidence = firstNumber(symbol.confidence, symbol.score, 0);
  return {
    symbol: text(firstString(symbol.symbol, symbol.ch, symbol.char, symbol.glyph, '?') ?? '?'),
    code: firstNumber(symbol.code, symbol.cid, symbol.charCode, -1),
    confidence: confidence !== undefined ? Math.round(confidence * 1000) / 1000 : 0,
    source: text(firstString(symbol.source, '') ?? ''),
  };
}

function normalizeFormula(raw, index) {
  const formula = raw && typeof raw === 'object' ? raw : {};
  const confidence = firstNumber(formula.confidence, formula.score, formula.minConfidence, 0);
  return {
    index: firstNumber(formula.index, index + 1),
    latex: text(firstString(formula.latex, formula.tex, '') ?? ''),
    display: formula.display === false ? false : true,
    confidence: confidence !== undefined ? Math.round(confidence * 1000) / 1000 : 0,
    uncertain: asArray(formula.uncertain ?? formula.uncertainSymbols ?? formula.lowConfidence).map(normalizeUncertain),
    source: text(firstString(formula.source, '') ?? ''),
  };
}

function normalizeFormulaPage(raw, index, opts) {
  const page = raw && typeof raw === 'object' ? raw : {};
  const formulas = asArray(page.formulas).map(normalizeFormula);
  const kept = opts.includeUncertain
    ? formulas
    : formulas.filter((formula) => formula.confidence >= opts.minConfidence);
  return {
    page: firstNumber(page.page, page.index, page.number, index + 1),
    formulas: kept,
    total: formulas.length,
  };
}

/* -------------------------------------------------------------------- tools */

function renderInfo(_args, value) {
  const lines = [];
  if (value.ok === false) {
    lines.push(`pdf_info failed: ${text(value.error)}`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  lines.push(`File: ${text(value.file)}`);
  lines.push(`Pages: ${firstNumber(value.pageCount, 0)}`);
  for (const page of asArray(value.pages)) {
    const size = page.width !== undefined && page.height !== undefined
      ? `${page.width} x ${page.height} pt`
      : 'size unknown';
    const scanned = page.scanned === true ? ' | scanned/image-only' : '';
    lines.push(`- page ${page.page}: ${size}${scanned}`);
    const fonts = asArray(page.fonts);
    if (fonts.length === 0) lines.push('    fonts: none declared');
    for (const font of fonts) {
      lines.push(`    font ${font.name || '?'} = ${font.baseFont || '?'} [${font.subtype || 'unknown'}] ${font.embedded ? 'embedded' : 'not embedded'}`);
    }
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderText(_args, value) {
  if (value.ok === false) return [{ type: 'text', text: `pdf_extract_text failed: ${text(value.error)}` }];
  const blocks = [];
  for (const page of asArray(value.pages)) {
    const body = value.mode === 'text' ? text(page.text) : text(page.markdown) || text(page.text);
    blocks.push(`===== page ${page.page} =====\n${truncate(body, TEXT_LIMIT)}`);
  }
  const note = value.note ? `\n(${text(value.note)})` : '';
  return [{ type: 'text', text: `${blocks.join('\n\n')}${note}` || '(no text extracted)' }];
}

function renderFormulas(_args, value) {
  if (value.ok === false) return [{ type: 'text', text: `pdf_extract_formulas failed: ${text(value.error)}` }];
  const lines = [];
  let shown = 0;
  for (const page of asArray(value.pages)) {
    for (const formula of asArray(page.formulas)) {
      if (shown >= FORMULA_LIMIT) break;
      shown += 1;
      lines.push(`[p${page.page} #${formula.index}] confidence ${formula.confidence}`);
      lines.push(`  ${formula.latex}`);
      for (const symbol of asArray(formula.uncertain)) {
        lines.push(`  ? unresolved symbol code ${symbol.code} (${symbol.symbol}) confidence ${symbol.confidence} via ${symbol.source || 'unknown'}`);
      }
    }
    if (shown >= FORMULA_LIMIT) break;
  }
  if (lines.length === 0) lines.push('No formulas detected on the requested pages.');
  if (shown >= FORMULA_LIMIT) lines.push(`... truncated at ${FORMULA_LIMIT} formulas.`);
  return [{ type: 'text', text: lines.join('\n') }];
}

const FORMULA_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'ok=false carries error; otherwise pages[] holds the detected formulas.',
  properties: {
    ok: { type: 'boolean', description: 'false when extraction failed; the call still resolves.' },
    error: { type: 'string', description: 'Failure message when ok is false.' },
    file: { type: 'string', description: 'Resolved absolute path that was read.' },
    path: { type: 'string', description: 'Path as supplied by the caller.' },
    pages: {
      type: 'array',
      description: 'One entry per requested page, in document order.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          page: { type: 'integer', description: '1-based page number.' },
          total: { type: 'integer', description: 'Formulas found on the page, before filtering.' },
          formulas: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                index: { type: 'integer', description: '1-based formula index on its page.' },
                latex: { type: 'string', description: 'Reconstructed LaTeX for the formula.' },
                display: { type: 'boolean', description: 'true for a display (block) formula.' },
                confidence: { type: 'number', description: '0..1 confidence of the reconstruction.' },
                source: { type: 'string', description: 'Dominant decoding evidence.' },
                glyphCount: { type: 'integer', description: 'Glyphs the formula was built from.' },
                page: { type: 'integer', description: '1-based page number of the formula.' },
                uncertain: {
                  type: 'array',
                  description: 'Low-confidence symbols that could not be resolved.',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      symbol: { type: 'string', description: 'Best-guess symbol, "?" when unknown.' },
                      code: { type: 'integer', description: 'Character code in the PDF font.' },
                      confidence: { type: 'number', description: '0..1 confidence for this symbol.' },
                      source: { type: 'string', description: 'Decoding path: tounicode, differences, shape, standard-encoding.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    pageCount: { type: 'integer', description: 'Pages in the document.' },
    formulaCount: { type: 'integer', description: 'Formulas returned across all requested pages.' },
    minConfidence: { type: 'number', description: 'Threshold actually applied (0..1).' },
    includeUncertain: { type: 'boolean', description: 'Whether formulas with unresolved symbols were kept.' },
    format: { type: 'string', enum: ['latex', 'json'], description: 'Requested output format.' },
    scannedPages: { type: 'array', description: '1-based numbers of pages that look scanned.', items: { type: 'integer' } },
    note: { type: 'string', description: 'Extra context about the result.' },
  },
};

// Last-resort schemas: register() validates the schema subset, so if a schema
// above is ever rejected the tool is still registered with an unconstrained
// object-rooted one instead of disappearing.
const MINIMAL_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };
const MINIMAL_PARAMETERS = { type: 'object', additionalProperties: true };

function buildTools(settings, ctx) {
  return [
    {
      name: 'pdf_info',
      description:
        'Inspect a PDF without extracting prose: page count, per-page size in points, the font list of every page '
        + 'with baseFont/subtype/embedded flags, and whether a page looks scanned (image-only, no text layer). '
        + 'Use it first to decide which pages are worth reading and whether formula recognition is possible at all.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'PDF file path: absolute, or relative to the session workspace.',
          },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'ok=false carries error; otherwise pages[] describes the document.',
          properties: {
            ok: { type: 'boolean', description: 'false when inspection failed; the call still resolves.' },
            error: { type: 'string', description: 'Failure message when ok is false.' },
            file: { type: 'string', description: 'Resolved absolute path that was read.' },
            path: { type: 'string', description: 'Path as supplied by the caller.' },
            pageCount: { type: 'integer', description: 'Number of pages.' },
            pages: {
              type: 'array',
              description: 'One entry per page, in document order.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  page: { type: 'integer', description: '1-based page number.' },
                  width: { type: 'number', description: 'Page width in points.' },
                  height: { type: 'number', description: 'Page height in points.' },
                  rotation: { type: 'integer', description: 'Page /Rotate value in degrees.' },
                  scanned: { type: 'boolean', description: 'true when the page has no text layer and looks image-only.' },
                  imageCount: { type: 'integer', description: 'Image XObjects drawn on the page.' },
                  glyphCount: { type: 'integer', description: 'Text glyphs placed on the page; 0 on a scanned page.' },
                  fonts: {
                    type: 'array',
                    description: 'Fonts referenced by the page.',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        name: { type: 'string', description: 'Resource name, e.g. F1.' },
                        baseFont: { type: 'string', description: '/BaseFont of the font dictionary.' },
                        subtype: { type: 'string', description: 'Type1, TrueType, Type0, Type3, ...' },
                        embedded: { type: 'boolean', description: 'true when an embedded font program was parsed.' },
                      },
                    },
                  },
                },
              },
            },
            note: { type: 'string', description: 'Extra context about the result.' },
          },
        },
        render: renderInfo,
      },
      async execute(args, exec) {
        const requested = text(args && args.path);
        const file = await resolvePdfPath(ctx, exec, requested);
        const out = { ok: true, path: requested, file };
        const notes = [];

        const [infoOutcome, textOutcome] = await Promise.all([
          callEngine('pdfInfo', file).then((value) => ({ value }), (error) => ({ error })),
          callEngine('extractText', file, { pages: 'all', mode: 'text', formulas: false })
            .then((value) => ({ value }), (error) => ({ error })),
        ]);

        const info = infoOutcome.value ?? null;
        const texts = asArray(textOutcome.value && textOutcome.value.pages);

        // The engine may report page facts in any of several parallel lists, so
        // merge every per-page list it returned before normalising.
        const merged = mergePageRecords(
          collectPageRecords(info),
          asArray(info && info.pageSizes),
          texts,
        );
        if (merged.length === 0 && !info) {
          const reason = infoOutcome.error ?? textOutcome.error;
          return { ok: false, error: reason ? errorMessage(reason) : 'the engine returned no page information' };
        }
        if (!info) {
          notes.push(`page-level inspection was unavailable (${errorMessage(infoOutcome.error)}); results come from text extraction only`);
        } else if (infoOutcome.value && collectPageRecords(info).length === 0) {
          notes.push('the engine reported no page-level details');
        }

        const pages = merged.map(({ number, record }) => normalizeInfoPage(number, record));
        const count = pageCountOf(info ?? {}, pages.length);
        if (count !== undefined) out.pageCount = count;
        out.pages = pages;

        const scanned = pages.filter((page) => page.scanned === true).map((page) => page.page);
        if (scanned.length > 0) {
          out.scannedPages = scanned;
          notes.push(`pages ${scanned.join(', ')} look scanned (image-only, no text layer)`);
        }
        if (notes.length > 0) out.note = notes.join('; ');
        return out;
      },
    },

    {
      name: 'pdf_extract_text',
      description:
        'Extract page text from a PDF, with inline display formulas rendered as LaTeX. Returns one entry per page '
        + 'holding both plain text and markdown. Use it to read a paper while keeping its equations machine-readable; '
        + 'set formulas=false for a cheap text-only pass on a large document.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'PDF file path: absolute, or relative to the session workspace.',
          },
          pages: {
            type: 'string',
            description: 'Page selection such as "1-5,9" or "all" (default). 1-based, inclusive ranges.',
          },
          mode: {
            type: 'string',
            enum: ['text', 'markdown'],
            description: '"markdown" (default) keeps headings and formula blocks; "text" returns plain reading order.',
          },
          formulas: {
            type: 'boolean',
            description: 'Render display formulas as LaTeX (default true). false is faster and skips recognition.',
          },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'ok=false carries error; otherwise pages[] holds text and markdown per page.',
          properties: {
            ok: { type: 'boolean', description: 'false when extraction failed; the call still resolves.' },
            error: { type: 'string', description: 'Failure message when ok is false.' },
            file: { type: 'string', description: 'Resolved absolute path that was read.' },
            path: { type: 'string', description: 'Path as supplied by the caller.' },
            mode: { type: 'string', enum: ['text', 'markdown'], description: 'Mode actually used.' },
            formulas: { type: 'boolean', description: 'Whether formula rendering was requested.' },
            pages: {
              type: 'array',
              description: 'One entry per extracted page, in document order.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  page: { type: 'integer', description: '1-based page number.' },
                  text: { type: 'string', description: 'Plain reading-order text; display formulas appear as LaTeX.' },
                  markdown: { type: 'string', description: 'Markdown rendering with formulas as LaTeX blocks.' },
                  formulas: { type: 'integer', description: 'Display formulas rendered on this page.' },
                  glyphCount: { type: 'integer', description: 'Glyphs decoded on the page.' },
                  uncertain: {
                    type: 'array',
                    description: 'Glyphs the decoder could not resolve with confidence.',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        symbol: { type: 'string', description: 'Best-guess symbol, "?" when unknown.' },
                        code: { type: 'integer', description: 'Character code in the PDF font.' },
                        confidence: { type: 'number', description: '0..1 confidence for this symbol.' },
                        source: { type: 'string', description: 'Decoding path, e.g. shape or tounicode.' },
                      },
                    },
                  },
                },
              },
            },
            pageCount: { type: 'integer', description: 'Pages in the document.' },
            scannedPages: { type: 'array', description: '1-based numbers of pages with no text layer.', items: { type: 'integer' } },
            note: { type: 'string', description: 'Extra context, e.g. pages that yielded nothing.' },
          },
        },
        render: renderText,
      },
      async execute(args, exec) {
        const source = args && typeof args === 'object' ? args : {};
        const requested = text(source.path);
        const file = await resolvePdfPath(ctx, exec, requested);
        const configuredMode = settings.defaultMode === 'text' || settings.defaultMode === 'markdown' ? settings.defaultMode : 'markdown';
        const mode = source.mode === 'text' || source.mode === 'markdown' ? source.mode : configuredMode;
        const formulas = source.formulas === undefined ? true : source.formulas === true;
        const pages = typeof source.pages === 'string' && source.pages.trim() ? source.pages.trim() : 'all';

        const result = await callEngine('extractText', file, { pages, mode, formulas });
        const list = asArray(result && result.pages).map((raw, index) => normalizeTextPage(raw, index, mode));
        const out = { ok: true, path: requested, file, mode, formulas, pages: list };
        const count = pageCountOf(result ?? {}, undefined);
        if (count !== undefined) out.pageCount = count;

        const empty = list.filter((page) => text(page.text).trim().length === 0 && text(page.markdown).trim().length === 0);
        const uncertain = list.reduce((sum, page) => sum + page.uncertain.length, 0);
        if (list.length === 0) out.note = 'no pages were extracted for this selection';
        else if (empty.length > 0) {
          out.note = `pages ${empty.map((page) => page.page).join(', ')} produced no text (possibly scanned); pdf_info reports which pages are image-only`;
        }
        if (uncertain > 0) {
          const extra = `${uncertain} glyph(s) in this text were decoded with low confidence`;
          out.note = out.note ? `${out.note}; ${extra}` : extra;
        }
        return out;
      },
    },

    {
      name: 'pdf_extract_formulas',
      description:
        'Detect the formulas of a PDF and return each one as LaTeX with its page number, confidence and the '
        + 'low-confidence symbols that could not be resolved. Recognition works on the PDF text layer and glyph '
        + 'outlines, so it needs a text-based PDF; a scanned page yields no formulas.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'PDF file path: absolute, or relative to the session workspace.',
          },
          pages: {
            type: 'string',
            description: 'Page selection such as "1-5,9" or "all" (default). 1-based, inclusive ranges.',
          },
          minConfidence: {
            type: 'number',
            description: 'Drop formulas below this 0..1 confidence (default 0.5).',
          },
          includeUncertain: {
            type: 'boolean',
            description: 'Keep formulas that contain unresolved symbols but report those symbols (default true).',
          },
          format: {
            type: 'string',
            enum: ['latex', 'json'],
            description: '"latex" (default) returns the formula list; "json" adds the full structured record.',
          },
        },
        required: ['path'],
      },
      output: {
        schema: FORMULA_OUTPUT_SCHEMA,
        render: renderFormulas,
      },
      async execute(args, exec) {
        const source = args && typeof args === 'object' ? args : {};
        const requested = text(source.path);
        const file = await resolvePdfPath(ctx, exec, requested);
        const configuredConfidence = Number(settings.minConfidence);
        const configDefault = Number.isFinite(configuredConfidence) ? configuredConfidence : 0.5;
        const minConfidence = clampNumber(source.minConfidence, configDefault, 0, 1);
        const includeUncertain = source.includeUncertain === undefined ? true : source.includeUncertain === true;
        const configuredFormat = settings.defaultFormat === 'latex' || settings.defaultFormat === 'json' ? settings.defaultFormat : 'latex';
        const format = source.format === 'latex' || source.format === 'json' ? source.format : configuredFormat;
        const pages = typeof source.pages === 'string' && source.pages.trim() ? source.pages.trim() : 'all';

        const result = await callEngine('extractFormulas', file, { pages, minConfidence, includeUncertain });
        const opts = { minConfidence, includeUncertain };
        const list = asArray(result && result.pages).map((raw, index) => normalizeFormulaPage(raw, index, opts));
        const found = list.reduce((sum, page) => sum + page.formulas.length, 0);
        const dropped = list.reduce((sum, page) => sum + Math.max(0, page.total - page.formulas.length), 0);

        const out = {
          ok: true,
          path: requested,
          file,
          pages: list,
          pageCount: pageCountOf(result ?? {}, list.length),
          minConfidence,
          includeUncertain,
          format,
          formulaCount: found,
        };
        const uncertainCount = list.reduce(
          (sum, page) => sum + page.formulas.reduce((inner, formula) => inner + formula.uncertain.length, 0),
          0,
        );
        if (found === 0) out.note = 'no formulas passed the confidence threshold on the requested pages';
        else if (uncertainCount > 0) out.note = `${uncertainCount} symbol(s) stayed below the confidence threshold and are listed per formula`;
        if (dropped > 0) {
          out.note = out.note
            ? `${out.note}; ${dropped} formula(s) hidden by minConfidence`
            : `${dropped} formula(s) hidden by minConfidence`;
        }
        return out;
      },
    },
  ];
}

/* --------------------------------------------------------- registration ---- */

/** ToolDefinition objects must be plain JSON-serialisable data; strip anything else. */
function sanitizeDefinition(definition, minimal) {
  if (typeof definition.output?.render !== 'function') {
    throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`);
  }
  const schema = definition.output.schema;
  if (!minimal && (!schema || typeof schema !== 'object' || schema.type !== 'object')) {
    throw new TypeError(`tool "${definition.name}" needs an object-rooted output schema`);
  }
  const clean = {
    name: definition.name,
    description: definition.description,
    parameters: minimal ? MINIMAL_PARAMETERS : definition.parameters,
    output: {
      schema: minimal ? MINIMAL_OUTPUT_SCHEMA : schema,
      render: definition.output.render,
    },
    execute: definition.execute,
  };
  for (const key of ['timeoutMs', 'deferLoading', 'presentCall', 'presentResult', 'projectContent', 'finalizeContent', 'isConcurrencySafe']) {
    if (definition[key] !== undefined) clean[key] = definition[key];
  }
  return clean;
}

/**
 * Wrap one tool body so it never rejects, and so the harness's per-call
 * execution context reaches it. `exec` (the second argument the tool runtime
 * passes to every `execute`) carries `agent.session.header.cwd` — the session
 * workspace a relative path must anchor at — plus the call's abort signal, so it
 * has to be forwarded rather than dropped.
 */
function makeRun(definition) {
  return async (args, exec) => {
    try {
      const value = await definition.execute(args, exec);
      if (value && typeof value === 'object' && !Array.isArray(value) && value.ok === undefined) {
        return { ok: true, ...value };
      }
      return value;
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}

/**
 * Read a service that may or may not be present, without tripping Cordis's
 * inject guard. Cordis 4 THROWS on a bare property access for any service the
 * plugin did not declare in `inject` (`cannot get property "tool" without
 * inject`), so `ctx.tool` — an alternative registry this plugin probes for but
 * does not require — must be read through `ctx.get`, which answers an absent
 * service with undefined.
 */
function optionalService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name);
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

function candidates(ctx) {
  const list = [];
  const tools = ctx && ctx.tools;
  if (tools && typeof tools.register === 'function') list.push({ label: 'ctx.tools.register', call: (tool) => tools.register(tool) });
  if (tools && typeof tools.add === 'function') list.push({ label: 'ctx.tools.add', call: (tool) => tools.add(tool) });
  if (tools && typeof tools.set === 'function') list.push({ label: 'ctx.tools.set', call: (tool) => tools.set(tool.name, tool) });
  const single = optionalService(ctx, 'tool');
  if (single && typeof single.register === 'function') list.push({ label: 'ctx.tool.register', call: (tool) => single.register(tool) });
  if (single && typeof single.add === 'function') list.push({ label: 'ctx.tool.add', call: (tool) => single.add(tool) });
  return list;
}

function registerTools(ctx, definitions) {
  const errors = [];
  const disposers = [];
  const via = candidates(ctx);

  if (via.length === 0) {
    errors.push('no tool registry found on ctx.tools / ctx.tool (register, add or set)');
  }

  for (const definition of definitions) {
    const attempts = [];
    for (const path of via) {
      // A registry that rejects the declared schema may still accept a minimal
      // one, so each registration path is tried twice.
      for (const minimal of [false, true]) {
        attempts.push(() => {
          const tool = sanitizeDefinition(definition, minimal);
          tool.execute = makeRun(definition);
          return path.call(tool);
        });
      }
    }
    let registered = false;
    for (const attempt of attempts) {
      try {
        const disposer = attempt();
        if (typeof disposer === 'function') disposers.push(disposer);
        registered = true;
        break;
      } catch (error) {
        errors.push(`${definition.name}: ${errorMessage(error)}`);
      }
    }
    if (!registered) errors.push(`${definition.name}: could not be registered through any available path`);
  }

  if (errors.length > 0) {
    report(ctx, `pdf-formula: tool registration reported ${errors.length} problem(s): ${errors.slice(0, 8).join(' | ')}`);
  }
  return { disposers, errors };
}

function report(ctx, message) {
  let reported = false;
  try {
    const logger = ctx && ctx.logger;
    for (const level of ['warn', 'error', 'info']) {
      if (logger && typeof logger[level] === 'function') {
        logger[level](message);
        reported = true;
        break;
      }
    }
  } catch {
    reported = false;
  }
  if (!reported) {
    try {
      console.warn(message);
    } catch {
      // Nothing left to report through.
    }
  }
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  let definitions = [];
  try {
    definitions = buildTools(settings, ctx);
  } catch (error) {
    report(ctx, `pdf-formula: tool definitions could not be built: ${errorMessage(error)}`);
    return;
  }

  let state = { disposers: [] };
  try {
    state = registerTools(ctx, definitions);
  } catch (error) {
    report(ctx, `pdf-formula: registration aborted: ${errorMessage(error)}`);
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        for (const disposer of state.disposers.splice(0)) {
          try {
            disposer();
          } catch {
            // Nothing left to report through.
          }
        }
      });
    } catch {
      // Registrations are also effect-scoped, so a missing dispose hook is safe.
    }
  }
}
