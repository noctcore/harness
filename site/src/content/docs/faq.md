---
title: FAQ
description: Common questions about @noctcore/harness.
---

## Why not just put these commands in a CI workflow?

You can, and many repos do. The manifest buys three things a workflow file does not: the same list
runs locally (`npx harness check`) and in any CI, not only GitHub Actions; every check runs even
after one fails, so a single run shows the whole failure set; and a check that could not run, such
as a timeout or a missing program, is a failure with a reason instead of a skipped step.

## What does `.nightcore` mean? Do I need another tool?

No. `.nightcore/` is the directory the runner reads by convention: the manifest at
`.nightcore/harness.json`, the registry at `.nightcore/lint-meta/registry.mts` and baselines under
`.nightcore/lint-meta/baselines/`. The names come from Nightcore, the noctcore desktop studio the
runner was first written for; nothing else needs to be installed. `--manifest` and `--registry`
point at files anywhere in the repo.

## Why can't my command use a pipe or `&&`?

The runner splits the command on whitespace and spawns it without a shell, so what runs is exactly
what the manifest says on every OS. Commit a script for anything that needs a shell and point the
check at it.

## How is lint-meta different from ESLint?

ESLint checks one JavaScript or TypeScript file at a time. A lint-meta rule reads the whole repo:
workflow YAML, the lockfile, `package.json` files, and contracts between files. Use both: ESLint for
code, lint-meta for the repo.

## Does it run on Windows?

Yes. CI runs the whole suite on Windows and on Linux under Node 22. Repo-relative paths in reports
use `/` on every OS, and text is read with line endings normalized. The pinned-tools installer
(`fetchPinned` with `nodeFetchDeps`) is linux only, since it installs linux binaries for CI; on a
Mac or Windows machine the image route needs nothing but Docker.

## Does it work with npm, yarn or Bun repos?

The runner, the lint-meta engine, the catalog and the pinned tools work in any repo. Four of the six
ready-made rules read pnpm files (the v9 lockfile, the build-script lists, `patchedDependencies`);
the two GitHub Actions rules work with any package manager.

## Does the package make any network call?

No. A test scans the built entry points for network imports and `fetch(`. The pinned-tools installer
needs to download binaries, so it takes the download function from your repo instead of making the
call itself.

## Can a repo weaken a rule and still pass?

Yes. The runner enforces whatever checks and rules are committed; it does not attest that they match
anything. A weakened rule is enforced in its weakened form. The control against that is review of
the diff, the same as for any other CI config.

## Why does a blocked linter fail CI? It did not find anything.

Because it did not check anything either. A check that could not run is never a pass. Install the
pinned binary, start Docker, or run `fetchPinned` in CI; the blocked reason says which.

## How do I report a security problem?

Privately, as [SECURITY.md](https://github.com/noctcore/harness/blob/main/SECURITY.md) describes.
Never in a public issue.
