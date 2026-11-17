import { readFileSync } from 'node:fs';

import {
  exitCodeFor,
  nodeGitleaksDeps,
  pinnedGitleaksVersion,
  runGitleaks,
} from '@noctcore/harness/pinned-tools';

const workflow = '.github/workflows/security-gitleaks.yml';
const version = pinnedGitleaksVersion(readFileSync(workflow, 'utf8'));
const root = process.cwd();
const result = runGitleaks(version, root, nodeGitleaksDeps(root), { versionSource: workflow });
console.log(`gitleaks: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status));
