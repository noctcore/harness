/*
 * The one way a budget script runs: load the build, hand it to the check,
 * print what it measured, and return 1 with the reasons when it fails or when
 * there is no fresh build to measure. A repo's script holds the limits and the
 * paths and calls this; the decisions are in the modules next to this file.
 */
import { checkHeadroom, type IBudgetReport } from './report.js';
import type { IWebBuild } from './web-build.js';

export interface IBudgetIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * `--headroom <percent>` from a script's arguments, or undefined without the
 * flag. With it, a budget also prints the limits that headroom over today's
 * weight gives; it never changes a limit. Throws on a value that is not a
 * percentage.
 */
export function headroomFromArgv(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--headroom');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '') {
    throw new Error(`--headroom ${value ?? ''} is not a percentage`);
  }
  return checkHeadroom(Number(value));
}

/**
 * Run one budget and return its exit code: 0 when it passes, 1 when it fails
 * or could not run (no build, a stale one, a bad budget). Every line is
 * prefixed with `[name]`, failures go to `err`.
 */
export function runBudget(
  name: string,
  io: IBudgetIo,
  load: () => IWebBuild,
  check: (build: IWebBuild) => IBudgetReport,
): number {
  let report: IBudgetReport;
  let encoding: string;
  try {
    const build = load();
    encoding = build.encoding;
    report = check(build);
  } catch (error) {
    io.err(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  io.out(`[${name}] weighed as served: ${encoding}`);
  for (const line of report.lines) io.out(`[${name}] ${line}`);
  for (const problem of report.problems) io.err(`[${name}] FAILED ${problem}`);
  if (report.problems.length > 0) return 1;
  io.out(`[${name}] OK`);
  return 0;
}
