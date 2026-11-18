# Contributing

## Before you start

- Open an issue with one of the forms first for anything larger than a small fix, so we agree on
  the shape before you write code. A new rule or a new pinned tool goes in the "Rule or tool
  proposal" form.
- A vulnerability never goes in a public issue: see [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Layout

```
packages/harness      @noctcore/harness: the runner, the lint-meta engine, /rules and /pinned-tools
assets/brand          the logo, banner and social artwork, rebuilt from design.mjs
scripts               repo checks: package shape, workflow pinning
```

`packages/harness/src` is split by entry point:

```
manifest.ts, run.ts     load and plan .noctcore/harness.json, then run every check (harness check)
cli.ts                  argument parsing and dispatch for check, lint-meta and catalog
lint-meta/              the rule contract, the registry loader, the run loop, baselines, the catalog
rules.ts, rules/        the @noctcore/harness/rules subpath: one file per rule factory
pinned-tools.ts,        the @noctcore/harness/pinned-tools subpath: pins, routes, gitleaks,
  pinned-tools/         fetching and placing binaries, and the node-backed deps
web-budget.ts,          the @noctcore/harness/web-budget subpath: manifest and chunk graph,
  web-budget/           route and file budgets, dead imports, nginx model, precompress
index.ts                the public type barrel plus the ratchet helpers and portableFileGlob
```

[`packages/harness/AGENTS.md`](packages/harness/AGENTS.md) is the full contract for the package:
read it before changing anything under `src/`.

## Hard constraints

These hold for everything that ships in `dist/`. Tests enforce most of them.

- **Plain Node 22 or later.** `node:*` builtins only. Never import `bun` or `bun:*` outside
  `*.test.ts` files; the tests use `bun:test`.
- **Zero runtime dependencies.** `package.json` has no `dependencies`.
- **No network call.** No `http`, `https`, `net`, `dns` or `tls` import and no `fetch(` in the
  built entry points (`src/cli.node.test.ts` scans them). A download goes through a function the
  caller passes in.
- **Dependencies injected.** A function that reads files, spawns or reads the clock takes that as
  an argument; the real implementation is a separate export.
- **Fail closed.** A check that could not run, a rule that throws, a missing file named by a flag:
  each is a failure with a reason, never a pass.
- **Windows and Linux.** Paths go through `node:path`, repo-relative paths in output use `/`, and
  the suites pass on both (`test` and `test · windows` in CI).

## Checks

```sh
bun run build && bun run format:check && bun run typecheck && bun run lint && bun run test
bun run test:coverage
bun run check:package && bun run check:workflows
node packages/harness/dist/cli.js --version   # the built CLI must run under plain node
```

| Gate | CI job | Locally |
|---|---|---|
| Lockfile matches the manifests | `build · lint · typecheck · package shape` | `bun install --lockfile-only && git diff --exit-code -- bun.lock` |
| Formatting | `build · lint · typecheck · package shape` | `bun run format:check` |
| Types | `build · lint · typecheck · package shape` | `bun run typecheck` |
| Lint | `build · lint · typecheck · package shape` | `bun run lint` |
| Actions pinned to SHAs, top-level permissions | `build · lint · typecheck · package shape` | `bun run check:workflows` |
| Package shape (publint and attw on the packed tarball) | `build · lint · typecheck · package shape` | `bun run check:package` (after a build) |
| Unit and CLI tests under plain Node 22 | `test`, `test · windows` | `bun run test` (after a build) |
| Line and function coverage floors (`bunfig.toml`) | `coverage floor` | `bun run test:coverage` |
| A changeset on every package change | `changeset status` | `bun run changeset` |
| CodeQL (security-extended) | `codeql · javascript-typescript` | CI only |
| Dependency review (high severity, licence allowlist) | `dependency review` | CI only |

## Conventions

- Commits are `type(scope): lowercase summary`, one logical change each. Scopes are in
  `commitlint.config.js`: `harness`, `harness-mutation`, `repo`, `deps`, `ci`, `docs`, `release`.
- A rule id and every exported name are public API. Renaming one is a breaking change.
- A rule from `/rules` is strict (`ciCritical: true`, no `baseline`), takes everything
  repo-specific as options, and throws at creation when its config would check nothing.
- A rule's violation message says what is wrong and what to do about it.
- No em or en dashes in code, comments or docs.
- No secrets, real hostnames, IPs or email addresses in code, fixtures or docs: use `example.com`,
  `example.test` and documentation ranges.

## Changesets

A pull request that changes `packages/harness` carries a changeset (`bun run changeset`) written for
someone reading the changelog. On `0.x`, a change that can turn a green repo red (a new rule, a
stricter default, a moved pin) is a minor; a fix or a loosening is a patch. A change inside a
package that releases nothing (tests, comments) uses `bun run changeset --empty`. Changes outside
`packages/` (this file, the root README, CI, the docs site) need no changeset.

## Releasing

Releases go out through the `release` workflow and npm trusted publishing. The flow and the
owner-only steps are in [RELEASING.md](RELEASING.md).
