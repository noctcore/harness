import type { IBuildGraph } from './graph.js';
import { toPosix } from './manifest.js';

/*
 * A dynamic `import()` exists to keep code out of the first download. When its
 * target is already in the importer's static closure, or in the shell, the
 * bytes are paid anyway and the split saves nothing: the import is dead. When
 * its target is not in the manifest at all, it is broken. Both fail, unless an
 * allow entry with a written reason names the exact pair.
 */

export interface IDeadImportAllow {
  /** The manifest key of the chunk that does the `import()`. */
  readonly importer: string;
  /** The manifest key it imports. */
  readonly target: string;
  /** Why this import stays as it is. Required: a blank reason is a problem. */
  readonly reason: string;
}

export interface IDeadImportOptions {
  readonly allow?: readonly IDeadImportAllow[];
}

export type DeadImportWhy = 'missing' | 'static' | 'shell';

export interface IDeadImport {
  readonly importer: string;
  readonly target: string;
  /** `broken`: the target is not in the manifest. `dead`: its bytes are already loaded. */
  readonly kind: 'broken' | 'dead';
  readonly why: DeadImportWhy;
  readonly message: string;
}

export interface IDeadImportReport {
  /** Dead and broken imports no allow entry covers. Each fails the check. */
  readonly dead: readonly IDeadImport[];
  /** Those an allow entry covers, kept for the report. */
  readonly allowed: readonly (IDeadImport & { readonly reason: string })[];
  /** Allow entries without a reason, or naming no dead import. Each fails the check. */
  readonly problems: readonly string[];
}

function describe(importer: string, target: string, why: DeadImportWhy): string {
  switch (why) {
    case 'missing':
      return `"${importer}" imports "${target}" with import(), but the manifest has no such chunk: rebuild, or fix the import`;
    case 'static':
      return `"${importer}" imports "${target}" with import(), but already loads it statically: drop the import() or the static import`;
    default:
      return `"${importer}" imports "${target}" with import(), but the shell already loads it: drop the import() or move it out of the shell`;
  }
}

/** Every dead or broken dynamic import in the graph, sorted by importer then target. */
export function findDeadImports(
  graph: IBuildGraph,
  options: IDeadImportOptions = {},
): IDeadImportReport {
  const problems: string[] = [];
  const allow = new Map<string, IDeadImportAllow>();
  for (const entry of options.allow ?? []) {
    const importer = toPosix(entry.importer);
    const target = toPosix(entry.target);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`allowed dead import "${importer}" -> "${target}" has no reason: write one`);
      continue;
    }
    allow.set(`${importer}\0${target}`, { importer, target, reason: entry.reason });
  }

  const found: IDeadImport[] = [];
  const chunks = graph.manifest.chunks;
  for (const importer of [...chunks.keys()].sort()) {
    const chunk = chunks.get(importer)!;
    const closure = graph.closureOf(importer)!;
    for (const target of [...new Set(chunk.dynamicImports)].sort()) {
      let why: DeadImportWhy | null = null;
      if (!chunks.has(target)) why = 'missing';
      else if (closure.keys.has(target)) why = 'static';
      else if (graph.shell.keys.has(target)) why = 'shell';
      if (why === null) continue;
      found.push({
        importer,
        target,
        kind: why === 'missing' ? 'broken' : 'dead',
        why,
        message: describe(importer, target, why),
      });
    }
  }

  const dead: IDeadImport[] = [];
  const allowed: (IDeadImport & { reason: string })[] = [];
  const used = new Set<string>();
  for (const item of found) {
    const id = `${item.importer}\0${item.target}`;
    const entry = allow.get(id);
    if (entry === undefined) {
      dead.push(item);
    } else {
      used.add(id);
      allowed.push({ ...item, reason: entry.reason });
    }
  }
  for (const [id, entry] of allow) {
    if (!used.has(id)) {
      problems.push(
        `allowed dead import "${entry.importer}" -> "${entry.target}" is not dead or broken any more: remove it from the allow list`,
      );
    }
  }
  return { dead, allowed, problems };
}
