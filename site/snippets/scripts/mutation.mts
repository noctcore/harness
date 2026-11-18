import {
  finishVerdict,
  type IMutationRequest,
  type IMutationTarget,
  nodeMutationDeps,
  runMutation,
} from '@noctcore/harness-mutation';

// Your targets: each package has its own stryker.config.mjs.
const TARGETS: Readonly<Record<string, IMutationTarget>> = {
  core: { dir: 'packages/core', checkId: 'mutation-core', ratchet: true, changedCheckId: 'mutation-changed' },
  server: { dir: 'packages/server', checkId: 'mutation-server', ratchet: false, changedCheckId: null },
};

const args = new Set(process.argv.slice(2));
const target = TARGETS[args.has('--server') ? 'server' : 'core'];
if (target === undefined) throw new Error('unknown target');

const request: IMutationRequest = {
  target,
  accept: args.has('--accept'),
  changed: args.has('--changed') ? { baseRef: 'origin/main' } : null,
  acceptHint: 'bun scripts/mutation.mts --accept',
  neverMutate: ['packages/core/src/generated/'],
};

const { checkId, verdict } = await runMutation(request, nodeMutationDeps(process.cwd()));
const { lines, exitCode } = finishVerdict(checkId, verdict);
for (const line of lines) console.log(line);
// Set the exit code instead of calling process.exit, so piped output is not cut off.
process.exitCode = exitCode; // 0 passed, 1 failed, 2 blocked
