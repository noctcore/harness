import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { nodeCiGitDeps, nodeIsWorkspace, nodeSpawnInherit, readDueSources } from './git.js';

// A throwaway repo: two commits, the second touching a workspace, a root file
// and a non-ASCII path.
let repo = '';
let first = '';
let second = '';

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), text);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'harness-ci-git-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('packages/ui/package.json', '{}');
  write('README.md', 'one');
  git('add', '.');
  git('commit', '-q', '-m', 'chore(repo): first');
  first = git('rev-parse', 'HEAD');
  write('packages/ui/src/a.ts', 'export {};');
  write('packages/wéb/b.ts', 'export {};');
  write('README.md', 'two');
  git('add', '.');
  git('commit', '-q', '-m', 'feat(ui): second\n\nwith a body');
  second = git('rev-parse', 'HEAD');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('nodeCiGitDeps', () => {
  test('lists changed files unquoted, including a non-ASCII path', () => {
    expect([...(nodeCiGitDeps(repo).changedFiles(first) ?? [])].sort()).toEqual([
      'README.md',
      'packages/ui/src/a.ts',
      'packages/wéb/b.ts',
    ]);
  });

  test('returns null for a base git cannot diff, and refuses an option as a base', () => {
    const deps = nodeCiGitDeps(repo);
    expect(deps.changedFiles('f'.repeat(40))).toBeNull();
    expect(deps.changedFiles('--output=x')).toBeNull();
  });

  test('answers ancestry', () => {
    const deps = nodeCiGitDeps(repo);
    expect(deps.isAncestor(first)).toBe(true);
    expect(deps.isAncestor('f'.repeat(40))).toBe(false);
  });

  test('lists the commits in a range, and null for an unknown ref', () => {
    const deps = nodeCiGitDeps(repo);
    expect(deps.commitsIn(first, 'HEAD')).toEqual([second]);
    expect(deps.commitsIn('HEAD', 'HEAD')).toEqual([]);
    expect(deps.commitsIn('nope', 'HEAD')).toBeNull();
  });

  test('reads a commit message, and null for an unknown sha', () => {
    const deps = nodeCiGitDeps(repo);
    expect(deps.commitMessage(second)?.trim()).toBe('feat(ui): second\n\nwith a body');
    expect(deps.commitMessage('f'.repeat(40))).toBeNull();
  });
});

describe('nodeIsWorkspace', () => {
  test('a folder with a package.json is a workspace', () => {
    const isWorkspace = nodeIsWorkspace(repo);
    expect(isWorkspace('packages/ui')).toBe(true);
    expect(isWorkspace('packages/wéb')).toBe(false);
  });
});

describe('nodeSpawnInherit', () => {
  test('returns the exit code, passes stdin, and null when the command cannot start', () => {
    const spawn = nodeSpawnInherit(repo);
    expect(spawn(process.execPath, ['-e', 'process.exit(3)'])).toBe(3);
    const echo =
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s==="hi"?0:4))';
    expect(spawn(process.execPath, ['-e', echo], 'hi')).toBe(0);
    expect(spawn(join(repo, 'no-such-command'), [])).toBeNull();
  });
});

describe('readDueSources', () => {
  test('reads ledgers and the ignore file, and records a missing ledger as a problem', () => {
    write('ledgers/a.json', '{"x":{"reviewBy":"2027-01-01"}}');
    write('.trivyignore.yaml', 'vulnerabilities:\n');
    expect(readDueSources(repo, ['ledgers/a.json', 'gone.json'], '.trivyignore.yaml')).toEqual({
      ledgers: { 'ledgers/a.json': '{"x":{"reviewBy":"2027-01-01"}}' },
      trivyIgnore: 'vulnerabilities:\n',
      trivyIgnoreName: '.trivyignore.yaml',
      problems: ['gone.json is missing: restore it or drop it from the ledger list'],
    });
  });

  test('an absent ignore file is no ignores; an unreadable one is a problem', () => {
    expect(readDueSources(repo, [], 'none.yaml')).toEqual({
      ledgers: {},
      trivyIgnore: null,
      trivyIgnoreName: 'none.yaml',
      problems: [],
    });
    const result = readDueSources(repo, ['ledgers'], 'ledgers');
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/^ledgers cannot be read/u);
    expect(readDueSources(repo, []).trivyIgnore).toBeNull();
  });
});
