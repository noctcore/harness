import assert from 'node:assert/strict';

import { describe, it } from 'bun:test';

import {
  exitCodeFor,
  formatDuration,
  type IConfigFacts,
  judgeRun,
  mutationScore,
  preflight,
  readMutants,
  tallyReport,
  verdictLine,
} from './verdict.js';

/** A mutation-testing-report-schema report with one file per entry of `files`. */
function report(
  files: Record<string, readonly string[]>,
  testsCompleted: number | undefined = undefined,
): string {
  return JSON.stringify({
    schemaVersion: '2',
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(
      Object.entries(files).map(([path, statuses]) => [
        path,
        {
          language: 'typescript',
          source: '',
          mutants: statuses.map((status, index) => ({
            id: `${path}-${String(index)}`,
            mutatorName: 'ConditionalExpression',
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            status,
            ...(testsCompleted === undefined ? {} : { testsCompleted }),
          })),
        },
      ]),
    ),
  });
}

const MIXED = report({
  'src/a.ts': ['Killed', 'Killed', 'Killed', 'Survived', 'Timeout'],
  'src/b.ts': ['NoCoverage', 'Killed', 'CompileError', 'Ignored'],
});

describe('tallyReport', () => {
  it('counts every mutant of every file by status', () => {
    assert.deepEqual(tallyReport(MIXED), {
      killed: 4,
      survived: 1,
      noCoverage: 1,
      timeout: 1,
      compileError: 1,
      runtimeError: 0,
      ignored: 1,
      pending: 0,
      total: 9,
      survivedUntested: 0,
    });
  });

  it('refuses what is not a mutation report', () => {
    assert.throws(() => tallyReport('{}'), /no "files" object/u);
    assert.throws(() => tallyReport('[]'), /no "files" object/u);
    assert.throws(() => tallyReport('not json'), SyntaxError);
    assert.throws(() => tallyReport(JSON.stringify({ files: { 'a.ts': {} } })), /a\.ts has no/u);
  });

  it('refuses a status the schema does not have, rather than skip the mutant', () => {
    assert.throws(() => tallyReport(report({ 'src/a.ts': ['Killed', 'Zapped'] })), /"Zapped"/u);
  });
});

describe('mutationScore', () => {
  it('is detected over valid, as Stryker computes it', () => {
    // detected 4 killed + 1 timeout; valid 5 + 1 survived + 1 no coverage
    assert.equal(mutationScore(tallyReport(MIXED)), (5 / 7) * 100);
  });

  it('is null when no mutant could be judged', () => {
    assert.equal(mutationScore(tallyReport(report({ 'a.ts': ['CompileError'] }))), null);
  });
});

describe('formatDuration', () => {
  it('prints whole seconds, minutes and hours', () => {
    assert.equal(formatDuration(42_400), '42s');
    assert.equal(formatDuration(370_000), '6m10s');
    assert.equal(formatDuration(3_723_000), '1h02m03s');
  });
});

describe('judgeRun', () => {
  const run = { exitCode: 0, report: MIXED, durationMs: 370_000 };

  it('passes a completed run and puts the score and the counts in the reason', () => {
    assert.deepEqual(judgeRun(run, null), {
      status: 'passed',
      reason:
        'score 71.4% (57.1% with timeouts as undetected), 9 mutants, 4 killed, 1 survived, ' +
        '1 no coverage, 1 timeout, 1 errors, 1 ignored, runtime 6m10s',
    });
  });

  it('passes a low score when the target has no ratchet: record-only', () => {
    const low = report({ 'a.ts': ['Killed', 'Survived', 'Survived', 'NoCoverage'] });
    const verdict = judgeRun({ ...run, report: low }, null);
    assert.equal(verdict.status, 'passed');
    assert.match(
      verdict.reason,
      /^score 25\.0% \(25\.0% [^)]*\), 4 mutants, 1 killed, 2 survived/u,
    );
  });

  it('shows a surviving mutant as survived', () => {
    const verdict = judgeRun({ ...run, report: report({ 'a.ts': ['Killed', 'Survived'] }) }, null);
    assert.match(verdict.reason, /score 50\.0% \(50\.0% [^)]*\), 2 mutants, 1 killed, 1 survived/u);
  });

  it("prints the conservative score, timeouts counted as undetected, next to Stryker's", () => {
    const verdict = judgeRun(
      {
        ...run,
        report: report({ 'a.ts': ['Killed', 'Killed', 'Timeout', 'Survived'] }),
      },
      null,
    );
    assert.match(verdict.reason, /^score 75\.0% \(50\.0% with timeouts as undetected\), /u);
  });

  it('fails a report where every mutant is no coverage: the runner measured nothing', () => {
    const verdict = judgeRun(
      {
        ...run,
        report: report({ 'a.ts': ['NoCoverage', 'NoCoverage', 'NoCoverage'] }),
      },
      null,
    );
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /runner measured nothing/u);
    assert.match(verdict.reason, /3 mutants/u);
  });

  it('fails a run that killed nothing although mutants were covered: the runner filter bug', () => {
    for (const statuses of [
      ['Survived', 'NoCoverage'],
      ['Survived', 'Timeout'],
    ]) {
      const verdict = judgeRun({ ...run, report: report({ 'a.ts': statuses }) }, null);
      assert.equal(verdict.status, 'failed', statuses.join());
      assert.match(verdict.reason, /no mutant was killed/u);
      assert.match(verdict.reason, /test-name filter/u);
    }
  });

  it('fails a run with more timeouts than kills: the runs did not finish', () => {
    const stalled = judgeRun(
      {
        ...run,
        report: report({ 'a.ts': ['Killed', 'Timeout', 'Timeout', 'Survived'] }),
      },
      null,
    );
    assert.deepEqual(stalled, {
      status: 'failed',
      reason:
        '2 mutants timed out and only 1 were killed: the runs did not finish, ' +
        'so the score would be false',
    });
    const even = report({ 'a.ts': ['Killed', 'Timeout', 'Survived'] });
    assert.equal(judgeRun({ ...run, report: even }, null).status, 'passed');
  });

  it('fails survived mutants that ran no test: the runner never judged them', () => {
    const untested = judgeRun(
      {
        ...run,
        report: report({ 'a.ts': ['Killed', 'Survived', 'Survived', 'NoCoverage'] }, 0),
      },
      null,
    );
    assert.deepEqual(untested, {
      status: 'failed',
      reason:
        '2 of 2 survived mutants ran no test: the test runner did not judge them, ' +
        'so the score would be false',
    });
    // A survivor that ran its covering tests is a real result.
    assert.equal(
      judgeRun({ ...run, report: report({ 'a.ts': ['Killed', 'Survived'] }, 12) }, null).status,
      'passed',
    );
  });

  it('fails a report with no mutants: the globs matched no code', () => {
    const verdict = judgeRun({ ...run, report: report({}) }, null);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /holds no mutants/u);
  });

  it('fails a report whose mutants no test could judge', () => {
    const verdict = judgeRun(
      { ...run, report: report({ 'a.ts': ['CompileError', 'Ignored'] }) },
      null,
    );
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /none of the 2 mutants/u);
  });

  it('fails a report with mutants that never ran', () => {
    const verdict = judgeRun({ ...run, report: report({ 'a.ts': ['Killed', 'Pending'] }) }, null);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /1 of 2 mutants were never run/u);
  });

  it('fails a run that exited 0 without writing its report', () => {
    const verdict = judgeRun({ ...run, report: null }, null);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /wrote no JSON report/u);
  });

  it('fails a report it cannot read', () => {
    const verdict = judgeRun({ ...run, report: '{"files": ' }, null);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /cannot be read/u);
  });

  it('fails a Stryker that crashed, with or without a report', () => {
    const crashed = judgeRun({ ...run, exitCode: 1, report: null }, null);
    assert.deepEqual(crashed, {
      status: 'failed',
      reason: 'Stryker exited 1 after 6m10s without writing a report',
    });
    assert.equal(judgeRun({ ...run, exitCode: 1 }, null).status, 'failed');
  });

  it('is blocked when Stryker could not start or a signal ended it', () => {
    assert.equal(judgeRun({ ...run, exitCode: 127, report: null }, null).status, 'blocked');
    for (const exitCode of [129, 130, 143]) {
      assert.equal(judgeRun({ ...run, exitCode }, null).status, 'blocked', String(exitCode));
    }
  });
});

describe('judgeRun with a ratchet', () => {
  const run = { exitCode: 0, report: MIXED, durationMs: 370_000 };
  // MIXED: 4 killed and 1 timeout of 7 judged, so 57.14% with the timeout as undetected.
  const ratchet = { baseline: 57.14, accept: false, allowLowering: false };

  it('passes a score at its baseline, with the counts first and the baseline last', () => {
    assert.deepEqual(judgeRun(run, ratchet), {
      status: 'passed',
      reason:
        'score 71.4% (57.1% with timeouts as undetected), 9 mutants, 4 killed, 1 survived, ' +
        '1 no coverage, 1 timeout, 1 errors, 1 ignored, runtime 6m10s, baseline 57.14%',
    });
  });

  it('judges the score with timeouts as undetected, not the one a timeout can raise', () => {
    // Stryker's own score here is 71.4%, which would pass a 71% baseline.
    const verdict = judgeRun(run, { ...ratchet, baseline: 71 });
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^mutation score dropped: 57\.14% < baseline 71\.00%/u);
    assert.match(
      verdict.reason,
      /; score 71\.4% \(57\.1% with timeouts as undetected\), 9 mutants/u,
    );
  });

  it('fails a low score that the record-only verdict passes', () => {
    const low = report({ 'a.ts': ['Killed', 'Survived', 'Survived', 'NoCoverage'] });
    assert.equal(judgeRun({ ...run, report: low }, null).status, 'passed');
    const verdict = judgeRun({ ...run, report: low }, { ...ratchet, baseline: 70 });
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^mutation score dropped: 25\.00% < baseline 70\.00%/u);
  });

  it('fails a stale baseline and is blocked without one', () => {
    assert.match(judgeRun(run, { ...ratchet, baseline: 40 }).reason, /^baseline stale: 57\.14%/u);
    const missing = judgeRun(run, { ...ratchet, baseline: null });
    assert.equal(missing.status, 'blocked');
    assert.match(missing.reason, /^no mutation-baseline\.json; .*; score 71\.4%/u);
  });

  it('hands back the score to write only from an accepted complete run', () => {
    const accepted = judgeRun(run, { baseline: null, accept: true, allowLowering: false });
    assert.equal(accepted.status, 'passed');
    assert.equal(accepted.write, 57.14);
    assert.match(accepted.reason, /^accepted 57\.14% as the baseline; score 71\.4%/u);
    assert.equal(judgeRun(run, ratchet).write, undefined);
  });

  it('never reaches the baseline from a run that is not a measurement', () => {
    const notMeasurements = [
      { ...run, exitCode: 1 },
      { ...run, exitCode: 130 },
      { ...run, report: null },
      { ...run, report: report({ 'a.ts': ['Killed', 'Pending'] }) },
      { ...run, report: report({ 'a.ts': ['Killed', 'Timeout', 'Timeout'] }) },
      { ...run, report: report({ 'a.ts': ['Killed', 'Survived'] }, 0) },
      { ...run, report: report({ 'a.ts': ['NoCoverage'] }) },
    ];
    for (const observation of notMeasurements) {
      // A baseline of 0 would read any score as stale, and null as blocked:
      // neither word may appear, the run's own failure is the verdict.
      const judged = judgeRun(observation, { ...ratchet, baseline: null });
      assert.deepEqual(judged, judgeRun(observation, null));
      const accepting = judgeRun(observation, { baseline: 0, accept: true, allowLowering: true });
      assert.notEqual(accepting.status, 'passed');
      assert.equal(accepting.write, undefined);
      assert.equal(accepting.reason, `${judged.reason}; nothing accepted`);
    }
  });
});

describe('readMutants', () => {
  it('reads what a verdict needs of each mutant, the text of its line included', () => {
    const text = JSON.stringify({
      files: {
        'src/a.ts': {
          source: 'const a = 1;\r\n  const on = false;\r\n',
          mutants: [
            {
              id: '1',
              mutatorName: 'BooleanLiteral',
              replacement: 'true',
              location: { start: { line: 2, column: 14 }, end: { line: 2, column: 19 } },
              status: 'Survived',
              testsCompleted: 4,
            },
            {
              id: '2',
              mutatorName: 'ObjectLiteral',
              replacement: '{}',
              location: { start: { line: 1, column: 1 }, end: { line: 2, column: 3 } },
              status: 'Ignored',
              static: true,
              statusReason: 'Static mutant (and "ignoreStatic" was enabled)',
            },
            { id: '3', status: 'NoCoverage' },
          ],
        },
      },
    });
    assert.deepEqual(readMutants(text), [
      {
        file: 'src/a.ts',
        status: 'survived',
        mutatorName: 'BooleanLiteral',
        replacement: 'true',
        lines: { start: 2, end: 2 },
        sourceLine: 'const on = false;',
        lineBefore: 'const a = 1;',
        lineAfter: '',
        testsCompleted: 4,
        static: false,
        statusReason: null,
      },
      {
        file: 'src/a.ts',
        status: 'ignored',
        mutatorName: 'ObjectLiteral',
        replacement: '{}',
        lines: { start: 1, end: 2 },
        sourceLine: 'const a = 1;',
        lineBefore: '',
        lineAfter: 'const on = false;',
        testsCompleted: null,
        static: true,
        statusReason: 'Static mutant (and "ignoreStatic" was enabled)',
      },
      {
        file: 'src/a.ts',
        status: 'noCoverage',
        mutatorName: 'unknown mutator',
        replacement: null,
        lines: null,
        sourceLine: null,
        lineBefore: null,
        lineAfter: null,
        testsCompleted: null,
        static: false,
        statusReason: null,
      },
    ]);
  });

  it('refuses what tallyReport refuses: the two read the same report or neither does', () => {
    assert.throws(() => readMutants('{}'), /no "files" object/u);
    assert.throws(() => readMutants(report({ 'src/a.ts': ['Zapped'] })), /"Zapped"/u);
  });
});

describe('preflight', () => {
  const config: IConfigFacts = {
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    reporters: ['clear-text', 'json'],
    jsonReportFile: '../../.noctcore/mutation/shared/mutation.json',
    mutate: ['src/**/*.ts'],
  };
  const everything = (): boolean => true;

  it('lets a config that names its runner plugin and a JSON report run', () => {
    assert.equal(preflight(config, everything), null);
  });

  it('fails a config that does not name the plugin of its test runner', () => {
    for (const plugins of [undefined, [], ['@stryker-mutator/jest-runner'], [42]]) {
      const verdict = preflight({ ...config, plugins }, everything);
      assert.equal(verdict?.status, 'failed', JSON.stringify(plugins));
      assert.match(verdict?.reason ?? '', /@stryker-mutator\/vitest-runner/u);
    }
  });

  it('needs no runner plugin for the command runner built into core, but still a plugins list', () => {
    const command = { ...config, testRunner: 'command', plugins: [] };
    assert.equal(preflight(command, everything), null);
    assert.equal(preflight({ ...command, plugins: undefined }, everything)?.status, 'failed');
  });

  it('fails a config with no test runner, no json reporter or no report file', () => {
    assert.equal(preflight({ ...config, testRunner: undefined }, everything)?.status, 'failed');
    assert.equal(preflight({ ...config, reporters: ['html'] }, everything)?.status, 'failed');
    assert.equal(preflight({ ...config, jsonReportFile: undefined }, everything)?.status, 'failed');
  });

  it('is blocked when Stryker or a plugin it names is not installed', () => {
    const noRunner = preflight(config, (name) => name !== '@stryker-mutator/vitest-runner');
    assert.deepEqual(noRunner, {
      status: 'blocked',
      reason:
        'not installed: @stryker-mutator/vitest-runner (install the dependencies of the target package)',
    });
    const noCore = preflight(config, (name) => name !== '@stryker-mutator/core');
    assert.equal(noCore?.status, 'blocked');
    assert.match(noCore?.reason ?? '', /@stryker-mutator\/core/u);
  });
});

describe('verdictLine and exitCodeFor', () => {
  it('prints the line verify reads, on one line', () => {
    assert.equal(
      verdictLine('mutation-lib', { status: 'failed', reason: 'a\n  b' }),
      'mutation-lib: failed (a b)',
    );
  });

  it('exits 0, 1 or 2', () => {
    assert.deepEqual((['passed', 'failed', 'blocked'] as const).map(exitCodeFor), [0, 1, 2]);
  });
});
