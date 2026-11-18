import { describe, expect, test } from 'bun:test';

import {
  affectedBaseFrom,
  affectedEnvLines,
  type BaseDecision,
  chooseBase,
  decideAffectedBase,
  headShaOfLatestRun,
  type IBaseDeps,
  type IBaseInput,
  outsideWorkspaces,
} from './affected-base.js';

const GREEN = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const PR_BASE = 'c'.repeat(40);
const WORKSPACES = new Set(['apps/web', 'apps/api', 'packages/ui']);
const isWorkspace = (dir: string): boolean => WORKSPACES.has(dir);

function push(overrides: Partial<IBaseInput> = {}): IBaseInput {
  return { event: 'push', prBaseSha: '', before: BEFORE, ...overrides };
}

function deps(overrides: Partial<IBaseDeps> = {}): IBaseDeps {
  return {
    lastGreenPushSha: () => Promise.resolve(GREEN),
    isAncestor: () => true,
    changedFiles: () => ['apps/web/src/main.tsx'],
    isWorkspace,
    ...overrides,
  };
}

function baseOf(decision: BaseDecision): string {
  return decision.kind === 'affected' ? decision.base : '';
}

describe('decideAffectedBase on push', () => {
  test('diffs against the head of the last successful push run, not the previous tip', async () => {
    const decision = await decideAffectedBase(push(), deps());
    expect(decision.kind).toBe('affected');
    expect(baseOf(decision)).toBe(GREEN);
    expect(decision.reason).toContain(`previous tip was ${BEFORE}`);
  });

  test('reports an unknown previous tip', async () => {
    const decision = await decideAffectedBase(push({ before: '' }), deps());
    expect(decision.reason).toContain('previous tip was unknown');
  });

  test('runs everything when no push run has ever succeeded', async () => {
    const decision = await decideAffectedBase(
      push(),
      deps({ lastGreenPushSha: () => Promise.resolve(null) }),
    );
    expect(decision.kind).toBe('full');
    expect(decision.reason).toMatch(/no successful push run/u);
  });

  test('runs everything when the lookup throws', async () => {
    const decision = await decideAffectedBase(
      push(),
      deps({ lastGreenPushSha: () => Promise.reject(new Error('HTTP 502')) }),
    );
    expect(decision.kind).toBe('full');
    expect(decision.reason).toContain('HTTP 502');
  });

  test('runs everything when the lookup throws a non-Error', async () => {
    const decision = await decideAffectedBase(
      push(),
      deps({
        lastGreenPushSha: () => {
          throw 'offline';
        },
      }),
    );
    expect(decision.kind).toBe('full');
    expect(decision.reason).toContain('(offline)');
  });

  test('runs everything when the green sha is not an ancestor of HEAD (a force push)', async () => {
    const decision = await decideAffectedBase(push(), deps({ isAncestor: () => false }));
    expect(decision.kind).toBe('full');
    expect(decision.reason).toMatch(/not an ancestor/u);
  });

  test('runs everything when the lookup returns something that is not a sha', async () => {
    let asked = false;
    const decision = await decideAffectedBase(
      push(),
      deps({
        lastGreenPushSha: () => Promise.resolve('--output=/tmp/x'),
        isAncestor: () => {
          asked = true;
          return true;
        },
      }),
    );
    expect(decision.kind).toBe('full');
    expect(asked).toBe(false);
  });

  test('runs everything when git cannot list the diff', async () => {
    const decision = await decideAffectedBase(push(), deps({ changedFiles: () => null }));
    expect(decision.kind).toBe('full');
    expect(decision.reason).toMatch(/could not list the files changed/u);
  });

  test('runs everything when a change is outside the workspaces, naming at most five', async () => {
    const changed = ['apps/web/a.ts', 'turbo.json', 'a', 'b', 'c', 'd', 'e', 'f'];
    const decision = await decideAffectedBase(push(), deps({ changedFiles: () => changed }));
    expect(decision.kind).toBe('full');
    expect(decision.reason).toContain('(apps/*, packages/*)');
    expect(decision.reason).toContain('turbo.json, a, b, c, d and 2 more');
  });

  test('names every outside path when there are five or fewer', async () => {
    const decision = await decideAffectedBase(push(), deps({ changedFiles: () => ['README.md'] }));
    expect(decision.reason).toContain('(README.md)');
    expect(decision.reason).not.toContain('more');
  });

  test('keeps the base when every change is inside a workspace', async () => {
    const decision = await decideAffectedBase(
      push(),
      deps({ changedFiles: () => ['apps/web/a.ts', 'packages/ui/src/b.ts'] }),
    );
    expect(baseOf(decision)).toBe(GREEN);
  });

  test('keeps the base when nothing changed', async () => {
    const decision = await decideAffectedBase(push(), deps({ changedFiles: () => [] }));
    expect(baseOf(decision)).toBe(GREEN);
  });
});

describe('decideAffectedBase on other events', () => {
  test('a pull request diffs against its base', async () => {
    let looked = false;
    const decision = await decideAffectedBase(
      { event: 'pull_request', prBaseSha: PR_BASE, before: '' },
      deps({
        lastGreenPushSha: () => {
          looked = true;
          return Promise.resolve(GREEN);
        },
      }),
    );
    expect(baseOf(decision)).toBe(PR_BASE);
    expect(looked).toBe(false);
  });

  test('a pull request without a readable base sha runs everything', async () => {
    const decision = await decideAffectedBase(
      { event: 'pull_request', prBaseSha: 'main', before: '' },
      deps(),
    );
    expect(decision.kind).toBe('full');
    expect(decision.reason).toMatch(/without a readable base sha/u);
  });

  test('a pull request with outside changes still runs everything', async () => {
    const decision = await decideAffectedBase(
      { event: 'pull_request', prBaseSha: PR_BASE, before: '' },
      deps({ changedFiles: () => ['package.json'] }),
    );
    expect(decision.kind).toBe('full');
  });

  test('workflow_dispatch runs everything', async () => {
    const decision = await decideAffectedBase(push({ event: 'workflow_dispatch' }), deps());
    expect(decision).toEqual({ kind: 'full', reason: 'workflow_dispatch: running everything' });
  });

  test('a missing event name runs everything', async () => {
    const decision = await chooseBase(push({ event: '' }), deps());
    expect(decision.reason).toBe('unknown event: running everything');
  });
});

describe('outsideWorkspaces', () => {
  test('a folder under a root without a package.json is outside', () => {
    expect(outsideWorkspaces(['apps/stray/x.ts', 'apps/web/x.ts'], isWorkspace)).toEqual([
      'apps/stray/x.ts',
    ]);
  });

  test('a file directly in a root, or a bare folder name, is outside', () => {
    expect(outsideWorkspaces(['packages/README.md', 'apps/web/', 'apps'], isWorkspace)).toEqual([
      'packages/README.md',
      'apps/web/',
      'apps',
    ]);
  });

  test('a root prefix that is only a name prefix does not match', () => {
    expect(outsideWorkspaces(['appsx/web/a.ts'], () => true)).toEqual(['appsx/web/a.ts']);
  });

  test('custom workspace roots replace the defaults', () => {
    const roots = { workspaceRoots: ['libs', '/tools/'] };
    const seen: string[] = [];
    const probe = (dir: string): boolean => {
      seen.push(dir);
      return true;
    };
    expect(
      outsideWorkspaces(['libs/a/x.ts', 'tools/b/y.ts', 'apps/web/z.ts'], probe, roots),
    ).toEqual(['apps/web/z.ts']);
    expect(seen).toEqual(['libs/a', 'tools/b']);
  });

  test('custom roots are named in the full-run reason', () => {
    const decision = affectedBaseFrom(
      { kind: 'affected', base: GREEN, reason: 'x' },
      { changedFiles: () => ['apps/web/a.ts'], isWorkspace: () => true },
      { workspaceRoots: ['libs'] },
    );
    expect(decision.kind).toBe('full');
    expect(decision.reason).toContain('(libs/*)');
  });
});

describe('affectedBaseFrom', () => {
  test('passes a full decision through without asking git', () => {
    const full: BaseDecision = { kind: 'full', reason: 'x' };
    const decision = affectedBaseFrom(full, {
      changedFiles: () => {
        throw new Error('asked');
      },
      isWorkspace,
    });
    expect(decision).toBe(full);
  });
});

describe('headShaOfLatestRun', () => {
  test('returns the first run head sha', () => {
    expect(headShaOfLatestRun({ workflow_runs: [{ head_sha: GREEN }, { head_sha: BEFORE }] })).toBe(
      GREEN,
    );
  });

  test('returns null for an empty list', () => {
    expect(headShaOfLatestRun({ total_count: 0, workflow_runs: [] })).toBeNull();
  });

  test('throws on a body without a run list', () => {
    expect(() => headShaOfLatestRun({ message: 'Not Found' })).toThrow(/no workflow_runs/u);
    expect(() => headShaOfLatestRun(null)).toThrow(/no workflow_runs/u);
  });

  test('throws on a head sha that is not a commit sha', () => {
    expect(() => headShaOfLatestRun({ workflow_runs: [{ head_sha: 'main' }] })).toThrow(
      /not a commit sha: "main"/u,
    );
    expect(() => headShaOfLatestRun({ workflow_runs: [null] })).toThrow(/not a commit sha/u);
  });
});

describe('affectedEnvLines', () => {
  test('a filtered run sets the base and the flag', () => {
    expect(affectedEnvLines({ kind: 'affected', base: GREEN, reason: '' })).toEqual([
      `TURBO_SCM_BASE=${GREEN}`,
      'TURBO_AFFECTED=--affected',
    ]);
  });

  test('a full run sets both empty', () => {
    expect(affectedEnvLines({ kind: 'full', reason: '' })).toEqual([
      'TURBO_SCM_BASE=',
      'TURBO_AFFECTED=',
    ]);
  });

  test('takes custom variable names and flag value', () => {
    const options = { baseVar: 'NX_BASE', flagVar: 'NX_FILTER', flagValue: 'affected' };
    expect(affectedEnvLines({ kind: 'affected', base: GREEN, reason: '' }, options)).toEqual([
      `NX_BASE=${GREEN}`,
      'NX_FILTER=affected',
    ]);
    expect(affectedEnvLines({ kind: 'full', reason: '' }, options)).toEqual([
      'NX_BASE=',
      'NX_FILTER=',
    ]);
  });
});
