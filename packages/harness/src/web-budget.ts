/*
 * `@noctcore/harness/web-budget`: hold a Vite app's shipped bytes to budgets.
 * Reads the build manifest defensively, weighs each route cold and beyond the
 * shell, checks route, shell and per-file budgets, finds dead dynamic imports,
 * renders a committed report with a freshness gate, and checks that every
 * file the server should serve compressed has its `.br`/`.gz` sibling. Pure
 * functions take their I/O as deps; the `node*` exports are the real ones.
 * Nothing here writes or raises a budget.
 */
export type {
  BudgetViolationKind,
  IBudgetViolation,
  IFileBudget,
  IRouteBudget,
  IWebBudgets,
} from './web-budget/budgets.js';
export { checkBudgets, matchesPattern, parseWebBudgets } from './web-budget/budgets.js';
export type {
  DeadImportWhy,
  IDeadImport,
  IDeadImportAllow,
  IDeadImportOptions,
  IDeadImportReport,
} from './web-budget/dead-imports.js';
export { findDeadImports } from './web-budget/dead-imports.js';
export type {
  IBuildGraph,
  IClosure,
  IGraphOptions,
  IRouteWeight,
  SizeOf,
} from './web-budget/graph.js';
export { buildGraph, staticClosure } from './web-budget/graph.js';
export type { IManifestChunk, IManifestReadDeps, IViteManifest } from './web-budget/manifest.js';
export {
  parseViteManifest,
  parseViteManifestText,
  readViteManifest,
} from './web-budget/manifest.js';
export type { SizeMeasure } from './web-budget/node.js';
export {
  nodeManifestDeps,
  nodePrecompressDeps,
  nodeReadText,
  nodeSizeOf,
} from './web-budget/node.js';
export type {
  IFileStat,
  IPrecompressDeps,
  IPrecompressOptions,
  IPrecompressProblem,
  IPrecompressReport,
} from './web-budget/precompress.js';
export {
  checkPrecompressed,
  formatPrecompressReport,
  PRECOMPRESS_EXTENSIONS,
  PRECOMPRESS_MIN_BYTES,
} from './web-budget/precompress.js';
export type {
  IFileRow,
  IFreshness,
  IRouteRow,
  IWebBudgetInput,
  IWebBudgetResult,
} from './web-budget/report.js';
export {
  checkWebBudget,
  formatBytes,
  formatWebBudgetReport,
  formatWebBudgetSummary,
  reportIsFresh,
} from './web-budget/report.js';
