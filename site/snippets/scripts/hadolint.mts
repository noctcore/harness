import { exitCodeFor, nodeHadolintDeps, runHadolint } from '@noctcore/harness/pinned-tools';

const result = runHadolint(process.cwd(), nodeHadolintDeps(), {
  // Each fixture with the exact codes the pinned hadolint must report for it.
  canaries: [
    { file: 'checks/hadolint/unsafe.Dockerfile', codes: ['DL3002', 'DL4006', 'SC2086'] },
    { file: 'checks/hadolint/clean.Dockerfile', codes: [] },
  ],
  exclude: ['checks/hadolint/'],
});
for (const line of result.lines) console.log(line);
console.log(`hadolint: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status));
