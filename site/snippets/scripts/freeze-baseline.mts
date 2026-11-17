import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { IMetaCtx } from '@noctcore/harness';
import { DEFAULT_BASELINE_DIR, portableFileGlob, serializeBaseline } from '@noctcore/harness';

import { maxFileLines } from '../lint-meta/rules/max-file-lines.mts';

const root = process.cwd();
const ctx: IMetaCtx = {
  root,
  read: (rel) => (existsSync(path.join(root, rel)) ? readFileSync(path.join(root, rel), 'utf8') : null),
  exists: (rel) => existsSync(path.join(root, rel)),
  glob: (pattern) => portableFileGlob(pattern, root),
  exec: () => ({ code: 1, stdout: '', stderr: 'exec is not used by this script' }),
};

const file = path.join(root, DEFAULT_BASELINE_DIR, `${maxFileLines.id}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, serializeBaseline(maxFileLines.baseline?.(ctx) ?? {}));
console.log(`froze ${file}`);
