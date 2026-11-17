import { exitCodeFor, nodeRunDeps, runLinter, WORKFLOW_LINTERS } from '@noctcore/harness/pinned-tools';

const result = runLinter(WORKFLOW_LINTERS.actionlint, process.cwd(), nodeRunDeps());
console.log(`actionlint: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status)); // 0 passed, 1 failed, 2 blocked
