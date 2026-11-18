import { describe, expect, test } from 'bun:test';

import type { IExemptCommit } from './commit-range.js';
import { type ICommitlintDeps, type ICommitlintOptions, runCommitlint } from './commitlint.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const EXEMPT: IExemptCommit = { sha: C, reason: 'pushed without the hook', message: 'bad message' };

interface ISpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function harness(overrides: Partial<ICommitlintDeps> = {}): {
  readonly deps: ICommitlintDeps;
  readonly calls: ISpawnCall[];
  readonly logs: string[];
} {
  const calls: ISpawnCall[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    deps: {
      commitsIn: () => [A, B],
      commitMessage: (sha) => (sha === C ? 'bad message\n' : `feat(x): commit ${sha.slice(0, 1)}`),
      spawn: (command, args, input) => {
        calls.push({ command, args, input });
        return 0;
      },
      log: (line) => void logs.push(line),
      ...overrides,
    },
  };
}

function options(overrides: Partial<ICommitlintOptions> = {}): ICommitlintOptions {
  return {
    from: B,
    to: 'HEAD',
    event: 'push',
    commitlint: { command: 'node', args: ['cli.js', '--config', 'commitlint config.js'] },
    ...overrides,
  };
}

describe('runCommitlint', () => {
  test('a range git cannot list fails', () => {
    const h = harness({ commitsIn: () => null });
    expect(runCommitlint(options(), h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.logs[0]).toMatch(/git cannot list .*fetch-depth: 0/u);
  });

  test('an empty range passes without running commitlint', () => {
    const h = harness({ commitsIn: () => [] });
    expect(runCommitlint(options(), h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.logs[0]).toContain('holds no commit');
  });

  test('a passing range runs commitlint once over the range and prints the command first', () => {
    const h = harness();
    expect(runCommitlint(options(), h.deps)).toBe(0);
    expect(h.calls).toEqual([
      {
        command: 'node',
        args: [
          'cli.js',
          '--config',
          'commitlint config.js',
          '--from',
          B,
          '--to',
          'HEAD',
          '--verbose',
        ],
        input: undefined,
      },
    ]);
    expect(h.logs).toContain(
      `→ node cli.js --config "commitlint config.js" --from ${B} --to HEAD --verbose`,
    );
  });

  test('a failing range fails', () => {
    const h = harness({ spawn: () => 2 });
    expect(runCommitlint(options(), h.deps)).toBe(1);
  });

  test('a commitlint that cannot start fails', () => {
    const h = harness({ spawn: () => null });
    expect(runCommitlint(options(), h.deps)).toBe(1);
  });

  test('skips an exempt commit and lints the others one by one through stdin', () => {
    const h = harness({ commitsIn: () => [A, C, B] });
    expect(runCommitlint(options({ exempt: [EXEMPT] }), h.deps)).toBe(0);
    expect(h.calls.map((call) => call.input)).toEqual(['feat(x): commit a', 'feat(x): commit b']);
    expect(h.calls[0]?.args.slice(-1)).toEqual(['--verbose']);
    expect(h.logs.some((line) => line.includes(`skipping exempt ${C}`))).toBe(true);
  });

  test('one failing commit in a one-by-one run fails the run, after linting the rest', () => {
    const h = harness({
      commitsIn: () => [A, C, B],
      spawn: (command, args, input) => {
        h.calls.push({ command, args, input });
        return input?.endsWith('a') === true ? 1 : 0;
      },
    });
    expect(runCommitlint(options({ exempt: [EXEMPT] }), h.deps)).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.logs).toContain(`commitlint: ${A} fails`);
  });

  test('a commit whose message git cannot read fails', () => {
    const h = harness({
      commitsIn: () => [A, C],
      commitMessage: (sha) => (sha === C ? 'bad message' : null),
    });
    expect(runCommitlint(options({ exempt: [EXEMPT] }), h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.logs).toContain(`commitlint: git cannot read the message of ${A}`);
  });

  test('a refused plan fails without running commitlint', () => {
    const h = harness({ commitsIn: () => [C], commitMessage: () => 'rewritten' });
    expect(runCommitlint(options({ exempt: [EXEMPT] }), h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.logs.at(-1)).toMatch(/fix the exemption list/u);
  });

  test('a pull request ignores the exemption list and lints the whole range', () => {
    const h = harness({ commitsIn: () => [A, C] });
    expect(runCommitlint(options({ event: 'pull_request', exempt: [EXEMPT] }), h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.args).toContain('--from');
  });
});
