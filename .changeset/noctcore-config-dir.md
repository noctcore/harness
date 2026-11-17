---
'@noctcore/harness': minor
---

Read the manifest, the lint-meta registry and default-home baselines from `.noctcore/` instead of `.nightcore/`, a name left over from when the runner lived inside the Nightcore app. `harness check` now reads `.noctcore/harness.json`, `lint-meta` and `catalog` look for `.noctcore/lint-meta/registry.{mts,ts,js}`, and `DEFAULT_BASELINE_DIR` is `.noctcore/lint-meta/baselines`.

Existing repos keep working: when only the `.nightcore/` file exists, the runner reads it and prints one deprecation warning naming the new path. The fallback goes away in 1.0, so move the directory with `git mv .nightcore .noctcore`. When a file exists in both places the run fails with exit 1 and names both, instead of picking one silently. Paths passed explicitly (`--manifest`, `--registry`, `--out`, a `baselineDir`) are read as given.

The locations are now exported from the package root: `CONFIG_DIR`, `MANIFEST_RELATIVE_PATH`, `DEFAULT_REGISTRY_RELATIVE_PATHS`, plus `LEGACY_CONFIG_DIR`, `LEGACY_MANIFEST_RELATIVE_PATH`, `LEGACY_REGISTRY_RELATIVE_PATHS` and `LEGACY_BASELINE_DIR`.
