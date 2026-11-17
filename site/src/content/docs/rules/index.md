---
title: Using the rules
description: The six ready-made lint-meta rules in @noctcore/harness/rules, how to add them to a registry, and what strict means for each.
---

`@noctcore/harness/rules` ships lint-meta rules for checks most repos want and ESLint cannot reach:
four on the pnpm lockfile and its build and patch settings, two on GitHub Actions workflows. Each is
a factory, `createXRule(options)`, that takes the repo-specific parts as options and returns an
`IMetaRule` you put in your registry next to your own rules.

```sh
npm install --save-dev @noctcore/harness
```

```ts title=".nightcore/lint-meta/registry.mts"
import type { IMetaRule } from '@noctcore/harness';
import {
  createGithubActionsSecretNoInstallRule,
  createGithubActionsSecurityNoCancelRule,
  createLockfileRegistryResolutionsRule,
  createOnlyBuiltDependenciesHaveScriptsRule,
  createPnpmPatchLedgerRule,
  createSingleVersionDependenciesRule,
} from '@noctcore/harness/rules';

export const META_RULES: IMetaRule[] = [
  createLockfileRegistryResolutionsRule(),
  createSingleVersionDependenciesRule({ packages: ['typescript', 'react', 'react-dom'] }),
  createOnlyBuiltDependenciesHaveScriptsRule(),
  createPnpmPatchLedgerRule(),
  createGithubActionsSecretNoInstallRule({
    exemptSecrets: [{ secret: 'CACHE_TOKEN', reason: 'the build cache credential; read-only on PRs' }],
  }),
  createGithubActionsSecurityNoCancelRule(),
];
```

The factories are value imports, so the package must be installed in the repo.

## The rules

| Rule id | Category | Options | What it holds |
|---|---|---|---|
| [`lockfile-registry-resolutions`](/harness/rules/lockfile-registry-resolutions/) | supply-chain | `lockfile` | Every package in the pnpm v9 lockfile resolves from the registry with a sha512 integrity hash: no git, tarball URL or directory source. |
| [`single-version-dependencies`](/harness/rules/single-version-dependencies/) | supply-chain | `packages` (required), `lockfile` | Each listed package resolves to exactly one version in the lockfile. |
| [`only-built-dependencies-have-scripts`](/harness/rules/only-built-dependencies-have-scripts/) | supply-chain | none | `onlyBuiltDependencies` and `ignoredBuiltDependencies` name exactly the installed packages that have a build step. |
| [`pnpm-patch-ledger`](/harness/rules/pnpm-patch-ledger/) | supply-chain | `ledger`, `lockfile`, `now` | Every patched dependency has a ledger entry with a reason, an upstream link, a removal condition and a review date that has not passed. |
| [`github-actions-secret-no-install`](/harness/rules/github-actions-secret-no-install/) | ci | `exemptSecrets` | A workflow job that can read a stored secret runs no package install. |
| [`github-actions-security-no-cancel`](/harness/rules/github-actions-security-no-cancel/) | ci | `securityWorkflowName` | A security workflow never cancels a run or lets a new run replace a pending one. |

## What strict means

- **Every rule is CI-critical** (`ciCritical: true`): a violation fails the run.
- **No baseline.** These hold properties that should be true in every repo from the start, so there
  is nothing to grandfather.
- **A config that would check nothing throws.** An empty package list or an exemption without a
  reason makes the factory throw, so the registry fails to load instead of passing quietly.
- **What it cannot read, it reports.** A lockfile line, a YAML block or a ledger entry the rule does
  not understand is a violation, never a skip.
- **Rule ids are public API.** `RULE_IDS` lists every id the subpath ships. Renaming one is a
  breaking change; a repo that keeps a local rule should not reuse one of these ids.

The rules read the repo through the `ctx` the runner hands them, plus `node:fs` for the two that
inspect what is installed (`node_modules/.pnpm`) or hash a patch file. Like the rest of the package
they use `node:*` builtins only and make no network call.

## Using a check without the rule

Two rules also export their check as a pure function over one file's text, for a repo with its own
lint tooling: `checkSecretNoInstall(file, text, exemptions)` and
`checkSecurityWorkflowNoCancel(file, text, securityWorkflowName)`. For the patch ledger,
`checkPnpmPatchLedger(ctx, today, options)` runs the check against a given date, and
`patchFileHash(text)` is the sha256 the rule compares with the lockfile (line endings normalized to
`\n` first).
