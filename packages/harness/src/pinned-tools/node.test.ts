import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import {
  dockerAvailable,
  gitTrackedFiles,
  migrationDirsUnder,
  nodeCapturedDeps,
  nodeFetchDeps,
  nodeGitleaksDeps,
  nodeHadolintDeps,
  nodeRunDeps,
  nodeSquawkDeps,
  nodeTrivyScanDeps,
  readRepoFile,
  spawnCaptured,
  workflowFilesUnder,
} from './node.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-tools-node-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('workflowFilesUnder', () => {
  test('lists the yml and yaml workflows, sorted, repo-relative with / separators', () => {
    const root = tempDir();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    for (const name of ['b.yaml', 'a.yml', 'notes.md']) {
      writeFileSync(join(root, '.github', 'workflows', name), '');
    }
    expect(workflowFilesUnder(root)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/b.yaml',
    ]);
  });

  test('is empty when there is no workflow directory', () => {
    expect(workflowFilesUnder(tempDir())).toEqual([]);
  });
});

describe('nodeGitleaksDeps', () => {
  test('sees a .git directory as local history, and a worktree pointer file as not', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    expect(nodeGitleaksDeps(repo).gitDirIsLocal()).toBe(true);
    const worktree = tempDir();
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    expect(nodeGitleaksDeps(worktree).gitDirIsLocal()).toBe(false);
    expect(nodeGitleaksDeps(tempDir()).gitDirIsLocal()).toBe(false);
  });
});

describe('nodeRunDeps', () => {
  test('reports no native version for a tool that is not on PATH', () => {
    const missing = { name: 'no-such-pinned-tool-x', version: '1.0.0', versionArgs: ['--version'] };
    expect(nodeRunDeps().nativeVersion({ ...missing, linux: {} as never })).toBeNull();
  });

  test('reports a spawn that could not start as null', () => {
    expect(nodeRunDeps().spawn('no-such-pinned-tool-x', [], tempDir())).toBeNull();
  });
});

describe('nodeFetchDeps', () => {
  const noDownload = (): Promise<Uint8Array> => Promise.reject(new Error('no network in tests'));

  test("hands back the caller's download untouched", () => {
    expect(nodeFetchDeps({ download: noDownload }).download).toBe(noDownload);
  });

  test('hashes with sha256', () => {
    expect(nodeFetchDeps({ download: noDownload }).sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('places a bare binary executable under its name', () => {
    const dir = tempDir();
    const binary = nodeFetchDeps({ download: noDownload, token: 't' }).place(
      new Uint8Array([1]),
      'tool',
      dir,
    );
    expect(binary).toBe(join(dir, 'tool'));
  });

  test('refuses an archive member tar cannot find, and leaves nothing behind', () => {
    const dir = tempDir();
    expect(() =>
      nodeFetchDeps({ download: noDownload }).unpack(
        new Uint8Array([1, 2, 3]),
        'missing/tool',
        dir,
      ),
    ).toThrow(/tar could not unpack missing\/tool/u);
  });
});

describe('the Docker probes, through a CLI that does not exist', () => {
  // A command name nothing provides makes every probe fail to start, so these
  // run the real probes without ever reaching a daemon or a registry.
  const MISSING = 'no-such-container-cli-x';

  test('report no daemon, no local image and a failed pull, instead of throwing', () => {
    const deps = nodeRunDeps({ docker: MISSING });
    expect(dockerAvailable(MISSING)).toBe(false);
    expect(deps.dockerAvailable()).toBe(false);
    expect(deps.imagePresent('example.invalid/tool:1.0.0')).toBe(false);
    expect(deps.pull('example.invalid/tool:1.0.0')).toBe(false);
  });

  test('report the same through the captured deps, a platform pull included', () => {
    const deps = nodeCapturedDeps({ docker: MISSING });
    expect(deps.dockerCommand).toBe(MISSING);
    expect(deps.dockerAvailable()).toBe(false);
    expect(deps.imagePresent('example.invalid/tool:1.0.0')).toBe(false);
    expect(deps.pull('example.invalid/tool:1.0.0', 'linux/amd64')).toBe(false);
    expect(nodeHadolintDeps({ docker: MISSING }).dockerCommand).toBe(MISSING);
    expect(nodeSquawkDeps({ docker: MISSING }).dockerCommand).toBe(MISSING);
    expect(nodeTrivyScanDeps({ docker: MISSING }).dockerAvailable()).toBe(false);
    expect(nodeCapturedDeps().dockerCommand).toBe('docker');
  });

  test('thread the one command into both the run deps and the gitleaks deps', () => {
    expect(nodeRunDeps({ docker: MISSING }).dockerCommand).toBe(MISSING);
    expect(nodeRunDeps().dockerCommand).toBe('docker');
    const gitleaks = nodeGitleaksDeps('.', { docker: MISSING });
    expect(gitleaks.dockerCommand).toBe(MISSING);
    expect(gitleaks.dockerAvailable()).toBe(false);
  });
});

describe('nodeFetchDeps on a real archive', () => {
  test('unpacks the member into the directory as an executable, and reads its version', () => {
    const work = tempDir();
    mkdirSync(join(work, 'pkg'));
    writeFileSync(join(work, 'pkg', 'tool'), 'not really a binary');
    const archive = join(work, 'tool.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', work, 'pkg/tool']);
    expect(tar.status).toBe(0);

    const dir = tempDir();
    const deps = nodeFetchDeps({ download: () => Promise.reject(new Error('unused')) });
    const binary = deps.unpack(new Uint8Array(readFileSync(archive)), 'pkg/tool', dir);
    expect(binary).toBe(join(dir, 'tool'));
    expect(readFileSync(binary, 'utf8')).toBe('not really a binary');

    // Any executable that prints an x.y.z for --version stands in for a tool.
    const runtime = { name: 'runtime', version: '0.0.0', versionArgs: ['--version'] };
    expect(deps.versionOf(process.execPath, { ...runtime, linux: {} as never })).toMatch(
      /^\d+\.\d+\.\d+$/u,
    );
  });
});

describe('the captured run deps', () => {
  test('capture what a command prints, and report one that could not start as null', () => {
    const ran = spawnCaptured(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err")'],
      tempDir(),
    );
    expect(ran).toEqual({ code: 0, stdout: 'out\n', stderr: 'err\n' });
    expect(spawnCaptured('no-such-pinned-tool-x', [], tempDir()).code).toBeNull();
    const missing = { name: 'no-such-pinned-tool-x', version: '1.0.0', versionArgs: ['--version'] };
    expect(nodeCapturedDeps().nativeVersion({ ...missing, linux: {} as never })).toBeNull();
  });

  test('read a repo-relative file, and nothing for a directory or a missing file', () => {
    const root = tempDir();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c.txt'), 'text');
    expect(readRepoFile(root, 'a/b/c.txt')).toBe('text');
    expect(readRepoFile(root, 'a/b')).toBeNull();
    expect(readRepoFile(root, 'a/missing.txt')).toBeNull();
    const deps = nodeHadolintDeps();
    expect(deps.read(root, 'a/b/c.txt')).toBe('text');
  });

  test("list git's tracked files with / separators, and nothing outside a repository", () => {
    const root = tempDir();
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    mkdirSync(join(root, 'svc'));
    writeFileSync(join(root, 'svc', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(root, 'untracked.txt'), '');
    expect(git('add', 'svc/Dockerfile').status).toBe(0);
    expect(gitTrackedFiles(root)).toEqual(['svc/Dockerfile']);
    expect(nodeHadolintDeps().tracked(root)).toEqual(['svc/Dockerfile']);
    expect(gitTrackedFiles(join(root, 'missing'))).toBeNull();
  });
});

describe('migrationDirsUnder', () => {
  test('lists every folder, whether it holds the migration file, and a link as a link', () => {
    const root = tempDir();
    const dir = join(root, 'db', 'migrations');
    mkdirSync(join(dir, '1_a'), { recursive: true });
    mkdirSync(join(dir, '2_b'));
    writeFileSync(join(dir, '1_a', 'migration.sql'), 'SELECT 1;\n');
    writeFileSync(join(dir, 'README.md'), '');
    const linked = process.platform !== 'win32';
    if (linked) symlinkSync(join(dir, '1_a'), join(dir, '3_link'));
    const found = [...(migrationDirsUnder(root, 'db/migrations', 'migration.sql') ?? [])].sort(
      (x, y) => x.name.localeCompare(y.name),
    );
    expect(found).toEqual([
      { name: '1_a', hasSql: true, symlink: false },
      { name: '2_b', hasSql: false, symlink: false },
      ...(linked ? [{ name: '3_link', hasSql: true, symlink: true }] : []),
    ]);
    expect(
      nodeSquawkDeps()
        .migrations(root, 'db/migrations', 'up.sql')
        ?.every((d) => !d.hasSql),
    ).toBe(true);
  });

  test('is null when the directory is missing', () => {
    expect(migrationDirsUnder(tempDir(), 'db/migrations', 'migration.sql')).toBeNull();
  });
});

describe('nodeTrivyScanDeps', () => {
  test('runs a command without blocking, capturing its output, with the environment it is given', async () => {
    const deps = nodeTrivyScanDeps();
    const ran = await deps.run(
      process.execPath,
      ['-e', 'console.log(process.env.ONLY_THIS ?? "none"); console.error("e"); process.exit(3)'],
      { cwd: tempDir(), env: { ...process.env, ONLY_THIS: 'yes' } as Record<string, string> },
    );
    expect(ran).toEqual({ code: 3, stdout: 'yes\n', stderr: 'e\n' });
    const inherited = await deps.run(process.execPath, ['-e', 'console.log("ok")'], {
      cwd: tempDir(),
    });
    expect(inherited.stdout).toBe('ok\n');
    const missing = await deps.run('no-such-pinned-tool-x', [], { cwd: tempDir() });
    expect(missing.code).toBeNull();
  });

  test('writes, makes and removes in the work directory, and hands out random bytes', () => {
    const deps = nodeTrivyScanDeps();
    const work = tempDir();
    deps.mkdir(deps.join(work, 'cache', 'deep'));
    deps.writeFile(deps.join(work, 'cache', 'deep', 'f'), 'x');
    expect(readFileSync(join(work, 'cache', 'deep', 'f'), 'utf8')).toBe('x');
    deps.remove(deps.join(work, 'cache'));
    expect(existsSync(join(work, 'cache'))).toBe(false);
    expect(deps.randomBytes(27)).toHaveLength(27);
    expect(deps.env).toBe(process.env);
    if (process.platform === 'win32') expect(deps.dockerUser).toEqual([]);
    else expect(deps.dockerUser?.[0]).toBe('--user');
  });
});
