---
'@noctcore/harness': minor
---

Add `@noctcore/harness/rules`: generic, configurable lint-meta rules a repo adds to its own registry next to its local ones. Six rules ship, each strict (`ciCritical`, no baseline):

- `lockfile-registry-resolutions`: every package in the pnpm lockfile resolves from the registry with a sha512 integrity hash.
- `single-version-dependencies`: each listed package resolves to exactly one version.
- `only-built-dependencies-have-scripts`: `onlyBuiltDependencies` and `ignoredBuiltDependencies` name exactly the installed packages with a build step.
- `pnpm-patch-ledger`: every patched dependency has a ledger entry with a reason, an upstream link, a removal condition and a review date that has not passed.
- `github-actions-secret-no-install`: a workflow job that can read a stored secret runs no package install.
- `github-actions-security-no-cancel`: a security workflow never cancels a run.

A config that would check nothing makes the factory throw, so the registry fails to load instead of passing quietly.

CommonJS consumers now get the `.d.cts` declarations: each `exports` entry names its own `types` under `import` and `require`.
