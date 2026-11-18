import {
  checkPrecompressed,
  formatPrecompressReport,
  nodePrecompressDeps,
} from '@noctcore/harness/web-budget';

// Match your server: nginx serves .br and .gz siblings for files over gzip_min_length.
const report = checkPrecompressed(
  { dir: 'apps/web/dist', minBytes: 1024, encodings: ['br', 'gz'] },
  nodePrecompressDeps,
);
console.log(formatPrecompressReport(report).join('\n'));
process.exit(report.passed ? 0 : 1);
