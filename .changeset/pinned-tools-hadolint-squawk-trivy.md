---
'@noctcore/harness': minor
---

Add hadolint, squawk and trivy to `@noctcore/harness/pinned-tools`, each with a default pin (`HADOLINT` 2.15.1, `SQUAWK` 2.67.0, `TRIVY` 0.75.0) that a repo can replace with its own through the `pin` option.

- `runHadolint(root, deps, options)` lints every Dockerfile git tracks plus the repo's canaries. It reads `.hadolint.yaml` strictly first (`failure-threshold: style`, pragmas off, at least one trusted registry, a reason for every ignored rule) and fails a `# hadolint` pragma before hadolint runs.
- `runSquawk(root, deps, options)` lints every migration outside a sealed baseline plus the repo's canaries. The baseline (`selectMigrations`, `baselineSeal`, `squawkSha256`) is a ratchet by design: pinned by the sha256 of each file, it only loses members. Squawk directives, bare carriage returns and `standard_conforming_strings` fail before squawk runs, `.squawk.toml` may set only the keys the check knows, and `inspect` adds a repo's own checks of a migration's text.
- `scanImages(images, deps, options)` scans `docker save` tarballs with trivy for advisories at or above a severity floor that have a fix, and for secrets, after an SBOM canary and a secret canary. `readTrivyIgnoreFile` holds every ignore entry to a statement and an expiry at most 14 days out.
- `nodeHadolintDeps`, `nodeSquawkDeps`, `nodeTrivyScanDeps` and `nodeCapturedDeps` are the real I/O, and all of them take the `docker` option for another container CLI. `IImagePin` names a pin with an image; `ILinterPin` now extends it.

Nothing that already shipped changes behavior.
