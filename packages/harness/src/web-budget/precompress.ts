/*
 * The brotli copies a web server serves. nginx's `brotli_static` sends
 * `<file>.br` to a client that accepts `br` when that file sits next to the
 * original, so the server never compresses anything at request time. A build
 * step runs `precompressDir` over the final build output, and the budgets weigh
 * the same bytes (`servedSize`), so what a budget weighs is what the server
 * holds. `checkPrecompressed` is the gate for an output someone else wrote:
 * every copy present, current and nothing more.
 */
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

import { toPosix } from './build-graph.js';
import type { IBudgetReport } from './report.js';

/** Brotli's top quality: the work is done once, at build time. */
export const BROTLI_QUALITY = 11;

/** The suffix of a precompressed copy: what `brotli_static` looks for. */
export const BROTLI_SUFFIX = '.br';

/**
 * What gets a `.br` by default, by extension, with the Content-Type a server
 * typically sends it as. Keep every type in the server's `gzip_types` (or
 * text/html, which nginx always compresses), so a client with br never gets
 * less than one with gzip. Fonts and images are already compressed formats.
 */
export const PRECOMPRESS_TYPES: Readonly<Record<string, string>> = {
  atom: 'application/atom+xml',
  css: 'text/css',
  html: 'text/html',
  js: 'application/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  xml: 'text/xml',
};

/** The default length floor, the same as nginx's default `gzip_min_length`. */
export const PRECOMPRESS_MIN_LENGTH = 20;

export interface IPrecompressOptions {
  /** Extensions (no dot, lower case) that get a copy, with their Content-Type. Defaults to `PRECOMPRESS_TYPES`. */
  readonly types?: Readonly<Record<string, string>>;
  /** Files shorter than this get no copy. Match the server's `gzip_min_length`. Defaults to 20. */
  readonly minLength?: number;
  /**
   * Paths under the root that never get a copy: a file the server rewrites at
   * start (a copy would describe a file nobody serves), or one it never serves.
   */
  readonly never?: readonly string[];
}

/** The I/O `precompressDir` and `checkPrecompressed` need, over paths under `dir` with `/` separators. */
export interface IPrecompressDeps {
  /** Every file under `dir`, at any depth. */
  readonly listFiles: (dir: string) => readonly string[];
  readonly readFile: (dir: string, file: string) => Buffer;
  readonly writeFile: (dir: string, file: string, body: Buffer) => void;
  readonly removeFile: (dir: string, file: string) => void;
}

export interface IPrecompressRun {
  /** Files that got a `.br`, as paths under the directory. */
  readonly written: readonly string[];
  /** `.br` files that were there before and were removed first. */
  readonly removed: readonly string[];
}

/** The file's extension without the dot, lower case, or '' for none. */
function extensionOf(file: string): string {
  return (/\.([^./\\]+)$/u.exec(file)?.[1] ?? '').toLowerCase();
}

/** `file` as a path under the root with `/` separators, whatever the platform. */
export function rootRelative(file: string): string {
  return toPosix(file).replace(/^\.?\//u, '');
}

/** One body as brotli at BROTLI_QUALITY: the text mode and a size hint, as an encoder is told. */
export function brotliBytes(body: Buffer): Buffer {
  return brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  });
}

/**
 * The `.br` copy of a file of the build, or null when it gets none: a kind of
 * file that is not in `types`, one of `never`, one under the length floor, or
 * one brotli cannot make smaller. `file` is the path under the root.
 */
export function precompressedBody(
  file: string,
  body: Buffer,
  options: IPrecompressOptions = {},
): Buffer | null {
  const relativePath = rootRelative(file);
  const types = options.types ?? PRECOMPRESS_TYPES;
  if (!Object.hasOwn(types, extensionOf(relativePath))) return null;
  if ((options.never ?? []).map(rootRelative).includes(relativePath)) return null;
  if (body.length < (options.minLength ?? PRECOMPRESS_MIN_LENGTH)) return null;
  const packed = brotliBytes(body);
  return packed.length < body.length ? packed : null;
}

function sortedFiles(deps: IPrecompressDeps, dir: string): string[] {
  return deps.listFiles(dir).map(rootRelative).sort();
}

/**
 * Give every eligible file under `dir` a `.br`. Every `.br` already there is
 * removed first, so a copy can never outlive or predate the file it stands
 * for: after this, the copies are exactly the ones this run wrote. A run that
 * wrote nothing should fail its caller: a build with no compressible file is
 * not the build it was meant to be.
 */
export function precompressDir(
  dir: string,
  deps: IPrecompressDeps,
  options: IPrecompressOptions = {},
): IPrecompressRun {
  const removed: string[] = [];
  for (const file of sortedFiles(deps, dir)) {
    if (file.endsWith(BROTLI_SUFFIX)) {
      deps.removeFile(dir, file);
      removed.push(file);
    }
  }
  const written: string[] = [];
  for (const file of sortedFiles(deps, dir)) {
    const packed = precompressedBody(file, deps.readFile(dir, file), options);
    if (packed === null) continue;
    deps.writeFile(dir, `${file}${BROTLI_SUFFIX}`, packed);
    written.push(file);
  }
  return { written, removed };
}

function decodes(copy: Buffer, body: Buffer): boolean {
  try {
    return brotliDecompressSync(copy).equals(body);
  } catch {
    return false;
  }
}

/**
 * Check the copies under `dir` without writing anything: every eligible file
 * has a `.br` that decodes to it, and no `.br` stands for a file that is gone
 * or gets no copy. A directory with no eligible file is a problem too: a check
 * that checked nothing is not a pass.
 */
export function checkPrecompressed(
  dir: string,
  deps: Pick<IPrecompressDeps, 'listFiles' | 'readFile'>,
  options: IPrecompressOptions = {},
): IBudgetReport {
  const files = deps.listFiles(dir).map(rootRelative).sort();
  const present = new Set(files);
  const problems: string[] = [];
  const expected = new Set<string>();
  for (const file of files) {
    if (file.endsWith(BROTLI_SUFFIX)) continue;
    const body = deps.readFile(dir, file);
    if (precompressedBody(file, body, options) === null) continue;
    const copy = `${file}${BROTLI_SUFFIX}`;
    expected.add(copy);
    if (!present.has(copy)) {
      problems.push(`${copy} is missing: run the precompress step after the build`);
    } else if (!decodes(deps.readFile(dir, copy), body)) {
      problems.push(`${copy} does not decode to ${file}: run the precompress step after the build`);
    }
  }
  for (const file of files) {
    if (file.endsWith(BROTLI_SUFFIX) && !expected.has(file)) {
      problems.push(
        `${file} stands for a file that is gone or gets no copy: run the precompress step, which removes it`,
      );
    }
  }
  if (expected.size === 0) problems.push(`nothing under ${dir} gets a precompressed copy`);
  return { lines: [`${expected.size} files with a precompressed copy`], problems };
}
