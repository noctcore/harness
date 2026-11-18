import { describe, expect, test } from 'bun:test';

import {
  isContainedPath,
  parseViteManifest,
  parseViteManifestText,
  readViteManifest,
  toPosix,
} from './manifest.js';
import { APP_MANIFEST } from './test-support.js';

describe('parseViteManifest', () => {
  test('reads every chunk with defaults for absent fields', () => {
    const { chunks, problems } = parseViteManifest(APP_MANIFEST);
    expect(problems).toEqual([]);
    expect(chunks.size).toBe(7);
    expect(chunks.get('index.html')).toEqual({
      key: 'index.html',
      file: 'assets/index.js',
      src: 'index.html',
      isEntry: true,
      isDynamicEntry: false,
      imports: ['_shared.js'],
      dynamicImports: ['src/routes/a.tsx', 'src/routes/b.tsx'],
      css: ['assets/index.css'],
      assets: [],
    });
    expect(chunks.get('_vendor.js')).toEqual({
      key: '_vendor.js',
      file: 'assets/vendor.js',
      isEntry: false,
      isDynamicEntry: false,
      imports: [],
      dynamicImports: [],
      css: [],
      assets: [],
    });
  });

  test('ignores unknown fields a later Vite may add', () => {
    const { chunks, problems } = parseViteManifest({
      'main.ts': { file: 'main.js', isEntry: true, integrity: 'sha384-x', future: { a: 1 } },
    });
    expect(problems).toEqual([]);
    expect(chunks.get('main.ts')?.file).toBe('main.js');
  });

  test('a manifest that is not an object is a named problem', () => {
    for (const raw of [null, [], 'x', 3]) {
      const result = parseViteManifest(raw, 'dist/.vite/manifest.json');
      expect(result.chunks.size).toBe(0);
      expect(result.problems).toEqual([
        'dist/.vite/manifest.json is not a JSON object of chunks: is it a Vite build manifest?',
      ]);
    }
  });

  test('an empty manifest is a problem, never a pass', () => {
    expect(parseViteManifest({}).problems[0]).toContain('lists no chunk');
  });

  test('an entry with no file, or one that is not an object, is a problem and is dropped', () => {
    const result = parseViteManifest({
      a: { src: 'a' },
      b: 'nope',
      c: { file: '' },
      d: { file: 'd.js' },
    });
    expect([...result.chunks.keys()]).toEqual(['d']);
    expect(result.problems).toEqual([
      'manifest: "a" has no "file" string',
      'manifest: "b" is not an object',
      'manifest: "c" has no "file" string',
    ]);
  });

  test('wrongly typed fields are named problems', () => {
    const result = parseViteManifest({
      x: {
        file: 'x.js',
        src: 1,
        name: false,
        isEntry: 'yes',
        isDynamicEntry: 1,
        imports: 'y',
        dynamicImports: [1],
        css: [''],
        assets: {},
      },
    });
    expect(result.chunks.size).toBe(0);
    expect(result.problems).toEqual([
      'manifest: "x".src must be a string',
      'manifest: "x".name must be a string',
      'manifest: "x".isEntry must be true or false',
      'manifest: "x".isDynamicEntry must be true or false',
      'manifest: "x".imports must be a list of non-empty strings',
      'manifest: "x".dynamicImports must be a list of non-empty strings',
      'manifest: "x".css must be a list of non-empty strings',
      'manifest: "x".assets must be a list of non-empty strings',
    ]);
  });

  test('a path outside the build directory is refused', () => {
    const result = parseViteManifest({
      a: { file: '../secret.js' },
      b: { file: 'b.js', css: ['/etc/x.css', 'ok.css'] },
      c: { file: 'C:\\x.js' },
    });
    expect([...result.chunks.keys()]).toEqual([]);
    expect(result.problems).toEqual([
      'manifest: "a".file names "../secret.js", outside the build directory',
      'manifest: "b".css names "/etc/x.css", outside the build directory',
      'manifest: "c".file names "C:\\x.js", outside the build directory',
    ]);
  });

  test('a static import of an unlisted key is a problem', () => {
    const result = parseViteManifest({ a: { file: 'a.js', imports: ['_gone.js'] } });
    expect(result.problems).toEqual([
      'manifest: "a" imports "_gone.js", which the manifest does not list',
    ]);
  });

  test('Windows separators in keys and paths read as /', () => {
    const result = parseViteManifest({
      'src\\routes\\a.tsx': {
        file: 'assets\\a.js',
        src: 'src\\routes\\a.tsx',
        css: ['assets\\a.css'],
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.chunks.get('src/routes/a.tsx')).toMatchObject({
      file: 'assets/a.js',
      src: 'src/routes/a.tsx',
      css: ['assets/a.css'],
    });
  });

  test('a manifest of css entries only reads fine', () => {
    const result = parseViteManifest({ 'style.css': { file: 'assets/style.css', isEntry: true } });
    expect(result.problems).toEqual([]);
    expect(result.chunks.get('style.css')?.isEntry).toBe(true);
  });
});

describe('helpers', () => {
  test('toPosix and isContainedPath', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
    expect(isContainedPath('assets/a.js')).toBe(true);
    expect(isContainedPath('a/../b')).toBe(false);
    expect(isContainedPath('')).toBe(false);
  });
});

describe('parseViteManifestText and readViteManifest', () => {
  test('text that is not JSON is a problem', () => {
    const result = parseViteManifestText('{nope', 'm.json');
    expect(result.problems[0]).toStartWith('m.json is not valid JSON (');
  });

  test('valid text parses', () => {
    expect(parseViteManifestText(JSON.stringify(APP_MANIFEST)).chunks.size).toBe(7);
  });

  test('a missing file says to build first', () => {
    const result = readViteManifest('dist/.vite/manifest.json', { readText: () => null });
    expect(result.problems).toEqual([
      'dist/.vite/manifest.json is missing: run the build first, with `build.manifest: true` in the Vite config',
    ]);
  });

  test('a read that throws is a problem', () => {
    const result = readViteManifest('m.json', {
      readText: () => {
        throw new Error('EACCES');
      },
    });
    expect(result.problems).toEqual(['m.json cannot be read: Error: EACCES']);
  });

  test('a readable file parses, labelled by its path', () => {
    const result = readViteManifest('m.json', { readText: () => '[]' });
    expect(result.problems[0]).toStartWith('m.json is not a JSON object');
  });
});
