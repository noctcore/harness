import { type IRunDeps, runLinter, WORKFLOW_LINTERS } from '@noctcore/harness/pinned-tools';

const deps: IRunDeps = {
  workflows: () => ['.github/workflows/ci.yml'],
  nativeVersion: () => null, // nothing on PATH
  dockerAvailable: () => false, // and no daemon
  imagePresent: () => false,
  pull: () => false,
  spawn: () => 0,
};

const result = runLinter(WORKFLOW_LINTERS.zizmor, '/repo', deps);
console.log(result.status); // 'blocked'
