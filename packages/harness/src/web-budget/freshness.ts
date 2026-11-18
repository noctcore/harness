/*
 * A build older than the sources it was made from measures a different commit.
 * A build directory merely existing is not enough of a precondition: a
 * two-day-old one satisfies it, and a number reported for the wrong commit is
 * worse than no number, because it passes.
 *
 * Skip it under CI when the workflow builds right before it measures and the
 * step order is the guarantee: modification times there come from a checkout
 * and a possible cache restore, so comparing them would fail a build for a
 * reason that has nothing to do with bytes.
 */

/** Directories never walked for source modification times. */
export const DEFAULT_SKIPPED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  '.git',
];

/**
 * The source roots changed after the build was made: those whose newest file
 * is newer than `builtAtMs`. `newestMtime` gives the newest modification time
 * under a root, or null when the root does not exist (skipped). Empty when the
 * build is at least as new as every root.
 */
export function newerSourceRoots(
  builtAtMs: number,
  roots: readonly string[],
  newestMtime: (root: string) => number | null,
): string[] {
  return roots.filter((root) => {
    const newest = newestMtime(root);
    return newest !== null && newest > builtAtMs;
  });
}
