---
'@noctcore/harness': minor
---

Export `portableFileGlob` from the package root: the glob behind the runner's `ctx.glob`, for a repo whose own lint tooling builds its ctx. It follows Node's `fs.globSync` rules under both Node and Bun (whose `globSync` cannot see a dot-directory such as `.github`), returns files only, sorted, and throws on syntax it does not implement instead of matching nothing.
