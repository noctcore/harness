import { describe, expect, test } from 'bun:test';

import { findDeadImports } from './dead-imports.js';
import { buildGraph } from './graph.js';
import { parseViteManifest } from './manifest.js';
import { appManifest, sizeOfMap } from './test-support.js';

describe('findDeadImports', () => {
  test('a healthy app has none', () => {
    const report = findDeadImports(buildGraph(appManifest(), sizeOfMap()));
    expect(report).toEqual({ dead: [], allowed: [], problems: [] });
  });

  const manifest = parseViteManifest({
    'main.ts': {
      file: 'main.js',
      isEntry: true,
      imports: ['_shared.js'],
      dynamicImports: ['_shared.js', 'src/lazy.ts', 'src/gone.ts'],
    },
    '_shared.js': { file: 'shared.js' },
    'src/lazy.ts': {
      file: 'lazy.js',
      isDynamicEntry: true,
      imports: ['_util.js'],
      dynamicImports: ['_util.js', '_shared.js', 'src/other.ts'],
    },
    '_util.js': { file: 'util.js' },
    'src/other.ts': { file: 'other.js', isDynamicEntry: true },
  });
  const graph = buildGraph(
    manifest,
    sizeOfMap({ 'main.js': 1, 'shared.js': 1, 'lazy.js': 1, 'util.js': 1, 'other.js': 1 }),
  );

  test('reports static, shell and missing targets', () => {
    const report = findDeadImports(graph);
    expect(
      report.dead.map(({ importer, target, kind, why }) => ({ importer, target, kind, why })),
    ).toEqual([
      { importer: 'main.ts', target: '_shared.js', kind: 'dead', why: 'static' },
      { importer: 'main.ts', target: 'src/gone.ts', kind: 'broken', why: 'missing' },
      { importer: 'src/lazy.ts', target: '_shared.js', kind: 'dead', why: 'shell' },
      { importer: 'src/lazy.ts', target: '_util.js', kind: 'dead', why: 'static' },
    ]);
    expect(report.dead[1]?.message).toBe(
      '"main.ts" imports "src/gone.ts" with import(), but the manifest has no such chunk: rebuild, or fix the import',
    );
    expect(report.dead[2]?.message).toContain('the shell already loads it');
    expect(report.dead[3]?.message).toContain('already loads it statically');
  });

  test('an allow entry with a reason moves the pair to allowed', () => {
    const report = findDeadImports(graph, {
      allow: [{ importer: 'src\\lazy.ts', target: '_util.js', reason: 'kept for the plugin API' }],
    });
    expect(report.dead).toHaveLength(3);
    expect(report.allowed).toEqual([
      expect.objectContaining({
        importer: 'src/lazy.ts',
        target: '_util.js',
        reason: 'kept for the plugin API',
      }),
    ]);
    expect(report.problems).toEqual([]);
  });

  test('an allow entry needs a reason, and one that matches nothing is stale', () => {
    const report = findDeadImports(graph, {
      allow: [
        { importer: 'main.ts', target: 'src/gone.ts', reason: '  ' },
        { importer: 'main.ts', target: 'src/other.ts', reason: 'old' },
      ],
    });
    expect(report.dead).toHaveLength(4);
    expect(report.problems).toEqual([
      'allowed dead import "main.ts" -> "src/gone.ts" has no reason: write one',
      'allowed dead import "main.ts" -> "src/other.ts" is not dead or broken any more: remove it from the allow list',
    ]);
  });
});
