import { describe, expect, test } from 'bun:test';

import { type IBuildGraph, parseManifest } from './build-graph.js';
import {
  checkDynamicImports,
  countDynamicImports,
  describeDeadImport,
  findDeadDynamicImports,
} from './dead-dynamic-imports.js';

const manifest = (chunks: Record<string, object>): IBuildGraph =>
  parseManifest(JSON.stringify(chunks));

describe('findDeadDynamicImports', () => {
  test('is alive when nothing imports the target statically: it has its own chunk', () => {
    const graph = manifest({
      'main.js': { file: 'assets/index.js', isEntry: true, dynamicImports: ['heavy.js'] },
      'heavy.js': { file: 'assets/heavy.js', isDynamicEntry: true },
    });
    expect(countDynamicImports(graph)).toBe(1);
    expect(findDeadDynamicImports(graph)).toEqual([]);
    expect(checkDynamicImports(graph).problems).toEqual([]);
  });

  test('is dead when the bundler folded the target into the importing chunk', () => {
    // What Vite writes when the module that loads heavy.js lazily also imports it statically.
    const graph = manifest({
      'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['index.html'] },
    });
    expect(findDeadDynamicImports(graph)).toEqual([
      { importer: 'assets/index.js', target: 'assets/index.js', reason: 'same-chunk' },
    ]);
  });

  test('is dead when the chunk that loads it imports the target chunk statically', () => {
    const graph = manifest({
      'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['panel.js'] },
      'panel.js': {
        file: 'assets/panel.js',
        imports: ['index.html'],
        dynamicImports: ['index.html'],
      },
    });
    expect(findDeadDynamicImports(graph)).toEqual([
      { importer: 'assets/panel.js', target: 'assets/index.js', reason: 'static' },
    ]);
    const report = checkDynamicImports(graph);
    expect(report.lines).toEqual(['2 dynamic imports, 1 that split nothing']);
    expect(report.problems).toEqual([
      'assets/panel.js (panel.js) loads assets/index.js (index.html) with import(), which that chunk also imports statically',
    ]);
  });

  test('finds a target the importer reaches through another chunk', () => {
    const graph = manifest({
      'index.html': { file: 'index.js', isEntry: true, dynamicImports: ['list'] },
      list: { file: 'list.js', imports: ['button'], dynamicImports: ['motion'] },
      button: { file: 'button.js', imports: ['motion'] },
      motion: { file: 'motion.js' },
    });
    expect(findDeadDynamicImports(graph)).toEqual([
      { importer: 'list.js', target: 'motion.js', reason: 'static' },
    ]);
  });

  test('finds a target the page entry already loads', () => {
    const graph = manifest({
      'index.html': {
        file: 'index.js',
        isEntry: true,
        imports: ['i18n'],
        dynamicImports: ['page'],
      },
      i18n: { file: 'i18n.js' },
      page: { file: 'page.js', dynamicImports: ['i18n'] },
    });
    const dead = findDeadDynamicImports(graph);
    expect(dead).toEqual([{ importer: 'page.js', target: 'i18n.js', reason: 'entry' }]);
    expect(describeDeadImport(graph, dead[0]!)).toBe(
      'page.js (page) loads i18n.js (i18n) with import(), which the page entry imports statically, so every page has loaded it',
    );
  });

  test('finds a target that every chunk loading the importer has already loaded', () => {
    // The entry lazily loads a route; the route imports a panel and a helper
    // statically; the panel loads the helper with import(). The helper is
    // there before the panel can run, though the panel never imports it.
    const graph = manifest({
      'index.html': { file: 'index.js', isEntry: true, dynamicImports: ['route'] },
      route: { file: 'route.js', imports: ['panel', 'helper'] },
      panel: { file: 'panel.js', dynamicImports: ['helper'] },
      helper: { file: 'helper.js' },
    });
    const dead = findDeadDynamicImports(graph);
    expect(dead).toEqual([{ importer: 'panel.js', target: 'helper.js', reason: 'loaded-with' }]);
    expect(describeDeadImport(graph, dead[0]!)).toBe(
      'panel.js (panel) loads helper.js (helper) with import(), which is a static import of every chunk that loads the first one, so it is always loaded already',
    );
  });

  test('leaves that target alone when one chunk loads the importer without it', () => {
    const graph = manifest({
      'index.html': { file: 'index.js', isEntry: true, dynamicImports: ['route', 'other'] },
      route: { file: 'route.js', imports: ['panel', 'helper'] },
      other: { file: 'other.js', imports: ['panel'] },
      panel: { file: 'panel.js', dynamicImports: ['helper'] },
      helper: { file: 'helper.js' },
    });
    expect(findDeadDynamicImports(graph)).toEqual([]);
  });

  test('leaves alone a chunk two lazy chunks share', () => {
    const graph = manifest({
      'index.html': { file: 'index.js', isEntry: true, dynamicImports: ['a', 'b'] },
      a: { file: 'a.js', dynamicImports: ['shared'] },
      b: { file: 'b.js', imports: ['shared'] },
      shared: { file: 'shared.js' },
    });
    expect(findDeadDynamicImports(graph)).toEqual([]);
  });

  test('names an unknown chunk as unknown', () => {
    const graph = manifest({ a: { file: 'a.js', isEntry: true } });
    expect(describeDeadImport(graph, { importer: 'x.js', target: 'a.js', reason: 'static' })).toBe(
      'x.js (unknown) loads a.js (a) with import(), which that chunk also imports statically',
    );
  });
});

describe('checkDynamicImports', () => {
  const graph = manifest({ 'index.html': { file: 'i.js', isEntry: true } });

  test('fails on a build with no dynamic import at all: it read nothing', () => {
    expect(checkDynamicImports(graph)).toEqual({
      lines: ['0 dynamic imports, 0 that split nothing'],
      problems: ['the build lists no dynamic import, so nothing was checked'],
    });
  });

  test('passes it for an app that says it splits nothing', () => {
    expect(checkDynamicImports(graph, { requireDynamicImports: false }).problems).toEqual([]);
  });
});
