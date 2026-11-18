/*
 * The mutation score ratchet: a committed baseline per package, compared with
 * the score the run just measured. A fixed floor trails the code, so the floor
 * is the last accepted score.
 *
 * The number judged is the conservative score, timeouts counted as undetected:
 * on a loaded machine a mutant run that overran its time limit reads as a
 * timeout, which Stryker counts as a kill, so a busy machine can raise
 * Stryker's own score and can only lower this one. A run fails when:
 *
 * - the score is more than `dropTolerance` points under the baseline. One
 *   survivor in a thousand judged mutants is 0.1 point, and a kill that turned
 *   into a timeout under load costs the same; the tolerance absorbs a handful
 *   of those and nothing larger.
 * - the score is more than `staleMargin` points over the baseline. A baseline
 *   that trails the code is a floor with slack again, so a gain is recorded
 *   (an accepted run) in the change that made it.
 *
 * An accepted run writes the measured score, and only from a run verdict.ts
 * found complete (Stryker exited 0, every mutant was run, none of the
 * false-score refusals applies). It never lowers the baseline unless
 * `allowLowering` says so as well.
 *
 * Only decisions live here. run.ts reads and writes the file.
 */

/** Percentage points the score may sit under its baseline before it counts as a drop, by default. */
export const DROP_TOLERANCE = 1;
/** Percentage points the score may sit over its baseline before the baseline is stale, by default. */
export const STALE_MARGIN = 2;

/** The baseline's file name in the target package, by default. */
export const BASELINE_FILE = 'mutation-baseline.json';

/** What a failure says to record a new baseline, unless `acceptHint` says otherwise. */
export const DEFAULT_ACCEPT_HINT = 'run an accepted mutation run (accept: true)';

/** Rounded to two decimals, the precision the baseline is written in, so float noise never decides. */
export function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** A committed baseline: exactly `{ "score": <percentage> }`, nothing else. */
export function parseBaseline(text: string): number {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the baseline is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'score');
  if (extra.length > 0) {
    throw new Error(`the baseline has unknown key(s): ${extra.join(', ')}`);
  }
  const score = record['score'];
  if (!isPercent(score)) {
    throw new Error('the baseline\'s "score" is not a percentage');
  }
  return score;
}

export function serializeBaseline(score: number): string {
  return `${JSON.stringify({ score: hundredths(score) }, null, 2)}\n`;
}

export type ScoreFinding = 'dropped' | 'stale';

/** The band a score may move in around its baseline. */
export interface IScoreBand {
  /** Points under the baseline that still pass. Defaults to {@link DROP_TOLERANCE}. */
  readonly dropTolerance?: number;
  /** Points over the baseline before it is stale. Defaults to {@link STALE_MARGIN}. */
  readonly staleMargin?: number;
}

export function compareToBaseline(
  baseline: number,
  actual: number,
  band: IScoreBand = {},
): ScoreFinding | null {
  const delta = hundredths(actual - baseline);
  if (delta < -(band.dropTolerance ?? DROP_TOLERANCE)) return 'dropped';
  if (delta > (band.staleMargin ?? STALE_MARGIN)) return 'stale';
  return null;
}

export interface IAcceptance {
  readonly next: number;
  /** The score fell past the tolerance and the baseline was kept. */
  readonly refused: boolean;
}

/**
 * The baseline an accepted run writes. A gain is taken as measured. A dip
 * inside the tolerance keeps the old value, so accepting on a loaded machine
 * cannot walk the baseline down a point at a time. A real drop is refused
 * unless `allowLowering` is set.
 */
export function acceptScore(
  baseline: number | null,
  actual: number,
  allowLowering: boolean,
  dropTolerance: number = DROP_TOLERANCE,
): IAcceptance {
  if (baseline === null) {
    return { next: actual, refused: false };
  }
  const delta = hundredths(actual - baseline);
  if (delta >= 0 || allowLowering) {
    return { next: actual, refused: false };
  }
  return { next: baseline, refused: delta < -dropTolerance };
}

/** The committed baseline, null when the file does not exist, or why it cannot be read. */
export type BaselineObservation = number | null | { readonly error: string };

export interface IRatchetOptions extends IScoreBand {
  readonly baseline: BaselineObservation;
  readonly accept: boolean;
  readonly allowLowering: boolean;
  /** The baseline's name in messages. Defaults to {@link BASELINE_FILE}. */
  readonly baselineFile?: string;
  /** How to record a new baseline, in messages. Defaults to {@link DEFAULT_ACCEPT_HINT}. */
  readonly acceptHint?: string;
}

export interface IRatchetJudgement {
  readonly status: 'passed' | 'failed' | 'blocked';
  /** What the ratchet says about the score; the caller adds the run's counts. */
  readonly reason: string;
  /** The baseline to write, when this was an accepted run. */
  readonly write?: number;
}

const pct = (value: number): string => `${value.toFixed(2)}%`;

function points(value: number): string {
  return `${String(value)} ${value === 1 ? 'point' : 'points'}`;
}

/**
 * The ratchet's verdict on the conservative score of a run that verdict.ts
 * already found complete. A run it did not find complete never gets here, so
 * nothing is compared with, or accepted into, the baseline from one.
 */
export function judgeScore(measured: number, options: IRatchetOptions): IRatchetJudgement {
  const baselineFile = options.baselineFile ?? BASELINE_FILE;
  const acceptHint = options.acceptHint ?? DEFAULT_ACCEPT_HINT;
  const dropTolerance = options.dropTolerance ?? DROP_TOLERANCE;
  const staleMargin = options.staleMargin ?? STALE_MARGIN;
  // Every comparison with NaN is false, which would read here as "inside the band".
  if (!isPercent(measured)) {
    return {
      status: 'failed',
      reason: `the measured score is not a percentage (${String(measured)}), so nothing is compared or accepted`,
    };
  }
  const actual = hundredths(measured);
  const { baseline } = options;
  if (baseline !== null && typeof baseline === 'object') {
    return { status: 'blocked', reason: `unreadable ${baselineFile}: ${baseline.error}` };
  }

  if (options.accept) {
    const acceptance = acceptScore(baseline, actual, options.allowLowering, dropTolerance);
    if (acceptance.refused) {
      return {
        status: 'failed',
        reason:
          `accept refused: ${pct(actual)} is under the baseline ${pct(acceptance.next)}; ` +
          'set allowLowering as well to lower it on purpose',
      };
    }
    return {
      status: 'passed',
      reason:
        acceptance.next === actual
          ? `accepted ${pct(actual)} as the baseline`
          : `baseline kept at ${pct(acceptance.next)}: the run measured ${pct(actual)}, inside the tolerance`,
      write: acceptance.next,
    };
  }

  if (baseline === null) {
    return {
      status: 'blocked',
      reason: `no ${baselineFile}; create it from a complete run: ${acceptHint}`,
    };
  }
  const finding = compareToBaseline(baseline, actual, { dropTolerance, staleMargin });
  if (finding === 'dropped') {
    return {
      status: 'failed',
      reason: `mutation score dropped: ${pct(actual)} < baseline ${pct(baseline)} (tolerance ${points(dropTolerance)})`,
    };
  }
  if (finding === 'stale') {
    return {
      status: 'failed',
      reason:
        `baseline stale: ${pct(actual)} is more than ${points(staleMargin)} over ${pct(baseline)}; ` +
        `record the gain: ${acceptHint}`,
    };
  }
  return { status: 'passed', reason: `baseline ${pct(baseline)}` };
}
