/*
 * The node-backed dependencies the pure functions in this module take, so a
 * repo's CLI is a few lines: pick the pin, hand over these deps, print the
 * verdict and exit with `exitCodeFor`. Every spawn passes an argv, never a
 * shell string.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { IFetchDeps } from './fetch.js';
import type { IGitleaksRunDeps } from './gitleaks.js';
import type { IHadolintDeps } from './hadolint.js';
import { placeBinary } from './place-binary.js';
import type { IRunDeps } from './route.js';
import { DOCKER_COMMAND, parseVersion } from './route.js';
import type { ISquawkDeps } from './squawk.js';
import type { ICapturedRunDeps, ISpawned } from './tool-run.js';
import type { ITrivyScanDeps } from './trivy.js';

export { DOCKER_COMMAND };

/** Whether a Docker daemon answers through `docker` (or the named CLI). */
export function dockerAvailable(docker: string = DOCKER_COMMAND): boolean {
  const result = spawnSync(docker, ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  return result.error === undefined && result.status === 0;
}

/** The repo-relative `.github/workflows/*.y(a)ml` files under `root`, sorted, with `/` separators. */
export function workflowFilesUnder(root: string): readonly string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

function spawnShown(command: string, args: readonly string[], cwd: string): number | null {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  return result.error === undefined ? result.status : null;
}

function reportedVersion(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

export interface INodeRunOptions {
  /** The container CLI every call uses: the probes, the pull and the run. Defaults to `docker`. */
  readonly docker?: string;
}

function imagePresent(docker: string, image: string): boolean {
  const result = spawnSync(docker, ['image', 'inspect', image], { encoding: 'utf8' });
  return result.error === undefined && result.status === 0;
}

/** Pull with docker's own message shown, for `platform` when one is named. */
function pullImage(docker: string, image: string, platform?: string): boolean {
  const result = spawnSync(
    docker,
    ['pull', '--quiet', ...(platform === undefined ? [] : ['--platform', platform]), image],
    { stdio: 'inherit' },
  );
  return result.error === undefined && result.status === 0;
}

/** A report can run past the default 1 MiB, which would end the child and read as "could not start". */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Run from `cwd` with the output captured. `code` is null when it could not be started. */
export function spawnCaptured(command: string, args: readonly string[], cwd: string): ISpawned {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return {
    code: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** `runLinter`'s deps on this machine: PATH, the Docker CLI, and the repo's workflow files. */
export function nodeRunDeps(options: INodeRunOptions = {}): IRunDeps {
  const docker = options.docker ?? DOCKER_COMMAND;
  return {
    workflows: workflowFilesUnder,
    nativeVersion: (tool) => reportedVersion(tool.name, tool.versionArgs),
    dockerAvailable: () => dockerAvailable(docker),
    dockerCommand: docker,
    imagePresent: (image) => imagePresent(docker, image),
    pull: (image) => pullImage(docker, image),
    spawn: spawnShown,
  };
}

/** The deps every captured run shares: PATH, the container CLI, and a spawn that keeps the output. */
export function nodeCapturedDeps(options: INodeRunOptions = {}): ICapturedRunDeps {
  const docker = options.docker ?? DOCKER_COMMAND;
  return {
    nativeVersion: (tool) => reportedVersion(tool.name, tool.versionArgs),
    dockerAvailable: () => dockerAvailable(docker),
    dockerCommand: docker,
    imagePresent: (image) => imagePresent(docker, image),
    pull: (image, platform) => pullImage(docker, image, platform),
    spawn: spawnCaptured,
  };
}

/** The text of a repo-relative file (`/` separators) under `root`, or null when there is none. */
export function readRepoFile(root: string, file: string): string | null {
  const path = join(root, ...file.split('/'));
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Every file git tracks under `root`, repo-relative with `/`, or null when git cannot list them. */
export function gitTrackedFiles(root: string): readonly string[] | null {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.split('\0').filter((file) => file !== '');
}

/** `runHadolint`'s deps on this machine: git's tracked files, the files, PATH and the container CLI. */
export function nodeHadolintDeps(options: INodeRunOptions = {}): IHadolintDeps {
  return { ...nodeCapturedDeps(options), tracked: gitTrackedFiles, read: readRepoFile };
}

/**
 * The folders directly under `migrationsDir` of `root`, each with whether it
 * holds `migrationFile`, or null when the directory is missing. A symbolic
 * link is listed, not followed: a migration tool would apply it, so the check
 * has to see it.
 */
export function migrationDirsUnder(
  root: string,
  migrationsDir: string,
  migrationFile: string,
): ReturnType<ISquawkDeps['migrations']> {
  const dir = join(root, ...migrationsDir.split('/'));
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      hasSql: existsSync(join(dir, entry.name, migrationFile)),
      symlink: entry.isSymbolicLink(),
    }));
}

/** `runSquawk`'s deps on this machine: the migration folders, the files, PATH and the container CLI. */
export function nodeSquawkDeps(options: INodeRunOptions = {}): ISquawkDeps {
  return { ...nodeCapturedDeps(options), migrations: migrationDirsUnder, read: readRepoFile };
}

/** Run without blocking the event loop, with the output captured. */
function runAsync(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
): Promise<ISpawned> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) =>
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` }),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `scanImages`'s deps on this machine. A caller that must remove what a run
 * started on an interrupt passes its own `run` and `containerName` over these.
 */
export function nodeTrivyScanDeps(options: INodeRunOptions = {}): ITrivyScanDeps {
  const docker = options.docker ?? DOCKER_COMMAND;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return {
    nativeVersion: (tool) => reportedVersion(tool.name, tool.versionArgs),
    dockerAvailable: () => dockerAvailable(docker),
    dockerCommand: docker,
    run: runAsync,
    writeFile: (path, text) => writeFileSync(path, text),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    join,
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    env: process.env,
    // On POSIX the container runs as this user, so the cache it writes can be removed afterwards.
    dockerUser:
      uid === undefined || gid === undefined ? [] : ['--user', `${String(uid)}:${String(gid)}`],
  };
}

/** `runGitleaks`'s deps for the checkout at `root`, calling the same container CLI as `nodeRunDeps`. */
export function nodeGitleaksDeps(root: string, options: INodeRunOptions = {}): IGitleaksRunDeps {
  const docker = options.docker ?? DOCKER_COMMAND;
  return {
    nativeVersion: () => reportedVersion('gitleaks', ['version']),
    dockerAvailable: () => dockerAvailable(docker),
    dockerCommand: docker,
    gitDirIsLocal: () => {
      try {
        return statSync(join(root, '.git')).isDirectory();
      } catch {
        return false;
      }
    },
    spawn: spawnShown,
  };
}

export interface INodeFetchOptions {
  /**
   * Download a release path under https://github.com/. The caller supplies it:
   * this package makes no network calls of its own, so the one that fetches
   * stays in the consuming repo, where its origin and timeout are reviewed.
   */
  readonly download: (path: string) => Promise<Uint8Array>;
  /** Keeps the staging names of two concurrent runs apart. Defaults to the process id. */
  readonly token?: string;
}

/**
 * `fetchPinned`'s deps on a linux machine around the caller's `download`:
 * sha256 from node:crypto, `tar -xzf` for archives, and `placeBinary` for an
 * asset that is the binary itself.
 */
export function nodeFetchDeps(options: INodeFetchOptions): IFetchDeps {
  const token = options.token ?? String(process.pid);
  return {
    download: options.download,
    sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    unpack(bytes, member, dir) {
      const work = mkdtempSync(join(tmpdir(), 'pinned-tool-'));
      try {
        const archive = join(work, 'archive.tar.gz');
        writeFileSync(archive, bytes);
        const tar = spawnSync('tar', ['-xzf', archive, '-C', work, member], { encoding: 'utf8' });
        if (tar.error !== undefined || tar.status !== 0) {
          throw new Error(`tar could not unpack ${member}: ${tar.stderr}`);
        }
        const binary = join(dir, basename(member));
        renameSync(join(work, member), binary);
        chmodSync(binary, 0o755);
        return binary;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    place: (bytes, name, dir) => placeBinary(bytes, name, dir, token),
    versionOf: (binary, tool) => reportedVersion(binary, tool.versionArgs),
  };
}
