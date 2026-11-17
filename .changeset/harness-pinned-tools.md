---
'@noctcore/harness': minor
---

Add `@noctcore/harness/pinned-tools`: run a linter at exactly its pinned version, natively when the binary on `PATH` reports the pin, else through its image by digest, else blocked with exit 2 (a check that could not run is never a pass).

- `runLinter` with the default `ZIZMOR` and `ACTIONLINT` pins (actionlint needs `SHELLCHECK`) lints `.github/workflows`.
- `runGitleaks` scans full history at the version CI installs (`pinnedGitleaksVersion` reads it from a workflow), falling back to `GITLEAKS_IMAGE` only when its tag names that version.
- `fetchPinned` installs the pinned linux x64 or arm64 release assets in CI, refusing any whose sha256 or reported version is not the pin; `placeBinary` replaces an existing symlink instead of writing through it.
- `nodeRunDeps`, `nodeGitleaksDeps` and `nodeFetchDeps` are the real I/O. `nodeFetchDeps` takes the `download` function from the caller, so the package still makes no network call.
