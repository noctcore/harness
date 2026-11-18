import { describe, expect, test } from 'bun:test';

import { buildGraph, staticClosure } from './graph.js';
import { parseViteManifest } from './manifest.js';
import { APP_SIZES, appManifest, SHELL_BYTES, sizeOfMap } from './test-support.js';

describe('staticClosure', () => {
  test('walks static imports only, css included, and survives a cycle', () => {
    const { chunks } = appManifest();
    const closure = staticClosure(chunks, 'src/routes/b.tsx');
    expect([...closure.keys].sort()).toEqual([
      '_cycle1.js',
      '_cycle2.js',
      '_vendor.js',
      'src/routes/b.tsx',
    ]);
    expect([...staticClosure(chunks, 'index.html').files].sort()).toEqual([
      'assets/index.css',
      'assets/index.js',
      'assets/shared.js',
    ]);
  });

  test('assets count only when asked', () => {
    const { chunks } = appManifest();
    expect(staticClosure(chunks, 'src/routes/a.tsx').files.has('assets/logo.png')).toBe(false);
    expect(staticClosure(chunks, 'src/routes/a.tsx', true).files.has('assets/logo.png')).toBe(true);
  });

  test('an unknown start is an empty closure', () => {
    expect(staticClosure(appManifest().chunks, 'nope').keys.size).toBe(0);
  });
});

describe('buildGraph', () => {
  test('the shell is every entry chunk closure, counted once', () => {
    const graph = buildGraph(appManifest(), sizeOfMap());
    expect(graph.problems).toEqual([]);
    expect(graph.shell.entries).toEqual(['index.html']);
    expect(graph.shell.bytes).toBe(SHELL_BYTES);
  });

  test('cold and beyond-shell weights, with a shared chunk counted once', () => {
    const graph = buildGraph(appManifest(), sizeOfMap());
    // a: a.js 30 + a.css 5 + vendor 200 + shared 50 (already in the shell).
    expect(graph.weightOf('src/routes/a.tsx')).toEqual({
      key: 'src/routes/a.tsx',
      cold: 285,
      beyondShell: 235,
    });
    // b: b.js 40 + vendor 200 + cycle 7 + 3.
    expect(graph.weightOf('src/routes/b.tsx')).toEqual({
      key: 'src/routes/b.tsx',
      cold: 250,
      beyondShell: 250,
    });
    expect(graph.weightOf('index.html')).toEqual({ key: 'index.html', cold: 170, beyondShell: 0 });
    expect(graph.weightOf('nope')).toBeNull();
    expect(graph.closureOf('nope')).toBeNull();
  });

  test('a chunk two imports share is counted once', () => {
    const manifest = parseViteManifest({
      'main.ts': { file: 'main.js', isEntry: true, imports: ['_a.js', '_b.js'] },
      '_a.js': { file: 'a.js', imports: ['_c.js'] },
      '_b.js': { file: 'b.js', imports: ['_c.js'] },
      '_c.js': { file: 'c.js' },
    });
    const graph = buildGraph(
      manifest,
      sizeOfMap({ 'main.js': 1, 'a.js': 2, 'b.js': 4, 'c.js': 8 }),
    );
    expect(graph.shell.bytes).toBe(15);
  });

  test('includeAssets adds referenced assets', () => {
    const graph = buildGraph(appManifest(), sizeOfMap(), { includeAssets: true });
    expect(graph.weightOf('src/routes/a.tsx')?.cold).toBe(1285);
  });

  test('shellEntries overrides isEntry, Windows keys included', () => {
    const graph = buildGraph(appManifest(), sizeOfMap(), { shellEntries: ['src\\routes\\b.tsx'] });
    expect(graph.shell.entries).toEqual(['src/routes/b.tsx']);
    expect(graph.shell.bytes).toBe(250);
    expect(graph.weightOf('src/routes/a.tsx')?.beyondShell).toBe(85);
  });

  test('a shell entry not in the manifest is a problem', () => {
    const graph = buildGraph(appManifest(), sizeOfMap(), { shellEntries: ['gone.html'] });
    expect(graph.problems).toEqual([
      'shell entry "gone.html" is not in the manifest: fix shellEntries',
    ]);
  });

  test('a manifest with no entry is a problem', () => {
    const graph = buildGraph(
      parseViteManifest({ 'a.ts': { file: 'a.js' } }),
      sizeOfMap({ 'a.js': 1 }),
    );
    expect(graph.problems).toEqual(['the manifest has no entry chunk: pass shellEntries']);
  });

  test('a file missing from the build dir is a problem', () => {
    const sizes = { ...APP_SIZES } as Record<string, number>;
    delete sizes['assets/vendor.js'];
    sizes['assets/b.js'] = Number.NaN;
    const graph = buildGraph(appManifest(), sizeOfMap(sizes));
    expect(graph.problems).toEqual([
      'assets/b.js is in the manifest but not in the build directory: rebuild',
      'assets/vendor.js is in the manifest but not in the build directory: rebuild',
    ]);
  });
});
