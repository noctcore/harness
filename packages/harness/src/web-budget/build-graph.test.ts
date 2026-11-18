import { describe, expect, test } from 'bun:test';

import {
  buildProblems,
  chunksOfSource,
  documentScripts,
  entryFiles,
  isContainedPath,
  loadRoots,
  parseManifest,
  staticClosure,
} from './build-graph.js';

const MANIFEST = JSON.stringify({
  'index.html': {
    file: 'assets/index-a.js',
    isEntry: true,
    imports: ['_vendor-b.js'],
    dynamicImports: ['src/routes/home.tsx'],
    css: ['assets/index-c.css'],
  },
  '_vendor-b.js': { file: 'assets/vendor-b.js', imports: ['_runtime-d.js'] },
  '_runtime-d.js': { file: 'assets/runtime-d.js' },
  'src/routes/home.tsx': {
    file: 'assets/home-e.js',
    isDynamicEntry: true,
    imports: ['_vendor-b.js'],
  },
  'src/logo.svg': { file: 'assets/logo-f.svg' },
});

const SCRIPTS = [
  'assets/index-a.js',
  'assets/vendor-b.js',
  'assets/runtime-d.js',
  'assets/home-e.js',
];

describe('parseManifest', () => {
  test('lists every script chunk with the files it imports, and no other asset', () => {
    const graph = parseManifest(MANIFEST);
    expect([...graph.chunks.keys()].sort()).toEqual([...SCRIPTS].sort());
    expect(graph.chunks.get('assets/index-a.js')).toEqual({
      file: 'assets/index-a.js',
      source: 'index.html',
      isEntry: true,
      imports: ['assets/vendor-b.js'],
      dynamicImports: ['assets/home-e.js'],
    });
    expect(entryFiles(graph)).toEqual(['assets/index-a.js']);
  });

  test('ignores fields it does not read, such as ones a later Vite adds', () => {
    const graph = parseManifest(
      JSON.stringify({
        a: { file: 'a.js', isEntry: true, integrity: 'sha384-x', future: { n: 1 } },
      }),
    );
    expect(graph.chunks.get('a.js')?.isEntry).toBe(true);
  });

  test('refuses a manifest that imports a chunk it does not list, statically or dynamically', () => {
    expect(() =>
      parseManifest(JSON.stringify({ a: { file: 'assets/a.js', imports: ['gone'] } })),
    ).toThrow('manifest: "a" imports "gone", which is not listed');
    expect(() =>
      parseManifest(JSON.stringify({ a: { file: 'assets/a.js', dynamicImports: ['gone'] } })),
    ).toThrow('which is not listed');
  });

  test('refuses what is not a manifest of scripts', () => {
    expect(() => parseManifest('{nope', 'dist/.vite/manifest.json')).toThrow(
      'dist/.vite/manifest.json: not JSON (',
    );
    expect(() => parseManifest('[]')).toThrow('not an object');
    expect(() => parseManifest('null')).toThrow('not an object');
    expect(() => parseManifest('{}')).toThrow('lists no script chunk');
    expect(() => parseManifest(JSON.stringify({ a: {} }))).toThrow('"a" names no file');
    expect(() => parseManifest(JSON.stringify({ a: 'x' }))).toThrow('"a" names no file');
    expect(() => parseManifest(JSON.stringify({ a: { file: '' } }))).toThrow('names no file');
    expect(() => parseManifest(JSON.stringify({ a: { file: 'a.js', imports: 'b' } }))).toThrow(
      '"a" has a imports that is not a list of keys',
    );
    expect(() =>
      parseManifest(JSON.stringify({ a: { file: 'a.js', dynamicImports: [1] } })),
    ).toThrow('dynamicImports that is not a list');
    expect(() => parseManifest(JSON.stringify({ a: { file: 'a.js', isEntry: 'yes' } }))).toThrow(
      'isEntry that is not true or false',
    );
    expect(() => parseManifest(JSON.stringify({ a: { file: 'assets/a.css' } }))).toThrow(
      'lists no script chunk',
    );
  });

  test('refuses a file outside the build directory', () => {
    for (const file of ['../a.js', '/etc/a.js', 'C:\\a.js', 'assets/../../a.js']) {
      expect(() => parseManifest(JSON.stringify({ a: { file } }))).toThrow(
        'outside the build directory',
      );
    }
  });

  test('reads Windows separators in keys and files as /', () => {
    const graph = parseManifest(
      JSON.stringify({
        'src\\main.ts': { file: 'assets\\main.js', isEntry: true, imports: ['src\\util.ts'] },
        'src\\util.ts': { file: 'assets\\util.js' },
      }),
    );
    expect(graph.chunks.get('assets/main.js')).toMatchObject({
      source: 'src/main.ts',
      imports: ['assets/util.js'],
    });
  });
});

describe('isContainedPath', () => {
  test('a relative path with no .. segment', () => {
    expect(isContainedPath('assets/a.js')).toBe(true);
    expect(isContainedPath('a..b.js')).toBe(true);
    expect(isContainedPath('')).toBe(false);
  });
});

describe('staticClosure', () => {
  test('follows static imports to the end and never a dynamic one', () => {
    const graph = parseManifest(MANIFEST);
    expect([...staticClosure(graph, ['assets/index-a.js'])].sort()).toEqual([
      'assets/index-a.js',
      'assets/runtime-d.js',
      'assets/vendor-b.js',
    ]);
  });

  test('ends on chunks that import each other', () => {
    const graph = parseManifest(
      JSON.stringify({ a: { file: 'a.js', imports: ['b'] }, b: { file: 'b.js', imports: ['a'] } }),
    );
    expect([...staticClosure(graph, ['a.js'])].sort()).toEqual(['a.js', 'b.js']);
  });
});

describe('chunksOfSource and loadRoots', () => {
  test('a module split into several chunks by a query is one source', () => {
    const graph = parseManifest(
      JSON.stringify({
        'index.html': { file: 'i.js', isEntry: true, dynamicImports: ['src/p.tsx?split=a'] },
        'src/p.tsx?split=a': { file: 'p-a.js' },
        'src/p.tsx?split=b': { file: 'p-b.js' },
      }),
    );
    expect(chunksOfSource(graph, 'src/p.tsx')).toEqual(['p-a.js', 'p-b.js']);
    expect(chunksOfSource(graph, 'src\\p.tsx')).toEqual(['p-a.js', 'p-b.js']);
    expect(chunksOfSource(graph, 'src/q.tsx')).toEqual([]);
    expect(loadRoots(graph).sort()).toEqual(['i.js', 'p-a.js']);
  });
});

describe('buildProblems', () => {
  const graph = parseManifest(MANIFEST);
  const document = ['runtime.js', 'assets/index-a.js', 'assets/vendor-b.js'];

  test('has none for the directory of the one build the manifest describes', () => {
    expect(buildProblems(graph, SCRIPTS, document)).toEqual([]);
  });

  test('names a script another build left in the directory', () => {
    expect(buildProblems(graph, [...SCRIPTS, 'assets/index-OTHER.js'], document)).toEqual([
      'the directory holds scripts this build did not emit (another build wrote here): assets/index-OTHER.js',
    ]);
  });

  test('names a chunk of the manifest the directory lacks', () => {
    expect(buildProblems(graph, SCRIPTS.slice(1), document)).toEqual([
      'the manifest lists chunks the directory does not hold: assets/index-a.js',
    ]);
  });

  test('names an entry the document does not load', () => {
    expect(buildProblems(graph, SCRIPTS, ['assets/index-OLD.js'], 'app.html')).toEqual([
      'app.html does not load the entry the manifest lists: assets/index-a.js',
    ]);
  });

  test('says so when the manifest has no entry at all', () => {
    const noEntry = parseManifest(JSON.stringify({ a: { file: 'assets/a.js' } }));
    expect(buildProblems(noEntry, ['assets/a.js'], [])).toEqual([
      'the manifest lists no entry chunk',
    ]);
  });

  test('reads Windows separators in the script list as /', () => {
    expect(
      buildProblems(
        graph,
        SCRIPTS.map((file) => file.replace('/', '\\')),
        document,
      ),
    ).toEqual([]);
  });
});

describe('documentScripts', () => {
  test('lists the local scripts and module preloads as paths inside the build', () => {
    const html = [
      '<script src="./runtime.js"></script>',
      '<script type="module" crossorigin src="./assets/index-a.js"></script>',
      '<link rel="modulepreload" crossorigin href="./assets/vendor-b.js">',
      '<link rel="stylesheet" crossorigin href="./assets/index-c.css">',
    ].join('\n');
    expect(documentScripts(html)).toEqual([
      'runtime.js',
      'assets/index-a.js',
      'assets/vendor-b.js',
    ]);
    expect(
      documentScripts(
        '<script src="/assets/index-a.js?v=1"></script><script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script>',
      ),
    ).toEqual(['assets/index-a.js']);
  });
});
