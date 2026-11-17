# Product: the @noctcore/harness docs site

register: brand

## What it is

The public docs for `@noctcore/harness`: a check runner (`harness check`), a whole-repo rule engine
(`harness lint-meta`) with six ready-made rules, and runners that use linters only at their pinned
version. The site has two jobs. The landing page shows the one idea (a repo held to its own
committed rules, with no silent pass). Getting started, Guides, Rules and Reference are reading
pages that must be calm and fast before anything else.

## Users

- **Maintainers choosing a CI gate.** Skeptical, ten minutes, read the sample before the copy. They
  want to know what runs, what it refuses to do, and whether it adds supply-chain risk.
- **Developers wiring it in.** Back many times for one manifest field, one rule option, one exit
  code. They need the sidebar, search and Reference to be boring.
- **Reviewers.** Reading a rule page end to end to judge whether a red build is right.

## Brand

- **Voice words:** calm, exact, accountable. A rule is stated, then the failure that makes it
  necessary, then where it lives.
- **Look:** the noctcore night and paper palette shared with noctcore/auth; the "Held run" mark;
  passing tracks continuous in blue, stopped checks dashed and capped in copper.
- **Copy rules:** no em or en dashes; no "blazing", "seamless", "enterprise-grade".

## Strategic principles

1. **Code is evidence.** Samples live in `snippets/`, are typechecked against the package sources,
   and were run against the published package.
2. **Both themes are first class.** Night leads; day is not a palette swap.
3. **Quiet structure.** Hierarchy from type and spacing; cards only where a card is the affordance.

## Screenshots

`screenshots/` holds headless captures of the built site (Playwright, chromium headless shell) at
1440 and 390 px in both themes. They are for review and the README, not loaded by the site.
