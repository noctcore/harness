import { describe, expect, test } from 'bun:test';

import type { IHadolintDeps, IHadolintFinding, IHadolintOptions } from './hadolint.js';
import {
  chooseHadolintRoute,
  dockerfileProblems,
  dockerfiles,
  HADOLINT_CONFIG,
  hadolintDockerArgs,
  parseHadolintReport,
  readHadolintConfig,
  runHadolint,
} from './hadolint.js';
import { HADOLINT } from './pins.js';
import type { ISpawned, IToolCanary } from './tool-run.js';
import { canaryProblems } from './tool-run.js';

const CONFIG = [
  'failure-threshold: style',
  'disable-ignore-pragma: true',
  'trustedRegistries:',
  '  - docker.io',
  'ignored:',
  '  - DL3008 # pinning apt versions breaks on every base image refresh',
  '  - DL3018 # the same for apk',
  '',
].join('\n');

const CANARIES: readonly IToolCanary[] = [
  { file: 'checks/hadolint/unsafe.Dockerfile', codes: ['DL3002', 'DL4006', 'SC2086'] },
  { file: 'checks/hadolint/pragma.Dockerfile', codes: ['DL3025'] },
  { file: 'checks/hadolint/clean.Dockerfile', codes: [] },
];
const OPTIONS: IHadolintOptions = { canaries: CANARIES, exclude: ['checks/hadolint/'] };
const DOCKERFILES = ['services/api/Dockerfile', 'services/web/Dockerfile'];

function finding(file: string, code: string, line = 1): IHadolintFinding {
  return { file, line, code, level: 'warning', message: `${code} message` };
}

/** The report the pinned hadolint gives when only the canaries report. */
function canaryReport(): IHadolintFinding[] {
  return CANARIES.flatMap((canary) => canary.codes.map((code) => finding(canary.file, code)));
}

function deps(overrides: Partial<IHadolintDeps> = {}, report = canaryReport(), code = 1) {
  const spawned: { command: string; args: readonly string[] }[] = [];
  const pulls: string[] = [];
  const all: IHadolintDeps = {
    tracked: () => [...DOCKERFILES, 'README.md', ...CANARIES.map((canary) => canary.file)],
    read: (_root, file) => (file === HADOLINT_CONFIG ? CONFIG : 'FROM scratch\n'),
    nativeVersion: () => null,
    dockerAvailable: () => true,
    imagePresent: () => true,
    pull: (image) => {
      pulls.push(image);
      return true;
    },
    spawn: (command, args): ISpawned => {
      spawned.push({ command, args });
      return { code, stdout: JSON.stringify(report), stderr: '' };
    },
    ...overrides,
  };
  return { all, spawned, pulls };
}

describe('the hadolint pin', () => {
  test('names one version in the image tag and both release paths', () => {
    expect(HADOLINT.image).toMatch(new RegExp(`:v${HADOLINT.version}@sha256:[0-9a-f]{64}$`, 'u'));
    for (const asset of Object.values(HADOLINT.linux)) {
      expect(asset.path).toContain(`/v${HADOLINT.version}/`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.member).toBeUndefined();
    }
  });
});

describe('dockerfiles', () => {
  test('finds every Dockerfile name form git tracks, excluded paths, canaries and look-alikes left out', () => {
    expect(
      dockerfiles(
        [
          'docker/runner/Dockerfile',
          'services/api/Dockerfile',
          'tools/x/build.Dockerfile',
          'tools/x/Dockerfile.dev',
          'checks/hadolint/unsafe.Dockerfile',
          'elsewhere/canary.Dockerfile',
          'docs/Dockerfiles.md',
          'services/api/Dockerfile.ts.md/x',
        ],
        {
          exclude: ['checks/hadolint/'],
          canaries: [{ file: 'elsewhere/canary.Dockerfile', codes: [] }],
        },
      ),
    ).toEqual([
      'docker/runner/Dockerfile',
      'services/api/Dockerfile',
      'tools/x/Dockerfile.dev',
      'tools/x/build.Dockerfile',
    ]);
  });

  test('lints every Dockerfile when nothing is excluded', () => {
    expect(dockerfiles(['b/Dockerfile', 'a/Dockerfile'])).toEqual(['a/Dockerfile', 'b/Dockerfile']);
  });
});

describe('dockerfileProblems', () => {
  test('refuses every hadolint pragma, in any case and form', () => {
    const text = [
      'FROM scratch',
      '# hadolint ignore=DL3008',
      '#hadolint global ignore=DL3018',
      '  # HADOLINT shell=powershell',
      '# a comment that mentions hadolint later is fine',
    ].join('\n');
    expect(
      dockerfileProblems('services/api/Dockerfile', text).map((problem) =>
        problem.split(':', 2).join(':'),
      ),
    ).toEqual([
      'services/api/Dockerfile:2',
      'services/api/Dockerfile:3',
      'services/api/Dockerfile:4',
    ]);
  });

  test('passes a Dockerfile without one, and names the configuration it was given', () => {
    expect(dockerfileProblems('Dockerfile', 'FROM scratch\nRUN true\n')).toEqual([]);
    expect(dockerfileProblems('Dockerfile', '# hadolint ignore=DL1\n', 'lint/h.yaml')[0]).toContain(
      'lint/h.yaml',
    );
  });
});

describe('readHadolintConfig', () => {
  test('accepts a configuration with every ignored rule given a reason', () => {
    expect(readHadolintConfig(CONFIG)).toEqual({ ignored: ['DL3008', 'DL3018'], problems: [] });
  });

  test('refuses a failure threshold above style, so no finding can pass as a mere note', () => {
    const problems = readHadolintConfig(
      CONFIG.replace('failure-threshold: style', 'failure-threshold: error'),
    ).problems;
    expect(problems.join('\n')).toMatch(/failure-threshold must be style/u);
  });

  test('refuses an ignored rule without a reason, a code that is not one, and a key it does not know', () => {
    const problems = readHadolintConfig(
      `${CONFIG}override:\n  info:\n    - DL3059\n`
        .replace(/(- DL3018) #.*/u, '$1')
        .replace('DL3008', 'XX1'),
    ).problems.join('\n');
    expect(problems).toMatch(/DL3018 is ignored without a reason/u);
    expect(problems).toMatch(/XX1 is not a rule code/u);
    expect(problems).toMatch(/override is not a key this check knows/u);
    expect(problems).toMatch(/a list item outside ignored or trustedRegistries/u);
    expect(problems).toMatch(/info has no value|not a line this check can read/u);
  });

  test('refuses a configuration that leaves pragmas on, or names no trusted registry', () => {
    const missing = readHadolintConfig(
      'failure-threshold: style\nignored:\n  - DL3008 # why\n',
    ).problems.join('\n');
    expect(missing).toMatch(/no disable-ignore-pragma/u);
    expect(missing).toMatch(/no trustedRegistries/u);
    const on = readHadolintConfig(CONFIG.replace('pragma: true', 'pragma: false')).problems;
    expect(on.join('\n')).toMatch(/disable-ignore-pragma must be true/u);
  });

  test('refuses a line it cannot read, and names the configuration file it was given', () => {
    const problems = readHadolintConfig(`${CONFIG}??\n`, 'lint/h.yaml').problems;
    expect(problems).toEqual([`lint/h.yaml:8: not a line this check can read (??)`]);
  });
});

describe('readHadolintConfig and inline values', () => {
  const base =
    'failure-threshold: style\ndisable-ignore-pragma: true\ntrustedRegistries:\n  - docker.io\n';

  test('refuses an ignore list written inline, which hadolint applies in full', () => {
    const flow = readHadolintConfig(`${base}ignored: [DL3002, DL3025]\n`).problems.join('\n');
    expect(flow).toMatch(/ignored must be a block list, one item per line/u);
    const scalar = readHadolintConfig(`${base}ignored: DL3020\n`).problems.join('\n');
    expect(scalar).toMatch(/ignored must be a block list, one item per line/u);
  });

  test('refuses a trusted registry list that is inline or empty, which turns DL3026 off', () => {
    const inline = readHadolintConfig(
      'failure-threshold: style\ndisable-ignore-pragma: true\ntrustedRegistries: []\n',
    ).problems.join('\n');
    expect(inline).toMatch(/trustedRegistries must be a block list, one item per line/u);
    const empty = readHadolintConfig(
      'failure-threshold: style\ndisable-ignore-pragma: true\ntrustedRegistries:\n',
    ).problems.join('\n');
    expect(empty).toMatch(/trustedRegistries names no registry/u);
  });

  test('refuses a key written twice, where YAML keeps the last', () => {
    const problems = readHadolintConfig(`${base}failure-threshold: error\n`).problems.join('\n');
    expect(problems).toMatch(/failure-threshold is written twice/u);
  });
});

describe('parseHadolintReport', () => {
  test('reads the JSON report, an empty one included', () => {
    expect(parseHadolintReport('')).toEqual([]);
    expect(
      parseHadolintReport(
        '[{"code":"DL3002","column":1,"file":"services/web/Dockerfile","level":"warning","line":31,"message":"Last USER should not be root"}]',
      ),
    ).toEqual([
      {
        file: 'services/web/Dockerfile',
        line: 31,
        code: 'DL3002',
        level: 'warning',
        message: 'Last USER should not be root',
      },
    ]);
  });

  test('refuses output that is not the report', () => {
    expect(parseHadolintReport('services/web/Dockerfile:31 DL3002 warning: x')).toBeNull();
    expect(parseHadolintReport('[{"code":"DL3002"}]')).toBeNull();
    expect(parseHadolintReport('{"code":"DL3002"}')).toBeNull();
  });
});

describe('chooseHadolintRoute', () => {
  const probes = (version: string | null, docker: boolean) => ({
    ...deps().all,
    nativeVersion: () => version,
    dockerAvailable: () => docker,
  });

  test('takes a native hadolint only at exactly the pinned version', () => {
    expect(chooseHadolintRoute('/repo', ['Dockerfile'], probes(HADOLINT.version, false))).toEqual({
      kind: 'native',
      command: 'hadolint',
      args: ['--config', HADOLINT_CONFIG, '--format', 'json', '--no-color', 'Dockerfile'],
    });
    expect(chooseHadolintRoute('/repo', ['Dockerfile'], probes('2.14.0', true)).kind).toBe(
      'docker',
    );
  });

  test('is blocked with neither, and says how to get either', () => {
    const route = chooseHadolintRoute('/repo', ['Dockerfile'], probes('2.14.0', false));
    expect(route.kind).toBe('blocked');
    expect(route.kind === 'blocked' ? route.reason : '').toMatch(
      /native hadolint 2\.14\.0 is not the pinned 2\.15\.1.*Start Docker, or install hadolint 2\.15\.1/u,
    );
  });

  test('runs the image with the repo read-only, no network, and the same arguments', () => {
    const args = hadolintDockerArgs('/repo', ['services/api/Dockerfile'], {
      configFile: 'lint/h.yaml',
    });
    expect(args).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      '/repo:/repo:ro',
      '-w',
      '/repo',
      HADOLINT.image,
      '/bin/hadolint',
      '--config',
      'lint/h.yaml',
      '--format',
      'json',
      '--no-color',
      'services/api/Dockerfile',
    ]);
  });

  test('names the platform of a pin published for one only', () => {
    const args = hadolintDockerArgs('/repo', ['Dockerfile'], {
      pin: { ...HADOLINT, platform: 'linux/amd64' },
    });
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--platform', 'linux/amd64']);
  });
});

describe('the canaries', () => {
  const judge = (report: readonly IHadolintFinding[], ignored: readonly string[] = []) =>
    canaryProblems('hadolint', HADOLINT_CONFIG, CANARIES, report, ignored);

  test('pass when reported exactly as pinned, whatever the order or the count per code', () => {
    expect(judge([...canaryReport()].reverse())).toEqual([]);
    expect(judge([...canaryReport(), finding(CANARIES[0]?.file ?? '', 'SC2086', 9)])).toEqual([]);
  });

  test('fail a canary that lost a code (a rule turned off, or ShellCheck gone)', () => {
    const report = canaryReport().filter((each) => each.code !== 'SC2086');
    expect(judge(report).join('\n')).toMatch(
      /unsafe\.Dockerfile: hadolint reported .*the canary expects/u,
    );
  });

  test('fail a pragma that took effect, and a clean canary that is reported', () => {
    const report = [
      ...canaryReport().filter((each) => !each.file.endsWith('pragma.Dockerfile')),
      finding('checks/hadolint/clean.Dockerfile', 'DL3007'),
    ];
    const problems = judge(report).join('\n');
    expect(problems).toMatch(/pragma\.Dockerfile: hadolint reported \[\]/u);
    expect(problems).toMatch(/clean\.Dockerfile: hadolint reported \[DL3007\]/u);
  });

  test('fail a canary that expects a rule the configuration ignores', () => {
    expect(judge(canaryReport(), ['DL3025']).join('\n')).toMatch(
      /expects DL3025, which \.hadolint\.yaml ignores/u,
    );
  });
});

describe('runHadolint', () => {
  test('passes when only the canaries report, as pinned', () => {
    const { all, spawned } = deps();
    const result = runHadolint('/repo', all, OPTIONS);
    expect(result.status).toBe('passed');
    expect(result.reason).toBe('2 Dockerfiles clean, 3 canaries judged as pinned, pinned image');
    expect(spawned[0]?.command).toBe('docker');
    expect(spawned[0]?.args).toContain('services/web/Dockerfile');
    expect(spawned[0]?.args).toContain('checks/hadolint/clean.Dockerfile');
  });

  test('runs a native hadolint, and the container CLI the deps name', () => {
    const native = deps({ nativeVersion: () => HADOLINT.version });
    expect(runHadolint('/repo', native.all, OPTIONS).reason).toMatch(/, native$/u);
    expect(native.spawned[0]?.command).toBe('hadolint');
    const podman = deps({ dockerCommand: 'podman' });
    runHadolint('/repo', podman.all, OPTIONS);
    expect(podman.spawned[0]?.command).toBe('podman');
  });

  test('fails a finding in a tracked Dockerfile, whatever its level', () => {
    const report = [
      ...canaryReport(),
      { ...finding('services/web/Dockerfile', 'DL3059', 40), level: 'info' },
    ];
    const result = runHadolint('/repo', deps({}, report).all, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('1 finding, pinned image: see above');
    expect(result.lines).toEqual(['services/web/Dockerfile:40: DL3059 info: DL3059 message']);
  });

  test('fails a misjudged canary even with no finding', () => {
    const result = runHadolint('/repo', deps({}, []).all, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('2 canary problems, pinned image: see above');
  });

  test('refuses a pragma before hadolint runs', () => {
    const { all, spawned } = deps({
      read: (_root, file) =>
        file === HADOLINT_CONFIG ? CONFIG : '# hadolint ignore=DL3008\nFROM scratch\n',
    });
    const result = runHadolint('/repo', all, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/before linting/u);
    expect(spawned).toHaveLength(0);
  });

  test('fails a tree with no configuration, and runs nothing', () => {
    const { all, spawned } = deps({ read: () => null });
    const result = runHadolint('/repo', all, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.lines).toEqual([`no ${HADOLINT_CONFIG} under /repo`]);
    expect(spawned).toHaveLength(0);
  });

  test('fails with nothing to lint, and is blocked when git cannot list the tree', () => {
    expect(runHadolint('/repo', deps({ tracked: () => ['README.md'] }).all, OPTIONS).status).toBe(
      'failed',
    );
    expect(runHadolint('/repo', deps({ tracked: () => null }).all, OPTIONS).status).toBe('blocked');
  });

  test('is blocked when there is no route, and runs nothing', () => {
    const { all, spawned } = deps({ dockerAvailable: () => false });
    expect(runHadolint('/repo', all, OPTIONS).status).toBe('blocked');
    expect(spawned).toHaveLength(0);
  });

  test('is blocked when Docker itself failed, the image could not be pulled, or nothing started', () => {
    const exit125 = runHadolint(
      '/repo',
      deps({ spawn: () => ({ code: 125, stdout: '', stderr: 'daemon gone' }) }).all,
      OPTIONS,
    );
    expect(exit125).toEqual({
      status: 'blocked',
      reason: 'docker could not run the pinned image (exit 125)',
      lines: ['daemon gone'],
    });
    const noPull = deps({ imagePresent: () => false, pull: () => false });
    expect(runHadolint('/repo', noPull.all, OPTIONS).status).toBe('blocked');
    const pulled = deps({ imagePresent: () => false });
    expect(runHadolint('/repo', pulled.all, OPTIONS).status).toBe('passed');
    expect(pulled.pulls).toEqual([HADOLINT.image]);
    const noStart = deps({ spawn: () => ({ code: null, stdout: '', stderr: '' }) }).all;
    expect(runHadolint('/repo', noStart, OPTIONS).reason).toBe('docker could not be started');
  });

  test('fails a run that exited with something other than 0 or 1, or printed no report', () => {
    expect(runHadolint('/repo', deps({}, canaryReport(), 2).all, OPTIONS).status).toBe('failed');
    const garbled = deps({ spawn: () => ({ code: 1, stdout: 'not json', stderr: 'oops' }) }).all;
    const result = runHadolint('/repo', garbled, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.lines).toEqual(['not json', 'oops']);
  });

  test('passes a tree with no canaries configured, and says so', () => {
    const { all } = deps({}, []);
    expect(runHadolint('/repo', all).reason).toBe(
      '5 Dockerfiles clean, 0 canaries judged as pinned, pinned image',
    );
  });
});
