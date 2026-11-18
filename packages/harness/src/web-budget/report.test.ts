import { describe, expect, test } from 'bun:test';

import { parseViteManifest } from './manifest.js';
import { checkWebBudget, formatBytes, formatWebBudgetSummary, reportIsFresh } from './report.js';
import { appManifest, sizeOfMap } from './test-support.js';

const BUDGETS = {
  shell: 200,
  routes: {
    'src/routes/b.tsx': { cold: 300 },
    'src/routes/a.tsx': { cold: 300, beyondShell: 240 },
  },
  files: [{ pattern: 'assets/vendor.js', max: 250 }],
};

describe('checkWebBudget', () => {
  test('a build within budget passes and renders a deterministic report', () => {
    const result = checkWebBudget({
      manifest: appManifest(),
      sizeOf: sizeOfMap(),
      budgets: BUDGETS,
    });
    expect(result.passed).toBe(true);
    expect(result.shell).toEqual({ bytes: 170, limit: 200 });
    expect(result.routes.map((row) => row.key)).toEqual(['src/routes/a.tsx', 'src/routes/b.tsx']);
    expect(result.files).toEqual([
      { file: 'assets/vendor.js', pattern: 'assets/vendor.js', bytes: 200, max: 250 },
    ]);
    expect(result.report).toBe(`# Web bundle budgets

Sizes are gzip bytes. Generated from the build manifest: do not edit by hand.

Status: passed

## Shell

| Weight | Budget | Headroom |
|---|---|---|
| 0.2 KiB (170 B) | 0.2 KiB (200 B) | 30 B left |

## Routes

| Route | Cold | Cold budget | Beyond shell | Beyond shell budget | Headroom |
|---|---|---|---|---|---|
| \`src/routes/a.tsx\` | 0.3 KiB (285 B) | 0.3 KiB (300 B) | 0.2 KiB (235 B) | 0.2 KiB (240 B) | 15 B left, 5 B left |
| \`src/routes/b.tsx\` | 0.2 KiB (250 B) | 0.3 KiB (300 B) | 0.2 KiB (250 B) |  | 50 B left |

## Files

| File | Pattern | Weight | Budget | Headroom |
|---|---|---|---|---|
| \`assets/vendor.js\` | \`assets/vendor.js\` | 0.2 KiB (200 B) | 0.2 KiB (250 B) | 50 B left |

## Dead dynamic imports

None.
`);
    // Same input, same bytes.
    expect(
      checkWebBudget({ manifest: appManifest(), sizeOf: sizeOfMap(), budgets: BUDGETS }).report,
    ).toBe(result.report);
    expect(formatWebBudgetSummary(result)).toEqual([
      'web-budget: passed (shell 0.2 KiB (170 B), 2 route budgets, 1 budgeted files)',
    ]);
  });

  test('violations, dead imports and problems all fail and are listed', () => {
    const manifest = parseViteManifest({
      'main.ts': { file: 'main.js', isEntry: true, dynamicImports: ['src/gone.ts', 'src/a.ts'] },
      'src/a.ts': { file: 'a.js', isDynamicEntry: true, dynamicImports: ['main.ts'] },
      bad: { nofile: true },
    });
    const result = checkWebBudget({
      manifest,
      sizeOf: () => 2000,
      budgets: { shell: 1000, routes: { 'src/gone.ts': { cold: 1 } } },
      allowDeadImports: [{ importer: 'src/a.ts', target: 'main.ts', reason: 'hot reload hook' }],
      measure: 'brotli',
    });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['shell', 'stale-route']);
    expect(result.deadImports.map((d) => d.target)).toEqual(['src/gone.ts']);
    expect(result.allowedDeadImports.map((d) => d.reason)).toEqual(['hot reload hook']);
    expect(result.problems).toEqual(['manifest: "bad" has no "file" string']);
    expect(result.report).toContain('Sizes are brotli bytes.');
    expect(result.report).toContain('Status: failed');
    expect(result.report).toContain('**1000 B over**');
    expect(result.report).toContain('No route budget.');
    expect(result.report).toContain('No file budget matched a built file.');
    expect(result.report).toContain('- broken: "main.ts" imports "src/gone.ts"');
    expect(result.report).toContain('- allowed (hot reload hook): `src/a.ts` -> `main.ts`');
    expect(result.report).toContain('## Failures');
    expect(result.report).toContain('- manifest: "bad" has no "file" string');
    const summary = formatWebBudgetSummary(result, 'bundle');
    expect(summary).toHaveLength(5);
    expect(summary.at(-1)).toBe(
      'bundle: failed (4 problems). Shrink what grew; raise a budget only in a reviewed change that says why.',
    );
  });

  test('one failure reads in the singular', () => {
    const result = checkWebBudget({
      manifest: appManifest(),
      sizeOf: sizeOfMap(),
      budgets: { shell: 1 },
    });
    expect(formatWebBudgetSummary(result).at(-1)).toStartWith('web-budget: failed (1 problem).');
  });

  test('shellEntries and includeAssets reach the graph', () => {
    const result = checkWebBudget({
      manifest: appManifest(),
      sizeOf: sizeOfMap(),
      budgets: { routes: { 'src/routes/a.tsx': { cold: 2000 } } },
      shellEntries: ['src/routes/b.tsx'],
      includeAssets: true,
    });
    expect(result.shell.bytes).toBe(250);
    expect(result.routes[0]?.cold).toBe(1285);
  });

  test('an invalid budgets value throws', () => {
    expect(() =>
      checkWebBudget({ manifest: appManifest(), sizeOf: sizeOfMap(), budgets: { shell: -5 } }),
    ).toThrow('shell must be a positive number');
  });
});

describe('formatBytes', () => {
  test('KiB with one decimal and the exact bytes', () => {
    expect(formatBytes(0)).toBe('0.0 KiB (0 B)');
    expect(formatBytes(153_600)).toBe('150.0 KiB (153600 B)');
  });
});

describe('reportIsFresh', () => {
  test('equal text is fresh, and CRLF equals LF', () => {
    expect(reportIsFresh('a\nb\n', 'a\nb\n').fresh).toBe(true);
    expect(reportIsFresh('a\r\nb\r\n', 'a\nb\n')).toEqual({
      fresh: true,
      message: 'the web budget report is up to date',
    });
  });

  test('a stale report says how to regenerate it', () => {
    expect(
      reportIsFresh('old\n', 'new\n', {
        path: 'web/BUDGETS.md',
        regenerate: 'bun run budgets --write',
      }),
    ).toEqual({
      fresh: false,
      message:
        'web/BUDGETS.md is out of date with the build: run `bun run budgets --write` and commit the result',
    });
    expect(reportIsFresh('old', 'new').message).toBe(
      'the web budget report is out of date with the build: regenerate it and commit the result',
    );
  });

  test('a missing report is stale', () => {
    expect(reportIsFresh(null, 'x', { path: 'R.md' })).toEqual({
      fresh: false,
      message: 'R.md is missing: regenerate it and commit the result',
    });
  });
});
