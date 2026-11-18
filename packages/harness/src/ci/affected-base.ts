/*
 * The commit a CI run diffs against to decide what is affected, decided once
 * per run.
 *
 * A filter such as turbo `--affected` skips every package unchanged since the
 * base. That is only honest when the base is a commit a completed run already
 * proved green:
 *
 * - pull_request: the pull request's base. The push run after the merge is
 *   what covers the target branch.
 * - push: the head of the LAST SUCCESSFUL push run of the workflow on the
 *   branch. Not the previous tip (`github.event.before`): push A then push B
 *   while A's run is still pending replaces A's run, and a base of A would
 *   test only A..B, so A's changes never got a completed run. After a red run
 *   the next push would go green against a base that is still red.
 * - any other event (workflow_dispatch, schedule): no filter, everything runs.
 *
 * A diff that touches anything outside a real workspace also runs everything:
 * a workspace filter only sees changes inside a workspace, so a change to a
 * root config, the lockfile or a script folder marks nothing affected although
 * the gated steps depend on it.
 *
 * Every doubt answers "run everything": no successful run yet, the lookup
 * failing, a green sha this clone cannot reach (a force push rewrote it), or a
 * diff that cannot be read. A full run costs minutes; a wrong base reports
 * green for suites that never ran.
 */

export interface IBaseInput {
  /** The CI event name, such as `GITHUB_EVENT_NAME`. */
  readonly event: string;
  /** The pull request's base sha, or '' outside a pull request. */
  readonly prBaseSha: string;
  /** The previous tip on a push (`github.event.before`): reported, never used as the base. */
  readonly before: string;
}

export interface IBaseDeps {
  /** Head sha of the last successful push run of this workflow on this branch, or null if none. */
  readonly lastGreenPushSha: () => Promise<string | null>;
  /** Whether `sha` is an ancestor of the checked-out HEAD. */
  readonly isAncestor: (sha: string) => boolean;
  /** Paths changed between `base` and HEAD (renames as both paths), or null when git cannot tell. */
  readonly changedFiles: (base: string) => readonly string[] | null;
  /** Whether a folder such as `packages/ui` is a workspace, that is, has a package.json. */
  readonly isWorkspace: (dir: string) => boolean;
}

export interface IAffectedBaseOptions {
  /**
   * The folders whose direct children are workspaces, with `/` separators.
   * Defaults to `['apps', 'packages']`.
   */
  readonly workspaceRoots?: readonly string[];
}

export type BaseDecision =
  | { readonly kind: 'affected'; readonly base: string; readonly reason: string }
  | { readonly kind: 'full'; readonly reason: string };

export interface IAffectedEnvOptions {
  /** The variable that carries the base sha. Defaults to `TURBO_SCM_BASE`. */
  readonly baseVar?: string;
  /** The variable that carries the filter flag. Defaults to `TURBO_AFFECTED`. */
  readonly flagVar?: string;
  /** The flag value on a filtered run. Defaults to `--affected`. */
  readonly flagValue?: string;
}

/** The workspace roots used when none are given. */
export const DEFAULT_WORKSPACE_ROOTS: readonly string[] = ['apps', 'packages'];

/** How many outside paths a full-run reason names before it counts the rest. */
const SHOWN_PATHS = 5;

const SHA = /^[0-9a-f]{40}$/u;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimSlashes(root: string): string {
  return root.replace(/^\/+|\/+$/gu, '');
}

/** The workspace folder (`<root>/<name>`) a path sits in, if it is under one of the roots. */
function workspaceFolder(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const prefix = `${trimSlashes(root)}/`;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    // A file directly in the root (`packages/README.md`) is not inside a workspace.
    if (slash > 0 && slash < rest.length - 1) return `${prefix}${rest.slice(0, slash)}`;
  }
  return undefined;
}

/**
 * The changed paths a workspace filter cannot see: everything that is not
 * inside a real workspace. A folder under a workspace root counts only when
 * `isWorkspace` says so; a stray folder, or a workspace whose package.json is
 * gone, is as invisible to the filter as a root file.
 */
export function outsideWorkspaces(
  paths: readonly string[],
  isWorkspace: (dir: string) => boolean,
  options: IAffectedBaseOptions = {},
): string[] {
  const roots = options.workspaceRoots ?? DEFAULT_WORKSPACE_ROOTS;
  return paths.filter((path) => {
    const folder = workspaceFolder(path, roots);
    return folder === undefined || !isWorkspace(folder);
  });
}

/**
 * Keep a filtered decision only when every change since its base is inside a
 * workspace; `chosen` is what `chooseBase` picked.
 */
export function affectedBaseFrom(
  chosen: BaseDecision,
  deps: Pick<IBaseDeps, 'changedFiles' | 'isWorkspace'>,
  options: IAffectedBaseOptions = {},
): BaseDecision {
  if (chosen.kind !== 'affected') return chosen;
  const changed = deps.changedFiles(chosen.base);
  if (changed === null) {
    return {
      kind: 'full',
      reason: `could not list the files changed since ${chosen.base}: running everything`,
    };
  }
  const outside = outsideWorkspaces(changed, deps.isWorkspace, options);
  if (outside.length > 0) {
    const roots = (options.workspaceRoots ?? DEFAULT_WORKSPACE_ROOTS)
      .map((root) => `${trimSlashes(root)}/*`)
      .join(', ');
    const shown = outside.slice(0, SHOWN_PATHS).join(', ');
    const more =
      outside.length > SHOWN_PATHS ? ` and ${String(outside.length - SHOWN_PATHS)} more` : '';
    return {
      kind: 'full',
      reason: `changes outside the workspaces (${roots}) since ${chosen.base} (${shown}${more}), which a workspace filter cannot see: running everything`,
    };
  }
  return chosen;
}

/**
 * The base before the diff check: the proven commit a filtered run would diff
 * against. `affectedBaseFrom` may still turn it into a full run; the commit
 * range commitlint reads (`commitRange`) starts from it either way.
 */
export async function chooseBase(
  input: IBaseInput,
  deps: Pick<IBaseDeps, 'lastGreenPushSha' | 'isAncestor'>,
): Promise<BaseDecision> {
  if (input.event === 'pull_request') {
    return SHA.test(input.prBaseSha)
      ? {
          kind: 'affected',
          base: input.prBaseSha,
          reason: 'pull request: diffing against its base',
        }
      : { kind: 'full', reason: 'pull request without a readable base sha: running everything' };
  }
  if (input.event !== 'push') {
    return { kind: 'full', reason: `${input.event || 'unknown event'}: running everything` };
  }

  let green: string | null;
  try {
    green = await deps.lastGreenPushSha();
  } catch (error) {
    return {
      kind: 'full',
      reason: `could not look up the last successful push run (${errorText(error)}): running everything`,
    };
  }
  if (green === null) {
    return {
      kind: 'full',
      reason: 'no successful push run on this branch yet: running everything',
    };
  }
  if (!SHA.test(green) || !deps.isAncestor(green)) {
    return {
      kind: 'full',
      reason: `the last successful push run's head ${green} is not an ancestor of HEAD: running everything`,
    };
  }
  return {
    kind: 'affected',
    base: green,
    reason: `push: diffing against the last successful push run's head ${green} (previous tip was ${input.before || 'unknown'})`,
  };
}

/** `chooseBase` followed by `affectedBaseFrom`: the base a filtered run uses, or a full run. */
export async function decideAffectedBase(
  input: IBaseInput,
  deps: IBaseDeps,
  options: IAffectedBaseOptions = {},
): Promise<BaseDecision> {
  return affectedBaseFrom(await chooseBase(input, deps), deps, options);
}

/**
 * The head sha of the first run in a GitHub "list workflow runs" response, or
 * null when the list is empty. Anything that is not that shape throws, and
 * `chooseBase` reads a throwing lookup as "run everything". Ask the API for
 * `status=success&event=push&branch=<branch>&per_page=1`.
 */
export function headShaOfLatestRun(body: unknown): string | null {
  const runs = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error('the response has no workflow_runs list');
  }
  if (runs.length === 0) return null;
  const sha = (runs[0] as { head_sha?: unknown } | null)?.head_sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    throw new Error(`the latest run's head_sha is not a commit sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * The `GITHUB_ENV` lines for a decision. A full run sets both variables
 * empty, so a step that reads them runs everything.
 */
export function affectedEnvLines(
  decision: BaseDecision,
  options: IAffectedEnvOptions = {},
): string[] {
  const baseVar = options.baseVar ?? 'TURBO_SCM_BASE';
  const flagVar = options.flagVar ?? 'TURBO_AFFECTED';
  const flagValue = options.flagValue ?? '--affected';
  return decision.kind === 'affected'
    ? [`${baseVar}=${decision.base}`, `${flagVar}=${flagValue}`]
    : [`${baseVar}=`, `${flagVar}=`];
}
