/**
 * Parsing + planning of `.noctcore/harness.json` — a faithful Node port of the
 * in-process Rust loader (`workflow/gauntlet_project/config.rs`). Reads the
 * manifest, gates its `schemaVersion`, and turns the `checks[]` array into
 * spawnable {@link PlannedCheck}s. Every "skip" path (absent file, unreadable
 * file, malformed JSON, missing `checks` array, a disabled / command-less /
 * `shell` entry) yields nothing to run, so the gate trivially passes
 * (opt-in-by-presence) — byte-parity with `load_checks` returning an empty vec.
 *
 * Pure over an injected {@link FileReader} so it is unit-testable without a
 * filesystem.
 */
import path from 'node:path';

import {
  conflictingPathsError,
  LEGACY_MANIFEST_RELATIVE_PATH,
  legacyPathWarning,
  MANIFEST_RELATIVE_PATH,
} from './paths.js';

export { LEGACY_MANIFEST_RELATIVE_PATH, MANIFEST_RELATIVE_PATH } from './paths.js';

/**
 * The default per-check wall-clock timeout (ms) when a check declares no
 * `timeoutMs` (or a zero/garbage one). Mirrors the Rust `DEFAULT_CHECK_TIMEOUT`
 * (300s): generous for a whole-repo lint/coverage run, but bounded so a hung
 * check can never pin CI forever.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

/**
 * The highest manifest MAJOR schema version this runner can safely interpret.
 * A bundle stamped higher was authored by a newer Nightcore and must red the
 * build rather than silently pass (the fail-safe direction).
 */
export const SUPPORTED_SCHEMA_MAJOR = 1;

/** A check resolved into the program + args to spawn. */
export interface PlannedCheck {
  name: string;
  /** The manifest `kind` wire string, carried through verbatim to the result. */
  kind: string;
  /** The exact command line, retained for the result + fix instruction. */
  command: string;
  program: string;
  args: string[];
  /** The resolved per-check wall-clock timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * The result of loading a manifest. `no-config` (exit 0, opt-in-by-presence),
 * `schema-too-new` (exit non-zero, upgrade the runner), `unreadable-manifest`
 * (exit non-zero — only reachable for an EXPLICIT `--manifest`, see
 * {@link loadChecks}), `conflicting-manifests` (exit non-zero: both the current
 * and the legacy default manifest exist, see {@link resolveDefaultManifest}), or
 * `ready` with the planned checks (possibly empty ⇒ trivially passing).
 */
export type ManifestOutcome =
  | { kind: 'no-config' }
  | { kind: 'schema-too-new'; found: number }
  | { kind: 'unreadable-manifest'; path: string; reason: string }
  | { kind: 'conflicting-manifests'; message: string }
  | { kind: 'ready'; checks: PlannedCheck[] };

/** Reads an absolute path, returning its contents or `null` if unreadable. */
export type FileReader = (absolutePath: string) => string | null;

/** The absolute manifest path for a target directory. */
export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_RELATIVE_PATH);
}

/** The absolute legacy (pre-0.6) manifest path for a target directory. */
export function legacyManifestPath(dir: string): string {
  return path.join(dir, LEGACY_MANIFEST_RELATIVE_PATH);
}

/**
 * Which default manifest a target directory carries:
 *  - `current`: only `.noctcore/harness.json` (or neither: `raw` is then `null`);
 *  - `legacy`: only `.nightcore/harness.json`, read with a deprecation `warning`;
 *  - `conflict`: both, which is an error (the two can disagree, so the runner never
 *    picks one silently).
 */
export type DefaultManifest =
  | { kind: 'current'; path: string; raw: string | null }
  | { kind: 'legacy'; path: string; raw: string; warning: string }
  | { kind: 'conflict'; message: string };

/** Resolve the default manifest of `dir`, falling back to the legacy location. */
export function resolveDefaultManifest(dir: string, read: FileReader): DefaultManifest {
  const currentPath = manifestPath(dir);
  const legacyPath = legacyManifestPath(dir);
  const current = read(currentPath);
  const legacy = read(legacyPath);
  if (legacy === null) return { kind: 'current', path: currentPath, raw: current };
  if (current !== null) {
    return {
      kind: 'conflict',
      message: conflictingPathsError(MANIFEST_RELATIVE_PATH, LEGACY_MANIFEST_RELATIVE_PATH),
    };
  }
  return {
    kind: 'legacy',
    path: legacyPath,
    raw: legacy,
    warning: legacyPathWarning(LEGACY_MANIFEST_RELATIVE_PATH, MANIFEST_RELATIVE_PATH),
  };
}

/**
 * Resolve the runner's understanding of the root `schemaVersion`. Absent ⇒
 * treated as `1` (a manifest armed before the stamp is a valid v1 bundle). A
 * finite value is floored to its MAJOR; anything unparseable is treated as
 * "too new" (fail-safe).
 */
function resolveSchema(raw: unknown): { tooNew: boolean; found: number } {
  if (raw === undefined || raw === null) return { tooNew: false, found: SUPPORTED_SCHEMA_MAJOR };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { tooNew: true, found: Number.NaN };
  const major = Math.floor(n);
  return { tooNew: major > SUPPORTED_SCHEMA_MAJOR, found: major };
}

/**
 * Resolve one raw manifest entry into a spawnable plan, or `null` when it is not
 * runnable (mirrors `load_checks` + `plan_check`):
 *  - not an object, or a missing/blank/non-string `name` ⇒ skip (malformed).
 *  - `enabled === false` ⇒ skip (explicitly disabled).
 *  - `kind === "shell"` ⇒ skip (the shell drift substrate's execution is a
 *    deliberate fast-follow — a ripgrep `--count` exit code is not a gate verdict).
 *  - absent / blank `command` ⇒ skip (nothing deterministic to run).
 *
 * Any other `kind` (including an unknown/future one) that has a command runs:
 * the runner treats everything except `schemaVersion` as data, so a
 * version-pinned CI stays forward-compatible.
 */
export function planCheck(entry: unknown): PlannedCheck | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const cfg = entry as Record<string, unknown>;

  if (typeof cfg.name !== 'string' || cfg.name.trim() === '') return null;
  if (cfg.enabled === false) return null;

  const kind = typeof cfg.kind === 'string' ? cfg.kind : '';
  if (kind === 'shell') return null;

  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  if (command === '') return null;

  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  const program = tokens[0];
  if (program === undefined) return null;
  const args = tokens.slice(1);

  const declared = cfg.timeoutMs;
  const timeoutMs =
    typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? Math.floor(declared)
      : DEFAULT_CHECK_TIMEOUT_MS;

  return { name: cfg.name, kind, command, program, args, timeoutMs };
}

/**
 * Load + plan the enabled checks from a manifest, reading through the injected
 * {@link FileReader}. See {@link ManifestOutcome} for the non-`ready` paths.
 *
 * `explicitPath` (the CLI's `--manifest`, resolved against `dir`) selects a manifest
 * OTHER than `<dir>/.noctcore/harness.json` — how a portable-lock bundle points CI at
 * its own committed, command-translated copy without disturbing the live manifest
 * Nightcore keeps writing (#325). The two paths differ in POSTURE, deliberately:
 *  - the DEFAULT path is opt-in-by-presence — absent / unreadable / malformed ⇒
 *    `no-config` ⇒ exit 0 (byte-parity with the Rust loader's read-error arm);
 *  - an EXPLICIT path is FAIL-CLOSED — the caller named a file, so an absent or
 *    unparseable one is an error, never a silent pass. (Its CONTENTS stay data: a
 *    parseable manifest with no `checks` array is simply nothing to enforce.)
 *
 * The DEFAULT path falls back to the legacy `<dir>/.nightcore/harness.json` when
 * only that file exists, passing a one-line deprecation notice to `warn`, and
 * returns `conflicting-manifests` when both exist (see {@link resolveDefaultManifest}).
 */
export function loadChecks(
  dir: string,
  read: FileReader,
  explicitPath?: string,
  warn?: (message: string) => void,
): ManifestOutcome {
  const explicit = explicitPath !== undefined && explicitPath !== '';
  let resolved: string;
  let raw: string | null;
  if (explicit) {
    resolved = path.resolve(dir, explicitPath);
    raw = read(resolved);
  } else {
    const found = resolveDefaultManifest(dir, read);
    if (found.kind === 'conflict') return { kind: 'conflicting-manifests', message: found.message };
    if (found.kind === 'legacy') warn?.(found.warning);
    resolved = found.path;
    raw = found.raw;
  }
  if (raw === null) {
    return explicit
      ? {
          kind: 'unreadable-manifest',
          path: resolved,
          reason: 'the file does not exist or is unreadable',
        }
      : { kind: 'no-config' };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    // Malformed JSON ⇒ warn-and-skip everything (exit 0), never a hard failure —
    // unless the caller explicitly named this file (fail-closed).
    return explicit
      ? {
          kind: 'unreadable-manifest',
          path: resolved,
          reason: err instanceof Error ? err.message : 'the file is not valid JSON',
        }
      : { kind: 'no-config' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return explicit
      ? { kind: 'unreadable-manifest', path: resolved, reason: 'its root is not a JSON object' }
      : { kind: 'no-config' };
  }
  const root = value as Record<string, unknown>;

  // The schemaVersion gate is evaluated BEFORE the checks array: a bundle the
  // runner can't safely interpret must red the build even if its checks are
  // absent.
  const schema = resolveSchema(root.schemaVersion);
  if (schema.tooNew) return { kind: 'schema-too-new', found: schema.found };

  const entries = root.checks;
  if (!Array.isArray(entries)) return { kind: 'no-config' };

  const checks: PlannedCheck[] = [];
  for (const entry of entries) {
    const planned = planCheck(entry);
    if (planned !== null) checks.push(planned);
  }
  return { kind: 'ready', checks };
}
