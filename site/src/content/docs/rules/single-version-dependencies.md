---
title: single-version-dependencies
description: Each listed package resolves to exactly one version in the pnpm lockfile, with no exception list.
---

**Category:** supply-chain · **CI-critical:** yes · **Factory:** `createSingleVersionDependenciesRule`

The packages you list must each resolve to exactly one version in the pnpm lockfile.

## Why

Two copies of some packages is a defect, not drift: two compilers type-check a repo differently, two
ORM clients disagree with their engine, two Reacts break hooks at runtime, two ESLints load plugins
against the wrong core. The repo names those packages. The list carries no exception, so add a
package only once it resolves once.

## Options

| Option | Default | What it does |
|---|---|---|
| `packages` | required | The package names that must resolve once. At least one; an empty list throws. |
| `lockfile` | `pnpm-lock.yaml` | The lockfile, relative to the repo root. |

```ts
createSingleVersionDependenciesRule({
  packages: ['typescript', 'react', 'react-dom', 'eslint', '@prisma/client'],
});
```

## What it reports

- A listed package with more than one version in the `packages:` section. One version under several
  peer sets counts as one version.
- A listed package the lockfile does not hold at all: a stale entry passes nothing.
- A lockfile that is missing or has no `packages:` section.

```
[ERROR] single-version-dependencies (pnpm-lock.yaml): "typescript" resolves to 2 versions in pnpm-lock.yaml (5.9.3, 6.0.3). Align every range that reaches it (a devDependency pin for an auto-installed peer, the same range in every manifest) so one version remains.
```

## Fixing it

Use the same range in every manifest that depends on the package, and pin a peer that pnpm installs
on its own as a devDependency at the root. Remove a package from the list only when the repo no
longer depends on it.
