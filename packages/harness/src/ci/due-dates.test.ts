import { describe, expect, test } from 'bun:test';

import { renderTrivyIgnoreFile } from '../pinned-tools/trivy.js';
import {
  collectDueEntries,
  daysLeft,
  DUE_FAIL_DAYS,
  DUE_LIST_DAYS,
  dueReport,
  formatDueReport,
  type IDueCollection,
} from './due-dates.js';

const TODAY = '2026-11-18';

function ledger(entries: Record<string, unknown>): string {
  return JSON.stringify(entries);
}

const IGNORE = renderTrivyIgnoreFile([
  {
    section: 'vulnerabilities',
    id: 'CVE-2026-50015',
    paths: [],
    statement: 'no fixed release yet',
    expiredAt: '2026-11-20',
  },
]);

describe('collectDueEntries', () => {
  test('reads each dated ledger entry', () => {
    const collection = collectDueEntries({
      ledgers: { 'overrides.json': ledger({ lodash: { reviewBy: '2026-12-01', why: 'x' } }) },
    });
    expect(collection).toEqual({
      entries: [{ source: 'overrides.json', key: 'lodash', due: '2026-12-01' }],
      problems: [],
    });
  });

  test('an undated, misdated or impossible date entry is a problem', () => {
    const collection = collectDueEntries({
      ledgers: {
        'a.json': ledger({
          none: { why: 'x' },
          text: { reviewBy: 'next week' },
          feb30: { reviewBy: '2026-02-30' },
          scalar: 'reviewBy',
          nil: null,
        }),
      },
    });
    expect(collection.entries).toEqual([]);
    expect(collection.problems).toEqual([
      'a.json: none has no reviewBy date (YYYY-MM-DD)',
      'a.json: text has no reviewBy date (YYYY-MM-DD)',
      'a.json: feb30 has no reviewBy date (YYYY-MM-DD)',
      'a.json: scalar has no reviewBy date (YYYY-MM-DD)',
      'a.json: nil has no reviewBy date (YYYY-MM-DD)',
    ]);
  });

  test('a ledger that is not JSON, or not an object, is a problem', () => {
    const collection = collectDueEntries({
      ledgers: { 'bad.json': '{ nope', 'list.json': '[]', 'null.json': 'null' },
    });
    expect(collection.problems).toHaveLength(3);
    expect(collection.problems[0]).toMatch(/^bad\.json is not JSON/u);
    expect(collection.problems.slice(1)).toEqual([
      'list.json is not a JSON object',
      'null.json is not a JSON object',
    ]);
  });

  test('skips metadata keys with the prefix, and a custom prefix or none', () => {
    const text = ledger({ $schema: './schema.json', _note: 'x', a: { reviewBy: '2026-12-01' } });
    expect(collectDueEntries({ ledgers: { l: text } }).problems).toEqual([
      'l: _note has no reviewBy date (YYYY-MM-DD)',
    ]);
    expect(collectDueEntries({ ledgers: { l: text } }, { skipKeyPrefix: '_' }).problems).toEqual([
      'l: $schema has no reviewBy date (YYYY-MM-DD)',
    ]);
    expect(
      collectDueEntries({ ledgers: { l: text } }, { skipKeyPrefix: '' }).problems,
    ).toHaveLength(2);
  });

  test('reads a custom date field', () => {
    const collection = collectDueEntries(
      { ledgers: { l: ledger({ a: { expires: '2027-01-01' } }) } },
      { dateField: 'expires' },
    );
    expect(collection.entries).toEqual([{ source: 'l', key: 'a', due: '2027-01-01' }]);
    expect(
      collectDueEntries({ ledgers: { l: ledger({ a: {} }) } }, { dateField: 'expires' }).problems,
    ).toEqual(['l: a has no expires date (YYYY-MM-DD)']);
  });

  test('reads trivy ignore expired_at dates under the ignore file name', () => {
    expect(collectDueEntries({ ledgers: {}, trivyIgnore: IGNORE }).entries).toEqual([
      { source: '.trivyignore.yaml', key: 'CVE-2026-50015', due: '2026-11-20' },
    ]);
    expect(
      collectDueEntries({ ledgers: {}, trivyIgnore: IGNORE, trivyIgnoreName: 'sec/ignore.yaml' })
        .entries[0]?.source,
    ).toBe('sec/ignore.yaml');
  });

  test('a trivy ignore entry without a date is a problem', () => {
    const undated = IGNORE.replace(/\n {4}expired_at: .*/u, '');
    expect(collectDueEntries({ ledgers: {}, trivyIgnore: undated }).problems).toEqual([
      '.trivyignore.yaml: CVE-2026-50015 has no expired_at date (YYYY-MM-DD)',
    ]);
    const noId = undated.replace('id: CVE-2026-50015', 'id: "x"');
    expect(collectDueEntries({ ledgers: {}, trivyIgnore: noId }).problems).toEqual([
      '.trivyignore.yaml: an entry has no expired_at date (YYYY-MM-DD)',
    ]);
  });

  test('no trivy ignore file adds nothing', () => {
    expect(collectDueEntries({ ledgers: {}, trivyIgnore: null })).toEqual({
      entries: [],
      problems: [],
    });
  });

  test('carries problems found while reading the sources', () => {
    expect(collectDueEntries({ ledgers: {}, problems: ['x.json is missing'] }).problems).toEqual([
      'x.json is missing',
    ]);
  });
});

describe('daysLeft', () => {
  test('counts whole days, zero on the due day and negative once lapsed', () => {
    expect(daysLeft(TODAY, '2026-11-25')).toBe(7);
    expect(daysLeft(TODAY, TODAY)).toBe(0);
    expect(daysLeft(TODAY, '2026-11-17')).toBe(-1);
    expect(daysLeft('2027-03-27', '2027-03-29')).toBe(2);
  });
});

function collection(...dues: [string, string, string][]): IDueCollection {
  return { entries: dues.map(([source, key, due]) => ({ source, key, due })), problems: [] };
}

describe('dueReport', () => {
  const entries = collection(
    ['b.json', 'later', '2026-12-30'],
    ['b.json', 'soon', '2026-11-30'],
    ['b.json', 'week', '2026-11-25'],
    ['a.json', 'week', '2026-11-25'],
    ['a.json', 'lapsed', '2026-11-10'],
  );

  test('lists entries due within the list window, soonest first, then by source and key', () => {
    const report = dueReport(entries, TODAY);
    expect(report.listed.map((entry) => `${entry.source}:${entry.key}:${entry.daysLeft}`)).toEqual([
      'a.json:lapsed:-8',
      'a.json:week:7',
      'b.json:week:7',
      'b.json:soon:12',
    ]);
    expect(report.failing).toBe(3);
    expect(report.passed).toBe(false);
    expect(DUE_LIST_DAYS).toBe(14);
    expect(DUE_FAIL_DAYS).toBe(7);
  });

  test('passes when nothing is in the fail window', () => {
    const report = dueReport(collection(['a', 'k', '2026-11-30']), TODAY);
    expect(report).toMatchObject({ failing: 0, passed: true });
    expect(report.listed).toHaveLength(1);
  });

  test('custom windows: failDays -1 fails only lapsed entries', () => {
    const report = dueReport(entries, TODAY, { listDays: 60, failDays: -1 });
    expect(report.listed).toHaveLength(5);
    expect(report.failing).toBe(1);
    expect(dueReport(collection(['a', 'k', TODAY]), TODAY, { failDays: -1 }).passed).toBe(true);
  });

  test('a fail window wider than the list window still lists what fails', () => {
    const report = dueReport(collection(['a', 'k', '2026-12-30']), TODAY, {
      listDays: 7,
      failDays: 60,
    });
    expect(report.listed).toHaveLength(1);
    expect(report.failing).toBe(1);
  });

  test('a problem fails the report', () => {
    const report = dueReport({ entries: [], problems: ['l: a has no reviewBy date'] }, TODAY);
    expect(report.passed).toBe(false);
  });
});

describe('formatDueReport', () => {
  test('a passing report ends in a passed summary', () => {
    const report = dueReport(collection(['a.json', 'k', '2026-11-30']), TODAY);
    expect(formatDueReport(report, 3)).toEqual([
      'soon  2026-11-30  12 days left          a.json  k',
      'due-dates: passed (3 dated entries, 1 due within 14 days, none due within 7 days or lapsed)',
    ]);
  });

  test('a failing report marks each failing line and tells the user what to do', () => {
    const report = dueReport(
      {
        entries: [
          { source: 'a.json', key: 'today', due: TODAY },
          { source: 'a.json', key: 'one', due: '2026-11-19' },
          { source: 'a.json', key: 'gone', due: '2026-11-17' },
          { source: 'a.json', key: 'long', due: '2026-11-08' },
        ],
        problems: ['b.json is not a JSON object'],
      },
      TODAY,
    );
    const lines = formatDueReport(report, 4);
    expect(lines).toEqual([
      'FAIL  2026-11-08  lapsed 10 days ago    a.json  long',
      'FAIL  2026-11-17  lapsed 1 day ago      a.json  gone',
      'FAIL  2026-11-18  last day today        a.json  today',
      'FAIL  2026-11-19  1 day left            a.json  one',
      'FAIL  b.json is not a JSON object',
      'due-dates: failed (4 due within 7 days or lapsed, 1 problem; renew or remove the entries, and date every entry)',
    ]);
  });

  test('takes a label and describes a lapsed-only fail window', () => {
    const passed = dueReport(collection(['a', 'k', TODAY]), TODAY, { failDays: -1 });
    expect(formatDueReport(passed, 1, { failDays: -1, label: 'ledgers' }).at(-1)).toBe(
      'ledgers: passed (1 dated entry, 1 due within 14 days, none lapsed)',
    );
    const failed = dueReport(collection(['a', 'k', '2026-11-01']), TODAY, { failDays: -1 });
    expect(formatDueReport(failed, 1, { failDays: -1 }).at(-1)).toBe(
      'due-dates: failed (1 lapsed, 0 problems; renew or remove the entries, and date every entry)',
    );
  });
});
