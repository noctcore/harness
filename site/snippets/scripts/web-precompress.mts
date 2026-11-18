import {
  checkPrecompressed,
  nodePrecompressDeps,
  precompressDir,
} from '@noctcore/harness/web-budget';

// The files your server rewrites at start or never serves get no copy.
const options = { minLength: 20, never: ['runtime.js'] };
const dir = 'apps/web/dist';

if (process.argv.includes('--check')) {
  // The gate for an output someone else wrote: every copy present, current and nothing more.
  const report = checkPrecompressed(dir, nodePrecompressDeps, options);
  for (const problem of report.problems) console.error(`FAILED ${problem}`);
  process.exit(report.problems.length === 0 ? 0 : 1);
}

// The build step: remove every old .br, then write one per eligible file.
const run = precompressDir(dir, nodePrecompressDeps, options);
console.log(`wrote ${run.written.length} .br files, removed ${run.removed.length}`);
process.exit(run.written.length > 0 ? 0 : 1);
