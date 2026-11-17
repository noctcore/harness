# Changesets

Every pull request that changes a published package carries a changeset: run `bun run changeset`,
pick the packages and the bump, and describe the change for the CHANGELOG. A change that releases
nothing (tests, docs inside a package) adds an empty one with `bun run changeset --empty`.

On `0.x`, a minor is any change that can turn a green repo red (a new rule, a stricter default, a
moved pin); a patch only fixes or loosens.
