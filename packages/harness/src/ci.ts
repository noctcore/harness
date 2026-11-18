/*
 * `@noctcore/harness/ci`: small helpers a CI pipeline runs around its checks.
 * The base commit a run diffs against, the commit range commitlint reads (with
 * an exemption list for history that cannot be rewritten), and a due-date
 * check over dated ledger files for a scheduled job. Pure functions take their
 * I/O as deps; the `node*` functions are the real ones. No network call: the
 * caller looks up the last green run and hands it in.
 */
export type {
  BaseDecision,
  IAffectedBaseOptions,
  IAffectedEnvOptions,
  IBaseDeps,
  IBaseInput,
} from './ci/affected-base.js';
export {
  affectedBaseFrom,
  affectedEnvLines,
  chooseBase,
  decideAffectedBase,
  DEFAULT_WORKSPACE_ROOTS,
  headShaOfLatestRun,
  outsideWorkspaces,
} from './ci/affected-base.js';
export type {
  ICommitRange,
  ICommitRangeInput,
  IExemptCommit,
  LintPlan,
} from './ci/commit-range.js';
export { commitRange, exemptionProblems, exemptionsFor, lintPlan } from './ci/commit-range.js';
export type { ICommitlintCommand, ICommitlintDeps, ICommitlintOptions } from './ci/commitlint.js';
export { runCommitlint } from './ci/commitlint.js';
export type {
  IDueCollection,
  IDueEntry,
  IDueOptions,
  IDueReport,
  IDueSources,
} from './ci/due-dates.js';
export {
  collectDueEntries,
  daysLeft,
  DUE_FAIL_DAYS,
  DUE_LIST_DAYS,
  dueReport,
  formatDueReport,
} from './ci/due-dates.js';
export type { ICiGitDeps } from './ci/git.js';
export { nodeCiGitDeps, nodeIsWorkspace, nodeSpawnInherit, readDueSources } from './ci/git.js';
