import { describe, expect, test } from 'bun:test';

import { TRIVY } from './pins.js';
import type { ISpawned } from './tool-run.js';
import type {
  ITrivyIgnoreEntry,
  ITrivyScanDeps,
  ITrivyScanOptions,
  TrivyFinding,
} from './trivy.js';
import {
  chooseTrivyRoute,
  classifyTrivyFailure,
  describeTrivyFinding,
  failingFindings,
  osCoverageProblem,
  parseTrivyReport,
  readTrivyIgnoreFile,
  renderTrivyIgnoreFile,
  sbomCanaryProblem,
  scanImages,
  secretCanaryProblem,
  secretCanaryToken,
  TRIVY_CONTAINER_PATHS,
  TRIVY_IGNORE_FILE,
  TRIVY_MAX_IGNORE_DAYS,
  TRIVY_SEVERITY_FLOOR,
  trivyDockerArgs,
  trivyScanArgs,
  trivyScanEnv,
} from './trivy.js';

/** The day the entries below were written: they are judged against it. */
const WRITTEN = '2026-10-15';
const SBOM = 'checks/trivy/vulnerable.cdx.json';
const SBOM_CANARY = { file: SBOM, advisory: 'CVE-2019-10744' };

const ENTRY: ITrivyIgnoreEntry = {
  section: 'vulnerabilities',
  id: 'CVE-2026-50015',
  paths: ['opt/corepack/v1/pnpm/10.33.2/**'],
  statement: 'pnpm 10.33.2 in the worker image; fixed by a packageManager bump',
  expiredAt: '2026-10-29',
};

/** A trivy report in the shape 0.75.0 prints, cut down to what the check reads. */
function report(results: readonly unknown[], os?: object): string {
  return JSON.stringify({
    SchemaVersion: 2,
    ArtifactName: '/work/web.tar',
    ...(os === undefined ? {} : { Metadata: { OS: os } }),
    Results: results,
  });
}

const VULNERABLE = report([
  {
    Target: '/work/api.tar (debian 12.15)',
    Class: 'os-pkgs',
    Vulnerabilities: [
      {
        VulnerabilityID: 'CVE-2026-13221',
        PkgName: 'perl-base',
        InstalledVersion: '5.36.0-7+deb12u3',
        FixedVersion: '5.36.0-7+deb12u4',
        Severity: 'CRITICAL',
      },
      {
        VulnerabilityID: 'CVE-2026-0001',
        PkgName: 'libfoo',
        InstalledVersion: '1.0',
        FixedVersion: '1.1',
        Severity: 'MEDIUM',
      },
    ],
  },
  {
    Target: 'Node.js',
    Class: 'lang-pkgs',
    Vulnerabilities: [
      {
        VulnerabilityID: 'CVE-2026-59873',
        PkgName: 'tar',
        PkgPath: 'usr/local/lib/node_modules/npm/node_modules/tar/package.json',
        InstalledVersion: '7.5.11',
        FixedVersion: '7.5.19',
        Severity: 'HIGH',
      },
    ],
  },
  {
    Target: '/etc/ssl/private/ssl-cert-snakeoil.key',
    Class: 'secret',
    Secrets: [
      { RuleID: 'private-key', Severity: 'HIGH', Title: 'Asymmetric Private Key', StartLine: 2 },
    ],
  },
]);

const ids = (findings: readonly TrivyFinding[]) =>
  findings.map((finding) => (finding.kind === 'secret' ? finding.rule : finding.id));

describe('the trivy pin', () => {
  test('names one version in the image tag and both release archives', () => {
    expect(TRIVY.image).toMatch(new RegExp(`:${TRIVY.version}@sha256:[0-9a-f]{64}$`, 'u'));
    for (const asset of Object.values(TRIVY.linux)) {
      expect(asset.path).toContain(`/v${TRIVY.version}/trivy_${TRIVY.version}_`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.member).toBe('trivy');
    }
  });
});

describe('readTrivyIgnoreFile', () => {
  test('accepts an empty file: every finding fixed, nothing waived', () => {
    expect(readTrivyIgnoreFile('# nothing ignored\n', WRITTEN)).toEqual({
      entries: [],
      problems: [],
    });
  });

  test('reads back what it renders, a quote inside a statement and a secret included', () => {
    const entries: ITrivyIgnoreEntry[] = [
      { ...ENTRY, statement: "the owner's call" },
      { ...ENTRY, section: 'secrets', id: 'private-key', paths: [] },
    ];
    expect(readTrivyIgnoreFile(renderTrivyIgnoreFile(entries), WRITTEN)).toEqual({
      entries,
      problems: [],
    });
  });

  test('refuses an entry without an expiry, one without a statement, and one without an id', () => {
    const noExpiry = renderTrivyIgnoreFile([ENTRY]).replace(/\n {4}expired_at: .*/u, '');
    expect(readTrivyIgnoreFile(noExpiry, WRITTEN).problems.join('\n')).toMatch(
      /CVE-2026-50015 has no expired_at date/u,
    );
    const noStatement = renderTrivyIgnoreFile([{ ...ENTRY, statement: '' }]);
    expect(readTrivyIgnoreFile(noStatement, WRITTEN).problems.join('\n')).toMatch(
      /CVE-2026-50015 has no statement/u,
    );
    const noId = renderTrivyIgnoreFile([ENTRY]).replace('id: CVE-2026-50015', 'id: "x"');
    expect(readTrivyIgnoreFile(noId, WRITTEN).problems.join('\n')).toMatch(/an entry has no id/u);
  });

  test('refuses an entry that has expired, or that expires more than the limit out', () => {
    expect(TRIVY_MAX_IGNORE_DAYS).toBe(14);
    expect(
      readTrivyIgnoreFile(renderTrivyIgnoreFile([ENTRY]), '2026-10-30').problems.join('\n'),
    ).toMatch(/expired on 2026-10-29/u);
    const far = renderTrivyIgnoreFile([{ ...ENTRY, expiredAt: '2026-10-30' }]);
    expect(readTrivyIgnoreFile(far, WRITTEN).problems.join('\n')).toMatch(/more than 14 days out/u);
    const edge = renderTrivyIgnoreFile([{ ...ENTRY, expiredAt: '2026-10-29' }]);
    expect(readTrivyIgnoreFile(edge, WRITTEN).problems).toEqual([]);
    expect(
      readTrivyIgnoreFile(edge, WRITTEN, { maxIgnoreDays: 7, ignoreFile: 'sec/ignore.yaml' })
        .problems,
    ).toEqual(['sec/ignore.yaml: CVE-2026-50015 expires 2026-10-29, more than 7 days out']);
  });

  test('refuses what trivy would read and this check would not: another section, field or form', () => {
    const text = renderTrivyIgnoreFile([ENTRY]);
    const problems = (input: string) => readTrivyIgnoreFile(input, WRITTEN).problems.join('\n');
    expect(problems(`${text}\nmisconfigurations:\n  - id: DS002\n`)).toMatch(
      /misconfigurations is not a section[\s\S]*an entry outside a known section/u,
    );
    expect(problems(text.replace('    statement:', '    purls:\n    statement:'))).toMatch(
      /purls is not a field/u,
    );
    expect(problems(text.replace(/'opt\/corepack[^']*'/u, '"opt/corepack/**"'))).toMatch(
      /a path this check cannot read/u,
    );
    expect(problems(text.replace('  - id:', '  - &a id:'))).toMatch(
      /not a line this check can read|not in the form/u,
    );
    expect(problems(text.replace(/statement: '(.*)'/u, 'statement: $1'))).toMatch(
      /has no statement|not in the form/u,
    );
    expect(problems(text.replace("statement: '", "statement:   '"))).toMatch(/not in the form/u);
  });
});

describe('parseTrivyReport and failingFindings', () => {
  test('reads vulnerabilities and secrets from every result', () => {
    expect(ids(parseTrivyReport(VULNERABLE) ?? [])).toEqual([
      'CVE-2026-13221',
      'CVE-2026-0001',
      'CVE-2026-59873',
      'private-key',
    ]);
  });

  test('fails every secret and every advisory at or above the floor, and nothing below', () => {
    expect(TRIVY_SEVERITY_FLOOR).toEqual(['HIGH', 'CRITICAL']);
    const findings = parseTrivyReport(VULNERABLE) ?? [];
    expect(ids(failingFindings(findings))).toEqual([
      'CVE-2026-13221',
      'CVE-2026-59873',
      'private-key',
    ]);
    expect(ids(failingFindings(findings, ['CRITICAL']))).toEqual(['CVE-2026-13221', 'private-key']);
  });

  test('passes a clean report, results without findings included', () => {
    expect(parseTrivyReport(report([{ Target: 'x', Class: 'os-pkgs' }]))).toEqual([]);
    expect(parseTrivyReport(report([]))).toEqual([]);
    expect(parseTrivyReport('{"SchemaVersion":2}')).toEqual([]);
  });

  test('refuses output that is not a report', () => {
    expect(parseTrivyReport('FATAL error')).toBeNull();
    expect(parseTrivyReport('{"Results":[]}')).toBeNull();
    expect(parseTrivyReport('{"SchemaVersion":2,"Results":{}}')).toBeNull();
    expect(parseTrivyReport(report([1]))).toBeNull();
    expect(parseTrivyReport(report([{ Vulnerabilities: {} }]))).toBeNull();
    expect(parseTrivyReport(report([{ Vulnerabilities: [{ PkgName: 'x' }] }]))).toBeNull();
    expect(parseTrivyReport(report([{ Secrets: [{ Title: 'x' }] }]))).toBeNull();
  });

  test('names the advisory, the package, the fix and where it is', () => {
    const [os, , lang, secret] = parseTrivyReport(VULNERABLE) ?? [];
    expect(describeTrivyFinding('api', os as TrivyFinding)).toBe(
      'api: CVE-2026-13221 CRITICAL perl-base 5.36.0-7+deb12u3, fixed in 5.36.0-7+deb12u4, /work/api.tar (debian 12.15)',
    );
    expect(describeTrivyFinding('api', lang as TrivyFinding)).toMatch(
      /npm\/node_modules\/tar\/package\.json$/u,
    );
    expect(describeTrivyFinding('worker', secret as TrivyFinding)).toBe(
      'worker: secret private-key (HIGH) Asymmetric Private Key in /etc/ssl/private/ssl-cert-snakeoil.key:2',
    );
  });
});

describe('osCoverageProblem', () => {
  const osPkgs = { Target: '/work/api.tar (debian 12.15)', Class: 'os-pkgs', Type: 'debian' };

  test('passes a scan that found the OS and judged its packages, with or without findings', () => {
    expect(osCoverageProblem('api', report([osPkgs], { Family: 'debian', Name: '12.15' }))).toBe(
      null,
    );
  });

  test('fails a scan that could not tell the OS: zero OS findings would prove nothing', () => {
    expect(osCoverageProblem('api', report([{ Target: 'Node.js', Class: 'lang-pkgs' }]))).toMatch(
      /api: trivy could not tell the image's OS/u,
    );
  });

  test('fails a scan that found an OS it judged no packages of (an unsupported one)', () => {
    expect(osCoverageProblem('web', report([], { Family: 'alpine', Name: '9.99' }))).toMatch(
      /web: trivy found alpine 9\.99 but judged none of its packages/u,
    );
  });

  test('fails output that is not a report', () => {
    expect(osCoverageProblem('api', 'not json')).toMatch(/api: trivy printed no report/u);
  });
});

describe('the canaries', () => {
  const sbomHit: TrivyFinding = {
    kind: 'vulnerability',
    target: SBOM,
    id: 'CVE-2019-10744',
    severity: 'CRITICAL',
    pkg: 'lodash',
    installed: '4.17.4',
    fixed: '4.17.12',
    path: '',
  };
  const secret: TrivyFinding = {
    kind: 'secret',
    target: '/work/secret-canary/env',
    rule: 'github-pat',
    severity: 'CRITICAL',
    title: 'GitHub Personal Access Token',
    line: 1,
  };

  test('pass an SBOM scan that reported the planted advisory at its severity', () => {
    expect(sbomCanaryProblem([sbomHit], SBOM_CANARY)).toBeNull();
    expect(
      sbomCanaryProblem([{ ...sbomHit, severity: 'HIGH' }], { ...SBOM_CANARY, severity: 'HIGH' }),
    ).toBeNull();
  });

  test('fail an SBOM scan that found nothing, or rated the advisory lower', () => {
    expect(sbomCanaryProblem([], SBOM_CANARY)).toMatch(
      /did not report CVE-2019-10744 at CRITICAL/u,
    );
    expect(sbomCanaryProblem([{ ...sbomHit, severity: 'HIGH' }], SBOM_CANARY)).toMatch(
      /no longer judge/u,
    );
  });

  test('pass a secret scan that reported the made-up token, and fail one that did not', () => {
    expect(secretCanaryProblem([secret])).toBeNull();
    expect(secretCanaryProblem([sbomHit])).toMatch(/did not report a github-pat secret/u);
    expect(secretCanaryProblem([secret], 'other-rule')).toMatch(/other-rule/u);
  });

  test('make up a token in the shape the github-pat rule matches, and refuse too few bytes', () => {
    const token = secretCanaryToken(new Uint8Array(27).fill(251));
    expect(token).toMatch(/^ghp_[A-Za-z0-9]{36}$/u);
    expect(() => secretCanaryToken(new Uint8Array(10))).toThrow(/at least 27 bytes/u);
  });
});

describe('trivyScanArgs and the routes', () => {
  test('asks for the floor, fixed advisories only, the ignore file, and nothing sent home', () => {
    const args = trivyScanArgs({ kind: 'image', tarball: 'api.tar' }, TRIVY_CONTAINER_PATHS, false);
    expect(args.slice(0, 5)).toEqual([
      'image',
      '--input',
      '/work/api.tar',
      '--scanners',
      'vuln,secret',
    ]);
    for (const flag of [
      '--ignore-unfixed',
      '--skip-db-update',
      '--disable-telemetry',
      '--skip-version-check',
      '--offline-scan',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf('--severity') + 1]).toBe('HIGH,CRITICAL');
    expect(args[args.indexOf('--ignorefile') + 1]).toBe(`/repo/${TRIVY_IGNORE_FILE}`);
    expect(args[args.indexOf('--exit-code') + 1]).toBe('0');
    const custom = trivyScanArgs(
      { kind: 'image', tarball: 'a.tar' },
      TRIVY_CONTAINER_PATHS,
      false,
      {
        severityFloor: ['CRITICAL'],
        ignoreFile: 'sec/ignore.yaml',
      },
    );
    expect(custom[custom.indexOf('--severity') + 1]).toBe('CRITICAL');
    expect(custom[custom.indexOf('--ignorefile') + 1]).toBe('/repo/sec/ignore.yaml');
  });

  test('reads no configuration from the repo or the environment, only the empty files the run writes', () => {
    const args = trivyScanArgs({ kind: 'image', tarball: 'api.tar' }, TRIVY_CONTAINER_PATHS, false);
    expect(args[args.indexOf('--config') + 1]).toBe('/work/trivy.yaml');
    expect(args[args.indexOf('--secret-config') + 1]).toBe('/work/trivy-secret.yaml');
    const fs = trivyScanArgs(
      { kind: 'secret-canary', dir: 'canary' },
      TRIVY_CONTAINER_PATHS,
      false,
    );
    expect(fs.slice(0, 4)).toEqual(['fs', '--scanners', 'secret', '/work/canary']);
    // `trivy sbom` scans no secrets and refuses the flag (unknown flag: --secret-config).
    const sbom = trivyScanArgs({ kind: 'sbom', file: SBOM }, TRIVY_CONTAINER_PATHS, false);
    expect(sbom[sbom.indexOf('--config') + 1]).toBe('/work/trivy.yaml');
    expect(sbom).not.toContain('--secret-config');
    expect(
      trivyScanEnv({
        PATH: '/usr/bin',
        HOME: '/home/me',
        TRIVY_SKIP_DIRS: '/usr',
        trivy_pkg_types: 'library',
        TRIVY_VEX: 'oci',
        NO_PROXY: undefined,
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });

  test('downloads the database on the first scan of a run only', () => {
    const first = trivyScanArgs({ kind: 'sbom', file: SBOM }, TRIVY_CONTAINER_PATHS, true);
    expect(first).not.toContain('--skip-db-update');
    expect(first.slice(0, 4)).toEqual(['sbom', '--scanners', 'vuln', `/repo/${SBOM}`]);
  });

  test('hands the image over as a file and never mounts the Docker socket', () => {
    const args = trivyDockerArgs({ root: '/r', work: '/w' }, ['image'], ['--user', '501:20']);
    expect(args.slice(0, 8)).toEqual([
      'run',
      '--rm',
      '--user',
      '501:20',
      '-v',
      '/r:/repo:ro',
      '-v',
      '/w:/work',
    ]);
    expect(args.slice(-2)).toEqual([TRIVY.image, 'image']);
    expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
    const amd = trivyDockerArgs({ root: '/r', work: '/w' }, [], [], {
      ...TRIVY,
      platform: 'linux/amd64',
    });
    expect(amd.slice(0, 4)).toEqual(['run', '--rm', '--platform', 'linux/amd64']);
  });

  test('takes a native trivy only at exactly the pinned version, else the image, else blocked', () => {
    expect(
      chooseTrivyRoute({ nativeVersion: () => '0.75.0', dockerAvailable: () => false }).kind,
    ).toBe('native');
    expect(
      chooseTrivyRoute({ nativeVersion: () => '0.76.0', dockerAvailable: () => true }).kind,
    ).toBe('docker');
    const blocked = chooseTrivyRoute({
      nativeVersion: () => '0.76.0',
      dockerAvailable: () => false,
    });
    expect(blocked.kind === 'blocked' ? blocked.reason : '').toMatch(
      /native trivy 0\.76\.0 is not the pinned 0\.75\.0.*install trivy 0\.75\.0/u,
    );
  });
});

describe('classifyTrivyFailure', () => {
  test('blocks a run that could not fetch the database or reach a registry', () => {
    for (const stderr of [
      'FATAL init error: DB error: failed to download vulnerability DB: OCI repository error',
      'dial tcp: lookup mirror.gcr.io: no such host',
      'GET https://ghcr.io/v2/: TOOMANYREQUESTS: retry later',
    ]) {
      expect(classifyTrivyFailure(stderr)).toBe('blocked');
    }
  });

  test('fails a tarball trivy cannot open: an image fault, not a download', () => {
    expect(
      classifyTrivyFailure(
        'FATAL Fatal error\trun error: image scan error: unable to initialize a scanner: unable to open /work/api.tar as a Docker image: archive/tar: invalid tar header',
      ),
    ).toBe('failed');
  });

  test('fails anything else trivy failed on', () => {
    expect(
      classifyTrivyFailure('FATAL run error: image scan error: unable to analyze config'),
    ).toBe('failed');
    expect(classifyTrivyFailure('failed to open sbom file: no such file or directory')).toBe(
      'failed',
    );
  });
});

describe('scanImages', () => {
  const OS = { Family: 'debian', Name: '12.15' };
  const CLEAN_IMAGE = report([{ Target: 'x (debian 12.15)', Class: 'os-pkgs' }], OS);
  const SBOM_REPORT = report([
    {
      Target: SBOM,
      Vulnerabilities: [{ VulnerabilityID: 'CVE-2019-10744', Severity: 'CRITICAL' }],
    },
  ]);
  const SECRET_REPORT = report([
    { Target: 'env', Secrets: [{ RuleID: 'github-pat', Severity: 'CRITICAL' }] },
  ]);

  interface IScanFake extends ITrivyScanDeps {
    readonly calls: string[];
    readonly files: Map<string, string>;
  }

  /** Answers by what the arguments ask: the canaries, an image, or a docker command. */
  function fake(
    overrides: Partial<ITrivyScanDeps> = {},
    answer: (command: string, args: readonly string[]) => ISpawned | undefined = () => undefined,
  ): IScanFake {
    const calls: string[] = [];
    const files = new Map<string, string>();
    return {
      calls,
      files,
      nativeVersion: () => null,
      dockerAvailable: () => true,
      run: (command, args, options) => {
        calls.push([command, ...args, `@${options.cwd}`].join(' '));
        const given = answer(command, args);
        if (given !== undefined) return Promise.resolve(given);
        const text = args.join(' ');
        const stdout =
          text.includes(' sbom ') || args[0] === 'sbom'
            ? SBOM_REPORT
            : text.includes('secret-canary')
              ? SECRET_REPORT
              : text.includes('--input')
                ? CLEAN_IMAGE
                : '';
        return Promise.resolve({ code: 0, stdout, stderr: '' });
      },
      writeFile: (path, content) => files.set(path, content),
      mkdir: (path) => calls.push(`mkdir ${path}`),
      remove: (path) => calls.push(`rm ${path}`),
      join: (...parts) => parts.join('/'),
      randomBytes: (count) => new Uint8Array(count).fill(7),
      env: { PATH: '/bin', TRIVY_VEX: 'x' },
      ...overrides,
    };
  }

  const OPTIONS: ITrivyScanOptions = { root: '/repo', work: '/tmp/w', sbomCanary: SBOM_CANARY };
  const IMAGES = [
    { name: 'web', ref: 'example/web:1' },
    { name: 'api', ref: 'example/api:1' },
  ];

  test('passes clean images through the pinned image, the canaries first, the database downloaded once', async () => {
    const deps = fake({
      dockerUser: ['--user', '1:1'],
      containerName: (n) => `run-trivy-${String(n)}`,
    });
    const result = await scanImages(IMAGES, deps, { ...OPTIONS, now: () => 0 });
    expect(result.status).toBe('passed');
    expect(result.reason).toBe(
      '2 image(s), no finding at HIGH or CRITICAL with a fix, 2 canaries reported, pinned image',
    );
    expect(result.lines).toEqual([
      'web (example/web:1): 0 finding(s), scanned in 0s',
      'api (example/api:1): 0 finding(s), scanned in 0s',
    ]);
    const runs = deps.calls.filter((call) => call.startsWith('docker run'));
    expect(runs).toHaveLength(4);
    expect(runs[0]).toContain('--user 1:1 --name run-trivy-1');
    expect(runs[0]).toContain(' sbom ');
    expect(runs[0]).not.toContain('--skip-db-update');
    expect(runs.slice(1).every((call) => call.includes('--skip-db-update'))).toBe(true);
    expect(deps.calls).toContain('docker save --output /tmp/w/web.tar example/web:1 @/repo');
    expect(deps.calls).toContain('rm /tmp/w/web.tar');
    expect(deps.files.get('/tmp/w/trivy.yaml')).toBe('{}\n');
    expect(deps.files.get('/tmp/w/secret-canary/env')).toMatch(
      /^GITHUB_TOKEN=ghp_[A-Za-z0-9]{36}\n$/u,
    );
  });

  test('runs a native trivy in the work directory without TRIVY_* variables', async () => {
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const base = fake({ nativeVersion: () => TRIVY.version });
    const deps: ITrivyScanDeps = {
      ...base,
      run: (command, args, options) => {
        envs.push(options.env);
        return base.run(command, args, options);
      },
    };
    const result = await scanImages(IMAGES.slice(0, 1), deps, OPTIONS);
    expect(result.status).toBe('passed');
    expect(result.via).toBe('native');
    expect(base.calls.find((call) => call.startsWith('trivy'))).toMatch(
      /^trivy sbom .* @\/tmp\/w$/u,
    );
    expect(envs[0]).toEqual({ PATH: '/bin' });
  });

  test('fails every failing finding and an OS it did not judge, naming the image', async () => {
    const deps = fake({}, (_command, args) =>
      args.includes('/work/api.tar') ? { code: 0, stdout: VULNERABLE, stderr: '' } : undefined,
    );
    const result = await scanImages(IMAGES, deps, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('4 problem(s) in 2 image(s), pinned image');
    expect(result.problems[0]).toMatch(/^api: trivy could not tell the image's OS/u);
    expect(result.problems.slice(1).map((line) => line.split(' ')[1])).toEqual([
      'CVE-2026-13221',
      'CVE-2026-59873',
      'secret',
    ]);
  });

  test('fails when a canary is no longer reported', async () => {
    const deps = fake({}, (_command, args) =>
      args.includes('sbom') || args.includes('fs')
        ? { code: 0, stdout: report([]), stderr: '' }
        : undefined,
    );
    const result = await scanImages([], deps, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.problems).toHaveLength(2);
  });

  test('pulls a missing image for its platform, and is blocked or failed when the pull fails', async () => {
    const pinned = { ...TRIVY, platform: 'linux/amd64' };
    const absent = (code: number) => (_command: string, args: readonly string[]) =>
      args[0] === 'image'
        ? { code: 1, stdout: '', stderr: '' }
        : args[0] === 'pull'
          ? { code, stdout: 'denied', stderr: '' }
          : undefined;
    const logged: string[] = [];
    const pulled = fake({ log: (line) => logged.push(line) }, absent(0));
    expect((await scanImages([], pulled, { ...OPTIONS, pin: pinned })).status).toBe('passed');
    expect(pulled.calls[1]).toBe(
      `docker pull --quiet --platform linux/amd64 ${TRIVY.image} @/repo`,
    );
    expect(logged).toEqual([`pulling ${TRIVY.image}`]);
    expect((await scanImages([], fake({}, absent(1)), OPTIONS)).status).toBe('blocked');
    const judged = fake({ classifyPullFailure: () => 'failed' }, absent(1));
    const result = await scanImages([], judged, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('pull failed:\ndenied');
  });

  test('is blocked with no route, and runs nothing', async () => {
    const deps = fake({ dockerAvailable: () => false });
    const result = await scanImages(IMAGES, deps, OPTIONS);
    expect(result.status).toBe('blocked');
    expect(deps.calls).toEqual([]);
  });

  test('is blocked when the database cannot be fetched or docker itself failed, failed otherwise', async () => {
    const failing = (code: number | null, stderr: string) =>
      fake({}, (_command, args) =>
        args.includes('sbom') ? { code, stdout: '', stderr } : undefined,
      );
    const offline = await scanImages(
      IMAGES,
      failing(1, 'FATAL DB error: failed to download vulnerability DB'),
      OPTIONS,
    );
    expect(offline.status).toBe('blocked');
    expect(offline.reason).toBe(
      'trivy exited 1: FATAL DB error: failed to download vulnerability DB',
    );
    expect((await scanImages(IMAGES, failing(125, 'daemon gone'), OPTIONS)).status).toBe('blocked');
    expect((await scanImages(IMAGES, failing(null, ''), OPTIONS)).status).toBe('blocked');
    expect((await scanImages(IMAGES, failing(1, 'unable to analyze config'), OPTIONS)).status).toBe(
      'failed',
    );
  });

  test('fails a scan that printed no report, and an image docker could not save', async () => {
    const garbled = fake({}, (_command, args) =>
      args.includes('sbom') ? { code: 0, stdout: 'not json', stderr: 'odd' } : undefined,
    );
    const result = await scanImages(IMAGES, garbled, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('trivy printed no report it can be judged by:');
    const unsaved = fake({}, (_command, args) =>
      args[0] === 'save' ? { code: 1, stdout: '', stderr: 'No such image' } : undefined,
    );
    const save = await scanImages(IMAGES, unsaved, OPTIONS);
    expect(save.status).toBe('failed');
    expect(save.error).toBe('docker save example/web:1:\nNo such image');
  });

  test('fails, never passes, when a dep throws', async () => {
    const deps = fake({
      mkdir: () => {
        throw new Error('disk full');
      },
    });
    const result = await scanImages(IMAGES, deps, OPTIONS);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Error: disk full');
  });
});
