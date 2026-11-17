import {
  fetchPinned,
  type LinuxArch,
  nodeFetchDeps,
  WORKFLOW_LINTER_TOOLS,
} from '@noctcore/harness/pinned-tools';

// The one network call lives here, in the repo, where its origin and timeout are reviewed.
async function download(path: string): Promise<Uint8Array> {
  const response = await fetch(`https://github.com/${path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

const dir = process.argv[2] ?? '.bin';
const arch: LinuxArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const installed = await fetchPinned(WORKFLOW_LINTER_TOOLS, arch, dir, nodeFetchDeps({ download }));
console.log(`installed ${installed.join(', ')} into ${dir}`);
