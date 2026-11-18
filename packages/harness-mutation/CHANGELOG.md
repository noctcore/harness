# @noctcore/harness-mutation

## 0.1.0

### Minor Changes

- [#26](https://github.com/noctcore/harness/pull/26) [`ed03731`](https://github.com/noctcore/harness/commit/ed037316a6a8601fbaf5643fcd412bb7dad98858) Thanks [@Shironex](https://github.com/Shironex)! - New package: a mutation-testing gate over Stryker (an optional peer dependency, never imported).
  `runMutation` runs a whole-package check held to a score baseline that may only rise (a drop past
  the tolerance fails, a rise past the margin fails until recorded) or a changed-line check that fails
  any surviving mutant on the lines a branch changed. Accepted mutants go in a ledger with a reason
  and a review date, and an entry fails once that date has passed. `nodeMutationDeps` holds the real
  I/O and `finishVerdict` the verdict line and exit code. Every app-specific value is an option.
