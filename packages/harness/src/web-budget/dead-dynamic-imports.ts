/*
 * A dynamic import that splits nothing. `import()` defers a module only when
 * the chunk it lands in is not loaded already. When the same graph also
 * imports that module statically, the bundler puts it in a chunk the importer
 * loads up front (or in the importer itself), and the `import()` resolves at
 * once to code the browser already has. The source still reads as lazy
 * loading, which is how a comment ends up promising a split the build never
 * made.
 */
import { entryFiles, type IBuildGraph, loadRoots, staticClosure } from './build-graph.js';
import type { IBudgetReport } from './report.js';

export type DeadImportReason =
  /** The bundler folded the target into the importing chunk. */
  | 'same-chunk'
  /** The importing chunk reaches the target over static imports. */
  | 'static'
  /** The document's entry reaches the target over static imports: every page has it. */
  | 'entry'
  /** Every chunk a browser can fetch that brings the importer brings the target too. */
  | 'loaded-with';

export interface IDeadImport {
  readonly importer: string;
  readonly target: string;
  readonly reason: DeadImportReason;
}

export interface IDynamicImportOptions {
  /**
   * Fail a build that lists no dynamic import at all. Defaults to true: an
   * app that splits its routes and reads none has not had its manifest read,
   * and the check would pass forever. Set false for an app with no split.
   */
  readonly requireDynamicImports?: boolean;
}

/** How many dynamic imports the build holds, dead or not. */
export function countDynamicImports(graph: IBuildGraph): number {
  let count = 0;
  for (const chunk of graph.chunks.values()) count += chunk.dynamicImports.length;
  return count;
}

/**
 * Every dynamic import of the build whose target is loaded before it runs.
 *
 * The importing chunk never arrives alone: it comes with a load root (the page
 * entry, or a chunk some `import()` names) whose static imports include it. So
 * a target is already there when every root that brings the importer also
 * brings the target, even when the importer itself never imports it
 * statically: a route chunk that imports both a panel and a helper statically
 * has loaded the helper before the panel's `import()` of it can run.
 */
export function findDeadDynamicImports(graph: IBuildGraph): IDeadImport[] {
  const entry = staticClosure(graph, entryFiles(graph));
  const roots = loadRoots(graph).map((root) => staticClosure(graph, [root]));
  const dead: IDeadImport[] = [];
  for (const chunk of graph.chunks.values()) {
    if (chunk.dynamicImports.length === 0) continue;
    const own = staticClosure(graph, chunk.imports);
    const carriers = roots.filter((closure) => closure.has(chunk.file));
    for (const target of chunk.dynamicImports) {
      if (target === chunk.file) dead.push({ importer: chunk.file, target, reason: 'same-chunk' });
      else if (own.has(target)) dead.push({ importer: chunk.file, target, reason: 'static' });
      else if (entry.has(target)) dead.push({ importer: chunk.file, target, reason: 'entry' });
      else if (carriers.length > 0 && carriers.every((closure) => closure.has(target))) {
        dead.push({ importer: chunk.file, target, reason: 'loaded-with' });
      }
    }
  }
  return dead;
}

const REASONS: Readonly<Record<DeadImportReason, string>> = {
  'same-chunk': 'which the bundler put in that same chunk',
  static: 'which that chunk also imports statically',
  entry: 'which the page entry imports statically, so every page has loaded it',
  'loaded-with':
    'which is a static import of every chunk that loads the first one, so it is always loaded already',
};

/** One line per dead import, naming both chunks and the modules they were made for. */
export function describeDeadImport(graph: IBuildGraph, dead: IDeadImport): string {
  const name = (file: string): string => `${file} (${graph.chunks.get(file)?.source ?? 'unknown'})`;
  return `${name(dead.importer)} loads ${name(dead.target)} with import(), ${REASONS[dead.reason]}`;
}

/** The check as a report: every dead import is a problem, and so is reading none at all. */
export function checkDynamicImports(
  graph: IBuildGraph,
  options: IDynamicImportOptions = {},
): IBudgetReport {
  const total = countDynamicImports(graph);
  const dead = findDeadDynamicImports(graph);
  const problems = dead.map((entry) => describeDeadImport(graph, entry));
  if (total === 0 && options.requireDynamicImports !== false) {
    problems.push('the build lists no dynamic import, so nothing was checked');
  }
  return {
    lines: [`${total} dynamic imports, ${dead.length} that split nothing`],
    problems,
  };
}
