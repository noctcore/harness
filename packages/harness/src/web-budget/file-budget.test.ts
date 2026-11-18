import { describe, expect, test } from 'bun:test';

import { type IBuildGraph, parseManifest } from './build-graph.js';
import { checkFileBudgets, matchFiles, ownChunks, parseFileBudgets } from './file-budget.js';

const FILES = [
  'assets/index-a.js',
  'assets/sign-in-b.js',
  'assets/SignIn.constants-c.js',
  'assets/index-d.css',
  'assets/deep/sign-in-e.js',
];
const sizeOf = (file: string): number => (file.endsWith('.css') ? 20_000 : 1_000);
const entry = (path: string, limit: string): string => JSON.stringify([{ name: 'n', path, limit }]);
const routeEntry = (route: readonly string[], limit: string): string =>
  JSON.stringify([{ name: 'n', route, limit }]);

const SIGN_IN = 'src/routes/sign-in.tsx';
const SHELL = 'src/routes/_app.tsx';
const REPORTS = 'src/routes/reports.tsx';

/**
 * A build: the entry loads the shell, the sign-in route and the reports route
 * lazily. Sign-in is two chunks of its own (a router plugin splits a route
 * module by component), imports a private helper, a form chunk it shares with
 * reports and a vendor chunk it shares with the entry, and loads a panel
 * lazily; the panel shares a chunk with sign-in.
 */
const manifest = (signIn: Record<string, object>): IBuildGraph =>
  parseManifest(
    JSON.stringify({
      'index.html': {
        file: 'assets/index.js',
        isEntry: true,
        imports: ['_vendor.js'],
        dynamicImports: [`${SHELL}?split=component`, `${SIGN_IN}?split=component`, REPORTS],
      },
      '_vendor.js': { file: 'assets/vendor.js' },
      [`${SHELL}?split=component`]: { file: 'assets/_app.js' },
      [REPORTS]: { file: 'assets/reports.js', imports: ['_form.js'] },
      '_form.js': { file: 'assets/form.js' },
      '_panel-shared.js': { file: 'assets/panel-shared.js' },
      'src/features/sign-in/Panel.tsx': { file: 'assets/Panel.js', imports: ['_panel-shared.js'] },
      ...signIn,
    }),
  );

const SPLIT = manifest({
  [`${SIGN_IN}?split=component`]: {
    file: 'assets/sign-in-a.js',
    imports: ['_vendor.js', '_form.js', '_SignIn.constants.js', '_panel-shared.js'],
    dynamicImports: ['src/features/sign-in/Panel.tsx'],
  },
  [`${SIGN_IN}?split=pending`]: { file: 'assets/sign-in-b.js' },
  '_SignIn.constants.js': { file: 'assets/SignIn.constants.js', imports: ['_deep.js'] },
  '_deep.js': { file: 'assets/deep.js' },
});

/** The same modules after the bundler folded the helper chunks into the route chunk and renamed it. */
const FOLDED = manifest({
  [`${SIGN_IN}?split=component`]: {
    file: 'assets/login-z.js',
    imports: ['_vendor.js', '_form.js', '_panel-shared.js'],
    dynamicImports: ['src/features/sign-in/Panel.tsx'],
  },
  [`${SIGN_IN}?split=pending`]: { file: 'assets/sign-in-b.js' },
});

const WEIGHTS: Readonly<Record<string, number>> = {
  'assets/sign-in-a.js': 1000,
  'assets/sign-in-b.js': 200,
  'assets/SignIn.constants.js': 300,
  'assets/deep.js': 100,
  // sign-in-a with SignIn.constants and deep folded in.
  'assets/login-z.js': 1400,
  'assets/form.js': 50_000,
  'assets/vendor.js': 90_000,
  'assets/panel-shared.js': 7000,
};
const weigh = (file: string): number => WEIGHTS[file] ?? 1_000_000;
const NO_GRAPH = parseManifest(JSON.stringify({ a: { file: 'assets/a.js', isEntry: true } }));

describe('parseFileBudgets', () => {
  test('reads path and route entries, normalizing Windows separators', () => {
    expect(
      parseFileBudgets(
        JSON.stringify([
          { name: 'scripts', path: 'assets\\*.js', limit: '700 kB' },
          { name: 'sign-in', route: ['src\\routes\\sign-in.tsx'], limit: '6 kB' },
        ]),
      ),
    ).toEqual([
      { name: 'scripts', path: 'assets/*.js', limitBytes: 700_000 },
      { name: 'sign-in', route: ['src/routes/sign-in.tsx'], limitBytes: 6_000 },
    ]);
  });

  test('reads a limit in kB of 1000 bytes', () => {
    expect(parseFileBudgets(entry('a', '512.3 kB'))[0]?.limitBytes).toBe(512_300);
    expect(parseFileBudgets(entry('a', '6 kB'))[0]?.limitBytes).toBe(6_000);
  });

  test('refuses an entry it cannot hold a build to', () => {
    expect(() => parseFileBudgets('nope')).toThrow('the budget file is not JSON');
    expect(() => parseFileBudgets('[]')).toThrow('not a list of entries');
    expect(() => parseFileBudgets('{}')).toThrow('not a list of entries');
    expect(() => parseFileBudgets('[3]')).toThrow('budget 1 is not an object');
    expect(() => parseFileBudgets(entry('a', '4kB'))).toThrow('expected "<number> kB"');
    expect(() => parseFileBudgets(entry('a', '4 MB'))).toThrow('expected "<number> kB"');
    expect(() => parseFileBudgets(entry('a', '0 kB'))).toThrow('above zero');
    expect(() => parseFileBudgets(JSON.stringify([{ name: 'n', path: 'a', limit: 4 }]))).toThrow(
      'expected "<number> kB"',
    );
    expect(() => parseFileBudgets(entry('', '6 kB'))).toThrow(
      'needs a path (a file pattern) or a route',
    );
    expect(() => parseFileBudgets(routeEntry([], '6 kB'))).toThrow('needs a path');
    expect(() => parseFileBudgets(routeEntry([''], '6 kB'))).toThrow('needs a path');
    expect(() =>
      parseFileBudgets(JSON.stringify([{ name: 'n', path: 'a', route: ['b'], limit: '6 kB' }])),
    ).toThrow('and only one');
    expect(() => parseFileBudgets(JSON.stringify([{ path: 'a', limit: '6 kB' }]))).toThrow(
      'has no name',
    );
    expect(() =>
      parseFileBudgets(
        JSON.stringify([{ name: 'n', path: 'a', limit: '6 kB', tolerance: '1 kB' }]),
      ),
    ).toThrow('options this check does not read: tolerance');
  });
});

describe('matchFiles', () => {
  test('lets * stand for part of one file name, never a directory, and reads the rest literally', () => {
    expect(matchFiles('assets/*.js', FILES)).toEqual([
      'assets/index-a.js',
      'assets/sign-in-b.js',
      'assets/SignIn.constants-c.js',
    ]);
    expect(matchFiles('assets/sign-in-*.js', FILES)).toEqual(['assets/sign-in-b.js']);
    expect(matchFiles('assets/index-a.js', FILES)).toEqual(['assets/index-a.js']);
    expect(matchFiles('assets/index-a_js', FILES)).toEqual([]);
    expect(matchFiles('assets/*.j', FILES)).toEqual([]);
    expect(matchFiles('assets/index-?.js', FILES)).toEqual([]);
    expect(matchFiles('assets/*/*.js', FILES)).toEqual(['assets/deep/sign-in-e.js']);
    expect(matchFiles('assets\\*.css', FILES)).toEqual(['assets/index-d.css']);
    expect(matchFiles('*', ['a', 'b/c'])).toEqual(['a']);
  });

  test('a long hostile pattern does not backtrack', () => {
    const started = Date.now();
    expect(matchFiles(`${'*a'.repeat(60)}b`, ['a'.repeat(5000)])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('checkFileBudgets', () => {
  test('sums the files of each entry and passes at the limit', () => {
    const budgets = parseFileBudgets(
      JSON.stringify([
        { name: 'scripts', path: 'assets/*.js', limit: '3 kB' },
        { name: 'styles', path: 'assets/*.css', limit: '20.5 kB' },
      ]),
    );
    expect(checkFileBudgets(budgets, FILES, NO_GRAPH, sizeOf)).toEqual({
      lines: [
        'assets/*.js: 3.00 kB across 3 files (limit 3.00 kB)',
        'assets/*.css: 20.00 kB across 1 files (limit 20.50 kB)',
      ],
      problems: [],
    });
  });

  test('fails an entry one byte over its limit, and says by how much', () => {
    const budgets = parseFileBudgets(entry('assets/*.js', '2.999 kB'));
    expect(checkFileBudgets(budgets, FILES, NO_GRAPH, sizeOf).problems).toEqual([
      'assets/*.js: 3.00 kB is 0.00 kB over its 3.00 kB limit: shrink it, or raise the limit in a reviewed change that says why',
    ]);
  });

  test('fails an entry no file matches, which would weigh nothing under any limit', () => {
    const budgets = parseFileBudgets(entry('assets/orders-*.js', '18 kB'));
    expect(checkFileBudgets(budgets, FILES, NO_GRAPH, sizeOf)).toEqual({
      lines: [],
      problems: ['assets/orders-*.js: no file of the build matches'],
    });
  });

  test('prints the limit a headroom over today gives, rounded down', () => {
    const budgets = parseFileBudgets(entry('assets/*.css', '30 kB'));
    expect(checkFileBudgets(budgets, FILES, NO_GRAPH, sizeOf, 4.5).lines).toEqual([
      'assets/*.css: 20.00 kB across 1 files (limit 30.00 kB)',
      'assets/*.css: at 4.5% headroom, 20.90 kB',
    ]);
    expect(() => checkFileBudgets(budgets, FILES, NO_GRAPH, sizeOf, Number.NaN)).toThrow(
      'is not a percentage',
    );
  });
});

describe('ownChunks', () => {
  test("is the route's chunks and what only they import: nothing shared with the entry, another route or a lazy child", () => {
    expect(ownChunks(SPLIT, [SIGN_IN]).sort()).toEqual([
      'assets/SignIn.constants.js',
      'assets/deep.js',
      'assets/sign-in-a.js',
      'assets/sign-in-b.js',
    ]);
  });

  test('keeps a route chunk that another load root imports statically', () => {
    const graph = parseManifest(
      JSON.stringify({
        'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: [SIGN_IN, 'tab'] },
        [SIGN_IN]: { file: 'assets/sign-in.js', imports: ['_private.js'], dynamicImports: ['tab'] },
        '_private.js': { file: 'assets/private.js' },
        tab: { file: 'assets/tab.js', imports: [SIGN_IN] },
      }),
    );
    // The lazy tab imports the route chunk, so the helper is shared with it; the route chunk still counts.
    expect(ownChunks(graph, [SIGN_IN])).toEqual(['assets/sign-in.js']);
  });
});

describe('checkFileBudgets on a route', () => {
  const files = Object.keys(WEIGHTS);

  test("weighs the route's own chunks, taken from the graph", () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN], '1.6 kB'));
    expect(checkFileBudgets(budgets, files, SPLIT, weigh)).toEqual({
      lines: [`route ${SIGN_IN}: 1.60 kB across 4 files (limit 1.60 kB)`],
      problems: [],
    });
  });

  test('weighs the same bytes after the bundler folds a helper chunk into the route chunk and renames it', () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN], '1.6 kB'));
    expect(checkFileBudgets(budgets, files, FOLDED, weigh)).toEqual({
      lines: [`route ${SIGN_IN}: 1.60 kB across 2 files (limit 1.60 kB)`],
      problems: [],
    });
    // What a file-name pattern makes of the same two builds: the helper's
    // bytes appear from nowhere, and the renamed chunk drops out.
    const pattern = parseFileBudgets(entry('assets/sign-in-*.js', '9 kB'));
    const emitted = (graph: IBuildGraph): string[] => [...graph.chunks.keys()];
    expect(checkFileBudgets(pattern, emitted(SPLIT), SPLIT, weigh).lines).toEqual([
      'assets/sign-in-*.js: 1.20 kB across 2 files (limit 9.00 kB)',
    ]);
    expect(checkFileBudgets(pattern, emitted(FOLDED), FOLDED, weigh).lines).toEqual([
      'assets/sign-in-*.js: 0.20 kB across 1 files (limit 9.00 kB)',
    ]);
  });

  test('sums several route modules as one entry', () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN, REPORTS], '100 kB'));
    const report = checkFileBudgets(budgets, files, SPLIT, (file) =>
      file === 'assets/reports.js' ? 400 : weigh(file),
    );
    // form.js is shared by the two modules of the entry and by nothing else, so it is theirs.
    expect(report).toEqual({
      lines: [`route ${SIGN_IN} + ${REPORTS}: 52.00 kB across 6 files (limit 100.00 kB)`],
      problems: [],
    });
  });

  test('fails a route over its limit, and says by how much', () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN], '1.5 kB'));
    expect(checkFileBudgets(budgets, files, SPLIT, weigh).problems).toEqual([
      `route ${SIGN_IN}: 1.60 kB is 0.10 kB over its 1.50 kB limit: shrink it, or raise the limit in a reviewed change that says why`,
    ]);
  });

  test('fails a route when the build has no chunk for one of its modules', () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN, 'src/routes/gone.tsx'], '100 kB'));
    expect(checkFileBudgets(budgets, files, SPLIT, weigh)).toEqual({
      lines: [],
      problems: [
        `route ${SIGN_IN} + src/routes/gone.tsx: the build has no chunk for src/routes/gone.tsx`,
      ],
    });
  });

  test('prints the limit a headroom over today gives', () => {
    const budgets = parseFileBudgets(routeEntry([SIGN_IN], '9 kB'));
    expect(checkFileBudgets(budgets, files, SPLIT, weigh, 10).lines).toEqual([
      `route ${SIGN_IN}: 1.60 kB across 4 files (limit 9.00 kB)`,
      `route ${SIGN_IN}: at 10% headroom, 1.76 kB`,
    ]);
  });
});
