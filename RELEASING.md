# Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets) and the `release`
workflow (`.github/workflows/release.yml`).

1. A pull request that changes a published package adds a changeset (`bun run changeset`). The
   `changeset` workflow fails a PR that changes a package without one; a change that releases
   nothing adds `bun run changeset --empty`.
2. When changesets land on `main`, the release workflow opens or updates a **Version Packages** PR
   that bumps the versions and writes the CHANGELOGs.
3. That PR is pushed with `GITHUB_TOKEN`, so GitHub starts no CI for it. Close and reopen it (or
   push an empty commit to its branch) so the required checks run, then merge it.
4. Merging the Version Packages PR, with no changesets pending, publishes to npm and creates the
   release tags (`@noctcore/harness@x.y.z`) and GitHub releases. Nothing else publishes.

Pending changesets combine: two minors waiting at once release as one minor. Merge the Version
Packages PR between them to keep them as separate versions.

## npm

Publishing uses npm trusted publishing (OIDC). There is no npm token in this repository. Each
package needs a trusted publisher on npmjs.com: repository `noctcore/harness`, workflow
`release.yml`, no environment. A new package name has to exist on npm before a trusted publisher
can be added, so its first version is created from the npm website or with a placeholder.

## Versioning

On `0.x`, a minor is any change that can turn a green repo red: a new rule, a stricter default, a
moved tool pin. A patch only fixes or loosens. Rule ids and exported names are public API.
