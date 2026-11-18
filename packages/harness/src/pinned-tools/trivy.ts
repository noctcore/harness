/*
 * trivy over images, for known vulnerabilities at or above a severity floor
 * that have a fix, and for secrets left in a layer.
 *
 * Native at exactly the pinned version, else the pinned image when a Docker
 * daemon answers, else BLOCKED. The images are handed to trivy as
 * `docker save` tarballs: no Docker socket is ever mounted into a container.
 *
 * THE VERDICT DEPENDS ON THE DAY. The pin fixes trivy's code, not its
 * vulnerability database, which trivy downloads on every run: an image that
 * passed yesterday fails today when an advisory is published for something it
 * ships. That is the point of the scan. Only what cannot be fixed yet goes in
 * the ignore file, each entry with a statement and an expiry at most
 * `maxIgnoreDays` out.
 *
 * Every run also scans two canaries with the same binary, database and flags:
 * a CycloneDX SBOM naming a package with a known advisory, and a directory
 * holding a token-shaped string made up for the run. Each must be reported, so
 * a pin, a database or a flag that stopped judging fails the check on the day
 * it happens. A database or registry download that fails is BLOCKED.
 */
import type { IImagePin } from './pins.js';
import { TRIVY } from './pins.js';
import type { IRouteDeps, LinterRoute, LinterStatus } from './route.js';
import { DOCKER_COMMAND } from './route.js';
import type { ISpawned } from './tool-run.js';
import { isRecord } from './tool-run.js';

/** The severities that fail, unless the options name others. */
export const TRIVY_SEVERITY_FLOOR: readonly string[] = ['HIGH', 'CRITICAL'];
/** The ignore file trivy and this check read, unless the options name another. */
export const TRIVY_IGNORE_FILE = '.trivyignore.yaml';
/** How far ahead an ignore entry may expire, unless the options say otherwise. */
export const TRIVY_MAX_IGNORE_DAYS = 14;
/** The rule the secret canary must be reported by. */
export const TRIVY_SECRET_CANARY_RULE = 'github-pat';

/** The SBOM canary: a repo-relative CycloneDX file and the advisory it must be reported with. */
export interface ITrivySbomCanary {
  readonly file: string;
  readonly advisory: string;
  /** The severity the advisory must be reported at. Defaults to `CRITICAL`. */
  readonly severity?: string;
}

export interface ITrivyOptions {
  /** The pin to run. Defaults to `TRIVY`. */
  readonly pin?: IImagePin;
  /** The severities that fail. Defaults to HIGH and CRITICAL. */
  readonly severityFloor?: readonly string[];
  /** The repo-relative ignore file. Defaults to `.trivyignore.yaml`. */
  readonly ignoreFile?: string;
  /** How far ahead an ignore entry may expire. Defaults to 14 days. */
  readonly maxIgnoreDays?: number;
}

/*
 * The ignore file.
 *
 * trivy reads it as YAML. This check reads the same file by a strict subset,
 * and then requires the file to be exactly the canonical rendering of what it
 * read (comments and blank lines aside), so anything YAML could mean that the
 * subset did not see (an anchor, a flow mapping, a key trivy honours and this
 * check does not know) is a failure, not a quiet change of what is ignored.
 */

export type TrivyIgnoreSection = 'vulnerabilities' | 'secrets';
const SECTIONS: readonly TrivyIgnoreSection[] = ['vulnerabilities', 'secrets'];

export interface ITrivyIgnoreEntry {
  readonly section: TrivyIgnoreSection;
  readonly id: string;
  /** Globs over the reported file path; empty means every path. */
  readonly paths: readonly string[];
  readonly statement: string;
  /** YYYY-MM-DD. */
  readonly expiredAt: string;
}

export interface ITrivyIgnoreFile {
  readonly entries: readonly ITrivyIgnoreEntry[];
  readonly problems: readonly string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** A scalar as written: a YAML single-quoted string (`''` is a quote), or a bare word. */
function scalar(raw: string): string | null {
  const value = raw.trim();
  const quoted = /^'((?:[^']|'')*)'$/u.exec(value);
  if (quoted !== null) return (quoted[1] ?? '').replaceAll("''", "'");
  return /^[A-Za-z0-9._/*:-]+$/u.test(value) ? value : null;
}

/** A string as the canonical form writes it: single-quoted. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The canonical text of a set of entries; the file must be this, comments and blank lines aside. */
export function renderTrivyIgnoreFile(entries: readonly ITrivyIgnoreEntry[]): string {
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const mine = entries.filter((entry) => entry.section === section);
    if (mine.length === 0) continue;
    lines.push(`${section}:`);
    for (const entry of mine) {
      lines.push(`  - id: ${entry.id}`);
      if (entry.paths.length > 0) {
        lines.push('    paths:');
        for (const path of entry.paths) lines.push(`      - ${quote(path)}`);
      }
      lines.push(`    statement: ${quote(entry.statement)}`);
      lines.push(`    expired_at: ${entry.expiredAt}`);
    }
  }
  return lines.join('\n');
}

function meaningful(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The entries of the ignore file and what is wrong with it, judged on `today`
 * (YYYY-MM-DD, UTC). Every entry needs an id, a statement and an `expired_at`
 * that is a real date, not past and at most `maxIgnoreDays` ahead. An entry
 * that has expired stops applying in trivy too, so its finding comes back.
 */
export function readTrivyIgnoreFile(
  text: string,
  today: string,
  options: Pick<ITrivyOptions, 'ignoreFile' | 'maxIgnoreDays'> = {},
): ITrivyIgnoreFile {
  const ignoreFile = options.ignoreFile ?? TRIVY_IGNORE_FILE;
  const maxDays = options.maxIgnoreDays ?? TRIVY_MAX_IGNORE_DAYS;
  const problems: string[] = [];
  const entries: ITrivyIgnoreEntry[] = [];
  let section: TrivyIgnoreSection | null = null;
  let current: { -readonly [K in keyof ITrivyIgnoreEntry]?: ITrivyIgnoreEntry[K] } | null = null;
  let inPaths = false;
  const finish = (): void => {
    if (current === null) return;
    const id = current.id ?? '';
    const where = `${ignoreFile}: ${id === '' ? 'an entry' : id}`;
    if (id === '') problems.push(`${where} has no id`);
    if ((current.statement ?? '').trim() === '') {
      problems.push(`${where} has no statement: say why it is ignored and what ends it`);
    }
    const expiredAt = current.expiredAt ?? '';
    if (!DATE.test(expiredAt) || Number.isNaN(Date.parse(`${expiredAt}T00:00:00Z`))) {
      problems.push(`${where} has no expired_at date (YYYY-MM-DD): an ignore must end`);
    } else {
      const days = daysBetween(today, expiredAt);
      if (days < 0) problems.push(`${where} expired on ${expiredAt}: fix it or renew it`);
      if (days > maxDays) {
        problems.push(`${where} expires ${expiredAt}, more than ${String(maxDays)} days out`);
      }
    }
    entries.push({
      section: current.section ?? 'vulnerabilities',
      id,
      paths: current.paths ?? [],
      statement: current.statement ?? '',
      expiredAt,
    });
    current = null;
  };

  text.split(/\r?\n/u).forEach((raw, index) => {
    const where = `${ignoreFile}:${String(index + 1)}`;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    const top = /^([a-z_]+):$/u.exec(raw);
    if (top !== null) {
      finish();
      inPaths = false;
      const name = top[1] ?? '';
      if ((SECTIONS as readonly string[]).includes(name)) {
        section = name as TrivyIgnoreSection;
      } else {
        section = null;
        problems.push(`${where}: ${name} is not a section this check knows`);
      }
      return;
    }
    const start = /^ {2}- id: (.+)$/u.exec(raw);
    if (start !== null) {
      finish();
      inPaths = false;
      if (section === null) problems.push(`${where}: an entry outside a known section`);
      current = { section: section ?? 'vulnerabilities', id: scalar(start[1] ?? '') ?? '' };
      return;
    }
    const field = /^ {4}([a-z_]+):(?: (.*))?$/u.exec(raw);
    if (field !== null && current !== null) {
      const key = field[1] ?? '';
      const value = field[2];
      inPaths = key === 'paths' && value === undefined;
      if (key === 'paths' && value === undefined) current.paths = [];
      else if (key === 'statement' && value !== undefined) current.statement = scalar(value) ?? '';
      else if (key === 'expired_at' && value !== undefined) current.expiredAt = value.trim();
      else problems.push(`${where}: ${key} is not a field this check knows`);
      return;
    }
    const path = /^ {6}- (.+)$/u.exec(raw);
    if (path !== null && current !== null && inPaths) {
      const value = scalar(path[1] ?? '');
      if (value === null) problems.push(`${where}: a path this check cannot read`);
      else current.paths = [...(current.paths ?? []), value];
      return;
    }
    problems.push(`${where}: not a line this check can read (${raw.trim()})`);
  });
  finish();

  if (problems.length === 0 && meaningful(text) !== renderTrivyIgnoreFile(entries)) {
    problems.push(
      `${ignoreFile} is not in the form this check reads (paths and statements in single ` +
        'quotes, two spaces per level): it would be read one way here and maybe ' +
        'another way by trivy',
    );
  }
  return { entries, problems };
}

/* The report. */

export interface ITrivyVulnerability {
  readonly kind: 'vulnerability';
  readonly target: string;
  readonly id: string;
  readonly severity: string;
  readonly pkg: string;
  readonly installed: string;
  readonly fixed: string;
  readonly path: string;
}

export interface ITrivySecret {
  readonly kind: 'secret';
  readonly target: string;
  readonly rule: string;
  readonly severity: string;
  readonly title: string;
  readonly line: number;
}

export type TrivyFinding = ITrivyVulnerability | ITrivySecret;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** trivy's `--format json` report, or null when the output is not one. */
export function parseTrivyReport(stdout: string): readonly TrivyFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.SchemaVersion !== 'number') return null;
  const results = parsed.Results ?? [];
  if (!Array.isArray(results)) return null;
  const findings: TrivyFinding[] = [];
  for (const result of results as readonly unknown[]) {
    if (!isRecord(result)) return null;
    const target = text(result.Target);
    const vulnerabilities = result.Vulnerabilities ?? [];
    const secrets = result.Secrets ?? [];
    if (!Array.isArray(vulnerabilities) || !Array.isArray(secrets)) return null;
    for (const entry of vulnerabilities as readonly unknown[]) {
      if (!isRecord(entry) || typeof entry.VulnerabilityID !== 'string') return null;
      findings.push({
        kind: 'vulnerability',
        target,
        id: entry.VulnerabilityID,
        severity: text(entry.Severity),
        pkg: text(entry.PkgName),
        installed: text(entry.InstalledVersion),
        fixed: text(entry.FixedVersion),
        path: text(entry.PkgPath),
      });
    }
    for (const entry of secrets as readonly unknown[]) {
      if (!isRecord(entry) || typeof entry.RuleID !== 'string') return null;
      findings.push({
        kind: 'secret',
        target,
        rule: entry.RuleID,
        severity: text(entry.Severity),
        title: text(entry.Title),
        line: typeof entry.StartLine === 'number' ? entry.StartLine : 0,
      });
    }
  }
  return findings;
}

/**
 * Whether an image scan judged the image's OS packages. trivy that cannot tell
 * the OS, or knows it and has no data for it, reports no OS finding, which
 * would read as a clean base. The report must name the OS (Metadata.OS) and
 * carry an `os-pkgs` result; anything else fails (never blocked: it is a
 * property of the image, not of the run).
 */
export function osCoverageProblem(image: string, stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return `${image}: trivy printed no report it can be judged by`;
  }
  const report = isRecord(parsed) ? parsed : {};
  const metadata = isRecord(report.Metadata) ? report.Metadata : {};
  const os = isRecord(metadata.OS) ? metadata.OS : {};
  const family = text(os.Family);
  if (family === '') {
    return `${image}: trivy could not tell the image's OS, so none of its OS packages was judged`;
  }
  const results = Array.isArray(report.Results) ? (report.Results as readonly unknown[]) : [];
  if (!results.some((result) => isRecord(result) && result.Class === 'os-pkgs')) {
    return (
      `${image}: trivy found ${family} ${text(os.Name)} but judged none of its packages ` +
      '(an OS release its database does not cover)'
    );
  }
  return null;
}

/**
 * What fails: every secret, and every vulnerability at or above the floor.
 * trivy is asked for the floor already (`--severity`); judging it here as
 * well means a flag that stopped working cannot change the verdict.
 */
export function failingFindings(
  findings: readonly TrivyFinding[],
  severityFloor: readonly string[] = TRIVY_SEVERITY_FLOOR,
): readonly TrivyFinding[] {
  return findings.filter(
    (finding) => finding.kind === 'secret' || severityFloor.includes(finding.severity),
  );
}

export function describeTrivyFinding(image: string, finding: TrivyFinding): string {
  if (finding.kind === 'secret') {
    return `${image}: secret ${finding.rule} (${finding.severity}) ${finding.title} in ${finding.target}:${String(finding.line)}`;
  }
  const where = finding.path === '' ? finding.target : finding.path;
  return `${image}: ${finding.id} ${finding.severity} ${finding.pkg} ${finding.installed}, fixed in ${finding.fixed}, ${where}`;
}

/** The SBOM canary's problem, or null when its advisory was reported at its severity. */
export function sbomCanaryProblem(
  findings: readonly TrivyFinding[],
  canary: ITrivySbomCanary,
): string | null {
  const severity = canary.severity ?? 'CRITICAL';
  const hit = findings.some(
    (finding) =>
      finding.kind === 'vulnerability' &&
      finding.id === canary.advisory &&
      finding.severity === severity,
  );
  return hit
    ? null
    : `${canary.file}: trivy did not report ${canary.advisory} at ${severity}. The pinned ` +
        'tool, its database or the flags no longer judge what this check relies on.';
}

/** The secret canary's problem, or null when the made-up token was reported by `rule`. */
export function secretCanaryProblem(
  findings: readonly TrivyFinding[],
  rule: string = TRIVY_SECRET_CANARY_RULE,
): string | null {
  const hit = findings.some((finding) => finding.kind === 'secret' && finding.rule === rule);
  return hit
    ? null
    : `the secret canary: trivy did not report a ${rule} secret. The secret ` +
        'scanner no longer judges what this check relies on.';
}

/**
 * A token in the shape the github-pat rule matches, from `bytes` (at least 27
 * random bytes). Made up for one run; never a real token.
 */
export function secretCanaryToken(bytes: Uint8Array): string {
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/[^A-Za-z0-9]/gu, 'A')
    .slice(0, 36);
  if (body.length < 36) throw new Error('secretCanaryToken: needs at least 27 bytes');
  return `ghp_${body}`;
}

/* Running trivy. */

/** Paths trivy is handed, as the route sees them. */
export interface ITrivyPaths {
  /** The repository root (the ignore file and the SBOM canary are read from it). */
  readonly root: string;
  /** The run's work directory: image tarballs, the secret canary, the database cache. */
  readonly work: string;
}

/*
 * trivy reads a `trivy.yaml` and a `trivy-secret.yaml` from its working
 * directory, and any `TRIVY_*` variable, and each can change what is judged
 * (skip-dirs, pkg-types, a VEX document, secret allow-rules). So every scan
 * names two empty files the run writes into its own work directory, runs
 * there, and gets an environment without `TRIVY_*` (trivyScanEnv).
 */
export const TRIVY_CONFIG_FILES = { config: 'trivy.yaml', secret: 'trivy-secret.yaml' } as const;
/** Their content: an empty mapping, which sets nothing. */
export const TRIVY_EMPTY_CONFIG = '{}\n';

/** `env` without any TRIVY_* variable (in any case) and without unset entries. */
export function trivyScanEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].toUpperCase().startsWith('TRIVY_'),
    ),
  );
}

/** Where the docker route mounts the two directories. */
export const TRIVY_CONTAINER_PATHS: ITrivyPaths = { root: '/repo', work: '/work' };

export type TrivyScanTarget =
  | { readonly kind: 'image'; readonly tarball: string }
  | { readonly kind: 'sbom'; readonly file: string }
  | { readonly kind: 'secret-canary'; readonly dir: string };

/**
 * trivy's arguments for one scan, paths as the route sees them. The first
 * scan of a run downloads the database into the run's own cache
 * (`updateDb`); the rest reuse it. Telemetry, the version check and every
 * online lookup beyond the database are off.
 */
export function trivyScanArgs(
  target: TrivyScanTarget,
  paths: ITrivyPaths,
  updateDb: boolean,
  options: Pick<ITrivyOptions, 'severityFloor' | 'ignoreFile'> = {},
): readonly string[] {
  const subject =
    target.kind === 'image'
      ? ['image', '--input', `${paths.work}/${target.tarball}`, '--scanners', 'vuln,secret']
      : target.kind === 'sbom'
        ? ['sbom', '--scanners', 'vuln', `${paths.root}/${target.file}`]
        : ['fs', '--scanners', 'secret', `${paths.work}/${target.dir}`];
  return [
    ...subject,
    '--severity',
    (options.severityFloor ?? TRIVY_SEVERITY_FLOOR).join(','),
    '--ignore-unfixed',
    '--ignorefile',
    `${paths.root}/${options.ignoreFile ?? TRIVY_IGNORE_FILE}`,
    '--cache-dir',
    `${paths.work}/cache`,
    '--config',
    `${paths.work}/${TRIVY_CONFIG_FILES.config}`,
    // `trivy sbom` scans no secrets and refuses the flag.
    ...(target.kind === 'sbom'
      ? []
      : ['--secret-config', `${paths.work}/${TRIVY_CONFIG_FILES.secret}`]),
    ...(updateDb ? [] : ['--skip-db-update']),
    '--format',
    'json',
    '--exit-code',
    '0',
    '--no-progress',
    '--disable-telemetry',
    '--skip-version-check',
    '--offline-scan',
  ];
}

/**
 * `docker run` for the pinned image, the repo read-only and the work directory
 * mounted. `extra` goes before the image: `--user uid:gid` on POSIX makes the
 * cache the container writes the host user's, and `--name` lets an interrupt
 * remove the container.
 */
export function trivyDockerArgs(
  host: ITrivyPaths,
  args: readonly string[],
  extra: readonly string[] = [],
  pin: IImagePin = TRIVY,
): readonly string[] {
  return [
    'run',
    '--rm',
    ...(pin.platform === undefined ? [] : ['--platform', pin.platform]),
    ...extra,
    '-v',
    `${host.root}:${TRIVY_CONTAINER_PATHS.root}:ro`,
    '-v',
    `${host.work}:${TRIVY_CONTAINER_PATHS.work}`,
    '-w',
    TRIVY_CONTAINER_PATHS.work,
    pin.image,
    ...args,
  ];
}

/** Native at the pinned version, else the pinned image, else blocked. `args` are filled in per scan. */
export function chooseTrivyRoute(deps: IRouteDeps, pin: IImagePin = TRIVY): LinterRoute {
  const found = deps.nativeVersion(pin);
  if (found === pin.version) return { kind: 'native', command: pin.name, args: [] };
  if (deps.dockerAvailable()) return { kind: 'docker', image: pin.image, args: [] };
  const native =
    found === null
      ? `no native ${pin.name}`
      : `native ${pin.name} ${found} is not the pinned ${pin.version}`;
  return {
    kind: 'blocked',
    reason: `${native}, and no Docker daemon answered. Start Docker, or install ${pin.name} ${pin.version}.`,
  };
}

/*
 * A run that failed because something could not be fetched proved nothing
 * about the image: blocked. That is the database, a registry, or the network
 * under either. Anything else trivy failed on is a failure.
 */
const UNREACHABLE =
  /(failed to download|download (vulnerability )?db|db error|OCI repository error|no such host|i\/o timeout|connection refused|connection reset|TLS handshake timeout|network is unreachable|toomanyrequests|rate limit|429 Too Many|Temporary failure in name resolution)/iu;

export function classifyTrivyFailure(stderr: string): 'blocked' | 'failed' {
  return UNREACHABLE.test(stderr) ? 'blocked' : 'failed';
}

/** An image to scan: the name the findings are reported under, and the local ref to save. */
export interface ITrivyImage {
  readonly name: string;
  readonly ref: string;
}

/** The deps of `scanImages`: everything it spawns or writes. */
export interface ITrivyScanDeps extends IRouteDeps {
  /** Run with the output captured. `env`, when given, is the whole environment. */
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
  ) => Promise<ISpawned>;
  readonly writeFile: (path: string, text: string) => void;
  readonly mkdir: (path: string) => void;
  readonly remove: (path: string) => void;
  /** Join path segments the host's way. */
  readonly join: (...parts: string[]) => string;
  /** Random bytes for the secret canary's token. */
  readonly randomBytes: (count: number) => Uint8Array;
  /** The environment a native scan starts from (TRIVY_* is dropped). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Extra `docker run` arguments, such as `--user uid:gid`. */
  readonly dockerUser?: readonly string[];
  /**
   * The name the n-th container of the run gets. Called before the container
   * starts, so a caller can record it and remove it on an interrupt.
   */
  readonly containerName?: (scan: number) => string;
  /** Whether a pull failed for want of the network (blocked) or for anything else (failed). */
  readonly classifyPullFailure?: (output: string) => 'blocked' | 'failed';
  /** A progress line (a pull starting). */
  readonly log?: (line: string) => void;
}

export interface ITrivyScanOptions extends ITrivyOptions {
  /** The repository root. */
  readonly root: string;
  /** An empty directory the run owns; the caller removes it afterwards. */
  readonly work: string;
  readonly sbomCanary: ITrivySbomCanary;
  /** The rule the secret canary must be reported by. Defaults to `github-pat`. */
  readonly secretCanaryRule?: string;
  /** A clock for the per-image seconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * What `scanImages` decided. `lines` are progress per image; `problems` fail
 * the check; `error` is the full message of the step that ended the run early.
 */
export interface ITrivyScanResult {
  readonly status: LinterStatus;
  readonly reason: string;
  readonly via: string;
  readonly lines: readonly string[];
  readonly problems: readonly string[];
  readonly error?: string;
}

/** A scan step that ended the run. */
class TrivyStepError extends Error {
  constructor(
    readonly status: 'failed' | 'blocked',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Find trivy, scan both canaries (the SBOM scan downloads the database for the
 * whole run), then `docker save` each image into the work directory and scan
 * it: failing findings, and an OS that was not judged, are problems. A run
 * that could not fetch the database, a registry or the image is blocked; a
 * tarball trivy cannot open is failed.
 */
export async function scanImages(
  images: readonly ITrivyImage[],
  deps: ITrivyScanDeps,
  options: ITrivyScanOptions,
): Promise<ITrivyScanResult> {
  const pin = options.pin ?? TRIVY;
  const docker = deps.dockerCommand ?? DOCKER_COMMAND;
  const now = options.now ?? Date.now;
  const lines: string[] = [];
  const route = chooseTrivyRoute(deps, pin);
  if (route.kind === 'blocked') {
    return { status: 'blocked', reason: route.reason, via: 'none', lines, problems: [] };
  }
  const via = route.kind === 'native' ? 'native' : 'pinned image';
  let scans = 0;

  const scan = async (
    target: TrivyScanTarget,
    updateDb: boolean,
  ): Promise<{ readonly findings: readonly TrivyFinding[]; readonly report: string }> => {
    scans += 1;
    const host: ITrivyPaths = { root: options.root, work: options.work };
    const name = deps.containerName?.(scans);
    const ran =
      route.kind === 'native'
        ? await deps.run(pin.name, trivyScanArgs(target, host, updateDb, options), {
            cwd: options.work,
            env: trivyScanEnv(deps.env),
          })
        : await deps.run(
            docker,
            trivyDockerArgs(
              host,
              trivyScanArgs(target, TRIVY_CONTAINER_PATHS, updateDb, options),
              [...(deps.dockerUser ?? []), ...(name === undefined ? [] : ['--name', name])],
              pin,
            ),
            { cwd: options.root },
          );
    const stderr = ran.stderr.trim();
    if (ran.code !== 0) {
      const status =
        ran.code === null || (route.kind === 'docker' && ran.code === 125)
          ? 'blocked'
          : classifyTrivyFailure(stderr);
      throw new TrivyStepError(
        status,
        `trivy exited ${String(ran.code)}: ${stderr.split('\n').at(-1) ?? ''}\n${stderr}`,
      );
    }
    const findings = parseTrivyReport(ran.stdout);
    if (findings === null) {
      throw new TrivyStepError('failed', `trivy printed no report it can be judged by:\n${stderr}`);
    }
    return { findings, report: ran.stdout };
  };

  try {
    if (route.kind === 'docker') {
      const present = await deps.run(docker, ['image', 'inspect', pin.image], {
        cwd: options.root,
      });
      if (present.code !== 0) {
        deps.log?.(`pulling ${pin.image}`);
        const pulled = await deps.run(
          docker,
          [
            'pull',
            '--quiet',
            ...(pin.platform === undefined ? [] : ['--platform', pin.platform]),
            pin.image,
          ],
          { cwd: options.root },
        );
        if (pulled.code !== 0) {
          const out = `${pulled.stdout}${pulled.stderr}`;
          throw new TrivyStepError(
            deps.classifyPullFailure?.(out) ?? 'blocked',
            `pull failed:\n${out}`,
          );
        }
      }
    }
    deps.mkdir(deps.join(options.work, 'cache'));
    deps.writeFile(deps.join(options.work, TRIVY_CONFIG_FILES.config), TRIVY_EMPTY_CONFIG);
    deps.writeFile(deps.join(options.work, TRIVY_CONFIG_FILES.secret), TRIVY_EMPTY_CONFIG);

    const problems: string[] = [];
    const sbom = await scan({ kind: 'sbom', file: options.sbomCanary.file }, true);
    const sbomProblem = sbomCanaryProblem(sbom.findings, options.sbomCanary);
    if (sbomProblem !== null) problems.push(sbomProblem);
    const canaryDir = 'secret-canary';
    deps.mkdir(deps.join(options.work, canaryDir));
    const token = secretCanaryToken(deps.randomBytes(27));
    deps.writeFile(deps.join(options.work, canaryDir, 'env'), `GITHUB_TOKEN=${token}\n`);
    const secret = await scan({ kind: 'secret-canary', dir: canaryDir }, false);
    const secretProblem = secretCanaryProblem(secret.findings, options.secretCanaryRule);
    if (secretProblem !== null) problems.push(secretProblem);

    for (const image of images) {
      const tarball = `${image.name}.tar`;
      const saved = await deps.run(
        docker,
        ['save', '--output', deps.join(options.work, tarball), image.ref],
        { cwd: options.root },
      );
      if (saved.code !== 0) {
        throw new TrivyStepError(
          'failed',
          `docker save ${image.ref}:\n${saved.stdout}${saved.stderr}`,
        );
      }
      const started = now();
      const scanned = await scan({ kind: 'image', tarball }, false);
      const findings = failingFindings(scanned.findings, options.severityFloor);
      const coverage = osCoverageProblem(image.name, scanned.report);
      if (coverage !== null) problems.push(coverage);
      const seconds = Math.round((now() - started) / 100) / 10;
      deps.remove(deps.join(options.work, tarball));
      lines.push(
        `${image.name} (${image.ref}): ${String(findings.length)} finding(s), scanned in ${String(seconds)}s`,
      );
      problems.push(...findings.map((finding) => describeTrivyFinding(image.name, finding)));
    }
    const floor = (options.severityFloor ?? TRIVY_SEVERITY_FLOOR).join(' or ');
    return problems.length > 0
      ? {
          status: 'failed',
          reason: `${String(problems.length)} problem(s) in ${String(images.length)} image(s), ${via}`,
          via,
          lines,
          problems,
        }
      : {
          status: 'passed',
          reason: `${String(images.length)} image(s), no finding at ${floor} with a fix, 2 canaries reported, ${via}`,
          via,
          lines,
          problems,
        };
  } catch (error) {
    const step =
      error instanceof TrivyStepError ? error : new TrivyStepError('failed', String(error));
    return {
      status: step.status,
      reason: step.message.split('\n', 1)[0] ?? '',
      via,
      lines,
      problems: [],
      error: step.message,
    };
  }
}
