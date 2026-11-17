import { describe, expect, spyOn, test } from 'bun:test';

import {
  DEFAULT_BASELINE_DIR,
  isGrandfathered,
  LEGACY_BASELINE_DIR,
  loadBaseline,
  serializeBaseline,
} from './baseline.js';
import { createFakeCtx } from './create-fake-ctx.js';

describe('serializeBaseline — stable, diff-friendly', () => {
  test('sorts keys and ends with a trailing newline', () => {
    const out = serializeBaseline({ b: 2, a: 1 });
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });
});

describe('isGrandfathered — one-way ratchet', () => {
  const baseline = { 'size:src/big.ts': 500 };

  test('a recorded offender at or below its frozen value passes', () => {
    expect(isGrandfathered(baseline, 'size:src/big.ts', 500)).toBe(true);
    expect(isGrandfathered(baseline, 'size:src/big.ts', 480)).toBe(true);
  });

  test('a recorded offender that GREW is a live violation', () => {
    expect(isGrandfathered(baseline, 'size:src/big.ts', 501)).toBe(false);
  });

  test('a NEW offender (absent from the baseline) is never grandfathered', () => {
    expect(isGrandfathered(baseline, 'size:src/new.ts', 1)).toBe(false);
  });
});

describe('loadBaseline — round-trips through the ctx at the portable home', () => {
  test('serialize → read back yields the same map', () => {
    const map = { 'manifest:a': 3, 'size:b': 7 };
    const path = `${DEFAULT_BASELINE_DIR}/my-rule.json`;
    const ctx = createFakeCtx({ files: { [path]: serializeBaseline(map) } });
    expect(loadBaseline(ctx, 'my-rule')).toEqual(map);
  });

  test('an absent baseline loads as {}', () => {
    const ctx = createFakeCtx({ files: {} });
    expect(loadBaseline(ctx, 'missing')).toEqual({});
  });

  test('malformed JSON loads as {} (never throws)', () => {
    const path = `${DEFAULT_BASELINE_DIR}/broken.json`;
    const ctx = createFakeCtx({ files: { [path]: '{ not json' } });
    expect(loadBaseline(ctx, 'broken')).toEqual({});
  });

  test('a non-number-map JSON body loads as {}', () => {
    const path = `${DEFAULT_BASELINE_DIR}/mixed.json`;
    const ctx = createFakeCtx({ files: { [path]: JSON.stringify({ a: 'x', b: 2 }) } });
    expect(loadBaseline(ctx, 'mixed')).toEqual({});
  });

  test('an explicit baselineDir overrides the default home', () => {
    const ctx = createFakeCtx({ files: { 'custom/dir/r.json': serializeBaseline({ k: 1 }) } });
    expect(loadBaseline(ctx, 'r', 'custom/dir')).toEqual({ k: 1 });
    // and the default home is empty for the same rule id
    expect(loadBaseline(ctx, 'r')).toEqual({});
  });
});

describe('loadBaseline: the .nightcore/ fallback for the default home', () => {
  test('the default home is .noctcore/, the legacy one .nightcore/', () => {
    expect(DEFAULT_BASELINE_DIR).toBe('.noctcore/lint-meta/baselines');
    expect(LEGACY_BASELINE_DIR).toBe('.nightcore/lint-meta/baselines');
  });

  test('new only: reads it, no warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = createFakeCtx({
        files: { [`${DEFAULT_BASELINE_DIR}/fresh.json`]: serializeBaseline({ k: 1 }) },
      });
      expect(loadBaseline(ctx, 'fresh')).toEqual({ k: 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('old only: reads it and warns once, naming the new path', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = createFakeCtx({
        files: { [`${LEGACY_BASELINE_DIR}/old-rule.json`]: serializeBaseline({ k: 2 }) },
      });
      expect(loadBaseline(ctx, 'old-rule')).toEqual({ k: 2 });
      expect(loadBaseline(ctx, 'old-rule')).toEqual({ k: 2 });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('.nightcore/lint-meta/baselines/old-rule.json');
      expect(message).toContain('.noctcore/lint-meta/baselines/old-rule.json');
    } finally {
      warn.mockRestore();
    }
  });

  test('both: throws (the rule reds the build) instead of picking one', () => {
    const ctx = createFakeCtx({
      files: {
        [`${DEFAULT_BASELINE_DIR}/dup.json`]: serializeBaseline({ k: 1 }),
        [`${LEGACY_BASELINE_DIR}/dup.json`]: serializeBaseline({ k: 9 }),
      },
    });
    expect(() => loadBaseline(ctx, 'dup')).toThrow('Found both');
  });

  test('a custom baselineDir never falls back', () => {
    const ctx = createFakeCtx({
      files: { [`${LEGACY_BASELINE_DIR}/r.json`]: serializeBaseline({ k: 1 }) },
    });
    expect(loadBaseline(ctx, 'r', 'custom/dir')).toEqual({});
  });
});
