/*
 * hadolint, the Dockerfile linter, over every Dockerfile git tracks. It
 * reports what makes an image build fragile or unsafe: a shell pipe that
 * hides a failed download, a relative WORKDIR, a root last USER, a shell-form
 * CMD, and every RUN body through ShellCheck (linked in as a library, so the
 * native binary and the image judge RUN bodies with the same ShellCheck).
 *
 * Native at exactly the pinned version, else the pinned image when a Docker
 * daemon answers, else BLOCKED. Every run also lints the repo's canaries with
 * the same binary and configuration, so a pin or a configuration that stopped
 * judging fails on the day it happens.
 *
 * There is no inline escape: a `# hadolint` pragma in a linted Dockerfile
 * fails the check before hadolint runs, and the configuration must turn
 * pragmas off as well.
 */
import type { IImagePin } from './pins.js';
import { HADOLINT } from './pins.js';
import type { LinterRoute } from './route.js';
import type { ICapturedRunDeps, IToolCanary, IToolResult } from './tool-run.js';
import {
  canaryProblems,
  chooseToolRoute,
  findingsVerdict,
  isRecord,
  plural,
  runCaptured,
  unjudgeable,
} from './tool-run.js';

/** The configuration file a run reads, unless the options name another. */
export const HADOLINT_CONFIG = '.hadolint.yaml';

export interface IHadolintOptions {
  /** The pin to run. Defaults to `HADOLINT`. */
  readonly pin?: IImagePin;
  /** The repo-relative configuration file. Defaults to `.hadolint.yaml`. */
  readonly configFile?: string;
  /** Fixtures hadolint must report exactly as pinned on every run. Never linted as Dockerfiles. */
  readonly canaries?: readonly IToolCanary[];
  /** Repo-relative path prefixes whose Dockerfiles are not linted (a fixtures directory). */
  readonly exclude?: readonly string[];
}

/** `Dockerfile`, `x.Dockerfile` and `Dockerfile.x`, in any directory. */
const DOCKERFILE = /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile|Dockerfile\.[^/]+)$/u;

/** The Dockerfiles among git's tracked files, minus the excluded prefixes and the canaries, sorted. */
export function dockerfiles(
  tracked: readonly string[],
  options: Pick<IHadolintOptions, 'canaries' | 'exclude'> = {},
): readonly string[] {
  const canaries = new Set((options.canaries ?? []).map((canary) => canary.file));
  const exclude = options.exclude ?? [];
  return tracked
    .filter(
      (file) =>
        DOCKERFILE.test(file) &&
        !canaries.has(file) &&
        !exclude.some((prefix) => file.startsWith(prefix)),
    )
    .sort();
}

/*
 * Any hadolint pragma in a comment: `# hadolint ignore=DL3008`, `# hadolint
 * global ignore=...`, `# hadolint shell=powershell`. Matched in any case: a
 * Dockerfile has no other reason to hold the word in a comment.
 */
const PRAGMA = /^\s*#\s*hadolint\b/iu;

/** What the check refuses in the text of one linted Dockerfile, before hadolint reads it. */
export function dockerfileProblems(
  file: string,
  text: string,
  configFile: string = HADOLINT_CONFIG,
): readonly string[] {
  return text
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      PRAGMA.test(line)
        ? [
            `${file}:${String(index + 1)}: a hadolint pragma. A Dockerfile is made to pass, or ` +
              `the rule is turned off for every Dockerfile in ${configFile} with its reason; ` +
              'a finding is never ignored in place.',
          ]
        : [],
    );
}

/*
 * The configuration, read line by line: it is a short file, and reading it
 * here means a key hadolint would honour that this check does not know is a
 * failure, not a quiet change of what is judged.
 *
 *   failure-threshold: style       everything hadolint reports fails
 *   disable-ignore-pragma: true
 *   trustedRegistries:             the registries a FROM may pull from
 *     - docker.io
 *   ignored:                       each rule that is off, with its reason
 *     - DL3008 # why
 */
const KNOWN_KEYS = new Set([
  'failure-threshold',
  'disable-ignore-pragma',
  'trustedRegistries',
  'ignored',
]);
const RULE_CODE = /^(?:DL|SC)\d{4}$/u;
/**
 * The keys whose value is a list. Each must be a block list, one `- item` per
 * line: hadolint reads an inline value too (`ignored: [DL3002, DL3025]`,
 * `trustedRegistries: []`) and applies it, but this check would see no item,
 * no rule code and no reason.
 */
const LIST_KEYS = new Set(['ignored', 'trustedRegistries']);

export interface IHadolintConfig {
  /** The rule codes the configuration turns off. */
  readonly ignored: readonly string[];
  readonly problems: readonly string[];
}

function stripComment(line: string): { readonly text: string; readonly comment: string } {
  const at = line.indexOf('#');
  return at === -1
    ? { text: line.trimEnd(), comment: '' }
    : { text: line.slice(0, at).trimEnd(), comment: line.slice(at + 1).trim() };
}

/**
 * The ignored rules of a hadolint configuration and what is wrong with it:
 * `failure-threshold` must be `style` (every finding fails),
 * `disable-ignore-pragma` must be `true`, `trustedRegistries` must name at
 * least one registry, every ignored rule needs a reason after a `#`, and any
 * other key, a key written twice or a list written inline is a problem.
 */
export function readHadolintConfig(
  text: string,
  configFile: string = HADOLINT_CONFIG,
): IHadolintConfig {
  const problems: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  const items = new Map<string, number>();
  let list: string | null = null;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const where = `${configFile}:${String(index + 1)}`;
    const { text: line, comment } = stripComment(raw);
    if (line.trim() === '') return;
    const item = /^\s+-\s+(\S+)$/u.exec(line);
    if (item !== null) {
      const value = item[1] ?? '';
      if (list !== null) items.set(list, (items.get(list) ?? 0) + 1);
      if (list === 'ignored') {
        if (!RULE_CODE.test(value)) problems.push(`${where}: ${value} is not a rule code`);
        if (comment === '') {
          problems.push(`${where}: ${value} is ignored without a reason: say why after a #`);
        }
        ignored.push(value);
      } else if (list !== 'trustedRegistries') {
        problems.push(`${where}: a list item outside ignored or trustedRegistries`);
      }
      return;
    }
    const pair = /^([A-Za-z-]+):\s*(.*)$/u.exec(line);
    const key = pair?.[1];
    if (pair === null || key === undefined) {
      problems.push(`${where}: not a line this check can read (${raw.trim()})`);
      return;
    }
    if (!KNOWN_KEYS.has(key)) {
      problems.push(
        `${where}: ${key} is not a key this check knows, so it cannot tell what it changes`,
      );
    }
    if (seen.has(key)) {
      problems.push(`${where}: ${key} is written twice, and YAML keeps only the last`);
    }
    seen.add(key);
    const value = pair[2] ?? '';
    list = value === '' ? key : null;
    if (LIST_KEYS.has(key) && value !== '') {
      problems.push(`${where}: ${key} must be a block list, one item per line`);
    }
    if (!LIST_KEYS.has(key) && value === '') {
      problems.push(`${where}: ${key} has no value`);
    }
    if (key === 'failure-threshold' && value !== 'style') {
      problems.push(`${where}: failure-threshold must be style, so every finding fails`);
    }
    if (key === 'disable-ignore-pragma' && value !== 'true') {
      problems.push(`${where}: disable-ignore-pragma must be true`);
    }
  });
  for (const key of ['failure-threshold', 'disable-ignore-pragma', 'trustedRegistries']) {
    if (!seen.has(key)) problems.push(`${configFile}: no ${key}`);
  }
  if (seen.has('trustedRegistries') && (items.get('trustedRegistries') ?? 0) === 0) {
    problems.push(`${configFile}: trustedRegistries names no registry, which turns DL3026 off`);
  }
  return { ignored, problems };
}

/** One finding of hadolint's JSON report. Lines are 1-based. */
export interface IHadolintFinding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly level: string;
  readonly message: string;
}

/** hadolint's `--format json` report, or null when the output is not one. Empty output is no finding. */
export function parseHadolintReport(stdout: string): readonly IHadolintFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const findings: IHadolintFinding[] = [];
  for (const entry of parsed as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== 'string' ||
      typeof entry.line !== 'number' ||
      typeof entry.code !== 'string' ||
      typeof entry.level !== 'string' ||
      typeof entry.message !== 'string'
    ) {
      return null;
    }
    findings.push({
      file: entry.file,
      line: entry.line,
      code: entry.code,
      level: entry.level,
      message: entry.message,
    });
  }
  return findings;
}

/** The arguments hadolint runs with, the same on both routes. */
export function hadolintArgs(
  files: readonly string[],
  configFile: string = HADOLINT_CONFIG,
): readonly string[] {
  return ['--config', configFile, '--format', 'json', '--no-color', ...files];
}

/** `docker run` for the pinned image: the repo read-only as the working directory, no network. */
export function hadolintDockerArgs(
  root: string,
  files: readonly string[],
  options: Pick<IHadolintOptions, 'pin' | 'configFile'> = {},
): readonly string[] {
  const pin = options.pin ?? HADOLINT;
  // The image's command is `/bin/hadolint -`; the arguments replace it.
  return [
    'run',
    '--rm',
    ...(pin.platform === undefined ? [] : ['--platform', pin.platform]),
    '--network',
    'none',
    '-v',
    `${root}:/repo:ro`,
    '-w',
    '/repo',
    pin.image,
    '/bin/hadolint',
    ...hadolintArgs(files, options.configFile),
  ];
}

export function chooseHadolintRoute(
  root: string,
  files: readonly string[],
  deps: ICapturedRunDeps,
  options: Pick<IHadolintOptions, 'pin' | 'configFile'> = {},
): LinterRoute {
  const pin = options.pin ?? HADOLINT;
  return chooseToolRoute(
    pin,
    hadolintArgs(files, options.configFile),
    hadolintDockerArgs(root, files, options),
    deps,
    `install hadolint ${pin.version} (brew or scoop install hadolint)`,
  );
}

export interface IHadolintDeps extends ICapturedRunDeps {
  /** Every file git tracks under `root`, repo-relative with `/`, or null when git cannot list them. */
  readonly tracked: (root: string) => readonly string[] | null;
  /** The text of a repo-relative file under `root`, or null when there is no such file. */
  readonly read: (root: string, file: string) => string | null;
}

function describeFinding(finding: IHadolintFinding): string {
  return `${finding.file}:${String(finding.line)}: ${finding.code} ${finding.level}: ${finding.message}`;
}

/**
 * Read the configuration, refuse pragmas, find the tool, lint the canaries and
 * every tracked Dockerfile, and judge the run: 0 passed, 1 failed, 2 blocked
 * (`exitCodeFor`). No Dockerfile to lint fails, never passes.
 */
export function runHadolint(
  root: string,
  deps: IHadolintDeps,
  options: IHadolintOptions = {},
): IToolResult {
  const configFile = options.configFile ?? HADOLINT_CONFIG;
  const canaries = options.canaries ?? [];
  const tracked = deps.tracked(root);
  if (tracked === null) {
    return { status: 'blocked', reason: `git could not list the files under ${root}`, lines: [] };
  }
  const linted = dockerfiles(tracked, options);
  if (linted.length === 0) {
    // Nothing to lint is a failure, never a pass: the files moved, or the tree is wrong.
    return { status: 'failed', reason: `no tracked Dockerfile under ${root}`, lines: [] };
  }
  const config = deps.read(root, configFile);
  const read = config === null ? null : readHadolintConfig(config, configFile);
  const problems = [
    ...(read === null ? [`no ${configFile} under ${root}`] : read.problems),
    ...linted.flatMap((file) => dockerfileProblems(file, deps.read(root, file) ?? '', configFile)),
  ];
  if (read === null || problems.length > 0) {
    return {
      status: 'failed',
      reason: `${plural(problems.length, 'problem')} before linting: see above`,
      lines: problems,
    };
  }

  const files = [...canaries.map((canary) => canary.file), ...linted];
  const route = chooseHadolintRoute(root, files, deps, options);
  const ran = runCaptured(options.pin ?? HADOLINT, route, root, deps);
  if (ran.kind === 'ended') return ran.result;
  const { run, via } = ran;
  const findings = parseHadolintReport(run.stdout);
  // 0 is a clean run and 1 a run with findings; anything else is hadolint failing.
  if (findings === null || (run.code !== 0 && run.code !== 1)) {
    return unjudgeable('hadolint', run, via);
  }

  const canaryFiles = new Set(canaries.map((canary) => canary.file));
  const misjudged = canaryProblems('hadolint', configFile, canaries, findings, read.ignored);
  const real = findings.filter((finding) => !canaryFiles.has(finding.file));
  const failed = findingsVerdict(via, real.map(describeFinding), real.length, misjudged);
  if (failed !== null) return failed;
  return {
    status: 'passed',
    reason:
      `${plural(linted.length, 'Dockerfile')} clean, ` +
      `${plural(canaries.length, 'canary', 'canaries')} judged as pinned, ${via}`,
    lines: [],
  };
}
