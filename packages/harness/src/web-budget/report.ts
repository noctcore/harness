import {
  checkBudgets,
  type IBudgetViolation,
  type IRouteBudget,
  matchesPattern,
  parseWebBudgets,
} from './budgets.js';
import { findDeadImports, type IDeadImport, type IDeadImportAllow } from './dead-imports.js';
import { buildGraph, type IBuildGraph, type IRouteWeight, type SizeOf } from './graph.js';
import type { IViteManifest } from './manifest.js';

/*
 * One call that runs every web budget check, plus a deterministic Markdown
 * report a repo commits next to its budgets, so a reviewer sees the weight a
 * change adds. `reportIsFresh` is the gate that keeps the committed report in
 * step with the build.
 */

export interface IWebBudgetInput {
  readonly manifest: IViteManifest;
  readonly sizeOf: SizeOf;
  /** The parsed budgets file. Checked with `parseWebBudgets`; an invalid value throws. */
  readonly budgets: unknown;
  /** Manifest keys of the shell's entry chunks. Defaults to every `isEntry` chunk. */
  readonly shellEntries?: readonly string[];
  /** Count referenced assets (images, fonts) in a route's weight. Defaults to false. */
  readonly includeAssets?: boolean;
  /** Dead dynamic imports that stay, each with a written reason. */
  readonly allowDeadImports?: readonly IDeadImportAllow[];
  /** How sizes were measured, shown in the report (`gzip`, `brotli`, `raw`). Defaults to `gzip`. */
  readonly measure?: string;
}

export interface IFileRow {
  readonly file: string;
  readonly pattern: string;
  readonly bytes: number;
  readonly max: number;
}

export interface IRouteRow extends IRouteWeight {
  readonly coldLimit?: number;
  readonly beyondShellLimit?: number;
}

export interface IWebBudgetResult {
  readonly passed: boolean;
  readonly graph: IBuildGraph;
  readonly shell: { readonly bytes: number; readonly limit?: number };
  readonly routes: readonly IRouteRow[];
  readonly files: readonly IFileRow[];
  readonly violations: readonly IBudgetViolation[];
  readonly deadImports: readonly IDeadImport[];
  readonly allowedDeadImports: readonly (IDeadImport & { readonly reason: string })[];
  /** Manifest, graph and allow-list problems. Each fails the check. */
  readonly problems: readonly string[];
  /** The Markdown report (`formatWebBudgetReport`). */
  readonly report: string;
}

/** Bytes as KiB with one decimal, the bytes kept so a diff shows the real change. */
export function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB (${bytes} B)`;
}

function headroom(actual: number, limit: number | undefined): string {
  if (limit === undefined) return '';
  const left = limit - actual;
  return left >= 0 ? `${left} B left` : `**${-left} B over**`;
}

function cell(limit: number | undefined): string {
  return limit === undefined ? '' : formatBytes(limit);
}

/** Render the Markdown report. Deterministic: rows are sorted and nothing depends on the clock. */
export function formatWebBudgetReport(
  result: Omit<IWebBudgetResult, 'report' | 'graph'>,
  measure = 'gzip',
): string {
  const lines = [
    '# Web bundle budgets',
    '',
    `Sizes are ${measure} bytes. Generated from the build manifest: do not edit by hand.`,
    '',
    `Status: ${result.passed ? 'passed' : 'failed'}`,
    '',
    '## Shell',
    '',
    '| Weight | Budget | Headroom |',
    '|---|---|---|',
    `| ${formatBytes(result.shell.bytes)} | ${cell(result.shell.limit)} | ${headroom(result.shell.bytes, result.shell.limit)} |`,
    '',
    '## Routes',
    '',
  ];
  if (result.routes.length === 0) {
    lines.push('No route budget.');
  } else {
    lines.push(
      '| Route | Cold | Cold budget | Beyond shell | Beyond shell budget | Headroom |',
      '|---|---|---|---|---|---|',
    );
    for (const row of result.routes) {
      const room = [
        headroom(row.cold, row.coldLimit),
        headroom(row.beyondShell, row.beyondShellLimit),
      ]
        .filter((part) => part !== '')
        .join(', ');
      lines.push(
        `| \`${row.key}\` | ${formatBytes(row.cold)} | ${cell(row.coldLimit)} | ${formatBytes(row.beyondShell)} | ${cell(row.beyondShellLimit)} | ${room} |`,
      );
    }
  }
  lines.push('', '## Files', '');
  if (result.files.length === 0) {
    lines.push('No file budget matched a built file.');
  } else {
    lines.push('| File | Pattern | Weight | Budget | Headroom |', '|---|---|---|---|---|');
    for (const row of result.files) {
      lines.push(
        `| \`${row.file}\` | \`${row.pattern}\` | ${formatBytes(row.bytes)} | ${formatBytes(row.max)} | ${headroom(row.bytes, row.max)} |`,
      );
    }
  }
  lines.push('', '## Dead dynamic imports', '');
  if (result.deadImports.length === 0 && result.allowedDeadImports.length === 0) {
    lines.push('None.');
  } else {
    for (const item of result.deadImports) lines.push(`- ${item.kind}: ${item.message}`);
    for (const item of result.allowedDeadImports) {
      lines.push(`- allowed (${item.reason}): \`${item.importer}\` -> \`${item.target}\``);
    }
  }
  if (result.violations.length > 0 || result.problems.length > 0) {
    lines.push('', '## Failures', '');
    for (const violation of result.violations) lines.push(`- ${violation.message}`);
    for (const problem of result.problems) lines.push(`- ${problem}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Run every check: read the graph, compare it to the budgets, find dead
 * imports, render the report. `passed` is false on any violation, dead
 * import or problem. An invalid budgets value throws.
 */
export function checkWebBudget(input: IWebBudgetInput): IWebBudgetResult {
  const budgets = parseWebBudgets(input.budgets);
  const graph = buildGraph(input.manifest, input.sizeOf, {
    ...(input.shellEntries === undefined ? {} : { shellEntries: input.shellEntries }),
    ...(input.includeAssets === undefined ? {} : { includeAssets: input.includeAssets }),
  });
  const violations = checkBudgets(graph, budgets);
  const dead = findDeadImports(graph, { allow: input.allowDeadImports ?? [] });
  const problems = [...input.manifest.problems, ...graph.problems, ...dead.problems];

  const routes: IRouteRow[] = [];
  const routeBudgets = budgets.routes ?? {};
  for (const key of Object.keys(routeBudgets).sort()) {
    const budget = routeBudgets[key] as IRouteBudget;
    const weight = graph.weightOf(key);
    if (weight === null) continue;
    routes.push({
      ...weight,
      ...(budget.cold === undefined ? {} : { coldLimit: budget.cold }),
      ...(budget.beyondShell === undefined ? {} : { beyondShellLimit: budget.beyondShell }),
    });
  }
  const files: IFileRow[] = [];
  const built = [...graph.sizes.keys()].sort();
  for (const { pattern, max } of budgets.files ?? []) {
    for (const file of built) {
      if (matchesPattern(pattern, file)) {
        files.push({ file, pattern, bytes: graph.sizes.get(file) as number, max });
      }
    }
  }

  const partial = {
    passed: violations.length === 0 && dead.dead.length === 0 && problems.length === 0,
    shell: {
      bytes: graph.shell.bytes,
      ...(budgets.shell === undefined ? {} : { limit: budgets.shell }),
    },
    routes,
    files,
    violations,
    deadImports: dead.dead,
    allowedDeadImports: dead.allowed,
    problems,
  };
  return { ...partial, graph, report: formatWebBudgetReport(partial, input.measure ?? 'gzip') };
}

/** Console lines for a result: one per failure, then a summary that says what to do next. */
export function formatWebBudgetSummary(result: IWebBudgetResult, label = 'web-budget'): string[] {
  const lines = [
    ...result.violations.map((violation) => `✗ ${violation.message}`),
    ...result.deadImports.map((item) => `✗ ${item.message}`),
    ...result.problems.map((problem) => `✗ ${problem}`),
  ];
  const failures = lines.length;
  lines.push(
    failures === 0
      ? `${label}: passed (shell ${formatBytes(result.shell.bytes)}, ${result.routes.length} route budgets, ${result.files.length} budgeted files)`
      : `${label}: failed (${failures} problem${failures === 1 ? '' : 's'}). Shrink what grew; raise a budget only in a reviewed change that says why.`,
  );
  return lines;
}

export interface IFreshness {
  readonly fresh: boolean;
  readonly message: string;
}

/**
 * Whether the committed report matches the one just rendered. Line endings
 * are normalized first, so a checkout with CRLF endings is still fresh. A
 * missing committed report (null) is stale.
 */
export function reportIsFresh(
  committed: string | null,
  rendered: string,
  options: { readonly path?: string; readonly regenerate?: string } = {},
): IFreshness {
  const path = options.path ?? 'the web budget report';
  const how = options.regenerate === undefined ? 'regenerate it' : `run \`${options.regenerate}\``;
  if (committed === null) {
    return { fresh: false, message: `${path} is missing: ${how} and commit the result` };
  }
  const normalize = (text: string): string => text.replaceAll('\r\n', '\n');
  if (normalize(committed) === normalize(rendered)) {
    return { fresh: true, message: `${path} is up to date` };
  }
  return {
    fresh: false,
    message: `${path} is out of date with the build: ${how} and commit the result`,
  };
}
