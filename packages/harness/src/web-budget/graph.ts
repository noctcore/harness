import { type IManifestChunk, type IViteManifest, toPosix } from './manifest.js';

/*
 * The build graph over a parsed manifest: which files a chunk pulls in before
 * it can run (its static closure), how many bytes that is, and how much of it
 * the shell (the entry chunks every page loads) already paid for. A file is
 * counted once however many chunks share it, and import cycles are safe.
 */

/** The byte size of a built file (relative to the build dir, `/` separators), or null when it is missing. */
export type SizeOf = (file: string) => number | null;

export interface IGraphOptions {
  /** Manifest keys of the shell's entry chunks. Defaults to every chunk with `isEntry`. */
  readonly shellEntries?: readonly string[];
  /** Count the assets (images, fonts) a chunk references in its weight. Defaults to false: js and css only. */
  readonly includeAssets?: boolean;
}

export interface IClosure {
  /** Manifest keys reached through static imports, the start included. */
  readonly keys: ReadonlySet<string>;
  /** Built files those chunks load. */
  readonly files: ReadonlySet<string>;
}

export interface IRouteWeight {
  readonly key: string;
  /** Bytes of the route's static closure: what a cold visit downloads. */
  readonly cold: number;
  /** Bytes of the closure the shell does not already load. */
  readonly beyondShell: number;
}

export interface IBuildGraph {
  readonly manifest: IViteManifest;
  readonly shell: IClosure & { readonly entries: readonly string[]; readonly bytes: number };
  /** The static closure of a manifest key, or null when the key is not in the manifest. */
  readonly closureOf: (key: string) => IClosure | null;
  /** The cold and beyond-shell weight of a manifest key, or null when the key is not in the manifest. */
  readonly weightOf: (key: string) => IRouteWeight | null;
  /** The size of every file the manifest names that could be measured. */
  readonly sizes: ReadonlyMap<string, number>;
  /** Problems found while building the graph: a missing file, a bad shell entry. Each fails the check. */
  readonly problems: readonly string[];
}

function chunkFiles(chunk: IManifestChunk, includeAssets: boolean): string[] {
  return [chunk.file, ...chunk.css, ...(includeAssets ? chunk.assets : [])];
}

/** The static closure of `start` (a key or keys), walking `imports` only. */
export function staticClosure(
  chunks: ReadonlyMap<string, IManifestChunk>,
  start: string | readonly string[],
  includeAssets = false,
): IClosure {
  const keys = new Set<string>();
  const files = new Set<string>();
  const stack = typeof start === 'string' ? [start] : [...start];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (keys.has(key)) continue;
    const chunk = chunks.get(key);
    if (chunk === undefined) continue;
    keys.add(key);
    for (const file of chunkFiles(chunk, includeAssets)) files.add(file);
    for (const next of chunk.imports) if (!keys.has(next)) stack.push(next);
  }
  return { keys, files };
}

function sum(files: Iterable<string>, sizes: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const file of files) total += sizes.get(file) ?? 0;
  return total;
}

/** Build the graph: measure every file the manifest names and close over the shell. */
export function buildGraph(
  manifest: IViteManifest,
  sizeOf: SizeOf,
  options: IGraphOptions = {},
): IBuildGraph {
  const includeAssets = options.includeAssets ?? false;
  const problems: string[] = [];
  const sizes = new Map<string, number>();
  const all = new Set<string>();
  for (const chunk of manifest.chunks.values()) {
    for (const file of [chunk.file, ...chunk.css, ...chunk.assets]) all.add(file);
  }
  for (const file of [...all].sort()) {
    const size = sizeOf(file);
    if (size === null || !Number.isFinite(size) || size < 0) {
      problems.push(`${file} is in the manifest but not in the build directory: rebuild`);
    } else {
      sizes.set(file, size);
    }
  }

  let entries: string[];
  if (options.shellEntries !== undefined) {
    entries = options.shellEntries.map(toPosix);
    for (const key of entries) {
      if (!manifest.chunks.has(key)) {
        problems.push(`shell entry "${key}" is not in the manifest: fix shellEntries`);
      }
    }
  } else {
    entries = [...manifest.chunks.values()]
      .filter((chunk) => chunk.isEntry)
      .map((chunk) => chunk.key)
      .sort();
  }
  if (entries.length === 0 && manifest.chunks.size > 0) {
    problems.push('the manifest has no entry chunk: pass shellEntries');
  }
  const shellClosure = staticClosure(manifest.chunks, entries, includeAssets);
  const shell = { ...shellClosure, entries, bytes: sum(shellClosure.files, sizes) };

  const closureOf = (key: string): IClosure | null =>
    manifest.chunks.has(key) ? staticClosure(manifest.chunks, key, includeAssets) : null;

  const weightOf = (key: string): IRouteWeight | null => {
    const closure = closureOf(key);
    if (closure === null) return null;
    const beyond = [...closure.files].filter((file) => !shell.files.has(file));
    return { key, cold: sum(closure.files, sizes), beyondShell: sum(beyond, sizes) };
  };

  return { manifest, shell, closureOf, weightOf, sizes, problems };
}
