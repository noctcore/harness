import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { nodePrecompressDeps } from './node.js';
import {
  BROTLI_QUALITY,
  BROTLI_SUFFIX,
  brotliBytes,
  checkPrecompressed,
  PRECOMPRESS_MIN_LENGTH,
  PRECOMPRESS_TYPES,
  precompressDir,
  precompressedBody,
  rootRelative,
} from './precompress.js';

/** Text a compressor can shrink, `length` bytes long. */
function text(length: number): Buffer {
  return Buffer.from(
    'export const value = "a row of the module";\n'.repeat(length).slice(0, length),
  );
}

describe('brotliBytes', () => {
  test('is brotli at the top quality, and decodes to the file', () => {
    const body = Buffer.from(
      Array.from(
        { length: 1500 },
        (_, index) =>
          `export const value${index} = compute(${index * 7919}, "${index.toString(36)}");`,
      ).join('\n'),
    );
    const packed = brotliBytes(body);
    expect(BROTLI_QUALITY).toBe(11);
    expect(brotliDecompressSync(packed).equals(body)).toBe(true);
    const lowQuality = brotliCompressSync(body, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    expect(packed.length).toBeLessThan(lowQuality.length);
    expect(packed.length).toBeLessThan(body.length);
  });
});

describe('precompressedBody', () => {
  test('compresses the kinds of file a server sends compressed, and no other', () => {
    for (const extension of Object.keys(PRECOMPRESS_TYPES)) {
      expect(precompressedBody(`assets/a.${extension}`, text(4000))).not.toBeNull();
    }
    for (const file of [
      'assets/font.woff2',
      'images/a.png',
      'assets/a.js.map',
      'LICENSE',
      'a.constructor',
    ]) {
      expect(precompressedBody(file, text(4000))).toBeNull();
    }
  });

  test('reads the extension in any case, and a path with backslashes as one under the root', () => {
    expect(precompressedBody('assets/A.JS', text(4000))).not.toBeNull();
    const never = { never: ['runtime.js'] };
    expect(precompressedBody('runtime.js', text(4000), never)).toBeNull();
    expect(precompressedBody('.\\runtime.js', text(4000), never)).toBeNull();
    expect(precompressedBody('./runtime.js', text(4000), never)).toBeNull();
    expect(rootRelative('.\\a\\b.js')).toBe('a/b.js');
  });

  test('leaves out a file under the length floor and one brotli cannot shrink', () => {
    expect(precompressedBody('a.js', text(PRECOMPRESS_MIN_LENGTH - 1))).toBeNull();
    expect(precompressedBody('a.js', text(1023), { minLength: 1024 })).toBeNull();
    expect(precompressedBody('a.js', text(1024), { minLength: 1024 })).not.toBeNull();
    const noise = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 97 + 13) % 251));
    expect(precompressedBody('a.js', noise)).toBeNull();
  });

  test('takes the kinds of file as an option', () => {
    expect(
      precompressedBody('a.wasm', text(4000), { types: { wasm: 'application/wasm' } }),
    ).not.toBeNull();
    expect(
      precompressedBody('a.js', text(4000), { types: { wasm: 'application/wasm' } }),
    ).toBeNull();
  });
});

describe('precompressDir and checkPrecompressed', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nc-web-precompress-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function put(file: string, body: Buffer | string): void {
    const target = join(dir, ...file.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  const options = { never: ['runtime.js'] };

  test('writes a .br next to every eligible file, and each decodes to its file', () => {
    put('index.html', text(3000));
    put('assets/index-a.js', text(9000));
    put('assets/font.woff2', text(9000));
    put('runtime.js', text(300));
    const run = precompressDir(dir, nodePrecompressDeps, options);
    expect(run).toEqual({ written: ['assets/index-a.js', 'index.html'], removed: [] });
    for (const file of run.written) {
      const copy = readFileSync(join(dir, `${file}${BROTLI_SUFFIX}`));
      expect(brotliDecompressSync(copy).equals(readFileSync(join(dir, file)))).toBe(true);
    }
    expect(existsSync(join(dir, `runtime.js${BROTLI_SUFFIX}`))).toBe(false);
    expect(existsSync(join(dir, 'assets', `font.woff2${BROTLI_SUFFIX}`))).toBe(false);
    expect(checkPrecompressed(dir, nodePrecompressDeps, options)).toEqual({
      lines: ['2 files with a precompressed copy'],
      problems: [],
    });
  });

  test('replaces a copy that predates its file and removes one whose file is gone or is not eligible', () => {
    put('assets/a.js', text(9000));
    put('assets/a.js.br', 'a stale copy of an older build');
    put('assets/gone.js.br', 'a copy of a file the build no longer has');
    put('runtime.js', text(300));
    put('runtime.js.br', 'a copy of the runtime file');
    expect(checkPrecompressed(dir, nodePrecompressDeps, options).problems).toEqual([
      'assets/a.js.br does not decode to assets/a.js: run the precompress step after the build',
      'assets/gone.js.br stands for a file that is gone or gets no copy: run the precompress step, which removes it',
      'runtime.js.br stands for a file that is gone or gets no copy: run the precompress step, which removes it',
    ]);
    const run = precompressDir(dir, nodePrecompressDeps, options);
    expect(run.removed).toEqual(['assets/a.js.br', 'assets/gone.js.br', 'runtime.js.br']);
    expect(
      brotliDecompressSync(readFileSync(join(dir, 'assets', 'a.js.br'))).equals(text(9000)),
    ).toBe(true);
    expect(existsSync(join(dir, 'assets', 'gone.js.br'))).toBe(false);
    expect(existsSync(join(dir, 'runtime.js.br'))).toBe(false);
    expect(checkPrecompressed(dir, nodePrecompressDeps, options).problems).toEqual([]);
  });

  test('gives the same files and bytes on a second run', () => {
    put('assets/a.js', text(9000));
    const first = precompressDir(dir, nodePrecompressDeps);
    const bytes = readFileSync(join(dir, 'assets', 'a.js.br'));
    const second = precompressDir(dir, nodePrecompressDeps);
    expect(second.written).toEqual(first.written);
    expect(second.removed).toEqual(['assets/a.js.br']);
    expect(readFileSync(join(dir, 'assets', 'a.js.br')).equals(bytes)).toBe(true);
  });

  test('a missing copy fails the check, and so does a directory with nothing to compress', () => {
    put('assets/a.js', text(9000));
    expect(checkPrecompressed(dir, nodePrecompressDeps).problems).toEqual([
      'assets/a.js.br is missing: run the precompress step after the build',
    ]);
    rmSync(join(dir, 'assets'), { recursive: true });
    put('photo.png', text(9000));
    expect(precompressDir(dir, nodePrecompressDeps).written).toEqual([]);
    expect(checkPrecompressed(dir, nodePrecompressDeps).problems).toEqual([
      `nothing under ${dir} gets a precompressed copy`,
    ]);
  });
});
