import { readTrivyIgnoreFile, TRIVY_IGNORE_FILE } from '../pinned-tools/trivy.js';

/*
 * Dated exceptions turn a gate red on a calendar day, not on a commit: a
 * ledger entry with a review date, a trivy ignore with an `expired_at`. Nothing
 * else lists them, so a quiet fortnight can let several gates go red with
 * nobody told. This lists every entry due within `listDays` and fails on one
 * due within `failDays` (or lapsed), for a scheduled CI job: the early warning
 * is a red scheduled run ahead of the date, which the CI host mails.
 */

export interface IDueOptions {
  /** The field of a ledger entry that holds its date. Defaults to `reviewBy`. */
  readonly dateField?: string;
  /** Entries due within this many days are listed. Defaults to 14. */
  readonly listDays?: number;
  /** An entry due within this many days fails the run. Defaults to 7; -1 fails only lapsed entries. */
  readonly failDays?: number;
  /** Top-level ledger keys with this prefix are metadata, not entries. Defaults to `$`. */
  readonly skipKeyPrefix?: string;
  /** The name the summary line starts with. Defaults to `due-dates`. */
  readonly label?: string;
}

/** Entries due within this many days are listed, unless `listDays` says otherwise. */
export const DUE_LIST_DAYS = 14;

/** An entry due within this many days fails, unless `failDays` says otherwise. */
export const DUE_FAIL_DAYS = 7;

export interface IDueSources {
  /** Ledger file name to its text, for each JSON ledger whose entries carry a date. */
  readonly ledgers: Readonly<Record<string, string>>;
  /** The text of the trivy ignore file, or null or absent when there is none. */
  readonly trivyIgnore?: string | null;
  /** The name the trivy ignore entries are reported under. Defaults to `.trivyignore.yaml`. */
  readonly trivyIgnoreName?: string;
  /** Problems found while reading the sources (a missing ledger), carried into the report. */
  readonly problems?: readonly string[];
}

export interface IDueEntry {
  /** The file the entry lives in. */
  readonly source: string;
  /** The ledger key or trivy id. */
  readonly key: string;
  /** The last day the entry still holds (YYYY-MM-DD, UTC). */
  readonly due: string;
}

export interface IDueCollection {
  readonly entries: readonly IDueEntry[];
  /** Entries this cannot date and sources it cannot read: each is a failure. */
  readonly problems: readonly string[];
}

export interface IDueReport {
  /** Due within `listDays` (or lapsed), soonest first. */
  readonly listed: readonly (IDueEntry & { readonly daysLeft: number })[];
  /** How many of the listed entries are due within `failDays` (or lapsed). */
  readonly failing: number;
  readonly problems: readonly string[];
  readonly passed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

/** Whether `value` is a calendar date written as YYYY-MM-DD. */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function ledgerEntries(source: string, text: string, options: IDueOptions): IDueCollection {
  const dateField = options.dateField ?? 'reviewBy';
  const skip = options.skipKeyPrefix ?? '$';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { entries: [], problems: [`${source} is not JSON: ${String(error)}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entries: [], problems: [`${source} is not a JSON object`] };
  }
  const entries: IDueEntry[] = [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (skip !== '' && key.startsWith(skip)) continue;
    const date: unknown =
      value !== null && typeof value === 'object' ? Reflect.get(value, dateField) : undefined;
    if (typeof date !== 'string' || !isRealDate(date)) {
      problems.push(`${source}: ${key} has no ${dateField} date (YYYY-MM-DD)`);
      continue;
    }
    entries.push({ source, key, due: date });
  }
  return { entries, problems };
}

/** Every dated entry in the given sources, and the ones that carry no readable date. */
export function collectDueEntries(sources: IDueSources, options: IDueOptions = {}): IDueCollection {
  const entries: IDueEntry[] = [];
  const problems: string[] = [...(sources.problems ?? [])];
  for (const [source, text] of Object.entries(sources.ledgers)) {
    const found = ledgerEntries(source, text, options);
    entries.push(...found.entries);
    problems.push(...found.problems);
  }
  const trivyIgnore = sources.trivyIgnore ?? null;
  if (trivyIgnore !== null) {
    const name = sources.trivyIgnoreName ?? TRIVY_IGNORE_FILE;
    // The date passed only decides the reader's own expiry problems, which
    // are not used here: this judges the dates itself, below.
    const file = readTrivyIgnoreFile(trivyIgnore, '1970-01-01', { ignoreFile: name });
    for (const entry of file.entries) {
      if (!isRealDate(entry.expiredAt)) {
        problems.push(`${name}: ${entry.id || 'an entry'} has no expired_at date (YYYY-MM-DD)`);
        continue;
      }
      entries.push({ source: name, key: entry.id, due: entry.expiredAt });
    }
  }
  return { entries, problems };
}

/** Whole days from `today` to `due`: 0 on the last day the entry holds, negative once it lapsed. */
export function daysLeft(today: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** The report for `today` (YYYY-MM-DD, UTC). */
export function dueReport(
  collection: IDueCollection,
  today: string,
  options: IDueOptions = {},
): IDueReport {
  const listDays = options.listDays ?? DUE_LIST_DAYS;
  const failDays = options.failDays ?? DUE_FAIL_DAYS;
  const listed = collection.entries
    .map((entry) => ({ ...entry, daysLeft: daysLeft(today, entry.due) }))
    .filter((entry) => entry.daysLeft <= Math.max(listDays, failDays))
    .sort(
      (a, b) =>
        a.daysLeft - b.daysLeft || a.source.localeCompare(b.source) || a.key.localeCompare(b.key),
    );
  const failing = listed.filter((entry) => entry.daysLeft <= failDays).length;
  return {
    listed,
    failing,
    problems: collection.problems,
    passed: failing === 0 && collection.problems.length === 0,
  };
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function remaining(daysToGo: number): string {
  if (daysToGo < 0) return `lapsed ${plural(-daysToGo, 'day')} ago`;
  if (daysToGo === 0) return 'last day today';
  return `${plural(daysToGo, 'day')} left`;
}

/** The report as lines, ending in a `<label>: passed|failed (...)` summary. */
export function formatDueReport(
  report: IDueReport,
  total: number,
  options: IDueOptions = {},
): string[] {
  const listDays = options.listDays ?? DUE_LIST_DAYS;
  const failDays = options.failDays ?? DUE_FAIL_DAYS;
  const label = options.label ?? 'due-dates';
  const failWindow = failDays < 0 ? 'lapsed' : `due within ${String(failDays)} days or lapsed`;
  const lines = report.listed.map(
    (entry) =>
      `${entry.daysLeft <= failDays ? 'FAIL' : 'soon'}  ${entry.due}  ${remaining(entry.daysLeft).padEnd(20)}  ${entry.source}  ${entry.key}`,
  );
  lines.push(...report.problems.map((problem) => `FAIL  ${problem}`));
  const summary = report.passed
    ? `${String(total)} dated ${total === 1 ? 'entry' : 'entries'}, ${String(report.listed.length)} due within ${String(listDays)} days, none ${failWindow}`
    : `${String(report.failing)} ${failWindow}, ${plural(report.problems.length, 'problem')}; renew or remove the entries, and date every entry`;
  lines.push(`${label}: ${report.passed ? 'passed' : 'failed'} (${summary})`);
  return lines;
}
