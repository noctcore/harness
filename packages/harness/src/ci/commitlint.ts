import { exemptionsFor, type IExemptCommit, lintPlan } from './commit-range.js';

/*
 * Run commitlint over a commit range the way `lintPlan` says. commitlint is
 * not a dependency of this package: the caller names the command (usually
 * `process.execPath` plus the path of `@commitlint/cli`'s bin) and its config
 * arguments.
 */

export interface ICommitlintCommand {
  /** The program to start, such as `process.execPath` or `npx`. */
  readonly command: string;
  /** Arguments before the range ones, such as the bin path and `--config <file>`. */
  readonly args: readonly string[];
}

export interface ICommitlintOptions {
  readonly from: string;
  readonly to: string;
  /** The CI event name: a pull request uses no exemption (`exemptionsFor`). */
  readonly event: string;
  /** Commits on a protected branch that may fail the config. Defaults to none. */
  readonly exempt?: readonly IExemptCommit[];
  readonly commitlint: ICommitlintCommand;
}

export interface ICommitlintDeps {
  /** `git rev-list from..to`: the commits in the range, newest first, or null when git cannot list it. */
  readonly commitsIn: (from: string, to: string) => readonly string[] | null;
  /** A commit's full message (`git log -1 --format=%B`), or null when git cannot read it. */
  readonly commitMessage: (sha: string) => string | null;
  /** Run a command, `input` on stdin when given; the exit code, or null when it could not start. */
  readonly spawn: (command: string, args: readonly string[], input?: string) => number | null;
  readonly log: (line: string) => void;
}

function quoteArg(arg: string): string {
  return /^[\w./:=@^~-]+$/u.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * Lint `from..to`: the whole range in one commitlint run, or, when a listed
 * exempt commit is in it, every other commit one by one through stdin.
 * Returns the exit code: 0 only when every linted commit passed. A range git
 * cannot list (an unknown ref) is 1; a range it lists as empty (a rerun of a
 * head that is already the last green one) is 0, since no commit in it goes
 * unlinted. Every command is logged before it runs.
 */
export function runCommitlint(options: ICommitlintOptions, deps: ICommitlintDeps): number {
  const { from, to } = options;
  const shas = deps.commitsIn(from, to);
  if (shas === null) {
    deps.log(`commitlint: git cannot list ${from}..${to}: fetch the full history (fetch-depth: 0)`);
    return 1;
  }
  if (shas.length === 0) {
    deps.log(`commitlint: ${from}..${to} holds no commit, nothing to lint`);
    return 0;
  }
  const plan = lintPlan(
    options,
    shas,
    (sha) => deps.commitMessage(sha) ?? '',
    exemptionsFor(options.event, options.exempt ?? []),
  );
  if (plan.kind === 'refused') {
    for (const problem of plan.problems) deps.log(`commitlint: ${problem}`);
    deps.log('commitlint: failed (fix the exemption list before the range can be linted)');
    return 1;
  }
  const run = (args: readonly string[], input?: string): number => {
    const all = [...options.commitlint.args, ...args];
    deps.log(`→ ${[options.commitlint.command, ...all].map(quoteArg).join(' ')}`);
    return deps.spawn(options.commitlint.command, all, input) ?? 1;
  };

  if (plan.kind === 'range') {
    deps.log(`commitlint: ${String(shas.length)} commit(s) in ${plan.from}..${plan.to}`);
    return run(['--from', plan.from, '--to', plan.to, '--verbose']) === 0 ? 0 : 1;
  }
  deps.log(
    `commitlint: skipping exempt ${plan.skipped.join(', ')}; linting ${String(plan.shas.length)} commit(s) one by one`,
  );
  let failed = 0;
  for (const sha of plan.shas) {
    const message = deps.commitMessage(sha);
    if (message === null) {
      deps.log(`commitlint: git cannot read the message of ${sha}`);
      failed += 1;
      continue;
    }
    deps.log(`commitlint: ${sha}`);
    if (run(['--verbose'], message) !== 0) {
      deps.log(`commitlint: ${sha} fails`);
      failed += 1;
    }
  }
  return failed === 0 ? 0 : 1;
}
