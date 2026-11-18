import { posix } from 'node:path';

import {
  acceptedBy,
  ambiguousEntries,
  brokeTheRun,
  describeMutant,
  type IAcceptedMutant,
  LEDGER_FILE,
  lineContext,
  names,
  ranOutOfTime,
  staleEntries,
  switchedOff,
} from './ledger.js';
import {
  formatDuration,
  type IMutationVerdict,
  incompleteRun,
  type IReportedMutant,
  type IRunObservation,
  readMutants,
} from './verdict.js';

/*
 * Mutation testing over the lines a change touches.
 *
 * The whole-package score cannot see one weakened test: a point of tolerance
 * is ten survivors. This asks the narrow question instead. The lines that
 * differ from the merge base are handed to Stryker as `path:first-last` mutate
 * ranges, and a mutant on one of them that no test kills fails the check, by
 * name. So does a mutant on one of them that no test even runs.
 *
 * What it does not see, each counted in the summary where it can be:
 * - a hunk that only removes lines has no line left to mutate;
 * - Stryker generates a mutant only when it sits wholly inside one range, so
 *   a mutant spanning lines the change did not touch (the operator of a
 *   condition written over three lines, one of them changed) is not generated;
 * - a file renamed into the mutated set with no line changed has no hunk, so
 *   none of it is judged here (the whole-package ratchet is what sees it);
 * - static mutants are ignored, as in the whole-package run.
 *
 * A mutant that timed out is one of two things. Stryker's hit limit catching
 * a loop the mutant made endless is the same on every machine and no test can
 * "fix" it: it counts as detected and is named in the output. A mutant that
 * ran out of time on the clock is what a survivor looks like on a loaded
 * machine: it was not judged, and the check is blocked until a rerun on a
 * quiet machine says which it is. A mutant that ended in a runtime error is
 * blocked the same way: the run broke, which is not a test result. A compile
 * error comes from a checker before any test runs, is the same everywhere,
 * and is counted.
 *
 * The report is reconciled with the plan before anything is read from it:
 * Stryker must say it instrumented exactly the files the run named, with as
 * many mutants as the report holds, and every one of them inside a range the
 * run named. An empty report is only "nothing mutable here" when Stryker said
 * it read the files. One run has no report at all: when no test file imports
 * any changed file Stryker exits 1 after its initial run, and that is judged
 * from its own count as well (nothing to mutate passes, mutants fail).
 *
 * Only decisions live here: run.ts asks git for the diff and runs Stryker.
 */

/** 1-based, both ends included. */
export interface ILineRange {
  readonly start: number;
  readonly end: number;
}

export interface IDiff {
  /** The lines each path gained or changed, by repo-relative `/`-separated path. */
  readonly files: ReadonlyMap<string, readonly ILineRange[]>;
  /** How many hunks of each path only removed lines: nothing on the new side to mutate. */
  readonly deletionOnlyHunks: ReadonlyMap<string, number>;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * The new-side line ranges of a `git diff -U0` (prefixes `a/` and `b/`, paths
 * unquoted: run.ts asks git for exactly that). The lines of a hunk are counted
 * off, so an added line that happens to read `+++ b/x` is not taken for a file
 * header. Throws on a path git had to quote, rather than guess at it.
 */
export function parseDiff(text: string): IDiff {
  const files = new Map<string, ILineRange[]>();
  const deletionOnlyHunks = new Map<string, number>();
  /** The path a hunk belongs to: the new one, or the old one of a deleted file. */
  let hunkPath: string | null = null;
  let current: string | null = null;
  let hunkLinesLeft = 0;

  for (const line of text.split('\n')) {
    if (hunkLinesLeft > 0) {
      // "\ No newline at end of file" belongs to the line before it.
      if (!line.startsWith('\\')) hunkLinesLeft -= 1;
      continue;
    }
    if (line.startsWith('--- a/')) {
      hunkPath = line.slice(6).replace(/\t$/u, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\t$/u, '');
      if (path === '/dev/null') {
        current = null;
      } else if (path.startsWith('b/')) {
        current = path.slice(2);
        hunkPath = current;
      } else {
        throw new Error(`the diff names a path this cannot read: ${path}`);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;
    const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
    hunkLinesLeft = removed + added;
    if (added === 0) {
      const path = hunkPath ?? '';
      deletionOnlyHunks.set(path, (deletionOnlyHunks.get(path) ?? 0) + 1);
      continue;
    }
    if (current === null) {
      throw new Error(`the diff has a hunk before any file: ${line}`);
    }
    const ranges = files.get(current) ?? [];
    ranges.push({ start, end: start + added - 1 });
    files.set(current, ranges);
  }
  return {
    files: new Map([...files].map(([path, ranges]) => [path, mergeRanges(ranges)])),
    deletionOnlyHunks,
  };
}

/** Sorted, with touching and overlapping ranges joined: Stryker wants a mutant inside ONE range. */
export function mergeRanges(ranges: readonly ILineRange[]): ILineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ILineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Stryker's own range suffix on a mutate pattern (`src/a.ts:3-7`, `src/a.ts:3:0-7:12`). */
const RANGE_SUFFIX = /:\d+(?::\d+)?-\d+(?::\d+)?$/u;
/**
 * What a path would be read as a glob with, once it is a mutate entry: the
 * wildcard and class characters, a leading `!`, and an extglob opener (`+(`,
 * `@(`, `!(`). Parentheses alone are a plain name.
 */
const GLOB_CHARACTERS = /[*?[\]{}]|^!|[+@!]\(/u;

/**
 * The mutate patterns of a Stryker config, as far as this can apply them, or
 * why it cannot. They decide which changed files are source: without them a
 * changed test file would be mutated.
 */
export function mutatePatterns(mutate: unknown): readonly string[] | { readonly error: string } {
  if (
    !Array.isArray(mutate) ||
    mutate.length === 0 ||
    !mutate.every((pattern): pattern is string => typeof pattern === 'string' && pattern !== '')
  ) {
    return {
      error: 'the Stryker config lists no mutate patterns, so source cannot be told from tests',
    };
  }
  const ranged = mutate.find((pattern) => RANGE_SUFFIX.test(pattern));
  if (ranged !== undefined) {
    return { error: `the Stryker config's mutate pattern ${ranged} already carries a line range` };
  }
  return mutate;
}

/** Whether Stryker would mutate `file` (package-relative) under `patterns`: the last match wins. */
export function mutated(file: string, patterns: readonly string[]): boolean {
  let result = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (posix.matchesGlob(file, negated ? pattern.slice(1) : pattern)) {
      result = !negated;
    }
  }
  return result;
}

export interface IPlanInput {
  /** The package Stryker runs in, repo-relative, `/`-separated. */
  readonly targetDir: string;
  readonly patterns: readonly string[];
  readonly diff: IDiff;
  /** Repo-relative paths git does not track yet: new files, every line of them changed. */
  readonly untracked: readonly string[];
  readonly ledger: readonly IAcceptedMutant[];
  /** The working-tree text of a package-relative file, or null when it cannot be read. */
  readonly source: (file: string) => string | null;
  /**
   * Repo-relative path prefixes never mutated, whatever the patterns say (the
   * code that judges the run, say: a mutant there would be judging itself).
   * Defaults to none.
   */
  readonly neverMutate?: readonly string[];
}

export interface IChangedPlan {
  /** The `mutate` entries of the run, package-relative: `src/a.ts:3-7`. */
  readonly mutate: readonly string[];
  /** The changed lines a mutant is judged on, per package-relative file. */
  readonly changed: ReadonlyMap<string, readonly ILineRange[]>;
  /** Every range the run names, per file: the changed lines and the ledger's lines, joined. */
  readonly planned: ReadonlyMap<string, readonly ILineRange[]>;
  /** How many lines `changed` holds. */
  readonly lines: number;
  /** Hunks of mutated files that only removed lines. */
  readonly deletionOnlyHunks: number;
  /** Changed paths under the package that its patterns do not mutate (tests, declarations). */
  readonly notMutated: number;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * What a changed-line run mutates. Besides the changed lines of each mutated
 * file it adds the lines the ledger's entries for that file sit on, so each
 * of them is judged in every run that touches the file: an entry cannot go
 * stale behind a change to the line next to it.
 */
export function planChangedRun(input: IPlanInput): IChangedPlan {
  const prefix = `${input.targetDir}/`;
  const neverMutate = input.neverMutate ?? [];
  const changed = new Map<string, readonly ILineRange[]>();
  let notMutated = 0;

  const consider = (path: string, ranges: () => readonly ILineRange[]): void => {
    if (!path.startsWith(prefix)) return;
    if (neverMutate.some((never) => path.startsWith(never))) return;
    const file = path.slice(prefix.length);
    if (!mutated(file, input.patterns)) {
      notMutated += 1;
      return;
    }
    if (GLOB_CHARACTERS.test(file)) {
      throw new Error(`${path} would be read as a glob pattern in a mutate range`);
    }
    const lines = ranges();
    if (lines.length > 0) changed.set(file, mergeRanges([...(changed.get(file) ?? []), ...lines]));
  };

  for (const [path, ranges] of input.diff.files) {
    consider(path, () => ranges);
  }
  for (const path of input.untracked) {
    consider(path, () => {
      const text = input.source(path.slice(prefix.length));
      const count = text === null ? 0 : lineCount(text);
      return count === 0 ? [] : [{ start: 1, end: count }];
    });
  }

  const mutate: string[] = [];
  const planned = new Map<string, readonly ILineRange[]>();
  let lines = 0;
  for (const [file, ranges] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    lines += ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    const ledgerLines: ILineRange[] = [];
    const entries = input.ledger.filter((entry) => entry.file === file);
    if (entries.length > 0) {
      const fileLines = (input.source(file) ?? '').split(/\r?\n/u);
      fileLines.forEach((_line, index) => {
        const context = lineContext(fileLines, index + 1);
        if (
          context !== null &&
          entries.some(
            (entry) =>
              entry.source === context.text &&
              entry.before === context.before &&
              entry.after === context.after,
          )
        ) {
          ledgerLines.push({ start: index + 1, end: index + 1 });
        }
      });
    }
    const named = mergeRanges([...ranges, ...ledgerLines]);
    planned.set(file, named);
    for (const range of named) {
      mutate.push(`${file}:${String(range.start)}-${String(range.end)}`);
    }
  }
  let deletionOnlyHunks = 0;
  for (const [path, hunks] of input.diff.deletionOnlyHunks) {
    if (path.startsWith(prefix) && mutated(path.slice(prefix.length), input.patterns)) {
      deletionOnlyHunks += hunks;
    }
  }
  return { mutate, changed, planned, lines, deletionOnlyHunks, notMutated };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** What the run looked at, the way both summaries say it. */
function scope(plan: IChangedPlan, base: string): string {
  return `${plural(plan.lines, 'changed line')} of ${plural(plan.changed.size, 'file')} since ${base}`;
}

function blindSpots(plan: IChangedPlan): string[] {
  const notes: string[] = [];
  if (plan.notMutated > 0) notes.push(`${plural(plan.notMutated, 'changed path')} not mutated`);
  if (plan.deletionOnlyHunks > 0) {
    notes.push(`${plural(plan.deletionOnlyHunks, 'deletion-only hunk')} with no line to mutate`);
  }
  return notes;
}

/**
 * The verdict when no line of mutated source changed. It passes, and says it
 * checked nothing: a summary of its own, so it is not mistaken for a run that
 * found every mutant killed, or for a check that was skipped.
 */
export function nothingToCheck(
  plan: IChangedPlan,
  targetDir: string,
  base: string,
): IMutationVerdict {
  const notes = blindSpots(plan);
  return {
    status: 'passed',
    reason:
      `checked nothing: no changed line of mutated source under ${targetDir} since ${base}` +
      (notes.length > 0 ? ` (${notes.join(', ')})` : ''),
  };
}

function overlaps(mutant: IReportedMutant, ranges: readonly ILineRange[]): boolean {
  const { lines } = mutant;
  if (lines === null) return false;
  return ranges.some((range) => lines.start <= range.end && lines.end >= range.start);
}

function inside(mutant: IReportedMutant, ranges: readonly ILineRange[]): boolean {
  const { lines } = mutant;
  if (lines === null) return false;
  return ranges.some((range) => lines.start >= range.start && lines.end <= range.end);
}

/** The line Stryker prints once it has read the files it was told to mutate. */
const INSTRUMENTED = /Instrumented (\d+) source file\(s\) with (\d+) mutant\(s\)/u;

/** How many files Stryker says it instrumented, and with how many mutants; null when it did not say. */
function instrumentedCounts(
  output: string | null | undefined,
): { readonly files: number; readonly mutants: number } | null {
  const match = INSTRUMENTED.exec(output ?? '');
  return match === null ? null : { files: Number(match[1]), mutants: Number(match[2]) };
}

export interface IChangedContext {
  readonly plan: IChangedPlan;
  readonly ledger: readonly IAcceptedMutant[];
  /** The commit the diff was taken against, short. */
  readonly base: string;
  /** The ledger's name in messages. Defaults to `mutation-ledger.json`. */
  readonly ledgerFile?: string;
}

/**
 * Why the report cannot be read as the result of this plan, or null when it
 * can. Stryker's JSON report lists only files that hold a mutant, so a file
 * missing from it is either "nothing mutable in those lines" or "Stryker never
 * read the file", and only Stryker's own count tells the two apart.
 */
function unreconciled(
  run: IRunObservation,
  plan: IChangedPlan,
  mutants: readonly IReportedMutant[],
): IMutationVerdict | null {
  const counts = instrumentedCounts(run.output);
  if (counts === null) {
    return {
      status: 'blocked',
      reason:
        'Stryker did not print what it instrumented, so an empty report cannot be told from a run that mutated nothing',
    };
  }
  if (counts.files !== plan.planned.size) {
    return {
      status: 'failed',
      reason: `Stryker instrumented ${String(counts.files)} of the ${String(plan.planned.size)} file(s) this run named, so its report says nothing about the rest`,
    };
  }
  if (counts.mutants !== mutants.length) {
    return {
      status: 'failed',
      reason: `the report holds ${String(mutants.length)} mutant(s) and Stryker instrumented ${String(counts.mutants)}: it is not the report of this run`,
    };
  }
  const strays = mutants.filter((mutant) => !inside(mutant, plan.planned.get(mutant.file) ?? []));
  if (strays.length > 0) {
    return {
      status: 'failed',
      reason: `${String(strays.length)} mutant(s) in the report lie outside the lines this run named: it is not the report of this run`,
      details: strays.map((mutant) => `${describeMutant(mutant)}: outside every range of the run`),
    };
  }
  return null;
}

/** Stryker's last word when its initial run found no test that imports a mutated file. */
const NO_TESTS = /No tests were executed/u;

/**
 * The verdict for the one run Stryker ends without a report on purpose: it
 * read the files, made its mutants, and found no test file that imports any
 * of them, so it exits 1. Null for every other run. Lines with nothing to
 * mutate (a comment in a file nothing tests) are then nothing to judge; lines
 * with mutants are lines no test runs.
 */
function untestedFiles(
  run: IRunObservation,
  plan: IChangedPlan,
  base: string,
): IMutationVerdict | null {
  const counts = instrumentedCounts(run.output);
  if (run.exitCode !== 1 || run.report !== null || counts === null) return null;
  if (!NO_TESTS.test(run.output ?? '')) return null;
  if (counts.files !== plan.planned.size) return null;
  const runtime = `runtime ${formatDuration(run.durationMs)}`;
  if (counts.mutants === 0) {
    return {
      status: 'passed',
      reason: [
        `nothing mutable in the ${scope(plan, base)} (Stryker instrumented ${plural(counts.files, 'file')}, 0 mutants, and found no test that imports it)`,
        ...blindSpots(plan),
        runtime,
      ].join(', '),
    };
  }
  return {
    status: 'failed',
    reason: [
      `no test imports the changed file(s) (${[...plan.planned.keys()].join(', ')}): ${plural(counts.mutants, 'mutant')} in ${scope(plan, base)} and no test runs any of them`,
      ...blindSpots(plan),
      runtime,
    ].join(', '),
  };
}

/** The verdict of a changed-line run from the report Stryker wrote for `context.plan`. */
export function judgeChanged(run: IRunObservation, context: IChangedContext): IMutationVerdict {
  const { plan, ledger, base } = context;
  const ledgerFile = context.ledgerFile ?? LEDGER_FILE;
  const untested = untestedFiles(run, plan, base);
  if (untested !== null) return untested;
  const started = incompleteRun(run);
  if ('verdict' in started) return started.verdict;
  let mutants: IReportedMutant[];
  try {
    mutants = readMutants(started.report);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `the JSON report cannot be read: ${why}` };
  }
  const mismatch = unreconciled(run, plan, mutants);
  if (mismatch !== null) return mismatch;

  const pending = mutants.filter((mutant) => mutant.status === 'pending').length;
  if (pending > 0) {
    return {
      status: 'failed',
      reason: `${String(pending)} of ${String(mutants.length)} mutants were never run`,
    };
  }
  const off = switchedOff(mutants);
  if (off.length > 0) {
    return {
      status: 'failed',
      reason: `${plural(off.length, 'mutant')} switched off instead of tested: nothing is ignored but static mutants`,
      details: off.map(
        (mutant) =>
          `${describeMutant(mutant)}: ignored (${mutant.statusReason ?? 'no reason given'})`,
      ),
    };
  }
  // The same refusal as the whole-package verdict: a report the runner, not
  // the tests, produced is not a measurement of any line.
  const unjudged = mutants.filter(
    (mutant) => mutant.status === 'survived' && mutant.testsCompleted === 0,
  ).length;
  if (unjudged > 0) {
    return {
      status: 'failed',
      reason:
        `${plural(unjudged, 'survived mutant')} ran no test: the test runner did not judge them, ` +
        'so the result would be false',
    };
  }

  const inFile = (entry: IAcceptedMutant): boolean => plan.changed.has(entry.file);
  // A mutant that ran out of time, or whose run broke, was not judged, and
  // neither was the entry that names it.
  const late = mutants.filter(ranOutOfTime);
  const broken = mutants.filter(brokeTheRun);
  const ambiguous = ambiguousEntries(ledger, mutants, inFile, ledgerFile);
  const stale = staleEntries(
    ledger,
    mutants,
    (entry) => inFile(entry) && ![...late, ...broken].some((mutant) => names(entry, mutant)),
    ledgerFile,
  );
  // An entry accepts a mutant only while it names exactly one.
  const exact = ledger.filter(
    (entry) => mutants.filter((mutant) => names(entry, mutant)).length === 1,
  );

  const inChange = mutants.filter((mutant) =>
    overlaps(mutant, plan.changed.get(mutant.file) ?? []),
  );
  const count = (status: IReportedMutant['status']): number =>
    inChange.filter((mutant) => mutant.status === status).length;
  const accepted = new Set(inChange.filter((mutant) => acceptedBy(exact, mutant) !== null));
  const failing = inChange.filter(
    (mutant) =>
      mutant.status === 'noCoverage' || (mutant.status === 'survived' && !accepted.has(mutant)),
  );
  const endless = inChange.filter((mutant) => mutant.status === 'timeout' && !ranOutOfTime(mutant));
  const lateInChange = late.filter((mutant) => inChange.includes(mutant));
  const brokenInChange = broken.filter((mutant) => inChange.includes(mutant));

  const details = [
    ...failing.map(
      (mutant) =>
        `${describeMutant(mutant)}: ${mutant.status === 'noCoverage' ? 'no test runs this line' : 'survived'}`,
    ),
    ...stale,
    ...ambiguous,
    ...late.map(
      (mutant) =>
        `${describeMutant(mutant)}: ran out of time, not judged (${mutant.statusReason ?? 'time limit'})`,
    ),
    ...broken.map(
      (mutant) =>
        `${describeMutant(mutant)}: runtime error, not judged (${mutant.statusReason ?? 'no reason given'})`,
    ),
    ...endless.map(
      (mutant) =>
        `${describeMutant(mutant)}: timed out, counted as detected (${mutant.statusReason ?? 'hit limit'})`,
    ),
  ];
  const runtime = `runtime ${formatDuration(run.durationMs)}`;
  const tail =
    inChange.length === 0
      ? [
          `nothing mutable in the ${scope(plan, base)} (Stryker instrumented ${plural(plan.planned.size, 'file')}, ${plural(mutants.length, 'mutant')})`,
          ...blindSpots(plan),
          runtime,
        ].join(', ')
      : [
          `${plural(inChange.length, 'mutant')} in ${scope(plan, base)}`,
          `${String(count('killed'))} killed`,
          ...(endless.length > 0
            ? [`${String(endless.length)} timed out (counted as detected)`]
            : []),
          ...(lateInChange.length > 0 ? [`${String(lateInChange.length)} ran out of time`] : []),
          ...(accepted.size > 0 ? [`${String(accepted.size)} accepted in ${ledgerFile}`] : []),
          ...(count('ignored') > 0 ? [`${String(count('ignored'))} static ignored`] : []),
          ...(brokenInChange.length > 0 ? [plural(brokenInChange.length, 'runtime error')] : []),
          ...(count('compileError') > 0 ? [plural(count('compileError'), 'compile error')] : []),
          ...blindSpots(plan),
          runtime,
        ].join(', ');

  if (failing.length > 0 || stale.length > 0 || ambiguous.length > 0) {
    const problems = [
      ...(failing.length > 0
        ? [
            `${plural(failing.length, 'mutant')} in a changed line ${
              failing.length === 1 ? 'is' : 'are'
            } not killed (${String(count('survived') - accepted.size)} survived, ${String(count('noCoverage'))} no coverage)`,
          ]
        : []),
      ...(stale.length > 0
        ? [plural(stale.length, 'stale ledger entry', 'stale ledger entries')]
        : []),
      ...(ambiguous.length > 0
        ? [
            `${plural(ambiguous.length, 'ledger entry that names', 'ledger entries that name')} more than one mutant`,
          ]
        : []),
    ];
    return { status: 'failed', reason: `${problems.join(' and ')}; ${tail}`, details };
  }
  if (late.length > 0 || broken.length > 0) {
    const where = (inTheChange: number): string =>
      inTheChange > 0 ? 'in a changed line' : "on a ledger entry's line";
    const notJudged = [
      ...(late.length > 0
        ? [
            `${plural(late.length, 'mutant')} ${where(lateInChange.length)} ran out of time, ` +
              'which is what a survivor looks like on a loaded machine',
          ]
        : []),
      ...(broken.length > 0
        ? [
            `${plural(broken.length, 'mutant')} ${where(brokenInChange.length)} ended in a runtime error, ` +
              'which is not a test result (one that stays after a rerun means the mutant breaks the test run itself)',
          ]
        : []),
    ];
    return {
      status: 'blocked',
      reason: `${notJudged.join(' and ')}: rerun on a quiet machine; ${tail}`,
      details,
    };
  }
  return { status: 'passed', reason: tail, ...(details.length > 0 ? { details } : {}) };
}
