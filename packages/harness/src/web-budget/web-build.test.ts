import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { checkDynamicImports } from './dead-dynamic-imports.js';
import { checkFileBudgets, parseFileBudgets } from './file-budget.js';
import { newerSourceRoots } from './freshness.js';
import { nodeNewestMtime, nodeReadText, nodeWebBuildDeps } from './node.js';
import { brotliBytes } from './precompress.js';
import { headroomFromArgv, type IBudgetIo, runBudget } from './run-budget.js';
import { parseServedEncoding } from './served-encoding.js';
import { type IWebBuildOptions, loadWebBuild, measuredSize } from './web-build.js';

const NGINX_CONF =
  'server {\n    gzip on;\n    gzip_proxied any;\n    gzip_comp_level 6;\n    gzip_types application/javascript text/css;\n}\n';
const HTML = [
  '<script src="./runtime.js"></script>',
  '<script type="module" crossorigin src="./assets/index-a.js"></script>',
  '<link rel="modulepreload" crossorigin href="./assets/vendor-b.js">',
  '<link rel="stylesheet" crossorigin href="./assets/index-c.css">',
].join('\n');
const MANIFEST = {
  'index.html': {
    file: 'assets/index-a.js',
    isEntry: true,
    imports: ['_vendor-b.js'],
    dynamicImports: ['src/routes/home.tsx'],
  },
  '_vendor-b.js': { file: 'assets/vendor-b.js' },
  'src/routes/home.tsx': { file: 'assets/home-d.js', imports: ['_vendor-b.js'] },
};
/** Script text of a given length. */
const noise = (length: number): string =>
  Array.from({ length }, (_, index) => String.fromCharCode(33 + ((index * 7919) % 89))).join('');

let root = '';

/** An app directory under the fixture root with a build in it; returns the build directory. */
function app(name: string, files: Readonly<Record<string, string>> = {}): string {
  const dist = join(root, name, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, '.vite'), { recursive: true });
  mkdirSync(join(root, name, 'src'), { recursive: true });
  const all: Record<string, string> = {
    'index.html': HTML,
    '.vite/manifest.json': JSON.stringify(MANIFEST),
    'assets/index-a.js': noise(3000),
    'assets/vendor-b.js': noise(5000),
    'assets/home-d.js': noise(1000),
    'assets/index-c.css': noise(2000),
    'assets/logo.svg': noise(100),
    ...files,
  };
  for (const [file, content] of Object.entries(all))
    writeFileSync(join(dist, ...file.split('/')), content);
  return dist;
}

interface IRun {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

const SERVED = parseServedEncoding(NGINX_CONF);

function run(
  dist: string,
  options: Partial<IWebBuildOptions> = {},
  check: Parameters<typeof runBudget>[3] = (build) => checkDynamicImports(build.graph),
): IRun {
  const out: string[] = [];
  const err: string[] = [];
  const io: IBudgetIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = runBudget(
    'budget',
    io,
    () =>
      loadWebBuild(
        {
          distDir: dist,
          sourceRoots: [join(dist, '..', 'src')],
          weigh: { encoding: SERVED },
          buildHint: 'Build first: `bun run build`.',
          ...options,
        },
        nodeWebBuildDeps,
      ),
    check,
  );
  return { code, out, err };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nc-web-budget-build-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadWebBuild with runBudget', () => {
  test('measures a fresh build, says in which encoding, and exits 0', () => {
    expect(run(app('fresh'))).toEqual({
      code: 0,
      out: [
        '[budget] weighed as served: gzip level 6',
        '[budget] 1 dynamic imports, 0 that split nothing',
        '[budget] OK',
      ],
      err: [],
    });
  });

  test('weighs each file as the configuration serves it, not as it is on disk', () => {
    const budgets = parseFileBudgets(
      JSON.stringify([{ name: 'scripts', path: 'assets/*.js', limit: '9.5 kB' }]),
    );
    const result = run(app('weighed'), {}, (build) =>
      checkFileBudgets(budgets, build.assets, build.graph, build.sizeOf),
    );
    const served = [3000, 5000, 1000]
      .map((length) => gzipSync(Buffer.from(noise(length)), { level: 6 }).length)
      .reduce((sum, bytes) => sum + bytes, 0);
    expect(served).toBeLessThan(9000);
    expect(result.code).toBe(0);
    expect(result.out[1]).toBe(
      `[budget] assets/*.js: ${(served / 1000).toFixed(2)} kB across 3 files (limit 9.50 kB)`,
    );
  });

  test('lists scripts and stylesheets of the assets directory, and weighs raw, gzip or brotli without a configuration', () => {
    const dist = app('measures');
    const build = loadWebBuild({ distDir: dist, weigh: 'raw' }, nodeWebBuildDeps);
    expect(build.assets).toEqual([
      'assets/home-d.js',
      'assets/index-a.js',
      'assets/index-c.css',
      'assets/vendor-b.js',
    ]);
    expect(build.encoding).toBe('as stored');
    expect(build.sizeOf('assets/index-a.js')).toBe(3000);
    expect(build.sizeOf('assets/index-a.js')).toBe(3000);
    const gzip = loadWebBuild({ distDir: dist }, nodeWebBuildDeps);
    expect(gzip.encoding).toBe('gzip level 9');
    expect(gzip.sizeOf('assets/vendor-b.js')).toBe(
      gzipSync(Buffer.from(noise(5000)), { level: 9 }).length,
    );
    const brotli = loadWebBuild({ distDir: dist, weigh: 'brotli' }, nodeWebBuildDeps);
    expect(brotli.encoding).toBe('brotli quality 11');
    expect(brotli.sizeOf('assets/vendor-b.js')).toBe(brotliBytes(Buffer.from(noise(5000))).length);
    expect(measuredSize(Buffer.from('abc'), 'raw')).toBe(3);
  });

  test('exits 1 with each reason when the check finds problems', () => {
    const result = run(app('over'), {}, () => ({ lines: ['measured'], problems: ['one', 'two'] }));
    expect(result.code).toBe(1);
    expect(result.err).toEqual(['[budget] FAILED one', '[budget] FAILED two']);
    expect(result.out).not.toContain('[budget] OK');
  });

  test('refuses a directory with no build, and one with no manifest', () => {
    const none = run(join(root, 'nowhere', 'dist'));
    expect(none.code).toBe(1);
    expect(none.err[0]).toMatch(/^\[budget\] No build at .+ Build first: `bun run build`\.$/u);

    const dist = app('no-manifest');
    rmSync(join(dist, '.vite'), { recursive: true });
    const result = run(dist);
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('has no .vite/manifest.json: build with `build.manifest` set');
    expect(run(dist, { buildHint: undefined }).err[0]).toEndWith('Run the build first.');
  });

  test('reads a manifest at another path, a document of another name and another assets directory', () => {
    const dist = app('custom', { 'app.html': HTML.replaceAll('assets/', 'static/') });
    mkdirSync(join(dist, 'static'));
    const manifest = JSON.stringify(MANIFEST).replaceAll('assets/', 'static/');
    writeFileSync(join(dist, 'bundle.json'), manifest);
    for (const [file, length] of [
      ['index-a.js', 3000],
      ['vendor-b.js', 5000],
      ['home-d.js', 1000],
    ] as const) {
      writeFileSync(join(dist, 'static', file), noise(length));
    }
    const build = loadWebBuild(
      { distDir: dist, manifestFile: 'bundle.json', documentFile: 'app.html', assetsDir: 'static' },
      nodeWebBuildDeps,
    );
    expect(build.assets).toEqual(['static/home-d.js', 'static/index-a.js', 'static/vendor-b.js']);
  });

  test('refuses a build older than its sources, and names them', () => {
    const dist = app('stale');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dist, 'index.html'), past, past);
    writeFileSync(join(dist, '..', 'src', 'main.tsx'), 'export {};\n');
    const result = run(dist);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err[0]).toMatch(
      /is older than its sources \(.+\/stale\/src\), so this would weigh a build of a different commit/u,
    );
  });

  test('does not compare times when told to skip it, as under CI where the build runs right before', () => {
    const dist = app('stale-ci');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dist, 'index.html'), past, past);
    writeFileSync(join(dist, '..', 'src', 'main.tsx'), 'export {};\n');
    expect(run(dist, { skipFreshness: true }).code).toBe(0);
    expect(run(dist, { sourceRoots: [] }).code).toBe(0);
  });

  test('refuses a directory another build left chunks in, even with freshness skipped', () => {
    const dist = app('mixed', { 'assets/index-OTHER.js': noise(3000) });
    const result = run(dist, { skipFreshness: true });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(
      'is not one build: the directory holds scripts this build did not emit (another build wrote here): assets/index-OTHER.js',
    );
  });

  test('refuses a document that loads another build than the manifest describes', () => {
    const dist = app('other-entry', { 'index.html': HTML.replace('index-a.js', 'index-OLD.js') });
    const result = run(dist);
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('index.html does not load the entry the manifest lists');
  });

  test('exits 1 when the manifest is not one', () => {
    const dist = app('bad-manifest', { '.vite/manifest.json': '{"a":{"file":"../x.js"}}' });
    const result = run(dist);
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(
      '.vite/manifest.json: "a" names "../x.js", outside the build directory',
    );
  });

  test('exits 1 when the check throws, as on a configuration the model cannot read', () => {
    const result = run(app('brotli'), {}, () => {
      parseServedEncoding('server {\n    brotli on;\n}\n');
      return { lines: [], problems: [] };
    });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('do not know how brotli changes what is served');
    const thrown = run(app('thrown'), {}, () => {
      throw 'plain';
    });
    expect(thrown.err).toEqual(['[budget] plain']);
  });
});

describe('headroomFromArgv', () => {
  test('reads a percentage, and refuses one that is not', () => {
    expect(headroomFromArgv([])).toBeUndefined();
    expect(headroomFromArgv(['--headroom', '2.5'])).toBe(2.5);
    for (const argv of [
      ['--headroom'],
      ['--headroom', ''],
      ['--headroom', 'ten'],
      ['--headroom', '-1'],
    ]) {
      expect(() => headroomFromArgv(argv)).toThrow('is not a percentage');
    }
  });
});

describe('freshness', () => {
  test('names the roots newer than the build, and skips a root that does not exist', () => {
    const times: Record<string, number | null> = { a: 100, b: 300, c: null };
    expect(newerSourceRoots(200, ['a', 'b', 'c'], (root) => times[root] ?? null)).toEqual(['b']);
  });

  test('walks a source tree for its newest file, skipping build and dependency folders', () => {
    const dir = join(root, 'walk');
    mkdirSync(join(dir, 'lib', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'deep', 'a.ts'), 'a');
    writeFileSync(join(dir, 'node_modules', 'b.js'), 'b');
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(dir, 'lib', 'deep', 'a.ts'), old, old);
    const newest = nodeNewestMtime()(dir) as number;
    expect(Math.abs(newest - old.getTime())).toBeLessThan(1000);
    expect(nodeNewestMtime([])(dir) as number).toBeGreaterThan(newest);
    expect(nodeNewestMtime()(join(root, 'nowhere'))).toBeNull();
  });
});

describe('nodeReadText', () => {
  test('reads a file, null when it is missing, throws on another error', () => {
    const file = join(root, 'budgets.json');
    writeFileSync(file, '[]');
    expect(nodeReadText(file)).toBe('[]');
    expect(nodeReadText(join(root, 'gone.json'))).toBeNull();
    expect(() => nodeReadText(root)).toThrow();
  });
});
