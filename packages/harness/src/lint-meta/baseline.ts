/**
 * The generic lint-meta ratchet — a faithful port of `tools/lint-meta/baseline.ts`.
 *
 * A baseline is a committed `<baselineDir>/<rule-id>.json` — a flat `key → number`
 * map freezing today's offenders at their current metric. The ratchet is one-way:
 * an offender that is recorded AND has not grown past its frozen value is
 * grandfathered (suppressed); a NEW offender, or a recorded one that GREW, is a
 * live violation. As each offender is fixed, its entry is deleted (or lowered),
 * never raised — the frozen debt only shrinks.
 *
 * The `key` is opaque to this module: a rule with more than one metric family
 * namespaces its keys (`size:<file>`, `manifest:<file>`) so one flat map serves both.
 *
 * The only portability change from the internal engine is the baseline HOME: the
 * Nightcore engine hardcodes `tools/lint-meta/baselines/`, whereas a portable rule
 * ships its baselines under {@link DEFAULT_BASELINE_DIR} (overridable per call).
 */
import { conflictingPathsError, legacyPathWarning } from '../paths.js';
import type { IMetaCtx } from './types.js';

/** Where a portable rule's committed baselines live, relative to the repo root. */
export const DEFAULT_BASELINE_DIR = '.noctcore/lint-meta/baselines';

/**
 * The pre-0.6 baseline home. {@link loadBaseline} reads a rule's baseline from here,
 * with a deprecation warning, only when it is called with the default directory and
 * the file under {@link DEFAULT_BASELINE_DIR} is absent. Support ends in 1.0.
 */
export const LEGACY_BASELINE_DIR = '.nightcore/lint-meta/baselines';

/** Legacy baseline files already warned about, so a run prints each warning once. */
const warnedLegacyBaselines = new Set<string>();

/**
 * Read a rule's committed baseline text from the default home, falling back to the
 * legacy one. Throws when both exist: the rule then fails with that message, which
 * reds the build instead of ratcheting against a silently chosen file.
 */
function readDefaultBaseline(ctx: IMetaCtx, ruleId: string): string | null {
  const currentRel = `${DEFAULT_BASELINE_DIR}/${ruleId}.json`;
  const legacyRel = `${LEGACY_BASELINE_DIR}/${ruleId}.json`;
  const current = ctx.read(currentRel);
  const legacy = ctx.read(legacyRel);
  if (legacy === null) return current;
  if (current !== null) throw new Error(conflictingPathsError(currentRel, legacyRel));
  const key = `${ctx.root}\0${legacyRel}`;
  if (!warnedLegacyBaselines.has(key)) {
    warnedLegacyBaselines.add(key);
    console.warn(legacyPathWarning(legacyRel, currentRel));
  }
  return legacy;
}

/**
 * Load a rule's committed baseline, or `{}` when none exists yet. With the default
 * `baselineDir`, a baseline only under the legacy `.nightcore/lint-meta/baselines/`
 * is still read (with a deprecation warning), and one in both homes throws.
 */
export function loadBaseline(
  ctx: IMetaCtx,
  ruleId: string,
  baselineDir: string = DEFAULT_BASELINE_DIR,
): Record<string, number> {
  const raw =
    baselineDir === DEFAULT_BASELINE_DIR
      ? readDefaultBaseline(ctx, ruleId)
      : ctx.read(`${baselineDir}/${ruleId}.json`);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isNumberMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether `current` for `key` is grandfathered by `baseline`: recorded AND not
 * grown past the frozen value. A key absent from the baseline is never
 * grandfathered (a new offender always fails); a recorded key whose current value
 * is `<=` its record passes (the ratchet permits staying same-or-shrinking).
 */
export function isGrandfathered(
  baseline: Record<string, number>,
  key: string,
  current: number,
): boolean {
  const frozen = baseline[key];
  return frozen !== undefined && current <= frozen;
}

/** Serialize a baseline map with sorted keys for a stable, diff-friendly file. */
export function serializeBaseline(map: Record<string, number>): string {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) sorted[key] = value;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function isNumberMap(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' && v !== null && Object.values(v).every((n) => typeof n === 'number')
  );
}
