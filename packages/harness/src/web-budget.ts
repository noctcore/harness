/*
 * `@noctcore/harness/web-budget`: hold a Vite app's shipped bytes to budgets.
 * Reads the build manifest defensively into a chunk graph, refuses a build
 * directory that is stale or holds two builds, weighs each route cold and
 * beyond its shell, holds file sets and a route's own chunks to limits, finds
 * dynamic imports that split nothing, weighs every file the way an nginx
 * configuration serves it, and writes and checks the brotli copies the server
 * sends. Pure functions take their I/O as deps; the `node*` exports are the
 * real ones. Nothing here writes or raises a budget.
 */
export type { IBuildGraph, IChunk } from './web-budget/build-graph.js';
export {
  buildProblems,
  chunksOfSource,
  DEFAULT_MANIFEST_FILE,
  documentScripts,
  entryFiles,
  loadRoots,
  parseManifest,
  staticClosure,
} from './web-budget/build-graph.js';
export type {
  DeadImportReason,
  IDeadImport,
  IDynamicImportOptions,
} from './web-budget/dead-dynamic-imports.js';
export {
  checkDynamicImports,
  countDynamicImports,
  describeDeadImport,
  findDeadDynamicImports,
} from './web-budget/dead-dynamic-imports.js';
export type { IFileBudget } from './web-budget/file-budget.js';
export {
  checkFileBudgets,
  matchFiles,
  ownChunks,
  parseFileBudgets,
} from './web-budget/file-budget.js';
export { DEFAULT_SKIPPED_DIRS, newerSourceRoots } from './web-budget/freshness.js';
export type { INginxStatement } from './web-budget/nginx-conf.js';
export { nginxStatements } from './web-budget/nginx-conf.js';
export {
  nodeNewestMtime,
  nodePrecompressDeps,
  nodeReadText,
  nodeWebBuildDeps,
} from './web-budget/node.js';
export type {
  IPrecompressDeps,
  IPrecompressOptions,
  IPrecompressRun,
} from './web-budget/precompress.js';
export {
  BROTLI_QUALITY,
  BROTLI_SUFFIX,
  brotliBytes,
  checkPrecompressed,
  PRECOMPRESS_MIN_LENGTH,
  PRECOMPRESS_TYPES,
  precompressDir,
  precompressedBody,
} from './web-budget/precompress.js';
export type { IBudgetReport } from './web-budget/report.js';
export { asKb, BYTES_PER_KB } from './web-budget/report.js';
export type { IRouteBaseline, IRouteBudget } from './web-budget/route-budget.js';
export { checkRoutes, unbuilt } from './web-budget/route-budget.js';
export type { IBudgetIo } from './web-budget/run-budget.js';
export { headroomFromArgv, runBudget } from './web-budget/run-budget.js';
export type {
  IServedEncoding,
  IServedEncodingOptions,
  IServedRequest,
  IServedSize,
} from './web-budget/served-encoding.js';
export {
  BROWSER_BEHIND_PROXY,
  describeEncoding,
  parseServedEncoding,
  SERVED_MIME_TYPES,
  servedCompressible,
  servedMimeType,
  servedSize,
  servedVary,
} from './web-budget/served-encoding.js';
export type {
  IServedWeighing,
  IWebBuild,
  IWebBuildDeps,
  IWebBuildOptions,
  SizeMeasure,
} from './web-budget/web-build.js';
export { loadWebBuild, measuredSize } from './web-budget/web-build.js';
