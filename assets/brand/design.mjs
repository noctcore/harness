// The "Held run" identity for noctcore/harness. All visible lettering is converted to paths.
import console from 'node:console';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import * as fontkit from 'fontkit';

const directory = new URL('./', import.meta.url);
const font = fontkit.openSync(fileURLToPath(new URL('fonts/Manrope.ttf', directory)));
const sans = font.getVariation({ wght: 550 });
const display = font.getVariation({ wght: 600 });
const mono = fontkit.openSync(fileURLToPath(new URL('fonts/DMMono-Regular.ttf', directory)));

// The noctcore night and paper palettes, shared with the noctcore/auth identity.
const palettes = {
  dark: {
    background: '#17212D',
    foreground: '#F0F3F6',
    accent: '#AAC8E2',
    secondary: '#B3BEC9',
    line: '#405367',
    grid: '#253344',
    raised: '#202F40',
    side: '#2C4055',
    stop: '#D9A08E',
    shadow: '#101924',
  },
  light: {
    background: '#F6F5F1',
    foreground: '#202B39',
    accent: '#355E87',
    secondary: '#596773',
    line: '#B9C6D0',
    grid: '#E3E6E6',
    raised: '#EDF0F1',
    side: '#CCD8E1',
    stop: '#92513E',
    shadow: '#DDE2E4',
  },
};
const round = (value) => Number(value.toFixed(3));
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function lettering(value, x, y, size, color, face = sans, spacing = 0) {
  const run = face.layout(value);
  let cursor = x;
  const paths = run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index];
      const scale = size / face.unitsPerEm;
      const preciseScale = Number(scale.toFixed(6));
      const path = `<path d="${glyph.path.toSVG()}" transform="translate(${round(cursor + position.xOffset * scale)} ${round(y - position.yOffset * scale)}) scale(${preciseScale} ${-preciseScale})"/>`;
      cursor += position.xAdvance * scale + spacing;
      return path;
    })
    .join('');
  return `<g fill="${color}" aria-label="${escape(value)}">${paths}</g>`;
}

/** The advance width of a run of text, for right-aligned labels. */
function measure(value, size, face = sans, spacing = 0) {
  const run = face.layout(value);
  const scale = size / face.unitsPerEm;
  return run.positions.reduce((sum, position) => sum + position.xAdvance * scale + spacing, 0);
}

function document(width, height, title, description, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc>${content}</svg>\n`;
}

function rectangle(x, y, width, height, fill, radius = 0, stroke = 'none') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function line(path, color, width = 1, extra = '') {
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" ${extra}/>`;
}

// Two brackets hold a visible core, on the same four-unit grid and eight-unit
// stroke as the noctcore/auth mark: the repo's own rules, held in place.
const geometry = '<path d="M12 12h16v8h-8v24h8v8H12zM52 12H36v8h8v24h-8v8h16zM28 28h8v8h-8z"/>';
function mark(x, y, size, color) {
  return `<g transform="translate(${x} ${y}) scale(${size / 64})" fill="${color}">${geometry}</g>`;
}

function lockup(x, y, scale, palette) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">${mark(0, 0, 64, palette.accent)}${lettering('noctcore/harness', 72, 47, 43, palette.foreground, display, -0.4)}</g>`;
}

function grid(palette, width, height) {
  return `<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${palette.grid}" stroke-width="1"/></pattern></defs>${rectangle(0, 0, width, height, palette.background)}<g opacity=".48">${rectangle(0, 0, width, height, 'url(#grid)')}</g>`;
}

/** The mark as a solid object: a depth plane, side faces and a hairline on top. */
function heldMark(cx, cy, size, palette) {
  const scale = size / 64;
  return (
    `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${scale})">` +
    `<g transform="translate(0 6)" fill="${palette.shadow}">${geometry}</g>` +
    `<path d="M12 52v6h16v-6zM20 20v6h8v-6zM36 52v6h16v-6zM36 20v6h8v-6zM28 36v6h8v-6z" fill="${palette.side}"/>` +
    `<g fill="${palette.accent}">${geometry}</g>` +
    line('M12 12h16M12 12v40M52 12H36M52 12v40M28 28h8', palette.foreground, 0.5) +
    '</g>'
  );
}

/*
 * The checks of one run, each on its own track. A passing check runs on in a
 * continuous line with forward ticks and lands on the core square. A failed
 * check is dashed and ends at a perpendicular cap; a blocked one is dashed and
 * capped too, and says why. Color is never the only signal: line style, the end
 * shape and the verdict word all carry it.
 */
const RUN = [
  { name: 'unit-tests', detail: 'node --test', verdict: 'passed' },
  { name: 'lockfile-registry-resolutions', detail: 'lint-meta · supply-chain', verdict: 'passed' },
  { name: 'actionlint 1.7.12', detail: 'pinned · native', verdict: 'passed' },
  {
    name: 'github-actions-secret-no-install',
    detail: 'a job reads NPM_TOKEN and runs npm ci',
    verdict: 'failed',
  },
  { name: 'zizmor 1.30.1', detail: 'no pinned binary, no Docker', verdict: 'blocked · exit 2' },
];

function track(y, x0, x1, verdict, palette, weight = 3) {
  if (verdict === 'passed') {
    let content = line(`M${x0} ${y}H${x1 - 14}`, palette.accent, weight);
    for (let x = x0 + 46; x < x1 - 40; x += 92) {
      content += `<path d="M${x - 5} ${y - 6}l7 6-7 6" fill="none" stroke="${palette.accent}" stroke-width="2"/>`;
    }
    content += rectangle(x1 - 10, y - 10, 20, 20, palette.accent);
    return content;
  }
  const end = x1 - 34;
  return (
    line(`M${x0} ${y}H${end}`, palette.stop, weight - 1, 'stroke-dasharray="6 8"') +
    line(`M${end} ${y - 12}v24`, palette.stop, 3) +
    `<circle cx="${end}" cy="${y}" r="3.5" fill="${palette.stop}"/>`
  );
}

function ledger(palette, { compact = false } = {}) {
  // Shared 1040 x 600 drawing space.
  const rows = compact ? RUN.filter((_, index) => index !== 0) : RUN;
  const top = compact ? 70 : 92;
  const step = compact ? 128 : 96;
  const nameSize = compact ? 34 : 25;
  const trackStart = compact ? 650 : 600;
  const trackEnd = 960;
  let content = '';
  // The run: one spine that every check hangs from.
  const spineEnd = top + step * (rows.length - 1);
  content += line(`M44 ${top - 40}V${spineEnd + 40}`, palette.line, 1);
  if (!compact)
    content += lettering('.nightcore/harness.json', 64, top - 46, 17, palette.secondary, mono);
  rows.forEach((row, index) => {
    const y = top + step * index;
    const passed = row.verdict === 'passed';
    content += line(`M44 ${y}H64`, palette.line, 1);
    content += rectangle(
      38,
      y - 6,
      12,
      12,
      passed ? palette.accent : palette.background,
      0,
      passed ? 'none' : palette.stop,
    );
    if (!compact)
      content += lettering(
        String(index + 1).padStart(2, '0'),
        80,
        y - 16,
        15,
        palette.accent,
        mono,
      );
    content += lettering(
      row.name,
      compact ? 80 : 112,
      y - (compact ? 4 : 10),
      nameSize,
      palette.foreground,
      display,
    );
    const detailSize = compact ? 24 : 17;
    content += lettering(
      row.detail,
      compact ? 80 : 112,
      y + (compact ? 34 : 20),
      detailSize,
      palette.secondary,
      mono,
    );
    content += track(y, trackStart, trackEnd, row.verdict, palette, compact ? 4 : 3);
    const verdictSize = compact ? 24 : 17;
    const word = compact ? row.verdict.split(' ')[0] : row.verdict;
    const color = passed ? palette.accent : palette.stop;
    content += lettering(
      word,
      trackEnd - measure(word, verdictSize, mono),
      y + (compact ? 40 : 34),
      verdictSize,
      color,
      mono,
    );
  });
  if (!compact) {
    const y = spineEnd + 82;
    content += line(`M44 ${spineEnd + 40}V${y - 6}`, palette.line, 1);
    content += rectangle(36, y - 8, 16, 16, palette.stop);
    content += lettering('exit 1', 72, y + 6, 22, palette.foreground, display);
    content += lettering(
      'every check ran; both stops are listed with their output',
      160,
      y + 5,
      17,
      palette.secondary,
      mono,
    );
  }
  return content;
}

const outputs = new Map();
const save = (name, source) => outputs.set(name, source);
const description =
  'Held run: two brackets hold a visible square core. A repository held to its own rules, in its own CI.';
save(
  'icon.svg',
  document(
    64,
    64,
    'noctcore/harness',
    description,
    rectangle(0, 0, 64, 64, palettes.dark.background, 12) + mark(0, 0, 64, palettes.dark.accent),
  ),
);
save(
  'favicon.svg',
  document(
    64,
    64,
    'noctcore/harness',
    description,
    rectangle(0, 0, 64, 64, palettes.dark.background, 12) + mark(0, 0, 64, palettes.dark.accent),
  ),
);
save(
  'icon-mono.svg',
  document(64, 64, 'noctcore/harness', description, mark(0, 0, 64, 'currentColor')),
);

const heroDescription =
  'One harness.json run: unit tests, a lockfile rule and actionlint at its pinned version pass; the secret-no-install rule fails on a job that reads a token and installs packages; zizmor is blocked with exit 2 because neither its pinned binary nor Docker is there. Every check runs, and the run exits 1 listing both stops.';
for (const theme of ['dark', 'light']) {
  const palette = palettes[theme];
  const logo = document(442, 64, 'noctcore/harness', description, lockup(0, 0, 1, palette));
  save(`logo-${theme}.svg`, logo);
  if (theme === 'light') save('logo.svg', logo);
  save(
    `hero-${theme}.svg`,
    document(
      1040,
      680,
      'One run, every check in view',
      heroDescription,
      grid(palette, 1040, 680) +
        lettering('CHECK RUN / FULL RUN', 52, 42, 14, palette.secondary, mono, 1.2) +
        heldMark(960, 40, 44, palette) +
        `<g transform="translate(0 60)">${ledger(palette)}</g>`,
    ),
  );
  const header =
    grid(palette, 1280, 360) +
    lockup(88, 56, 0.9, palette) +
    lettering('Hold a repo to its own rules.', 88, 207, 50, palette.foreground, display, -1.2) +
    lettering(
      'Checks that run in any CI, with no server and no account.',
      90,
      256,
      23,
      palette.secondary,
    ) +
    `<g transform="translate(724 34) scale(.5)">${ledger(palette, { compact: true })}</g>`;
  save(
    `readme-header-${theme}.svg`,
    document(
      1280,
      360,
      'noctcore/harness. Hold a repo to its own rules.',
      'Checks that run in any CI, with no server and no account. A lockfile rule and a pinned actionlint pass; a secret-no-install rule fails and a pinned zizmor is blocked.',
      header,
    ),
  );
}

const palette = palettes.dark;
const social =
  grid(palette, 1280, 640) +
  lockup(104, 76, 0.82, palette) +
  lettering('TYPESCRIPT / OPEN SOURCE', 940, 113, 13, palette.accent, mono, 1.1) +
  lettering('Hold a repo to its own rules.', 104, 234, 60, palette.foreground, display, -1.4) +
  lettering(
    'Checks that run in any CI, with no server and no account.',
    107,
    283,
    25,
    palette.secondary,
  ) +
  `<g transform="translate(104 330) scale(.47)">${ledger(palette, { compact: true })}</g>` +
  `<g transform="translate(700 336)">${lettering('npx @noctcore/harness check', 0, 40, 24, palette.foreground, mono)}${lettering('zero runtime dependencies', 0, 96, 20, palette.secondary, mono)}${lettering('no network call at run time', 0, 132, 20, palette.secondary, mono)}${lettering('Node 22, tested on Linux and Windows', 0, 168, 20, palette.secondary, mono)}</g>`;
save(
  'social-preview.svg',
  document(
    1280,
    640,
    'noctcore/harness. Hold a repo to its own rules.',
    'Checks that run in any CI, with no server and no account. A run where a lockfile rule and a pinned actionlint pass, a secret-no-install rule fails and a pinned zizmor is blocked. Zero runtime dependencies, no network call at run time.',
    social,
  ),
);
for (const [name, source] of outputs) writeFileSync(new URL(name, directory), source);
console.log(`Wrote ${outputs.size} outlined SVG sources.`);
