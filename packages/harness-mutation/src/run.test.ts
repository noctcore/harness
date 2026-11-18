import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { describe, it } from 'bun:test';

import {
  checkIdOf,
  configFacts,
  type IGitResult,
  type IMutationDeps,
  type IMutationRequest,
  type IMutationTarget,
  reportFileRefusal,
  requestRefusal,
  reusesResults,
  runMutation,
} from './run.js';

/*
 * runMutation with every side effect faked: what it deletes, what it starts
 * and what it writes are recorded, so a test can say "nothing was deleted and
 * Stryker never started" about a run that must be refused.
 */

const ROOT = resolve('/repo');
const SHARED = join(ROOT, 'packages', 'lib');
const STATE = join(ROOT, '.noctcore', 'mutation', 'shared');
const REPORT = join(STATE, 'mutation.json');
const CHANGED_REPORT = join(STATE, 'changed', 'mutation.json');
const DERIVED_CONFIG = join(STATE, 'changed', 'stryker.config.json');
const BASELINE = join(SHARED, 'mutation-baseline.json');
const LEDGER = join(SHARED, 'mutation-ledger.json');
/** A target held to a baseline, with a changed-line run. */
const LIB: IMutationTarget = {
  dir: 'packages/lib',
  checkId: 'mutation-lib',
  ratchet: true,
  changedCheckId: 'mutation-changed',
};
/** A record-only target, with no changed-line run. */
const SERVER: IMutationTarget = {
  dir: 'packages/server',
  checkId: 'mutation-server',
  ratchet: false,
  changedCheckId: null,
};
const BASE_SHA = 'abc1234def5678900000000000000000000000ff';

interface IFakeMutant {
  readonly status: string;
  readonly line?: number;
  readonly mutatorName?: string;
  readonly replacement?: string;
  readonly static?: boolean;
  readonly statusReason?: string;
}

/** A report of one file, `src/a.ts`, whose source is `source`. */
function reportOf(mutants: readonly IFakeMutant[], source = ''): string {
  return JSON.stringify({
    files: {
      'src/a.ts': {
        source,
        mutants: mutants.map((mutant, index) => ({
          id: String(index),
          mutatorName: mutant.mutatorName ?? 'ConditionalExpression',
          replacement: mutant.replacement ?? 'false',
          location: {
            start: { line: mutant.line ?? 1, column: 1 },
            end: { line: mutant.line ?? 1, column: 2 },
          },
          status: mutant.status,
          testsCompleted: 3,
          ...(mutant.static === true ? { static: true } : {}),
          ...(mutant.statusReason === undefined ? {} : { statusReason: mutant.statusReason }),
        })),
      },
    },
  });
}

/** A report of `killed` killed mutants and `survived` survivors, each of which ran its tests. */
function report(killed: number, survived: number, pending = 0): string {
  return reportOf([
    ...Array.from({ length: killed }, () => ({ status: 'Killed' })),
    ...Array.from({ length: survived }, () => ({ status: 'Survived' })),
    ...Array.from({ length: pending }, () => ({ status: 'Pending' })),
  ]);
}

interface IWorld {
  readonly deps: IMutationDeps;
  readonly files: Map<string, string>;
  readonly removed: string[];
  readonly strykerRuns: string[][];
  readonly gitCalls: string[][];
  readonly log: string[];
}

interface IWorldOptions {
  /** `jsonReporter.fileName` of the fake config, relative to the package. */
  readonly reportFile?: string;
  /** More keys for the fake config's default export. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** What Stryker "writes" to the report file, or null when it writes none. */
  readonly strykerWrites?: string | null;
  readonly strykerExit?: number;
  /** What Stryker "prints" in a captured run; by default the count that fits the run it was given. */
  readonly strykerOutput?: string | null;
  readonly baseline?: string;
  /** Files of the working tree, by absolute path. */
  readonly files?: Readonly<Record<string, string>>;
  /** The diff `git diff -U0` prints. */
  readonly diff?: string;
  /** Repo-relative paths git lists as untracked, and as tracked. */
  readonly untracked?: readonly string[];
  readonly tracked?: readonly string[];
  /** The exit status of each git subcommand that should fail. */
  readonly gitFails?: readonly string[];
  /** git is not installed: every call comes back with no output at all. */
  readonly gitMissing?: boolean;
}

function world(options: IWorldOptions = {}): IWorld {
  const reportFile = options.reportFile ?? '../../.noctcore/mutation/shared/mutation.json';
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  if (options.baseline !== undefined) files.set(BASELINE, options.baseline);
  const removed: string[] = [];
  const strykerRuns: string[][] = [];
  const gitCalls: string[][] = [];
  const log: string[] = [];
  let clock = 0;
  const git = (args: readonly string[]): IGitResult => {
    gitCalls.push([...args]);
    if (options.gitMissing === true) return { status: 1, stdout: null };
    const command = args.find((arg) => ['merge-base', 'diff', 'ls-files'].includes(arg)) ?? '';
    if ((options.gitFails ?? []).includes(command)) return { status: 128, stdout: '' };
    if (command === 'merge-base') return { status: 0, stdout: `${BASE_SHA}\n` };
    if (command === 'diff') return { status: 0, stdout: options.diff ?? '' };
    const listed = args.includes('--others') ? options.untracked : options.tracked;
    return { status: 0, stdout: (listed ?? []).map((path) => `${path}\0`).join('') };
  };
  const deps: IMutationDeps = {
    root: ROOT,
    loadConfig: () =>
      Promise.resolve({
        default: {
          testRunner: 'vitest',
          plugins: ['@stryker-mutator/vitest-runner'],
          reporters: ['progress', 'json', 'html'],
          jsonReporter: { fileName: reportFile },
          htmlReporter: { fileName: '../../.noctcore/mutation/shared/index.html' },
          mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
          incremental: true,
          incrementalFile: '../../.noctcore/mutation/shared/incremental.json',
          ...options.config,
        },
      }),
    installed: () => () => true,
    readFile: (file) => files.get(file) ?? null,
    writeFile: (file, text) => {
      files.set(file, text);
    },
    removeFile: (file) => {
      removed.push(file);
      files.delete(file);
    },
    stryker: (packageDir, args, capture) => {
      strykerRuns.push([packageDir, ...args]);
      // A changed-line run names its own config file, which says where the report goes.
      const text = files.get(args[1] ?? '');
      const derived =
        text === undefined
          ? null
          : (JSON.parse(text) as { jsonReporter: { fileName: string }; mutate: string[] });
      const target =
        derived === null ? resolve(packageDir, reportFile) : derived.jsonReporter.fileName;
      const written = options.strykerWrites === undefined ? report(8, 2) : options.strykerWrites;
      if (written !== null) files.set(target, written);
      // The line a real Stryker prints: the files its mutate entries name, the mutants it made.
      const instrumentedFiles = new Set(
        (derived?.mutate ?? []).map((entry) => entry.replace(/:\d+-\d+$/u, '')),
      ).size;
      const mutantCount =
        written === null
          ? 0
          : Object.values(
              (JSON.parse(written) as { files: Record<string, { mutants: unknown[] }> }).files,
            ).reduce((sum, file) => sum + file.mutants.length, 0);
      const output =
        options.strykerOutput === undefined
          ? `INFO Instrumenter Instrumented ${String(instrumentedFiles)} source file(s) with ${String(mutantCount)} mutant(s)\n`
          : options.strykerOutput;
      return Promise.resolve({
        exitCode: options.strykerExit ?? 0,
        output: capture ? output : null,
      });
    },
    git,
    now: () => {
      clock += 30_000;
      return clock;
    },
    log: (line) => {
      log.push(line);
    },
  };
  return { deps, files, removed, strykerRuns, gitCalls, log };
}

function request(overrides: Partial<IMutationRequest> = {}): IMutationRequest {
  return {
    target: LIB,
    config: null,
    force: false,
    incremental: false,
    accept: false,
    allowLowering: false,
    changed: null,
    ...overrides,
  };
}

function apiTarget(): IMutationTarget {
  return SERVER;
}

const CHANGED = { changed: { baseRef: 'origin/main' } } as const;

/** `git diff -U0` of one modified file. */
function diffOf(path: string, hunks: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
    '',
  ].join('\n');
}

const A_TS = ['export function a(x: number): boolean {', '  return x > 1;', '}', ''].join('\n');
/** Line 2 of packages/lib/src/a.ts changed. */
const ONE_LINE = diffOf('packages/lib/src/a.ts', [
  '@@ -2 +2 @@',
  '-  return x > 0;',
  '+  return x > 1;',
]);

describe('runMutation: the report file is checked before it is deleted', () => {
  it('refuses a config whose JSON report is outside .noctcore/mutation/ and deletes nothing', async () => {
    for (const reportFile of [
      'package.json',
      '../../.noctcore/inventory/shared.junit.xml',
      '../../.noctcore/mutation',
      'mutation.json',
    ]) {
      const { deps, removed, strykerRuns } = world({ reportFile });
      const sentinel = resolve(SHARED, reportFile);

      const { checkId, verdict } = await runMutation(request(), deps);

      assert.deepEqual(removed, [], `${reportFile} was deleted`);
      assert.deepEqual(strykerRuns, [], `${reportFile}: Stryker was started`);
      assert.equal(checkId, 'mutation-lib');
      assert.equal(verdict.status, 'failed', reportFile);
      assert.match(verdict.reason, /is not under \.noctcore\/mutation\//u, reportFile);
      assert.ok(verdict.reason.includes(sentinel), `${reportFile}: the reason names the file`);
    }
  });

  it('refuses the same config in a changed-line run, whose report sits next to it', async () => {
    const { deps, removed, strykerRuns, files } = world({
      reportFile: 'reports/mutation.json',
      diff: ONE_LINE,
      files: { [join(SHARED, 'src', 'a.ts')]: A_TS },
    });

    const { checkId, verdict } = await runMutation(request(CHANGED), deps);

    assert.deepEqual(removed, []);
    assert.deepEqual(strykerRuns, []);
    // Nothing is written next to a report path that is refused, the derived config included.
    assert.deepEqual([...files.keys()], [join(SHARED, 'src', 'a.ts')]);
    assert.equal(checkId, 'mutation-changed');
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /is not under \.noctcore\/mutation\//u);
  });

  it('deletes exactly the report under .noctcore/mutation/, before Stryker starts', async () => {
    const { deps, removed, strykerRuns, files } = world({ baseline: '{ "score": 80 }' });
    files.set(REPORT, 'the report of an earlier run');

    const { verdict } = await runMutation(request(), deps);

    assert.deepEqual(removed, [REPORT]);
    assert.deepEqual(strykerRuns, [[SHARED, 'run', join(SHARED, 'stryker.config.mjs'), '--force']]);
    assert.equal(verdict.status, 'passed', verdict.reason);
    assert.match(verdict.reason, /^score 80\.0% .*, baseline 80\.00%$/u);
  });

  it('never judges the report of an earlier run: Stryker wrote none, so there is none', async () => {
    const { deps, files } = world({ strykerWrites: null, baseline: '{ "score": 80 }' });
    files.set(REPORT, report(10, 0));

    const { verdict } = await runMutation(request(), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /wrote no JSON report/u);
  });
});

describe('runMutation: the ratchet', () => {
  it('fails a run more than a point under the committed baseline', async () => {
    const { deps, files } = world({ baseline: '{ "score": 81.5 }' });

    const { verdict } = await runMutation(request(), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(
      verdict.reason,
      /^mutation score dropped: 80\.00% < baseline 81\.50% \(tolerance 1 point\); score 80\.0%/u,
    );
    assert.equal(files.get(BASELINE), '{ "score": 81.5 }', 'a failed run rewrote the baseline');
  });

  it('fails a run more than two points over it: the baseline is stale', async () => {
    const { deps } = world({ baseline: '{ "score": 60 }' });

    const { verdict } = await runMutation(request(), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^baseline stale: 80\.00% is more than 2 points over 60\.00%/u);
    assert.match(verdict.reason, /\(accept: true\)/u);
  });

  it('takes the baseline file, tolerance, margin and accept hint from the request', async () => {
    const custom = {
      baselineFile: 'score.json',
      dropTolerance: 0,
      staleMargin: 25,
      acceptHint: 'bun run mutation --accept',
    } as const;
    const inside = world({ files: { [join(SHARED, 'score.json')]: '{ "score": 60 }' } });
    const passed = await runMutation(request(custom), inside.deps);
    assert.equal(passed.verdict.status, 'passed', passed.verdict.reason);

    const dropped = world({ files: { [join(SHARED, 'score.json')]: '{ "score": 80.5 }' } });
    const failed = await runMutation(request(custom), dropped.deps);
    assert.match(failed.verdict.reason, /tolerance 0 points/u);

    const missing = await runMutation(request(custom), world().deps);
    assert.equal(missing.verdict.status, 'blocked');
    assert.match(missing.verdict.reason, /^no score\.json; .*bun run mutation --accept/u);

    const accepted = world();
    await runMutation(request({ ...custom, accept: true }), accepted.deps);
    assert.equal(accepted.files.get(join(SHARED, 'score.json')), '{\n  "score": 80\n}\n');
  });

  it('is blocked without a baseline, and with one it cannot read', async () => {
    const missing = await runMutation(request(), world().deps);
    assert.equal(missing.verdict.status, 'blocked');
    assert.match(missing.verdict.reason, /^no mutation-baseline\.json/u);

    const broken = await runMutation(request(), world({ baseline: '{ "score": "80" }' }).deps);
    assert.equal(broken.verdict.status, 'blocked');
    assert.match(broken.verdict.reason, /^unreadable mutation-baseline\.json: .*not a percentage/u);
  });

  it('accepts a complete run: writes the measured score and says so', async () => {
    const { deps, files, log } = world({ baseline: '{ "score": 60 }' });

    const { verdict } = await runMutation(request({ accept: true }), deps);

    assert.equal(verdict.status, 'passed');
    assert.match(verdict.reason, /^accepted 80\.00% as the baseline; score 80\.0%/u);
    assert.equal(files.get(BASELINE), '{\n  "score": 80\n}\n');
    assert.ok(log.includes(`wrote ${join('packages', 'lib', 'mutation-baseline.json')}`));
  });

  it('refuses to accept a lower score unless allowLowering says so as well', async () => {
    const refused = world({ baseline: '{ "score": 90 }' });
    const { verdict } = await runMutation(request({ accept: true }), refused.deps);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^accept refused: 80\.00% is under the baseline 90\.00%/u);
    assert.equal(refused.files.get(BASELINE), '{ "score": 90 }');

    const lowered = world({ baseline: '{ "score": 90 }' });
    const allowed = await runMutation(request({ accept: true, allowLowering: true }), lowered.deps);
    assert.equal(allowed.verdict.status, 'passed');
    assert.equal(lowered.files.get(BASELINE), '{\n  "score": 80\n}\n');
  });

  it('accepts nothing from a partial run: mutants never run, a crash, an interrupt', async () => {
    const partial: readonly IWorldOptions[] = [
      { strykerWrites: report(8, 2, 5) },
      { strykerWrites: report(8, 2), strykerExit: 1 },
      { strykerWrites: null, strykerExit: 130 },
      { strykerWrites: report(0, 4) },
    ];
    for (const options of partial) {
      const { deps, files } = world({ ...options, baseline: '{ "score": 60 }' });

      const { verdict } = await runMutation(request({ accept: true }), deps);

      assert.notEqual(verdict.status, 'passed', verdict.reason);
      assert.match(verdict.reason, /; nothing accepted$/u);
      assert.equal(verdict.write, undefined);
      assert.equal(files.get(BASELINE), '{ "score": 60 }', verdict.reason);
    }
  });

  it('never accepts the run of another config, and does not judge it against the baseline', async () => {
    const accepting = world({ baseline: '{ "score": 60 }' });
    const refused = await runMutation(
      request({ accept: true, config: 'stryker.one-file.mjs' }),
      accepting.deps,
    );
    assert.equal(refused.verdict.status, 'blocked');
    assert.match(refused.verdict.reason, /another config is a partial run/u);
    assert.deepEqual(accepting.strykerRuns, [], 'Stryker ran for a request that was refused');

    const byHand = await runMutation(
      request({ config: 'stryker.one-file.mjs' }),
      world({ baseline: '{ "score": 60 }' }).deps,
    );
    assert.equal(byHand.verdict.status, 'passed');
    assert.match(byHand.verdict.reason, /, not judged against the baseline \(another config\)$/u);
  });

  it('keeps the api record-only: no baseline is read, and accept is refused', async () => {
    const { deps, files, strykerRuns } = world({
      reportFile: '../../.noctcore/mutation/api/mutation.json',
      strykerWrites: report(1, 9),
    });

    const recorded = await runMutation(request({ target: apiTarget() }), deps);

    assert.equal(recorded.checkId, 'mutation-server');
    assert.equal(recorded.verdict.status, 'passed');
    assert.match(recorded.verdict.reason, /^score 10\.0% /u);
    assert.doesNotMatch(recorded.verdict.reason, /baseline/u);
    assert.ok(!strykerRuns[0]?.includes('--force'), 'the api run stopped reusing its results');

    // Forced, the api run judges every mutant again and is still held to no baseline.
    const forced = await runMutation(request({ target: apiTarget(), force: true }), deps);
    assert.ok(strykerRuns[1]?.includes('--force'));
    assert.equal(forced.verdict.status, 'passed', forced.verdict.reason);
    assert.doesNotMatch(forced.verdict.reason, /baseline/u);

    const accepting = await runMutation(request({ target: apiTarget(), accept: true }), deps);
    assert.equal(accepting.verdict.status, 'blocked');
    assert.match(accepting.verdict.reason, /mutation-server has no baseline/u);
    assert.ok(![...files.keys()].some((file) => file.endsWith('mutation-baseline.json')));
  });
});

describe('runMutation: a run that reused results is never judged', () => {
  it('judges every mutant again by default, and reuses only when incremental asks', () => {
    assert.equal(reusesResults(request()), false);
    assert.equal(reusesResults(request({ incremental: true })), true);
    assert.equal(reusesResults(request({ target: apiTarget() })), true);
    assert.equal(reusesResults(request({ target: apiTarget(), force: true })), false);
  });

  it('passes an incremental run whatever its score and says it was not judged', async () => {
    // A baseline of 95 fails the forced run of the same report as dropped.
    const forced = await runMutation(request(), world({ baseline: '{ "score": 95 }' }).deps);
    assert.equal(forced.verdict.status, 'failed');

    const { deps, strykerRuns, files } = world({ baseline: '{ "score": 95 }' });
    const { verdict } = await runMutation(request({ incremental: true }), deps);

    assert.deepEqual(strykerRuns[0]?.slice(1), ['run', join(SHARED, 'stryker.config.mjs')]);
    assert.equal(verdict.status, 'passed');
    assert.match(
      verdict.reason,
      /^score 80\.0% .*, not judged against the baseline \(incremental: results were reused\)$/u,
    );
    assert.equal(files.get(BASELINE), '{ "score": 95 }');
  });

  it('cannot reach the baseline, to judge or to write, with result reuse on: every flag combination', async () => {
    const flags = [false, true];
    for (const force of flags) {
      for (const incremental of flags) {
        for (const accept of flags) {
          for (const config of [null, 'other.mjs']) {
            const asked = { force, incremental, accept, config };
            const label = JSON.stringify(asked);
            // 20 is far under the report's 80: a judged run fails as stale.
            const { deps, strykerRuns, files } = world({ baseline: '{ "score": 20 }' });

            const { verdict } = await runMutation(request(asked), deps);

            const run = strykerRuns[0];
            const reused = run !== undefined && !run.includes('--force');
            const judged = /baseline stale|accepted .* as the baseline/u.test(verdict.reason);
            assert.ok(!(reused && judged), `${label}: judged a run that reused results`);
            if (reused || run === undefined) {
              assert.equal(files.get(BASELINE), '{ "score": 20 }', `${label}: wrote the baseline`);
              assert.equal(verdict.write, undefined, label);
            }
            if (run !== undefined && !reused && config === null) {
              assert.ok(judged, `${label}: a forced run of the own config was not judged`);
            }
          }
        }
      }
    }
  });

  it('refuses accept with incremental, and force with incremental, before Stryker starts', async () => {
    for (const asked of [
      { accept: true, incremental: true },
      { force: true, incremental: true },
    ]) {
      const { deps, strykerRuns } = world({ baseline: '{ "score": 20 }' });
      const { verdict } = await runMutation(request(asked), deps);
      assert.equal(verdict.status, 'blocked', JSON.stringify(asked));
      assert.deepEqual(strykerRuns, []);
    }
  });
});

describe('runMutation: the ledger and switched-off mutants in a whole-package run', () => {
  const ledger = (source: string, reviewBy = '2099-01-01'): string =>
    JSON.stringify({
      accepted: [
        {
          file: 'src/a.ts',
          mutator: 'EqualityOperator',
          source,
          before: 'export function a(x: number): boolean {',
          after: '}',
          replacement: 'x >= 1',
          reason: 'equivalent: x is an integer',
          reviewBy,
        },
      ],
    });
  const survivor = {
    status: 'Survived',
    line: 2,
    mutatorName: 'EqualityOperator',
    replacement: 'x >= 1',
  };
  const killed = Array.from({ length: 9 }, () => ({ status: 'Killed' }));

  it('fails an entry past its review date before Stryker starts', async () => {
    // The fake clock reads 1970-01-01.
    const { deps, strykerRuns } = world({
      baseline: '{ "score": 90 }',
      strykerWrites: reportOf([...killed, survivor], A_TS),
      files: { [LEDGER]: ledger('return x > 1;', '1969-12-31') },
    });
    const { verdict } = await runMutation(request(), deps);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.reason, '1 mutation-ledger.json entry is past their review date');
    assert.match(verdict.details?.[0] ?? '', /was due for review on 1969-12-31/u);
    assert.deepEqual(strykerRuns, []);
  });

  it('reads the ledger from the file the request names', async () => {
    const { deps } = world({
      baseline: '{ "score": 90 }',
      strykerWrites: reportOf([...killed, survivor], A_TS),
      files: { [join(SHARED, 'accepted.json')]: ledger('return x > 2;') },
    });
    const { verdict } = await runMutation(request({ ledgerFile: 'accepted.json' }), deps);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.details?.[0] ?? '', /^accepted\.json: .*matches no mutant any more/u);
  });

  it('passes while every ledger entry still names a surviving mutant', async () => {
    const { deps } = world({
      baseline: '{ "score": 90 }',
      strykerWrites: reportOf([...killed, survivor], A_TS),
      files: { [LEDGER]: ledger('return x > 1;') },
    });
    const { verdict } = await runMutation(request(), deps);
    assert.equal(verdict.status, 'passed', verdict.reason);
  });

  it('fails an entry whose line is gone, and one whose mutant is killed now', async () => {
    const gone = await runMutation(
      request(),
      world({
        baseline: '{ "score": 90 }',
        strykerWrites: reportOf([...killed, survivor], A_TS),
        files: { [LEDGER]: ledger('return x > 0;') },
      }).deps,
    );
    assert.equal(gone.verdict.status, 'failed');
    assert.match(gone.verdict.reason, /^1 stale ledger entry: /u);
    assert.match(
      gone.verdict.details?.[0] ?? '',
      /matches no mutant any more: update its `source`, `before` and `after`/u,
    );

    const nowKilled = await runMutation(
      request({ accept: true }),
      world({
        baseline: '{ "score": 90 }',
        strykerWrites: reportOf([...killed, { ...survivor, status: 'Killed' }], A_TS),
        files: { [LEDGER]: ledger('return x > 1;') },
      }).deps,
    );
    assert.equal(nowKilled.verdict.status, 'failed');
    assert.match(nowKilled.verdict.details?.[0] ?? '', /no longer survives \(killed\)/u);
    assert.match(nowKilled.verdict.reason, /; nothing accepted$/u);
  });

  it('fails an entry that names two mutants of the package, and leaves one alone whose mutant ran out of time', async () => {
    // The same three lines twice in one file: the entry cannot say which loop it means.
    const twice = ['export function a(x: number): boolean {', '  return x > 1;', '}'].join('\n');
    const two = await runMutation(
      request(),
      world({
        baseline: '{ "score": 80 }',
        strykerWrites: reportOf(
          [...killed, survivor, { ...survivor, line: 5 }],
          `${twice}\n${twice}\n`,
        ),
        files: { [LEDGER]: ledger('return x > 1;') },
      }).deps,
    );
    assert.equal(two.verdict.status, 'failed');
    assert.match(two.verdict.reason, /^1 ledger entry names more than one mutant/u);
    assert.match(two.verdict.details?.[0] ?? '', /names 2 mutants \(src\/a\.ts:2, src\/a\.ts:5\)/u);

    // On a loaded machine the accepted mutant can run out of time: that is not "killed now".
    const late = await runMutation(
      request(),
      world({
        baseline: '{ "score": 90 }',
        strykerWrites: reportOf([...killed, { ...survivor, status: 'Timeout' }], A_TS),
        files: { [LEDGER]: ledger('return x > 1;') },
      }).deps,
    );
    assert.equal(late.verdict.status, 'passed', late.verdict.reason);
    // Nor is a mutant whose run broke. It leaves the score (9 of 9 killed), so the baseline is 100.
    const broke = await runMutation(
      request(),
      world({
        baseline: '{ "score": 100 }',
        strykerWrites: reportOf([...killed, { ...survivor, status: 'RuntimeError' }], A_TS),
        files: { [LEDGER]: ledger('return x > 1;') },
      }).deps,
    );
    assert.equal(broke.verdict.status, 'passed', broke.verdict.reason);
    const endless = await runMutation(
      request(),
      world({
        baseline: '{ "score": 90 }',
        strykerWrites: reportOf(
          [...killed, { ...survivor, status: 'Timeout', statusReason: 'Hit limit reached (7/6)' }],
          A_TS,
        ),
        files: { [LEDGER]: ledger('return x > 1;') },
      }).deps,
    );
    assert.match(endless.verdict.reason, /^1 stale ledger entry/u);
  });

  it('is blocked by a ledger it cannot read, before Stryker starts', async () => {
    const { deps, strykerRuns } = world({ files: { [LEDGER]: '{ "accepted": [{}] }' } });
    const { verdict } = await runMutation(request(), deps);
    assert.equal(verdict.status, 'blocked');
    assert.match(verdict.reason, /^unreadable mutation-ledger\.json: accepted\[0\]/u);
    assert.deepEqual(strykerRuns, []);
  });

  it('fails a mutant that was switched off, which would have raised the score', async () => {
    const { deps, files } = world({
      baseline: '{ "score": 20 }',
      strykerWrites: reportOf([
        ...killed,
        { status: 'Ignored', static: true, statusReason: 'Static mutant' },
        { status: 'Ignored', line: 7, statusReason: 'Ignored using a comment' },
      ]),
    });

    const { verdict } = await runMutation(request({ accept: true }), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^1 mutant was switched off instead of tested/u);
    assert.deepEqual(verdict.details, [
      'src/a.ts:7 ConditionalExpression -> false: ignored (Ignored using a comment)',
    ]);
    assert.equal(files.get(BASELINE), '{ "score": 20 }');
  });
});

describe('runMutation: the changed-line run', () => {
  const tree = { [join(SHARED, 'src', 'a.ts')]: A_TS };
  const tracked = ['packages/lib/src/a.ts', 'packages/lib/src/a.test.ts'];

  it('diffs against the merge base of HEAD and origin/main, or of the ref --base names', async () => {
    const byDefault = world({ diff: ONE_LINE, files: tree, tracked });
    await runMutation(request(CHANGED), byDefault.deps);
    assert.deepEqual(byDefault.gitCalls[0]?.slice(-3), ['merge-base', 'HEAD', 'origin/main']);
    const diff = byDefault.gitCalls.find((call) => call.includes('diff')) ?? [];
    assert.ok(diff.includes('-U0'));
    assert.deepEqual(diff.slice(-3), [BASE_SHA, '--', 'packages/lib']);

    const named = world({ diff: ONE_LINE, files: tree, tracked });
    await runMutation(request({ changed: { baseRef: 'feat/x' } }), named.deps);
    assert.deepEqual(named.gitCalls[0]?.slice(-3), ['merge-base', 'HEAD', 'feat/x']);
  });

  it('prints every git and Stryker command before it runs', async () => {
    const events: string[] = [];
    const base = world({
      diff: ONE_LINE,
      files: tree,
      tracked,
      strykerWrites: reportOf([{ status: 'Killed', line: 2 }], A_TS),
    });
    const deps: IMutationDeps = {
      ...base.deps,
      git: (args) => {
        events.push(`ran git ${args.join(' ')}`);
        return base.deps.git(args);
      },
      stryker: (packageDir, args, capture) => {
        events.push(`ran stryker ${args.join(' ')}`);
        return base.deps.stryker(packageDir, args, capture);
      },
      log: (line) => {
        events.push(line);
      },
    };

    await runMutation(request(CHANGED), deps);

    const ran = events.flatMap((event, index) => (event.startsWith('ran ') ? [index] : []));
    assert.equal(ran.length, 5, events.join('\n'));
    for (const index of ran) {
      const command = (events[index] ?? '').slice('ran '.length);
      assert.ok((events[index - 1] ?? '').startsWith(`$ ${command}`), events.join('\n'));
    }
    assert.ok(events.includes(`$ stryker run ${DERIVED_CONFIG} (in ${join('packages', 'lib')})`));
  });

  it('never mutates what neverMutate names, and writes reports under the reportDir asked for', async () => {
    const skipped = world({ diff: ONE_LINE, files: tree, tracked });
    const nothing = await runMutation(
      request({ ...CHANGED, neverMutate: ['packages/lib/src/'] }),
      skipped.deps,
    );
    assert.equal(nothing.verdict.status, 'passed');
    assert.match(nothing.verdict.reason, /^checked nothing/u);
    assert.deepEqual(skipped.strykerRuns, []);

    const elsewhere = world({ diff: ONE_LINE, files: tree, tracked });
    const refused = await runMutation(
      request({ ...CHANGED, reportDir: 'reports' }),
      elsewhere.deps,
    );
    assert.equal(refused.verdict.status, 'failed');
    assert.match(refused.verdict.reason, /is not under reports\//u);
    assert.deepEqual(elsewhere.strykerRuns, []);
  });

  it('runs Stryker on the changed lines only, with no cache and its own report', async () => {
    const { deps, strykerRuns, files, removed } = world({
      diff: ONE_LINE,
      files: tree,
      tracked,
      strykerWrites: reportOf([{ status: 'Killed', line: 2 }], A_TS),
    });

    const { checkId, verdict } = await runMutation(request(CHANGED), deps);

    assert.equal(checkId, 'mutation-changed');
    assert.deepEqual(strykerRuns, [[SHARED, 'run', DERIVED_CONFIG]]);
    assert.deepEqual(removed, [CHANGED_REPORT]);
    assert.deepEqual(JSON.parse(files.get(DERIVED_CONFIG) ?? ''), {
      testRunner: 'vitest',
      plugins: ['@stryker-mutator/vitest-runner'],
      reporters: ['progress', 'json'],
      jsonReporter: { fileName: CHANGED_REPORT },
      mutate: ['src/a.ts:2-2'],
      incremental: false,
      logLevel: 'info',
    });
    assert.equal(verdict.status, 'passed', verdict.reason);
    assert.equal(
      verdict.reason,
      '1 mutant in 1 changed line of 1 file since abc1234d, 1 killed, runtime 30s',
    );
  });

  it('fails on a survivor in a changed line and prints file, line, mutator and replacement', async () => {
    const { deps } = world({
      diff: ONE_LINE,
      files: tree,
      tracked,
      strykerWrites: reportOf(
        [
          { status: 'Killed', line: 2 },
          { status: 'Survived', line: 2, mutatorName: 'EqualityOperator', replacement: 'x >= 1' },
        ],
        A_TS,
      ),
    });

    const { verdict } = await runMutation(request(CHANGED), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(
      verdict.reason,
      /^1 mutant in a changed line is not killed \(1 survived, 0 no coverage\); /u,
    );
    assert.deepEqual(verdict.details, ['src/a.ts:2 EqualityOperator -> x >= 1: survived']);
  });

  it('passes and says it checked nothing when no line of mutated source changed', async () => {
    const onlyATest = diffOf('packages/lib/src/a.test.ts', ['@@ -3 +3 @@', '-old', '+new']);
    for (const diff of ['', onlyATest]) {
      const { deps, strykerRuns, removed } = world({ diff, files: tree, tracked });

      const { verdict } = await runMutation(request(CHANGED), deps);

      assert.equal(verdict.status, 'passed');
      assert.match(
        verdict.reason,
        /^checked nothing: no changed line of mutated source under packages\/lib since abc1234d/u,
      );
      assert.deepEqual(strykerRuns, []);
      assert.deepEqual(removed, []);
    }
  });

  it('captures what Stryker prints in a changed-line run, and only there', async () => {
    const changed = world({
      diff: ONE_LINE,
      files: tree,
      tracked,
      strykerWrites: reportOf([{ status: 'Killed', line: 2 }], A_TS),
      strykerOutput: 'INFO Stryker Done in 3 seconds.\n',
    });
    const blocked = await runMutation(request(CHANGED), changed.deps);
    assert.equal(blocked.verdict.status, 'blocked');
    assert.match(blocked.verdict.reason, /^Stryker did not print what it instrumented/u);

    // The whole-package run streams its output and does not read it.
    const whole = world({ baseline: '{ "score": 80 }', strykerOutput: 'nothing useful' });
    assert.equal((await runMutation(request(), whole.deps)).verdict.status, 'passed');
  });

  it('fails a changed-line report Stryker wrote for fewer files than the run named', async () => {
    const { deps } = world({
      diff: ONE_LINE,
      files: tree,
      tracked,
      strykerWrites: reportOf([], A_TS),
      strykerOutput: 'INFO Instrumenter Instrumented 0 source file(s) with 0 mutant(s)\n',
    });
    const { verdict } = await runMutation(request(CHANGED), deps);
    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^Stryker instrumented 0 of the 1 file\(s\) this run named/u);
  });

  it('mutates every line of a file git does not track yet', async () => {
    const { deps, files } = world({
      files: {
        ...tree,
        [join(SHARED, 'src', 'new.ts')]: 'export const one = 1;\nexport const two = 2;\n',
      },
      tracked,
      untracked: ['packages/lib/src/new.ts', 'packages/lib/src/new.test.ts'],
      strykerWrites: reportOf([]),
    });

    await runMutation(request(CHANGED), deps);

    const derived = JSON.parse(files.get(DERIVED_CONFIG) ?? '{}') as { mutate?: unknown };
    assert.deepEqual(derived.mutate, ['src/new.ts:1-2']);
  });

  it('is blocked, never passed, when git cannot name the base or the changes', async () => {
    const noBase = await runMutation(
      request(CHANGED),
      world({ diff: ONE_LINE, files: tree, gitFails: ['merge-base'] }).deps,
    );
    assert.equal(noBase.verdict.status, 'blocked');
    assert.match(noBase.verdict.reason, /no merge base of HEAD and origin\/main.*baseRef/u);

    for (const failing of ['diff', 'ls-files']) {
      const { deps, strykerRuns } = world({ diff: ONE_LINE, files: tree, gitFails: [failing] });
      const { verdict } = await runMutation(request(CHANGED), deps);
      assert.equal(verdict.status, 'blocked', failing);
      assert.match(verdict.reason, /git could not list what changed/u);
      assert.deepEqual(strykerRuns, []);
    }
  });

  it('is blocked, not crashed, when git cannot be started at all: no status, no output', async () => {
    // What spawnSync hands back for a command that is not on PATH.
    const { deps, strykerRuns } = world({ diff: ONE_LINE, files: tree, gitMissing: true });

    const { verdict } = await runMutation(request(CHANGED), deps);

    assert.equal(verdict.status, 'blocked');
    assert.equal(verdict.reason, 'git could not be started: is it installed and on PATH?');
    assert.deepEqual(strykerRuns, []);
  });

  it('fails on a Stryker disable comment anywhere in the mutated files, changed or not', async () => {
    const { deps, strykerRuns } = world({
      diff: ONE_LINE,
      tracked: [...tracked, 'packages/lib/src/b.ts'],
      files: {
        ...tree,
        [join(SHARED, 'src', 'b.ts')]:
          'const b = 1;\n// Stryker disable next-line all: equivalent\nconst c = b > 0;\n',
        // A test file is not mutated, so a mention of the words there is not a switch.
        [join(SHARED, 'src', 'a.test.ts')]: '// Stryker disable all\n',
      },
    });

    const { verdict } = await runMutation(request(CHANGED), deps);

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /^1 Stryker disable comment\(s\) under packages\/lib/u);
    assert.match(verdict.reason, /mutation-ledger\.json/u);
    assert.deepEqual(verdict.details, ['packages/lib/src/b.ts:2: Stryker disable comment']);
    assert.deepEqual(strykerRuns, [], 'Stryker ran although the tree switches mutants off');
  });

  it('fails a config it cannot derive a run from: no mutate patterns, or not plain data', async () => {
    const noPatterns = await runMutation(
      request(CHANGED),
      world({ diff: ONE_LINE, files: tree, config: { mutate: [] } }).deps,
    );
    assert.equal(noPatterns.verdict.status, 'failed');
    assert.match(noPatterns.verdict.reason, /lists no mutate patterns/u);

    const notData = await runMutation(
      request(CHANGED),
      world({ diff: ONE_LINE, files: tree, config: { ignorers: [() => true] } }).deps,
    );
    assert.equal(notData.verdict.status, 'failed');
    assert.match(notData.verdict.reason, /stryker\.config\.mjs is not plain data/u);
  });

  it('refuses flags that would make it something else, and a target without one', async () => {
    for (const asked of [
      { accept: true },
      { force: true },
      { incremental: true },
      { config: 'x.mjs' },
    ]) {
      const { deps, strykerRuns, gitCalls } = world({ diff: ONE_LINE, files: tree });
      const { verdict } = await runMutation(request({ ...CHANGED, ...asked }), deps);
      assert.equal(verdict.status, 'blocked', JSON.stringify(asked));
      assert.match(verdict.reason, /^a changed-line run takes no /u);
      assert.deepEqual([strykerRuns, gitCalls], [[], []]);
    }
    const api = await runMutation(request({ ...CHANGED, target: apiTarget() }), world().deps);
    assert.equal(api.verdict.status, 'blocked');
    assert.match(api.verdict.reason, /mutation-server has no changed-line run/u);
  });
});

describe('requestRefusal', () => {
  it('blocks allowLowering without accept before anything runs', () => {
    const verdict = requestRefusal(request({ allowLowering: true }));
    assert.equal(verdict?.status, 'blocked');
    assert.match(verdict?.reason ?? '', /only means something with accept/u);
    assert.equal(requestRefusal(request({ accept: true, allowLowering: true })), null);
    assert.equal(requestRefusal(request()), null);
  });

  it('takes a request with only a target, every flag off', () => {
    assert.equal(requestRefusal({ target: LIB }), null);
    assert.equal(reusesResults({ target: LIB }), false);
    assert.equal(reusesResults({ target: SERVER }), true);
  });
});

describe('checkIdOf', () => {
  it("is the target's id, or its changed-line run's", () => {
    assert.equal(checkIdOf({ target: LIB }), 'mutation-lib');
    assert.equal(checkIdOf({ target: LIB, changed: {} }), 'mutation-changed');
    assert.equal(checkIdOf({ target: SERVER, changed: {} }), 'mutation-server');
  });
});

describe('configFacts', () => {
  it('reads the facts a run needs from the default export of a config module', () => {
    assert.deepEqual(
      configFacts({
        default: {
          testRunner: 'vitest',
          plugins: ['p'],
          reporters: ['json'],
          jsonReporter: { fileName: 'r.json' },
          mutate: ['src/**'],
        },
      }),
      {
        testRunner: 'vitest',
        plugins: ['p'],
        reporters: ['json'],
        jsonReportFile: 'r.json',
        mutate: ['src/**'],
      },
    );
  });

  it('yields empty facts for anything that is not a plain object', () => {
    for (const module of [null, 42, [], { default: [] }, { default: null }, {}]) {
      assert.deepEqual(configFacts(module), {
        testRunner: undefined,
        plugins: undefined,
        reporters: undefined,
        jsonReportFile: undefined,
        mutate: undefined,
      });
    }
  });
});

describe('reportFileRefusal', () => {
  it('accepts a file strictly inside the report directory, and nothing else', () => {
    assert.equal(reportFileRefusal(ROOT, join(ROOT, '.noctcore', 'mutation', 'a.json')), null);
    for (const file of [
      join(ROOT, '.noctcore', 'mutation'),
      join(ROOT, '.noctcore', 'other.json'),
      join(ROOT, 'package.json'),
    ]) {
      assert.equal(reportFileRefusal(ROOT, file)?.status, 'failed', file);
    }
  });

  it('takes another report directory', () => {
    assert.equal(reportFileRefusal(ROOT, join(ROOT, 'reports', 'm', 'a.json'), 'reports/m'), null);
    assert.match(
      reportFileRefusal(ROOT, join(ROOT, '.noctcore', 'mutation', 'a.json'), 'reports/m')?.reason ??
        '',
      /is not under reports\/m\//u,
    );
  });
});
