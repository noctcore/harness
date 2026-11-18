import { describe, expect, test } from 'bun:test';

import { parseManifest } from './build-graph.js';
import { checkRoutes, type IRouteBudget, unbuilt } from './route-budget.js';

const GRAPH = parseManifest(
  JSON.stringify({
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_vendor.js'] },
    '_vendor.js': { file: 'assets/vendor.js' },
    'src/routes/_app.tsx?split=component': {
      file: 'assets/_app-a.js',
      imports: ['_vendor.js', '_sidebar.js'],
    },
    'src/routes/_app.tsx?split=pending': { file: 'assets/_app-b.js' },
    '_sidebar.js': { file: 'assets/sidebar.js' },
    'src/routes/sign-in.tsx?split=component': {
      file: 'assets/sign-in.js',
      imports: ['_vendor.js', '_form.js'],
    },
    '_form.js': { file: 'assets/form.js' },
    'src/routes/_app/reports.tsx?split=component': {
      file: 'assets/reports.js',
      imports: ['_sidebar.js', '_table.js'],
      dynamicImports: ['_export.js'],
    },
    '_table.js': { file: 'assets/table.js' },
    '_export.js': { file: 'assets/export.js' },
  }),
);

/** Sizes in bytes, chosen so every sum is easy to read. */
const SIZES: Readonly<Record<string, number>> = {
  'assets/index.js': 100_000,
  'assets/vendor.js': 50_000,
  'assets/_app-a.js': 20_000,
  'assets/_app-b.js': 5_000,
  'assets/sidebar.js': 25_000,
  'assets/sign-in.js': 2_000,
  'assets/form.js': 8_000,
  'assets/reports.js': 3_000,
  'assets/table.js': 30_000,
  'assets/export.js': 900_000,
};
const sizeOf = (file: string): number => SIZES[file] ?? 0;

const budget = (overrides: Partial<IRouteBudget> = {}): IRouteBudget => ({
  shells: { app: ['src/routes/_app.tsx'] },
  baselines: [
    { route: '/sign-in', sources: ['src/routes/sign-in.tsx'], coldKb: 160, beyondKb: 10 },
    {
      route: '/reports',
      sources: ['src/routes/_app/reports.tsx'],
      shell: 'app',
      coldKb: 233,
      beyondKb: 33,
    },
  ],
  ...overrides,
});

describe('checkRoutes', () => {
  test('weighs a route as its own chunks and their static imports, with and beyond the shell', () => {
    expect(checkRoutes(GRAPH, sizeOf, budget())).toEqual({
      lines: [
        'entry: 150.00 kB across 2 chunks',
        'app shell: 200.00 kB across 5 chunks',
        '/sign-in: cold 160.00 kB (baseline 160 kB), 10.00 kB across 2 chunks beyond the shell (baseline 10 kB)',
        '/reports: cold 233.00 kB (baseline 233 kB), 33.00 kB across 2 chunks beyond the shell (baseline 33 kB)',
      ],
      problems: [],
    });
  });

  test('a baseline is the limit: at it passes, a byte past it fails, cold and beyond apart', () => {
    const tight = budget();
    const cold = {
      ...tight,
      baselines: tight.baselines.map((b) => ({ ...b, coldKb: b.coldKb - 0.01 })),
    };
    expect(checkRoutes(GRAPH, sizeOf, cold).problems).toEqual([
      '/sign-in: cold 160.00 kB is 0.01 kB over its 159.99 kB baseline: shrink it, or move the baseline in a reviewed change that says why',
      '/reports: cold 233.00 kB is 0.01 kB over its 232.99 kB baseline: shrink it, or move the baseline in a reviewed change that says why',
    ]);
    const beyond = { ...tight, baselines: tight.baselines.map((b) => ({ ...b, beyondKb: 1 })) };
    expect(
      checkRoutes(GRAPH, sizeOf, beyond).problems.map(
        (p) => p.split(':')[0] + ':' + p.split(':')[1],
      ),
    ).toEqual([
      '/sign-in: beyond the shell 10.00 kB is 9.00 kB over its 1 kB baseline',
      '/reports: beyond the shell 33.00 kB is 32.00 kB over its 1 kB baseline',
    ]);
  });

  test('fails a route the build has no chunk for, and a shell it cannot find', () => {
    const moved = budget({
      shells: { app: ['src/routes/_layout.tsx'], empty: [] },
      baselines: [
        { route: '/gone', sources: ['src/routes/gone.tsx'], coldKb: 1, beyondKb: 1 },
        { route: '/none', sources: [], coldKb: 1, beyondKb: 1 },
        {
          route: '/inside',
          sources: ['src/routes/sign-in.tsx'],
          shell: 'app',
          coldKb: 1,
          beyondKb: 1,
        },
        {
          route: '/elsewhere',
          sources: ['src/routes/sign-in.tsx'],
          shell: 'admin',
          coldKb: 1,
          beyondKb: 1,
        },
      ],
    });
    expect(checkRoutes(GRAPH, sizeOf, moved).problems).toEqual([
      'the build has no chunk for src/routes/_layout.tsx, so the app shell cannot be measured',
      'the build has no chunk for a shell with no module, so the empty shell cannot be measured',
      '/gone: the build has no chunk for src/routes/gone.tsx, so the route cannot be measured',
      '/none: the build has no chunk for a route with no module, so the route cannot be measured',
      '/elsewhere: names the shell "admin", which the budget does not define',
    ]);
  });

  test('fails a route when one of its modules is missing, never weighing the rest alone', () => {
    const partial = budget({
      baselines: [
        {
          route: '/reports',
          sources: ['src/routes/_app/reports.tsx', 'src/routes/gone.tsx'],
          shell: 'app',
          coldKb: 999,
          beyondKb: 999,
        },
      ],
    });
    expect(checkRoutes(GRAPH, sizeOf, partial).problems).toEqual([
      '/reports: the build has no chunk for src/routes/gone.tsx, so the route cannot be measured',
    ]);
    expect(unbuilt(GRAPH, ['src/routes/sign-in.tsx', 'x.tsx'])).toEqual(['x.tsx']);
  });

  test('fails a build with no entry chunk', () => {
    const noEntry = parseManifest(JSON.stringify({ a: { file: 'a.js' } }));
    expect(checkRoutes(noEntry, sizeOf, { baselines: [] }).problems).toEqual([
      'the build has no entry chunk',
    ]);
  });

  test('prints the baselines a headroom over today gives, rounded down', () => {
    const { lines } = checkRoutes(GRAPH, sizeOf, budget(), 3);
    expect(lines).toContain('/sign-in: at 3% headroom, cold 164.80 kB and beyond 10.30 kB');
    expect(lines).toContain('/reports: at 3% headroom, cold 239.99 kB and beyond 33.99 kB');
  });

  test('throws on a baseline or headroom that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        checkRoutes(GRAPH, sizeOf, {
          baselines: [
            { route: '/x', sources: ['src/routes/sign-in.tsx'], coldKb: bad, beyondKb: 1 },
          ],
        }),
      ).toThrow('/x: coldKb must be a positive number of kB');
      expect(() =>
        checkRoutes(GRAPH, sizeOf, {
          baselines: [
            { route: '/x', sources: ['src/routes/sign-in.tsx'], coldKb: 1, beyondKb: bad },
          ],
        }),
      ).toThrow('/x: beyondKb must be a positive number of kB');
    }
    expect(() => checkRoutes(GRAPH, sizeOf, budget(), -1)).toThrow(
      'headroom -1 is not a percentage',
    );
  });
});
