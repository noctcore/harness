import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IDueSources } from './due-dates.js';

/*
 * The real I/O behind the ci helpers: the git questions they ask, run in
 * `cwd`, a workspace probe, a spawn with inherited stdio, and a reader for the
 * due-date sources. Everything else in the subpath is pure over these.
 */

export interface ICiGitDeps {
  /** Paths changed between `base` and HEAD, renames listed as both paths, or null when git cannot diff. */
  readonly changedFiles: (base: string) => readonly string[] | null;
  /** Whether `sha` is an ancestor of HEAD. */
  readonly isAncestor: (sha: string) => boolean;
  /** `git rev-list from..to`: the commits in the range, newest first, or null when git cannot list it. */
  readonly commitsIn: (from: string, to: string) => readonly string[] | null;
  /** A commit's full message, as `git log -1 --format=%B` prints it, or null when git cannot read it. */
  readonly commitMessage: (sha: string) => string | null;
}

function git(args: readonly string[], cwd: string): string | null {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return result.error === undefined && result.status === 0 ? result.stdout : null;
}

/**
 * The git deps for the repo at `cwd`. `changedFiles` is NUL-separated with
 * core.quotePath off: git otherwise quotes a non-ASCII path
 * (`"packages/w\303\251b/a.ts"`), and a quoted path no longer starts with its
 * workspace folder, so a workspace change would read as one outside them.
 */
export function nodeCiGitDeps(cwd: string): ICiGitDeps {
  return {
    changedFiles: (base) => {
      const out = git(
        [
          '-c',
          'core.quotePath=false',
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          '--end-of-options',
          base,
          'HEAD',
        ],
        cwd,
      );
      return out === null ? null : out.split('\0').filter((path) => path !== '');
    },
    isAncestor: (sha) =>
      spawnSync('git', ['merge-base', '--is-ancestor', '--end-of-options', sha, 'HEAD'], { cwd })
        .status === 0,
    commitsIn: (from, to) => {
      const out = git(['rev-list', '--end-of-options', `${from}..${to}`], cwd);
      return out === null ? null : out.split(/\r?\n/u).filter((sha) => sha !== '');
    },
    commitMessage: (sha) => git(['log', '-1', '--format=%B', '--end-of-options', sha], cwd),
  };
}

/** Whether a repo-relative folder under `cwd` is a workspace: it has a package.json. */
export function nodeIsWorkspace(cwd: string): (dir: string) => boolean {
  return (dir) => existsSync(join(cwd, dir, 'package.json'));
}

/**
 * Run a command with stdout and stderr inherited, `input` on stdin when given.
 * The exit code, or null when it could not start. Fits `ICommitlintDeps.spawn`.
 */
export function nodeSpawnInherit(
  cwd: string,
): (command: string, args: readonly string[], input?: string) => number | null {
  return (command, args, input) => {
    const result = spawnSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    });
    return result.error === undefined ? result.status : null;
  };
}

/**
 * Read the due-date sources under `cwd`: each ledger (repo-relative path) and,
 * when given and present, the trivy ignore file. A ledger that cannot be read
 * is a problem in the result, never a silent pass; an absent ignore file is
 * no ignores.
 */
export function readDueSources(
  cwd: string,
  ledgerPaths: readonly string[],
  trivyIgnorePath?: string,
): IDueSources & { readonly problems: readonly string[] } {
  const ledgers: Record<string, string> = {};
  const problems: string[] = [];
  for (const path of ledgerPaths) {
    try {
      ledgers[path] = readFileSync(join(cwd, path), 'utf8');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      problems.push(
        code === 'ENOENT'
          ? `${path} is missing: restore it or drop it from the ledger list`
          : `${path} cannot be read: ${String(error)}`,
      );
    }
  }
  let trivyIgnore: string | null = null;
  if (trivyIgnorePath !== undefined) {
    try {
      trivyIgnore = readFileSync(join(cwd, trivyIgnorePath), 'utf8');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'ENOENT') problems.push(`${trivyIgnorePath} cannot be read: ${String(error)}`);
    }
  }
  return {
    ledgers,
    trivyIgnore,
    ...(trivyIgnorePath === undefined ? {} : { trivyIgnoreName: trivyIgnorePath }),
    problems,
  };
}
