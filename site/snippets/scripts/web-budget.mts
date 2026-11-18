import { readFileSync, writeFileSync } from 'node:fs';

import {
  checkWebBudget,
  formatWebBudgetSummary,
  nodeManifestDeps,
  nodeReadText,
  nodeSizeOf,
  readViteManifest,
  reportIsFresh,
} from '@noctcore/harness/web-budget';

// Your paths: the build output, its manifest, your budgets file and the committed report.
const DIST = 'apps/web/dist';
const REPORT = 'apps/web/BUDGETS.md';

const result = checkWebBudget({
  manifest: readViteManifest(`${DIST}/.vite/manifest.json`, nodeManifestDeps),
  sizeOf: nodeSizeOf(DIST, 'gzip'),
  budgets: JSON.parse(readFileSync('apps/web/budgets.json', 'utf8')),
  allowDeadImports: [
    { importer: 'src/main.tsx', target: 'src/devtools.tsx', reason: 'loaded in dev builds only' },
  ],
});

if (process.argv.includes('--report')) {
  // Writes the report, never the budgets: a budget changes only by hand, with a reason.
  writeFileSync(REPORT, result.report);
  process.exit(0);
}

console.log(formatWebBudgetSummary(result).join('\n'));
const freshness = reportIsFresh(nodeReadText(REPORT), result.report, {
  path: REPORT,
  regenerate: 'node scripts/web-budget.mts --report',
});
if (!freshness.fresh) console.error(freshness.message);
process.exit(result.passed && freshness.fresh ? 0 : 1);
