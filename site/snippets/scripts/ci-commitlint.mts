import { createRequire } from 'node:module';

import {
  type IExemptCommit,
  nodeCiGitDeps,
  nodeSpawnInherit,
  runCommitlint,
} from '@noctcore/harness/ci';

// Commits already on main that fail the config and cannot be rewritten.
// Each entry needs the full sha, a reason and the message as `git log -1 --format=%B` prints it.
const EXEMPT: readonly IExemptCommit[] = [];

const root = process.cwd();
const git = nodeCiGitDeps(root);
const bin = createRequire(import.meta.url).resolve('@commitlint/cli/cli.js');

const code = runCommitlint(
  {
    from: process.env.LINT_FROM ?? 'HEAD~1',
    to: process.env.LINT_TO ?? 'HEAD',
    event: process.env.GITHUB_EVENT_NAME ?? '',
    exempt: EXEMPT,
    commitlint: { command: process.execPath, args: [bin, '--config', 'commitlint.config.js'] },
  },
  { ...git, spawn: nodeSpawnInherit(root), log: (line) => console.log(line) },
);
process.exit(code);
