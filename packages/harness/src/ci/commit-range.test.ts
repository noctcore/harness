import { describe, expect, test } from 'bun:test';

import type { BaseDecision } from './affected-base.js';
import {
  commitRange,
  exemptionProblems,
  exemptionsFor,
  type ICommitRangeInput,
  type IExemptCommit,
  lintPlan,
} from './commit-range.js';

const GREEN = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const PR_BASE = 'c'.repeat(40);
const PR_HEAD = 'd'.repeat(40);
const ZERO = '0'.repeat(40);

const AFFECTED: BaseDecision = { kind: 'affected', base: GREEN, reason: '' };
const FULL: BaseDecision = { kind: 'full', reason: '' };

function input(overrides: Partial<ICommitRangeInput> = {}): ICommitRangeInput {
  return { event: 'push', prBaseSha: '', prHeadSha: '', before: BEFORE, ...overrides };
}

describe('commitRange', () => {
  test('a pull request reads base to head, never the merge commit', () => {
    const range = commitRange(
      input({ event: 'pull_request', prBaseSha: PR_BASE, prHeadSha: PR_HEAD }),
      AFFECTED,
      () => true,
    );
    expect(range).toEqual({ from: PR_BASE, to: PR_HEAD, reason: 'pull request: base to head' });
  });

  test('a pull request without readable shas reads the merge commit parents', () => {
    const range = commitRange(
      input({ event: 'pull_request', prBaseSha: PR_BASE, prHeadSha: '' }),
      FULL,
      () => true,
    );
    expect([range.from, range.to]).toEqual(['HEAD^1', 'HEAD^2']);
  });

  test('a push with a green base reads from it to HEAD', () => {
    const range = commitRange(input(), AFFECTED, () => true);
    expect([range.from, range.to]).toEqual([GREEN, 'HEAD']);
  });

  test('a push without a green base falls back to the pushed range', () => {
    const range = commitRange(input(), FULL, (sha) => sha === BEFORE);
    expect([range.from, range.to]).toEqual([BEFORE, 'HEAD']);
    expect(range.reason).toContain('pushed range');
  });

  test('the first push of a branch reads HEAD alone', () => {
    const range = commitRange(input({ before: ZERO }), FULL, () => true);
    expect([range.from, range.to]).toEqual(['HEAD~1', 'HEAD']);
  });

  test('a previous tip this clone cannot reach reads HEAD alone', () => {
    const range = commitRange(input(), FULL, () => false);
    expect([range.from, range.to]).toEqual(['HEAD~1', 'HEAD']);
  });

  test('a previous tip that is not a sha reads HEAD alone', () => {
    const range = commitRange(input({ before: 'HEAD~5' }), FULL, () => true);
    expect(range.from).toBe('HEAD~1');
  });

  test('another event reads HEAD alone', () => {
    expect(commitRange(input({ event: 'workflow_dispatch' }), AFFECTED, () => true)).toEqual({
      from: 'HEAD~1',
      to: 'HEAD',
      reason: 'workflow_dispatch: HEAD alone',
    });
    expect(commitRange(input({ event: '' }), AFFECTED, () => true).reason).toBe(
      'unknown event: HEAD alone',
    );
  });
});

const EXEMPT: IExemptCommit = {
  sha: 'e'.repeat(40),
  reason: 'pushed without the commit-msg hook; the branch cannot be force-pushed',
  message: 'Fix things\n\nA body line that is far too long for the config.',
};

describe('exemptionsFor', () => {
  test('a pull request uses no exemption', () => {
    expect(exemptionsFor('pull_request', [EXEMPT])).toEqual([]);
  });

  test('a push uses the list', () => {
    expect(exemptionsFor('push', [EXEMPT])).toEqual([EXEMPT]);
  });
});

describe('exemptionProblems', () => {
  test('a well-formed list has none', () => {
    expect(exemptionProblems([EXEMPT])).toEqual([]);
  });

  test('names a short sha, a blank reason, a blank message and a duplicate', () => {
    const problems = exemptionProblems([
      { sha: 'abc123', reason: ' ', message: '' },
      EXEMPT,
      EXEMPT,
    ]);
    expect(problems).toEqual([
      '"abc123" is not a full 40-character sha',
      'abc123 gives no reason',
      'abc123 records no message',
      `${EXEMPT.sha} is listed twice`,
    ]);
  });
});

describe('lintPlan', () => {
  const range = { from: GREEN, to: 'HEAD' };
  const other = 'f'.repeat(40);

  test('with no listed commit in range it lints the range in one run', () => {
    expect(lintPlan(range, [other], () => '', [EXEMPT])).toEqual({
      kind: 'range',
      from: GREEN,
      to: 'HEAD',
    });
  });

  test('with no exemptions it lints the range', () => {
    expect(lintPlan(range, [other], () => '', []).kind).toBe('range');
  });

  test('with a listed commit in range it lints every other one by one', () => {
    const plan = lintPlan(range, [other, EXEMPT.sha], () => `${EXEMPT.message}\n`, [EXEMPT]);
    expect(plan).toEqual({ kind: 'commits', shas: [other], skipped: [EXEMPT.sha] });
  });

  test('refuses when a listed commit message no longer matches', () => {
    const plan = lintPlan(range, [EXEMPT.sha], () => 'feat(x): something else', [EXEMPT]);
    expect(plan).toEqual({
      kind: 'refused',
      problems: [`${EXEMPT.sha} is exempt, but its message is not the one recorded for it`],
    });
  });

  test('refuses a malformed list before reading any message', () => {
    const plan = lintPlan(
      range,
      [other],
      () => {
        throw new Error('asked');
      },
      [{ ...EXEMPT, sha: 'short' }],
    );
    expect(plan.kind).toBe('refused');
  });
});
