import { describe, expect, test } from 'bun:test';

import { checkBudgets, matchesPattern, parseWebBudgets } from './budgets.js';
import { buildGraph } from './graph.js';
import { appManifest, sizeOfMap } from './test-support.js';

const graph = buildGraph(appManifest(), sizeOfMap());

describe('parseWebBudgets', () => {
  test('reads shell, routes and files, normalizing Windows keys', () => {
    expect(
      parseWebBudgets({
        $note: 'raised in #12 for the editor',
        shell: 100,
        routes: { 'src\\routes\\a.tsx': { cold: 10 }, b: { beyondShell: 5 } },
        files: [{ pattern: 'assets\\*.js', max: 3 }],
      }),
    ).toEqual({
      shell: 100,
      routes: { 'src/routes/a.tsx': { cold: 10 }, b: { beyondShell: 5 } },
      files: [{ pattern: 'assets/*.js', max: 3 }],
    });
    expect(parseWebBudgets({})).toEqual({});
  });

  test('a zero, negative, infinite or non-number limit throws', () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, '100', null]) {
      expect(() => parseWebBudgets({ shell: bad })).toThrow('shell must be a positive number');
      expect(() => parseWebBudgets({ routes: { a: { cold: bad } } })).toThrow(
        'routes["a"].cold must be a positive number',
      );
      expect(() => parseWebBudgets({ routes: { a: { beyondShell: bad } } })).toThrow(
        'routes["a"].beyondShell must be a positive number',
      );
      expect(() => parseWebBudgets({ files: [{ pattern: '*', max: bad }] })).toThrow(
        'files[0].max must be a positive number',
      );
    }
  });

  test('a malformed shape throws', () => {
    expect(() => parseWebBudgets([])).toThrow('must be a JSON object');
    expect(() => parseWebBudgets({ tolerance: 0.1 })).toThrow('unknown key "tolerance"');
    expect(() => parseWebBudgets({ routes: [] })).toThrow('routes must be an object');
    expect(() => parseWebBudgets({ routes: { a: 3 } })).toThrow('routes["a"] must be an object');
    expect(() => parseWebBudgets({ routes: { a: {} } })).toThrow('sets no limit');
    expect(() => parseWebBudgets({ files: {} })).toThrow('files must be a list');
    expect(() => parseWebBudgets({ files: [{ max: 1 }] })).toThrow('needs a non-empty "pattern"');
  });
});

describe('matchesPattern', () => {
  test('* stays within a segment, ** crosses any number', () => {
    expect(matchesPattern('assets/*.js', 'assets/a.js')).toBe(true);
    expect(matchesPattern('assets/*.js', 'assets/x/a.js')).toBe(false);
    expect(matchesPattern('**/*.css', 'assets/a.css')).toBe(true);
    expect(matchesPattern('**/*.css', 'a.css')).toBe(true);
    expect(matchesPattern('assets/**', 'assets/x/y/z.js')).toBe(true);
    expect(matchesPattern('a/**/b.js', 'a/b.js')).toBe(true);
    expect(matchesPattern('a?.js', 'ab.js')).toBe(true);
    expect(matchesPattern('a?.js', 'a.js')).toBe(false);
    expect(matchesPattern('*vendor*', 'my-vendor-x.js')).toBe(true);
    expect(matchesPattern('*.js', 'a.css')).toBe(false);
    expect(matchesPattern('assets\\*.js', 'assets\\a.js')).toBe(true);
  });

  test('a long hostile pattern does not backtrack', () => {
    const started = Date.now();
    expect(matchesPattern(`${'**/'.repeat(200)}x`, `${'a/'.repeat(200)}y`)).toBe(false);
    expect(matchesPattern(`${'*a'.repeat(50)}b`, 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('checkBudgets', () => {
  test('within every budget there is no violation', () => {
    expect(
      checkBudgets(graph, {
        shell: 170,
        routes: { 'src/routes/a.tsx': { cold: 285, beyondShell: 235 } },
        files: [{ pattern: 'assets/*.js', max: 200 }],
      }),
    ).toEqual([]);
  });

  test('reports shell, route and file overruns with actual, limit and over-by', () => {
    const violations = checkBudgets(graph, {
      shell: 150,
      routes: {
        'src/routes/b.tsx': { cold: 200 },
        'src/routes/a.tsx': { cold: 300, beyondShell: 200 },
      },
      files: [{ pattern: '**/vendor.js', max: 150 }],
    });
    expect(
      violations.map(({ kind, subject, actual, limit, overBy }) => ({
        kind,
        subject,
        actual,
        limit,
        overBy,
      })),
    ).toEqual([
      { kind: 'shell', subject: 'shell', actual: 170, limit: 150, overBy: 20 },
      {
        kind: 'route-beyond-shell',
        subject: 'src/routes/a.tsx',
        actual: 235,
        limit: 200,
        overBy: 35,
      },
      { kind: 'route-cold', subject: 'src/routes/b.tsx', actual: 250, limit: 200, overBy: 50 },
      { kind: 'file', subject: 'assets/vendor.js', actual: 200, limit: 150, overBy: 50 },
    ]);
    expect(violations[0]?.message).toBe(
      'the shell is 170 bytes, 20 over its 150 byte budget: shrink it, or raise the budget in a reviewed change that says why',
    );
  });

  test('a budgeted route or file pattern the build no longer has is stale', () => {
    const violations = checkBudgets(graph, {
      routes: { 'src/routes/gone.tsx': { cold: 1 } },
      files: [{ pattern: 'assets/*.mjs', max: 1 }],
    });
    expect(violations).toEqual([
      {
        kind: 'stale-route',
        subject: 'src/routes/gone.tsx',
        message:
          'route "src/routes/gone.tsx" has a budget but is not in the manifest: fix the key or remove the budget',
      },
      {
        kind: 'stale-file',
        subject: 'assets/*.mjs',
        message:
          'file budget "assets/*.mjs" matches no built file: fix the pattern or remove the budget',
      },
    ]);
  });

  test('an invalid budget throws instead of passing', () => {
    expect(() => checkBudgets(graph, { shell: 0 })).toThrow('shell must be a positive number');
  });
});
