---
'@noctcore/harness': minor
---

Add the `@noctcore/harness/web-budget` subpath: web bundle budgets for a Vite build, as pure functions over injected file reads.

- `parseManifest` reads the Vite manifest defensively into a graph of script chunks: text that is not JSON, an entry without a `file`, a wrong field type, a path outside the build directory, a reference to an unlisted key and a manifest with no script chunk all throw; unknown fields are ignored.
- `loadWebBuild` refuses a missing build, a missing manifest, a build older than its `sourceRoots` (skippable under CI) and a directory two builds wrote into, then weighs each file as served.
- `checkRoutes` holds each route's cold weight (its shell plus the route) and its weight beyond the shell to baselines, with named shells for layout routes.
- `parseFileBudgets` and `checkFileBudgets` hold file patterns and a route's own chunks (`ownChunks`, taken from the graph) to `"<n> kB"` limits; a pattern or route that names nothing fails.
- `checkDynamicImports` reports `import()` calls that split nothing (`same-chunk`, `static`, `entry`, `loaded-with`), and fails a build that lists none unless told the app splits nothing.
- `parseServedEncoding` and `servedSize` weigh a file the way an nginx configuration sends it (gzip level, length floor, types, `gzip_proxied`, `brotli_static`), failing closed on anything the model cannot read; includes and `types` locations it may accept are options.
- `precompressDir` writes the `.br` copies `brotli_static` serves (old copies removed first), and `checkPrecompressed` checks them.
- `runBudget` and `headroomFromArgv` run a budget script with prefixed output and an exit code; headroom only prints limits.

Nothing in the module writes or raises a limit, and it has no tolerance or override. Nothing that already shipped changes behavior.
