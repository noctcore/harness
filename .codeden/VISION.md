# Vision

Verification harness modules for TypeScript monorepos: checks that hold a repo to its own rules in any CI, with no server, no account and no runtime dependencies.

## Goals
- Grow the module set by extracting proven checks from real consumer repos into generic, typed modules (pinned tools, repo rules, lint-meta today; mutation testing, web bundle budgets and CI helpers next, issues #17 to #19)
- Every check runs, every command is printed before it runs, and a check that could not run is a failure, never a pass
- One committed config (`.noctcore/harness.json`) and pinned tool versions, so a new linter release never turns CI red on nobody's change
- Works the same on Linux, macOS and Windows, in any CI

## Target users
- Maintainers of TypeScript monorepos who want their repo's rules enforced in CI without a hosted service

## Principles
- Zero runtime dependencies in published packages; heavy tools (Stryker and the like) are peer dependencies
- Follow the module contract of the existing modules: library functions with typed options plus injectable node I/O deps, so tests need no real repo, network or Docker
- Every app-specific value is an option; code, tests and docs never name the private app a module was extracted from
- Public API changes are deliberate: each user-facing change ships a changeset (minor for a new module, patch for a fix) and README export rows
- One module or one fix per pull request; split anything that does not fit the size limit
- Conventional commits, `type(scope): lowercase summary`, scope required; no em or en dashes anywhere

## Out of scope
- A hosted service, dashboard or account of any kind
- Runtime dependencies in published packages
- Checks tied to one framework or one private app
- Changing an existing module's public API without a deprecation path

## Quality bar
- Tests with synthetic fixtures for every behaviour, coverage at the repo floor
- Linux and Windows CI green before merge
- A docs page (guide plus API) on the site for every new module
- A failure message that tells the user what to do next

## Protected areas
- `.github/workflows/**`
- `RELEASING.md`
- `.changeset/config.json`
- `LICENSE`
- licensing
- infrastructure
