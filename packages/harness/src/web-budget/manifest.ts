/*
 * The Vite build manifest (`.vite/manifest.json`), read defensively. Its shape
 * is Vite's, not ours, and it has changed between majors, so every field is
 * checked before it is trusted: a field of the wrong type, an entry without a
 * `file`, an empty manifest or a path that leaves the build directory is a
 * named problem, and any problem fails the check. Unknown fields are ignored,
 * so a field a later Vite adds does not break the read.
 */

export interface IManifestChunk {
  /** The manifest key: the source path Vite keyed the chunk by (`src/main.ts`, `_shared-a1b2.js`). */
  readonly key: string;
  /** The built file, relative to the build directory, with `/` separators. */
  readonly file: string;
  readonly src?: string;
  readonly name?: string;
  readonly isEntry: boolean;
  readonly isDynamicEntry: boolean;
  /** Keys of the chunks this one imports statically. */
  readonly imports: readonly string[];
  /** Keys of the chunks this one imports with `import()`. */
  readonly dynamicImports: readonly string[];
  /** Built css files this chunk loads. */
  readonly css: readonly string[];
  /** Built asset files (images, fonts) this chunk references. */
  readonly assets: readonly string[];
}

export interface IViteManifest {
  readonly chunks: ReadonlyMap<string, IManifestChunk>;
  /** Everything the reader could not trust. Any problem fails the check. */
  readonly problems: readonly string[];
}

/** Reads a file's text: null when it does not exist. Any other failure may throw. */
export interface IManifestReadDeps {
  readonly readText: (path: string) => string | null;
}

const STRING_FIELDS = ['src', 'name'] as const;
const BOOLEAN_FIELDS = ['isEntry', 'isDynamicEntry'] as const;

/** Backslashes to `/`, so keys and paths compare the same on Windows. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** A JSON object: not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A built path must stay inside the build directory: relative, with no `..` segment. */
export function isContainedPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split('/').some((segment) => segment === '..');
}

function readList(
  label: string,
  key: string,
  field: string,
  value: unknown,
  problems: string[],
  isPath: boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    problems.push(`${label}: "${key}".${field} must be a list of non-empty strings`);
    return [];
  }
  const items = (value as string[]).map(toPosix);
  if (isPath) {
    for (const item of items) {
      if (!isContainedPath(item)) {
        problems.push(`${label}: "${key}".${field} names "${item}", outside the build directory`);
      }
    }
    return items.filter(isContainedPath);
  }
  return items;
}

function readChunk(
  label: string,
  rawKey: string,
  entry: unknown,
  problems: string[],
): IManifestChunk | null {
  const key = toPosix(rawKey);
  if (!isPlainObject(entry)) {
    problems.push(`${label}: "${key}" is not an object`);
    return null;
  }
  const before = problems.length;
  if (typeof entry.file !== 'string' || entry.file === '') {
    problems.push(`${label}: "${key}" has no "file" string`);
  } else if (!isContainedPath(toPosix(entry.file))) {
    problems.push(`${label}: "${key}".file names "${entry.file}", outside the build directory`);
  }
  for (const field of STRING_FIELDS) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      problems.push(`${label}: "${key}".${field} must be a string`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
      problems.push(`${label}: "${key}".${field} must be true or false`);
    }
  }
  const imports = readList(label, key, 'imports', entry.imports, problems, false);
  const dynamicImports = readList(
    label,
    key,
    'dynamicImports',
    entry.dynamicImports,
    problems,
    false,
  );
  const css = readList(label, key, 'css', entry.css, problems, true);
  const assets = readList(label, key, 'assets', entry.assets, problems, true);
  if (problems.length > before) return null;
  return {
    key,
    file: toPosix(entry.file as string),
    ...(typeof entry.src === 'string' ? { src: toPosix(entry.src) } : {}),
    ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    isEntry: entry.isEntry === true,
    isDynamicEntry: entry.isDynamicEntry === true,
    imports,
    dynamicImports,
    css,
    assets,
  };
}

/**
 * Parse a Vite manifest already read as JSON. `label` names it in problems
 * (its path, say). A static import of a key the manifest does not list is a
 * problem too: the graph would undercount. A dynamic import of a missing key
 * is left to `findDeadImports`, which reports it as broken.
 */
export function parseViteManifest(raw: unknown, label = 'manifest'): IViteManifest {
  const chunks = new Map<string, IManifestChunk>();
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    return {
      chunks,
      problems: [`${label} is not a JSON object of chunks: is it a Vite build manifest?`],
    };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    return {
      chunks,
      problems: [`${label} lists no chunk: build with \`build.manifest: true\` and check the path`],
    };
  }
  for (const [rawKey, entry] of entries) {
    const chunk = readChunk(label, rawKey, entry, problems);
    if (chunk !== null) chunks.set(chunk.key, chunk);
  }
  for (const chunk of chunks.values()) {
    for (const target of chunk.imports) {
      if (!chunks.has(target)) {
        problems.push(
          `${label}: "${chunk.key}" imports "${target}", which the manifest does not list`,
        );
      }
    }
  }
  return { chunks, problems };
}

/** Parse manifest text; text that is not JSON is a problem, never an empty pass. */
export function parseViteManifestText(text: string, label = 'manifest'): IViteManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      chunks: new Map(),
      problems: [`${label} is not valid JSON (${(error as Error).message}): rebuild it`],
    };
  }
  return parseViteManifest(raw, label);
}

/** Read and parse the manifest at `path`. A missing or unreadable file is a problem. */
export function readViteManifest(path: string, deps: IManifestReadDeps): IViteManifest {
  let text: string | null;
  try {
    text = deps.readText(path);
  } catch (error) {
    return { chunks: new Map(), problems: [`${path} cannot be read: ${String(error)}`] };
  }
  if (text === null) {
    return {
      chunks: new Map(),
      problems: [
        `${path} is missing: run the build first, with \`build.manifest: true\` in the Vite config`,
      ],
    };
  }
  return parseViteManifestText(text, path);
}
