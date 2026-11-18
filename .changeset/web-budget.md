---
'@noctcore/harness': minor
---

Add the `@noctcore/harness/web-budget` subpath: web bundle budgets for a Vite build, as pure functions over injected file reads.

- `parseViteManifest`, `parseViteManifestText` and `readViteManifest` read the Vite manifest defensively: a wrong field type, an entry without `file`, an empty or missing manifest, or a path outside the build directory is a named problem that fails the check; unknown fields are ignored.
- `buildGraph` weighs each route cold (its static closure) and beyond the shell (minus what the entry chunks load), counting a shared file once and surviving import cycles.
- `checkBudgets` holds the shell, each route (`cold`, `beyondShell`) and each built file matching a glob to the budgets your repo commits; a stale route key or pattern and an invalid budget fail.
- `findDeadImports` reports `import()` calls whose target is already loaded or missing; each allowed one needs a written reason.
- `checkWebBudget` runs everything and renders a deterministic Markdown report; `reportIsFresh` fails a committed report that no longer matches the build (CRLF equals LF).
- `checkPrecompressed` checks that every file the server serves compressed has a non-empty, fresh `.br` and `.gz` sibling; the directory, extensions, `minBytes` and encodings are options.
- `nodeManifestDeps`, `nodeReadText`, `nodeSizeOf` (raw, gzip or brotli) and `nodePrecompressDeps` are the real I/O.

Nothing in the module writes or raises a budget. Nothing that already shipped changes behavior.
