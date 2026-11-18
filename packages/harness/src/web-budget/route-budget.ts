/*
 * What one route costs a visitor: the chunks the bundler made for the route's
 * own modules and everything they import statically, measured cold (with the
 * shell) and beyond the shell the visitor already has.
 *
 * A route is named by its SOURCE modules, and its chunks are taken from the
 * build graph. A pattern over chunk file names cannot do this: the bundler
 * names a chunk after whichever module it was made for, and folds one chunk
 * into another when the graph changes, so a name pattern gains or loses bytes
 * without the route changing.
 *
 * COLD is the number a person feels: everything downloaded to see the route
 * from nothing. BEYOND is what a navigation from elsewhere in the app costs,
 * and what the route itself adds on top of the shell. Both are held to a
 * baseline. They move in opposite directions when a chunk is pushed out of the
 * shell, so a change that does that on purpose moves both baselines together,
 * in a reviewed change that says why. There is no tolerance: a baseline is the
 * limit.
 */
import { chunksOfSource, entryFiles, type IBuildGraph, staticClosure } from './build-graph.js';
import { asKb, atHeadroom, BYTES_PER_KB, checkHeadroom, type IBudgetReport } from './report.js';

export interface IRouteBaseline {
  /** The route as people know it (`/settings`), used in every line. */
  readonly route: string;
  /** The route's own modules, as the manifest names them: `src/routes/settings.tsx`. */
  readonly sources: readonly string[];
  /** The named shell the route renders inside (a key of `shells`). Absent: the entry alone. */
  readonly shell?: string;
  /** The cold weight the route is held to, in kB as served. */
  readonly coldKb: number;
  /** The weight beyond the shell the route is held to, in kB as served. */
  readonly beyondKb: number;
}

export interface IRouteBudget {
  readonly baselines: readonly IRouteBaseline[];
  /**
   * Shells beyond the entry, by name: the layout modules a group of routes
   * renders inside (`{ app: ['src/routes/_app.tsx'] }`). A named shell is the
   * entry plus those modules' chunks and their static imports.
   */
  readonly shells?: Readonly<Record<string, readonly string[]>>;
}

/** The modules of `sources` the build has no chunk for. */
export function unbuilt(graph: IBuildGraph, sources: readonly string[]): string[] {
  return sources.filter((source) => chunksOfSource(graph, source).length === 0);
}

function checkKb(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be a positive number of kB, got ${String(value)}`);
  }
}

/**
 * Every tracked route against its baseline. `sizeOf` is the served size of a
 * chunk in bytes. A route or a shell the build has no chunk for is a problem,
 * never a skip: a moved route file would otherwise leave the budget without a
 * word. A baseline that is not a positive number throws. With
 * `headroomPercent`, each route's line also carries the baselines that
 * headroom over today's measurement gives, for the change that moves one.
 */
export function checkRoutes(
  graph: IBuildGraph,
  sizeOf: (file: string) => number,
  budget: IRouteBudget,
  headroomPercent?: number,
): IBudgetReport {
  checkHeadroom(headroomPercent);
  for (const baseline of budget.baselines) {
    checkKb(baseline.coldKb, `${baseline.route}: coldKb`);
    checkKb(baseline.beyondKb, `${baseline.route}: beyondKb`);
  }
  const lines: string[] = [];
  const problems: string[] = [];
  const weigh = (set: Iterable<string>): number => {
    let total = 0;
    for (const file of set) total += sizeOf(file);
    return total;
  };

  const entries = entryFiles(graph);
  if (entries.length === 0) problems.push('the build has no entry chunk');
  const entryShell = staticClosure(graph, entries);
  lines.push(`entry: ${asKb(weigh(entryShell))} across ${entryShell.size} chunks`);
  const shells = new Map<string, Set<string>>();
  for (const [name, sources] of Object.entries(budget.shells ?? {})) {
    const missing = unbuilt(graph, sources);
    if (missing.length > 0 || sources.length === 0) {
      problems.push(
        `the build has no chunk for ${missing.join(', ') || 'a shell with no module'}, ` +
          `so the ${name} shell cannot be measured`,
      );
      continue;
    }
    const closure = staticClosure(graph, [
      ...entries,
      ...sources.flatMap((source) => chunksOfSource(graph, source)),
    ]);
    shells.set(name, closure);
    lines.push(`${name} shell: ${asKb(weigh(closure))} across ${closure.size} chunks`);
  }

  for (const baseline of budget.baselines) {
    const missing = unbuilt(graph, baseline.sources);
    if (missing.length > 0 || baseline.sources.length === 0) {
      problems.push(
        `${baseline.route}: the build has no chunk for ${missing.join(', ') || 'a route with no module'}, ` +
          'so the route cannot be measured',
      );
      continue;
    }
    const shell = baseline.shell === undefined ? entryShell : shells.get(baseline.shell);
    if (shell === undefined) {
      if (budget.shells?.[baseline.shell as string] === undefined) {
        problems.push(
          `${baseline.route}: names the shell ${JSON.stringify(baseline.shell)}, which the budget does not define`,
        );
      }
      continue;
    }
    const own = baseline.sources.flatMap((source) => chunksOfSource(graph, source));
    const beyond = [...staticClosure(graph, own)].filter((file) => !shell.has(file));
    const beyondBytes = weigh(beyond);
    const coldBytes = weigh(shell) + beyondBytes;
    lines.push(
      `${baseline.route}: cold ${asKb(coldBytes)} (baseline ${baseline.coldKb} kB), ` +
        `${asKb(beyondBytes)} across ${beyond.length} chunks beyond the shell (baseline ${baseline.beyondKb} kB)`,
    );
    if (headroomPercent !== undefined) {
      lines.push(
        `${baseline.route}: at ${headroomPercent}% headroom, cold ${atHeadroom(coldBytes, headroomPercent)} ` +
          `and beyond ${atHeadroom(beyondBytes, headroomPercent)}`,
      );
    }
    for (const [label, bytes, baselineKb] of [
      ['cold', coldBytes, baseline.coldKb],
      ['beyond the shell', beyondBytes, baseline.beyondKb],
    ] as const) {
      const overBytes = bytes - baselineKb * BYTES_PER_KB;
      if (overBytes > 0) {
        problems.push(
          `${baseline.route}: ${label} ${asKb(bytes)} is ${asKb(overBytes)} over its ${baselineKb} kB ` +
            'baseline: shrink it, or move the baseline in a reviewed change that says why',
        );
      }
    }
  }
  return { lines, problems };
}
