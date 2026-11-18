/*
 * `@noctcore/harness/pinned-tools`: run a linter at exactly its pinned version,
 * natively or through its image by digest, and install the pinned linux
 * binaries in CI after checking each sha256. Pure functions take their I/O as
 * deps; the `node*Deps` functions are the real ones.
 */
export type { IFetchDeps } from './pinned-tools/fetch.js';
export { fetchPinned } from './pinned-tools/fetch.js';
export type {
  GitleaksRoute,
  IGitleaksDeps,
  IGitleaksOptions,
  IGitleaksResult,
  IGitleaksRunDeps,
} from './pinned-tools/gitleaks.js';
export {
  chooseGitleaksRoute,
  GITLEAKS_CONFIG,
  GITLEAKS_VERSION_VARIABLE,
  gitleaksArgs,
  imageVersion,
  pinnedGitleaksVersion,
  runGitleaks,
} from './pinned-tools/gitleaks.js';
export type {
  IHadolintConfig,
  IHadolintDeps,
  IHadolintFinding,
  IHadolintOptions,
} from './pinned-tools/hadolint.js';
export {
  chooseHadolintRoute,
  dockerfileProblems,
  dockerfiles,
  HADOLINT_CONFIG,
  hadolintArgs,
  hadolintDockerArgs,
  parseHadolintReport,
  readHadolintConfig,
  runHadolint,
} from './pinned-tools/hadolint.js';
export type { INodeFetchOptions, INodeRunOptions } from './pinned-tools/node.js';
export {
  DOCKER_COMMAND,
  dockerAvailable,
  gitTrackedFiles,
  migrationDirsUnder,
  nodeCapturedDeps,
  nodeFetchDeps,
  nodeGitleaksDeps,
  nodeHadolintDeps,
  nodeRunDeps,
  nodeSquawkDeps,
  nodeTrivyScanDeps,
  readRepoFile,
  spawnCaptured,
  workflowFilesUnder,
} from './pinned-tools/node.js';
export type {
  IImagePin,
  ILinterPin,
  IPinnedTool,
  IReleaseArchive,
  IToolPin,
  LinuxArch,
  WorkflowLinterId,
} from './pinned-tools/pins.js';
export {
  ACTIONLINT,
  GITLEAKS_IMAGE,
  HADOLINT,
  SHELLCHECK,
  SQUAWK,
  TRIVY,
  WORKFLOW_LINTER_TOOLS,
  WORKFLOW_LINTERS,
  ZIZMOR,
} from './pinned-tools/pins.js';
export type { IPlaceIo } from './pinned-tools/place-binary.js';
export { nodePlaceIo, placeBinary } from './pinned-tools/place-binary.js';
export type {
  ILinterResult,
  IRouteDeps,
  IRunDeps,
  LinterRoute,
  LinterStatus,
} from './pinned-tools/route.js';
export {
  chooseRoute,
  dockerRunArgs,
  exitCodeFor,
  lintArgs,
  linterVerdict,
  parseVersion,
  runLinter,
} from './pinned-tools/route.js';
export type {
  IMigrationDir,
  IMigrationSelection,
  ISquawkBaseline,
  ISquawkDeps,
  ISquawkFinding,
  ISquawkOptions,
} from './pinned-tools/squawk.js';
export {
  baselineSeal,
  chooseSquawkRoute,
  findDirectives,
  MIGRATION_FILE,
  migrationPath,
  migrationProblems,
  parseSquawkReport,
  runSquawk,
  selectMigrations,
  SQUAWK_CONFIG,
  SQUAWK_CONFIG_KEYS,
  squawkArgs,
  squawkConfigProblems,
  squawkDockerArgs,
  squawkSha256,
} from './pinned-tools/squawk.js';
export type {
  CapturedRun,
  ICapturedRunDeps,
  ISpawned,
  IToolCanary,
  IToolResult,
} from './pinned-tools/tool-run.js';
export { canaryProblems, chooseToolRoute, runCaptured } from './pinned-tools/tool-run.js';
export type {
  ITrivyIgnoreEntry,
  ITrivyIgnoreFile,
  ITrivyImage,
  ITrivyOptions,
  ITrivyPaths,
  ITrivySbomCanary,
  ITrivyScanDeps,
  ITrivyScanOptions,
  ITrivyScanResult,
  ITrivySecret,
  ITrivyVulnerability,
  TrivyFinding,
  TrivyIgnoreSection,
  TrivyScanTarget,
} from './pinned-tools/trivy.js';
export {
  chooseTrivyRoute,
  classifyTrivyFailure,
  describeTrivyFinding,
  failingFindings,
  osCoverageProblem,
  parseTrivyReport,
  readTrivyIgnoreFile,
  renderTrivyIgnoreFile,
  sbomCanaryProblem,
  scanImages,
  secretCanaryProblem,
  secretCanaryToken,
  TRIVY_CONFIG_FILES,
  TRIVY_CONTAINER_PATHS,
  TRIVY_EMPTY_CONFIG,
  TRIVY_IGNORE_FILE,
  TRIVY_MAX_IGNORE_DAYS,
  TRIVY_SECRET_CANARY_RULE,
  TRIVY_SEVERITY_FLOOR,
  trivyDockerArgs,
  trivyScanArgs,
  trivyScanEnv,
} from './pinned-tools/trivy.js';
