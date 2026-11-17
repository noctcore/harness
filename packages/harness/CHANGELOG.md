# @noctcore/harness

## 0.5.0

### Minor Changes

- [#4](https://github.com/noctcore/harness/pull/4) [`581615d`](https://github.com/noctcore/harness/commit/581615d3b4d7a36669348332afd92a18861f4864) Thanks [@Shironex](https://github.com/Shironex)! - Add `@noctcore/harness/pinned-tools`: run a linter at exactly its pinned version, natively when the binary on `PATH` reports the pin, else through its image by digest, else blocked with exit 2 (a check that could not run is never a pass).
  
  - `runLinter` with the default `ZIZMOR` and `ACTIONLINT` pins (actionlint needs `SHELLCHECK`) lints `.github/workflows`.
  - `runGitleaks` scans full history at the version CI installs (`pinnedGitleaksVersion` reads it from a workflow), falling back to `GITLEAKS_IMAGE` only when its tag names that version.
  - `fetchPinned` installs the pinned linux x64 or arm64 release assets in CI, refusing any whose sha256 or reported version is not the pin; `placeBinary` replaces an existing symlink instead of writing through it.
  - `nodeRunDeps`, `nodeGitleaksDeps` and `nodeFetchDeps` are the real I/O. `nodeFetchDeps` takes the `download` function from the caller, so the package still makes no network call.

## 0.4.0

### Minor Changes

- [#5](https://github.com/noctcore/harness/pull/5) [`ff01be1`](https://github.com/noctcore/harness/commit/ff01be1056869585bc539db5c50124fad05262c4) Thanks [@Shironex](https://github.com/Shironex)! - Export `portableFileGlob` from the package root: the glob behind the runner's `ctx.glob`, for a repo whose own lint tooling builds its ctx. It follows Node's `fs.globSync` rules under both Node and Bun (whose `globSync` cannot see a dot-directory such as `.github`), returns files only, sorted, and throws on syntax it does not implement instead of matching nothing.

- [#3](https://github.com/noctcore/harness/pull/3) [`2460341`](https://github.com/noctcore/harness/commit/2460341e8224f93819a956f1d0a7f3dafe7e87d9) Thanks [@Shironex](https://github.com/Shironex)! - Add `@noctcore/harness/rules`: generic, configurable lint-meta rules a repo adds to its own registry next to its local ones. Six rules ship, each strict (`ciCritical`, no baseline):
  
  - `lockfile-registry-resolutions`: every package in the pnpm lockfile resolves from the registry with a sha512 integrity hash.
  - `single-version-dependencies`: each listed package resolves to exactly one version.
  - `only-built-dependencies-have-scripts`: `onlyBuiltDependencies` and `ignoredBuiltDependencies` name exactly the installed packages with a build step.
  - `pnpm-patch-ledger`: every patched dependency has a ledger entry with a reason, an upstream link, a removal condition and a review date that has not passed.
  - `github-actions-secret-no-install`: a workflow job that can read a stored secret runs no package install.
  - `github-actions-security-no-cancel`: a security workflow never cancels a run.
  
  A config that would check nothing makes the factory throw, so the registry fails to load instead of passing quietly.
  
  CommonJS consumers now get the `.d.cts` declarations: each `exports` entry names its own `types` under `import` and `require`.

## 0.3.0

- Async lint-meta rules: a rule declares `run`, `runAsync`, or both.
- `catalog` renders a registry's Markdown rule catalog, and `catalog --check` fails when it is stale.
- `ctx.glob` returns files only, and a run that could not finish says so in its summary.
- A walker with Node's glob rules under Bun, whose `globSync` misses dot-directory paths.

## 0.2.0

- `lint-meta --registry` and `check --manifest` point at a committed bundle, and fail closed when
  the named file is missing.
- TypeScript rule registries load through Node's own type stripping (Node 22.18 or later).

## 0.1.0

- The portable Structure-Lock runner: `npx @noctcore/harness check` runs a repo's
  `.nightcore/harness.json` checks in any CI.
- The `lint-meta` subcommand and the published `IMetaRule` contract.
