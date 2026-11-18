import { describe, expect, test } from 'bun:test';

import * as wb from './web-budget.js';

describe('@noctcore/harness/web-budget', () => {
  test('exports the graph, budget, dead-import, served-encoding, precompress, build and node entry points', () => {
    for (const name of [
      'parseManifest',
      'staticClosure',
      'entryFiles',
      'chunksOfSource',
      'loadRoots',
      'buildProblems',
      'documentScripts',
      'checkRoutes',
      'unbuilt',
      'parseFileBudgets',
      'matchFiles',
      'ownChunks',
      'checkFileBudgets',
      'findDeadDynamicImports',
      'countDynamicImports',
      'describeDeadImport',
      'checkDynamicImports',
      'nginxStatements',
      'parseServedEncoding',
      'servedMimeType',
      'servedCompressible',
      'servedVary',
      'servedSize',
      'describeEncoding',
      'brotliBytes',
      'precompressedBody',
      'precompressDir',
      'checkPrecompressed',
      'newerSourceRoots',
      'loadWebBuild',
      'measuredSize',
      'runBudget',
      'headroomFromArgv',
      'asKb',
      'nodeReadText',
      'nodeNewestMtime',
    ] as const) {
      expect(typeof wb[name]).toBe('function');
    }
    expect(wb.DEFAULT_MANIFEST_FILE).toBe('.vite/manifest.json');
    expect(wb.BYTES_PER_KB).toBe(1000);
    expect([wb.BROTLI_QUALITY, wb.BROTLI_SUFFIX, wb.PRECOMPRESS_MIN_LENGTH]).toEqual([
      11,
      '.br',
      20,
    ]);
    expect(wb.BROWSER_BEHIND_PROXY).toEqual({ viaProxy: true, acceptsBrotli: true });
    expect(Object.keys(wb.SERVED_MIME_TYPES)).toEqual(['css', 'html', 'js']);
    expect(Object.keys(wb.PRECOMPRESS_TYPES)).toContain('js');
    expect(wb.DEFAULT_SKIPPED_DIRS).toContain('node_modules');
    expect(typeof wb.nodeWebBuildDeps.readText).toBe('function');
    expect(typeof wb.nodePrecompressDeps.writeFile).toBe('function');
  });

  test('exposes nothing that writes or raises a budget', () => {
    const names = Object.keys(wb).map((name) => name.toLowerCase());
    for (const banned of ['raise', 'update', 'tolerance', 'override', 'bump', 'writebudget']) {
      expect(names.filter((name) => name.includes(banned))).toEqual([]);
    }
  });
});
