import assert from 'node:assert/strict';

import { describe, it } from 'bun:test';

import {
  acceptedBy,
  ambiguousEntries,
  describeMutant,
  directiveLines,
  expiredEntries,
  type IAcceptedMutant,
  lineContext,
  parseLedger,
  staleEntries,
  switchedOff,
  utcDay,
} from './ledger.js';
import type { IReportedMutant } from './verdict.js';

const ENTRY: IAcceptedMutant = {
  file: 'src/constants/safe-path.ts',
  mutator: 'EqualityOperator',
  source: 'for (let index = 0; index < value.length; index += 1) {',
  before: "if (value.includes('\\\\')) return false;",
  after: 'const code = value.charCodeAt(index);',
  replacement: 'index <= value.length',
  reason: 'equivalent: charCodeAt past the end is NaN, and NaN passes neither comparison',
  reviewBy: '2099-01-01',
};

function mutant(overrides: Partial<IReportedMutant> = {}): IReportedMutant {
  return {
    file: ENTRY.file,
    status: 'survived',
    mutatorName: ENTRY.mutator,
    replacement: ENTRY.replacement,
    lines: { start: 35, end: 35 },
    sourceLine: ENTRY.source,
    lineBefore: ENTRY.before,
    lineAfter: ENTRY.after,
    testsCompleted: 26,
    static: false,
    statusReason: null,
    ...overrides,
  };
}

describe('parseLedger', () => {
  it('reads the accepted mutants, with the line they sit on trimmed', () => {
    const text = JSON.stringify({ accepted: [{ ...ENTRY, source: `  ${ENTRY.source}  ` }] });
    assert.deepEqual(parseLedger(text), [ENTRY]);
    assert.deepEqual(parseLedger('{ "accepted": [] }'), []);
  });

  it('refuses an entry without a reason, or without any other field', () => {
    for (const key of ['file', 'mutator', 'source', 'replacement', 'reason'] as const) {
      // `before` and `after` may be empty (the first and the last line of a file); see below.
      const { [key]: _dropped, ...rest } = ENTRY;
      assert.throws(
        () => parseLedger(JSON.stringify({ accepted: [rest] })),
        new RegExp(`accepted\\[0\\]\\.${key} must be a non-empty string`, 'u'),
      );
      assert.throws(
        () => parseLedger(JSON.stringify({ accepted: [{ ...ENTRY, [key]: '   ' }] })),
        new RegExp(`accepted\\[0\\]\\.${key} must be a non-empty string`, 'u'),
      );
    }
  });

  it('refuses anything else in the file: an unknown key, a second copy of an entry, another shape', () => {
    assert.throws(() => parseLedger('[]'), /not a JSON object/u);
    assert.throws(() => parseLedger('{}'), /"accepted" is not an array/u);
    assert.throws(
      () => parseLedger(JSON.stringify({ accepted: [], allowAll: true })),
      /unknown key\(s\): allowAll/u,
    );
    assert.throws(
      () => parseLedger(JSON.stringify({ accepted: [{ ...ENTRY, line: 35 }] })),
      /accepted\[0\] has unknown key\(s\): line/u,
    );
    assert.throws(
      () => parseLedger(JSON.stringify({ accepted: [ENTRY, { ...ENTRY, reason: 'again' }] })),
      /accepted\[1\] names the same mutant as an earlier entry/u,
    );
    assert.throws(
      () => parseLedger(JSON.stringify({ accepted: ['x'] })),
      /accepted\[0\] is not an object/u,
    );
  });
});

describe('parseLedger: the review date', () => {
  it('needs a real calendar day written YYYY-MM-DD, with a message that says so', () => {
    const { reviewBy: _omitted, ...rest } = ENTRY;
    assert.throws(
      () => parseLedger(JSON.stringify({ accepted: [rest] })),
      /accepted\[0\]\.reviewBy must be a non-empty string/u,
    );
    for (const bad of ['2026-13-01', '2026-02-30', '26-01-01', 'next year', '2026/01/01']) {
      assert.throws(
        () => parseLedger(JSON.stringify({ accepted: [{ ...ENTRY, reviewBy: bad }] })),
        /accepted\[0\]\.reviewBy must be a date written YYYY-MM-DD/u,
        bad,
      );
    }
    assert.equal(
      parseLedger(JSON.stringify({ accepted: [{ ...ENTRY, reviewBy: ' 2028-02-29 ' }] }))[0]
        ?.reviewBy,
      '2028-02-29',
    );
  });
});

describe('expiredEntries', () => {
  const dated = (reviewBy: string): IAcceptedMutant => ({ ...ENTRY, reviewBy });

  it('holds an entry through its review day and fails it the day after', () => {
    assert.deepEqual(expiredEntries([dated('2026-11-18')], '2026-11-18'), []);
    assert.deepEqual(expiredEntries([dated('2026-11-17')], '2026-11-18'), [
      `mutation-ledger.json: ${ENTRY.file} EqualityOperator -> index <= value.length on \`${ENTRY.source}\` ` +
        'was due for review on 2026-11-17: re-read its reason and move reviewBy forward, or delete the entry',
    ]);
  });

  it('names the ledger it was given, and lists only the lapsed entries', () => {
    const found = expiredEntries(
      [dated('2020-01-01'), dated('2099-01-01'), { ...dated('2026-01-01'), mutator: 'Other' }],
      '2026-06-01',
      'accepted.json',
    );
    assert.equal(found.length, 2);
    assert.ok(found.every((line) => line.startsWith('accepted.json: ')));
  });

  it('reads the UTC day of a timestamp', () => {
    assert.equal(utcDay(Date.UTC(2026, 10, 18, 23, 59)), '2026-11-18');
    assert.equal(utcDay(Date.UTC(2026, 0, 1)), '2026-01-01');
  });
});

describe('lineContext', () => {
  const lines = ['first();', '', '  target();  ', '', '', 'last();', ''];

  it('is the line with its nearest neighbours that are not blank, all trimmed', () => {
    assert.deepEqual(lineContext(lines, 3), {
      text: 'target();',
      before: 'first();',
      after: 'last();',
    });
  });

  it('has an empty neighbour at either end of the file, and is null past it', () => {
    assert.deepEqual(lineContext(lines, 1), { text: 'first();', before: '', after: 'target();' });
    assert.deepEqual(lineContext(lines, 6), { text: 'last();', before: 'target();', after: '' });
    assert.equal(lineContext(lines, 8), null);
    assert.equal(lineContext(lines, 0), null);
  });
});

describe('parseLedger: the locator', () => {
  it('needs the line above and the line below, which may be empty but not missing', () => {
    for (const key of ['before', 'after'] as const) {
      const { [key]: _dropped, ...rest } = ENTRY;
      assert.throws(
        () => parseLedger(JSON.stringify({ accepted: [rest] })),
        new RegExp(`accepted\\[0\\]\\.${key} must be a string`, 'u'),
      );
      assert.throws(
        () => parseLedger(JSON.stringify({ accepted: [{ ...ENTRY, [key]: 7 }] })),
        new RegExp(`accepted\\[0\\]\\.${key} must be a string`, 'u'),
      );
    }
    const atTheTop = { ...ENTRY, before: '', after: `  ${ENTRY.after}  ` };
    assert.deepEqual(parseLedger(JSON.stringify({ accepted: [atTheTop] })), [
      { ...ENTRY, before: '' },
    ]);
  });

  it('reads two entries for the same line text in two places as two entries', () => {
    const elsewhere = { ...ENTRY, before: 'let count = 0;' };
    assert.equal(parseLedger(JSON.stringify({ accepted: [ENTRY, elsewhere] })).length, 2);
  });
});

describe('acceptedBy', () => {
  it('accepts a survivor that an entry names by file, mutator, line text and replacement', () => {
    assert.equal(acceptedBy([ENTRY], mutant()), ENTRY);
    // The line number is no part of the match: the entry survives lines moving.
    assert.equal(acceptedBy([ENTRY], mutant({ lines: { start: 90, end: 90 } })), ENTRY);
  });

  it('accepts nothing that differs in any of the four, and nothing that did not survive', () => {
    for (const other of [
      mutant({ file: 'src/other.ts' }),
      mutant({ mutatorName: 'ConditionalExpression' }),
      mutant({ replacement: 'index >= value.length' }),
      mutant({ sourceLine: 'for (let index = 1; index < value.length; index += 1) {' }),
      mutant({ sourceLine: null }),
      // The same line under another line, or above another one: a copy, not the entry's place.
      mutant({ lineBefore: 'let count = 0;' }),
      mutant({ lineAfter: "if (value[index] !== 'a') count += 1;" }),
      mutant({ lineBefore: null }),
      mutant({ status: 'noCoverage' }),
      mutant({ status: 'timeout' }),
    ]) {
      assert.equal(acceptedBy([ENTRY], other), null, JSON.stringify(other));
    }
  });
});

describe('staleEntries', () => {
  const all = (): boolean => true;

  it('finds nothing stale while a surviving mutant matches each entry', () => {
    assert.deepEqual(
      staleEntries([ENTRY], [mutant(), mutant({ status: 'killed', replacement: 'x' })], all),
      [],
    );
  });

  it('reports an entry no mutant matches: the line it was argued for is gone', () => {
    const stale = staleEntries(
      [ENTRY],
      [mutant({ sourceLine: 'for (const char of value) {' })],
      all,
    );
    assert.deepEqual(stale, [
      'mutation-ledger.json: src/constants/safe-path.ts EqualityOperator -> index <= value.length ' +
        'on `for (let index = 0; index < value.length; index += 1) {` matches no mutant any more: ' +
        'update its `source`, `before` and `after` to where the mutant is now, or delete the entry',
    ]);
  });

  it('reports an entry whose mutant is killed, has no coverage or is ignored now', () => {
    for (const status of ['killed', 'noCoverage', 'ignored', 'timeout'] as const) {
      const stale = staleEntries([ENTRY], [mutant({ status })], all);
      assert.equal(stale.length, 1, status);
      assert.match(
        stale[0] ?? '',
        new RegExp(`no longer survives \\(${status}\\): delete the entry$`, 'u'),
      );
    }
  });

  it('leaves alone an entry the run did not judge', () => {
    assert.deepEqual(
      staleEntries([ENTRY], [], () => false),
      [],
    );
  });
});

describe('ambiguousEntries', () => {
  const all = (): boolean => true;

  it('finds nothing while each entry names one mutant', () => {
    assert.deepEqual(ambiguousEntries([ENTRY], [mutant(), mutant({ replacement: 'x' })], all), []);
  });

  it('reports an entry that names two mutants, with the line of each', () => {
    const twice = [mutant(), mutant({ lines: { start: 61, end: 61 } })];
    assert.deepEqual(ambiguousEntries([ENTRY], twice, all), [
      'mutation-ledger.json: src/constants/safe-path.ts EqualityOperator -> index <= value.length ' +
        'on `for (let index = 0; index < value.length; index += 1) {` names 2 mutants ' +
        '(src/constants/safe-path.ts:35, src/constants/safe-path.ts:61): ' +
        'an entry accepts exactly one, so the lines around them have to differ',
    ]);
  });

  it('counts a killed copy as well: the entry no longer says which mutant it means', () => {
    const copies = [mutant(), mutant({ status: 'killed', lines: { start: 61, end: 61 } })];
    assert.equal(ambiguousEntries([ENTRY], copies, all).length, 1);
  });

  it('leaves alone an entry the run did not judge', () => {
    assert.deepEqual(
      ambiguousEntries([ENTRY], [mutant(), mutant()], () => false),
      [],
    );
  });
});

describe('directiveLines', () => {
  it('finds every spelling of the comment that switches mutants off', () => {
    const source = [
      'const a = 1;',
      '// Stryker disable all',
      'const b = 2; // Stryker disable next-line EqualityOperator: equivalent',
      '/* Stryker   disable BooleanLiteral */',
      '// Stryker restore all',
      'const stryker = "disable";',
      '// the stryker docs say disable is possible',
    ].join('\r\n');
    assert.deepEqual(directiveLines(source), [2, 3, 4]);
    assert.deepEqual(directiveLines(''), []);
  });
});

describe('switchedOff', () => {
  it('is every ignored mutant that is not static', () => {
    const off = mutant({ status: 'ignored', statusReason: 'Ignored using a comment' });
    assert.deepEqual(
      switchedOff([
        mutant(),
        mutant({ status: 'ignored', static: true, statusReason: 'Static mutant' }),
        off,
      ]),
      [off],
    );
  });
});

describe('describeMutant', () => {
  it('prints file, line, mutator and replacement', () => {
    assert.equal(
      describeMutant(mutant()),
      'src/constants/safe-path.ts:35 EqualityOperator -> index <= value.length',
    );
    assert.equal(
      describeMutant(mutant({ lines: null, replacement: null })),
      'src/constants/safe-path.ts EqualityOperator',
    );
  });
});
