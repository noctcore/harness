import { readFileSync } from 'node:fs';

import {
  checkDynamicImports,
  checkFileBudgets,
  checkRoutes,
  headroomFromArgv,
  type IRouteBudget,
  loadWebBuild,
  nodeWebBuildDeps,
  parseFileBudgets,
  parseServedEncoding,
  runBudget,
} from '@noctcore/harness/web-budget';

// Your paths and limits. Moving a baseline or a limit is a reviewed edit with a reason.
const ROUTES: IRouteBudget = {
  shells: { app: ['src/routes/_app.tsx'] },
  baselines: [
    { route: '/sign-in', sources: ['src/routes/sign-in.tsx'], coldKb: 160, beyondKb: 12 },
    { route: '/reports', sources: ['src/routes/_app/reports.tsx'], shell: 'app', coldKb: 240, beyondKb: 35 },
  ],
};
const budgets = parseFileBudgets(readFileSync('apps/web/budgets.json', 'utf8'));
const encoding = parseServedEncoding(readFileSync('apps/web/nginx.conf', 'utf8'));
const headroom = headroomFromArgv(process.argv.slice(2));

const code = runBudget(
  'web-budget',
  { out: console.log, err: console.error },
  () =>
    loadWebBuild(
      {
        distDir: 'apps/web/dist',
        sourceRoots: ['apps/web/src', 'packages/ui/src'],
        skipFreshness: process.env.CI === 'true',
        weigh: { encoding, precompress: { never: ['runtime.js'] } },
      },
      nodeWebBuildDeps,
    ),
  (build) => {
    const reports = [
      checkRoutes(build.graph, build.sizeOf, ROUTES, headroom),
      checkFileBudgets(budgets, build.assets, build.graph, build.sizeOf, headroom),
      checkDynamicImports(build.graph),
    ];
    return {
      lines: reports.flatMap((report) => report.lines),
      problems: reports.flatMap((report) => report.problems),
    };
  },
);
process.exit(code);
