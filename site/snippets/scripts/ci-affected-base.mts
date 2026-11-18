import { appendFileSync } from 'node:fs';

import {
  affectedEnvLines,
  chooseBase,
  affectedBaseFrom,
  commitRange,
  headShaOfLatestRun,
  nodeCiGitDeps,
  nodeIsWorkspace,
} from '@noctcore/harness/ci';

const env = process.env;
const root = process.cwd();
const git = nodeCiGitDeps(root);

// The GitHub lookup lives in your repo: the package makes no network call.
async function lastGreenPushSha(): Promise<string | null> {
  const query = new URLSearchParams({
    branch: env.GITHUB_REF_NAME ?? '',
    event: 'push',
    status: 'success',
    per_page: '1',
  });
  const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?${query.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return headShaOfLatestRun(await response.json());
}

const input = {
  event: env.GITHUB_EVENT_NAME ?? '',
  prBaseSha: env.PR_BASE_SHA ?? '',
  prHeadSha: env.PR_HEAD_SHA ?? '',
  before: env.PUSH_BEFORE ?? '',
};
const chosen = await chooseBase(input, { lastGreenPushSha, isAncestor: git.isAncestor });
const decision = affectedBaseFrom(chosen, {
  changedFiles: git.changedFiles,
  isWorkspace: nodeIsWorkspace(root),
});
const range = commitRange(input, chosen, git.isAncestor);

console.log(`affected-base: ${decision.reason}`);
console.log(`commit range: ${range.from}..${range.to} (${range.reason})`);
const lines = [...affectedEnvLines(decision), `LINT_FROM=${range.from}`, `LINT_TO=${range.to}`];
if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${lines.join('\n')}\n`);
