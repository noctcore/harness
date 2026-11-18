import { describe, expect, test } from 'bun:test';

import * as wb from './web-budget.js';

describe('@noctcore/harness/web-budget', () => {
  test('exports the manifest, graph, budget, dead-import, report, precompress and node entry points', () => {
    for (const name of [
      'parseViteManifest',
      'parseViteManifestText',
      'readViteManifest',
      'buildGraph',
      'staticClosure',
      'parseWebBudgets',
      'checkBudgets',
      'matchesPattern',
      'findDeadImports',
      'checkWebBudget',
      'formatWebBudgetReport',
      'formatWebBudgetSummary',
      'formatBytes',
      'reportIsFresh',
      'checkPrecompressed',
      'formatPrecompressReport',
      'nodeSizeOf',
      'nodeReadText',
    ] as const) {
      expect(typeof wb[name]).toBe('function');
    }
    expect(wb.PRECOMPRESS_MIN_BYTES).toBe(1024);
    expect(wb.PRECOMPRESS_EXTENSIONS).toContain('.js');
    expect(typeof wb.nodeManifestDeps.readText).toBe('function');
    expect(typeof wb.nodePrecompressDeps.listFiles).toBe('function');
  });

  test('exposes nothing that writes or raises a budget', () => {
    const names = Object.keys(wb).map((name) => name.toLowerCase());
    for (const banned of ['write', 'raise', 'update', 'tolerance', 'override', 'bump']) {
      expect(names.filter((name) => name.includes(banned))).toEqual([]);
    }
  });
});
