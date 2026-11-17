/** The failure to verdict pairs the landing page shows, each linked to the page that explains it. */
export interface RunRow {
  readonly failure: string;
  readonly answer: string;
  readonly module: string;
  readonly href: string;
}

export const RUN: readonly RunRow[] = [
  {
    failure: 'A new linter release turns CI red on nobody’s change',
    answer: 'zizmor, actionlint and gitleaks run at exactly their pinned version, natively or by image digest.',
    module: 'pinned-tools',
    href: '/harness/guides/pinned-tools/',
  },
  {
    failure: 'A check that could not run counts as a pass',
    answer: 'No pinned binary and no Docker is blocked, exit 2. A timeout or a launch failure is a failed check.',
    module: 'pinned-tools · harness check',
    href: '/harness/guides/pinned-tools/#routes-and-verdicts',
  },
  {
    failure: 'The first failure hides the rest',
    answer: 'Every check runs. The fix instruction lists each failed one with its command and output.',
    module: 'harness check',
    href: '/harness/guides/manifest-and-runner/',
  },
  {
    failure: 'A git or tarball source slips into the lockfile',
    answer: 'Every package resolves from the registry with a sha512 hash, read from the lockfile on every run.',
    module: 'lockfile-registry-resolutions',
    href: '/harness/rules/lockfile-registry-resolutions/',
  },
  {
    failure: 'A deploy token is readable by every install script',
    answer: 'A job that can read a stored secret runs no package install.',
    module: 'github-actions-secret-no-install',
    href: '/harness/rules/github-actions-secret-no-install/',
  },
  {
    failure: 'A patch outlives the bug it worked around',
    answer: 'Each patch has a reason, an upstream link, a removal condition and a review date that turns red.',
    module: 'pnpm-patch-ledger',
    href: '/harness/rules/pnpm-patch-ledger/',
  },
  {
    failure: 'Old debt blocks a new rule',
    answer: 'A baseline freezes today’s offenders. A new one fails; a frozen one may only shrink.',
    module: 'lint-meta baselines',
    href: '/harness/guides/baselines/',
  },
];
