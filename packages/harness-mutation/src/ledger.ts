import type { IReportedMutant } from './verdict.js';

/*
 * The two ways a mutant can be let through, and the one that is allowed.
 *
 * Allowed: a ledger file (`mutation-ledger.json` by default) next to the
 * package's Stryker config, a committed list of surviving mutants somebody
 * argued cannot be killed (an equivalent mutant: the changed code behaves the
 * same). Every entry carries a review date (`reviewBy`, YYYY-MM-DD): the
 * argument holds through that day, and every run after it fails until somebody
 * re-reads the entry and moves the date, or deletes it. Each entry names ONE
 * mutant, by what does not move when lines shift: the file, the mutator, the
 * code it puts there, the text of the line it sits on and the text of the
 * lines above and below it, plus the argument. The two neighbours are what
 * ties the entry to its place: the same line written again elsewhere in the
 * file is another mutant, with another argument to make, and does not match.
 * An entry that still names two mutants (the same three lines twice) fails.
 *
 * What an entry is tied to, exactly: the file, the mutator, the replacement,
 * and the trimmed text of three lines (the mutant's own, the nearest
 * non-blank one above, the nearest non-blank one below). What can change
 * under it with no diff of the ledger: everything else. The lines further
 * up and down in the same function (the rest of a loop body), the function's
 * name and signature, the indentation, and where in the file the three lines
 * stand. An argument that rests on a line outside the three (a comparison two
 * lines below a loop header, say) can therefore stop being true while the
 * entry still matches. The tooling does not see that; whoever changes code
 * next to an accepted mutant re-reads the entry's reason, and the review date
 * makes somebody do so on a schedule. An enclosing-function locator would need
 * a parser the report does not give.
 * It is shrink-only in both directions: a survivor with no entry fails the
 * changed-line check, and an entry no surviving mutant matches fails every run
 * that judged its line, so an entry cannot outlive the code it was argued for.
 *
 * Refused: Stryker's own switch, a `Stryker disable` comment in the source.
 * It is an inline suppression with no review behind it, and an ignored mutant
 * leaves the score, so it raises the ratchet's number by deleting what the
 * number counts. A run fails on one anywhere in the files it mutates, and on
 * any mutant the report says was ignored for a reason other than being static.
 *
 * Only decisions live here. run.ts reads the files.
 */

/** The ledger's file name in the target package, by default. */
export const LEDGER_FILE = 'mutation-ledger.json';

export interface IAcceptedMutant {
  /** The file, relative to the package, `/`-separated, as the report names it. */
  readonly file: string;
  /** Stryker's mutator name (`EqualityOperator`). */
  readonly mutator: string;
  /** The whole line the mutant sits on, trimmed. With the two below it is the locator: no line numbers. */
  readonly source: string;
  /** The nearest line above it that is not blank, trimmed; empty when there is none. */
  readonly before: string;
  /** The nearest line below it that is not blank, trimmed; empty when there is none. */
  readonly after: string;
  /** The code the mutant puts in place of the original. */
  readonly replacement: string;
  /** Why no test can kill it. */
  readonly reason: string;
  /** The last day the argument holds without a review (YYYY-MM-DD, UTC). */
  readonly reviewBy: string;
}

const ENTRY_KEYS = [
  'file',
  'mutator',
  'source',
  'before',
  'after',
  'replacement',
  'reason',
  'reviewBy',
] as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Whether `value` is a real calendar day written YYYY-MM-DD. */
function isDay(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A line of a file with its place: its own text and its nearest non-blank neighbours, all trimmed. */
export interface ILineContext {
  readonly text: string;
  readonly before: string;
  readonly after: string;
}

/** The context of line `line` (1-based) of a file's lines, or null when the file has no such line. */
export function lineContext(lines: readonly string[], line: number): ILineContext | null {
  const text = lines[line - 1];
  if (text === undefined) return null;
  const nearest = (step: -1 | 1): string => {
    for (let index = line - 1 + step; index >= 0 && index < lines.length; index += step) {
      const candidate = lines[index]?.trim() ?? '';
      if (candidate !== '') return candidate;
    }
    return '';
  };
  return { text: text.trim(), before: nearest(-1), after: nearest(1) };
}

/** A committed ledger: `{ "accepted": [ ... ] }`, every entry complete, none twice. */
export function parseLedger(text: string): IAcceptedMutant[] {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the ledger is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'accepted');
  if (extra.length > 0) {
    throw new Error(`the ledger has unknown key(s): ${extra.join(', ')}`);
  }
  const accepted = record['accepted'];
  if (!Array.isArray(accepted)) {
    throw new Error('the ledger\'s "accepted" is not an array');
  }
  const seen = new Set<string>();
  return accepted.map((raw, index) => {
    const where = `accepted[${String(index)}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${where} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(
      (key) => !(ENTRY_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new Error(`${where} has unknown key(s): ${unknown.join(', ')}`);
    }
    const text = (key: (typeof ENTRY_KEYS)[number]): string => {
      const value = entry[key];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${where}.${key} must be a non-empty string`);
      }
      return value;
    };
    // A neighbour is empty for the first or the last line of a file, never absent.
    const neighbour = (key: 'before' | 'after'): string => {
      const value = entry[key];
      if (typeof value !== 'string') {
        throw new Error(
          `${where}.${key} must be a string (the line ${key === 'before' ? 'above' : 'below'}, empty when there is none)`,
        );
      }
      return value.trim();
    };
    const mutant: IAcceptedMutant = {
      file: text('file'),
      mutator: text('mutator'),
      source: text('source').trim(),
      before: neighbour('before'),
      after: neighbour('after'),
      replacement: text('replacement'),
      reason: text('reason'),
      reviewBy: text('reviewBy').trim(),
    };
    if (!isDay(mutant.reviewBy)) {
      throw new Error(
        `${where}.reviewBy must be a date written YYYY-MM-DD (the last day the argument holds), not ${JSON.stringify(mutant.reviewBy)}`,
      );
    }
    const identity = JSON.stringify([
      mutant.file,
      mutant.mutator,
      mutant.source,
      mutant.before,
      mutant.after,
      mutant.replacement,
    ]);
    if (seen.has(identity)) {
      throw new Error(`${where} names the same mutant as an earlier entry`);
    }
    seen.add(identity);
    return mutant;
  });
}

export function describeEntry(entry: IAcceptedMutant): string {
  return `${entry.file} ${entry.mutator} -> ${entry.replacement} on \`${entry.source}\``;
}

/** Whether `entry` names `mutant`: the same file, mutator and replacement, on the same line in the same place. */
export function names(entry: IAcceptedMutant, mutant: IReportedMutant): boolean {
  return (
    mutant.file === entry.file &&
    mutant.mutatorName === entry.mutator &&
    mutant.replacement === entry.replacement &&
    mutant.sourceLine === entry.source &&
    mutant.lineBefore === entry.before &&
    mutant.lineAfter === entry.after
  );
}

/** The entry that accepts this mutant, if it survived and one names it exactly. */
export function acceptedBy(
  entries: readonly IAcceptedMutant[],
  mutant: IReportedMutant,
): IAcceptedMutant | null {
  if (mutant.status !== 'survived') return null;
  return entries.find((entry) => names(entry, mutant)) ?? null;
}

/**
 * The entries that name more than one mutant of a run, each with the mutants
 * it names. An entry accepts exactly one: when the same three lines stand in
 * two places, nothing says which of the two was argued for, so neither is
 * accepted until the code around them differs. `judged` as in staleEntries.
 */
export function ambiguousEntries(
  entries: readonly IAcceptedMutant[],
  mutants: readonly IReportedMutant[],
  judged: (entry: IAcceptedMutant) => boolean,
  ledgerFile: string = LEDGER_FILE,
): string[] {
  const ambiguous: string[] = [];
  for (const entry of entries) {
    if (!judged(entry)) continue;
    const named = mutants.filter((mutant) => names(entry, mutant));
    if (named.length > 1) {
      const where = named
        .map((mutant) => `${mutant.file}:${String(mutant.lines?.start ?? '?')}`)
        .join(', ');
      ambiguous.push(
        `${ledgerFile}: ${describeEntry(entry)} names ${String(named.length)} mutants (${where}): ` +
          'an entry accepts exactly one, so the lines around them have to differ',
      );
    }
  }
  return ambiguous;
}

/**
 * The entries a run proved stale, each with why. `judged` says whether the run
 * generated the mutants of an entry's line: a whole-package run did for every
 * file, a changed-line run only for the lines it was told to mutate. An entry
 * the run did not judge is left alone, not passed.
 */
export function staleEntries(
  entries: readonly IAcceptedMutant[],
  mutants: readonly IReportedMutant[],
  judged: (entry: IAcceptedMutant) => boolean,
  ledgerFile: string = LEDGER_FILE,
): string[] {
  const stale: string[] = [];
  for (const entry of entries) {
    if (!judged(entry)) continue;
    const named = mutants.filter((mutant) => names(entry, mutant));
    if (named.length === 0) {
      stale.push(
        `${ledgerFile}: ${describeEntry(entry)} matches no mutant any more: ` +
          'update its `source`, `before` and `after` to where the mutant is now, or delete the entry',
      );
    } else if (!named.some((mutant) => mutant.status === 'survived')) {
      stale.push(
        `${ledgerFile}: ${describeEntry(entry)} no longer survives (${named
          .map((mutant) => mutant.status)
          .join(', ')}): delete the entry`,
      );
    }
  }
  return stale;
}

/** The UTC day of `ms` (epoch milliseconds), YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The entries whose review date has passed on `today` (YYYY-MM-DD), each with
 * what to do. An entry holds through its `reviewBy` day and lapses the day
 * after: the argument has to be read again before it lets a mutant through.
 */
export function expiredEntries(
  entries: readonly IAcceptedMutant[],
  today: string,
  ledgerFile: string = LEDGER_FILE,
): string[] {
  return entries
    .filter((entry) => entry.reviewBy < today)
    .map(
      (entry) =>
        `${ledgerFile}: ${describeEntry(entry)} was due for review on ${entry.reviewBy}: ` +
        're-read its reason and move reviewBy forward, or delete the entry',
    );
}

/** `Stryker disable` in any spelling Stryker reads: it matches the word pair, whatever follows. */
const DIRECTIVE = /\bStryker\s+disable\b/u;

/** The 1-based lines of a source file that switch mutants off with a Stryker comment. */
export function directiveLines(source: string): number[] {
  const lines: number[] = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    if (DIRECTIVE.test(line)) lines.push(index + 1);
  });
  return lines;
}

/**
 * The mutants the report says were switched off: ignored, and not because
 * they are static. A comment, a config's `excludedMutations` and an ignore
 * plugin all end here, whatever the source scan saw.
 */
export function switchedOff(mutants: readonly IReportedMutant[]): IReportedMutant[] {
  return mutants.filter((mutant) => mutant.status === 'ignored' && !mutant.static);
}

/** Stryker's note on a timeout its hit counter caused: a loop the mutant made endless. */
const HIT_LIMIT = /^Hit limit reached/u;

/**
 * Whether a mutant timed out on the clock. A hit-limit timeout is a loop the
 * mutant made endless: no test can kill it and it is the same on every
 * machine. Any other timeout is a run that did not finish in time, which is
 * also what a survivor looks like on a loaded machine: not judged.
 */
export function ranOutOfTime(mutant: IReportedMutant): boolean {
  return mutant.status === 'timeout' && !HIT_LIMIT.test(mutant.statusReason ?? '');
}

/**
 * Whether a mutant ended in a runtime error: the test run itself broke, which
 * is not a test result. A crashed worker on a loaded machine looks like this,
 * and so does a mutant that breaks the run on every machine; the report does
 * not say which, so it is not judged either way. A compile error is another
 * matter: only a checker plugin gives that status, before any test runs, so
 * it is the same on every machine.
 */
export function brokeTheRun(mutant: IReportedMutant): boolean {
  return mutant.status === 'runtimeError';
}

/** A mutant this run did not judge: it ran out of time, or its run broke. */
export function notJudged(mutant: IReportedMutant): boolean {
  return ranOutOfTime(mutant) || brokeTheRun(mutant);
}

export function describeMutant(mutant: IReportedMutant): string {
  const line = mutant.lines === null ? '' : `:${String(mutant.lines.start)}`;
  const replacement = mutant.replacement === null ? '' : ` -> ${mutant.replacement}`;
  return `${mutant.file}${line} ${mutant.mutatorName}${replacement}`;
}
