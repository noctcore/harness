import assert from 'node:assert/strict';

import { describe, it } from 'bun:test';

import {
  acceptScore,
  compareToBaseline,
  DROP_TOLERANCE,
  hundredths,
  type IRatchetOptions,
  judgeScore,
  parseBaseline,
  serializeBaseline,
  STALE_MARGIN,
} from './ratchet.js';

const BASELINE = 71.3;

function options(overrides: Partial<IRatchetOptions> = {}): IRatchetOptions {
  return { baseline: BASELINE, accept: false, allowLowering: false, ...overrides };
}

describe('mutation baseline file', () => {
  it('round-trips a score, written to two decimals', () => {
    assert.equal(serializeBaseline(71.3), '{\n  "score": 71.3\n}\n');
    assert.equal(serializeBaseline(71.28514056), '{\n  "score": 71.29\n}\n');
    assert.equal(parseBaseline(serializeBaseline(71.28514056)), 71.29);
  });

  it('refuses anything that is not exactly one score', () => {
    assert.throws(() => parseBaseline('[71.3]'), /not a JSON object/u);
    assert.throws(() => parseBaseline('{}'), /"score" is not a percentage/u);
    assert.throws(() => parseBaseline('{ "score": "71.3" }'), /"score" is not a percentage/u);
    assert.throws(() => parseBaseline('{ "score": 171.3 }'), /"score" is not a percentage/u);
    assert.throws(() => parseBaseline('{ "score": -1 }'), /"score" is not a percentage/u);
    assert.throws(
      () => parseBaseline('{ "score": 71.3, "tolerance": 50 }'),
      /unknown key\(s\): tolerance/u,
    );
    assert.throws(() => parseBaseline('not json'), SyntaxError);
  });
});

describe('compareToBaseline', () => {
  it('holds the tolerance and the stale margin at their defaults', () => {
    assert.equal(DROP_TOLERANCE, 1);
    assert.equal(STALE_MARGIN, 2);
  });

  it('reads a score inside the band as neither dropped nor stale', () => {
    for (const actual of [BASELINE, BASELINE - 1, BASELINE + 2, 70.3, 73.3]) {
      assert.equal(compareToBaseline(BASELINE, actual), null, String(actual));
    }
  });

  it('reads the first hundredth past the tolerance as dropped', () => {
    assert.equal(compareToBaseline(BASELINE, 70.29), 'dropped');
    assert.equal(compareToBaseline(BASELINE, 0), 'dropped');
  });

  it('reads the first hundredth past the margin as stale', () => {
    assert.equal(compareToBaseline(BASELINE, 73.31), 'stale');
    assert.equal(compareToBaseline(BASELINE, 100), 'stale');
  });

  it('decides on hundredths, so float noise at the edge never does', () => {
    // 71.3 - 1 is 70.29999999999999 in binary floating point.
    assert.equal(hundredths(71.3 - 1), 70.3);
    assert.equal(compareToBaseline(71.3, 71.3 - 1), null);
    assert.equal(compareToBaseline(0.3, 0.1 + 0.2 + 2), null);
  });
});

describe('acceptScore', () => {
  it('takes a first score, and a gain, as measured', () => {
    assert.deepEqual(acceptScore(null, 64.2, false), { next: 64.2, refused: false });
    assert.deepEqual(acceptScore(BASELINE, 75, false), { next: 75, refused: false });
    assert.deepEqual(acceptScore(BASELINE, BASELINE, false), { next: BASELINE, refused: false });
  });

  it('keeps the baseline on a dip inside the tolerance, so accepting cannot walk it down', () => {
    assert.deepEqual(acceptScore(BASELINE, 70.3, false), { next: BASELINE, refused: false });
    assert.deepEqual(acceptScore(BASELINE, 71.29, false), { next: BASELINE, refused: false });
  });

  it('refuses a drop past the tolerance', () => {
    assert.deepEqual(acceptScore(BASELINE, 70.29, false), { next: BASELINE, refused: true });
  });

  it('lowers only when told to, by any amount', () => {
    assert.deepEqual(acceptScore(BASELINE, 70.29, true), { next: 70.29, refused: false });
    assert.deepEqual(acceptScore(BASELINE, 71.29, true), { next: 71.29, refused: false });
  });
});

describe('judgeScore', () => {
  it('passes a score within the band and names the baseline', () => {
    assert.deepEqual(judgeScore(71.28514056, options()), {
      status: 'passed',
      reason: 'baseline 71.30%',
    });
  });

  it('fails a baseline set above the real score', () => {
    assert.deepEqual(judgeScore(71.3, options({ baseline: 75 })), {
      status: 'failed',
      reason: 'mutation score dropped: 71.30% < baseline 75.00% (tolerance 1 point)',
    });
  });

  it('fails a baseline set far below the real score as stale', () => {
    assert.deepEqual(judgeScore(71.3, options({ baseline: 40 })), {
      status: 'failed',
      reason:
        'baseline stale: 71.30% is more than 2 points over 40.00%; ' +
        'record the gain: run an accepted mutation run (accept: true)',
    });
  });

  it('takes the tolerance, margin, file name and accept hint as options', () => {
    const custom = (measured: number, baseline: number) =>
      judgeScore(
        measured,
        options({
          baseline,
          dropTolerance: 0.5,
          staleMargin: 0.5,
          baselineFile: 'score.json',
          acceptHint: 'bun run mutation --accept',
        }),
      );
    assert.equal(custom(71.3, 71.3).status, 'passed');
    assert.deepEqual(custom(70.7, 71.3), {
      status: 'failed',
      reason: 'mutation score dropped: 70.70% < baseline 71.30% (tolerance 0.5 points)',
    });
    assert.deepEqual(custom(71.9, 71.3), {
      status: 'failed',
      reason:
        'baseline stale: 71.90% is more than 0.5 points over 71.30%; ' +
        'record the gain: bun run mutation --accept',
    });
    assert.deepEqual(
      judgeScore(
        71.3,
        options({ baseline: null, baselineFile: 'score.json', acceptHint: 'bun run accept' }),
      ),
      {
        status: 'blocked',
        reason: 'no score.json; create it from a complete run: bun run accept',
      },
    );
    assert.equal(compareToBaseline(70, 74, { staleMargin: 5 }), null);
    assert.equal(compareToBaseline(70, 66, { dropTolerance: 5 }), null);
    assert.equal(compareToBaseline(70, 64.99, { dropTolerance: 5 }), 'dropped');
  });

  it('is blocked, never passed, without a baseline or with an unreadable one', () => {
    const missing = judgeScore(71.3, options({ baseline: null }));
    assert.equal(missing.status, 'blocked');
    assert.match(missing.reason, /^no mutation-baseline\.json; .*\(accept: true\)$/u);

    const unreadable = judgeScore(71.3, options({ baseline: { error: 'it is a directory' } }));
    assert.deepEqual(unreadable, {
      status: 'blocked',
      reason: 'unreadable mutation-baseline.json: it is a directory',
    });
    assert.equal(
      judgeScore(71.3, options({ baseline: { error: 'x' }, accept: true })).status,
      'blocked',
      'an unreadable baseline was overwritten by accept',
    );
  });

  it('accepts a first score and a gain, and returns what to write', () => {
    assert.deepEqual(judgeScore(64.2, options({ baseline: null, accept: true })), {
      status: 'passed',
      reason: 'accepted 64.20% as the baseline',
      write: 64.2,
    });
    assert.deepEqual(judgeScore(75.004, options({ accept: true })), {
      status: 'passed',
      reason: 'accepted 75.00% as the baseline',
      write: 75,
    });
  });

  it('keeps the baseline when accepting a dip inside the tolerance, and says so', () => {
    assert.deepEqual(judgeScore(70.9, options({ accept: true })), {
      status: 'passed',
      reason: 'baseline kept at 71.30%: the run measured 70.90%, inside the tolerance',
      write: 71.3,
    });
  });

  it('fails a score that is not a number, and accepts nothing from it', () => {
    for (const measured of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100.01]) {
      for (const accept of [false, true]) {
        const verdict = judgeScore(measured, options({ accept, allowLowering: accept }));
        assert.equal(verdict.status, 'failed', `${String(measured)} accept=${String(accept)}`);
        assert.match(verdict.reason, /^the measured score is not a percentage/u);
        assert.equal(verdict.write, undefined);
      }
    }
  });

  it('refuses to accept a drop without allowLowering, and writes nothing', () => {
    const refused = judgeScore(60, options({ accept: true }));
    assert.equal(refused.status, 'failed');
    assert.match(refused.reason, /^accept refused: 60\.00% is under the baseline 71\.30%/u);
    assert.match(refused.reason, /allowLowering/u);
    assert.equal(refused.write, undefined);

    assert.deepEqual(judgeScore(60, options({ accept: true, allowLowering: true })), {
      status: 'passed',
      reason: 'accepted 60.00% as the baseline',
      write: 60,
    });
  });
});
