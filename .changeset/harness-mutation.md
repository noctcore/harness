---
'@noctcore/harness-mutation': minor
---

New package: a mutation-testing gate over Stryker (an optional peer dependency, never imported).
`runMutation` runs a whole-package check held to a score baseline that may only rise (a drop past
the tolerance fails, a rise past the margin fails until recorded) or a changed-line check that fails
any surviving mutant on the lines a branch changed. Accepted mutants go in a ledger with a reason
and a review date, and an entry fails once that date has passed. `nodeMutationDeps` holds the real
I/O and `finishVerdict` the verdict line and exit code. Every app-specific value is an option.
