/*
 * squawk, a linter for Postgres migrations, over every migration that is not
 * in the repo's baseline. It reports statements that take or wait on a long
 * lock: an index built without CONCURRENTLY, a foreign key or CHECK added
 * without NOT VALID, a column made NOT NULL by a scan. The rules and the
 * reason for every one that is off are in the repo's squawk configuration.
 *
 * Native at exactly the pinned version, else the pinned image when a Docker
 * daemon answers, else BLOCKED. Every run also lints the repo's canaries with
 * the same binary and configuration. With nothing but baselined migrations in
 * the tree that is the only thing squawk is asked, so a pin or a configuration
 * that stopped judging fails the check on the day it happens.
 *
 * There is no inline escape: a `squawk-ignore` or
 * `squawk-disable-assume-in-transaction` comment in a linted migration fails
 * the check before squawk runs, and so do two things that make a file read
 * one way here and another way to Postgres (a bare carriage return and
 * `standard_conforming_strings`). A repo adds its own checks of a migration's
 * text through `inspect`.
 *
 * THE BASELINE IS A RATCHET, by design. The migrations that existed when the
 * check arrived are pinned by the sha256 of their file and never linted (an
 * applied migration cannot be edited, so a finding in one could only be read).
 * The set only loses members: a pinned migration whose folder is deleted moves
 * to `retired` with its hash. The seal is the sha256 of both lists together, so
 * a list changed without its seal fails. A list changed together with its seal
 * passes: that is a reviewer's to catch, and the seal only makes it evident.
 */
import { createHash } from 'node:crypto';

import type { IImagePin } from './pins.js';
import { SQUAWK } from './pins.js';
import type { LinterRoute } from './route.js';
import type { ICapturedRunDeps, IToolCanary, IToolResult } from './tool-run.js';
import {
  canaryProblems,
  chooseToolRoute,
  findingsVerdict,
  isRecord,
  plural,
  runCaptured,
  unjudgeable,
} from './tool-run.js';

/** The configuration file a run reads, unless the options name another. */
export const SQUAWK_CONFIG = '.squawk.toml';
/** The file a migration folder holds (the Prisma layout), unless the options name another. */
export const MIGRATION_FILE = 'migration.sql';
/** The only keys the configuration may set, and must set, unless the options name others. */
export const SQUAWK_CONFIG_KEYS: readonly string[] = [
  'pg_version',
  'assume_in_transaction',
  'excluded_rules',
];

/**
 * The migrations a repo keeps out of the lint, each pinned by the sha256 of
 * its file (`squawkSha256`), the ones that left, and the seal over both
 * (`baselineSeal`). `source` names where the lists live, for the messages.
 */
export interface ISquawkBaseline {
  readonly pinned: Readonly<Record<string, string>>;
  readonly retired: Readonly<Record<string, string>>;
  readonly seal: string;
  readonly source: string;
}

export interface ISquawkOptions {
  /** The repo-relative directory whose folders are the migrations. */
  readonly migrationsDir: string;
  /** The file in each folder. Defaults to `migration.sql`. */
  readonly migrationFile?: string;
  /** The pin to run. Defaults to `SQUAWK`. */
  readonly pin?: IImagePin;
  /** The repo-relative configuration file. Defaults to `.squawk.toml`. */
  readonly configFile?: string;
  /** The keys the configuration may and must set. Defaults to `SQUAWK_CONFIG_KEYS`. */
  readonly configKeys?: readonly string[];
  /** Fixtures squawk must report with exactly these rules on every run. */
  readonly canaries?: readonly IToolCanary[];
  /** The migrations kept out of the lint. Without one, every migration is linted. */
  readonly baseline?: ISquawkBaseline;
  /** The repo's own problems with the text of a linted migration, refused before squawk runs. */
  readonly inspect?: (file: string, sql: string) => readonly string[];
}

/** A folder under the migrations directory (or a link to one), and whether it holds its file. */
export interface IMigrationDir {
  readonly name: string;
  readonly hasSql: boolean;
  /** The entry is a symbolic link. A migration tool may follow it and apply what it finds there. */
  readonly symlink?: boolean;
}

export function migrationPath(
  name: string,
  options: Pick<ISquawkOptions, 'migrationsDir' | 'migrationFile'>,
): string {
  return `${options.migrationsDir}/${name}/${options.migrationFile ?? MIGRATION_FILE}`;
}

/**
 * The sha256 a baselined migration is pinned by. Line endings are read as LF,
 * so a Windows checkout of the same file has the same hash.
 */
export function squawkSha256(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/**
 * The sha256 of every `name sha256` line of the pinned and the retired
 * migrations together, sorted by name. Moving an entry between the two keeps
 * it; adding one, renaming one or changing a hash does not.
 */
export function baselineSeal(
  pinned: Readonly<Record<string, string>>,
  retired: Readonly<Record<string, string>>,
): string {
  const lines = [...Object.entries(pinned), ...Object.entries(retired)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hash]) => `${name} ${hash}\n`);
  return createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
}

export interface IMigrationSelection {
  /** The migrations to lint, sorted: every folder that is not pinned in the baseline. */
  readonly lint: readonly string[];
  /** How many folders the baseline keeps out of the lint. */
  readonly baselined: number;
  /** Why the tree cannot be judged as it stands. Any entry fails the check. */
  readonly problems: readonly string[];
}

/**
 * Split the migration folders into the baselined and the linted, and say what
 * is wrong with the baseline or the tree: a pinned file whose content changed
 * (what was added to it would never be linted), a pinned name with no folder
 * (a new migration reusing it would skip the lint), a name both pinned and
 * retired, a baseline whose seal no longer matches, a folder that is a
 * symbolic link, and a folder with no migration file. `hashOf` is asked for
 * the pinned folders only.
 */
export function selectMigrations(
  found: readonly IMigrationDir[],
  hashOf: (name: string) => string,
  options: Pick<ISquawkOptions, 'migrationsDir' | 'migrationFile' | 'baseline'>,
): IMigrationSelection {
  const { migrationsDir } = options;
  const file = options.migrationFile ?? MIGRATION_FILE;
  const baseline = options.baseline;
  const pinned = baseline?.pinned ?? {};
  const problems: string[] = [];
  const names = new Map(found.map((dir) => [dir.name, dir]));
  if (baseline !== undefined) {
    if (baselineSeal(baseline.pinned, baseline.retired) !== baseline.seal) {
      problems.push(
        `${baseline.source} no longer matches its seal: a migration was added to it, or a ` +
          'pinned hash was changed. A new migration is made to pass, never listed; a pinned one ' +
          'whose folder is gone moves to the retired list with its hash, which keeps the seal',
      );
    }
    for (const [name, hash] of Object.entries(baseline.pinned)) {
      if (name in baseline.retired) {
        problems.push(`the baseline names ${name} as pinned and as retired`);
      }
      const dir = names.get(name);
      if (dir === undefined) {
        problems.push(
          `the baseline pins ${name}, but ${migrationsDir}/${name} is gone: move the entry to ` +
            `the retired list in ${baseline.source} (a new migration reusing the name would ` +
            'never be linted)',
        );
      } else if (dir.symlink !== true && dir.hasSql && hashOf(name) !== hash) {
        problems.push(
          `${migrationPath(name, options)} is not the file the baseline pinned: an applied ` +
            'migration is never edited, and what was added to it would not be linted. Restore ' +
            'it and put the change in a new migration',
        );
      }
    }
  }
  for (const dir of found) {
    if (dir.symlink === true) {
      problems.push(
        `${migrationsDir}/${dir.name} is a symbolic link. A migration tool may follow it and ` +
          'apply what it points at, which may be outside the repository and is not what this ' +
          'check can vouch for: make it a real folder',
      );
    } else if (!dir.hasSql) {
      problems.push(`${migrationsDir}/${dir.name} has no ${file}`);
    }
  }
  const lint = found
    .filter((dir) => dir.symlink !== true && dir.hasSql && !(dir.name in pinned))
    .map((dir) => dir.name)
    .sort();
  return { lint, baselined: found.filter((dir) => dir.name in pinned).length, problems };
}

/*
 * Any spelling of squawk's comment directives: `squawk-ignore`,
 * `squawk-ignore-file`, `squawk-disable-assume-in-transaction`. Matched in the
 * raw text, wherever it stands and in any case: a migration has no reason to
 * hold the words at all.
 */
const DIRECTIVE = /squawk-(?:ignore|disable)/iu;

/** The 1-based lines of `sql` that carry a squawk directive. */
export function findDirectives(sql: string): readonly number[] {
  return sql.split(/\r?\n/u).flatMap((line, index) => (DIRECTIVE.test(line) ? [index + 1] : []));
}

/*
 * A carriage return that is not part of a CRLF line ending: Postgres ends a
 * `--` comment there and runs what follows, and an editor shows one line.
 *
 * `standard_conforming_strings`: with it off a backslash escapes a quote in an
 * ordinary string, so where a string ends depends on a setting of the session.
 * What is matched is the name written out.
 */
const BARE_CARRIAGE_RETURN = /\r(?!\n)/gu;
const STRING_SETTING = /standard_conforming_strings/giu;

/** The 1-based lines (counted in line feeds) where `pattern` matches in `sql`. */
function linesOf(sql: string, pattern: RegExp): readonly number[] {
  return [...sql.matchAll(pattern)].map((match) => sql.slice(0, match.index).split('\n').length);
}

/**
 * What the check refuses in the text of one linted migration before squawk
 * reads it: a squawk directive, a bare carriage return, and
 * `standard_conforming_strings`, each by line.
 */
export function migrationProblems(
  file: string,
  sql: string,
  configFile: string = SQUAWK_CONFIG,
): readonly string[] {
  const problems: string[] = findDirectives(sql).map(
    (line) =>
      `${file}:${String(line)}: a squawk comment directive. A migration is made to pass, or ` +
      `the rule is turned off for every migration in ${configFile} with its reason; a ` +
      'finding is never ignored in place.',
  );
  for (const line of linesOf(sql, BARE_CARRIAGE_RETURN)) {
    problems.push(
      `${file}:${String(line)}: a carriage return that is not followed by a line feed. ` +
        'Postgres ends a -- comment there and runs what follows, while an editor shows one ' +
        'commented line: end every line with a line feed.',
    );
  }
  for (const line of linesOf(sql, STRING_SETTING)) {
    problems.push(
      `${file}:${String(line)}: standard_conforming_strings. With it off a backslash escapes ` +
        'a quote, so where a string ends depends on the session and this check would read ' +
        'the file differently than Postgres does: a migration never names the setting.',
    );
  }
  return problems;
}

/** What `readConfigKeys` found: each top-level key with its line, in order, or why it stopped. */
interface IConfigScan {
  readonly keys: readonly { readonly key: string; readonly line: number }[];
  readonly problems: readonly string[];
}

const BARE_KEY = /^[A-Za-z0-9_-]+/u;

/**
 * Read the configuration as TOML, for the subset squawk's configuration uses:
 * comments, and `key = value` where the value is a string, a bare word or an
 * array of those, over as many lines as it takes. Values are skipped, not
 * interpreted: what matters is which keys the file sets, and that nothing in
 * it can be read two ways. A quoted key, a dotted key, a table header and an
 * inline table are problems, and anything the scanner cannot place ends the
 * read with one.
 */
function readConfigKeys(text: string, configFile: string): IConfigScan {
  const keys: { key: string; line: number }[] = [];
  const problems: string[] = [];
  let index = 0;
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const at = (offset: number): string => `${configFile}:${String(lineAt(offset))}`;
  const unreadable = (offset: number, what: string): IConfigScan => ({
    keys,
    problems: [...problems, `${at(offset)}: cannot be read as TOML (${what})`],
  });
  const skipBlank = (newlines: boolean): void => {
    for (;;) {
      const char = text[index];
      if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) {
        index += 1;
      } else if (char === '#') {
        while (index < text.length && text[index] !== '\n') index += 1;
      } else {
        return;
      }
    }
  };
  /** Step over a string starting at `index`; false when it never closes on its line. */
  const skipString = (): boolean => {
    const quote = text[index];
    index += 1;
    while (index < text.length && text[index] !== '\n') {
      if (quote === '"' && text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === quote) {
        index += 1;
        return true;
      }
      index += 1;
    }
    return false;
  };
  /** Step over one value; null when it is fine, else what is wrong with it. */
  const skipValue = (): string | null => {
    const char = text[index];
    if (char === '"' || char === "'") return skipString() ? null : 'a string never closes';
    if (char === '{') return 'an inline table';
    if (char === '[') {
      index += 1;
      for (;;) {
        skipBlank(true);
        if (index >= text.length) return 'an array never closes';
        if (text[index] === ']') {
          index += 1;
          return null;
        }
        const inner = skipValue();
        if (inner !== null) return inner;
        skipBlank(true);
        if (text[index] === ',') index += 1;
        else if (text[index] !== ']') return 'an array entry is not followed by , or ]';
      }
    }
    const word = /^[A-Za-z0-9_+.:-]+/u.exec(text.slice(index))?.[0];
    if (word === undefined) return 'a value is missing';
    index += word.length;
    return null;
  };

  for (;;) {
    skipBlank(true);
    if (index >= text.length) return { keys, problems };
    const start = index;
    const endOfLine = (): void => {
      while (index < text.length && text[index] !== '\n') index += 1;
    };
    if (text[index] === '[') {
      endOfLine();
      problems.push(
        `${at(start)}: a table (${text.slice(start, index).trim()}). The check expects ` +
          'top-level keys only',
      );
      continue;
    }
    let key: string | null = null;
    if (text[index] === '"' || text[index] === "'") {
      if (!skipString()) return unreadable(start, 'a quoted key never closes');
      problems.push(
        `${at(start)}: a quoted key (${text.slice(start, index)}). Squawk reads it as the key ` +
          'it spells: write a key bare, so that it can be read one way only',
      );
    } else {
      key = BARE_KEY.exec(text.slice(index))?.[0] ?? null;
      if (key === null) return unreadable(start, 'a key is expected here');
      index += key.length;
    }
    skipBlank(false);
    if (text[index] === '.') {
      endOfLine();
      problems.push(
        `${at(start)}: a dotted key (${text.slice(start, index).trim()}). The check expects ` +
          'top-level keys only',
      );
      continue;
    }
    if (text[index] !== '=') return unreadable(start, 'a key is not followed by =');
    index += 1;
    skipBlank(false);
    const wrong = skipValue();
    if (wrong !== null) return unreadable(start, wrong);
    skipBlank(false);
    if (index < text.length && text[index] !== '\n') {
      return unreadable(start, 'something follows the value on its line');
    }
    if (key !== null) keys.push({ key, line: lineAt(start) });
  }
}

/** The line a problem names, so they are reported in file order; a whole-file problem goes last. */
function lineOfProblem(problem: string): number {
  const line = /^[^:]+:(\d+):/u.exec(problem)?.[1];
  return line === undefined ? Number.MAX_SAFE_INTEGER : Number(line);
}

/**
 * What is wrong with the configuration before squawk reads it: a key it would
 * silently ignore (a misspelt setting is no setting), a key the check does not
 * expect (`excluded_paths` would take a migration out of the lint), a key
 * written so that it has to be unquoted to be recognised, a table, a key set
 * twice or missing, or a file that does not read as TOML to the end.
 */
export function squawkConfigProblems(
  text: string,
  options: Pick<ISquawkOptions, 'configFile' | 'configKeys'> = {},
): readonly string[] {
  const configFile = options.configFile ?? SQUAWK_CONFIG;
  const known = options.configKeys ?? SQUAWK_CONFIG_KEYS;
  const scan = readConfigKeys(text, configFile);
  const problems = [...scan.problems];
  const seen = new Set<string>();
  for (const { key, line } of scan.keys) {
    const where = `${configFile}:${String(line)}`;
    if (!known.includes(key)) {
      problems.push(
        `${where}: the key ${key}. The check knows ${known.join(', ')}; squawk would ` +
          'ignore a key it does not know without a word',
      );
    } else if (seen.has(key)) {
      problems.push(`${where}: the key ${key} is set twice`);
    }
    seen.add(key);
  }
  for (const key of known) {
    if (!seen.has(key)) problems.push(`${configFile}: the key ${key} is missing`);
  }
  return problems.sort((a, b) => lineOfProblem(a) - lineOfProblem(b));
}

/** One entry of `squawk --reporter json`. `line` and `column` are 0-based there. */
export interface ISquawkFinding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly message: string;
  readonly help: string | null;
}

/**
 * The findings in a JSON report, or null when `stdout` is not one: squawk
 * printed something else (a configuration error, a usage error, nothing). An
 * entry without a file, a rule and a position makes the whole report
 * unreadable, never a shorter one.
 */
export function parseSquawkReport(stdout: string): readonly ISquawkFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const findings: ISquawkFinding[] = [];
  for (const entry of parsed as readonly unknown[]) {
    if (!isRecord(entry)) return null;
    const { file, line, column, rule_name: rule, message, help } = entry;
    if (
      typeof file !== 'string' ||
      typeof rule !== 'string' ||
      typeof line !== 'number' ||
      typeof column !== 'number' ||
      typeof message !== 'string'
    ) {
      return null;
    }
    findings.push({
      file,
      line,
      column,
      rule,
      message,
      help: typeof help === 'string' ? help : null,
    });
  }
  return findings;
}

/**
 * The arguments squawk runs with, the same on both routes. Nothing but the
 * configuration file decides the rules: `--exclude` or `--pg-version` here
 * would replace what the file says instead of adding to it.
 */
export function squawkArgs(
  files: readonly string[],
  configFile: string = SQUAWK_CONFIG,
): readonly string[] {
  return ['--config', configFile, '--reporter', 'json', ...files];
}

/** `docker run` for the pinned image, with the repo mounted read-only as the working directory. */
export function squawkDockerArgs(
  root: string,
  files: readonly string[],
  options: Pick<ISquawkOptions, 'pin' | 'configFile'> = {},
): readonly string[] {
  const pin = options.pin ?? SQUAWK;
  return [
    'run',
    '--rm',
    ...(pin.platform === undefined ? [] : ['--platform', pin.platform]),
    '-v',
    `${root}:/repo:ro`,
    '-w',
    '/repo',
    pin.image,
    ...squawkArgs(files, options.configFile),
  ];
}

export function chooseSquawkRoute(
  root: string,
  files: readonly string[],
  deps: ICapturedRunDeps,
  options: Pick<ISquawkOptions, 'pin' | 'configFile'> = {},
): LinterRoute {
  const pin = options.pin ?? SQUAWK;
  return chooseToolRoute(
    pin,
    squawkArgs(files, options.configFile),
    squawkDockerArgs(root, files, options),
    deps,
    `put the squawk ${pin.version} release binary on PATH as \`squawk\``,
  );
}

export interface ISquawkDeps extends ICapturedRunDeps {
  /**
   * The folders directly under `migrationsDir` of `root`, each with whether it
   * holds `migrationFile`, or null when that directory is missing. A symbolic
   * link is listed, not followed.
   */
  readonly migrations: (
    root: string,
    migrationsDir: string,
    migrationFile: string,
  ) => readonly IMigrationDir[] | null;
  /** The text of a repo-relative file under `root`, or null when there is no such file. */
  readonly read: (root: string, file: string) => string | null;
}

function describeFinding(finding: ISquawkFinding): readonly string[] {
  const where = `${finding.file}:${String(finding.line + 1)}:${String(finding.column + 1)}`;
  const head = `${where}: ${finding.rule}: ${finding.message}`;
  return finding.help === null ? [head] : [head, `  ${finding.help}`];
}

/**
 * Select the migrations, read the configuration, refuse what squawk cannot be
 * trusted with, find the tool, lint the canaries and every migration outside
 * the baseline, and judge the run: 0 passed, 1 failed, 2 blocked
 * (`exitCodeFor`). A missing migrations directory fails, never passes.
 */
export function runSquawk(root: string, deps: ISquawkDeps, options: ISquawkOptions): IToolResult {
  const configFile = options.configFile ?? SQUAWK_CONFIG;
  const canaries = options.canaries ?? [];
  const found = deps.migrations(
    root,
    options.migrationsDir,
    options.migrationFile ?? MIGRATION_FILE,
  );
  if (found === null) {
    // Nothing to read is a failure, never a pass: the path moved, or the tree is wrong.
    return { status: 'failed', reason: `no ${options.migrationsDir} under ${root}`, lines: [] };
  }
  const selection = selectMigrations(
    found,
    (name) => squawkSha256(deps.read(root, migrationPath(name, options)) ?? ''),
    options,
  );
  const config = deps.read(root, configFile);
  const problems = [
    ...selection.problems,
    ...(config === null
      ? [`no ${configFile} under ${root}`]
      : squawkConfigProblems(config, options)),
  ];
  for (const name of selection.lint) {
    const file = migrationPath(name, options);
    const sql = deps.read(root, file) ?? '';
    problems.push(
      ...migrationProblems(file, sql, configFile),
      ...(options.inspect?.(file, sql) ?? []),
    );
  }
  if (problems.length > 0) {
    return {
      status: 'failed',
      reason: `${plural(problems.length, 'problem')} before linting: see above`,
      lines: problems,
    };
  }

  const linted = selection.lint.map((name) => migrationPath(name, options));
  const files = [...canaries.map((canary) => canary.file), ...linted];
  const route = chooseSquawkRoute(root, files, deps, options);
  const ran = runCaptured(options.pin ?? SQUAWK, route, root, deps);
  if (ran.kind === 'ended') return ran.result;
  const { run, via } = ran;
  const findings = parseSquawkReport(run.stdout);
  // 0 is a clean run and 1 a run with findings; anything else is squawk failing.
  if (findings === null || (run.code !== 0 && run.code !== 1)) {
    return unjudgeable('squawk', run, via);
  }

  const canaryFiles = new Set(canaries.map((canary) => canary.file));
  const misjudged = canaryProblems(
    'squawk',
    configFile,
    canaries,
    findings.map((finding) => ({ file: finding.file, code: finding.rule })),
  );
  const real = findings.filter((finding) => !canaryFiles.has(finding.file));
  const failed = findingsVerdict(via, real.flatMap(describeFinding), real.length, misjudged);
  if (failed !== null) return failed;
  const scope =
    linted.length === 0
      ? 'no migration outside the baseline'
      : `${plural(linted.length, 'migration')} outside the baseline clean`;
  return {
    status: 'passed',
    reason:
      `${scope}, ${String(selection.baselined)} baselined, ` +
      `${plural(canaries.length, 'canary', 'canaries')} judged as pinned, ${via}`,
    lines: [],
  };
}
