---
title: The manifest and the runner
description: Every field of .nightcore/harness.json, how harness check plans and runs each check, timeouts, --json and the exit codes.
---

`harness check` reads one file, `.nightcore/harness.json`, and runs the checks it lists. The runner
interprets exactly one field structurally (`schemaVersion`); everything else is data, so a pinned
runner keeps working when the manifest grows new fields.

## The manifest

```json title=".nightcore/harness.json"
{
  "schemaVersion": 1,
  "checks": [
    { "name": "unit-tests", "kind": "test", "command": "node --test" },
    { "name": "typecheck", "kind": "typecheck", "command": "npx tsc --noEmit", "timeoutMs": 600000 },
    { "name": "repo-rules", "kind": "lint-meta", "command": "npx harness lint-meta" },
    { "name": "e2e", "kind": "test", "command": "npx playwright test", "enabled": false }
  ]
}
```

| Field | Type | What it does |
|---|---|---|
| `schemaVersion` | number | The manifest's major version. Absent means `1`. A higher major than the runner supports fails the run: upgrade the runner. |
| `checks` | array | The checks to run. Absent or not an array means nothing to enforce. |
| `checks[].name` | string | Required. A check with no name, or a blank one, is skipped as malformed. |
| `checks[].kind` | string | Free-form, carried into the result. `shell` is the one kind the runner skips. |
| `checks[].command` | string | The command line to run. A check without one is skipped. |
| `checks[].timeoutMs` | number | Wall-clock limit in milliseconds when greater than 0, else 300000 (5 minutes). |
| `checks[].enabled` | boolean | `false` skips the check. Anything else, or absent, runs it. |
| `checks[].configPath` | string | Informational: the underlying tool's config. The runner does not read it. |
| `policy` | object | Carried for other tools that read the manifest. The runner does not interpret it. |

### How a command runs

The command is trimmed, split on whitespace, and spawned directly: the first word is the program,
the rest are its arguments. There is **no shell**, so pipes, `&&`, redirects, globs, environment
assignments and quotes do not work. When a check needs any of those, commit a script and point the
check at it (`node scripts/check-docs.mjs`, `bash scripts/smoke.sh`).

Each check runs in the target directory with stdin closed and up to 16 MiB of output captured.

## What the runner does

- **Every check runs.** The runner does not stop at the first failure, so one CI run shows the
  whole failure set. `passed` is false when any check failed, and `failedCheck` names the first.
- **Every command is printed before it runs** (`→ name: command`), so a reviewer reading the CI log
  sees exactly what executed.
- **Exit 0 passes, anything else fails.** A failed check keeps the last 4000 characters of its
  combined stdout and stderr.
- **A timeout is a failure.** The check is killed and reported as timed out, never skipped.
- **A launch failure is a failure.** A program that does not exist fails its check with the reason.

On failure the runner prints a fix instruction to stderr that lists every failed check with its
command and captured output.

## Opt in by presence, fail closed when named

With no flags the runner reads `.nightcore/harness.json` under the target directory. A missing,
unreadable or malformed manifest at that default path means **nothing to enforce**, and the run
exits `0`. A repo turns the lock on by committing the file.

`--manifest <path>` names a different manifest, relative to `--dir`. A manifest you name is
**fail-closed**: if it is missing, unparseable or its root is not an object, the run exits `1`. A
bundle that points CI at its own committed copy must never pass because that copy went missing. Its
contents are still data: a parseable manifest with no `checks` array is nothing to enforce.

```sh
npx harness check --manifest ci/harness.json
```

## Machine-readable output

`--json` prints the whole result to stdout as one JSON document and moves the command echo to
stderr, so stdout stays parseable:

```sh
npx harness check --json > harness-result.json
```

```json
{
  "passed": false,
  "checks": [
    { "name": "unit-tests", "kind": "test", "command": "node --test", "status": "passed", "exitCode": 0, "durationMs": 412 },
    { "name": "repo-rules", "kind": "lint-meta", "command": "npx harness lint-meta", "status": "failed", "exitCode": 1, "output": "...", "durationMs": 1290 }
  ],
  "failedCheck": "repo-rules"
}
```

The shape is `StructureLockResult` from the package root. `status` is only ever `passed` or
`failed`. With nothing to enforce the result is `{ "passed": true, "checks": [] }`.

## Exit codes

| Code | When |
|---|---|
| `0` | Every check passed, or there is nothing to enforce. |
| `1` | A check failed or timed out, a named manifest was unusable, or the manifest requires a newer runner. |
| `2` | A usage error, such as an unknown command. |

## Types for the result

A tool that reads the `--json` output can type it with what the package root exports:
`StructureLockResult`, `StructureLockCheck` and `CheckStatus` for the result, and
`HarnessManifest` and `HarnessManifestCheck` for the manifest. They are listed in the
[API reference](/harness/reference/api/noctcore/harness/).
