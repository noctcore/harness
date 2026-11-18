/*
 * File budgets: each entry is a set of files of the build and a ceiling on
 * their summed weight as served. An entry names its files one of two ways.
 *
 * `path` is a file pattern, for a set a file name really defines: every
 * script, every stylesheet.
 *
 * `route` is a list of route modules, for a route's OWN chunks. A file name
 * cannot say those: the bundler names a chunk after whichever module it was
 * made for, and folds one chunk into another when the graph changes. They are
 * taken from the build graph instead (`ownChunks`).
 */
import {
  chunksOfSource,
  type IBuildGraph,
  isRecord,
  loadRoots,
  staticClosure,
  toPosix,
} from './build-graph.js';
import { asKb, atHeadroom, BYTES_PER_KB, checkHeadroom, type IBudgetReport } from './report.js';

export interface IFileBudget {
  /** What the entry measures, in words. */
  readonly name: string;
  /** Files of the build, relative to the build directory: `assets/*.js`. Set when `route` is not. */
  readonly path?: string;
  /** Route modules, as the manifest names them: `src/routes/settings.tsx`. Set when `path` is not. */
  readonly route?: readonly string[];
  readonly limitBytes: number;
}

const LIMIT = /^(\d+(?:\.\d+)?) kB$/u;

/**
 * The budgets a budgets file declares: a JSON list of `{ name, path | route,
 * limit: "<number> kB" }`. Throws on an entry it cannot hold a build to: no
 * name, both or neither of `path` and `route`, a limit in another form or of
 * zero, or an option this check does not read (a tolerance, a compression
 * switch). The file is read, never written.
 */
export function parseFileBudgets(json: string): IFileBudget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`the budget file is not JSON (${(error as Error).message})`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('the budget file is not a list of entries');
  }
  return parsed.map((entry: unknown, index) => {
    if (!isRecord(entry)) throw new Error(`budget ${index + 1} is not an object`);
    const { name, path, route, limit, ...rest } = entry;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`budget ${index + 1} has no name`);
    }
    const hasPath = typeof path === 'string' && path !== '';
    const hasRoute =
      Array.isArray(route) &&
      route.length > 0 &&
      route.every((source): source is string => typeof source === 'string' && source !== '');
    if (hasPath === hasRoute) {
      throw new Error(
        `budget ${index + 1} needs a path (a file pattern) or a route (a list of route modules), and only one`,
      );
    }
    const match = typeof limit === 'string' ? LIMIT.exec(limit) : null;
    const limitBytes = match === null ? 0 : Math.round(Number(match[1]) * BYTES_PER_KB);
    if (limitBytes <= 0) {
      throw new Error(
        `budget ${index + 1} has the limit ${JSON.stringify(limit)}, expected "<number> kB" above zero`,
      );
    }
    const unknown = Object.keys(rest);
    if (unknown.length > 0) {
      throw new Error(
        `budget ${index + 1} has options this check does not read: ${unknown.join(', ')}`,
      );
    }
    return hasRoute
      ? { name, route: (route as string[]).map(toPosix), limitBytes }
      : { name, path: toPosix(String(path)), limitBytes };
  });
}

/** Whether one path segment matches a pattern segment in which `*` is any run of characters. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
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
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * `files` matching a pattern in which `*` stands for any run of characters
 * inside one path segment, never a `/`; everything else is literal. No regex
 * is built from the pattern, so a long one cannot backtrack.
 */
export function matchFiles(pattern: string, files: readonly string[]): string[] {
  const parts = toPosix(pattern).split('/');
  return files.filter((file) => {
    const segments = toPosix(file).split('/');
    return (
      segments.length === parts.length &&
      parts.every((part, index) => matchSegment(part, segments[index] as string))
    );
  });
}

/**
 * A route's own chunks: what this route, and nothing else, makes a browser
 * download.
 *
 * 1. The chunks the bundler made for the route's modules themselves. Always
 *    counted, whoever else imports them.
 * 2. Every chunk those import statically, at any depth, that no OTHER load
 *    root imports statically. The other load roots are the page entry and
 *    every chunk some `import()` names (a shell layout, every other route,
 *    every lazily loaded panel) except the chunks of 1.
 *
 * So a chunk shared with the shell, with another route or with a lazy child of
 * this route is not the route's own, and a private helper chunk is. The
 * definition follows the graph, not the names: a chunk the bundler renames, or
 * folds into one of the route's chunks, stays counted.
 */
export function ownChunks(graph: IBuildGraph, sources: readonly string[]): string[] {
  const made = new Set(sources.flatMap((source) => chunksOfSource(graph, source)));
  const others = staticClosure(
    graph,
    loadRoots(graph).filter((root) => !made.has(root)),
  );
  const closure = staticClosure(graph, [...made]);
  return [...closure].filter((file) => made.has(file) || !others.has(file));
}

interface IMatch {
  readonly label: string;
  readonly files: readonly string[];
  /** Why the entry cannot be weighed, or null. */
  readonly problem: string | null;
}

function matchBudget(budget: IFileBudget, files: readonly string[], graph: IBuildGraph): IMatch {
  if (budget.route === undefined) {
    const path = budget.path ?? '';
    const matched = matchFiles(path, files);
    return {
      label: path,
      files: matched,
      problem: matched.length === 0 ? 'no file of the build matches' : null,
    };
  }
  const label = `route ${budget.route.join(' + ')}`;
  const missing = budget.route.filter((source) => chunksOfSource(graph, source).length === 0);
  return missing.length > 0
    ? { label, files: [], problem: `the build has no chunk for ${missing.join(', ')}` }
    : { label, files: ownChunks(graph, budget.route), problem: null };
}

/**
 * Every budget against the build. `files` is every file of the build relative
 * to the build directory, `graph` its chunk graph and `sizeOf` the served size
 * of one file in bytes. An entry that names nothing is a problem: a pattern no
 * file matches, or a route module the build has no chunk for, would otherwise
 * turn its budget into zero bytes under any limit. With `headroomPercent`,
 * each entry also prints the limit that headroom over today's measurement
 * gives.
 */
export function checkFileBudgets(
  budgets: readonly IFileBudget[],
  files: readonly string[],
  graph: IBuildGraph,
  sizeOf: (file: string) => number,
  headroomPercent?: number,
): IBudgetReport {
  checkHeadroom(headroomPercent);
  const lines: string[] = [];
  const problems: string[] = [];
  for (const budget of budgets) {
    const { label, files: matched, problem } = matchBudget(budget, files, graph);
    if (problem !== null) {
      problems.push(`${label}: ${problem}`);
      continue;
    }
    const total = matched.reduce((sum, file) => sum + sizeOf(file), 0);
    lines.push(
      `${label}: ${asKb(total)} across ${matched.length} files (limit ${asKb(budget.limitBytes)})`,
    );
    if (headroomPercent !== undefined) {
      lines.push(
        `${label}: at ${headroomPercent}% headroom, ${atHeadroom(total, headroomPercent)}`,
      );
    }
    if (total > budget.limitBytes) {
      problems.push(
        `${label}: ${asKb(total)} is ${asKb(total - budget.limitBytes)} over its ` +
          `${asKb(budget.limitBytes)} limit: shrink it, or raise the limit in a reviewed change that says why`,
      );
    }
  }
  return { lines, problems };
}
