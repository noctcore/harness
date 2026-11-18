/*
 * Test-only: a synthetic Vite manifest and its file sizes, shared by the web
 * budget tests. Never bundled (no entry point imports it).
 *
 * The app: an `index.html` entry (the shell) that loads a shared chunk and
 * lazily imports two routes. Route `a` also imports the shared chunk and a
 * vendor chunk; route `b` imports the vendor chunk and a two-chunk cycle.
 */
import type { SizeOf } from './graph.js';
import { type IViteManifest, parseViteManifest } from './manifest.js';

export const APP_MANIFEST = {
  'index.html': {
    file: 'assets/index.js',
    src: 'index.html',
    isEntry: true,
    css: ['assets/index.css'],
    imports: ['_shared.js'],
    dynamicImports: ['src/routes/a.tsx', 'src/routes/b.tsx'],
  },
  '_shared.js': { file: 'assets/shared.js' },
  'src/routes/a.tsx': {
    file: 'assets/a.js',
    src: 'src/routes/a.tsx',
    isDynamicEntry: true,
    imports: ['_vendor.js', '_shared.js'],
    css: ['assets/a.css'],
    assets: ['assets/logo.png'],
  },
  'src/routes/b.tsx': {
    file: 'assets/b.js',
    src: 'src/routes/b.tsx',
    isDynamicEntry: true,
    imports: ['_vendor.js', '_cycle1.js'],
  },
  '_vendor.js': { file: 'assets/vendor.js' },
  '_cycle1.js': { file: 'assets/cycle1.js', imports: ['_cycle2.js'] },
  '_cycle2.js': { file: 'assets/cycle2.js', imports: ['_cycle1.js'] },
};

export const APP_SIZES: Readonly<Record<string, number>> = {
  'assets/index.js': 100,
  'assets/index.css': 20,
  'assets/shared.js': 50,
  'assets/a.js': 30,
  'assets/a.css': 5,
  'assets/logo.png': 1000,
  'assets/b.js': 40,
  'assets/vendor.js': 200,
  'assets/cycle1.js': 7,
  'assets/cycle2.js': 3,
};

/** Shell = index.js + index.css + shared.js. */
export const SHELL_BYTES = 170;

export function appManifest(extra: Record<string, unknown> = {}): IViteManifest {
  return parseViteManifest({ ...APP_MANIFEST, ...extra });
}

export function sizeOfMap(sizes: Readonly<Record<string, number>> = APP_SIZES): SizeOf {
  return (file) => sizes[file] ?? null;
}
