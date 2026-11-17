# noctcore/harness identity

**Held run** shows what the package does: two brackets hold a visible core.
The repository is the core; its own committed rules are the brackets around it.
The illustrations draw one run of `harness check` as a ledger: every check
hangs from the same spine, runs on its own track, and ends in a verdict. The
mark is original, hand drawn SVG geometry, not a shield, padlock, checkmark or
claim that a green run proves anything beyond the checks it ran.

The identity is a sibling of [noctcore/auth](https://github.com/noctcore/auth):
the same night and paper palettes, the same Manrope and DM Mono lettering, the
same four-unit grid and eight-unit stroke for the mark, and the same line
language. A passing check runs on in a continuous line with forward ticks and
lands on the square core. A check that stops is dashed and ends at a
perpendicular cap, in copper. There are no gradients, glows or embedded images.

The wordmark is **noctcore/harness**, matching the GitHub repository. In
running prose and install instructions, use **@noctcore/harness**. The leading
promise is **Hold a repo to its own rules.** Its supporting line is **Checks
that run in any CI, with no server and no account.**

## Files

| File | Purpose |
| --- | --- |
| `icon.svg` | Primary square icon, night tile on either theme |
| `icon-mono.svg` | Transparent, single color mark using `currentColor` |
| `icon-{16,32,64,180,512}.png` | Favicon, app icon and avatar exports |
| `favicon.svg` | Self contained SVG favicon, same pixel grid as the primary icon |
| `logo.svg` | Default transparent lockup for a light surface |
| `logo-light.svg` | Blue mark and ink wordmark for a light surface |
| `logo-dark.svg` | Pale blue mark and pale wordmark for a dark surface |
| `social-preview.svg` | Editable, outlined 1280 x 640 social artwork |
| `social-preview.png` | GitHub social preview, exactly 1280 x 640, under 1 MB |
| `readme-header-light.svg` | Wide 1280 x 360 banner for light mode |
| `readme-header-dark.svg` | Wide 1280 x 360 banner for dark mode |
| `hero-light.svg` | Paper version of the 1040 x 680 docs illustration |
| `hero-dark.svg` | Night version of the 1040 x 680 docs illustration |
| `design.mjs` | Editable geometry, typography and composition source for every SVG |
| `export.mjs` | Exports and verifies every shipped PNG; parses every SVG |
| `fonts/` | Exact, openly licensed fonts used to rebuild the outlined lettering |
| `licenses/` | Complete font copyright notices and SIL Open Font License texts |

Suffixes name the **intended background**, not the lettering color. Every SVG
contains a title and description. All visible lettering is paths: displaying
an asset requires no fonts, network requests, scripts or raster resources.

## Palette

The palette is the noctcore night and paper set. Hex sRGB values are the
source of truth.

| Token | Hex | Role |
| --- | --- | --- |
| Night | `#17212D` | Lead background, icon tile |
| Paper | `#F6F5F1` | Light background |
| Ink | `#202B39` | Light text |
| Blue | `#355E87` | Light mark and passing tracks |
| Pale blue | `#AAC8E2` | Night mark and passing tracks |
| Cloud | `#F0F3F6` | Night primary text |
| Slate | `#596773` | Light secondary text |
| Mist | `#B3BEC9` | Night secondary text |
| Copper, night | `#D9A08E` | Failed and blocked checks on night |
| Copper, day | `#92513E` | Failed and blocked checks on paper |

Every text pairing exceeds 4.5:1 (WCAG AA for normal text); the ratios are
listed in the noctcore/auth brand README, which uses the same pairs. Color is
redundant in the illustrations: the line style, the end shape (square core or
perpendicular cap) and the verdict word all say whether a check passed.

## What the illustrations mean

The ledger is a conceptual picture of one `harness check` run, not a recorded
log. Its rows are real names from the package:

1. `unit-tests` stands for any command a `harness.json` check runs.
2. `lockfile-registry-resolutions` is one of the rules in
   `@noctcore/harness/rules`, run by `harness lint-meta`.
3. `actionlint 1.7.12` and `zizmor 1.30.1` are the default pins in
   `@noctcore/harness/pinned-tools`. Blocked means neither the pinned binary
   nor a Docker daemon was there, so the check exits 2 instead of passing.
4. `github-actions-secret-no-install` fails on a job that reads a stored secret
   and installs packages.

The run goes on past the first failure and exits 1 with every failed check
listed, which is what the runner does.

## README picture snippet

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/readme-header-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/readme-header-light.svg">
  <img src="assets/brand/readme-header-light.svg" width="100%" alt="noctcore/harness. Hold a repo to its own rules. Checks that run in any CI, with no server and no account.">
</picture>
```

## Usage rules

- Keep the mark upright with both brackets open toward the core. Do not close
  the brackets, round their corners, rotate, stretch or add effects.
- The icon uses a 64-unit canvas. Its occupied area is x=12..52, y=12..52;
  strokes, core and gaps use an exact four-unit grid, so at 16 px every stroke
  is two pixels wide.
- Choose `logo-dark.svg` for dark surfaces and `logo-light.svg` for light
  surfaces. The icon tile stays night in both themes. Do not tint the wordmark
  copper: copper belongs to checks that stopped.
- The docs heroes are designed at **640 px wide** and up. At narrow widths,
  rely on the HTML next to them rather than the small annotations.

## Typography and licensing

The wordmark and headings use **Manrope 600**; supporting prose uses
**Manrope 550**. Technical labels use **DM Mono Regular 400**. Both families
use the **SIL Open Font License 1.1**, with the complete upstream notices in
[`licenses/`](licenses/). Provenance, pinned upstream links and SHA-256 hashes
are in [`fonts/README.md`](fonts/README.md).

The original mark, illustrations, layouts and scripts use this repository's
MIT license. Font software keeps its separate OFL license.

## Rebuild and verify

Requires Node.js 22 or later and npm. The tooling is self contained here; the
Bun workspace is unchanged. From the repository root:

```sh
npm --prefix assets/brand ci
npm --prefix assets/brand run design   # rebuild every SVG from design.mjs
npm --prefix assets/brand run export   # render the PNGs from the SVGs
npm --prefix assets/brand run check    # render again and require identical PNGs
```

`export` renders with pinned `@resvg/resvg-js` 2.6.2 and system fonts disabled;
`design` uses pinned `fontkit` 2.0.4 and the fonts in `fonts/` to outline every
letter.

GitHub's social preview must be uploaded by hand in the repository's
**Settings > General > Social preview**. There is no API for it.
