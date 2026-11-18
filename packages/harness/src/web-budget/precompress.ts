import { toPosix } from './manifest.js';

/*
 * A web server set to serve precompressed files (nginx `gzip_static` and
 * `brotli_static`) falls back to the plain file, or compresses on every
 * request, when a `.br` or `.gz` sibling is missing. Nothing breaks visibly,
 * so this checks the build output: every file the server should serve
 * compressed has a non-empty sibling per encoding, no older than the file.
 */

export interface IFileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface IPrecompressDeps {
  /** Every file under `dir`, relative to it with `/` separators, or null when `dir` cannot be read. */
  readonly listFiles: (dir: string) => readonly string[] | null;
  /** A file's size and modification time (`dir`-relative path), or null when it does not exist. */
  readonly stat: (dir: string, file: string) => IFileStat | null;
}

export interface IPrecompressOptions {
  /** The build output directory the server serves. */
  readonly dir: string;
  /** File extensions served compressed. Defaults to `PRECOMPRESS_EXTENSIONS`. */
  readonly extensions?: readonly string[];
  /** Files smaller than this are served plain (nginx `gzip_min_length`). Defaults to 1024. */
  readonly minBytes?: number;
  /** Sibling suffixes, without the dot. Defaults to `br` and `gz`. */
  readonly encodings?: readonly string[];
  /** Built paths (dir-relative) never checked, matched exactly. */
  readonly exclude?: readonly string[];
}

/** Text-like extensions a server typically serves compressed. */
export const PRECOMPRESS_EXTENSIONS: readonly string[] = [
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.txt',
  '.wasm',
  '.webmanifest',
  '.xml',
];

/** Files under this many bytes are not checked, unless `minBytes` says otherwise. */
export const PRECOMPRESS_MIN_BYTES = 1024;

export interface IPrecompressProblem {
  readonly file: string;
  readonly encoding: string;
  readonly kind: 'missing' | 'empty' | 'stale';
  readonly message: string;
}

export interface IPrecompressReport {
  readonly passed: boolean;
  /** How many files needed precompressed siblings. */
  readonly checked: number;
  readonly problems: readonly IPrecompressProblem[];
  /** Failures that stopped the check: an unreadable dir, nothing to check, a bad option. */
  readonly errors: readonly string[];
}

/** Check every matching file under `options.dir` for its precompressed siblings. */
export function checkPrecompressed(
  options: IPrecompressOptions,
  deps: IPrecompressDeps,
): IPrecompressReport {
  const extensions = (options.extensions ?? PRECOMPRESS_EXTENSIONS).map((ext) =>
    (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase(),
  );
  const encodings = options.encodings ?? ['br', 'gz'];
  const minBytes = options.minBytes ?? PRECOMPRESS_MIN_BYTES;
  const fail = (error: string): IPrecompressReport => ({
    passed: false,
    checked: 0,
    problems: [],
    errors: [error],
  });
  if (!Number.isFinite(minBytes) || minBytes < 0) {
    return fail(`precompress: minBytes must be zero or more, got ${String(minBytes)}`);
  }
  if (encodings.length === 0 || extensions.length === 0) {
    return fail('precompress: extensions and encodings must each name at least one value');
  }
  const listed = deps.listFiles(options.dir);
  if (listed === null) return fail(`${options.dir} cannot be read: run the build first`);
  const files = listed.map(toPosix).sort();
  const exclude = new Set((options.exclude ?? []).map(toPosix));
  const siblingSuffixes = encodings.map((encoding) => `.${encoding}`);

  const problems: IPrecompressProblem[] = [];
  let checked = 0;
  for (const file of files) {
    if (exclude.has(file)) continue;
    if (siblingSuffixes.some((suffix) => file.endsWith(suffix))) continue;
    const lower = file.toLowerCase();
    if (!extensions.some((ext) => lower.endsWith(ext))) continue;
    const original = deps.stat(options.dir, file);
    if (original === null || original.size < minBytes) continue;
    checked += 1;
    for (const encoding of encodings) {
      const sibling = `${file}.${encoding}`;
      const stat = deps.stat(options.dir, sibling);
      if (stat === null) {
        problems.push({
          file,
          encoding,
          kind: 'missing',
          message: `${sibling} is missing: run the precompress step after the build`,
        });
      } else if (stat.size === 0) {
        problems.push({
          file,
          encoding,
          kind: 'empty',
          message: `${sibling} is empty: the precompress step failed, run it again`,
        });
      } else if (stat.mtimeMs < original.mtimeMs) {
        problems.push({
          file,
          encoding,
          kind: 'stale',
          message: `${sibling} is older than ${file}: run the precompress step after the build`,
        });
      }
    }
  }
  if (checked === 0) {
    return {
      passed: false,
      checked,
      problems,
      errors: [
        `${options.dir} holds no file to check (extensions ${extensions.join(' ')}, at least ${minBytes} bytes): is it the build output?`,
      ],
    };
  }
  return { passed: problems.length === 0, checked, problems, errors: [] };
}

/** Console lines for a report: each failure, then a summary. */
export function formatPrecompressReport(
  report: IPrecompressReport,
  label = 'precompress',
): string[] {
  const lines = [
    ...report.errors.map((error) => `✗ ${error}`),
    ...report.problems.map((problem) => `✗ ${problem.message}`),
  ];
  lines.push(
    report.passed
      ? `${label}: passed (${report.checked} files, every sibling present)`
      : `${label}: failed (${report.errors.length + report.problems.length} problems over ${report.checked} files)`,
  );
  return lines;
}
