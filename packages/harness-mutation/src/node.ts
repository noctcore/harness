import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { IMutationDeps, IStrykerExit } from './run.js';
import { exitCodeFor, type IMutationVerdict, verdictLine } from './verdict.js';

/*
 * The real I/O behind runMutation: files, a dynamic import of the Stryker
 * config, git at the repo root, and Stryker itself, resolved from the target
 * package the way Stryker resolves its own plugins. Stryker is a peer
 * dependency: nothing here imports it, the run spawns its bin with the Node
 * that runs this.
 */

/** The exit code verdict.ts reads as "Stryker could not be started". */
export const COULD_NOT_START = 127;

/** Room for the zero-context diff of a large change; past it git's status is non-zero and the run is blocked. */
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface INodeMutationOptions {
  /**
   * Stop where Stryker would start: the run then reads as one that could not
   * start, which is blocked. A test of a consumer's CLI passes it so a broken
   * refusal can never begin a run of many minutes; it can turn a verdict into
   * "proved nothing" and never into a pass.
   */
  readonly noStryker?: boolean;
  /** Where log lines go. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
  /** Where captured Stryker output is written once the run ended. Defaults to stdout. */
  readonly write?: (text: string) => void;
}

/** Whether `name` resolves from `packageDir`, the way Stryker loads its plugins from its cwd. */
export function installedFrom(packageDir: string): (name: string) => boolean {
  const require = createRequire(join(packageDir, 'package.json'));
  return (name) => {
    try {
      require.resolve(`${name}/package.json`);
      return true;
    } catch {
      return false;
    }
  };
}

/** The Stryker bin `@stryker-mutator/core` installs for `packageDir`, or null when it does not resolve. */
export function strykerBin(packageDir: string): string | null {
  try {
    const manifest = createRequire(join(packageDir, 'package.json')).resolve(
      '@stryker-mutator/core/package.json',
    );
    return join(dirname(manifest), 'bin', 'stryker.js');
  } catch {
    return null;
  }
}

/** The exit code a shell gives a child that `signal` ended: 128 plus its number. */
function signalExit(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/**
 * Run the Stryker bin under the current Node with `cwd`, streaming or
 * capturing its output. SIGINT and SIGTERM sent to this process are passed on
 * to it, so an interrupted CI job ends Stryker as well, and the run reads as
 * ended by a signal (blocked), never as a result.
 */
export function spawnStryker(
  bin: string,
  args: readonly string[],
  cwd: string,
  capture: boolean,
): Promise<IStrykerExit> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    const chunks: string[] = [];
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => chunks.push(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => chunks.push(chunk));
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    let settled = false;
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolvePromise({ exitCode, output: capture ? chunks.join('') : null });
    };
    child.on('error', () => {
      settle(COULD_NOT_START);
    });
    child.on('close', (code, signal) => {
      settle(signal !== null ? signalExit(signal) : (code ?? COULD_NOT_START));
    });
  });
}

/** The real deps for the repository at `root` (absolute). */
export function nodeMutationDeps(root: string, options: INodeMutationOptions = {}): IMutationDeps {
  const log = options.log ?? ((line: string) => console.log(line));
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  return {
    root,
    loadConfig: (file) => import(pathToFileURL(file).href),
    installed: installedFrom,
    readFile: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    writeFile: (file, text) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    },
    removeFile: (file) => {
      rmSync(file, { force: true });
    },
    stryker: async (packageDir, args, capture) => {
      if (options.noStryker === true) {
        log('Stryker not started: noStryker is set');
        return { exitCode: COULD_NOT_START, output: null };
      }
      const bin = strykerBin(packageDir);
      if (bin === null) {
        log(`Stryker not started: @stryker-mutator/core does not resolve from ${packageDir}`);
        return { exitCode: COULD_NOT_START, output: null };
      }
      const result = await spawnStryker(bin, args, packageDir, capture);
      // A changed-line run is seconds: its output is shown once it has ended.
      if (result.output !== null) write(result.output);
      return result;
    },
    git: (args) => {
      const result = spawnSync('git', [...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: GIT_OUTPUT_LIMIT,
        windowsHide: true,
      });
      // spawnSync gives no output at all (not an empty string) for a git it could not start.
      return {
        status: result.status ?? 1,
        stdout: typeof result.stdout === 'string' ? result.stdout : null,
      };
    },
    now: () => Date.now(),
    log,
  };
}

export interface IFinishedVerdict {
  /** The verdict's detail lines (indented), then its verdict line. */
  readonly lines: readonly string[];
  /** 0 passed, 1 failed, 2 blocked. */
  readonly exitCode: number;
}

/**
 * How a run leaves the process: its last lines, then its exit code. Print the
 * lines and set `process.exitCode`; do not call `process.exit`, which can cut
 * off output still in a pipe (the verdict line included).
 */
export function finishVerdict(checkId: string, verdict: IMutationVerdict): IFinishedVerdict {
  return {
    lines: [
      ...(verdict.details ?? []).map((detail) => `  - ${detail}`),
      verdictLine(checkId, verdict),
    ],
    exitCode: exitCodeFor(verdict.status),
  };
}
