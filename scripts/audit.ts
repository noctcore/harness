/**
 * Runs `bun audit` with the repo's reviewed advisory ignores.
 *
 * `bun audit --ignore` is CLI-only (bunfig.toml has no audit section), so the
 * ignore list lives here, where each entry can carry its reason and a date to
 * look at it again. An entry past its review date prints a warning, not a
 * failure: the date is a reminder for a maintainer, and the audit result must
 * not change on a day nobody touched the repo.
 *
 * Fixed advisories stay fixed in package.json instead: `overrides.minimatch`
 * moves typedoc (which still asks for minimatch ^10.2.5) onto minimatch 11,
 * clearing GHSA-g3hv-75wg-m249 (>=7.0.0 <11.0.1). Drop that override once
 * typedoc depends on minimatch 11 itself.
 *
 *   bun run audit
 */
import { spawnSync } from 'node:child_process';

interface Ignore {
  /** GHSA id as printed by `bun audit`. */
  readonly id: string;
  /** Why the advisory does not affect this repo, and why it cannot be fixed yet. */
  readonly reason: string;
  /** ISO date (YYYY-MM-DD) to check for a patched release again. */
  readonly reviewBy: string;
}

const IGNORES: readonly Ignore[] = [
  {
    // picomatch ReDoS through single-branch repeated extglobs, every version <= 4.0.7.
    id: 'GHSA-fc5q-39xc-vjpf',
    reason:
      'No patched picomatch release exists yet. It is reached only through dev and docs tooling ' +
      '(astro, @changesets/git, tsup and typescript-eslint via tinyglobby/fdir), which match glob ' +
      'patterns from the config in this repo, never untrusted input. Published packages have no ' +
      'runtime dependencies, so consumers never install it.',
    reviewBy: '2027-01-18',
  },
];

const today = new Date().toISOString().slice(0, 10);
for (const { id, reviewBy } of IGNORES) {
  if (reviewBy < today) {
    console.warn(
      `audit: the ignore for ${id} was due for review on ${reviewBy}; check for a fix and update scripts/audit.ts.`,
    );
  }
}

const args = ['audit', ...IGNORES.map(({ id }) => `--ignore=${id}`)];
console.log(`$ bun ${args.join(' ')}`);
const result = spawnSync('bun', args, { stdio: 'inherit' });
if (result.error) {
  console.error(`audit: could not run bun: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
