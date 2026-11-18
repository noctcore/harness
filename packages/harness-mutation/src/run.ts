import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type IChangedPlan,
  judgeChanged,
  mutated,
  mutatePatterns,
  nothingToCheck,
  parseDiff,
  planChangedRun,
} from './changed.js';
import {
  directiveLines,
  expiredEntries,
  type IAcceptedMutant,
  LEDGER_FILE,
  parseLedger,
  utcDay,
} from './ledger.js';
import {
  BASELINE_FILE,
  type BaselineObservation,
  parseBaseline,
  serializeBaseline,
} from './ratchet.js';
import { type IConfigFacts, type IMutationVerdict, judgeRun, preflight } from './verdict.js';

/*
 * One mutation run, start to verdict, with every side effect handed in: the
 * config import, the files read, written and removed, git, Stryker itself.
 * node.ts supplies the real ones; the tests supply fakes, so what is refused
 * before a file is deleted, what a run may write and which runs are held to
 * the baseline is decided here and proven here.
 */

/** The ref a changed-line run diffs against (its merge base with HEAD), by default. */
export const DEFAULT_BASE_REF = 'origin/main';

/** The Stryker config file name in a target package, by default. */
export const CONFIG_FILE = 'stryker.config.mjs';

/**
 * Where every mutation report has to live, relative to the repo root, by
 * default. The runner deletes the report before each run, so it refuses a
 * report path outside this directory.
 */
export const REPORT_DIR = '.noctcore/mutation';

/** A package mutation testing runs on, with its own Stryker config. */
export interface IMutationTarget {
  /** The package directory, relative to the repo root, `/`-separated. */
  readonly dir: string;
  /** The verdict line's prefix for a whole-package run. */
  readonly checkId: string;
  /** Whether a whole-package run is judged against the baseline file in `dir`; else record-only. */
  readonly ratchet: boolean;
  /** The verdict prefix of this target's changed-line run, or null when it has none. */
  readonly changedCheckId: string | null;
}

export interface IMutationRequest {
  readonly target: IMutationTarget;
  /** A Stryker config other than the package's own, relative to the package. A partial run: never judged. */
  readonly config?: string | null;
  /** A record-only target: judge every mutant again instead of reusing the incremental file. */
  readonly force?: boolean;
  /** A ratchet target: reuse the incremental file (the run is then not judged against the baseline). */
  readonly incremental?: boolean;
  /** Write the measured score as the baseline, from a complete run. */
  readonly accept?: boolean;
  /** With `accept`: allow the baseline to go down past the tolerance. */
  readonly allowLowering?: boolean;
  /**
   * A changed-line run against the merge base of HEAD and `baseRef` (default
   * {@link DEFAULT_BASE_REF}); absent or null for a whole-package run.
   */
  readonly changed?: { readonly baseRef?: string } | null;
  /** The Stryker config in the target package. Defaults to {@link CONFIG_FILE}. */
  readonly configFile?: string;
  /** The baseline in the target package. Defaults to `mutation-baseline.json`. */
  readonly baselineFile?: string;
  /** The ledger in the target package. Defaults to `mutation-ledger.json`. */
  readonly ledgerFile?: string;
  /** Where reports must live, repo-relative. Defaults to {@link REPORT_DIR}. */
  readonly reportDir?: string;
  /** Repo-relative path prefixes a changed-line run never mutates. Defaults to none. */
  readonly neverMutate?: readonly string[];
  /** Points under the baseline that still pass. Defaults to 1. */
  readonly dropTolerance?: number;
  /** Points over the baseline before it is stale. Defaults to 2. */
  readonly staleMargin?: number;
  /** How to record a new baseline, in failure messages (your own command, say). */
  readonly acceptHint?: string;
}

/**
 * Whether Stryker may reuse the results of its incremental file. A target held
 * to a baseline judges every mutant again unless `incremental` asks otherwise:
 * the file is a per-worktree cache, and a stale one can give the same commit a
 * lower score than a fresh run. A record-only target keeps reusing unless
 * `force` says not to.
 */
export function reusesResults(request: IMutationRequest): boolean {
  return request.target.ratchet ? request.incremental === true : request.force !== true;
}

/**
 * Why a request cannot be run as asked, or null when it can. Decided before
 * Stryker starts, so a run that could never be accepted does not spend its
 * minutes first.
 */
export function requestRefusal(request: IMutationRequest): IMutationVerdict | null {
  const blocked = (reason: string): IMutationVerdict => ({ status: 'blocked', reason });
  const configFile = request.configFile ?? CONFIG_FILE;
  const config = request.config ?? null;
  if (request.allowLowering === true && request.accept !== true) {
    return blocked('allowLowering only means something with accept');
  }
  if (request.force === true && request.incremental === true) {
    return blocked('force and incremental ask for opposite things');
  }
  if (request.changed != null) {
    if (request.target.changedCheckId === null) {
      return blocked(`changed: ${request.target.checkId} has no changed-line run`);
    }
    const extra = (
      [
        ['accept', request.accept === true],
        ['config', config !== null],
        ['force', request.force === true],
        ['incremental', request.incremental === true],
      ] as const
    )
      .filter(([, set]) => set)
      .map(([flag]) => flag);
    if (extra.length > 0) {
      return blocked(
        `a changed-line run takes no ${extra.join(', ')}: it is partial, uses the package's own ${configFile} and reuses nothing`,
      );
    }
    return null;
  }
  if (request.accept === true && !request.target.ratchet) {
    return blocked(`accept: ${request.target.checkId} has no baseline, its score is record-only`);
  }
  if (request.accept === true && config !== null) {
    return blocked(
      `accept judges the package's own ${configFile}: a run of another config is a partial run`,
    );
  }
  if (request.accept === true && request.incremental === true) {
    return blocked('accept needs a run that judged every mutant again: drop incremental');
  }
  return null;
}

/**
 * The run-relevant facts of a loaded Stryker config module (its default
 * export), for `preflight` in verdict.ts. A config that is not a plain object
 * yields empty facts, which preflight fails.
 */
export function configFacts(module: unknown): IConfigFacts {
  const config = plainObject(plainObject(module)?.['default']);
  return {
    testRunner: config?.['testRunner'],
    plugins: config?.['plugins'],
    reporters: config?.['reporters'],
    jsonReportFile: plainObject(config?.['jsonReporter'])?.['fileName'],
    mutate: config?.['mutate'],
  };
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Why the report file a Stryker config names must not be deleted, or null
 * when it may. The runner removes the report before each run, so a config that
 * pointed `jsonReporter.fileName` anywhere else would delete that file: only a
 * path strictly inside `reportDir` (repo-relative) is accepted.
 */
export function reportFileRefusal(
  root: string,
  file: string,
  reportDir: string = REPORT_DIR,
): IMutationVerdict | null {
  const inside = relative(resolve(root, reportDir), file);
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return null;
  return {
    status: 'failed',
    reason: `the JSON report ${file} is not under ${reportDir}/, so it is not deleted or read`,
  };
}

export interface IGitResult {
  readonly status: number;
  /** What git printed; null when it could not be started at all. */
  readonly stdout: string | null;
}

/** What a Stryker process left behind besides its report. */
export interface IStrykerExit {
  /** Its exit code: 127 when it could not be started, 128 + n when signal n ended it. */
  readonly exitCode: number;
  /** Everything it printed, when the caller asked for it to be captured; else null. */
  readonly output: string | null;
}

export interface IMutationDeps {
  /** The repository root, absolute. */
  readonly root: string;
  /** The module a Stryker config file exports (a dynamic import). */
  readonly loadConfig: (file: string) => Promise<unknown>;
  /** Whether a package resolves from `packageDir`, the way Stryker loads its plugins. */
  readonly installed: (packageDir: string) => (name: string) => boolean;
  /** The text of a file, or null when it does not exist. */
  readonly readFile: (file: string) => string | null;
  /** Write a file, creating the directories above it. */
  readonly writeFile: (file: string, text: string) => void;
  /** Remove a file; one that is not there is not an error. */
  readonly removeFile: (file: string) => void;
  /**
   * Run Stryker with `packageDir` as its cwd. With `capture` its output is
   * collected (and printed once it has ended) instead of streamed: a
   * changed-line run reads Stryker's own count of what it instrumented.
   */
  readonly stryker: (
    packageDir: string,
    args: readonly string[],
    capture: boolean,
  ) => Promise<IStrykerExit>;
  /** Run git at the repository root, no shell; a git that cannot start is a non-zero status. */
  readonly git: (args: readonly string[]) => IGitResult;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export interface IMutationOutcome {
  /** The prefix of the verdict line. */
  readonly checkId: string;
  readonly verdict: IMutationVerdict;
}

function readBaseline(text: string | null): BaselineObservation {
  if (text === null) return null;
  try {
    return parseBaseline(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The package's accepted mutants; none when it has no ledger file. Entries past review fail. */
function readLedger(
  request: IMutationRequest,
  deps: IMutationDeps,
  packageDir: string,
): readonly IAcceptedMutant[] | { readonly verdict: IMutationVerdict } {
  const ledgerFile = request.ledgerFile ?? LEDGER_FILE;
  const text = deps.readFile(join(packageDir, ledgerFile));
  if (text === null) return [];
  let entries: IAcceptedMutant[];
  try {
    entries = parseLedger(text);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { verdict: { status: 'blocked', reason: `unreadable ${ledgerFile}: ${why}` } };
  }
  const expired = expiredEntries(entries, utcDay(deps.now()), ledgerFile);
  if (expired.length > 0) {
    return {
      verdict: {
        status: 'failed',
        reason: `${String(expired.length)} ${ledgerFile} ${expired.length === 1 ? 'entry is' : 'entries are'} past their review date`,
        details: expired,
      },
    };
  }
  return entries;
}

interface ILoadedConfig {
  /** The config's default export, as loaded. */
  readonly config: unknown;
  readonly facts: IConfigFacts;
}

async function loadConfig(
  deps: IMutationDeps,
  packageDir: string,
  configPath: string,
): Promise<ILoadedConfig | { readonly verdict: IMutationVerdict }> {
  let module: unknown;
  try {
    module = await deps.loadConfig(configPath);
  } catch (error) {
    const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      verdict: {
        status: 'failed',
        reason: `${relative(deps.root, configPath)} cannot be loaded: ${why}`,
      },
    };
  }
  const facts = configFacts(module);
  const refused = preflight(facts, deps.installed(packageDir));
  if (refused !== null) return { verdict: refused };
  return { config: (module as { default?: unknown } | null)?.default, facts };
}

interface IStrykerRun extends IStrykerExit {
  readonly report: string | null;
  readonly durationMs: number;
}

/**
 * Run Stryker and hand back what it left. The report is removed before the
 * run, so whatever is read afterwards was written by this run. That makes the
 * report path a path this deletes: it is checked first, and a refusal ends the
 * run with the file still there. The command is printed before it starts.
 */
async function strykerRun(
  request: IMutationRequest,
  deps: IMutationDeps,
  packageDir: string,
  reportFile: string,
  args: readonly string[],
  capture: boolean,
): Promise<IStrykerRun | { readonly verdict: IMutationVerdict }> {
  const outside = reportFileRefusal(deps.root, reportFile, request.reportDir);
  if (outside !== null) return { verdict: outside };
  deps.removeFile(reportFile);

  deps.log(`$ stryker ${args.join(' ')} (in ${relative(deps.root, packageDir) || '.'})`);
  const startedAt = deps.now();
  const { exitCode, output } = await deps.stryker(packageDir, args, capture);
  const durationMs = deps.now() - startedAt;
  const report = deps.readFile(reportFile);
  if (report !== null) {
    deps.log(`Mutation report: ${relative(deps.root, reportFile)}`);
  }
  return { exitCode, output, report, durationMs };
}

async function runPackage(
  request: IMutationRequest,
  deps: IMutationDeps,
): Promise<IMutationVerdict> {
  const { target } = request;
  const config = request.config ?? null;
  const packageDir = resolve(deps.root, target.dir);
  const configPath = resolve(packageDir, config ?? request.configFile ?? CONFIG_FILE);
  const loaded = await loadConfig(deps, packageDir, configPath);
  if ('verdict' in loaded) return loaded.verdict;

  const reuse = reusesResults(request);
  // Only a run of the package's own config that judged every mutant again
  // says anything about the baseline or the ledger.
  const fresh = config === null && !reuse;
  const ledger = fresh ? readLedger(request, deps, packageDir) : null;
  if (ledger !== null && 'verdict' in ledger) return ledger.verdict;

  const ran = await strykerRun(
    request,
    deps,
    packageDir,
    resolve(packageDir, String(loaded.facts.jsonReportFile)),
    ['run', configPath, ...(reuse ? [] : ['--force'])],
    false,
  );
  if ('verdict' in ran) return ran.verdict;

  const judged = fresh && target.ratchet;
  const baselineName = request.baselineFile ?? BASELINE_FILE;
  const baselineFile = join(packageDir, baselineName);
  const verdict = judgeRun(
    ran,
    judged
      ? {
          baseline: readBaseline(deps.readFile(baselineFile)),
          accept: request.accept === true,
          allowLowering: request.allowLowering === true,
          baselineFile: baselineName,
          ...(request.acceptHint === undefined ? {} : { acceptHint: request.acceptHint }),
          ...(request.dropTolerance === undefined ? {} : { dropTolerance: request.dropTolerance }),
          ...(request.staleMargin === undefined ? {} : { staleMargin: request.staleMargin }),
        }
      : null,
    ledger,
    { ledgerFile: request.ledgerFile ?? LEDGER_FILE },
  );
  if (verdict.write !== undefined) {
    deps.writeFile(baselineFile, serializeBaseline(verdict.write));
    deps.log(`wrote ${relative(deps.root, baselineFile)}`);
  }
  if (target.ratchet && !judged && verdict.status === 'passed') {
    const why = config !== null ? 'another config' : 'incremental: results were reused';
    return { ...verdict, reason: `${verdict.reason}, not judged against the baseline (${why})` };
  }
  return verdict;
}

const GIT = ['-c', 'core.quotePath=false'] as const;

function nulList(stdout: string | null): string[] {
  return (stdout ?? '').split('\0').filter((path) => path !== '');
}

/** The `Stryker disable` comments in the files the patterns mutate, as `path:line`. */
function directives(
  deps: IMutationDeps,
  target: IMutationTarget,
  patterns: readonly string[],
  files: readonly string[],
): string[] {
  const found: string[] = [];
  const prefix = `${target.dir}/`;
  for (const path of files) {
    if (!path.startsWith(prefix) || !mutated(path.slice(prefix.length), patterns)) continue;
    const text = deps.readFile(join(deps.root, ...path.split('/')));
    for (const line of text === null ? [] : directiveLines(text)) {
      found.push(`${path}:${String(line)}`);
    }
  }
  return found;
}

async function runChanged(
  request: IMutationRequest,
  baseRef: string,
  deps: IMutationDeps,
): Promise<IMutationVerdict> {
  const { target } = request;
  const ledgerFile = request.ledgerFile ?? LEDGER_FILE;
  const blocked = (reason: string): IMutationVerdict => ({ status: 'blocked', reason });
  const git = (args: readonly string[]): IGitResult => {
    deps.log(`$ git ${args.join(' ')}`);
    return deps.git(args);
  };
  const packageDir = resolve(deps.root, target.dir);
  const configPath = resolve(packageDir, request.configFile ?? CONFIG_FILE);
  const loaded = await loadConfig(deps, packageDir, configPath);
  if ('verdict' in loaded) return loaded.verdict;
  const patterns = mutatePatterns(loaded.facts.mutate);
  if ('error' in patterns) return { status: 'failed', reason: patterns.error };
  // The run's config is this one with other mutate ranges and report paths,
  // written out as JSON, so it has to be plain data to begin with.
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(loaded.config)), loaded.config)) {
    return {
      status: 'failed',
      reason: `${relative(deps.root, configPath)} is not plain data, so a changed-line run cannot be derived from it`,
    };
  }
  const ledger = readLedger(request, deps, packageDir);
  if ('verdict' in ledger) return ledger.verdict;

  const mergeBase = git([...GIT, 'merge-base', 'HEAD', baseRef]);
  // A git that could not be started has a status and no output at all.
  if (mergeBase.stdout === null) {
    return blocked('git could not be started: is it installed and on PATH?');
  }
  const base = mergeBase.stdout.trim();
  if (mergeBase.status !== 0 || base === '') {
    return blocked(
      `git found no merge base of HEAD and ${baseRef}: fetch it (a shallow CI clone needs fetch-depth 0), or name another baseRef`,
    );
  }
  const diffed = git([
    ...GIT,
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    base,
    '--',
    target.dir,
  ]);
  const listing = ['ls-files', '-z', '--exclude-standard'];
  const untracked = git([...GIT, ...listing, '--others', '--', target.dir]);
  const tracked = git([...GIT, ...listing, '--cached', '--', target.dir]);
  if (
    diffed.status !== 0 ||
    untracked.status !== 0 ||
    tracked.status !== 0 ||
    diffed.stdout === null
  ) {
    return blocked(`git could not list what changed under ${target.dir} since ${base}`);
  }

  const switchedOff = directives(deps, target, patterns, [
    ...nulList(tracked.stdout),
    ...nulList(untracked.stdout),
  ]);
  if (switchedOff.length > 0) {
    return {
      status: 'failed',
      reason:
        `${String(switchedOff.length)} Stryker disable comment(s) under ${target.dir}: a mutant nobody can kill ` +
        `goes in ${ledgerFile} with its reason, never in a comment`,
      details: switchedOff.map((where) => `${where}: Stryker disable comment`),
    };
  }

  let plan: IChangedPlan;
  try {
    plan = planChangedRun({
      targetDir: target.dir,
      patterns,
      diff: parseDiff(diffed.stdout),
      untracked: nulList(untracked.stdout),
      ledger,
      source: (file) => deps.readFile(join(packageDir, ...file.split('/'))),
      ...(request.neverMutate === undefined ? {} : { neverMutate: request.neverMutate }),
    });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
  const shortBase = base.slice(0, 8);
  if (plan.mutate.length === 0) return nothingToCheck(plan, target.dir, shortBase);

  // Next to the package's own report, in a directory of its own: the report
  // and the HTML page of the whole-package run stay what they were.
  const outDir = join(dirname(resolve(packageDir, String(loaded.facts.jsonReportFile))), 'changed');
  const reportFile = join(outDir, 'mutation.json');
  // Checked here as well as before the delete: the derived config is written
  // next to the report, and nothing is written next to a path that is refused.
  const outside = reportFileRefusal(deps.root, reportFile, request.reportDir);
  if (outside !== null) return outside;
  const derivedPath = join(outDir, 'stryker.config.json');
  const derived: Record<string, unknown> = { ...(loaded.config as Record<string, unknown>) };
  delete derived['incrementalFile'];
  delete derived['htmlReporter'];
  const reporters = Array.isArray(loaded.facts.reporters) ? loaded.facts.reporters : [];
  deps.writeFile(
    derivedPath,
    `${JSON.stringify(
      {
        ...derived,
        mutate: plan.mutate,
        // No cache: the run is seconds, and a reused result is exactly what
        // this check exists to distrust.
        incremental: false,
        // The verdict reads Stryker's "Instrumented N source file(s) ..." line.
        logLevel: 'info',
        reporters: reporters.filter((reporter) => reporter !== 'html'),
        jsonReporter: { fileName: reportFile },
      },
      null,
      2,
    )}\n`,
  );

  const ran = await strykerRun(request, deps, packageDir, reportFile, ['run', derivedPath], true);
  if ('verdict' in ran) return ran.verdict;
  return judgeChanged(ran, { plan, ledger, base: shortBase, ledgerFile });
}

/** The prefix of the request's verdict line: the target's, or its changed-line run's. */
export function checkIdOf(request: IMutationRequest): string {
  return request.changed == null
    ? request.target.checkId
    : (request.target.changedCheckId ?? request.target.checkId);
}

/**
 * Run one mutation check to its verdict: a whole-package run (held to the
 * baseline when the target has a ratchet) or, with `changed`, a run over the
 * lines changed since the merge base with `baseRef`. Never throws for a run
 * that went wrong: that is a failed or blocked verdict.
 */
export async function runMutation(
  request: IMutationRequest,
  deps: IMutationDeps,
): Promise<IMutationOutcome> {
  const checkId = checkIdOf(request);
  const refused = requestRefusal(request);
  if (refused !== null) return { checkId, verdict: refused };
  const verdict =
    request.changed == null
      ? await runPackage(request, deps)
      : await runChanged(request, request.changed.baseRef ?? DEFAULT_BASE_REF, deps);
  return { checkId, verdict };
}
