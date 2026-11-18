/*
 * Tools pinned three ways at once: the version a native binary must report,
 * the image a check falls back to (by index digest), and the linux release
 * assets CI installs (by sha256). A different version audits with a different
 * rule set, so a native tool of another version is never used.
 *
 * The pins below are the defaults this package ships. A repo that needs
 * another version passes its own pin to the same functions; moving a default
 * here is a minor release, because a new rule set can turn a green repo red.
 */

/**
 * A linux release asset: an archive and the binary's path inside it (`member`),
 * or, with no `member`, the binary itself. `path` is under https://github.com/,
 * the only origin fetched.
 */
export interface IReleaseArchive {
  readonly path: string;
  readonly sha256: string;
  readonly member?: string;
}

/** x64 is a GitHub runner; arm64 is a local runner (act) on Apple Silicon. */
export type LinuxArch = 'x64' | 'arm64';

/** What `fetchPinned` installs: any tool pinned by version and by the sha256 of its linux assets. */
export interface IPinnedTool {
  readonly name: string;
  readonly version: string;
  readonly versionArgs: readonly string[];
  readonly linux: Readonly<Record<LinuxArch, IReleaseArchive>>;
}

/** A pinned tool that a check runs natively, or through the image of the tool that needs it. */
export type IToolPin = IPinnedTool;

/** A pinned tool with an image to fall back to: native at the pinned version, else the image by digest. */
export interface IImagePin extends IPinnedTool {
  /** The image, pinned by index digest. */
  readonly image: string;
  /** Set when the image is published for this platform only (Rosetta or QEMU elsewhere). */
  readonly platform?: string;
}

/** A pinned linter: native at the pinned version, else its image by digest. */
export interface ILinterPin extends IImagePin {
  /** Native tools that must also be on PATH at their pinned version. */
  readonly needs: readonly IToolPin[];
}

export const SHELLCHECK: IToolPin = {
  name: 'shellcheck',
  version: '0.11.0',
  versionArgs: ['--version'],
  linux: {
    x64: {
      path: 'koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz',
      sha256: 'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      member: 'shellcheck-v0.11.0/shellcheck',
    },
    arm64: {
      path: 'koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.aarch64.tar.gz',
      sha256: '68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc',
      member: 'shellcheck-v0.11.0/shellcheck',
    },
  },
};

/** zizmor: GitHub Actions security audits. */
export const ZIZMOR: ILinterPin = {
  name: 'zizmor',
  version: '1.30.1',
  versionArgs: ['--version'],
  image:
    'ghcr.io/zizmorcore/zizmor:1.30.1@sha256:a2eb396d886c053073405c7a980f2139ba2248ec172243cfa3841e57196e8101',
  platform: 'linux/amd64',
  needs: [],
  linux: {
    x64: {
      path: 'zizmorcore/zizmor/releases/download/v1.30.1/zizmor-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a',
      member: 'zizmor',
    },
    arm64: {
      path: 'zizmorcore/zizmor/releases/download/v1.30.1/zizmor-aarch64-unknown-linux-gnu.tar.gz',
      sha256: '7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540',
      member: 'zizmor',
    },
  },
};

/**
 * actionlint: workflow syntax, expressions, and every `run:` script through
 * shellcheck. The image bundles shellcheck 0.11.0, so the Docker route needs
 * nothing native.
 */
export const ACTIONLINT: ILinterPin = {
  name: 'actionlint',
  version: '1.7.12',
  versionArgs: ['-version'],
  image:
    'docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',
  needs: [SHELLCHECK],
  linux: {
    x64: {
      path: 'rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
      sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      member: 'actionlint',
    },
    arm64: {
      path: 'rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_arm64.tar.gz',
      sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      member: 'actionlint',
    },
  },
};

/** The workflow linters this package knows how to run, by name. */
export type WorkflowLinterId = 'zizmor' | 'actionlint';

export const WORKFLOW_LINTERS: Readonly<Record<WorkflowLinterId, ILinterPin>> = {
  zizmor: ZIZMOR,
  actionlint: ACTIONLINT,
};

/** Every linux asset the workflow linters need on the native route: both linters and shellcheck. */
export const WORKFLOW_LINTER_TOOLS: readonly IToolPin[] = [ZIZMOR, ACTIONLINT, SHELLCHECK];

/**
 * The gitleaks image a secret scan falls back to, by digest. Its tag must name
 * the version CI installs; `chooseGitleaksRoute` refuses it otherwise.
 */
export const GITLEAKS_IMAGE =
  'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

/**
 * hadolint: the Dockerfile linter. It links ShellCheck in as a library, so no
 * native shellcheck is needed on either route. The linux release assets are
 * the binaries themselves, so neither has a `member`.
 */
export const HADOLINT: IImagePin = {
  name: 'hadolint',
  version: '2.15.1',
  versionArgs: ['--version'],
  image:
    'ghcr.io/hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d',
  linux: {
    x64: {
      path: 'hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64',
      sha256: 'c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507',
    },
    arm64: {
      path: 'hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-arm64',
      sha256: 'f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d',
    },
  },
};

/**
 * squawk: the Postgres migration linter. The image is published for
 * linux/amd64 only. The linux release assets are the binaries themselves.
 */
export const SQUAWK: IImagePin = {
  name: 'squawk',
  version: '2.67.0',
  versionArgs: ['--version'],
  image:
    'ghcr.io/sbdchd/squawk:2.67.0@sha256:48cb8552edce6fbe4f3e5826eb92ea3b798bedf79592e1bce5fddc2b7130a082',
  platform: 'linux/amd64',
  linux: {
    x64: {
      path: 'sbdchd/squawk/releases/download/v2.67.0/squawk-linux-x64',
      sha256: '03efe0e666b63bf33e2493693ee0aa9dbed07cbdcd20f7a8292245c1da9d790a',
    },
    arm64: {
      path: 'sbdchd/squawk/releases/download/v2.67.0/squawk-linux-arm64',
      sha256: '25c4f95f81bcdbb0a0dc909820c22eb657a12381558b7275bd69f98f253b9b64',
    },
  },
};

/** trivy: the image scanner (vulnerabilities and secrets). */
export const TRIVY: IImagePin = {
  name: 'trivy',
  version: '0.75.0',
  versionArgs: ['--version'],
  image:
    'ghcr.io/aquasecurity/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa',
  linux: {
    x64: {
      path: 'aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz',
      sha256: 'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f',
      member: 'trivy',
    },
    arm64: {
      path: 'aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-ARM64.tar.gz',
      sha256: 'a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3',
      member: 'trivy',
    },
  },
};
