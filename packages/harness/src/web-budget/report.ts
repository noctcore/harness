/* What every bundle budget hands back, and the one unit they print. */

export interface IBudgetReport {
  /** What the check measured, one line per fact. */
  readonly lines: readonly string[];
  /** Why the check fails. Empty when it passes. */
  readonly problems: readonly string[];
}

/** A kB is 1000 bytes in every budget and every limit. */
export const BYTES_PER_KB = 1000;

/** Bytes as kB with two decimals: `12.34 kB`. */
export function asKb(bytes: number): string {
  return `${(bytes / BYTES_PER_KB).toFixed(2)} kB`;
}

/** The weight `percent` headroom over `bytes` gives, rounded down, as kB. */
export function atHeadroom(bytes: number, percent: number): string {
  return asKb(Math.floor(bytes * (1 + percent / 100)));
}

/**
 * Check a headroom percentage before it is used: a number of zero or more.
 * Headroom only prints the limits a percentage over today's weight would give,
 * for the reviewed change that moves one; it never changes a limit.
 */
export function checkHeadroom(percent: number | undefined): number | undefined {
  if (percent !== undefined && (!Number.isFinite(percent) || percent < 0)) {
    throw new Error(`headroom ${String(percent)} is not a percentage`);
  }
  return percent;
}
