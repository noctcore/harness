/*
 * What a Stryker run proved, decided from the JSON report it wrote
 * (mutation-testing-report-schema, `files.<path>.mutants[].status`) and its
 * exit code. run.ts only runs Stryker and reads files; every decision is here,
 * where it is unit tested.
 *
 * A run that crashed, wrote no report, left mutants unrun or had nothing to
 * mutate is failed; a run that could not start (Stryker or a runner plugin not
 * installed, an interrupt) is blocked. Neither is ever read as a pass, and
 * neither reaches the ratchet.
 *
 * A complete run of a target with a ratchet is then judged against its
 * committed baseline (ratchet.ts): its score with timeouts counted as
 * undetected must sit within the tolerance of it. A target without one is
 * record-only: a complete run passes whatever its score, and the score goes
 * into the reason.
 */

import {
  ambiguousEntries,
  describeMutant,
  type IAcceptedMutant,
  lineContext,
  names,
  notJudged,
  staleEntries,
  switchedOff,
} from './ledger.js';
import { type IRatchetOptions, judgeScore } from './ratchet.js';

export type MutationStatus = 'passed' | 'failed' | 'blocked';

export interface IMutationVerdict {
  readonly status: MutationStatus;
  readonly reason: string;
  /** Lines printed above the verdict line (the mutants a changed-line run names). */
  readonly details?: readonly string[];
  /** The baseline score to write, when this was an accepted run. */
  readonly write?: number;
}

export interface IMutationTally {
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly timeout: number;
  readonly compileError: number;
  readonly runtimeError: number;
  readonly ignored: number;
  readonly pending: number;
  readonly total: number;
  /**
   * Survived mutants whose report says no test completed (`testsCompleted: 0`).
   * A mutant that survived its covering tests ran them all, so zero means the
   * runner never judged it: the report looks like a result and is not one.
   */
  readonly survivedUntested: number;
}

type TallyField = Exclude<keyof IMutationTally, 'total' | 'survivedUntested'>;

/** The statuses of mutation-testing-report-schema 3, and the tally field each one counts in. */
const STATUS_FIELD: Readonly<Record<string, TallyField>> = {
  Killed: 'killed',
  Survived: 'survived',
  NoCoverage: 'noCoverage',
  Timeout: 'timeout',
  CompileError: 'compileError',
  RuntimeError: 'runtimeError',
  Ignored: 'ignored',
  Pending: 'pending',
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One mutant of a report, as far as a verdict reads it. */
export interface IReportedMutant {
  /** The report's key for the file: its path relative to the package Stryker ran in. */
  readonly file: string;
  readonly status: TallyField;
  readonly mutatorName: string;
  /** The code the mutant put in place of the original, when the report carries it. */
  readonly replacement: string | null;
  /** 1-based first and last line, or null when the report gives the mutant no location. */
  readonly lines: { readonly start: number; readonly end: number } | null;
  /** The text of the mutant's first line in the report's copy of the file, trimmed, when it has one. */
  readonly sourceLine: string | null;
  /** The nearest non-blank line above that line, trimmed; empty at the top of the file. */
  readonly lineBefore: string | null;
  /** The nearest non-blank line below that line, trimmed; empty at the end of the file. */
  readonly lineAfter: string | null;
  readonly testsCompleted: number | null;
  /** Runs once, when its module is imported: no single test covers it (`ignoreStatic` ignores these). */
  readonly static: boolean;
  /** Stryker's note on the status: why a mutant was ignored, which limit a timeout hit. */
  readonly statusReason: string | null;
}

function lineOf(location: Record<string, unknown> | null, edge: 'start' | 'end'): number | null {
  const line = record(location?.[edge])?.['line'];
  return typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : null;
}

/**
 * Every mutant of a report. Throws on anything that is not a mutation report,
 * and on a status the schema does not have: a report this cannot read
 * completely is never judged from the part it could.
 */
export function readMutants(text: string): IReportedMutant[] {
  const report = record(JSON.parse(text));
  const files = record(report?.['files']);
  if (files === null) {
    throw new Error('it has no "files" object');
  }
  const out: IReportedMutant[] = [];
  for (const [file, value] of Object.entries(files)) {
    const mutants = record(value)?.['mutants'];
    if (!Array.isArray(mutants)) {
      throw new Error(`${file} has no "mutants" array`);
    }
    const source = record(value)?.['source'];
    const sourceLines = typeof source === 'string' ? source.split(/\r?\n/u) : null;
    for (const raw of mutants) {
      const mutant = record(raw);
      const status = mutant?.['status'];
      const field = typeof status === 'string' ? STATUS_FIELD[status] : undefined;
      if (field === undefined) {
        throw new Error(`a mutant in ${file} has the unknown status ${JSON.stringify(status)}`);
      }
      const location = record(mutant?.['location']);
      const start = lineOf(location, 'start');
      const end = lineOf(location, 'end');
      const mutatorName = mutant?.['mutatorName'];
      const replacement = mutant?.['replacement'];
      const testsCompleted = mutant?.['testsCompleted'];
      const statusReason = mutant?.['statusReason'];
      const context =
        start === null || sourceLines === null ? null : lineContext(sourceLines, start);
      out.push({
        file,
        status: field,
        mutatorName: typeof mutatorName === 'string' ? mutatorName : 'unknown mutator',
        replacement: typeof replacement === 'string' ? replacement : null,
        lines: start === null || end === null ? null : { start, end },
        sourceLine: context?.text ?? null,
        lineBefore: context?.before ?? null,
        lineAfter: context?.after ?? null,
        testsCompleted: typeof testsCompleted === 'number' ? testsCompleted : null,
        static: mutant?.['static'] === true,
        statusReason: typeof statusReason === 'string' ? statusReason : null,
      });
    }
  }
  return out;
}

/** Count the mutants of a report by status (see readMutants for what it refuses). */
export function tallyReport(text: string): IMutationTally {
  return tallyMutants(readMutants(text));
}

function tallyMutants(mutants: readonly IReportedMutant[]): IMutationTally {
  const tally = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    compileError: 0,
    runtimeError: 0,
    ignored: 0,
    pending: 0,
    total: 0,
    survivedUntested: 0,
  };
  for (const mutant of mutants) {
    tally[mutant.status] += 1;
    tally.total += 1;
    if (mutant.status === 'survived' && mutant.testsCompleted === 0) {
      tally.survivedUntested += 1;
    }
  }
  return tally;
}

/**
 * Stryker's mutation score: detected (killed or timed out) over every mutant a
 * test could have detected (detected, survived, no coverage). Compile and
 * runtime errors and ignored mutants do not count. Null when nothing counts.
 */
export function mutationScore(tally: IMutationTally): number | null {
  const detected = tally.killed + tally.timeout;
  const valid = detected + tally.survived + tally.noCoverage;
  return valid === 0 ? null : (detected / valid) * 100;
}

/**
 * The same score with timeouts counted as undetected. On a loaded machine a
 * mutant run that merely overran its time limit reads as a timeout, which
 * Stryker counts as detected; this number is the one a timeout cannot raise.
 */
export function conservativeScore(tally: IMutationTally): number | null {
  const valid = tally.killed + tally.timeout + tally.survived + tally.noCoverage;
  return valid === 0 ? null : (tally.killed / valid) * 100;
}

/** `6m10s`, `1h02m03s`, `42s`: whole seconds, the way the verdict prints a runtime. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${String(h)}h${pad(m)}m${pad(s)}s`;
  if (m > 0) return `${String(m)}m${pad(s)}s`;
  return `${String(s)}s`;
}

/** Exit codes of a child a signal ended (SIGHUP, SIGINT, SIGTERM): the run proved nothing. */
const INTERRUPTED = new Set([129, 130, 143]);

export interface IRunObservation {
  /** Stryker's exit code; 127 when it could not be started. */
  readonly exitCode: number;
  /** The JSON report THIS run wrote (the file is removed before it starts), or null. */
  readonly report: string | null;
  readonly durationMs: number;
  /** What Stryker printed, when the run captured it (a changed-line run does), else null. */
  readonly output?: string | null;
}

/**
 * Why a run is not a measurement, or null when it is: Stryker's exit code, then
 * a report that exists, can be read and holds mutants that were all run.
 * Shared by the whole-package verdict and the changed-line one (changed.ts).
 */
export function incompleteRun(
  run: IRunObservation,
): { readonly verdict: IMutationVerdict } | { readonly report: string } {
  const runtime = formatDuration(run.durationMs);
  if (run.exitCode === 127) {
    return { verdict: { status: 'blocked', reason: 'Stryker could not be started' } };
  }
  if (INTERRUPTED.has(run.exitCode)) {
    return {
      verdict: {
        status: 'blocked',
        reason: `Stryker was ended by a signal (exit ${String(run.exitCode)}) after ${runtime}`,
      },
    };
  }
  if (run.exitCode !== 0) {
    return {
      verdict: {
        status: 'failed',
        reason:
          `Stryker exited ${String(run.exitCode)} after ${runtime}` +
          (run.report === null ? ' without writing a report' : ''),
      },
    };
  }
  if (run.report === null) {
    return { verdict: { status: 'failed', reason: 'Stryker exited 0 but wrote no JSON report' } };
  }
  return { report: run.report };
}

interface IMeasurement {
  readonly conservative: number;
  /** The score and the counts, the way the reason prints them. */
  readonly counts: string;
}

function measureRun(
  run: IRunObservation,
  ledger: readonly IAcceptedMutant[] | null,
  ledgerFile: string | undefined,
): IMutationVerdict | IMeasurement {
  const runtime = formatDuration(run.durationMs);
  const started = incompleteRun(run);
  if ('verdict' in started) return started.verdict;
  let tally: IMutationTally;
  let mutants: IReportedMutant[];
  try {
    mutants = readMutants(started.report);
    tally = tallyMutants(mutants);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `the JSON report cannot be read: ${why}` };
  }
  if (tally.total === 0) {
    return {
      status: 'failed',
      reason: 'the report holds no mutants: the mutate globs match no code',
    };
  }
  if (tally.pending > 0) {
    return {
      status: 'failed',
      reason: `${String(tally.pending)} of ${String(tally.total)} mutants were never run`,
    };
  }
  /*
   * No mutant reached by any test: the per-test coverage the runner collects
   * came back empty, which is what a runner setup file that never loaded
   * looks like. A package whose tests reach none of its code is not a
   * measurement either.
   */
  if (tally.killed + tally.survived + tally.timeout === 0 && tally.noCoverage > 0) {
    return {
      status: 'failed',
      reason:
        `all ${String(tally.noCoverage)} mutants report no coverage: the runner measured nothing, ` +
        'so the score would be false',
    };
  }
  /*
   * Stryker's vitest runner selects each mutant's tests by name, and when that
   * filter matches nothing every covered mutant runs no test and survives:
   * the runner, not the tests, produced the result.
   */
  const covered = tally.survived + tally.timeout;
  if (tally.killed === 0 && covered > 0) {
    return {
      status: 'failed',
      reason:
        `no mutant was killed although ${String(covered)} were covered: the runner's ` +
        'test-name filter ran no test for them, so the score would be false',
    };
  }
  if (tally.survivedUntested > 0) {
    return {
      status: 'failed',
      reason:
        `${String(tally.survivedUntested)} of ${String(tally.survived)} survived mutants ran no test: ` +
        'the test runner did not judge them, so the score would be false',
    };
  }
  /*
   * Stryker counts a timed-out mutant as detected. A few are real (a mutant
   * that turns a loop infinite); more timeouts than kills means the runs are
   * not finishing at all, and the score would read that as tests catching
   * the mutants.
   */
  if (tally.timeout > tally.killed) {
    return {
      status: 'failed',
      reason:
        `${String(tally.timeout)} mutants timed out and only ${String(tally.killed)} were killed: ` +
        'the runs did not finish, so the score would be false',
    };
  }
  const score = mutationScore(tally);
  if (score === null) {
    return {
      status: 'failed',
      reason: `none of the ${String(tally.total)} mutants could be judged by a test`,
    };
  }
  if (ledger !== null) {
    /*
     * An ignored mutant leaves the score, so switching survivors off in the
     * source or the config would raise it by deleting what it counts. Only
     * static mutants are ignored; anything else is a failure.
     */
    const off = switchedOff(mutants);
    if (off.length > 0) {
      return {
        status: 'failed',
        reason:
          `${String(off.length)} ${off.length === 1 ? 'mutant was' : 'mutants were'} switched off instead of tested: nothing is ignored ` +
          'but static mutants, so the score would be false',
        details: off.map(
          (mutant) =>
            `${describeMutant(mutant)}: ignored (${mutant.statusReason ?? 'no reason given'})`,
        ),
      };
    }
    // A whole-package run generated the mutants of every line, so every entry is judged.
    const ambiguous = ambiguousEntries(ledger, mutants, () => true, ledgerFile);
    if (ambiguous.length > 0) {
      return {
        status: 'failed',
        reason: `${String(ambiguous.length)} ledger ${ambiguous.length === 1 ? 'entry names' : 'entries name'} more than one mutant: an entry accepts exactly one`,
        details: ambiguous,
      };
    }
    // ... but one whose mutant ran out of time or broke its run was not judged: it is left alone.
    const unjudged = mutants.filter(notJudged);
    const stale = staleEntries(
      ledger,
      mutants,
      (entry) => !unjudged.some((mutant) => names(entry, mutant)),
      ledgerFile,
    );
    if (stale.length > 0) {
      return {
        status: 'failed',
        reason: `${String(stale.length)} stale ledger ${stale.length === 1 ? 'entry' : 'entries'}: an accepted mutant is no longer there to accept`,
        details: stale,
      };
    }
  }
  const conservative = conservativeScore(tally) ?? 0;
  const parts = [
    `score ${score.toFixed(1)}% (${conservative.toFixed(1)}% with timeouts as undetected)`,
    `${String(tally.total)} mutants`,
    `${String(tally.killed)} killed`,
    `${String(tally.survived)} survived`,
    `${String(tally.noCoverage)} no coverage`,
    `${String(tally.timeout)} timeout`,
  ];
  const errors = tally.compileError + tally.runtimeError;
  if (errors > 0) parts.push(`${String(errors)} errors`);
  if (tally.ignored > 0) parts.push(`${String(tally.ignored)} ignored`);
  parts.push(`runtime ${runtime}`);
  return { conservative, counts: parts.join(', ') };
}

/**
 * The verdict for one whole-package run. `ratchet` is null for a run that is
 * not held to a baseline (a target without one, a run that reused results or
 * used another config): it is then record-only. `ledger` is the package's
 * accepted mutants (ledger.ts) for a run that judged every mutant afresh, null
 * for one that did not. The order matters: a run that is not a measurement is
 * reported as that before anything is said about the score, and nothing is
 * accepted from it. `options.ledgerFile` is the ledger's name in messages.
 */
export function judgeRun(
  run: IRunObservation,
  ratchet: IRatchetOptions | null,
  ledger: readonly IAcceptedMutant[] | null = null,
  options: { readonly ledgerFile?: string } = {},
): IMutationVerdict {
  const measured = measureRun(run, ledger, options.ledgerFile);
  if ('status' in measured) {
    return ratchet?.accept === true
      ? { ...measured, reason: `${measured.reason}; nothing accepted` }
      : measured;
  }
  if (ratchet === null) {
    return { status: 'passed', reason: measured.counts };
  }
  const judged = judgeScore(measured.conservative, ratchet);
  if (judged.status === 'passed' && judged.write === undefined) {
    return { status: 'passed', reason: `${measured.counts}, ${judged.reason}` };
  }
  return {
    status: judged.status,
    reason: `${judged.reason}; ${measured.counts}`,
    ...(judged.write === undefined ? {} : { write: judged.write }),
  };
}

/** The config facts a run needs before Stryker is started. */
export interface IConfigFacts {
  readonly testRunner: unknown;
  readonly plugins: unknown;
  readonly reporters: unknown;
  readonly jsonReportFile: unknown;
  /** The mutate patterns; only the changed-line run reads them (changed.ts). */
  readonly mutate: unknown;
}

/**
 * Why a Stryker config cannot be run as it stands, or null when it can.
 *
 * Under an isolated install (pnpm and the like) Stryker cannot discover its
 * plugins (it scans a node_modules nothing is hoisted into), so the config has
 * to name the runner plugin for its `testRunner` (`command` is built into core
 * and needs none); one that does not is a broken config, failed. A plugin the
 * config names that is not installed is blocked: an install is missing, not
 * the check. The JSON reporter has to be on, with a file name, since that
 * report is what the run is judged from.
 */
export function preflight(
  config: IConfigFacts,
  installed: (name: string) => boolean,
): IMutationVerdict | null {
  const { testRunner, plugins, reporters, jsonReportFile } = config;
  if (typeof testRunner !== 'string' || testRunner === '') {
    return { status: 'failed', reason: 'the Stryker config names no testRunner' };
  }
  const runnerPlugin = testRunner === 'command' ? null : `@stryker-mutator/${testRunner}-runner`;
  if (
    !Array.isArray(plugins) ||
    !plugins.every((plugin): plugin is string => typeof plugin === 'string') ||
    (runnerPlugin !== null && !plugins.includes(runnerPlugin))
  ) {
    return {
      status: 'failed',
      reason: `the Stryker config does not list ${runnerPlugin ?? 'its plugins'} in plugins (an isolated install hides it from discovery)`,
    };
  }
  if (!Array.isArray(reporters) || !reporters.includes('json')) {
    return { status: 'failed', reason: 'the Stryker config does not enable the json reporter' };
  }
  if (typeof jsonReportFile !== 'string' || jsonReportFile === '') {
    return { status: 'failed', reason: 'the Stryker config sets no jsonReporter.fileName' };
  }
  const missing = ['@stryker-mutator/core', ...plugins].filter((name) => !installed(name));
  if (missing.length > 0) {
    return {
      status: 'blocked',
      reason: `not installed: ${missing.join(', ')} (install the dependencies of the target package)`,
    };
  }
  return null;
}

/**
 * Each line break, with the whitespace around it, as one space. A linear
 * split rather than a `\s*\n\s*` regex, whose backtracking is polynomial on a
 * long run of spaces.
 */
function oneLine(text: string): string {
  const parts = text.split('\n');
  const last = parts.length - 1;
  return parts
    .map((part, index) => {
      const start = index === 0 ? part : part.trimStart();
      return index === last ? start : start.trimEnd();
    })
    .filter((part, index) => index === 0 || index === last || part !== '')
    .join(' ');
}

/** `<checkId>: <status> (<reason>)`, on one line. */
export function verdictLine(checkId: string, verdict: IMutationVerdict): string {
  return `${checkId}: ${verdict.status} (${oneLine(verdict.reason)})`;
}

/** 0 for passed, 1 for failed, 2 for blocked. */
export function exitCodeFor(status: MutationStatus): number {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}
