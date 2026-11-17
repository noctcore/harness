---
title: github-actions-security-no-cancel
description: A security workflow gives every pushed commit its own completed run, with no cancel-in-progress and no shared concurrency group that lets a new run replace a pending one.
---

**Category:** ci · **CI-critical:** yes · **Factory:** `createGithubActionsSecurityNoCancelRule`

A security workflow must give every pushed commit its own completed run.

## Why

A secret-scanning workflow is the authoritative gate (a local hook is defense in depth, and
`--no-verify` skips it), and it scans history. Two concurrency shapes hide a commit from the scan
without turning anything red:

1. **`cancel-in-progress: true`.** Push B cancels push A's run. A force-push that rewrites history
   leaves A's commit out of B's scan, so a key it contained is exposed (GitHub still serves the
   orphaned SHA) and nothing flags it.
2. **A group not keyed on the commit, even with `cancel-in-progress: false`.** GitHub keeps one
   running and one pending run per group, and a new run replaces the pending one, so the middle of
   three quick pushes never gets a run of its own.

So a security workflow either has no `concurrency` block, or keys its group on `github.sha` or
`github.run_id` (a group nothing else shares) and does not cancel.

## Options

| Option | Default | What it does |
|---|---|---|
| `securityWorkflowName` | `/^security-.+\.ya?ml$/u` | Which workflow file names (the basename) are security workflows. |

```ts
createGithubActionsSecurityNoCancelRule();
createGithubActionsSecurityNoCancelRule({ securityWorkflowName: /^(secrets|audit)\.ya?ml$/u });
```

A workflow is a security workflow when its file name matches, **or** when it runs the gitleaks CLI
(`gitleaks git`, `detect`, `dir`, `protect` or `stdin`) or a gitleaks action, whatever its name.

## What it reports

Comments are stripped first (a workflow's own explanation of why it has no block may name
`cancel-in-progress: true`), then every `concurrency:` key is read in block, flow-mapping or scalar
form, at the workflow or at a job level:

- `cancel-in-progress` set to anything but `false`;
- a group that is missing or not keyed on `github.sha`, `github.run_id` or a pull request's
  `head.sha`.

```yaml title=".github/workflows/security-gitleaks.yml"
name: security-gitleaks
on: [push]
concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true
```

```
[ERROR] github-actions-security-no-cancel (.github/workflows/security-gitleaks.yml): Line 3: security workflow sets `cancel-in-progress: true`. A newer push would cancel an older commit's scan, and a force-push that rewrites history then leaves that commit unscanned while the newer run passes. Delete the `concurrency` block, or set `cancel-in-progress: false` and key the group on the commit.
[ERROR] github-actions-security-no-cancel (.github/workflows/security-gitleaks.yml): Line 3: security workflow concurrency group `security-${{ github.ref }}` is not keyed on the commit. GitHub keeps one running and one pending run per group and a new run REPLACES the pending one, so the middle of several quick pushes never gets its own scan. Delete the `concurrency` block, or include `github.sha` or `github.run_id` in the group.
```

## Fixing it

Delete the `concurrency` block. If the workflow needs one, use
`group: security-${{ github.sha }}` with `cancel-in-progress: false`.
