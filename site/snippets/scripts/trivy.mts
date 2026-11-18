import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exitCodeFor,
  nodeTrivyScanDeps,
  readTrivyIgnoreFile,
  scanImages,
} from '@noctcore/harness/pinned-tools';

const root = process.cwd();
const ignore = readTrivyIgnoreFile(
  readFileSync(join(root, '.trivyignore.yaml'), 'utf8'),
  new Date().toISOString().slice(0, 10),
);
if (ignore.problems.length > 0) {
  for (const problem of ignore.problems) console.log(problem);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'trivy-'));
const result = await scanImages(
  [{ name: 'web', ref: 'example/web:latest' }],
  nodeTrivyScanDeps(),
  {
    root,
    work,
    sbomCanary: { file: 'checks/trivy/vulnerable.cdx.json', advisory: 'CVE-2019-10744' },
  },
);
rmSync(work, { recursive: true, force: true });
for (const line of [...result.lines, ...result.problems]) console.log(line);
if (result.error !== undefined) console.error(result.error);
console.log(`trivy: ${result.status} (${result.reason})`);
process.exit(exitCodeFor(result.status));
