# @noctcore/harness-mutation

A mutation-testing gate over [Stryker](https://stryker-mutator.io/): a score ratchet that may only
rise, changed-line runs that fail any surviving mutant on the lines a branch changed, a dated and
reviewed ledger of accepted mutants, and a verdict that never reads a broken run as a pass.

Library functions with typed options over injectable Node I/O, the same contract as the other
harness modules. No runtime dependencies; Stryker is a peer dependency the runner spawns and never
imports. There is no CLI: your repo writes the few lines that call `runMutation`.

```sh
bun add -d @noctcore/harness-mutation @stryker-mutator/core
```

```ts
// scripts/mutation.mts
import { finishVerdict, nodeMutationDeps, runMutation } from '@noctcore/harness-mutation';

const { checkId, verdict } = await runMutation(
  {
    target: { dir: 'packages/core', checkId: 'mutation-core', ratchet: true, changedCheckId: 'mutation-changed' },
    accept: process.argv.includes('--accept'),
    changed: process.argv.includes('--changed') ? { baseRef: 'origin/main' } : null,
    acceptHint: 'bun scripts/mutation.mts --accept',
  },
  nodeMutationDeps(process.cwd()),
);
const { lines, exitCode } = finishVerdict(checkId, verdict);
for (const line of lines) console.log(line);
process.exitCode = exitCode; // 0 passed, 1 failed, 2 blocked
```

The target list, each package's `stryker.config.mjs`, and the baseline and ledger JSON files stay in
your repo.

## Exports

| Export | What it does |
|---|---|
| `runMutation(request, deps)` | One run to its verdict: a whole-package run (held to the baseline when the target has `ratchet: true`) or, with `changed`, a run over the lines changed since the merge base with `baseRef`. Prints every git and Stryker command before it runs. |
| `nodeMutationDeps(root, options?)` | The real I/O: files, a dynamic import of the config, git at the root, and Stryker resolved from the target package and spawned with the current Node (SIGINT and SIGTERM passed on). `noStryker` stops where Stryker would start. |
| `finishVerdict(checkId, verdict)` | The lines to print (details, then `<checkId>: <status> (<reason>)`) and the exit code. |
| `parseBaseline`, `serializeBaseline`, `compareToBaseline`, `acceptScore`, `judgeScore` | The score ratchet: a drop past `dropTolerance` (default 1 point) fails, a rise past `staleMargin` (default 2 points) fails until recorded, a missing or unreadable baseline is blocked. |
| `parseDiff`, `mergeRanges`, `mutatePatterns`, `mutated`, `planChangedRun`, `judgeChanged`, `nothingToCheck` | Changed lines: a zero-context git diff to Stryker `file:start-end` mutate ranges, skipping unmutated paths and `neverMutate` prefixes, and the verdict over the report that run wrote. |
| `parseLedger`, `expiredEntries`, `acceptedBy`, `staleEntries`, `ambiguousEntries`, `directiveLines`, `switchedOff` | The ledger: accepted mutants with a reason and a `reviewBy` date; an entry past its date, stale or naming two mutants fails. |
| `readMutants`, `tallyReport`, `mutationScore`, `conservativeScore`, `judgeRun`, `incompleteRun`, `preflight`, `verdictLine`, `exitCodeFor` | The verdict of a whole-package run, and the config checks made before Stryker starts. |

Request options with their defaults: `configFile` (`stryker.config.mjs`), `baselineFile`
(`mutation-baseline.json`), `ledgerFile` (`mutation-ledger.json`), `reportDir`
(`.noctcore/mutation`), `neverMutate` (none), `dropTolerance` (`1`), `staleMargin` (`2`) and
`acceptHint`.

## Risks

- **Stryker peer version skew.** The verdict reads Stryker's JSON report and its `Instrumented ...`
  log line. A Stryker major that changes either reads as a failed or blocked run, never a pass, but
  turns the gate red until this package supports it. Keep core and the runner plugin on one version.
- **Changed lines on an enforced path is the consumer's choice.** A changed-line run is partial by
  design; whether it blocks a merge, advises or runs locally is decided in your repo.

The [mutation testing guide](https://noctcore.github.io/harness/guides/mutation-testing/) covers the
config requirements, the ledger format, every verdict and the API.

## License

MIT
