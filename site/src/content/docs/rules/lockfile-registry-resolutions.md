---
title: lockfile-registry-resolutions
description: Every package in the pnpm v9 lockfile resolves from the registry with a sha512 integrity hash, with no git, tarball URL or directory source.
---

**Category:** supply-chain · **CI-critical:** yes · **Factory:** `createLockfileRegistryResolutionsRule`

Every package in the pnpm lockfile resolves from the registry and carries the sha512 hash pnpm checks
the download against.

## Why

pnpm's `blockExoticSubdeps` and `trustPolicy` are judged only while pnpm resolves a dependency. An
entry already in the lockfile is skipped, so a frozen install (CI, a Docker deps stage, a git hook)
never checks either again. A git or tarball source that reached the lockfile on one machine would
install everywhere else without a word. This rule reads the lockfile itself, offline, so that entry
is red on every run.

## Options

| Option | Default | What it does |
|---|---|---|
| `lockfile` | `pnpm-lock.yaml` | The lockfile, relative to the repo root. |

```ts
createLockfileRegistryResolutionsRule();
createLockfileRegistryResolutionsRule({ lockfile: 'apps/web/pnpm-lock.yaml' });
```

## What it reports

In the `packages:` section, every entry must have one `resolution: {integrity: sha512-...}` line.
The rule reports:

1. a resolution from a git repository (`type: git`), a tarball URL (`tarball:`, even beside an
   integrity hash) or a local directory (`directory:`);
2. an entry with no sha512 integrity, an entry with no resolution line, and an entry with two;
3. a lockfile it cannot read: none at all, a `lockfileVersion` other than `9.0`, no `packages:`
   section, or a line under `packages:` that is not a bare `name@version:` key.

A tarball URL fails even with an integrity hash: a tarball on the registry's own host passes
`blockExoticSubdeps`, and a second registry for one scope writes the same shape.

Workspace packages are not in `packages:` (the importers link them with `link:`), so they are never
reported. A **direct** dependency from git or a tarball URL is reported too, although pnpm allows
it: adopting one should be a decision that changes this rule's config, not a line that slips in.

```
[ERROR] lockfile-registry-resolutions (pnpm-lock.yaml): "left-pad@1.3.0" resolves from a git repository. Every package must come from the registry with an integrity hash; a frozen install never re-checks blockExoticSubdeps.
```

## Fixing it

Replace the dependency with a registry release, or publish the fork to your registry. A different
`lockfileVersion` means pnpm changed its format: check how the new format writes a resolution before
updating the rule.
