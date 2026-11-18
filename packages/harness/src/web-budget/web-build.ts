/*
 * One web build, loaded for the budgets: its chunk graph, the files it holds
 * and what each weighs as the server sends it. Everything that can make a
 * budget weigh the wrong thing is refused here, before any number is printed:
 * no build, a build older than its sources, a directory two builds wrote into.
 */
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  buildProblems,
  DEFAULT_MANIFEST_FILE,
  documentScripts,
  type IBuildGraph,
  parseManifest,
  toPosix,
} from './build-graph.js';
import { newerSourceRoots } from './freshness.js';
import { brotliBytes, type IPrecompressOptions } from './precompress.js';
import {
  describeEncoding,
  type IServedEncoding,
  type IServedRequest,
  servedSize,
} from './served-encoding.js';

/** How a file is weighed when no server configuration is given: as stored, or compressed at the top level. */
export type SizeMeasure = 'raw' | 'gzip' | 'brotli';

/** Weigh files as an nginx configuration serves them (`parseServedEncoding`). */
export interface IServedWeighing {
  readonly encoding: IServedEncoding;
  /** The request to weigh for. Defaults to `BROWSER_BEHIND_PROXY`. */
  readonly request?: IServedRequest;
  /** The options the precompress step runs with, so the `.br` weighed is the one served. */
  readonly precompress?: IPrecompressOptions;
}

export interface IWebBuildOptions {
  /** The build output directory. */
  readonly distDir: string;
  /** The manifest, relative to `distDir`. Defaults to `.vite/manifest.json`. */
  readonly manifestFile?: string;
  /** The directory of scripts and stylesheets, relative to `distDir`. Defaults to `assets`. */
  readonly assetsDir?: string;
  /** The HTML document that loads the entry, relative to `distDir`. Defaults to `index.html`. */
  readonly documentFile?: string;
  /** Source directories the build must be newer than. Defaults to none (no freshness check). */
  readonly sourceRoots?: readonly string[];
  /** Skip the freshness check: set it under CI, where the build runs right before the budgets. */
  readonly skipFreshness?: boolean;
  /** How files are weighed. Defaults to `gzip`. */
  readonly weigh?: SizeMeasure | IServedWeighing;
  /** What to tell a person whose build is missing or stale. Defaults to `Run the build first.` */
  readonly buildHint?: string;
}

/** The file reads `loadWebBuild` needs, over real paths. */
export interface IWebBuildDeps {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readFile: (path: string) => Buffer;
  /** The names of the entries of a directory. */
  readonly listDir: (path: string) => readonly string[];
  readonly mtimeMs: (path: string) => number;
  /** The newest modification time of a file under `dir`, or null when it does not exist. */
  readonly newestMtime: (dir: string) => number | null;
}

export interface IWebBuild {
  readonly graph: IBuildGraph;
  /** Every script and stylesheet under the assets directory, relative to `distDir`: `assets/index-abc.js`. */
  readonly assets: readonly string[];
  /** The encoding in words: `gzip level 6`. */
  readonly encoding: string;
  /** The bytes a browser downloads for one file of the build (relative to `distDir`), each file read once. */
  readonly sizeOf: (file: string) => number;
}

/** A size of `body` as `measure` gives it. */
export function measuredSize(body: Buffer, measure: SizeMeasure): number {
  if (measure === 'raw') return body.length;
  if (measure === 'brotli') return brotliBytes(body).length;
  return gzipSync(body, { level: 9 }).length;
}

function describeWeigh(weigh: SizeMeasure | IServedWeighing): string {
  if (typeof weigh !== 'string') return describeEncoding(weigh.encoding);
  return weigh === 'raw' ? 'as stored' : weigh === 'gzip' ? 'gzip level 9' : 'brotli quality 11';
}

/**
 * The build in `options.distDir`. Throws with the reason when the directory
 * is not one fresh build: no document, no manifest, a build older than a
 * source root, a manifest that is not one, or a directory whose scripts are
 * not exactly the ones the manifest lists.
 */
export function loadWebBuild(options: IWebBuildOptions, deps: IWebBuildDeps): IWebBuild {
  const { distDir } = options;
  const hint = options.buildHint ?? 'Run the build first.';
  const documentFile = options.documentFile ?? 'index.html';
  const manifestFile = options.manifestFile ?? DEFAULT_MANIFEST_FILE;
  const assetsDir = toPosix(options.assetsDir ?? 'assets');
  const htmlPath = join(distDir, documentFile);
  const manifestPath = join(distDir, manifestFile);
  if (!deps.exists(htmlPath)) throw new Error(`No build at ${distDir}. ${hint}`);
  if (!deps.exists(manifestPath)) {
    throw new Error(
      `${distDir} has no ${manifestFile}: build with \`build.manifest\` set, or pass manifestFile. ${hint}`,
    );
  }
  if (options.skipFreshness !== true && (options.sourceRoots ?? []).length > 0) {
    const newer = newerSourceRoots(
      deps.mtimeMs(htmlPath),
      options.sourceRoots ?? [],
      deps.newestMtime,
    );
    if (newer.length > 0) {
      throw new Error(
        `${htmlPath} is older than its sources (${newer.map(toPosix).join(', ')}), so this would ` +
          `weigh a build of a different commit. ${hint}`,
      );
    }
  }

  const graph = parseManifest(deps.readText(manifestPath), manifestFile);
  const assets = deps
    .listDir(join(distDir, assetsDir))
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => `${assetsDir}/${name}`)
    .sort();
  const problems = buildProblems(
    graph,
    assets.filter((file) => file.endsWith('.js')),
    documentScripts(deps.readText(htmlPath)),
    documentFile,
  );
  if (problems.length > 0) {
    throw new Error(`${distDir} is not one build: ${problems.join('; ')}. ${hint}`);
  }

  const weigh = options.weigh ?? 'gzip';
  const sizes = new Map<string, number>();
  const sizeOf = (file: string): number => {
    const known = sizes.get(file);
    if (known !== undefined) return known;
    const body = deps.readFile(join(distDir, ...toPosix(file).split('/')));
    const size =
      typeof weigh === 'string'
        ? measuredSize(body, weigh)
        : servedSize(weigh.encoding, file, body, weigh.request, weigh.precompress).bytes;
    sizes.set(file, size);
    return size;
  };
  return { graph, assets, encoding: describeWeigh(weigh), sizeOf };
}
