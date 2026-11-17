/**
 * Where the runner looks for a repo's files by default, and the legacy location it
 * still reads during the move.
 *
 * Everything the runner reads by convention lives under one directory at the repo
 * root: the manifest (`harness.json`), the lint-meta registry and the baselines
 * beside it. That directory is {@link CONFIG_DIR} (`.noctcore/`). Before 0.6 it was
 * `.nightcore/` ({@link LEGACY_CONFIG_DIR}); the runner still falls back to it, with
 * a deprecation warning, when only the old file exists, and refuses to guess when
 * both do. The fallback goes away in 1.0.
 *
 * Every path here is repo-relative with forward slashes, so the same string works
 * on every OS (`path.join` normalizes it) and reads the same in a message.
 */

/** The directory the runner reads by convention, relative to the repo root. */
export const CONFIG_DIR = '.noctcore';

/**
 * The pre-0.6 convention directory. Read only as a fallback when the matching file
 * under {@link CONFIG_DIR} is absent; support ends in 1.0.
 */
export const LEGACY_CONFIG_DIR = '.nightcore';

/** Repo-relative location of the manifest `harness check` reads by default. */
export const MANIFEST_RELATIVE_PATH = `${CONFIG_DIR}/harness.json`;

/** The pre-0.6 manifest location, read only as a deprecated fallback. */
export const LEGACY_MANIFEST_RELATIVE_PATH = `${LEGACY_CONFIG_DIR}/harness.json`;

/**
 * The fixed, repo-relative registry paths the runner tries, in order, when no
 * `--registry` is given. TypeScript first (what Nightcore's portable-lock exporter
 * emits) so an exported registry is authoritative in a repo that still carries a
 * hand-rolled JavaScript one, and `.mts` ahead of `.ts` because that is the form the
 * exporter writes: `.mts` is an ES module whatever the repo's `package.json` says,
 * while a `.ts` in a `"type": "commonjs"` repo cannot load ESM rules at all. Still
 * BOUNDED eval: a fixed, enumerated list, of which exactly one file is ever imported.
 */
export const DEFAULT_REGISTRY_RELATIVE_PATHS = [
  '.noctcore/lint-meta/registry.mts',
  '.noctcore/lint-meta/registry.ts',
  '.noctcore/lint-meta/registry.js',
] as const;

/**
 * The pre-0.6 registry locations, tried in the same order only when none of
 * {@link DEFAULT_REGISTRY_RELATIVE_PATHS} exists. Reading one prints a deprecation
 * warning; finding one here AND one in the current list is an error. Support ends in 1.0.
 */
export const LEGACY_REGISTRY_RELATIVE_PATHS = [
  '.nightcore/lint-meta/registry.mts',
  '.nightcore/lint-meta/registry.ts',
  '.nightcore/lint-meta/registry.js',
] as const;

/** The version that drops the {@link LEGACY_CONFIG_DIR} fallback. */
export const LEGACY_FALLBACK_REMOVED_IN = '1.0';

/**
 * The one-line deprecation warning printed when the runner reads `legacyRel`
 * because `currentRel` is absent.
 */
export function legacyPathWarning(legacyRel: string, currentRel: string): string {
  return (
    `Deprecated: read ${legacyRel}. Move it to ${currentRel}; ` +
    `@noctcore/harness ${LEGACY_FALLBACK_REMOVED_IN} stops reading ${LEGACY_CONFIG_DIR}/.`
  );
}

/**
 * The error when both the current and the legacy file exist: the runner never
 * picks one silently, since the two can disagree.
 */
export function conflictingPathsError(currentRel: string, legacyRel: string): string {
  return (
    `Found both ${currentRel} and ${legacyRel}, so it is unclear which one to use. ` +
    `Keep ${currentRel} (move anything you still need from ${legacyRel} into it) ` +
    `and delete ${legacyRel}.`
  );
}
