# noctcore/harness

Verification harness modules for TypeScript monorepos: checks that hold a repo to its own rules
in any CI, with no server, no account and no runtime dependencies.

| Package | What it is |
|---|---|
| [`@noctcore/harness`](packages/harness) | The portable Structure-Lock runner (`npx @noctcore/harness check`), the lint-meta engine for repo-level rules ESLint cannot reach, and generic rules under `@noctcore/harness/rules`. |

Each package's README has its usage. Every module runs under plain Node 22 or later, makes no
network call, and reads only what is committed in the repo it checks.

## Developing

This is a Bun workspace (`bun@1.4.2`).

```
bun install
bun run build
bun run typecheck && bun run lint && bun run test
bun run test:coverage
bun run check:package
```

Commits are conventional and scoped (`type(scope): lowercase summary`, scopes in
`commitlint.config.js`). A pull request that changes a published package carries a changeset
(`bun run changeset`); see [RELEASING.md](RELEASING.md).

## License

MIT, see [LICENSE](LICENSE).
