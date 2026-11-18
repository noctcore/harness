import type { IBuildGraph } from './graph.js';
import { isPlainObject, toPosix } from './manifest.js';

/*
 * Budgets are the consumer's file, read here and never written: nothing in
 * this module raises a limit, adds a tolerance or skips a route. A budget that
 * is too tight is raised by editing that file, in a reviewed change that says
 * why. A budget naming a route or file the build no longer has is stale and
 * fails, so the file cannot quietly drift from the app.
 */

export interface IRouteBudget {
  /** Most bytes the route's static closure may weigh (a cold visit). */
  readonly cold?: number;
  /** Most bytes the route may add on top of the shell. */
  readonly beyondShell?: number;
}

export interface IFileBudget {
  /** A glob over built file paths (`assets/*.js`, `**\/*.css`): `*` within a segment, `**` across segments. */
  readonly pattern: string;
  /** Most bytes any one matching file may weigh. */
  readonly max: number;
}

export interface IWebBudgets {
  /** Most bytes the shell (every entry chunk's static closure) may weigh. */
  readonly shell?: number;
  /** Per route, keyed by its manifest key (`src/routes/settings.tsx`). */
  readonly routes?: Readonly<Record<string, IRouteBudget>>;
  readonly files?: readonly IFileBudget[];
}

export type BudgetViolationKind =
  'shell' | 'route-cold' | 'route-beyond-shell' | 'file' | 'stale-route' | 'stale-file';

export interface IBudgetViolation {
  readonly kind: BudgetViolationKind;
  /** The route key, file path or pattern the violation is about. */
  readonly subject: string;
  readonly actual?: number;
  readonly limit?: number;
  readonly overBy?: number;
  readonly message: string;
}

function checkLimit(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `web budgets: ${where} must be a positive number of bytes, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Check a budgets value (parsed from your budgets file) and return it typed.
 * A limit that is zero, negative or not a number, a route with no limit, a
 * file budget without a pattern, or an unknown top-level key throws: a budget
 * that cannot be read must stop the run, not pass it.
 */
export function parseWebBudgets(raw: unknown): IWebBudgets {
  if (!isPlainObject(raw)) throw new Error('web budgets: the budgets must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (key !== 'shell' && key !== 'routes' && key !== 'files' && !key.startsWith('$')) {
      throw new Error(
        `web budgets: unknown key "${key}" (expected shell, routes, files, or a $-prefixed note)`,
      );
    }
  }
  const out: { shell?: number; routes?: Record<string, IRouteBudget>; files?: IFileBudget[] } = {};
  if (raw.shell !== undefined) out.shell = checkLimit(raw.shell, 'shell');
  if (raw.routes !== undefined) {
    if (!isPlainObject(raw.routes)) throw new Error('web budgets: routes must be an object');
    const routes: Record<string, IRouteBudget> = {};
    for (const [key, value] of Object.entries(raw.routes)) {
      if (!isPlainObject(value)) throw new Error(`web budgets: routes["${key}"] must be an object`);
      if (value.cold === undefined && value.beyondShell === undefined) {
        throw new Error(`web budgets: routes["${key}"] sets no limit (cold or beyondShell)`);
      }
      routes[toPosix(key)] = {
        ...(value.cold === undefined
          ? {}
          : { cold: checkLimit(value.cold, `routes["${key}"].cold`) }),
        ...(value.beyondShell === undefined
          ? {}
          : { beyondShell: checkLimit(value.beyondShell, `routes["${key}"].beyondShell`) }),
      };
    }
    out.routes = routes;
  }
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) throw new Error('web budgets: files must be a list');
    out.files = raw.files.map((value: unknown, index) => {
      if (!isPlainObject(value) || typeof value.pattern !== 'string' || value.pattern === '') {
        throw new Error(`web budgets: files[${index}] needs a non-empty "pattern" string`);
      }
      return { pattern: toPosix(value.pattern), max: checkLimit(value.max, `files[${index}].max`) };
    });
  }
  return out;
}

/** Whether one path segment matches one pattern segment (`*` any run, `?` one char). Linear in practice. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Whether a built path matches a budget pattern. `*` and `?` stay inside a
 * segment; a `**` segment matches any number of segments, none included. No
 * regex is built from the pattern, so a long pattern cannot backtrack.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const ps = toPosix(pattern).split('/');
  const ts = toPosix(path).split('/');
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const id = i * (ts.length + 1) + j;
    const seen = memo.get(id);
    if (seen !== undefined) return seen;
    let result: boolean;
    if (i === ps.length) result = j === ts.length;
    else if (ps[i] === '**') result = go(i + 1, j) || (j < ts.length && go(i, j + 1));
    else
      result = j < ts.length && matchSegment(ps[i] as string, ts[j] as string) && go(i + 1, j + 1);
    memo.set(id, result);
    return result;
  };
  return go(0, 0);
}

function over(
  kind: BudgetViolationKind,
  subject: string,
  actual: number,
  limit: number,
  what: string,
): IBudgetViolation {
  return {
    kind,
    subject,
    actual,
    limit,
    overBy: actual - limit,
    message: `${what} is ${actual} bytes, ${actual - limit} over its ${limit} byte budget: shrink it, or raise the budget in a reviewed change that says why`,
  };
}

/** Every budget the build breaks, plus every stale budget. Throws on an invalid budgets value. */
export function checkBudgets(
  graph: IBuildGraph,
  budgets: IWebBudgets | unknown,
): IBudgetViolation[] {
  const parsed = parseWebBudgets(budgets);
  const violations: IBudgetViolation[] = [];
  if (parsed.shell !== undefined && graph.shell.bytes > parsed.shell) {
    violations.push(over('shell', 'shell', graph.shell.bytes, parsed.shell, 'the shell'));
  }
  for (const key of Object.keys(parsed.routes ?? {}).sort()) {
    const budget = (parsed.routes as Record<string, IRouteBudget>)[key] as IRouteBudget;
    const weight = graph.weightOf(key);
    if (weight === null) {
      violations.push({
        kind: 'stale-route',
        subject: key,
        message: `route "${key}" has a budget but is not in the manifest: fix the key or remove the budget`,
      });
      continue;
    }
    if (budget.cold !== undefined && weight.cold > budget.cold) {
      violations.push(over('route-cold', key, weight.cold, budget.cold, `route "${key}" (cold)`));
    }
    if (budget.beyondShell !== undefined && weight.beyondShell > budget.beyondShell) {
      violations.push(
        over(
          'route-beyond-shell',
          key,
          weight.beyondShell,
          budget.beyondShell,
          `route "${key}" (beyond the shell)`,
        ),
      );
    }
  }
  const files = [...graph.sizes.keys()].sort();
  for (const { pattern, max } of parsed.files ?? []) {
    const hits = files.filter((file) => matchesPattern(pattern, file));
    if (hits.length === 0) {
      violations.push({
        kind: 'stale-file',
        subject: pattern,
        message: `file budget "${pattern}" matches no built file: fix the pattern or remove the budget`,
      });
    }
    for (const file of hits) {
      const size = graph.sizes.get(file) as number;
      if (size > max)
        violations.push(over('file', file, size, max, `${file} (budget "${pattern}")`));
    }
  }
  return violations;
}
