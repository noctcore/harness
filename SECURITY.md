# Security

`@noctcore/harness` runs in other people's CI with whatever access that CI has, so a bug that makes
it run something it should not, reach the network, or pass a check that did not run is a security
bug. Please report privately.

## Supported versions

During 0.x only the latest release gets fixes. A fix ships as a patch on top of the latest minor;
older 0.x lines are not patched, so upgrade to the latest release to get it.

| Version | Security fixes |
|---|---|
| Latest 0.x release | Yes |
| Older 0.x releases | No |

## Reporting

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/noctcore/harness/security/advisories/new>. It opens a draft advisory that only
the maintainer can see.

If that page says reporting is not enabled, open a regular issue whose entire body is "security
report, need a private channel", with no details, and the maintainer will reply with one.

Include the version, the command or API you used, what an attacker needs, and what they get. There
is no bounty. You get a reply, a fix released as a patch with a changelog entry that credits you
unless you ask otherwise, and the details published once consumers have had the fix for a day.

## How a report is handled

1. **Acknowledged** within 3 working days, in the draft advisory.
2. **Triaged**: in scope or not, severity (CVSS), affected versions. You hear the outcome and the
   reasoning either way.
3. **Fixed in private**, in a temporary private fork attached to the advisory, with a test that
   fails before the fix. You are invited to review it.
4. **Released** as a patch with a changeset that describes the impact. A CVE is requested through
   the GitHub advisory when the severity warrants one.
5. **Published**: the advisory goes public once consumers have had the fixed release for a day,
   crediting you unless you ask otherwise.

The aim is a released fix within 30 days of the report for high and critical issues. If that cannot
be met, you hear why and when.

## What counts

- A network call from the published package: any request the runner, a rule or a pinned-tools
  function makes on its own. The only download is the `download` function a consuming repo passes
  to `nodeFetchDeps`.
- Code execution the repo did not commit: the `lint-meta` loader importing any file other than the
  one registry it resolved, or the runner executing something other than the `command` strings in
  the manifest it read.
- A fail-open path: a check that timed out, could not launch or could not find its tool, a rule
  that threw, or a missing file named with `--manifest` or `--registry`, reported as a pass.
- `pinned-tools` running a binary or image that is not the pinned one: a sha256 mismatch accepted,
  a version mismatch accepted, an image not pinned by digest, or `placeBinary` writing through an
  existing symlink.
- A rule from `@noctcore/harness/rules` that a crafted workflow, lockfile or ledger makes pass when
  it should fail.
- The published artefacts: a tarball on npm that does not match the tagged source, or a way to make
  the release workflow publish something else.

## What does not count

- The `command` strings in `.noctcore/harness.json` and the rules in a registry are executed by
  design. They are the repo's own committed, reviewed config, at the same trust level as a
  `package.json` script or a workflow step.
- The runner does not attest that a manifest or a rule matches what some tool generated. A weakened
  rule is enforced in its weakened form; review of the diff is the control against that.
- Advisories in the dev toolchain that never ship in the published `dist/`.

## Versioning policy

On `0.x`, a change that can turn a green repo red (a new rule, a stricter default, a moved pin) is a
minor; a fix or a loosening is a patch. Removing a fail-closed check or a pin is never a patch.
During 0.x, pin an exact version in CI.
