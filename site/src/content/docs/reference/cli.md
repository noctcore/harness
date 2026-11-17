---
title: CLI
description: Every harness command, flag and exit code.
---

The package installs one bin, `harness`. Run it with `npx harness` when the package is installed,
or `npx --yes @noctcore/harness@<version>` when it is not.

```
harness [check] [options]      Run the checks declared in .nightcore/harness.json
harness lint-meta [options]    Run the portable lint-meta rules from the enumerated registry
harness catalog [options]      Write the registry's rule catalog (Markdown), or --check it
```

`check` is the default command, so `npx harness` alone runs the checks.

## Options

| Option | Commands | What it does |
|---|---|---|
| `--dir <path>` | all | The directory to operate in. Default: the current directory. Other paths are relative to it. |
| `--manifest <path>` | `check` | The manifest to read, relative to `--dir`. Default `.nightcore/harness.json`. A named manifest that is missing or unparseable fails the run. |
| `--registry <path>` | `lint-meta`, `catalog` | The registry to load, relative to `--dir`. Default: the first of `.nightcore/lint-meta/registry.mts`, `.ts`, `.js` that exists. A named registry that is missing fails the run. |
| `--out <path>` | `catalog` | The catalog file, relative to `--dir`. Default `RULES.md` beside the registry. |
| `--check` | `catalog` | Write nothing; exit 1 with a diff when the committed catalog is stale or missing. |
| `--json` | `check` | Print the result as one JSON document on stdout; the command echo moves to stderr. |
| `--version`, `-v` | | Print the runner version. |
| `--help`, `-h` | | Print the help. |

Flags with a value also accept `--flag=value`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every check or rule passed, or nothing is configured to enforce. |
| `1` | A check failed, a rule reported a critical violation or threw, a manifest or registry named with a flag was unusable, the manifest requires a newer runner, or `catalog --check` found the catalog stale. |
| `2` | A usage error, such as an unknown command. |

Scripts built on `@noctcore/harness/pinned-tools` use their own codes through `exitCodeFor`: `0`
passed, `1` failed, `2` blocked. See [Pinned tools](/harness/guides/pinned-tools/#routes-and-verdicts).

## Requirements

Node 22 or later. Node 22.18 or later to load a TypeScript registry (`.mts` or `.ts`), which uses
Node's own type stripping.
