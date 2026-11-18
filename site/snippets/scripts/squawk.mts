import { exitCodeFor, nodeSquawkDeps, runSquawk } from '@noctcore/harness/pinned-tools';

import { BASELINE, BASELINE_SEAL, RETIRED } from './squawk-baseline.mts';

const result = runSquawk(process.cwd(), nodeSquawkDeps(), {
  migrationsDir: 'prisma/migrations',
  baseline: {
    pinned: BASELINE,
    retired: RETIRED,
    seal: BASELINE_SEAL,
    source: 'scripts/squawk-baseline.mts',
  },
  canaries: [
    { file: 'checks/squawk/lock-unsafe.sql', codes: ['require-concurrent-index-creation'] },
    { file: 'checks/squawk/lock-safe.sql', codes: [] },
  ],
});
for (const line of result.lines) console.log(line);
console.log(`squawk: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status));
