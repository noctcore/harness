---
title: github-actions-secret-no-install
description: A GitHub Actions job that can read a stored secret must not run a package install, because every dependency's install scripts run in that job.
---

**Category:** ci · **CI-critical:** yes · **Factory:** `createGithubActionsSecretNoInstallRule`

A workflow job that can read a stored secret must not install packages.

## Why

A package install runs every dependency's lifecycle scripts, and anything a script leaves behind (a
patched binary in `node_modules/.bin`, a file a later step executes) runs in every later step of the
same job. So a secret that any step of that job can see is readable by every package in the
lockfile, whichever step it is declared on. The fix is a job of its own that checks out and runs the
tool the secret is for, with no install. There is no per-job allowlist, because a job that "really
needs both" is exactly the case the rule exists for.

## Options

| Option | Default | What it does |
|---|---|---|
| `exemptSecrets` | none | Secrets the rule does not count, each `{ secret, reason }` with a non-empty reason. |

```ts
createGithubActionsSecretNoInstallRule();
createGithubActionsSecretNoInstallRule({
  exemptSecrets: [{ secret: 'CACHE_TOKEN', reason: 'the build cache credential; read-only on PRs' }],
});
```

An exemption names a **secret**, never a job: every other secret in an exempted job still fails it.
An exemption without a name or a reason makes the factory throw.

## What counts

- **A secret:** any `secrets.<NAME>` in the job except `GITHUB_TOKEN` (the ephemeral token, scoped by
  the job's own `permissions:`), any `secrets.<NAME>` in the workflow-level `env:` block (every step
  of every job sees it), and `secrets: inherit`, which hands a called workflow all of them.
- **An install:** `pnpm`, `npm`, `yarn` or `bun` followed by `install`, `i`, `ci` or `add` inside a
  `run:` script, or `run_install: true` (pnpm/action-setup installs for you).

The rule reads every `.github/workflows/*.yml` and `*.yaml` line by line: comments are stripped, then
the top-level `env:` block and each job under `jobs:` are read by indentation.

## Example

```yaml title=".github/workflows/release.yml"
name: release
on: push
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

```
[ERROR] github-actions-secret-no-install (.github/workflows/release.yml): Job `publish` (line 5) reads `NPM_TOKEN` (line 12) and installs packages on line 9. Every package's lifecycle scripts run in that job, and what they leave behind runs in the step that holds the secret. Move the secret's step into a job of its own that checks out and runs no package install.
```

## Fixing it

Split the job: one job installs, builds and uploads an artifact; a second job downloads the artifact
and runs the step that needs the secret, with no install. Declare a secret on the one step that
needs it, not in the workflow-level `env:`. npm trusted publishing (OIDC) removes the token
entirely.
