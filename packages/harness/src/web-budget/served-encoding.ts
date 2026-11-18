/*
 * How an nginx server compresses what it serves, read from its configuration,
 * so every bundle budget weighs a file the way a browser receives it. A budget
 * that weighs brotli at quality 11 while the server sends gzip (or nothing)
 * passes on bytes nobody downloads. The model here is the configuration
 * itself: change a gzip directive and the budgets move with it.
 *
 * It fails closed: a directive it has no model for is an error, never a
 * default. A consumer that does not serve through nginx weighs files with
 * `nodeSizeOf` instead.
 */
import { gzipSync } from 'node:zlib';

import { nginxStatements } from './nginx-conf.js';
import {
  BROTLI_QUALITY,
  type IPrecompressOptions,
  precompressedBody,
  rootRelative,
} from './precompress.js';

export interface IServedEncoding {
  /** `gzip on`. Off means every response goes out as it is on disk. */
  readonly gzip: boolean;
  /** `gzip_comp_level`. */
  readonly level: number;
  /** `gzip_min_length`: a response shorter than this is not compressed. */
  readonly minLength: number;
  /** `gzip_types`, plus text/html, which nginx always compresses. */
  readonly types: readonly string[];
  /** `gzip_vary`: a response nginx may compress carries `Vary: Accept-Encoding`. */
  readonly vary: boolean;
  /**
   * `gzip_proxied`: whether a request that carries a `Via` header (one that
   * went through a proxy) is compressed. Only the two values that do not
   * depend on the response's own headers are modelled: `any` and `off`.
   */
  readonly proxied: 'any' | 'off';
  /**
   * `brotli_static on`: a client that accepts `br` gets the `.br` copy that
   * sits next to a file (`precompressDir` writes them). The module ignores
   * `gzip_proxied`, and for any request that accepts br it also tells the gzip
   * filter to stand down, whether or not the copy exists. A file with no copy
   * therefore goes out as it is to a client that accepts br, unless its
   * location sets `brotli_static off`.
   */
  readonly brotliStatic: boolean;
  /**
   * The files served from a location of their own with `brotli_static off`:
   * `location = /runtime.js` gives `/runtime.js`. For these the module does
   * nothing, so gzip applies as it does without it.
   */
  readonly brotliOffPaths: readonly string[];
  /** The Content-Type the server gives a file, by extension (`parseServedEncoding`'s `mimeTypes`). */
  readonly mimeTypes: Readonly<Record<string, string>>;
}

export interface IServedEncodingOptions {
  /**
   * Files the configuration may `include`, each once and outside every block.
   * List only a file that holds nothing about compression (a generated `map`,
   * say): its directives are not read. Defaults to none.
   */
  readonly allowedIncludes?: readonly string[];
  /**
   * Block heads that may hold one `types` block (`location = /feed.xml`). A
   * `types` block changes the Content-Type of files, and with it which are
   * compressed, so list only a location no budgeted file is served from.
   * Defaults to none.
   */
  readonly typesLocations?: readonly string[];
  /** The Content-Type of each extension a budget weighs. Defaults to `SERVED_MIME_TYPES`. */
  readonly mimeTypes?: Readonly<Record<string, string>>;
}

/** What a request looks like to the compression directives. */
export interface IServedRequest {
  /** The request carries a `Via` header: a proxy handled it before the server did. */
  readonly viaProxy: boolean;
  /** The Accept-Encoding header names `br`. */
  readonly acceptsBrotli: boolean;
}

/**
 * The request the budgets weigh by default: a browser that reached the server
 * through a proxy (a load balancer, a tunnel). Under `gzip_proxied off` this
 * is the request that gets nothing, so a budget never assumes gzip it would
 * not get.
 */
export const BROWSER_BEHIND_PROXY: IServedRequest = { viaProxy: true, acceptsBrotli: true };

export interface IServedSize {
  readonly bytes: number;
  readonly encoding: 'br' | 'gzip' | 'identity';
}

/** The Content-Type nginx's default mime.types gives the files a budget weighs. */
export const SERVED_MIME_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css',
  html: 'text/html',
  js: 'application/javascript',
};

/** nginx's defaults for the directives the model reads. */
const DEFAULT_LEVEL = 1;
const DEFAULT_MIN_LENGTH = 20;
const DEFAULT_PROXIED = 'off';
const ALWAYS_COMPRESSED = 'text/html';

/** A directive that decides whether, or how, a response is compressed. */
const COMPRESSION_DIRECTIVE = /^(?:gzip|gunzip|brotli|zstd)/u;

const KNOWN_DIRECTIVES = new Set([
  'gzip',
  'gzip_comp_level',
  'gzip_min_length',
  'gzip_types',
  'gzip_vary',
  'gzip_proxied',
  'brotli_static',
]);

function single(values: readonly string[], directive: string): string {
  const [value] = values;
  if (value === undefined || values.length !== 1) {
    throw new Error(
      `nginx config: ${directive} takes one value, found ${JSON.stringify(values.join(' '))}`,
    );
  }
  return value;
}

/**
 * The path a `brotli_static off` in `block` stands for. Only an exact-match
 * location (`location = /runtime.js`) with the value `off` is modelled: the
 * file it serves is known without matching rules, and `off` can only remove
 * the copy and the module's side effect for that one file.
 */
function brotliOffPath(block: string, values: readonly string[]): string {
  const path = /^location = (\/\S*)$/u.exec(block)?.[1];
  if (path === undefined || values.join(' ') !== 'off') {
    throw new Error(
      `nginx config: brotli_static ${values.join(' ')} sits in ${JSON.stringify(block)}. The bundle ` +
        'budgets read brotli_static in the server block, and `off` in an exact-match location ' +
        '(`location = /file.js`); they have no model for anything else',
    );
  }
  return path;
}

/** An `on`/`off` directive: off when it is not written. */
function onOff(values: readonly string[] | undefined, directive: string): boolean {
  if (values === undefined) return false;
  const value = single(values, directive);
  if (value !== 'on' && value !== 'off') {
    throw new Error(`nginx config: ${directive} ${value} is neither on nor off`);
  }
  return value === 'on';
}

function wholeNumber(values: readonly string[], directive: string): number {
  const value = single(values, directive);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`nginx config: ${directive} ${value} is not a whole number of bytes or levels`);
  }
  return Number(value);
}

/** Throws unless `file` is an allowed include, outside every block, for the first time. */
function checkInclude(
  file: string,
  block: string,
  count: number,
  allowed: readonly string[],
): void {
  if (!allowed.includes(file)) {
    throw new Error(
      `nginx config: include ${file} brings in directives the bundle budgets cannot read, so ` +
        'they could not tell what is served. Write the directives into the configuration itself, ' +
        'or list the file in allowedIncludes if it holds nothing about compression',
    );
  }
  if (block !== '') {
    throw new Error(
      `nginx config: include ${file} sits in ${JSON.stringify(block)}. An allowed include is ` +
        'read as sitting outside every block: move it to the top of the file',
    );
  }
  if (count > 1) throw new Error(`nginx config: include ${file} is written twice. Keep one`);
}

/** Throws unless `block` is an allowed types location holding its first `types` block. */
function checkTypesBlock(block: string, count: number, allowed: readonly string[]): void {
  if (!allowed.includes(block)) {
    throw new Error(
      `nginx config: a types block in ${JSON.stringify(block)} changes the Content-Type of ` +
        'files, and with it which of them are compressed. The bundle budgets take the type from ' +
        'mimeTypes. Remove this block, or, for a location no budgeted file is served from, list ' +
        'its head in typesLocations',
    );
  }
  if (count > 1) {
    throw new Error(`nginx config: a second types block in ${JSON.stringify(block)}. Keep one`);
  }
}

/**
 * The encoding an nginx configuration serves. Fails closed: a compression
 * directive the model does not know (gzip_static, brotli, gunzip, buffers), one
 * set twice, one inside a `location`, an `include` that is not allowed or not
 * where it belongs, or a `types` block outside an allowed location would make
 * the budgets weigh something other than what is served, so each is an error.
 */
export function parseServedEncoding(
  conf: string,
  options: IServedEncodingOptions = {},
): IServedEncoding {
  const allowedIncludes = options.allowedIncludes ?? [];
  const typesLocations = options.typesLocations ?? [];
  const seen = new Map<string, readonly string[]>();
  const brotliOffPaths: string[] = [];
  const includes = new Map<string, number>();
  const typesBlocks = new Map<string, number>();
  for (const statement of nginxStatements(conf)) {
    const [name = '', ...values] = statement.words;
    if (name === 'include') {
      const file = values.join(' ');
      includes.set(file, (includes.get(file) ?? 0) + 1);
      checkInclude(file, statement.block, includes.get(file) as number, allowedIncludes);
    }
    if (name === 'types') {
      typesBlocks.set(statement.block, (typesBlocks.get(statement.block) ?? 0) + 1);
      checkTypesBlock(statement.block, typesBlocks.get(statement.block) as number, typesLocations);
    }
    if (name === 'brotli_static' && statement.block !== 'server') {
      brotliOffPaths.push(brotliOffPath(statement.block, values));
      continue;
    }
    if (!COMPRESSION_DIRECTIVE.test(name)) continue;
    if (statement.block !== 'server') {
      throw new Error(
        `nginx config: ${name} sits in ${JSON.stringify(statement.block)}, and the bundle budgets ` +
          'read compression from the server block only',
      );
    }
    if (seen.has(name)) throw new Error(`nginx config: ${name} is set twice`);
    seen.set(name, values);
  }

  const unknown = [...seen.keys()].filter((name) => !KNOWN_DIRECTIVES.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `nginx config: the bundle budgets do not know how ${unknown.join(', ')} changes what is ` +
        'served, so they could not weigh what a browser downloads',
    );
  }

  const proxied = seen.get('gzip_proxied') ?? [DEFAULT_PROXIED];
  const [proxiedValue] = proxied;
  if ((proxiedValue !== 'any' && proxiedValue !== 'off') || proxied.length !== 1) {
    throw new Error(
      `nginx config: gzip_proxied ${proxied.join(' ')} is neither any nor off. The other values ` +
        'compress by the headers of the response (expired, no-cache, private, auth ...), which ' +
        'the bundle budgets do not see',
    );
  }
  const level = seen.get('gzip_comp_level');
  const minLength = seen.get('gzip_min_length');
  const resolvedLevel = level === undefined ? DEFAULT_LEVEL : wholeNumber(level, 'gzip_comp_level');
  if (resolvedLevel < 1 || resolvedLevel > 9) {
    throw new Error(`nginx config: gzip_comp_level ${resolvedLevel} is outside 1 to 9`);
  }
  return {
    gzip: onOff(seen.get('gzip'), 'gzip'),
    vary: onOff(seen.get('gzip_vary'), 'gzip_vary'),
    proxied: proxiedValue,
    brotliStatic: onOff(seen.get('brotli_static'), 'brotli_static'),
    brotliOffPaths,
    level: resolvedLevel,
    minLength:
      minLength === undefined ? DEFAULT_MIN_LENGTH : wholeNumber(minLength, 'gzip_min_length'),
    types: [...new Set([ALWAYS_COMPRESSED, ...(seen.get('gzip_types') ?? [])])],
    mimeTypes: options.mimeTypes ?? SERVED_MIME_TYPES,
  };
}

/** The Content-Type the server sends a build file with. Throws for a kind no budget weighs. */
export function servedMimeType(
  file: string,
  mimeTypes: Readonly<Record<string, string>> = SERVED_MIME_TYPES,
): string {
  const extension = /\.([^./\\]+)$/u.exec(file)?.[1] ?? '';
  const type = Object.hasOwn(mimeTypes, extension) ? mimeTypes[extension] : undefined;
  if (type === undefined) {
    throw new Error(
      `${file}: the bundle budgets do not know how the server serves this kind of file`,
    );
  }
  return type;
}

/**
 * Whether the server's gzip filter takes this file at all: gzip on, a listed
 * type, long enough. Whether a given request then gets gzip is `servedSize`.
 */
export function servedCompressible(encoding: IServedEncoding, file: string, body: Buffer): boolean {
  return (
    encoding.gzip &&
    encoding.types.includes(servedMimeType(file, encoding.mimeTypes)) &&
    body.length >= encoding.minLength
  );
}

/** Whether a request that went through a proxy may be gzipped (`gzip_proxied`). */
function proxiedAllowed(encoding: IServedEncoding, request: IServedRequest): boolean {
  return !request.viaProxy || encoding.proxied === 'any';
}

/** Whether `brotli_static` is in force for this file: on, and not off in a location of its own. */
function brotliInForce(encoding: IServedEncoding, file: string): boolean {
  return encoding.brotliStatic && !encoding.brotliOffPaths.includes(`/${rootRelative(file)}`);
}

/**
 * Whether the response for this file carries `Vary: Accept-Encoding`: any
 * response the gzip filter may compress, and any file brotli_static handles
 * (the module marks every response it looks at).
 */
export function servedVary(encoding: IServedEncoding, file: string, body: Buffer): boolean {
  return (
    encoding.vary && (servedCompressible(encoding, file, body) || brotliInForce(encoding, file))
  );
}

/**
 * What a client downloads for one file of the build: the `.br` copy when it
 * accepts br and the build holds one (as `precompressDir` with the same
 * `precompress` options writes it), else gzip when the filter takes the file,
 * else the file as it is. A client that accepts br is never gzipped while
 * brotli_static is in force for the file, so a file with no copy reaches it as
 * it is.
 */
export function servedSize(
  encoding: IServedEncoding,
  file: string,
  body: Buffer,
  request: IServedRequest = BROWSER_BEHIND_PROXY,
  precompress: IPrecompressOptions = {},
): IServedSize {
  if (request.acceptsBrotli && brotliInForce(encoding, file)) {
    const precompressed = precompressedBody(file, body, precompress);
    return precompressed === null
      ? { bytes: body.length, encoding: 'identity' }
      : { bytes: precompressed.length, encoding: 'br' };
  }
  const compressed = servedCompressible(encoding, file, body) && proxiedAllowed(encoding, request);
  return compressed
    ? { bytes: gzipSync(body, { level: encoding.level }).length, encoding: 'gzip' }
    : { bytes: body.length, encoding: 'identity' };
}

/** The encoding in words, for a budget's output: `brotli quality 11 (precompressed), gzip level 6`. */
export function describeEncoding(encoding: IServedEncoding): string {
  const gzip = !encoding.gzip
    ? 'no compression'
    : encoding.proxied === 'off'
      ? `gzip level ${encoding.level}, not for a request through a proxy (gzip_proxied off)`
      : `gzip level ${encoding.level}`;
  return encoding.brotliStatic ? `brotli quality ${BROTLI_QUALITY} (precompressed), ${gzip}` : gzip;
}
