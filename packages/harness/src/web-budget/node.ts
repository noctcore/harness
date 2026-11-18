import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import type { SizeOf } from './graph.js';
import type { IManifestReadDeps } from './manifest.js';
import type { IFileStat, IPrecompressDeps } from './precompress.js';

/*
 * The real I/O behind the web budget checks: file reads, sizes measured the
 * way a browser downloads them, and a walk of the build directory. Everything
 * else in the subpath is pure over these.
 */

/** How a file's weight is measured: as stored, or compressed at the highest level. */
export type SizeMeasure = 'raw' | 'gzip' | 'brotli';

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** Manifest read deps: null for a missing file; any other read error throws and becomes a problem. */
export const nodeManifestDeps: IManifestReadDeps = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
};

/** Read a text file, or null when it does not exist (a committed report, say). */
export function nodeReadText(path: string): string | null {
  return nodeManifestDeps.readText(path);
}

/** Measure files under `dir` (`/`-separated relative paths) as `measure` bytes. Defaults to gzip. */
export function nodeSizeOf(dir: string, measure: SizeMeasure = 'gzip'): SizeOf {
  return (file) => {
    let body: Buffer;
    try {
      body = readFileSync(join(dir, ...file.split('/')));
    } catch {
      return null;
    }
    if (measure === 'raw') return body.length;
    if (measure === 'brotli') {
      return brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }).length;
    }
    return gzipSync(body, { level: 9 }).length;
  };
}

function walk(root: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(join(root, ...rel.split('/').filter(Boolean)), {
    withFileTypes: true,
  })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

/** Precompress deps over the real file system. Symlinks are not followed. */
export const nodePrecompressDeps: IPrecompressDeps = {
  listFiles: (dir) => {
    const out: string[] = [];
    try {
      walk(dir, '', out);
    } catch {
      return null;
    }
    return out;
  },
  stat: (dir, file): IFileStat | null => {
    try {
      const stat = statSync(join(dir, ...file.split('/')));
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  },
};
