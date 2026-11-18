/*
 * Builds the package's own tsup `dist`, then loads it under plain `node` (not
 * `bun`) and checks the shipped files: no network or Bun import, and no import
 * of Stryker, which is a peer dependency the runner spawns, never loads.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, test } from 'bun:test';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(PKG_ROOT, 'dist');
const ENTRYPOINTS = ['index.js', 'index.cjs'].map((file) => path.join(DIST, file));

beforeAll(() => {
  if (!ENTRYPOINTS.every((file) => existsSync(file))) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: PKG_ROOT, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`tsup build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
}, 120_000);

describe('the built dist', () => {
  const FORBIDDEN = [
    "'http'",
    '"http"',
    "'https'",
    '"https"',
    "'net'",
    '"net"',
    "'dns'",
    '"dns"',
    "'tls'",
    '"tls"',
    "'bun'",
    '"bun"',
    'node:http',
    'node:https',
    'node:net',
    'node:dns',
    'node:tls',
    'bun:',
  ];
  /** An import or require of any Stryker package. */
  const STRYKER_IMPORT =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@stryker-mutator\//u;

  test('has no network, Bun or Stryker import and no fetch() call', () => {
    for (const file of ENTRYPOINTS) {
      const body = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        expect({ file, needle, found: body.includes(needle) }).toEqual({
          file,
          needle,
          found: false,
        });
      }
      expect(STRYKER_IMPORT.test(body)).toBe(false);
      expect(/\bfetch\s*\(/u.test(body)).toBe(false);
    }
  });

  test('loads under plain node, as ESM and as CommonJS', () => {
    const esm = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { finishVerdict, judgeScore } from ${JSON.stringify(pathToFileURL(ENTRYPOINTS[0] ?? '').href)};
const judged = judgeScore(70, { baseline: 71.5, accept: false, allowLowering: false });
console.log(JSON.stringify(finishVerdict('m', judged)));`,
      ],
      { encoding: 'utf8' },
    );
    expect(esm.stderr).toBe('');
    expect(JSON.parse(esm.stdout)).toEqual({
      lines: ['m: failed (mutation score dropped: 70.00% < baseline 71.50% (tolerance 1 point))'],
      exitCode: 1,
    });

    const cjs = spawnSync(
      'node',
      [
        '-e',
        `const m = require(${JSON.stringify(ENTRYPOINTS[1])});
console.log(typeof m.runMutation, typeof m.nodeMutationDeps, m.parseBaseline('{"score": 12.5}'));`,
      ],
      { encoding: 'utf8' },
    );
    expect(cjs.stderr).toBe('');
    expect(cjs.stdout.trim()).toBe('function function 12.5');
  });
});
