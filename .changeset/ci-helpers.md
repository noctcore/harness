---
'@noctcore/harness': minor
---

Add the `@noctcore/harness/ci` subpath: three CI helpers as pure functions over injected git and GitHub lookups.

- `decideAffectedBase(input, deps, options)` (with `chooseBase` and `affectedBaseFrom`) picks the commit a run diffs against: a pull request's base, or on push the head of the last successful push run when it is an ancestor of HEAD. Every doubt is a full run, including a change outside a workspace under `workspaceRoots` (`apps` and `packages` by default). `headShaOfLatestRun` parses the GitHub list-workflow-runs response your repo fetches, and `affectedEnvLines` writes the `GITHUB_ENV` lines (`TURBO_SCM_BASE` and `TURBO_AFFECTED` by default).
- `commitRange` decides which commits a run lints, and `runCommitlint` lints them with the commitlint command you pass, skipping exempt commits listed by full sha with a reason and their recorded message (`lintPlan`, `exemptionsFor`, `exemptionProblems`). A pull request never uses the exemption list.
- `collectDueEntries`, `dueReport` and `formatDueReport` list dated ledger entries (`reviewBy` by default) and trivy `expired_at` dates due within 14 days and fail on those within 7, for a scheduled job whose wiring stays in your repo.
- `nodeCiGitDeps`, `nodeIsWorkspace`, `nodeSpawnInherit` and `readDueSources` are the real I/O.

Nothing that already shipped changes behavior.
