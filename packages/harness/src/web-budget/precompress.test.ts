import { describe, expect, test } from 'bun:test';

import {
  checkPrecompressed,
  formatPrecompressReport,
  type IFileStat,
  type IPrecompressDeps,
  PRECOMPRESS_MIN_BYTES,
} from './precompress.js';

function fakeDeps(files: Record<string, IFileStat> | null): IPrecompressDeps {
  return {
    listFiles: () => (files === null ? null : Object.keys(files)),
    stat: (_dir, file) => files?.[file] ?? null,
  };
}

const BIG = { size: 5000, mtimeMs: 100 };
const SIB = { size: 900, mtimeMs: 100 };

describe('checkPrecompressed', () => {
  test('every matching file with fresh siblings passes', () => {
    const report = checkPrecompressed(
      { dir: 'dist' },
      fakeDeps({
        'index.html': BIG,
        'index.html.br': SIB,
        'index.html.gz': SIB,
        'assets/app.js': BIG,
        'assets/app.js.br': { size: 800, mtimeMs: 200 },
        'assets/app.js.gz': SIB,
      }),
    );
    expect(report).toEqual({ passed: true, checked: 2, problems: [], errors: [] });
    expect(formatPrecompressReport(report)).toEqual([
      'precompress: passed (2 files, every sibling present)',
    ]);
  });

  test('a missing, empty or stale sibling fails with what to do', () => {
    const report = checkPrecompressed(
      { dir: 'dist' },
      fakeDeps({
        'a.js': BIG,
        'a.js.gz': SIB,
        'b.css': BIG,
        'b.css.br': { size: 0, mtimeMs: 100 },
        'b.css.gz': { size: 10, mtimeMs: 50 },
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.checked).toBe(2);
    expect(report.problems).toEqual([
      {
        file: 'a.js',
        encoding: 'br',
        kind: 'missing',
        message: 'a.js.br is missing: run the precompress step after the build',
      },
      {
        file: 'b.css',
        encoding: 'br',
        kind: 'empty',
        message: 'b.css.br is empty: the precompress step failed, run it again',
      },
      {
        file: 'b.css',
        encoding: 'gz',
        kind: 'stale',
        message: 'b.css.gz is older than b.css: run the precompress step after the build',
      },
    ]);
    expect(formatPrecompressReport(report, 'nginx').at(-1)).toBe(
      'nginx: failed (3 problems over 2 files)',
    );
  });

  test('small, non-matching and excluded files are ignored', () => {
    const report = checkPrecompressed(
      { dir: 'dist', exclude: ['assets\\skip.js'] },
      fakeDeps({
        'big.js': BIG,
        'big.js.br': SIB,
        'big.js.gz': SIB,
        'tiny.js': { size: PRECOMPRESS_MIN_BYTES - 1, mtimeMs: 1 },
        'photo.png': BIG,
        'assets/skip.js': BIG,
      }),
    );
    expect(report).toEqual({ passed: true, checked: 1, problems: [], errors: [] });
  });

  test('a file at exactly minBytes is checked', () => {
    const report = checkPrecompressed(
      { dir: 'dist', minBytes: 20 },
      fakeDeps({ 'a.js': { size: 20, mtimeMs: 1 } }),
    );
    expect(report.problems.map((p) => p.kind)).toEqual(['missing', 'missing']);
  });

  test('extensions and encodings are options; Windows paths read as /', () => {
    const deps: IPrecompressDeps = {
      listFiles: () => ['data\\x.GEOJSON', 'data\\x.GEOJSON.zst'],
      stat: (_dir, file) => (file.startsWith('data/x.GEOJSON') ? BIG : null),
    };
    const report = checkPrecompressed(
      { dir: 'dist', extensions: ['geojson'], encodings: ['zst'] },
      deps,
    );
    expect(report).toEqual({ passed: true, checked: 1, problems: [], errors: [] });
  });

  test('an empty or unmatched dir fails: nothing to check', () => {
    const report = checkPrecompressed({ dir: 'dist' }, fakeDeps({}));
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      'dist holds no file to check (extensions .css .html .js .json .mjs .svg .txt .wasm .webmanifest .xml, at least 1024 bytes): is it the build output?',
    ]);
    expect(formatPrecompressReport(report)).toHaveLength(2);
  });

  test('an unreadable dir and bad options fail', () => {
    expect(checkPrecompressed({ dir: 'dist' }, fakeDeps(null)).errors).toEqual([
      'dist cannot be read: run the build first',
    ]);
    expect(checkPrecompressed({ dir: 'd', minBytes: -1 }, fakeDeps({})).errors[0]).toContain(
      'minBytes',
    );
    expect(checkPrecompressed({ dir: 'd', encodings: [] }, fakeDeps({})).errors[0]).toContain(
      'at least one value',
    );
    expect(checkPrecompressed({ dir: 'd', extensions: [] }, fakeDeps({})).passed).toBe(false);
  });
});
