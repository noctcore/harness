# @noctcore/harness

## 0.3.0

- Async lint-meta rules: a rule declares `run`, `runAsync`, or both.
- `catalog` renders a registry's Markdown rule catalog, and `catalog --check` fails when it is stale.
- `ctx.glob` returns files only, and a run that could not finish says so in its summary.
- A walker with Node's glob rules under Bun, whose `globSync` misses dot-directory paths.

## 0.2.0

- `lint-meta --registry` and `check --manifest` point at a committed bundle, and fail closed when
  the named file is missing.
- TypeScript rule registries load through Node's own type stripping (Node 22.18 or later).

## 0.1.0

- The portable Structure-Lock runner: `npx @noctcore/harness check` runs a repo's
  `.nightcore/harness.json` checks in any CI.
- The `lint-meta` subcommand and the published `IMetaRule` contract.
