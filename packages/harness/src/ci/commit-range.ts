import type { BaseDecision } from './affected-base.js';

/*
 * Which commits a CI commitlint step reads, decided next to the affected base
 * and from the same facts.
 *
 * - pull_request: the pull request's base to its head. Never HEAD: a checkout
 *   of a pull request is the synthetic merge commit, whose `Merge <sha> into
 *   <sha>` subject nobody wrote.
 * - push: from the head of the last successful push run (the commit the path
 *   filter already trusts) to HEAD, so the commits of a push whose run failed,
 *   was replaced or was cancelled are read again by the next one. Without a
 *   usable green base, the pushed range (`before..HEAD`) when `before` is an
 *   ancestor of HEAD. That fallback reads only this push: accepted on purpose,
 *   a GitHub API blip must not turn the default branch red.
 * - otherwise (workflow_dispatch, a new branch, a `before` this clone cannot
 *   reach): HEAD alone.
 *
 * A commit-msg hook checks each commit as it is written; this is the check a
 * `--no-verify` commit cannot skip. History before the range is never read, so
 * commits that predate a rule stay as they are.
 */
export interface ICommitRangeInput {
  /** The CI event name, such as `GITHUB_EVENT_NAME`. */
  readonly event: string;
  readonly prBaseSha: string;
  readonly prHeadSha: string;
  /** The previous tip on a push (`github.event.before`). */
  readonly before: string;
}

export interface ICommitRange {
  /** Exclusive: commitlint reads `from..to`. */
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

const SHA = /^[0-9a-f]{40}$/u;
/** What `github.event.before` is on the first push of a branch. */
const NO_COMMIT = /^0{40}$/u;

function headOnly(reason: string): ICommitRange {
  return { from: 'HEAD~1', to: 'HEAD', reason };
}

/**
 * The range to lint. `chosen` is the affected base before the diff check
 * (`chooseBase`): a full run still has a proven base for commits even when a
 * workspace filter cannot use it.
 */
export function commitRange(
  input: ICommitRangeInput,
  chosen: BaseDecision,
  isAncestor: (sha: string) => boolean,
): ICommitRange {
  if (input.event === 'pull_request') {
    if (SHA.test(input.prBaseSha) && SHA.test(input.prHeadSha)) {
      return { from: input.prBaseSha, to: input.prHeadSha, reason: 'pull request: base to head' };
    }
    // The merge commit's parents are the base and the pull request's head.
    return {
      from: 'HEAD^1',
      to: 'HEAD^2',
      reason: "pull request without readable shas: the merge commit's parents",
    };
  }
  if (input.event !== 'push') {
    return headOnly(`${input.event || 'unknown event'}: HEAD alone`);
  }
  if (chosen.kind === 'affected') {
    return {
      from: chosen.base,
      to: 'HEAD',
      reason: `push: every commit since the last successful push run's head ${chosen.base}`,
    };
  }
  if (SHA.test(input.before) && !NO_COMMIT.test(input.before) && isAncestor(input.before)) {
    return {
      from: input.before,
      to: 'HEAD',
      reason: `push without a usable green base: the pushed range from ${input.before}`,
    };
  }
  return headOnly('push without a usable green base or previous tip: HEAD alone');
}

/**
 * A commit already on a protected branch that fails the commitlint config,
 * skipped by its full sha. CI lints every commit since the last successful
 * push run and a protected branch cannot be force-pushed, so one such commit
 * (a `--no-verify` commit, a merge message typed in a web UI) would keep CI
 * red for good. `message` is the message exactly as
 * `git log -1 --format=%B <sha>` prints it: a cross-check, never the key.
 */
export interface IExemptCommit {
  readonly sha: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * The exemptions an event may use: none on a pull request, since a commit
 * already on the base branch is never in a pull request's range and a pull
 * request must not exempt its own commits.
 */
export function exemptionsFor(
  event: string,
  exempt: readonly IExemptCommit[],
): readonly IExemptCommit[] {
  return event === 'pull_request' ? [] : exempt;
}

/** Why an exemption list is malformed: every entry a full sha, a reason and a message, each sha once. */
export function exemptionProblems(entries: readonly IExemptCommit[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!SHA.test(entry.sha)) problems.push(`"${entry.sha}" is not a full 40-character sha`);
    if (entry.reason.trim() === '') problems.push(`${entry.sha} gives no reason`);
    if (entry.message.trim() === '') problems.push(`${entry.sha} records no message`);
    if (seen.has(entry.sha)) problems.push(`${entry.sha} is listed twice`);
    seen.add(entry.sha);
  }
  return problems;
}

export type LintPlan =
  /** No listed commit in range: one commitlint run over `from..to`. */
  | { readonly kind: 'range'; readonly from: string; readonly to: string }
  /** A listed commit is in range: every other commit, one by one. */
  | {
      readonly kind: 'commits';
      readonly shas: readonly string[];
      readonly skipped: readonly string[];
    }
  | { readonly kind: 'refused'; readonly problems: readonly string[] };

/**
 * What the commitlint step lints. `inRange` is `git rev-list from..to`. A
 * listed sha in range is skipped only when its message still matches the
 * entry; a commit that is not listed is linted whatever its message, so
 * another commit with the same message as an exempt one is not exempt. A
 * listed sha outside the range changes nothing.
 */
export function lintPlan(
  range: Pick<ICommitRange, 'from' | 'to'>,
  inRange: readonly string[],
  messageOf: (sha: string) => string,
  exempt: readonly IExemptCommit[],
): LintPlan {
  const malformed = exemptionProblems(exempt);
  if (malformed.length > 0) return { kind: 'refused', problems: malformed };
  const listed = exempt.filter((entry) => inRange.includes(entry.sha));
  if (listed.length === 0) return { kind: 'range', from: range.from, to: range.to };
  const problems = listed
    .filter((entry) => messageOf(entry.sha).trim() !== entry.message.trim())
    .map((entry) => `${entry.sha} is exempt, but its message is not the one recorded for it`);
  if (problems.length > 0) return { kind: 'refused', problems };
  const skipped = listed.map((entry) => entry.sha);
  return { kind: 'commits', shas: inRange.filter((sha) => !skipped.includes(sha)), skipped };
}
