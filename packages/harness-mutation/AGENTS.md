# `@noctcore/harness-mutation`: agent contract

A mutation-testing gate over Stryker, published as `@noctcore/harness-mutation`. Library functions
with typed options plus injectable Node I/O (the pinned-tools / rules module contract); no bin and
no CLI subcommand.

## Hard constraints

- **Plain Node 22 or later.** `node:*` builtins only in `src/` (non-test). Never import `bun` or
  `bun:*` outside `*.test.ts`; tests use `bun:test` with `node:assert/strict`.
- **Zero runtime dependencies.** No `dependencies`. `@stryker-mutator/core` is an optional peer
  dependency and is never imported: `node.ts` resolves its bin from the target package and spawns
  it with `process.execPath`. `src/dist.node.test.ts` asserts the built files import no network
  module, no `bun` and no `@stryker-mutator/*` package.
- **No app names.** Every app-specific value (targets, file names, report dir, never-mutate list,
  tolerance, margin, accept hint) is an option. Code, tests and docs never name the repo the module
  came from.
- **Fail closed.** A run that could not start, a missing or unreadable report, an unloadable or
  incomplete config, an unreadable or expired ledger, a git that cannot answer: each is `failed` or
  `blocked`, never `passed`. Every git and Stryker command is logged before it runs.

## Layout

- `src/verdict.ts`: reading a Stryker JSON report, the score, the whole-package verdict, `preflight`.
- `src/ratchet.ts`: the baseline and its band (`dropTolerance`, `staleMargin`), accepting a score.
- `src/changed.ts`: a zero-context diff to mutate ranges, and the changed-line verdict.
- `src/ledger.ts`: accepted mutants (with `reviewBy`), stale, ambiguous and expired entries.
- `src/run.ts`: `runMutation(request, deps)`, pure over `IMutationDeps`.
- `src/node.ts`: the real deps (`nodeMutationDeps`), the Stryker spawn, `finishVerdict`.
- `src/index.ts`: the public exports. A new export needs a README row and a changeset.

Coverage floor: lines 0.87, functions 0.83 (`bunfig.toml`). Releases go through changesets like the
other packages in this repo.
