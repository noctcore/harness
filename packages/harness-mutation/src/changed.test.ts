import assert from 'node:assert/strict';

import { describe, it } from 'bun:test';

import {
  type IChangedPlan,
  type IPlanInput,
  judgeChanged,
  mergeRanges,
  mutated,
  mutatePatterns,
  nothingToCheck,
  parseDiff,
  planChangedRun,
} from './changed.js';
import type { IAcceptedMutant } from './ledger.js';

const SHARED_PATTERNS = ['src/**/*.ts', '!src/**/*.test.ts', '!src/types/**'];

function fileDiff(path: string, hunks: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join('\n');
}

describe('parseDiff', () => {
  it('reads the new-side lines of every hunk of every file', () => {
    const diff = parseDiff(
      [
        fileDiff('packages/lib/src/a.ts', [
          '@@ -3 +3 @@ export function a() {',
          '-  return 1;',
          '+  return 2;',
          '@@ -10,2 +10,3 @@',
          '-  one();',
          '-  two();',
          '+  one();',
          '+  two();',
          '+  three();',
        ]),
        fileDiff('packages/lib/src/b.ts', ['@@ -7,0 +8,2 @@', '+  added();', '+  again();']),
        '',
      ].join('\n'),
    );

    assert.deepEqual(Object.fromEntries(diff.files), {
      'packages/lib/src/a.ts': [
        { start: 3, end: 3 },
        { start: 10, end: 12 },
      ],
      'packages/lib/src/b.ts': [{ start: 8, end: 9 }],
    });
    assert.deepEqual([...diff.deletionOnlyHunks], []);
  });

  it('counts a hunk that only removes lines and gives it no range', () => {
    const diff = parseDiff(
      fileDiff('packages/lib/src/a.ts', [
        '@@ -4,2 +3,0 @@',
        '-  if (!allowed) return;',
        '-  audit();',
        '@@ -9 +7 @@',
        '-  old();',
        '+  next();',
      ]),
    );

    assert.deepEqual(diff.files.get('packages/lib/src/a.ts'), [{ start: 7, end: 7 }]);
    assert.deepEqual([...diff.deletionOnlyHunks], [['packages/lib/src/a.ts', 1]]);
  });

  it('reads a new file as every line, and gives a deleted file nothing', () => {
    const diff = parseDiff(
      [
        'diff --git a/packages/lib/src/new.ts b/packages/lib/src/new.ts',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/packages/lib/src/new.ts',
        '@@ -0,0 +1,3 @@',
        '+one',
        '+two',
        '+three',
        'diff --git a/packages/lib/src/gone.ts b/packages/lib/src/gone.ts',
        'deleted file mode 100644',
        'index 4444444..0000000',
        '--- a/packages/lib/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-one',
        '-two',
      ].join('\n'),
    );

    assert.deepEqual(Object.fromEntries(diff.files), {
      'packages/lib/src/new.ts': [{ start: 1, end: 3 }],
    });
    assert.deepEqual([...diff.deletionOnlyHunks], [['packages/lib/src/gone.ts', 1]]);
  });

  it('takes a rename with an edit under its new name, and a pure rename as no change', () => {
    const diff = parseDiff(
      [
        'diff --git a/packages/lib/src/old.ts b/packages/lib/src/moved.ts',
        'similarity index 100%',
        'rename from packages/lib/src/old.ts',
        'rename to packages/lib/src/moved.ts',
        'diff --git a/packages/lib/src/x.ts b/packages/lib/src/y.ts',
        'similarity index 90%',
        'rename from packages/lib/src/x.ts',
        'rename to packages/lib/src/y.ts',
        'index 5555555..6666666 100644',
        '--- a/packages/lib/src/x.ts',
        '+++ b/packages/lib/src/y.ts',
        '@@ -5 +5 @@',
        '-  return x;',
        '+  return y;',
      ].join('\n'),
    );

    assert.deepEqual(Object.fromEntries(diff.files), {
      'packages/lib/src/y.ts': [{ start: 5, end: 5 }],
    });
  });

  it('does not take an added line that reads like a file header for one', () => {
    const diff = parseDiff(
      fileDiff('packages/lib/src/a.ts', [
        '@@ -2,0 +3,3 @@',
        '+++ b/packages/lib/src/evil.ts',
        '+@@ -1 +1,400 @@',
        '+  real();',
        '@@ -20 +23 @@',
        '-x',
        '+y',
        '\\ No newline at end of file',
      ]),
    );

    assert.deepEqual(Object.fromEntries(diff.files), {
      'packages/lib/src/a.ts': [
        { start: 3, end: 5 },
        { start: 23, end: 23 },
      ],
    });
  });

  it('strips the tab git puts after a path with a space, and throws on a quoted path', () => {
    const spaced = parseDiff('+++ b/packages/lib/src/a b.ts\t\n@@ -1 +1 @@\n-x\n+y\n');
    assert.deepEqual([...spaced.files.keys()], ['packages/lib/src/a b.ts']);
    assert.throws(
      () => parseDiff('+++ "b/packages/lib/src/a\\nb.ts"\n@@ -1 +1 @@\n-x\n+y\n'),
      /names a path this cannot read/u,
    );
  });

  it('reads an empty diff as no change', () => {
    assert.deepEqual(parseDiff(''), { files: new Map(), deletionOnlyHunks: new Map() });
  });
});

describe('mergeRanges', () => {
  it('joins overlapping and touching ranges and sorts the rest', () => {
    assert.deepEqual(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 1, end: 2 },
        { start: 3, end: 3 },
        { start: 11, end: 15 },
        { start: 20, end: 20 },
      ]),
      [
        { start: 1, end: 3 },
        { start: 10, end: 15 },
        { start: 20, end: 20 },
      ],
    );
  });

  it('keeps ranges a line apart as two: the line between them did not change', () => {
    assert.deepEqual(
      mergeRanges([
        { start: 1, end: 2 },
        { start: 4, end: 4 },
      ]),
      [
        { start: 1, end: 2 },
        { start: 4, end: 4 },
      ],
    );
  });
});

describe('mutatePatterns and mutated', () => {
  it('applies the patterns in order, the last match deciding, as Stryker does', () => {
    assert.equal(mutated('src/money/format.ts', SHARED_PATTERNS), true);
    assert.equal(mutated('src/money/format.test.ts', SHARED_PATTERNS), false);
    assert.equal(mutated('src/types/user.ts', SHARED_PATTERNS), false);
    assert.equal(mutated('vitest.config.ts', SHARED_PATTERNS), false);
    assert.equal(mutated('src/money/format.tsx', SHARED_PATTERNS), false);
    assert.equal(mutated('src/types/a.ts', [...SHARED_PATTERNS, 'src/types/a.ts']), true);
  });

  it('refuses a config with no usable patterns, or one that already carries a range', () => {
    assert.deepEqual(mutatePatterns(SHARED_PATTERNS), SHARED_PATTERNS);
    for (const mutate of [undefined, [], ['src/**/*.ts', 42], [''], 'src/**/*.ts']) {
      assert.match(
        (mutatePatterns(mutate) as { error: string }).error,
        /lists no mutate patterns/u,
        JSON.stringify(mutate),
      );
    }
    assert.match(
      (mutatePatterns(['src/a.ts:3-7']) as { error: string }).error,
      /src\/a\.ts:3-7 already carries a line range/u,
    );
  });
});

const SOURCES: Readonly<Record<string, string>> = {
  'src/a.ts': ['one();', '  for (let i = 0; i < n; i += 1) {', 'three();', 'four();', ''].join(
    '\n',
  ),
  'src/new.ts': 'a\nb\nc',
  // The same loop header twice: line 2 is the one the ledger argues for, line 7 a copy.
  'src/dup.ts': [
    'function first(value) {',
    '  for (let i = 0; i < n; i += 1) {',
    '    a();',
    '  }',
    '}',
    'function second(value) {',
    '  for (let i = 0; i < n; i += 1) {',
    '    b();',
    '  }',
    '}',
    '',
  ].join('\n'),
  // The same three lines twice: nothing but the position tells the two loops apart.
  'src/twins.ts': [
    'start();',
    'for (let i = 0; i < n; i += 1) {',
    'step();',
    'start();',
    'for (let i = 0; i < n; i += 1) {',
    'step();',
    '',
  ].join('\n'),
};

function plan(overrides: Partial<IPlanInput> = {}): IChangedPlan {
  return planChangedRun({
    targetDir: 'packages/lib',
    patterns: SHARED_PATTERNS,
    diff: { files: new Map(), deletionOnlyHunks: new Map() },
    untracked: [],
    ledger: [],
    source: (file) => SOURCES[file] ?? null,
    ...overrides,
  });
}

const LOOP_ENTRY: IAcceptedMutant = {
  file: 'src/a.ts',
  mutator: 'EqualityOperator',
  source: 'for (let i = 0; i < n; i += 1) {',
  before: 'one();',
  after: 'three();',
  replacement: 'i <= n',
  reason: 'equivalent: the extra pass reads past the end and changes nothing',
  reviewBy: '2099-01-01',
};

/** The entry for the FIRST loop of src/dup.ts (line 2), and only for it. */
const DUP_ENTRY: IAcceptedMutant = {
  ...LOOP_ENTRY,
  file: 'src/dup.ts',
  before: 'function first(value) {',
  after: 'a();',
};

describe('planChangedRun', () => {
  it('turns the changed lines of mutated files into path:first-last ranges, package-relative', () => {
    const planned = plan({
      diff: {
        files: new Map([
          [
            'packages/lib/src/a.ts',
            [
              { start: 3, end: 3 },
              { start: 10, end: 12 },
            ],
          ],
          ['packages/lib/src/b.ts', [{ start: 8, end: 9 }]],
        ]),
        // Only the hunks of mutated files count: a deleted test line is not a blind spot.
        deletionOnlyHunks: new Map([
          ['packages/lib/src/a.ts', 1],
          ['packages/lib/src/gone.ts', 1],
          ['packages/lib/src/a.test.ts', 5],
          ['apps/web/src/a.ts', 7],
        ]),
      },
    });

    assert.deepEqual(planned.mutate, ['src/a.ts:3-3', 'src/a.ts:10-12', 'src/b.ts:8-9']);
    assert.equal(planned.lines, 6);
    assert.equal(planned.changed.size, 2);
    assert.equal(planned.deletionOnlyHunks, 2);
  });

  it('leaves out what the patterns do not mutate and what is outside the package, and counts the first', () => {
    const planned = plan({
      diff: {
        files: new Map([
          ['packages/lib/src/a.test.ts', [{ start: 1, end: 9 }]],
          ['packages/lib/src/types/user.ts', [{ start: 1, end: 2 }]],
          ['packages/lib/package.json', [{ start: 3, end: 3 }]],
          ['packages/lib-kit/src/a.ts', [{ start: 1, end: 1 }]],
          ['apps/web/src/a.ts', [{ start: 1, end: 1 }]],
        ]),
        deletionOnlyHunks: new Map(),
      },
    });

    assert.deepEqual(planned.mutate, []);
    assert.equal(planned.lines, 0);
    assert.equal(planned.notMutated, 3);
  });

  it('takes every line of an untracked source file, and none of an untracked test', () => {
    const planned = plan({
      untracked: ['packages/lib/src/new.ts', 'packages/lib/src/new.test.ts'],
    });
    assert.deepEqual(planned.mutate, ['src/new.ts:1-3']);
    assert.equal(planned.lines, 3);
    assert.equal(planned.notMutated, 1);
  });

  it('adds the line of each ledger entry of a changed file, so the entry is judged', () => {
    const planned = plan({
      diff: {
        files: new Map([['packages/lib/src/a.ts', [{ start: 4, end: 4 }]]]),
        deletionOnlyHunks: new Map(),
      },
      ledger: [LOOP_ENTRY, { ...LOOP_ENTRY, file: 'src/elsewhere.ts' }],
    });

    // Line 2 is the ledger entry's line; it is mutated but is not a changed line.
    assert.deepEqual(planned.mutate, ['src/a.ts:2-2', 'src/a.ts:4-4']);
    assert.deepEqual(planned.changed.get('src/a.ts'), [{ start: 4, end: 4 }]);
    assert.equal(planned.lines, 1);
  });

  it("adds only the line whose neighbours are the entry's: a copy elsewhere is not the ledger's line", () => {
    const planned = planFor('src/dup.ts', [{ start: 10, end: 10 }], [DUP_ENTRY]);
    assert.deepEqual(planned.mutate, ['src/dup.ts:2-2', 'src/dup.ts:10-10']);
    assert.deepEqual(planned.planned.get('src/dup.ts'), [
      { start: 2, end: 2 },
      { start: 10, end: 10 },
    ]);
  });

  it('mutates everything by default and never what neverMutate names, whatever a target says', () => {
    const input = {
      targetDir: 'tools',
      patterns: ['**/*.ts', '!**/*.test.ts'],
      diff: {
        files: new Map([
          ['tools/gate/checks.ts', [{ start: 1, end: 5 }]],
          ['tools/judge/verdict.ts', [{ start: 1, end: 5 }]],
          ['tools/quality/junit.ts', [{ start: 2, end: 2 }]],
        ]),
        deletionOnlyHunks: new Map(),
      },
      untracked: ['tools/judge/new.ts'],
      ledger: [],
      source: () => 'x\ny\n',
    };
    assert.deepEqual(planChangedRun(input).mutate, [
      'gate/checks.ts:1-5',
      'judge/new.ts:1-2',
      'judge/verdict.ts:1-5',
      'quality/junit.ts:2-2',
    ]);

    const planned = planChangedRun({ ...input, neverMutate: ['tools/gate/', 'tools/judge/'] });
    assert.deepEqual(planned.mutate, ['quality/junit.ts:2-2']);
    assert.deepEqual([...planned.changed.keys()], ['quality/junit.ts']);
  });

  it('throws on a path Stryker would read as a glob, rather than mutate something else', () => {
    for (const name of [
      '[id]/a.ts',
      'a*.ts',
      '{a,b}.ts',
      '+(a).ts',
      '@(a|b).ts',
      '!(a).ts',
      '?(a).ts',
    ]) {
      assert.throws(
        () =>
          plan({
            patterns: ['src/**'],
            diff: {
              files: new Map([[`packages/lib/src/${name}`, [{ start: 1, end: 1 }]]]),
              deletionOnlyHunks: new Map(),
            },
          }),
        /would be read as a glob pattern/u,
        name,
      );
    }
    // Parentheses alone are a plain name (a route group), and are left alone.
    const grouped = plan({
      patterns: ['src/**'],
      diff: {
        files: new Map([['packages/lib/src/(app)/a.ts', [{ start: 1, end: 1 }]]]),
        deletionOnlyHunks: new Map(),
      },
    });
    assert.deepEqual(grouped.mutate, ['src/(app)/a.ts:1-1']);
  });
});

describe('nothingToCheck', () => {
  it('passes with a summary that says nothing was checked, and why', () => {
    assert.deepEqual(nothingToCheck(plan(), 'packages/lib', 'abc1234d'), {
      status: 'passed',
      reason:
        'checked nothing: no changed line of mutated source under packages/lib since abc1234d',
    });
    const withNotes = nothingToCheck(
      plan({
        diff: {
          files: new Map([['packages/lib/src/a.test.ts', [{ start: 1, end: 1 }]]]),
          deletionOnlyHunks: new Map([['packages/lib/src/a.ts', 1]]),
        },
      }),
      'packages/lib',
      'abc1234d',
    );
    assert.match(
      withNotes.reason,
      /\(1 changed path not mutated, 1 deletion-only hunk with no line to mutate\)$/u,
    );
  });
});

interface IFakeMutant {
  readonly status: string;
  readonly line: number;
  readonly endLine?: number;
  readonly mutatorName?: string;
  readonly replacement?: string;
  readonly static?: boolean;
  readonly statusReason?: string;
  readonly testsCompleted?: number;
  readonly file?: string;
}

function report(mutants: readonly IFakeMutant[]): string {
  const files: Record<string, { source: string; mutants: unknown[] }> = {};
  mutants.forEach((mutant, index) => {
    const file = mutant.file ?? 'src/a.ts';
    files[file] ??= { source: SOURCES[file] ?? '', mutants: [] };
    files[file].mutants.push({
      id: String(index),
      mutatorName: mutant.mutatorName ?? 'ConditionalExpression',
      replacement: mutant.replacement ?? 'false',
      location: {
        start: { line: mutant.line, column: 1 },
        end: { line: mutant.endLine ?? mutant.line, column: 9 },
      },
      status: mutant.status,
      testsCompleted: mutant.testsCompleted ?? 4,
      ...(mutant.static === true ? { static: true } : {}),
      ...(mutant.statusReason === undefined ? {} : { statusReason: mutant.statusReason }),
    });
  });
  return JSON.stringify({ files });
}

/** Lines 2 to 3 of src/a.ts changed. */
const CHANGED_PLAN = plan({
  diff: {
    files: new Map([['packages/lib/src/a.ts', [{ start: 2, end: 3 }]]]),
    deletionOnlyHunks: new Map(),
  },
});

/** What Stryker prints once it has read the files: how many it instruments, with how many mutants. */
function instrumented(files: number, mutants: number): string {
  return [
    `12:00:00 (1) INFO ProjectReader Found ${String(files)} of 338 file(s) to be mutated.`,
    `\u001b[32m12:00:00 (1) INFO Instrumenter\u001b[39m Instrumented ${String(files)} source file(s) with ${String(mutants)} mutant(s)`,
    '',
  ].join('\n');
}

function judge(
  mutants: readonly IFakeMutant[],
  ledger: readonly IAcceptedMutant[] = [],
  planned: IChangedPlan = CHANGED_PLAN,
  output: string | null = instrumented(planned.planned.size, mutants.length),
): ReturnType<typeof judgeChanged> {
  return judgeChanged(
    { exitCode: 0, report: report(mutants), durationMs: 4_200, output },
    { plan: planned, ledger, base: 'abc1234d' },
  );
}

/** A plan for src/dup.ts or src/twins.ts with `lines` changed and the ledger's lines added. */
function planFor(
  file: string,
  lines: readonly { start: number; end: number }[],
  ledger: readonly IAcceptedMutant[],
): IChangedPlan {
  return plan({
    diff: { files: new Map([[`packages/lib/${file}`, lines]]), deletionOnlyHunks: new Map() },
    ledger,
  });
}

describe('judgeChanged', () => {
  it('passes when every mutant in the changed lines is killed, and says what it looked at', () => {
    assert.deepEqual(
      judge([
        { status: 'Killed', line: 2 },
        { status: 'Killed', line: 3 },
      ]),
      {
        status: 'passed',
        reason: '2 mutants in 2 changed lines of 1 file since abc1234d, 2 killed, runtime 4s',
      },
    );
  });

  it('fails on a survivor in a changed line and names it', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'Survived', line: 3, mutatorName: 'BooleanLiteral', replacement: 'true' },
    ]);

    assert.equal(verdict.status, 'failed');
    assert.equal(
      verdict.reason,
      '1 mutant in a changed line is not killed (1 survived, 0 no coverage); ' +
        '2 mutants in 2 changed lines of 1 file since abc1234d, 1 killed, runtime 4s',
    );
    assert.deepEqual(verdict.details, ['src/a.ts:3 BooleanLiteral -> true: survived']);
  });

  it('fails on a changed line no test runs at all', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'NoCoverage', line: 3, mutatorName: 'StringLiteral', replacement: '""' },
    ]);

    assert.equal(verdict.status, 'failed');
    assert.match(
      verdict.reason,
      /^1 mutant in a changed line is not killed \(0 survived, 1 no coverage\)/u,
    );
    assert.deepEqual(verdict.details, ['src/a.ts:3 StringLiteral -> "": no test runs this line']);
  });

  it('passes a timed-out mutant in a changed line as detected, and names it in the output', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      {
        status: 'Timeout',
        line: 2,
        mutatorName: 'AssignmentOperator',
        replacement: 'i -= 1',
        statusReason: 'Hit limit reached (701/700)',
      },
    ]);

    assert.equal(verdict.status, 'passed');
    assert.match(verdict.reason, /, 1 killed, 1 timed out \(counted as detected\), runtime 4s$/u);
    assert.deepEqual(verdict.details, [
      'src/a.ts:2 AssignmentOperator -> i -= 1: timed out, counted as detected (Hit limit reached (701/700))',
    ]);
  });

  it('passes a line whose only mutant makes a loop endless: the hit limit is not a time limit', () => {
    const verdict = judge([
      { status: 'Timeout', line: 2, statusReason: 'Hit limit reached (701/700)' },
    ]);
    assert.equal(verdict.status, 'passed', verdict.reason);
  });

  it('is blocked, not passed, by a mutant in a changed line that ran out of time', () => {
    for (const statusReason of [
      undefined,
      'Test run timed out',
      'something Stryker says tomorrow',
    ]) {
      const verdict = judge([
        { status: 'Killed', line: 2 },
        { status: 'Killed', line: 3 },
        {
          status: 'Timeout',
          line: 3,
          mutatorName: 'EqualityOperator',
          replacement: 'a >= b',
          ...(statusReason === undefined ? {} : { statusReason }),
        },
      ]);

      assert.equal(verdict.status, 'blocked', String(statusReason));
      assert.match(
        verdict.reason,
        /^1 mutant in a changed line ran out of time, which is what a survivor looks like on a loaded machine: rerun on a quiet machine; /u,
      );
      assert.deepEqual(verdict.details, [
        `src/a.ts:3 EqualityOperator -> a >= b: ran out of time, not judged (${statusReason ?? 'time limit'})`,
      ]);
    }
  });

  it('is blocked by a mutant in a changed line that ended in a runtime error: that is not a test result', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      {
        status: 'RuntimeError',
        line: 3,
        mutatorName: 'StringLiteral',
        replacement: '""',
        statusReason: 'Error: worker exited unexpectedly',
      },
    ]);

    assert.equal(verdict.status, 'blocked');
    assert.match(
      verdict.reason,
      /^1 mutant in a changed line ended in a runtime error, which is not a test result \(one that stays after a rerun means the mutant breaks the test run itself\): rerun on a quiet machine; /u,
    );
    assert.match(verdict.reason, /, 1 killed, 1 runtime error, runtime 4s$/u);
    assert.deepEqual(verdict.details, [
      'src/a.ts:3 StringLiteral -> "": runtime error, not judged (Error: worker exited unexpectedly)',
    ]);
  });

  it('names both kinds when one mutant ran out of time and another broke the run', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'Timeout', line: 2 },
      { status: 'RuntimeError', line: 3 },
    ]);
    assert.equal(verdict.status, 'blocked');
    assert.match(
      verdict.reason,
      /^1 mutant in a changed line ran out of time, which is what a survivor looks like on a loaded machine and 1 mutant in a changed line ended in a runtime error, /u,
    );
    assert.equal(verdict.details?.length, 2);
  });

  it('passes a mutant the checker refused to compile, and counts it: that is the same on every machine', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'CompileError', line: 3, statusReason: 'TS2322' },
    ]);
    assert.equal(verdict.status, 'passed', verdict.reason);
    assert.match(verdict.reason, /, 1 killed, 1 compile error, runtime 4s$/u);
  });

  it("is blocked, not stale, when the ledger entry's mutant ended in a runtime error", () => {
    const planned = planFor('src/dup.ts', [{ start: 8, end: 8 }], [DUP_ENTRY]);
    const verdict = judge(
      [
        { status: 'Killed', line: 8, file: 'src/dup.ts' },
        {
          status: 'RuntimeError',
          line: 2,
          file: 'src/dup.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'i <= n',
        },
      ],
      [DUP_ENTRY],
      planned,
    );
    assert.equal(verdict.status, 'blocked', verdict.reason);
    assert.match(verdict.reason, /^1 mutant on a ledger entry's line ended in a runtime error/u);
    assert.doesNotMatch(verdict.reason, /stale/u);
  });

  it('fails, not blocks, when a survivor sits next to the mutant that ran out of time', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'Survived', line: 2, replacement: 'true' },
      { status: 'Timeout', line: 3 },
    ]);

    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.details?.length, 2);
    assert.match(verdict.details?.[1] ?? '', /ran out of time, not judged/u);
  });

  it('is blocked when a ledger entry cannot be judged because its mutant ran out of time', () => {
    const planned = planFor('src/dup.ts', [{ start: 8, end: 8 }], [DUP_ENTRY]);
    const verdict = judge(
      [
        { status: 'Killed', line: 8, file: 'src/dup.ts' },
        {
          status: 'Timeout',
          line: 2,
          file: 'src/dup.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'i <= n',
        },
      ],
      [DUP_ENTRY],
      planned,
    );
    assert.equal(verdict.status, 'blocked', verdict.reason);
    assert.doesNotMatch(verdict.reason, /stale/u);
  });

  it('judges only mutants in a changed line: a survivor on a ledger line next to it is not this change', () => {
    // Line 2 of src/dup.ts is mutated for the ledger's sake; only line 8 changed.
    const planned = planFor('src/dup.ts', [{ start: 8, end: 8 }], [DUP_ENTRY]);
    const verdict = judge(
      [
        { status: 'Killed', line: 8, file: 'src/dup.ts' },
        {
          status: 'Survived',
          line: 2,
          file: 'src/dup.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'i <= n',
        },
        { status: 'Survived', line: 2, file: 'src/dup.ts', replacement: 'true' },
      ],
      [DUP_ENTRY],
      planned,
    );
    assert.equal(verdict.status, 'passed', verdict.reason);
    assert.match(verdict.reason, /^1 mutant in 1 changed line of 1 file/u);
  });

  it('counts a mutant that only overlaps the changed lines as in them', () => {
    // Lines 2 and 3 are one planned range (the ledger's line, then the changed one).
    const planned = planFor('src/dup.ts', [{ start: 3, end: 3 }], [DUP_ENTRY]);
    const verdict = judge(
      [
        { status: 'Killed', line: 3, file: 'src/dup.ts' },
        { status: 'Survived', line: 2, endLine: 3, file: 'src/dup.ts' },
        {
          status: 'Survived',
          line: 2,
          file: 'src/dup.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'i <= n',
        },
      ],
      [DUP_ENTRY],
      planned,
    );
    assert.equal(verdict.status, 'failed');
    assert.deepEqual(verdict.details, ['src/dup.ts:2 ConditionalExpression -> false: survived']);
  });

  it('counts static mutants as ignored and says how many', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'Ignored', line: 3, static: true, statusReason: 'Static mutant' },
    ]);
    assert.equal(verdict.status, 'passed');
    assert.match(verdict.reason, /, 1 killed, 1 static ignored, runtime 4s$/u);
  });

  it('fails on a mutant that was switched off, anywhere in the report', () => {
    // Outside the changed lines: line 2 of src/dup.ts is mutated only because the ledger names it.
    const planned = planFor('src/dup.ts', [{ start: 8, end: 8 }], [DUP_ENTRY]);
    const verdict = judge(
      [
        { status: 'Killed', line: 8, file: 'src/dup.ts' },
        {
          status: 'Survived',
          line: 2,
          file: 'src/dup.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'i <= n',
        },
        { status: 'Ignored', line: 2, file: 'src/dup.ts', statusReason: 'Ignored using a comment' },
      ],
      [DUP_ENTRY],
      planned,
    );
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^1 mutant switched off instead of tested/u);
    assert.deepEqual(verdict.details, [
      'src/dup.ts:2 ConditionalExpression -> false: ignored (Ignored using a comment)',
    ]);
  });

  it('fails on a mutant that was switched off', () => {
    const verdict = judge([
      { status: 'Killed', line: 2 },
      { status: 'Ignored', line: 3, statusReason: 'Ignored using a comment' },
    ]);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^1 mutant switched off instead of tested/u);
    assert.deepEqual(verdict.details, [
      'src/a.ts:3 ConditionalExpression -> false: ignored (Ignored using a comment)',
    ]);
  });

  it('passes a survivor the ledger names exactly, and counts it', () => {
    const survivor = {
      status: 'Survived',
      line: 2,
      mutatorName: 'EqualityOperator',
      replacement: 'i <= n',
    };
    const verdict = judge([{ status: 'Killed', line: 2 }, survivor], [LOOP_ENTRY]);
    assert.equal(verdict.status, 'passed', verdict.reason);
    assert.match(verdict.reason, /, 1 killed, 1 accepted in mutation-ledger\.json, runtime 4s$/u);

    for (const other of [
      { ...LOOP_ENTRY, replacement: 'i >= n' },
      { ...LOOP_ENTRY, mutator: 'ConditionalExpression' },
      { ...LOOP_ENTRY, source: 'for (let i = 0; i < m; i += 1) {' },
      { ...LOOP_ENTRY, before: 'zero();' },
      { ...LOOP_ENTRY, after: 'four();' },
      { ...LOOP_ENTRY, file: 'src/b.ts' },
    ]) {
      const refused = judge([{ status: 'Killed', line: 2 }, survivor], [other]);
      assert.equal(refused.status, 'failed', JSON.stringify(other));
    }
  });

  it('fails a ledger entry of a changed file that no mutant matches, or whose mutant is killed', () => {
    const unmatched = judge([{ status: 'Killed', line: 2 }], [LOOP_ENTRY]);
    assert.equal(unmatched.status, 'failed');
    assert.match(unmatched.reason, /^1 stale ledger entry; /u);
    assert.match(
      unmatched.details?.[0] ?? '',
      /matches no mutant any more: update its `source`, `before` and `after` to where the mutant is now, or delete the entry$/u,
    );

    const killed = judge(
      [{ status: 'Killed', line: 2, mutatorName: 'EqualityOperator', replacement: 'i <= n' }],
      [LOOP_ENTRY],
    );
    assert.equal(killed.status, 'failed');
    assert.match(killed.details?.[0] ?? '', /no longer survives \(killed\): delete the entry$/u);
  });

  it('does not let an entry accept a copy of its line elsewhere in the file', () => {
    // The reviewer's probe: a second function with the same loop header (line 7) is added.
    const planned = planFor('src/dup.ts', [{ start: 6, end: 10 }], [DUP_ENTRY]);
    const survivor = {
      status: 'Survived',
      file: 'src/dup.ts',
      mutatorName: 'EqualityOperator',
      replacement: 'i <= n',
    };
    const verdict = judge(
      [
        { ...survivor, line: 2 },
        { ...survivor, line: 7 },
        { status: 'Killed', line: 8, file: 'src/dup.ts' },
      ],
      [DUP_ENTRY],
      planned,
    );

    assert.equal(verdict.status, 'failed', verdict.reason);
    assert.deepEqual(verdict.details, ['src/dup.ts:7 EqualityOperator -> i <= n: survived']);
    assert.doesNotMatch(verdict.reason, /accepted/u);
  });

  it('fails an entry that names more than one mutant, and prints each of them', () => {
    const entry = { ...LOOP_ENTRY, file: 'src/twins.ts', before: 'start();', after: 'step();' };
    const planned = planFor('src/twins.ts', [{ start: 6, end: 6 }], [entry]);
    assert.deepEqual(planned.mutate, ['src/twins.ts:2-2', 'src/twins.ts:5-6']);
    const survivor = {
      status: 'Survived',
      file: 'src/twins.ts',
      mutatorName: 'EqualityOperator',
      replacement: 'i <= n',
    };
    const verdict = judge(
      [
        { ...survivor, line: 2 },
        { ...survivor, line: 5 },
        { status: 'Killed', line: 6, file: 'src/twins.ts' },
      ],
      [entry],
      planned,
    );

    assert.equal(verdict.status, 'failed', verdict.reason);
    assert.match(verdict.reason, /^1 ledger entry that names more than one mutant; /u);
    assert.deepEqual(verdict.details, [
      'mutation-ledger.json: src/twins.ts EqualityOperator -> i <= n on `for (let i = 0; i < n; i += 1) {` ' +
        'names 2 mutants (src/twins.ts:2, src/twins.ts:5): an entry accepts exactly one, so the lines around them have to differ',
    ]);
  });

  it('accepts neither mutant of an entry that names two, even the one in a changed line', () => {
    const entry = { ...LOOP_ENTRY, file: 'src/twins.ts', before: 'start();', after: 'step();' };
    const planned = planFor('src/twins.ts', [{ start: 5, end: 5 }], [entry]);
    const survivor = {
      status: 'Survived',
      file: 'src/twins.ts',
      mutatorName: 'EqualityOperator',
      replacement: 'i <= n',
    };
    const verdict = judge(
      [
        { ...survivor, line: 2 },
        { ...survivor, line: 5 },
      ],
      [entry],
      planned,
    );

    assert.equal(verdict.status, 'failed');
    assert.match(
      verdict.reason,
      /^1 mutant in a changed line is not killed \(1 survived, 0 no coverage\) and 1 ledger entry that names more than one mutant; /u,
    );
    assert.equal(verdict.details?.[0], 'src/twins.ts:5 EqualityOperator -> i <= n: survived');
    assert.doesNotMatch(verdict.reason, /accepted/u);
  });

  it('leaves a ledger entry alone when its file is not part of the change', () => {
    const verdict = judge(
      [{ status: 'Killed', line: 2 }],
      [{ ...LOOP_ENTRY, file: 'src/elsewhere.ts' }],
    );
    assert.equal(verdict.status, 'passed', verdict.reason);
  });

  it('passes changed lines that hold nothing to mutate, and says that is what it found', () => {
    assert.deepEqual(judge([]), {
      status: 'passed',
      reason:
        'nothing mutable in the 2 changed lines of 1 file since abc1234d ' +
        '(Stryker instrumented 1 file, 0 mutants), runtime 4s',
    });
  });

  /** What Stryker 10 prints, and exits 1 on, when no test file imports any mutated file. */
  const noTests = (files: number, mutants: number): string =>
    `${instrumented(files, mutants)}WARN VitestTestRunner Vitest failed to find test files related to mutated files.\n` +
    'INFO DryRunExecutor No tests were found\n' +
    'ERROR Stryker No tests were executed. Stryker will exit prematurely. Please check your configuration.\n';
  const aborted = (output: string): ReturnType<typeof judgeChanged> =>
    judgeChanged(
      { exitCode: 1, report: null, durationMs: 6_000, output },
      { plan: CHANGED_PLAN, ledger: [], base: 'abc1234d' },
    );

  it('passes a changed file no test imports when its changed lines hold nothing to mutate', () => {
    // Stryker writes no report here and exits 1: without this, a comment in an untested file is a false red.
    assert.deepEqual(aborted(noTests(1, 0)), {
      status: 'passed',
      reason:
        'nothing mutable in the 2 changed lines of 1 file since abc1234d ' +
        '(Stryker instrumented 1 file, 0 mutants, and found no test that imports it), runtime 6s',
    });
  });

  it('fails a changed file no test imports when its changed lines do hold mutants', () => {
    const verdict = aborted(noTests(1, 5));
    assert.equal(verdict.status, 'failed');
    assert.equal(
      verdict.reason,
      'no test imports the changed file(s) (src/a.ts): 5 mutants in 2 changed lines of 1 file since abc1234d and no test runs any of them, runtime 6s',
    );
  });

  it('does not read a crash as "no test imports it": the exit code, the report and both lines have to agree', () => {
    assert.match(aborted(noTests(0, 0)).reason, /^Stryker exited 1 after 6s without writing/u);
    assert.match(aborted(instrumented(1, 0)).reason, /^Stryker exited 1 after 6s without writing/u);
    assert.match(aborted('No tests were executed.').reason, /^Stryker exited 1 after 6s without/u);
    const withReport = judgeChanged(
      { exitCode: 1, report: report([]), durationMs: 6_000, output: noTests(1, 0) },
      { plan: CHANGED_PLAN, ledger: [], base: 'abc1234d' },
    );
    assert.equal(withReport.status, 'failed');
    const exitedClean = judgeChanged(
      { exitCode: 0, report: null, durationMs: 6_000, output: noTests(1, 0) },
      { plan: CHANGED_PLAN, ledger: [], base: 'abc1234d' },
    );
    assert.match(exitedClean.reason, /^Stryker exited 0 but wrote no JSON report$/u);
  });

  it('fails a report that is not of this run: Stryker read fewer files than the plan names', () => {
    const verdict = judge([], [], CHANGED_PLAN, instrumented(0, 0));
    assert.equal(verdict.status, 'failed');
    assert.equal(
      verdict.reason,
      'Stryker instrumented 0 of the 1 file(s) this run named, so its report says nothing about the rest',
    );
  });

  it('fails a report whose mutant count is not the one Stryker instrumented', () => {
    const verdict = judge([{ status: 'Killed', line: 2 }], [], CHANGED_PLAN, instrumented(1, 7));
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^the report holds 1 mutant\(s\) and Stryker instrumented 7/u);
  });

  it('fails a report with a mutant outside every range the run named', () => {
    for (const stray of [
      { status: 'Killed', line: 4 },
      { status: 'Survived', line: 1, endLine: 2 },
      { status: 'Killed', line: 2, file: 'src/b.ts' },
    ]) {
      const mutants = [{ status: 'Killed', line: 2 }, stray];
      const verdict = judge(mutants, [], CHANGED_PLAN);
      assert.equal(verdict.status, 'failed', JSON.stringify(stray));
      assert.match(
        verdict.reason,
        /^1 mutant\(s\) in the report lie outside the lines this run named/u,
      );
      assert.equal(verdict.details?.length, 1);
    }
  });

  it('is blocked when Stryker did not say what it instrumented: an empty report proves nothing then', () => {
    for (const output of [null, '', 'INFO Stryker Done in 4 seconds.']) {
      const verdict = judge([], [], CHANGED_PLAN, output);
      assert.equal(verdict.status, 'blocked', String(output));
      assert.match(verdict.reason, /^Stryker did not print what it instrumented/u);
    }
  });

  it('is not a pass when the run is not a measurement', () => {
    const context = { plan: CHANGED_PLAN, ledger: [], base: 'abc1234d' };
    const killed = report([{ status: 'Killed', line: 2 }]);
    const output = instrumented(1, 1);
    const run = (exitCode: number, text: string | null): string =>
      judgeChanged({ exitCode, report: text, durationMs: 1, output }, context).status;
    assert.equal(run(1, killed), 'failed');
    assert.equal(run(130, null), 'blocked');
    assert.equal(run(0, null), 'failed');
    assert.equal(run(0, '{'), 'failed');
    assert.match(
      judge([
        { status: 'Killed', line: 2 },
        { status: 'Pending', line: 3 },
      ]).reason,
      /^1 of 2 mutants were never run$/u,
    );
    assert.match(
      judge([
        { status: 'Killed', line: 2 },
        { status: 'Survived', line: 3, testsCompleted: 0 },
      ]).reason,
      /^1 survived mutant ran no test/u,
    );
  });
});
