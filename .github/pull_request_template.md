<!--
Title: a conventional commit with a scope, for example `fix(harness): keep a blocked route blocked`.
-->

## Summary

<!-- What changes and why, in one or two sentences. -->

Closes #

## Checklist

- [ ] A changeset in `.changeset/` (`bun run changeset`), written for a consumer reading the changelog. On `0.x`, anything that can turn a green repo red (a new rule, a stricter default, a moved pin) is a minor. Changes that release nothing use `bun run changeset --empty`.
- [ ] `bun run build && bun run format:check && bun run typecheck && bun run lint && bun run test` pass locally
- [ ] `bun run check:package` passes
- [ ] The package still makes no network call and has no runtime dependency
- [ ] No secrets, real hostnames, IPs or email addresses in code, fixtures or docs
- [ ] Commits are small `type(scope): lowercase summary` commits, with no em or en dashes and no AI attribution lines

## Test plan

<!-- Commands run, cases covered, what a reviewer can try. -->
