import path from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  type FileReader,
  legacyManifestPath,
  loadChecks,
  manifestPath,
  planCheck,
  resolveDefaultManifest,
} from './manifest.js';
import { LEGACY_MANIFEST_RELATIVE_PATH, MANIFEST_RELATIVE_PATH } from './paths.js';

const DIR = path.resolve('/repo');

/**
 * A reader that returns a fixed body for any path except the legacy default
 * manifest (which it reports absent, so the default path resolves to the current one).
 */
function reader(body: string | null): FileReader {
  return (p) => (p === legacyManifestPath(DIR) ? null : body);
}

/** A reader over an absolute-path map; anything else is absent. */
function files(map: Record<string, string>): FileReader {
  return (p) => map[p] ?? null;
}

describe('planCheck (command planning, mirrors plan_check)', () => {
  test('splits the command on whitespace into program + args', () => {
    const planned = planCheck({ name: 'lint', kind: 'lint-plugin', command: 'npx  eslint   .' });
    expect(planned).not.toBeNull();
    expect(planned?.program).toBe('npx');
    expect(planned?.args).toEqual(['eslint', '.']);
    expect(planned?.command).toBe('npx  eslint   .');
    expect(planned?.timeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });

  test('a blank or absent command is skipped', () => {
    expect(planCheck({ name: 'a', kind: 'lint-plugin', command: '   ' })).toBeNull();
    expect(planCheck({ name: 'a', kind: 'lint-plugin' })).toBeNull();
  });

  test('a disabled check is skipped', () => {
    expect(planCheck({ name: 'a', kind: 'lint-plugin', command: 'x', enabled: false })).toBeNull();
    // enabled defaults to true.
    expect(planCheck({ name: 'a', kind: 'lint-plugin', command: 'x' })).not.toBeNull();
  });

  test('a shell-kind check is skipped (its execution is a deferred fast-follow)', () => {
    expect(planCheck({ name: 'a', kind: 'shell', command: 'rg --count foo' })).toBeNull();
  });

  test('an unknown/future kind with a command still runs (forward-compat)', () => {
    const planned = planCheck({ name: 'a', kind: 'some-future-kind', command: 'do it' });
    expect(planned?.kind).toBe('some-future-kind');
    expect(planned?.program).toBe('do');
  });

  test('a malformed entry (non-object, missing name) is skipped', () => {
    expect(planCheck(null)).toBeNull();
    expect(planCheck('nope')).toBeNull();
    expect(planCheck({ kind: 'lint-plugin', command: 'x' })).toBeNull();
    expect(planCheck({ name: '  ', kind: 'lint-plugin', command: 'x' })).toBeNull();
  });

  test('timeoutMs is honored when > 0, else falls back to the default', () => {
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: 5000 })?.timeoutMs).toBe(
      5000,
    );
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: 0 })?.timeoutMs).toBe(
      DEFAULT_CHECK_TIMEOUT_MS,
    );
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: -1 })?.timeoutMs).toBe(
      DEFAULT_CHECK_TIMEOUT_MS,
    );
  });
});

describe('loadChecks (opt-in-by-presence, mirrors load_checks)', () => {
  test('reads the manifest at <dir>/.noctcore/harness.json', () => {
    const seen: string[] = [];
    loadChecks(DIR, (p) => {
      seen.push(p);
      return null;
    });
    expect(seen[0]).toBe(manifestPath(DIR));
    expect(manifestPath(DIR)).toBe(path.join(DIR, '.noctcore', 'harness.json'));
  });

  test('an absent / unreadable manifest yields no-config (exit 0)', () => {
    expect(loadChecks(DIR, reader(null))).toEqual({ kind: 'no-config' });
  });

  test('malformed JSON yields no-config (warn-and-skip everything)', () => {
    expect(loadChecks(DIR, reader('{ not json'))).toEqual({ kind: 'no-config' });
  });

  test('a manifest with no checks array yields no-config', () => {
    expect(loadChecks(DIR, reader(JSON.stringify({ policy: {} })))).toEqual({ kind: 'no-config' });
  });

  test('a non-object JSON body yields no-config', () => {
    expect(loadChecks(DIR, reader('42'))).toEqual({ kind: 'no-config' });
  });

  test('an absent schemaVersion is treated as v1 and proceeds', () => {
    const out = loadChecks(
      DIR,
      reader(JSON.stringify({ checks: [{ name: 'a', kind: 'k', command: 'x' }] })),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.checks).toHaveLength(1);
  });

  test('schemaVersion 1 proceeds', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 1, checks: [] })));
    expect(out).toEqual({ kind: 'ready', checks: [] });
  });

  test('a higher MAJOR schemaVersion is rejected (upgrade the runner)', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 2, checks: [] })));
    expect(out).toEqual({ kind: 'schema-too-new', found: 2 });
  });

  test('an unparseable schemaVersion is rejected fail-safe', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 'nonsense', checks: [] })));
    expect(out.kind).toBe('schema-too-new');
  });

  test('disabled and command-less entries are dropped from the plan', () => {
    const out = loadChecks(
      DIR,
      reader(
        JSON.stringify({
          checks: [
            { name: 'runs', kind: 'lint-plugin', command: 'npx eslint .' },
            { name: 'off', kind: 'lint-plugin', command: 'x', enabled: false },
            { name: 'nocmd', kind: 'lint-plugin' },
            { name: 'shell', kind: 'shell', command: 'rg foo' },
          ],
        }),
      ),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.checks.map((c) => c.name)).toEqual(['runs']);
    }
  });
});

describe('loadChecks — an EXPLICIT manifest path is fail-closed (#325)', () => {
  /** A reader that only knows one path (everything else is unreadable). */
  function only(known: string, body: string): FileReader {
    return (p) => (p === known ? body : null);
  }

  const BUNDLE = '.nightcore/export/portable-lock/harness.json';
  const ABS_BUNDLE = path.resolve(DIR, BUNDLE);

  test('the explicit path is resolved against dir and read instead of the default', () => {
    const out = loadChecks(
      DIR,
      only(
        ABS_BUNDLE,
        JSON.stringify({ checks: [{ name: 'a', kind: 'lint-meta', command: 'x' }] }),
      ),
      BUNDLE,
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.checks.map((c) => c.name)).toEqual(['a']);
  });

  test('an absent explicit manifest is unreadable-manifest, NOT no-config', () => {
    const out = loadChecks(DIR, reader(null), BUNDLE);
    expect(out.kind).toBe('unreadable-manifest');
    if (out.kind === 'unreadable-manifest') expect(out.path).toBe(ABS_BUNDLE);
  });

  test('malformed JSON in an explicit manifest is unreadable-manifest (the default path stays exit-0)', () => {
    expect(loadChecks(DIR, reader('{ not json'), BUNDLE).kind).toBe('unreadable-manifest');
    expect(loadChecks(DIR, reader('{ not json')).kind).toBe('no-config');
  });

  test('a non-object root in an explicit manifest is unreadable-manifest', () => {
    expect(loadChecks(DIR, reader('[]'), BUNDLE).kind).toBe('unreadable-manifest');
  });

  test('a parseable explicit manifest with no checks array is simply nothing to enforce', () => {
    // Contents stay DATA: only the file itself must exist and parse.
    expect(loadChecks(DIR, reader('{ "schemaVersion": 1 }'), BUNDLE).kind).toBe('no-config');
  });

  test('an empty explicit path falls back to the default manifest', () => {
    const out = loadChecks(DIR, only(manifestPath(DIR), JSON.stringify({ checks: [] })), '');
    expect(out.kind).toBe('ready');
  });
});

describe('the default manifest location and its .nightcore/ fallback', () => {
  const body = JSON.stringify({ checks: [{ name: 'a', kind: 'k', command: 'x' }] });

  test('the constants name .noctcore/ and the legacy .nightcore/', () => {
    expect(MANIFEST_RELATIVE_PATH).toBe('.noctcore/harness.json');
    expect(LEGACY_MANIFEST_RELATIVE_PATH).toBe('.nightcore/harness.json');
    expect(legacyManifestPath(DIR)).toBe(path.join(DIR, '.nightcore', 'harness.json'));
  });

  test('new only: reads it and warns about nothing', () => {
    const warnings: string[] = [];
    const out = loadChecks(DIR, files({ [manifestPath(DIR)]: body }), undefined, (m) =>
      warnings.push(m),
    );
    expect(out.kind).toBe('ready');
    expect(warnings).toEqual([]);
  });

  test('old only: reads it and passes exactly one deprecation warning', () => {
    const warnings: string[] = [];
    const out = loadChecks(DIR, files({ [legacyManifestPath(DIR)]: body }), undefined, (m) =>
      warnings.push(m),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.checks.map((c) => c.name)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.nightcore/harness.json');
    expect(warnings[0]).toContain('.noctcore/harness.json');
    expect(warnings[0]).toContain('1.0');
  });

  test('old only keeps the default posture: a malformed legacy manifest is no-config', () => {
    const out = loadChecks(DIR, files({ [legacyManifestPath(DIR)]: '{ nope' }));
    expect(out).toEqual({ kind: 'no-config' });
  });

  test('both: conflicting-manifests, never a silent pick', () => {
    const warnings: string[] = [];
    const out = loadChecks(
      DIR,
      files({ [manifestPath(DIR)]: body, [legacyManifestPath(DIR)]: body }),
      undefined,
      (m) => warnings.push(m),
    );
    expect(out.kind).toBe('conflicting-manifests');
    if (out.kind === 'conflicting-manifests') {
      expect(out.message).toContain('.noctcore/harness.json');
      expect(out.message).toContain('.nightcore/harness.json');
    }
    expect(warnings).toEqual([]);
  });

  test('neither: no-config, as before', () => {
    expect(loadChecks(DIR, files({}))).toEqual({ kind: 'no-config' });
    expect(resolveDefaultManifest(DIR, files({}))).toEqual({
      kind: 'current',
      path: manifestPath(DIR),
      raw: null,
    });
  });

  test('an explicit path ignores both defaults', () => {
    const out = loadChecks(
      DIR,
      files({
        [path.resolve(DIR, 'b/harness.json')]: body,
        [manifestPath(DIR)]: body,
        [legacyManifestPath(DIR)]: body,
      }),
      'b/harness.json',
    );
    expect(out.kind).toBe('ready');
  });
});
