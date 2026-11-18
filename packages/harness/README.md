# @noctcore/harness

A **portable Structure-Lock runner**. It reads a repo's `.noctcore/harness.json` and runs each
declared check, reddening the build on any violation — so a project's structure lock is enforced in
its **own CI**, with no Nightcore install, no server, and no account.

```bash
npx @noctcore/harness check
```

Run it from the repo root (or pass `--dir <path>`). If there is no `.noctcore/harness.json`, the
runner exits `0` — the lock is opt-in-by-presence.

## What it does

For every enabled check that declares a `command`, the runner prints the command, runs it in the
target directory (bounded by the check's `timeoutMs`, default 5 minutes), and records the outcome.
It runs **all** checks (it does not stop at the first failure), so one CI run shows the whole
failure set. It exits `0` when every check passed and `1` when any failed (printing a fix
instruction that lists each failed check with its command and captured output). `--json` emits a
machine-readable result to stdout instead.

```
harness [check] [--dir <path>] [--manifest <path>] [--json] [--version] [--help]
harness lint-meta [--dir <path>] [--registry <path>]
harness catalog [--dir <path>] [--registry <path>] [--out <path>] [--check]
```

## Sync and async rules

A lint-meta rule declares `run(ctx)`, `runAsync(ctx)`, or both. Use `runAsync` when the check needs
an async API, such as ESLint's `calculateConfigForFile`:

```ts
import type { IMetaCtx, IMetaRule, IViolation } from '@noctcore/harness';

export const eslintConfigNoWarn: IMetaRule = {
  id: 'eslint-config-no-warn',
  category: 'config',
  ciCritical: true,
  description: 'ESLint severities must be "error" or "off", not "warn".',
  async runAsync({ root }: IMetaCtx): Promise<IViolation[]> {
    return checkResolvedConfigs(root);
  },
};
```

Rules run one at a time, in registry order. When a rule has both entry points, `run` goes first and
both report. A rejected `runAsync` is treated exactly like a throwing `run`: it is a critical failure
reported against that rule, and every later rule still runs. An object with neither entry point is
not a rule, and a registry that exports one fails to load.

## Generic rules (`@noctcore/harness/rules`)

The package also ships ready-made lint-meta rules for checks most repos want and ESLint cannot
reach. Each is a factory that takes the repo-specific parts as options and returns a strict rule
(`ciCritical: true`, no baseline). Install the package as a devDependency and add the rules to your
registry next to your own:

```ts
import type { IMetaRule } from '@noctcore/harness';
import {
  createGithubActionsSecretNoInstallRule,
  createLockfileRegistryResolutionsRule,
  createSingleVersionDependenciesRule,
} from '@noctcore/harness/rules';

import { myRepoRule } from './rules/my-repo-rule';

export const META_RULES: IMetaRule[] = [
  createLockfileRegistryResolutionsRule(),
  createSingleVersionDependenciesRule({ packages: ['typescript', 'react', 'react-dom'] }),
  createGithubActionsSecretNoInstallRule({
    exemptSecrets: [{ secret: 'CACHE_TOKEN', reason: 'the build cache credential; read-only on PRs' }],
  }),
  myRepoRule,
];
```

| Rule id | Category | Options | What it holds |
|---|---|---|---|
| `lockfile-registry-resolutions` | supply-chain | `lockfile` | Every package in the pnpm v9 lockfile resolves from the registry with a sha512 integrity hash: no git, tarball URL or directory source. |
| `single-version-dependencies` | supply-chain | `packages` (required), `lockfile` | Each listed package resolves to exactly one version in the lockfile. |
| `only-built-dependencies-have-scripts` | supply-chain | none | `onlyBuiltDependencies` and `ignoredBuiltDependencies` name exactly the installed packages that have a build step. |
| `pnpm-patch-ledger` | supply-chain | `ledger`, `lockfile`, `now` | Every `patchedDependencies` entry has a ledger entry with a reason, an upstream link, a removal condition and a `reviewBy` date that has not passed; the patch file hashes to what the lockfile records. |
| `github-actions-secret-no-install` | ci | `exemptSecrets` | A workflow job that can read a stored secret runs no package install. |
| `github-actions-security-no-cancel` | ci | `securityWorkflowName` | A security workflow never cancels a run or lets a new run replace a pending one. |

A config that would check nothing (an empty package list, an exemption with no reason) makes the
factory throw, so the registry fails to load instead of passing quietly. `RULE_IDS` lists every id
the subpath ships; a repo keeping a local rule should not reuse one.

The rules read the repo through the `IMetaCtx` the runner hands them, plus `node:fs` for the two
that inspect what is installed (`node_modules/.pnpm`) or hash a patch file. Like the rest of the
package they use `node:*` builtins only and make no network call.

## Pinned tools (`@noctcore/harness/pinned-tools`)

A check that shells out to a linter is only as stable as the linter's version: a newer zizmor or
actionlint brings new rules and turns a green repo red on nobody's change. This subpath runs a tool
at exactly its pinned version and refuses anything else:

1. a native binary on `PATH` that reports exactly the pinned version (and every tool it `needs`);
2. else the tool's image, pinned by index digest, when a Docker daemon answers;
3. else **blocked**, exit 2. A check that could not run is never a pass.

In CI, `fetchPinned` installs the pinned linux release assets first (x64 runners and arm64 `act`),
refusing any whose sha256 or reported version is not the pin, so route 1 runs with no Docker.

```ts
import { exitCodeFor, nodeRunDeps, runLinter, WORKFLOW_LINTERS } from '@noctcore/harness/pinned-tools';

const result = runLinter(WORKFLOW_LINTERS.actionlint, process.cwd(), nodeRunDeps());
console.log(`actionlint: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status)); // 0 passed, 1 failed, 2 blocked
```

| Export | What it does |
|---|---|
| `ZIZMOR`, `ACTIONLINT`, `SHELLCHECK`, `WORKFLOW_LINTERS`, `WORKFLOW_LINTER_TOOLS`, `HADOLINT`, `SQUAWK`, `TRIVY` | The default pins: version, image by digest, linux assets by sha256. |
| `runLinter(pin, root, deps)` | Lint `.github/workflows` with a workflow linter, by the route above. |
| `runGitleaks(version, root, deps, options)` | A full-history gitleaks scan at the version CI installs (`pinnedGitleaksVersion` reads it from a workflow), else `GITLEAKS_IMAGE` when its tag names that version. A worktree, whose `.git` the image cannot follow, needs the native binary. |
| `runHadolint(root, deps, options)` | hadolint over every Dockerfile git tracks, plus the repo's canaries: the configuration is read strictly first (`failure-threshold: style`, pragmas off, every ignored rule with a reason), and a `# hadolint` pragma in a Dockerfile fails before hadolint runs. |
| `runSquawk(root, deps, options)` | squawk over every migration outside a sealed baseline (a ratchet by design), plus the repo's canaries. Squawk directives, bare carriage returns and `standard_conforming_strings` fail before squawk runs; `inspect` adds the repo's own checks of a migration's text. |
| `scanImages(images, deps, options)` | trivy over `docker save` tarballs for advisories at or above a severity floor that have a fix, and for secrets, after an SBOM canary and a secret canary. `readTrivyIgnoreFile` holds every ignore to a statement and an expiry. |
| `fetchPinned(tools, arch, dir, deps)` | Install pinned linux assets after checking each sha256, then require the pinned version. |
| `placeBinary(bytes, name, dir, token)` | Put a binary in place through a staged file and a rename, so an existing symlink is replaced, never written through. |
| `nodeRunDeps({ docker })`, `nodeGitleaksDeps(root)`, `nodeHadolintDeps()`, `nodeSquawkDeps()`, `nodeTrivyScanDeps()`, `nodeFetchDeps({ download })` | The real I/O for the functions above. `docker` (also accepted by `nodeGitleaksDeps(root, { docker })`) names another container CLI for every call: the probes, the pull and the run (default `docker`); the hadolint, squawk and trivy deps take it too. |

Every function takes its I/O as deps, so a repo tests its own wiring without spawning anything. A
repo that needs another version passes its own pin; moving a default pin is a minor release. Like
the rest of the package this subpath makes no network call: `nodeFetchDeps` takes the `download`
function from the caller, so the one fetch lives in the consuming repo.

## CI helpers (`@noctcore/harness/ci`)

Three decisions a CI pipeline makes around its checks, as pure functions over injected git and
GitHub lookups. The package makes no network call: your repo asks the GitHub API for the last
successful push run and hands the answer in.

```ts
import { affectedEnvLines, decideAffectedBase, nodeCiGitDeps, nodeIsWorkspace } from '@noctcore/harness/ci';

const git = nodeCiGitDeps(process.cwd());
const decision = await decideAffectedBase(
  { event: process.env.GITHUB_EVENT_NAME ?? '', prBaseSha: process.env.PR_BASE_SHA ?? '', before: '' },
  { ...git, lastGreenPushSha, isWorkspace: nodeIsWorkspace(process.cwd()) },
);
console.log(decision.reason);
console.log(affectedEnvLines(decision).join('\n')); // TURBO_SCM_BASE=..., TURBO_AFFECTED=--affected
```

| Export | What it does |
|---|---|
| `chooseBase(input, deps)`, `affectedBaseFrom(chosen, deps, options)`, `decideAffectedBase(input, deps, options)` | The base a filtered run diffs against: a pull request's base, or on push the head of the last successful push run when it is an ancestor of HEAD. Every doubt (no green run, a throwing lookup, an unreadable diff, a change outside a workspace under `workspaceRoots`) is a full run. |
| `outsideWorkspaces(paths, isWorkspace, options)`, `headShaOfLatestRun(body)`, `affectedEnvLines(decision, options)` | The changed paths a workspace filter cannot see, the head sha in a GitHub list-workflow-runs response, and the `GITHUB_ENV` lines (variable names are options). |
| `commitRange(input, chosen, isAncestor)` | The commits a run lints: base to head on a pull request, the green base (else the pushed range) to HEAD on push, HEAD alone otherwise. |
| `lintPlan(range, inRange, messageOf, exempt)`, `exemptionsFor(event, exempt)`, `exemptionProblems(exempt)` | Skip a listed exempt commit (full sha, reason and recorded message) and lint the rest one by one; a pull request uses no exemption, and a malformed list or a changed message refuses the run. |
| `runCommitlint(options, deps)` | Run the commitlint command you pass over the plan, printing each command first; exit 0 or 1. |
| `collectDueEntries(sources, options)`, `dueReport(collection, today, options)`, `formatDueReport(report, total, options)`, `daysLeft(today, due)` | Dated ledger entries (`reviewBy` by default) and trivy `expired_at` dates: list those due within `listDays` (14), fail those within `failDays` (7, or `-1` for lapsed only), and fail any undated entry. |
| `nodeCiGitDeps(cwd)`, `nodeIsWorkspace(cwd)`, `nodeSpawnInherit(cwd)`, `readDueSources(cwd, ledgers, trivyIgnore)` | The real I/O for the functions above. |

The workflow files, job names, the GitHub lookup, the exempt commit list, the ledger files and the
scheduled due-date job stay in your repo: a due date turns red on a calendar day, so only a
scheduled workflow that your repo wires catches it.

## Web bundle budgets (`@noctcore/harness/web-budget`)

Hold a Vite build to the budgets your repo commits. The manifest is read defensively (a wrong
type, a missing `file` or an empty manifest fails the check), each route is weighed cold and beyond
the shell, and every failure says what to do next.

```ts
import { readFileSync } from 'node:fs';

import { checkWebBudget, formatWebBudgetSummary, nodeManifestDeps, nodeSizeOf, readViteManifest } from '@noctcore/harness/web-budget';

const result = checkWebBudget({
  manifest: readViteManifest('dist/.vite/manifest.json', nodeManifestDeps),
  sizeOf: nodeSizeOf('dist', 'gzip'),
  budgets: JSON.parse(readFileSync('budgets.json', 'utf8')),
});
console.log(formatWebBudgetSummary(result).join('\n'));
process.exit(result.passed ? 0 : 1);
```

| Export | What it does |
|---|---|
| `parseViteManifest(raw)`, `parseViteManifestText(text)`, `readViteManifest(path, deps)` | Read the Vite manifest, type-checking every field it uses and ignoring unknown ones; any problem fails the check. |
| `buildGraph(manifest, sizeOf, options)`, `staticClosure(chunks, start)` | Static closures, the shell (every `isEntry` chunk, or `shellEntries`), and each route's cold and beyond-shell weight, each file counted once. |
| `parseWebBudgets(raw)`, `checkBudgets(graph, budgets)`, `matchesPattern(pattern, path)` | Shell, route (`cold`, `beyondShell`) and per-file budgets; an over-budget weight, a stale route or pattern, and an invalid budget all fail. |
| `findDeadImports(graph, { allow })` | Dynamic imports whose target is already loaded (statically or by the shell) or missing; each allowed one needs a written reason. |
| `checkWebBudget(input)`, `formatWebBudgetReport(result)`, `formatWebBudgetSummary(result)`, `reportIsFresh(committed, rendered)` | Everything in one call, a deterministic Markdown report to commit, and the freshness check (CRLF equals LF). |
| `checkPrecompressed(options, deps)`, `formatPrecompressReport(report)` | Every file the server serves compressed (by extension, at least `minBytes`) has a non-empty, fresh sibling per encoding (`br`, `gz`). |
| `nodeManifestDeps`, `nodeReadText(path)`, `nodeSizeOf(dir, measure)`, `nodePrecompressDeps` | The real I/O; sizes are raw, gzip (default) or brotli bytes. |

The budgets file, the manifest path and the web server paths stay in your repo. Raising a budget
needs a written reason in a reviewed change: the module never writes the budgets file and has no
tolerance or override, so there is no way to raise a budget silently.

## Rule catalog (`catalog`)

`harness catalog` renders a Markdown table of every rule in the registry: id, category, whether it
is CI-critical (a violation reds the build), and its description. It is generated from the registry,
so it cannot drift from what `lint-meta` enforces.

```bash
npx @noctcore/harness catalog                     # write RULES.md beside the registry
npx @noctcore/harness catalog --out docs/RULES.md # or anywhere, relative to --dir
npx @noctcore/harness catalog --check             # the gate: exit 1 + a diff when stale
```

The generated table sits between `<!-- harness:rule-catalog:start -->` and
`<!-- harness:rule-catalog:end -->`. If the file already has both markers, only the text between
them is replaced, so hand-written sections around the table survive. `--check` writes nothing; it
exits `1` when the committed file is missing or differs from what would be generated, and prints the
changed lines. The catalog only imports the registry; it never runs a rule.

## Pointing it at a bundle (`--manifest` / `--registry`)

A Nightcore **portable-lock bundle** commits its own command-translated manifest, so CI reads that
one file instead of the repo's default manifest:

```bash
npx @noctcore/harness check --manifest .nightcore/export/portable-lock/harness.json
```

The default paths are **opt-in-by-presence** (absent ⇒ exit `0`), but an **explicitly named**
manifest or registry is **fail-closed**: if the file you pointed at is missing (or the manifest is
unparseable), the runner exits `1`. A portable lock must never pass because the thing it was told to
enforce went missing.

## Moving from `.nightcore/`

Before 0.6 the runner read `.nightcore/`; the default is now `.noctcore/`. Move it with
`git mv .nightcore .noctcore`. Until 1.0 the runner still falls back to the old location for the
manifest, the registry and default-home baselines, printing one deprecation warning per file it
reads there. If a file exists in both places the run stops with exit `1` and names both, instead of
picking one. Paths you pass explicitly (`--manifest`, `--registry`, `--out`, a `baselineDir`) are
read as given. The locations are exported (`MANIFEST_RELATIVE_PATH`,
`DEFAULT_REGISTRY_RELATIVE_PATHS`, `DEFAULT_BASELINE_DIR` and their `LEGACY_*` counterparts).

## TypeScript rule registries

`lint-meta` loads a TypeScript registry as happily as a `.js` one — Nightcore's exporter emits
`registry.mts` and copies your generated rule files **verbatim** (it is deterministic Rust and never
shells out to a transpiler). The type stripping happens here, in the runner, using **Node's own**
(unflagged since Node 22.18) — which is why this package still has zero runtime dependencies. The
default registry lookup tries `.noctcore/lint-meta/registry.mts`, then `…/registry.ts`, then
`…/registry.js`.

Two requirements for a TypeScript registry: **Node ≥ 22.18**, and an ES-module scope. `.mts` (what
the exporter writes) is always an ES module; a plain `.ts` one is only ESM if the nearest
`package.json` says `"type": "module"`. Exported rules may only `import type` from `@noctcore/harness`: a
value import would have to resolve at run time, and nothing is installed in the target repo. A repo
that installs the package itself may import the `@noctcore/harness/rules` factories as values.

## What it is NOT

- **Not a SaaS or telemetry.** The runner makes zero network calls at run time. Everything it reads
  is committed in your repo. It has zero runtime dependencies.
- **Not an integrity attestation.** It enforces **whatever checks are present** in your
  `.noctcore/harness.json` and your committed rule files. It does **not** verify that those files
  match what Nightcore originally generated — the artifacts are yours to edit. A weakened rule is
  enforced in its weakened form. The control against silent weakening is **PR review of the diff**
  (a re-export or a hand-edit shows up in `git diff`), not a signature or hash check.

The `command` strings in `.noctcore/harness.json` are executed. In your own CI this is the same
trust level as any `package.json` script or workflow step — your own committed, PR-reviewed config.
The runner prints every command before running it so a reviewer reading CI logs sees exactly what
executed.

## Requirements

Node ≥ 22 (≥ 22.18 to load a TypeScript rule registry, which needs native type stripping).
