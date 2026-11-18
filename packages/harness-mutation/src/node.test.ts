import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, it } from 'bun:test';

import {
  COULD_NOT_START,
  finishVerdict,
  installedFrom,
  nodeMutationDeps,
  spawnStryker,
  strykerBin,
} from './node.js';

/*
 * The real I/O, against a temp directory with a fake `@stryker-mutator/core`:
 * its bin is a small script, so no test starts a real Stryker.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mutation-')));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function tempDir(): string {
  counter += 1;
  const dir = join(scratch, String(counter));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A package whose node_modules holds a fake Stryker core whose bin runs `script`. */
function packageWithStryker(script: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture", "private": true }\n');
  const core = join(dir, 'node_modules', '@stryker-mutator', 'core');
  mkdirSync(join(core, 'bin'), { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    '{ "name": "@stryker-mutator/core", "version": "10.0.0" }\n',
  );
  writeFileSync(join(core, 'bin', 'stryker.js'), script);
  return dir;
}

const ECHO_ARGS = [
  "process.stdout.write('args ' + process.argv.slice(2).join(' ') + '\\n');",
  "process.stderr.write('cwd ' + process.cwd() + '\\n');",
  'process.exitCode = 3;',
  '',
].join('\n');

describe('finishVerdict', () => {
  it('prints the details indented, then the verdict line, with the exit code of the status', () => {
    assert.deepEqual(
      finishVerdict('mutation-lib', {
        status: 'failed',
        reason: 'two\n  lines',
        details: ['src/a.ts:2 survived', 'src/b.ts:4 survived'],
      }),
      {
        lines: [
          '  - src/a.ts:2 survived',
          '  - src/b.ts:4 survived',
          'mutation-lib: failed (two lines)',
        ],
        exitCode: 1,
      },
    );
    assert.deepEqual(finishVerdict('m', { status: 'passed', reason: 'ok' }), {
      lines: ['m: passed (ok)'],
      exitCode: 0,
    });
    assert.equal(finishVerdict('m', { status: 'blocked', reason: 'x' }).exitCode, 2);
  });
});

describe('installedFrom and strykerBin', () => {
  it('resolve from the package directory, the way Stryker loads its plugins', () => {
    const dir = packageWithStryker(ECHO_ARGS);
    assert.equal(installedFrom(dir)('@stryker-mutator/core'), true);
    assert.equal(installedFrom(dir)('@stryker-mutator/no-such-runner'), false);
    assert.equal(
      strykerBin(dir),
      join(dir, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js'),
    );
  });

  it('find nothing in a package without Stryker', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{}\n');
    assert.equal(strykerBin(dir), null);
  });
});

describe('spawnStryker', () => {
  it('captures what the bin printed and hands back its exit code', async () => {
    const dir = packageWithStryker(ECHO_ARGS);
    const bin = strykerBin(dir);
    assert.ok(bin !== null);
    const result = await spawnStryker(bin, ['run', 'stryker.config.mjs'], dir, true);
    assert.equal(result.exitCode, 3);
    assert.match(result.output ?? '', /^args run stryker\.config\.mjs$/mu);
    assert.match(result.output ?? '', /^cwd /mu);
  });

  it('streams instead of capturing when asked to', async () => {
    const dir = packageWithStryker('process.exitCode = 0;\n');
    const bin = strykerBin(dir);
    assert.ok(bin !== null);
    assert.deepEqual(await spawnStryker(bin, ['run'], dir, false), { exitCode: 0, output: null });
  });

  it('reads a child that a signal ended as 128 plus the signal', async () => {
    if (process.platform === 'win32') return; // Windows has no POSIX signals to end a child with.
    const dir = packageWithStryker(
      "process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n",
    );
    const bin = strykerBin(dir);
    assert.ok(bin !== null);
    assert.equal((await spawnStryker(bin, [], dir, true)).exitCode, 143);
  });

  it('reads a cwd that does not exist as could not start', async () => {
    const result = await spawnStryker('bin.js', [], join(scratch, 'no', 'such', 'dir'), true);
    assert.equal(result.exitCode, COULD_NOT_START);
  });
});

describe('nodeMutationDeps', () => {
  it('reads, writes (creating directories) and removes files', () => {
    const dir = tempDir();
    const deps = nodeMutationDeps(dir, { log: () => {} });
    const file = join(dir, 'a', 'b', 'c.json');
    assert.equal(deps.root, dir);
    assert.equal(deps.readFile(file), null);
    deps.writeFile(file, '{}\n');
    assert.equal(deps.readFile(file), '{}\n');
    deps.removeFile(file);
    assert.equal(deps.readFile(file), null);
    deps.removeFile(file); // not there: not an error
    assert.equal(typeof deps.now(), 'number');
    assert.equal(deps.installed(dir)('@stryker-mutator/core'), false);
  });

  it('loads a config module through a dynamic import', async () => {
    const dir = tempDir();
    const config = join(dir, 'stryker.config.mjs');
    writeFileSync(config, "export default { testRunner: 'command' };\n");
    const module = (await nodeMutationDeps(dir).loadConfig(config)) as {
      default: { testRunner: string };
    };
    assert.equal(module.default.testRunner, 'command');
  });

  it('runs git at the root, with its status and output', () => {
    const deps = nodeMutationDeps(tempDir());
    const version = deps.git(['--version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout ?? '', /^git version /u);
    assert.notEqual(deps.git(['no-such-subcommand-here']).status, 0);
  });

  it('runs the Stryker the package resolves, and prints captured output once it ended', async () => {
    const dir = packageWithStryker(ECHO_ARGS);
    const written: string[] = [];
    const deps = nodeMutationDeps(dir, { log: () => {}, write: (text) => written.push(text) });
    const result = await deps.stryker(dir, ['run', 'x.json'], true);
    assert.equal(result.exitCode, 3);
    assert.deepEqual(written, [result.output]);
  });

  it('reads a Stryker that does not resolve, or noStryker, as could not start', async () => {
    const logged: string[] = [];
    const bare = tempDir();
    writeFileSync(join(bare, 'package.json'), '{}\n');
    const missing = await nodeMutationDeps(bare, { log: (line) => logged.push(line) }).stryker(
      bare,
      ['run'],
      false,
    );
    assert.deepEqual(missing, { exitCode: COULD_NOT_START, output: null });
    assert.match(logged[0] ?? '', /@stryker-mutator\/core does not resolve/u);

    const dir = packageWithStryker(ECHO_ARGS);
    const off = await nodeMutationDeps(dir, {
      noStryker: true,
      log: (line) => logged.push(line),
    }).stryker(dir, ['run'], true);
    assert.deepEqual(off, { exitCode: COULD_NOT_START, output: null });
    assert.equal(logged[1], 'Stryker not started: noStryker is set');
  });
});
