import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, describe, expect, test } from 'bun:test';

import { readViteManifest } from './manifest.js';
import { nodeManifestDeps, nodePrecompressDeps, nodeReadText, nodeSizeOf } from './node.js';
import { checkPrecompressed } from './precompress.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nc-web-budget-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const BODY = 'export const x = 1;\n'.repeat(200);

describe('nodeSizeOf', () => {
  test('measures raw, gzip and brotli bytes under nested / paths', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'a.js'), BODY);
    expect(nodeSizeOf(dir, 'raw')('assets/a.js')).toBe(BODY.length);
    const gz = nodeSizeOf(dir)('assets/a.js') as number;
    expect(gz).toBe(gzipSync(BODY, { level: 9 }).length);
    const br = nodeSizeOf(dir, 'brotli')('assets/a.js') as number;
    expect(br).toBeGreaterThan(0);
    expect(br).toBeLessThan(BODY.length);
  });

  test('a missing file is null', () => {
    expect(nodeSizeOf(tempDir())('nope.js')).toBeNull();
  });
});

describe('nodeManifestDeps and nodeReadText', () => {
  test('reads a file, null when missing, throws on another error', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'm.json'), '{"a.ts":{"file":"a.js","isEntry":true}}');
    expect(readViteManifest(join(dir, 'm.json'), nodeManifestDeps).chunks.size).toBe(1);
    expect(nodeReadText(join(dir, 'gone.md'))).toBeNull();
    expect(readViteManifest(join(dir, 'gone.json'), nodeManifestDeps).problems[0]).toContain(
      'is missing',
    );
    // Reading a directory is EISDIR, not ENOENT: a problem, not a missing file.
    expect(readViteManifest(dir, nodeManifestDeps).problems[0]).toContain('cannot be read');
  });
});

describe('nodePrecompressDeps', () => {
  test('walks nested dirs with / paths and stats files', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), BODY);
    writeFileSync(join(dir, 'assets', 'deep', 'a.js'), BODY);
    expect([...(nodePrecompressDeps.listFiles(dir) ?? [])].sort()).toEqual([
      'assets/deep/a.js',
      'index.html',
    ]);
    expect(nodePrecompressDeps.stat(dir, 'assets/deep/a.js')?.size).toBe(BODY.length);
    expect(nodePrecompressDeps.stat(dir, 'assets')).toBeNull();
    expect(nodePrecompressDeps.stat(dir, 'gone')).toBeNull();
    expect(nodePrecompressDeps.listFiles(join(dir, 'gone'))).toBeNull();
  });

  test('end to end: a stale sibling on disk fails the check', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'app.js'), BODY);
    writeFileSync(join(dir, 'app.js.gz'), gzipSync(BODY));
    writeFileSync(join(dir, 'app.js.br'), 'x');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'app.js.gz'), old, old);
    const report = checkPrecompressed({ dir }, nodePrecompressDeps);
    expect(report.checked).toBe(1);
    expect(report.problems.map((p) => `${p.encoding}:${p.kind}`)).toEqual(['gz:stale']);
  });
});
