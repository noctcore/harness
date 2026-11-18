import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_SKIPPED_DIRS } from './freshness.js';
import type { IPrecompressDeps } from './precompress.js';
import type { IWebBuildDeps } from './web-build.js';

/*
 * The real I/O behind the web budget checks: file reads, directory walks and
 * modification times. Everything else in the subpath is pure over these.
 */

/** Read a text file, or null when it does not exist (a budgets file, a configuration). */
export function nodeReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The newest modification time of a file under a directory, skipping
 * `skipped` directory names at any depth; null when the directory does not
 * exist. A file that vanishes mid-walk cannot make a build stale.
 */
export function nodeNewestMtime(
  skipped: readonly string[] = DEFAULT_SKIPPED_DIRS,
): (dir: string) => number | null {
  const skip = new Set(skipped);
  const walk = (dir: string): number => {
    let newest = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return newest;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) newest = Math.max(newest, walk(join(dir, entry.name)));
      } else if (entry.isFile()) {
        try {
          newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs);
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
    return newest;
  };
  return (dir) => (existsSync(dir) ? walk(dir) : null);
}

/** `loadWebBuild` deps over the real file system. */
export const nodeWebBuildDeps: IWebBuildDeps = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
  readFile: (path) => readFileSync(path),
  listDir: (path) => readdirSync(path),
  mtimeMs: (path) => statSync(path).mtimeMs,
  newestMtime: nodeNewestMtime(),
};

function filesUnder(root: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(join(root, ...rel.split('/').filter(Boolean)), {
    withFileTypes: true,
  })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(root, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

const under = (dir: string, file: string): string => join(dir, ...file.split('/'));

/** `precompressDir` and `checkPrecompressed` deps over the real file system. Symlinks are not followed. */
export const nodePrecompressDeps: IPrecompressDeps = {
  listFiles: (dir) => {
    const out: string[] = [];
    filesUnder(dir, '', out);
    return out;
  },
  readFile: (dir, file) => readFileSync(under(dir, file)),
  writeFile: (dir, file, body) => {
    mkdirSync(dirname(under(dir, file)), { recursive: true });
    writeFileSync(under(dir, file), body);
  },
  removeFile: (dir, file) => rmSync(under(dir, file)),
};
