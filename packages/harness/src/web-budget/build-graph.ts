/*
 * The chunk graph of one web build, read from the manifest Vite writes next to
 * it (`build.manifest`). The bundler decides which chunk loads which, so its
 * own record is the source: a pattern over the emitted code misses a dynamic
 * import the bundler folded into the importing chunk, which the manifest lists
 * as a chunk importing itself.
 *
 * The manifest's shape is Vite's, not ours, and it has changed between majors,
 * so it is read defensively: every field this module uses is type-checked, a
 * reference to a chunk the manifest does not list is refused, and a path that
 * leaves the build directory is refused. Fields it does not use are ignored.
 */

/** Where Vite writes the manifest inside the build directory when `build.manifest` is `true`. */
export const DEFAULT_MANIFEST_FILE = '.vite/manifest.json';

export interface IChunk {
  /** Path inside the build directory, with forward slashes: `assets/index-abc.js`. */
  readonly file: string;
  /** The manifest key: the module the chunk was made for, or the bundler's name for a shared chunk. */
  readonly source: string;
  readonly isEntry: boolean;
  /** Files of the chunks this one imports statically. */
  readonly imports: readonly string[];
  /** Files of the chunks this one loads with `import()`. */
  readonly dynamicImports: readonly string[];
}

export interface IBuildGraph {
  /** Every script chunk of the build, by file. */
  readonly chunks: ReadonlyMap<string, IChunk>;
}

interface IManifestEntry {
  readonly file: string;
  readonly isEntry: boolean;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
}

/** Backslashes to `/`, so keys and paths compare the same on Windows. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** A JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A built path stays inside the build directory: relative, with no `..` segment. */
export function isContainedPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split('/').includes('..');
}

function keyList(label: string, value: unknown, key: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${label}: ${JSON.stringify(key)} has a ${field} that is not a list of keys`);
  }
  return value.map(toPosix);
}

function readEntry(label: string, key: string, value: unknown): IManifestEntry {
  if (!isRecord(value) || typeof value.file !== 'string' || value.file === '') {
    throw new Error(`${label}: ${JSON.stringify(key)} names no file`);
  }
  const file = toPosix(value.file);
  if (!isContainedPath(file)) {
    throw new Error(
      `${label}: ${JSON.stringify(key)} names ${JSON.stringify(value.file)}, outside the build directory`,
    );
  }
  if (value.isEntry !== undefined && typeof value.isEntry !== 'boolean') {
    throw new Error(`${label}: ${JSON.stringify(key)} has an isEntry that is not true or false`);
  }
  return {
    file,
    isEntry: value.isEntry === true,
    imports: keyList(label, value.imports, key, 'imports'),
    dynamicImports: keyList(label, value.dynamicImports, key, 'dynamicImports'),
  };
}

/**
 * The graph a manifest describes. `label` names the manifest in errors (its
 * path). Throws on text that is not JSON, a manifest that is not an object of
 * entries, an entry with no file, a field of the wrong type, a path outside
 * the build directory, a manifest with no script chunk, or one that points at
 * a chunk it does not list: a graph with a hole in it would report a smaller
 * closure and pass. Only `.js` chunks are kept; css and assets are weighed by
 * file budgets.
 */
export function parseManifest(json: string, label = 'manifest'): IBuildGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${label}: not JSON (${(error as Error).message})`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label}: not an object`);

  const entries = new Map<string, IManifestEntry>();
  for (const [key, value] of Object.entries(parsed)) {
    entries.set(toPosix(key), readEntry(label, key, value));
  }

  const fileOf = (key: string, from: string): string => {
    const target = entries.get(key);
    if (target === undefined) {
      throw new Error(
        `${label}: ${JSON.stringify(from)} imports ${JSON.stringify(key)}, which is not listed`,
      );
    }
    return target.file;
  };

  const chunks = new Map<string, IChunk>();
  for (const [key, entry] of entries) {
    if (!entry.file.endsWith('.js')) continue;
    chunks.set(entry.file, {
      file: entry.file,
      source: key,
      isEntry: entry.isEntry,
      imports: entry.imports.map((target) => fileOf(target, key)),
      dynamicImports: entry.dynamicImports.map((target) => fileOf(target, key)),
    });
  }
  if (chunks.size === 0) throw new Error(`${label}: lists no script chunk`);
  return { chunks };
}

/** Every chunk reachable from `roots` over static imports, the roots included. */
export function staticClosure(graph: IBuildGraph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(graph.chunks.get(file)?.imports ?? []));
  }
  return seen;
}

/** The entry chunks of the build: what the document's module script loads. */
export function entryFiles(graph: IBuildGraph): string[] {
  return [...graph.chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.file);
}

/**
 * The chunks the bundler made for one source module. A plugin may split one
 * module into several chunks with a query on the key (`src/page.tsx?split=a`),
 * so the query is dropped before comparing.
 */
export function chunksOfSource(graph: IBuildGraph, source: string): string[] {
  const wanted = toPosix(source);
  return [...graph.chunks.values()]
    .filter((chunk) => chunk.source.split('?')[0] === wanted)
    .map((chunk) => chunk.file);
}

/**
 * The load roots of the build: every chunk a browser can be told to fetch on
 * its own. That is the page entry and every chunk some `import()` names; any
 * other chunk only ever arrives as a static import of one of these.
 */
export function loadRoots(graph: IBuildGraph): string[] {
  const roots = new Set(entryFiles(graph));
  for (const chunk of graph.chunks.values()) {
    for (const target of chunk.dynamicImports) roots.add(target);
  }
  return [...roots];
}

/** The local scripts and module preloads an HTML document names, as paths inside the build. */
export function documentScripts(html: string): string[] {
  const references = [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu),
    ...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/gu),
  ].map((match) => match[1] ?? '');
  return [...new Set(references)]
    .filter((reference) => !/^(?:https?:)?\/\//u.test(reference))
    .map((reference) => (reference.split('?')[0] ?? '').replace(/^(?:\.\/|\/)/u, ''));
}

/**
 * Why a build directory is not the output of the one build its manifest
 * describes, or nothing. A directory a second build wrote into (another base
 * path, an older commit restored from a cache) holds chunks under other
 * hashes; a budget over such a directory weighs two builds, or the wrong one.
 *
 * `scriptFiles` is every script under the build's assets directory, and
 * `documentScripts` the local scripts and module preloads of the HTML
 * document, both as paths inside the build directory.
 */
export function buildProblems(
  graph: IBuildGraph,
  scriptFiles: readonly string[],
  documentScripts: readonly string[],
  documentName = 'index.html',
): string[] {
  const present = new Set(scriptFiles.map(toPosix));
  const missing = [...graph.chunks.keys()].filter((file) => !present.has(file));
  const leftover = [...present].filter((file) => !graph.chunks.has(file));
  const entries = entryFiles(graph);
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`the manifest lists chunks the directory does not hold: ${missing.join(', ')}`);
  }
  if (leftover.length > 0) {
    problems.push(
      `the directory holds scripts this build did not emit (another build wrote here): ${leftover.join(', ')}`,
    );
  }
  if (entries.length === 0) problems.push('the manifest lists no entry chunk');
  const strangers = entries.filter((file) => !documentScripts.includes(file));
  if (strangers.length > 0) {
    problems.push(
      `${documentName} does not load the entry the manifest lists: ${strangers.join(', ')}`,
    );
  }
  return problems;
}
