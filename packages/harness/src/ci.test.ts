import { describe, expect, test } from 'bun:test';

import * as ci from './ci.js';

describe('@noctcore/harness/ci', () => {
  test('exports the affected-base, commit-range, commitlint, due-dates and node entry points', () => {
    for (const name of [
      'chooseBase',
      'decideAffectedBase',
      'affectedBaseFrom',
      'outsideWorkspaces',
      'headShaOfLatestRun',
      'affectedEnvLines',
      'commitRange',
      'exemptionsFor',
      'exemptionProblems',
      'lintPlan',
      'runCommitlint',
      'collectDueEntries',
      'daysLeft',
      'dueReport',
      'formatDueReport',
      'nodeCiGitDeps',
      'nodeIsWorkspace',
      'nodeSpawnInherit',
      'readDueSources',
    ] as const) {
      expect(typeof ci[name]).toBe('function');
    }
    expect(ci.DEFAULT_WORKSPACE_ROOTS).toEqual(['apps', 'packages']);
    expect([ci.DUE_LIST_DAYS, ci.DUE_FAIL_DAYS]).toEqual([14, 7]);
  });
});
