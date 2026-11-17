---
title: only-built-dependencies-have-scripts
description: onlyBuiltDependencies and ignoredBuiltDependencies name exactly the installed packages that have a build step, each in one list.
---

**Category:** supply-chain · **CI-critical:** yes · **Factory:** `createOnlyBuiltDependenciesHaveScriptsRule`

pnpm's two build-script lists name exactly the installed packages that have a build step, each in
one list.

## Why

With `strictDepBuilds` on, an install fails when a package with a build step is in neither list, so
that half guards itself. The other half does not: a name that stays in `onlyBuiltDependencies` after
its package dropped its script, or left the tree, is a standing permission for whatever script a
later version of it ships, and nothing ever says so.

## Options

None.

```ts
createOnlyBuiltDependenciesHaveScriptsRule();
```

The lists are read from the root `package.json`'s `pnpm` block and from `pnpm-workspace.yaml`.

## What it reports

The rule reads what is installed (`node_modules/.pnpm`, so run it after `pnpm install`) and reports:

1. a listed name that is not installed, or none of whose installed versions has a build step;
2. a name in both lists;
3. an installed package with a build step that is in neither list (strictDepBuilds would fail the
   install for it; this says which one, and catches a tree installed before the setting);
4. a build setting the rule does not read (`allowBuilds`, `neverBuiltDependencies`,
   `onlyBuiltDependenciesFile`), a list entry it cannot read, and a tree with nothing installed.
   None of these is a pass.

A build step is what pnpm counts: a `preinstall`, `install` or `postinstall` script, a `binding.gyp`
(pnpm then runs `node-gyp rebuild`), or files under `.hooks/`.

```
[ERROR] only-built-dependencies-have-scripts (package.json): "esbuild" is in onlyBuiltDependencies but no installed version has a preinstall, install or postinstall script, a binding.gyp or .hooks/ (0.25.0). Remove the entry: it would let a script a later version adds run unreviewed.
```

## Fixing it

Remove stale entries. For a package with a new build step, read the script, then file it under
`onlyBuiltDependencies` (it runs) or `ignoredBuiltDependencies` (it never does).

A platform package installed only on another OS is not in this machine's store, so a listed one
reads as not installed here: keep such packages out of the lists.
