/*
 * The migrations that existed when the lock check arrived, each pinned by the
 * sha256 of its file (squawkSha256). They are never linted. The set only loses
 * members: a pinned migration whose folder is deleted moves to RETIRED with
 * its hash. Every change to this file needs a second reader.
 */
export const BASELINE: Readonly<Record<string, string>> = {
  '20260101000000_init': 'beaa7e665bb8ea9c6d5e3f3b534bc9cbf79bd87097e7043708f2695af708adb7',
};
export const RETIRED: Readonly<Record<string, string>> = {};
/** baselineSeal(BASELINE, RETIRED), recomputed only when the lists change. */
export const BASELINE_SEAL = '8d3fb01a93c5d58f9895fd892b94ae09548da5538c05195d88d73c2851cca038';
