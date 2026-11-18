/*
 * What hadolint and squawk share: one pinned tool that reads files and prints
 * a JSON report. The route is found the way `chooseRoute` finds a linter's
 * (native at exactly the pinned version, else the image by digest, else
 * BLOCKED), the run is captured so its report can be parsed, and the canaries
 * (fixtures with the exact codes the tool must report for them) are judged on
 * every run, so a pin or a configuration that stopped judging fails on the day
 * it happens.
 */
import type { IImagePin } from './pins.js';
import type { IRouteDeps, LinterRoute, LinterStatus } from './route.js';
import { DOCKER_COMMAND } from './route.js';

/** What a run of a tool left behind. `code` is null when it could not be started. */
export interface ISpawned {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The deps of a captured run: the route probes, the image, and a spawn that keeps the output. */
export interface ICapturedRunDeps extends IRouteDeps {
  /** Whether the image is already local, so nothing needs pulling. */
  readonly imagePresent: (image: string) => boolean;
  /** Pull the image, for `platform` when one is named; false when it could not be pulled. */
  readonly pull: (image: string, platform?: string) => boolean;
  /** Run from `cwd` and capture the output. */
  readonly spawn: (command: string, args: readonly string[], cwd: string) => ISpawned;
}

/** A check's verdict and what to print above it: the findings, or what stopped the run. */
export interface IToolResult {
  readonly status: LinterStatus;
  readonly reason: string;
  readonly lines: readonly string[];
}

/** A fixture the tool must report with exactly `codes`, no more and no fewer. Empty: it must be clean. */
export interface IToolCanary {
  /** Repo-relative, with `/` separators. */
  readonly file: string;
  readonly codes: readonly string[];
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Native at exactly the pin's version, else the pin's image when a Docker
 * daemon answers, else blocked with `installHint` as the way out.
 */
export function chooseToolRoute(
  pin: IImagePin,
  nativeArgs: readonly string[],
  dockerArgs: readonly string[],
  deps: IRouteDeps,
  installHint: string,
): LinterRoute {
  const found = deps.nativeVersion(pin);
  if (found === pin.version) return { kind: 'native', command: pin.name, args: nativeArgs };
  if (deps.dockerAvailable()) return { kind: 'docker', image: pin.image, args: dockerArgs };
  const native =
    found === null
      ? `no native ${pin.name}`
      : `native ${pin.name} ${found} is not the pinned ${pin.version}`;
  return {
    kind: 'blocked',
    reason: `${native}, and no Docker daemon answered for the pinned image. Start Docker, or ${installHint}.`,
  };
}

/** A run that produced output to judge, or the verdict that ended it first. */
export type CapturedRun =
  | { readonly kind: 'ran'; readonly run: ISpawned; readonly via: string }
  | { readonly kind: 'ended'; readonly result: IToolResult };

/**
 * Pull the image when the route needs one that is not local, spawn the
 * route, and stop at what proves the tool never ran: no route, no image, a
 * command that could not start, and docker's own exit 125. All of those are
 * blocked, never passed.
 */
export function runCaptured(
  pin: IImagePin,
  route: LinterRoute,
  root: string,
  deps: ICapturedRunDeps,
): CapturedRun {
  if (route.kind === 'blocked') {
    return { kind: 'ended', result: { status: 'blocked', reason: route.reason, lines: [] } };
  }
  // The platform is named on the pull as on the run: left to the host, an arm64
  // machine asks the registry for an arm64 image, which may not be published.
  if (
    route.kind === 'docker' &&
    !deps.imagePresent(route.image) &&
    !deps.pull(route.image, pin.platform)
  ) {
    return {
      kind: 'ended',
      result: {
        status: 'blocked',
        reason: `could not pull the pinned image ${route.image} (see docker's message above)`,
        lines: [],
      },
    };
  }
  const command = route.kind === 'native' ? route.command : (deps.dockerCommand ?? DOCKER_COMMAND);
  const run = deps.spawn(command, route.args, root);
  if (run.code === null) {
    return {
      kind: 'ended',
      result: { status: 'blocked', reason: `${command} could not be started`, lines: [] },
    };
  }
  if (route.kind === 'docker' && run.code === 125) {
    return {
      kind: 'ended',
      result: {
        status: 'blocked',
        reason: 'docker could not run the pinned image (exit 125)',
        lines: run.stderr.trim() === '' ? [] : [run.stderr.trim()],
      },
    };
  }
  return { kind: 'ran', run, via: route.kind === 'native' ? 'native' : 'pinned image' };
}

/**
 * Each canary the tool did not report exactly as pinned, as one line, and
 * each canary that expects a code the configuration ignores (the two
 * disagree, so one of them is wrong). `reported` is every `{ file, code }`
 * the tool printed; how often a code appears does not matter.
 */
export function canaryProblems(
  tool: string,
  configFile: string,
  canaries: readonly IToolCanary[],
  reported: readonly { readonly file: string; readonly code: string }[],
  ignored: readonly string[] = [],
): readonly string[] {
  const problems: string[] = [];
  for (const canary of canaries) {
    const codes = [
      ...new Set(reported.filter((each) => each.file === canary.file).map((each) => each.code)),
    ].sort();
    const expected = [...canary.codes].sort();
    if (codes.join(',') !== expected.join(',')) {
      problems.push(
        `${canary.file}: ${tool} reported [${codes.join(', ')}], the canary expects ` +
          `[${expected.join(', ')}]. The pinned tool or ${configFile} no longer judges what ` +
          'this check relies on.',
      );
    }
    for (const code of canary.codes.filter((each) => ignored.includes(each))) {
      problems.push(`${canary.file}: the canary expects ${code}, which ${configFile} ignores`);
    }
  }
  return problems;
}

/** The failed verdict for real findings and misjudged canaries, or null when there are neither. */
export function findingsVerdict(
  via: string,
  findings: readonly string[],
  findingCount: number,
  canaries: readonly string[],
): IToolResult | null {
  if (findingCount === 0 && canaries.length === 0) return null;
  const what = [
    ...(findingCount > 0 ? [plural(findingCount, 'finding')] : []),
    ...(canaries.length > 0 ? [plural(canaries.length, 'canary problem')] : []),
  ].join(', ');
  return {
    status: 'failed',
    reason: `${what}, ${via}: see above`,
    lines: [...canaries, ...findings],
  };
}

/** The failed verdict for a run whose exit code is not 0 or 1, or that printed no report. */
export function unjudgeable(tool: string, run: ISpawned, via: string): IToolResult {
  return {
    status: 'failed',
    reason: `${tool} exited ${String(run.code)} without a report it can be judged by, ${via}`,
    lines: [run.stdout.trim(), run.stderr.trim()].filter((text) => text !== ''),
  };
}
