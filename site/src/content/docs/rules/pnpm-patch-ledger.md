---
title: pnpm-patch-ledger
description: Every patched dependency has a ledger entry with a reason, an upstream link, a removal condition and a review date that has not passed, and its patch file matches the lockfile.
---

**Category:** supply-chain · **CI-critical:** yes · **Factory:** `createPnpmPatchLedgerRule`

Every patched dependency says why it is patched, where upstream tracks it, what removes the patch,
and when to look at it again.

## Why

A `patchedDependencies` entry rewrites a package after it is installed. The entry carries a file path
and nothing else, and a patch nobody remembers the reason for is never removed: it outlives the bug
it worked around and quietly stops a dependency from moving. pnpm already fails the install when the
patched version moves or a hunk stops applying; what it cannot know is whether the patch is still
needed. The ledger carries that, and this rule keeps it load-bearing.

## Options

| Option | Default | What it does |
|---|---|---|
| `ledger` | `patches.ledger.json` | The ledger file, relative to the repo root. |
| `lockfile` | `pnpm-lock.yaml` | The lockfile, relative to the repo root. |
| `now` | `() => new Date()` | The clock `reviewBy` dates are judged against. Pass a fixed date in tests. |

```ts
createPnpmPatchLedgerRule();
createPnpmPatchLedgerRule({ ledger: 'patches/ledger.json' });
```

## The ledger

Keyed by the exact `patchedDependencies` key. Each entry has four fields, all required. One
`$comment` string may describe the file; every other key is an entry.

```json title="patches.ledger.json"
{
  "$comment": "Why each patch in pnpm-workspace.yaml exists. Checked by pnpm-patch-ledger.",
  "left-pad@1.3.0": {
    "reason": "Pads with a space when given an empty fill string.",
    "upstream": "https://github.com/example/left-pad/issues/42",
    "removeWhen": "A release with the fix for issue 42.",
    "reviewBy": "2027-03-01"
  }
}
```

## What it reports

1. A patch with no ledger entry, and a ledger entry with no patch. The key holds the version, so a
   patch moved to another version is a new entry to justify, not the old one carried over.
2. An entry missing `reason`, `upstream`, `removeWhen` or `reviewBy`, and a `reviewBy` that is not a
   real `yyyy-MM-dd` date or is in the past.
3. A key that pins no exact version (`name@1.2.3`). The pin is what makes pnpm fail the install when
   the dependency moves, instead of patching whatever arrived.
4. A patch file that does not exist, or that is declared at one path and locked at another.
5. A lockfile whose patch hash is not the hash of the patch file, or that does not record the patch
   at all: the file changed and nothing was installed since.

**Review dates turn red.** An entry is due after its day: green for the whole of `reviewBy` by the
UTC calendar (so every machine agrees), red from the first second of the next day, and red until
someone renews the entry with a reason or removes the patch. That is the design: a date nobody is
stopped by is a comment.

```
[ERROR] pnpm-patch-ledger (patches.ledger.json): `left-pad@1.3.0` was due for review on 2027-03-01. Check https://github.com/example/left-pad/issues/42 against its `removeWhen`, then remove the patch or move the date forward with a reason.
```

**Dormant by design:** with no patched dependency and no ledger, the rule reports nothing. Both places
pnpm reads the setting from are checked (`pnpm-workspace.yaml` and the root manifest's
`pnpm.patchedDependencies`), and a block the rule cannot read is reported instead of skipped.
