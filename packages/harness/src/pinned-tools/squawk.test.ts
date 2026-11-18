import { describe, expect, test } from 'bun:test';

import { SQUAWK } from './pins.js';
import { exitCodeFor } from './route.js';
import type { IMigrationDir, ISquawkBaseline, ISquawkDeps, ISquawkOptions } from './squawk.js';
import {
  baselineSeal,
  chooseSquawkRoute,
  findDirectives,
  migrationPath,
  migrationProblems,
  parseSquawkReport,
  runSquawk,
  selectMigrations,
  SQUAWK_CONFIG,
  SQUAWK_CONFIG_KEYS,
  squawkConfigProblems,
  squawkSha256,
} from './squawk.js';
import type { ISpawned, IToolCanary } from './tool-run.js';

const ROOT = '/work/repo';
const DIR = 'db/migrations';
const NEW = '20270101000000_order_owner';
const SQL = 'ALTER TABLE "Order" ADD COLUMN "ownerId" TEXT;\n';
const OLD = ['20260101000000_a', '20260201000000_b', '20260301000000_c'];
const CONFIG = 'pg_version = "17.0"\nassume_in_transaction = true\nexcluded_rules = []\n';
const NEW_FILE = `${DIR}/${NEW}/migration.sql`;

const CANARIES: readonly IToolCanary[] = [
  {
    file: 'checks/squawk/lock-unsafe.sql',
    codes: ['constraint-missing-not-valid', 'require-concurrent-index-creation'],
  },
  { file: 'checks/squawk/lock-safe.sql', codes: [] },
  { file: 'checks/squawk/in-transaction.sql', codes: ['require-concurrent-index-creation'] },
];

/** A baseline sealed over exactly these entries. */
function baselineOf(
  pinned: Readonly<Record<string, string>>,
  retired: Readonly<Record<string, string>> = {},
): ISquawkBaseline {
  return { pinned, retired, seal: baselineSeal(pinned, retired), source: 'db/baseline.ts' };
}

/** Three migrations, each pinned to the hash of the SQL the fake `read` hands back. */
const FAKE = baselineOf(Object.fromEntries(OLD.map((name) => [name, squawkSha256(SQL)])));

function options(overrides: Partial<ISquawkOptions> = {}): ISquawkOptions {
  return { migrationsDir: DIR, canaries: CANARIES, baseline: FAKE, ...overrides };
}

function dirs(names: readonly string[]): readonly IMigrationDir[] {
  return names.map((name) => ({ name, hasSql: true }));
}

interface IReported {
  readonly file: string;
  readonly rule: string;
  readonly line?: number;
}

/** A `--reporter json` report: every canary as pinned, plus `extra`, minus `drop`. */
function report(
  args: readonly string[],
  extra: readonly IReported[] = [],
  drop: (finding: IReported) => boolean = () => false,
): string {
  const canaries: readonly IReported[] = CANARIES.filter((canary) =>
    args.includes(canary.file),
  ).flatMap((canary) => canary.codes.map((rule) => ({ file: canary.file, rule })));
  return JSON.stringify(
    [...canaries, ...extra]
      .filter((finding) => !drop(finding))
      .map(({ file, rule, line }) => ({
        file,
        line: line ?? 0,
        column: 0,
        level: 'Warning',
        message: `message of ${rule}`,
        help: `help of ${rule}`,
        rule_name: rule,
      })),
  );
}

interface IFake extends ISquawkDeps {
  readonly calls: string[];
}

function deps(overrides: Partial<ISquawkDeps> = {}): IFake {
  const calls: string[] = [];
  return {
    calls,
    migrations: () => dirs(OLD),
    read: (_root, file) => (file === SQUAWK_CONFIG ? CONFIG : SQL),
    nativeVersion: () => null,
    dockerAvailable: () => true,
    imagePresent: () => true,
    pull: (image, platform) => {
      calls.push(`pull ${String(platform)} ${image}`);
      return true;
    },
    spawn: (command, args) => {
      calls.push([command, ...args].join(' '));
      return { code: 1, stdout: report(args), stderr: '' };
    },
    ...overrides,
  };
}

/** A spawn that answers with `answer`, recording the call like the default one does. */
function spawning(answer: (args: readonly string[]) => ISpawned, calls: string[] = []) {
  return (command: string, args: readonly string[]): ISpawned => {
    calls.push([command, ...args].join(' '));
    return answer(args);
  };
}

describe('the squawk pin', () => {
  test('pins the image by digest and both linux binaries by sha256, all at one version', () => {
    expect(SQUAWK.image).toMatch(/:[0-9.]+@sha256:[0-9a-f]{64}$/u);
    expect(SQUAWK.image).toContain(`:${SQUAWK.version}@`);
    expect(SQUAWK.platform).toBe('linux/amd64');
    for (const arch of ['x64', 'arm64'] as const) {
      const asset = SQUAWK.linux[arch];
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.path).toMatch(/^sbdchd\/squawk\/releases\/download\//u);
      expect(asset.path).toContain(`/v${SQUAWK.version}/`);
      expect(asset.member).toBeUndefined();
    }
    expect(SQUAWK.linux.x64.sha256).not.toBe(SQUAWK.linux.arm64.sha256);
  });
});

describe('squawkSha256 and migrationPath', () => {
  test('hash a file the same whatever the line endings of the checkout', () => {
    expect(squawkSha256('a;\r\nb;\r\n')).toBe(squawkSha256('a;\nb;\n'));
    expect(squawkSha256('a;\nb;\n')).not.toBe(squawkSha256('a;\nb;\nc;\n'));
  });

  test('name the file in a folder, migration.sql unless told otherwise', () => {
    expect(migrationPath(NEW, { migrationsDir: DIR })).toBe(NEW_FILE);
    expect(migrationPath(NEW, { migrationsDir: DIR, migrationFile: 'up.sql' })).toBe(
      `${DIR}/${NEW}/up.sql`,
    );
  });
});

describe('selectMigrations', () => {
  const [a = '', b = '', c = ''] = OLD;
  const hash = squawkSha256(SQL);
  const same = (): string => hash;
  const select = (
    found: readonly IMigrationDir[],
    hashOf: (name: string) => string = same,
    baseline: ISquawkBaseline = FAKE,
  ) => selectMigrations(found, hashOf, { migrationsDir: DIR, baseline });

  test('lints a migration that is not in the baseline, and not one that is', () => {
    const selection = select(dirs([...OLD, NEW]));
    expect(selection.lint).toEqual([NEW]);
    expect(selection.baselined).toBe(3);
    expect(selection.problems).toEqual([]);
  });

  test('lints every migration without a baseline', () => {
    const selection = selectMigrations(dirs([NEW, ...OLD]), same, { migrationsDir: DIR });
    expect(selection).toEqual({ lint: [...OLD, NEW], baselined: 0, problems: [] });
  });

  test('lints a new migration whose timestamp is older than every pinned one', () => {
    const backdated = '20250115000000_backdated';
    const selection = select(dirs([...OLD, backdated]));
    expect(selection.lint).toEqual([backdated]);
    expect(selection.problems).toEqual([]);
  });

  test('fails a baselined name whose folder is gone', () => {
    const selection = select(dirs([a, c]));
    expect(selection.problems).toHaveLength(1);
    expect(selection.problems[0]).toMatch(
      /pins 20260201000000_b, but .* is gone: move the entry to the retired list in db\/baseline\.ts/u,
    );
  });

  test('fails a baselined file whose content changed, and asks the hash of pinned files only', () => {
    const asked: string[] = [];
    const selection = select(dirs([...OLD, NEW]), (name) => {
      asked.push(name);
      return name === b ? squawkSha256(`${SQL}CREATE INDEX "x" ON "Order"("total");\n`) : hash;
    });
    expect(selection.problems).toHaveLength(1);
    expect(selection.problems[0]).toMatch(
      /20260201000000_b\/migration\.sql is not the file the baseline pinned/u,
    );
    expect(asked).toEqual(OLD);
  });

  test('fails a name added to the baseline, backdated or not, and still does not lint it', () => {
    for (const added of [NEW, '20250115000000_backdated']) {
      const grown = { ...FAKE, pinned: { ...FAKE.pinned, [added]: hash } };
      const selection = select(dirs([...OLD, added]), same, grown);
      expect(selection.lint).toEqual([]);
      expect(selection.problems).toHaveLength(1);
      expect(selection.problems[0]).toMatch(/db\/baseline\.ts no longer matches its seal/u);
    }
  });

  test('lets a pinned migration retire, and shows a refill that leaves the seal as it was', () => {
    const { [b]: retiring = '', ...rest } = FAKE.pinned;
    const shrunk = { ...FAKE, pinned: rest, retired: { [b]: retiring } };
    expect(select(dirs([a, c]), same, shrunk).problems).toEqual([]);
    // The count is back to three: a cap on the size would have let this through.
    const refilled = { ...shrunk, pinned: { ...rest, '20250115000000_backdated': hash } };
    const selection = select(dirs([a, c, '20250115000000_backdated']), same, refilled);
    expect(selection.problems[0]).toMatch(/no longer matches its seal/u);
    // Nor by dropping the retired entry to make room.
    const swapped = { ...refilled, retired: {} };
    expect(select(dirs([a, c, '20250115000000_backdated']), same, swapped).problems[0]).toMatch(
      /no longer matches its seal/u,
    );
  });

  test('cannot tell a list that grew together with its seal: that is a reviewer’s to catch', () => {
    // The limit of the seal, stated as a test so that nobody reads more into it:
    // the seal is in the file it seals, and whoever recomputes it is believed.
    const resealed = baselineOf({ ...FAKE.pinned, [NEW]: hash });
    const selection = select(dirs([...OLD, NEW]), same, resealed);
    expect(selection.problems).toEqual([]);
    expect(selection.lint).toEqual([]);
    expect(selection.baselined).toBe(4);
  });

  test('fails a pinned hash that was rewritten to match an edited file', () => {
    const edited = squawkSha256(`${SQL}DROP TABLE "Order";\n`);
    const repinned = { ...FAKE, pinned: { ...FAKE.pinned, [b]: edited } };
    const selection = select(dirs(OLD), (name) => (name === b ? edited : hash), repinned);
    expect(selection.problems.map((problem) => /seal/u.test(problem))).toEqual([true]);
  });

  test('fails a name that is both pinned and retired', () => {
    const both = baselineOf(FAKE.pinned, { [a]: hash });
    expect(select(dirs(OLD), same, both).problems).toEqual([
      `the baseline names ${a} as pinned and as retired`,
    ]);
  });

  test('fails a symlink in the migrations directory, new or baselined, and lints nothing through it', () => {
    const linked = select([...dirs(OLD), { name: NEW, hasSql: true, symlink: true }]);
    expect(linked.lint).toEqual([]);
    expect(linked.problems).toHaveLength(1);
    expect(linked.problems[0]).toMatch(/order_owner is a symbolic link/u);

    const [first = '', ...rest] = OLD;
    const old = select([{ name: first, hasSql: true, symlink: true }, ...dirs(rest)]);
    expect(old.problems[0]).toMatch(/20260101000000_a is a symbolic link/u);
  });

  test('fails a migration folder with no migration file instead of skipping it', () => {
    const selection = select([...dirs(OLD), { name: NEW, hasSql: false }]);
    expect(selection.lint).toEqual([]);
    expect(selection.problems[0]).toMatch(/order_owner has no migration\.sql/u);
  });
});

describe('migrationProblems', () => {
  test('fails a squawk directive by line', () => {
    const [problem] = migrationProblems(NEW_FILE, '-- squawk-ignore x\nSELECT 1;\n');
    expect(problem).toMatch(/order_owner\/migration\.sql:1: a squawk comment directive/u);
    expect(problem).toContain(SQUAWK_CONFIG);
  });

  test('fails a carriage return that is not part of a line ending, by line', () => {
    const problems = migrationProblems(
      NEW_FILE,
      'SELECT 1;\r\n-- note\rCREATE INDEX CONCURRENTLY i ON t(c);\r\n',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/migration\.sql:2: a carriage return that is not followed/u);
    // A Windows checkout of an ordinary migration has none.
    expect(migrationProblems(NEW_FILE, SQL.replaceAll('\n', '\r\n'))).toEqual([]);
  });

  test('fails a migration that names standard_conforming_strings, the setting that changes how a string ends', () => {
    const sql = ['SELECT 1;', 'SET Standard_Conforming_Strings = off;'].join('\n');
    const problems = migrationProblems(NEW_FILE, sql);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/migration\.sql:2: standard_conforming_strings/u);
  });

  test('has nothing to say about a plain migration', () => {
    expect(migrationProblems(NEW_FILE, SQL)).toEqual([]);
  });
});

describe('squawkConfigProblems', () => {
  test('accepts the three keys the check knows', () => {
    expect(squawkConfigProblems(CONFIG)).toEqual([]);
    expect(SQUAWK_CONFIG_KEYS).toEqual(['pg_version', 'assume_in_transaction', 'excluded_rules']);
  });

  test('takes another set of keys and another file name', () => {
    expect(
      squawkConfigProblems('pg_version = "17.0"\n', {
        configFile: 'lint/squawk.toml',
        configKeys: ['pg_version', 'excluded_rules'],
      }),
    ).toEqual(['lint/squawk.toml: the key excluded_rules is missing']);
  });

  test('fails a key squawk would ignore, indented or not, and a known key the check does not expect', () => {
    for (const line of [
      'excluded_rulez = ["x"]',
      '  assume_in_transactions = false',
      '\texcluded_paths = ["*.sql"]',
      'included_rules = ["require-table-schema"]',
    ]) {
      const problems = squawkConfigProblems(`${line}\n${CONFIG}`);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^\.squawk\.toml:1: the key /u);
    }
  });

  test('fails a table, a missing key and a key that is only in a comment', () => {
    expect(squawkConfigProblems(`${CONFIG}[upload_to_github]\n`)[0]).toMatch(/:4: a table/u);
    expect(squawkConfigProblems('pg_version = "17.0"\nexcluded_rules = []\n')).toEqual([
      '.squawk.toml: the key assume_in_transaction is missing',
    ]);
    expect(
      squawkConfigProblems(
        'pg_version = "17.0"\n# assume_in_transaction = true\nexcluded_rules = []\n',
      ),
    ).toEqual(['.squawk.toml: the key assume_in_transaction is missing']);
  });

  test('fails a quoted key, basic or literal: squawk reads it as the key it spells', () => {
    for (const line of [
      '\'excluded_paths\' = ["*.sql"]',
      '"excluded_paths" = ["*.sql"]',
      '  \'pg_version\' = "17.0"',
    ]) {
      const problems = squawkConfigProblems(`${line}\n${CONFIG}`);
      expect(problems.length).toBeGreaterThanOrEqual(1);
      expect(problems[0]).toMatch(/^\.squawk\.toml:1: a quoted key/u);
    }
    expect(squawkConfigProblems(`'never closed\n${CONFIG}`)[0]).toMatch(
      /a quoted key never closes/u,
    );
  });

  test('fails every kind of table header, quoted names included, and a dotted key', () => {
    for (const line of [
      '[upload_to_github]',
      '["upload_to_github"]',
      "['upload_to_github']",
      '[[excluded]]',
      '  [ upload_to_github ]',
    ]) {
      expect(squawkConfigProblems(`${CONFIG}${line}\n`)[0]).toMatch(/:4: a table/u);
    }
    expect(
      squawkConfigProblems(`${CONFIG}upload_to_github.fail_on_violations = false\n`)[0],
    ).toMatch(/:4: a dotted key/u);
  });

  test('fails a key set twice, and a file it cannot read to the end', () => {
    expect(squawkConfigProblems(`${CONFIG}pg_version = "16.0"\n`)[0]).toMatch(
      /:4: the key pg_version is set twice/u,
    );
    for (const text of [
      'pg_version = "17.0\n',
      'pg_version = "17.0"\nassume_in_transaction = true\nexcluded_rules = [\n  "a",\n',
      `${CONFIG}pg_version\n`,
      `${CONFIG}x = { a = 1 }\n`,
      `${CONFIG}x = 1 2\n`,
      `${CONFIG}x = ["a" "b"]\n`,
      `${CONFIG}x =\n`,
      `${CONFIG}= 1\n`,
    ]) {
      expect(squawkConfigProblems(text)[0]).toMatch(/cannot be read/u);
    }
  });

  test('is not fooled by a key-shaped line inside a list or a string', () => {
    const text = [
      'pg_version = "17.0" # trailing = comment',
      'assume_in_transaction = true',
      'excluded_rules = [',
      "  'excluded_paths = 1', # a value, however it looks",
      '  "a = b \\" c",',
      '  [ "nested" ],',
      ']',
    ].join('\n');
    expect(squawkConfigProblems(text)).toEqual([]);
  });

  test('reads the rules inside the list as values, not as keys', () => {
    const text =
      'pg_version = "17.0"\nassume_in_transaction = true\nexcluded_rules = [\n  # why = because\n  "ban-drop-column",\n]\n';
    expect(squawkConfigProblems(text)).toEqual([]);
  });
});

describe('findDirectives', () => {
  test('finds every spelling of a squawk directive, by line', () => {
    const sql = [
      '-- squawk-ignore ban-drop-column',
      'ALTER TABLE "E" DROP COLUMN "x";',
      '/* SQUAWK-IGNORE-FILE */',
      '-- squawk-disable-assume-in-transaction',
      "SELECT 'squawk-ignore';",
    ].join('\r\n');
    expect(findDirectives(sql)).toEqual([1, 3, 4, 5]);
  });

  test('finds nothing in a migration that only mentions the tool', () => {
    expect(findDirectives('-- written so that squawk passes\nSELECT 1;\n')).toEqual([]);
  });
});

describe('parseSquawkReport', () => {
  test('reads the findings of a JSON report, and an empty one as no findings', () => {
    expect(parseSquawkReport('[]')).toEqual([]);
    const [finding] =
      parseSquawkReport(report([], [{ file: 'a.sql', rule: 'ban-char-field' }])) ?? [];
    expect(finding).toEqual({
      file: 'a.sql',
      line: 0,
      column: 0,
      rule: 'ban-char-field',
      message: 'message of ban-char-field',
      help: 'help of ban-char-field',
    });
    const [bare] =
      parseSquawkReport('[{"file":"a.sql","line":0,"column":0,"message":"m","rule_name":"r"}]') ??
      [];
    expect(bare?.help).toBeNull();
  });

  test('is unreadable, never empty, for anything that is not a report', () => {
    for (const text of ['', 'Configuration error: invalid rule name', '{"a":1}', '[1]', '[{}]']) {
      expect(parseSquawkReport(text)).toBeNull();
    }
    expect(parseSquawkReport('[{"file":"a.sql","line":0,"column":0,"message":"m"}]')).toBeNull();
  });
});

describe('chooseSquawkRoute', () => {
  const files = [NEW_FILE];

  test('runs a native squawk that reports exactly the pinned version, with the configuration file', () => {
    const route = chooseSquawkRoute(ROOT, files, deps({ nativeVersion: () => SQUAWK.version }));
    expect(route.kind === 'native' ? [route.command, ...route.args] : []).toEqual([
      'squawk',
      '--config',
      SQUAWK_CONFIG,
      '--reporter',
      'json',
      ...files,
    ]);
  });

  test('refuses a native squawk of another version and takes the pinned image', () => {
    const route = chooseSquawkRoute(ROOT, files, deps({ nativeVersion: () => '2.68.0' }), {
      configFile: 'lint/squawk.toml',
    });
    expect(route.kind).toBe('docker');
    const args = route.kind === 'docker' ? route.args : [];
    expect(args).toEqual([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-v',
      `${ROOT}:/repo:ro`,
      '-w',
      '/repo',
      SQUAWK.image,
      '--config',
      'lint/squawk.toml',
      '--reporter',
      'json',
      ...files,
    ]);
  });

  test('never decides a rule on the command line, where a flag replaces the config file', () => {
    for (const nativeVersion of [() => SQUAWK.version, () => null]) {
      const route = chooseSquawkRoute(ROOT, files, deps({ nativeVersion }));
      const args = route.kind === 'blocked' ? ['--exclude'] : route.args;
      for (const flag of ['--exclude', '--include', '--pg-version', '--exclude-path']) {
        expect(args.some((arg) => arg.startsWith(flag))).toBe(false);
      }
      expect(args.some((arg) => arg.includes('assume-in-transaction'))).toBe(false);
    }
  });

  test('is blocked, naming what is missing, with neither the pinned binary nor Docker', () => {
    const none = chooseSquawkRoute(ROOT, files, deps({ dockerAvailable: () => false }));
    expect(none.kind === 'blocked' ? none.reason : '').toMatch(/^no native squawk, and no Docker/u);
    const other = chooseSquawkRoute(
      ROOT,
      files,
      deps({ nativeVersion: () => '2.68.0', dockerAvailable: () => false }),
    );
    expect(other.kind === 'blocked' ? other.reason : '').toMatch(
      /native squawk 2\.68\.0 is not the pinned 2\.67\.0.*release binary on PATH/u,
    );
  });
});

describe('runSquawk', () => {
  test('passes a tree with nothing outside the baseline, having judged every canary', () => {
    const run = deps();
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('passed');
    expect(result.reason).toBe(
      'no migration outside the baseline, 3 baselined, 3 canaries judged as pinned, pinned image',
    );
    expect(run.calls).toHaveLength(1);
    for (const canary of CANARIES) expect(run.calls[0]).toContain(canary.file);
  });

  test('hands squawk a migration that is not in the baseline, and none that is', () => {
    const run = deps({ migrations: () => dirs([...OLD, NEW]) });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('passed');
    expect(result.reason).toMatch(/^1 migration outside the baseline clean, 3 baselined/u);
    expect(run.calls[0]?.endsWith(` ${NEW_FILE}`)).toBe(true);
    for (const name of OLD) expect(run.calls[0]).not.toContain(`${DIR}/${name}/`);
  });

  test('asks the deps for the migrations directory and file it was given', () => {
    const asked: string[] = [];
    runSquawk(
      ROOT,
      deps({
        migrations: (root, dir, file) => {
          asked.push(`${root} ${dir} ${file}`);
          return dirs(OLD);
        },
      }),
      options({ migrationFile: 'up.sql' }),
    );
    expect(asked).toEqual([`${ROOT} ${DIR} up.sql`]);
  });

  test('fails, exit 1, a new migration with a lock-unsafe statement, and says where', () => {
    const run = deps({
      migrations: () => dirs([...OLD, NEW]),
      nativeVersion: () => SQUAWK.version,
      spawn: spawning((args) => ({
        code: 1,
        stdout: report(args, [
          { file: NEW_FILE, rule: 'require-concurrent-index-creation', line: 4 },
        ]),
        stderr: '',
      })),
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(exitCodeFor(result.status)).toBe(1);
    expect(result.reason).toBe('1 finding, native: see above');
    expect(result.lines).toEqual([
      `${NEW_FILE}:5:1: require-concurrent-index-creation: message of require-concurrent-index-creation`,
      '  help of require-concurrent-index-creation',
    ]);
  });

  test('fails a baselined name with no folder, and runs nothing', () => {
    const run = deps({ migrations: () => dirs(OLD.slice(1)) });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('1 problem before linting: see above');
    expect(result.lines[0]).toMatch(/pins 20260101000000_a, but .* is gone/u);
    expect(run.calls).toEqual([]);
  });

  test('fails a squawk-ignore comment in a new migration, and runs nothing', () => {
    const run = deps({
      migrations: () => dirs([...OLD, NEW]),
      read: (_root, file) =>
        file === NEW_FILE
          ? '-- squawk-ignore require-concurrent-index-creation\nCREATE INDEX "x" ON "E"("y");\n'
          : file === SQUAWK_CONFIG
            ? CONFIG
            : SQL,
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.lines[0]).toMatch(/order_owner\/migration\.sql:1: a squawk comment/u);
    expect(run.calls).toEqual([]);
  });

  test('fails what the repo inspects for in a new migration, and runs nothing', () => {
    const seen: string[] = [];
    const run = deps({ migrations: () => dirs([...OLD, NEW]) });
    const result = runSquawk(
      ROOT,
      run,
      options({
        inspect: (file, sql) => {
          seen.push(file);
          return sql.includes('ADD COLUMN') ? [`${file}:1: the repo refuses this`] : [];
        },
      }),
    );
    expect(seen).toEqual([NEW_FILE]);
    expect(result.status).toBe('failed');
    expect(result.lines).toEqual([`${NEW_FILE}:1: the repo refuses this`]);
    expect(run.calls).toEqual([]);
  });

  test('fails SQL appended to a baselined migration, and runs nothing', () => {
    const edited = migrationPath(OLD[1] ?? '', { migrationsDir: DIR });
    const run = deps({
      read: (_root, file) =>
        file === SQUAWK_CONFIG
          ? CONFIG
          : file === edited
            ? `${SQL}CREATE INDEX "Order_sneaky_idx" ON "Order"("total");\n`
            : SQL,
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('1 problem before linting: see above');
    expect(result.lines[0]).toMatch(/20260201000000_b\/migration\.sql is not the file/u);
    expect(run.calls).toEqual([]);
  });

  test('fails a baseline that grew, however the tree looks, and runs nothing', () => {
    const grown = { ...FAKE, pinned: { ...FAKE.pinned, [NEW]: squawkSha256(SQL) } };
    const run = deps({ migrations: () => dirs([...OLD, NEW]) });
    const result = runSquawk(ROOT, run, options({ baseline: grown }));
    expect(result.status).toBe('failed');
    expect(result.lines[0]).toMatch(/no longer matches its seal/u);
    expect(run.calls).toEqual([]);
  });

  test('fails a configuration key squawk would ignore, and a tree with no configuration', () => {
    const misspelt = deps({
      read: (_root, file) => (file === SQUAWK_CONFIG ? `  excluded_pathz = ["x"]\n${CONFIG}` : SQL),
    });
    const result = runSquawk(ROOT, misspelt, options());
    expect(result.status).toBe('failed');
    expect(result.lines[0]).toMatch(/\.squawk\.toml:1: the key excluded_pathz/u);
    expect(misspelt.calls).toEqual([]);

    const none = deps({ read: (_root, file) => (file === SQUAWK_CONFIG ? null : SQL) });
    expect(runSquawk(ROOT, none, options()).lines).toEqual([`no ${SQUAWK_CONFIG} under ${ROOT}`]);
    expect(none.calls).toEqual([]);
  });

  test('fails a tree with no migrations directory instead of passing it', () => {
    const run = deps({ migrations: () => null });
    expect(runSquawk(ROOT, run, options()).status).toBe('failed');
    expect(run.calls).toEqual([]);
  });

  test('is blocked, exits 2 and runs nothing with neither the pinned binary nor Docker', () => {
    const run = deps({ dockerAvailable: () => false });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('blocked');
    expect(exitCodeFor(result.status)).toBe(2);
    expect(run.calls).toEqual([]);
  });

  test('pulls a missing image for its platform before running it, and is blocked when it cannot', () => {
    const pulled = deps({ imagePresent: () => false });
    expect(runSquawk(ROOT, pulled, options()).status).toBe('passed');
    // Without the platform an arm64 host asks for an arm64 image, and there is none.
    expect(pulled.calls[0]).toBe(`pull linux/amd64 ${SQUAWK.image}`);
    expect(pulled.calls[1]).toMatch(/^docker run --rm/u);

    const offline = deps({ imagePresent: () => false, pull: () => false });
    expect(runSquawk(ROOT, offline, options()).status).toBe('blocked');
    expect(offline.calls).toEqual([]);
  });

  test('is blocked when the tool could not be started', () => {
    const run = deps({
      nativeVersion: () => SQUAWK.version,
      spawn: () => ({ code: null, stdout: '', stderr: '' }),
    });
    expect(runSquawk(ROOT, run, options()).reason).toBe('squawk could not be started');
  });

  test('reads docker’s own 125 as blocked, and the same code from a native run as failed', () => {
    const answer = (): ISpawned => ({ code: 125, stdout: '', stderr: 'docker: daemon gone' });
    expect(runSquawk(ROOT, deps({ spawn: spawning(answer) }), options()).status).toBe('blocked');
    const native = deps({ nativeVersion: () => SQUAWK.version, spawn: spawning(answer) });
    expect(runSquawk(ROOT, native, options()).status).toBe('failed');
  });

  test('fails a run that left no report: a configuration error is not a clean run', () => {
    const run = deps({
      spawn: spawning(() => ({
        code: 1,
        stdout: '',
        stderr: 'Configuration error: invalid rule name nope for key `excluded_rules`',
      })),
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/exited 1 without a report/u);
    expect(result.lines).toEqual([
      'Configuration error: invalid rule name nope for key `excluded_rules`',
    ]);
  });

  test('fails an exit code that is neither clean nor findings, whatever was printed', () => {
    const run = deps({
      spawn: spawning((args) => ({ code: 2, stdout: report(args), stderr: '' })),
    });
    expect(runSquawk(ROOT, run, options()).status).toBe('failed');
  });

  test('fails when a canary is no longer reported: a rule turned off in the config', () => {
    const run = deps({
      spawn: spawning((args) => ({
        code: 1,
        stdout: report(args, [], (f) => f.rule === 'require-concurrent-index-creation'),
        stderr: '',
      })),
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('2 canary problems, pinned image: see above');
    expect(result.lines[0]).toMatch(/lock-unsafe\.sql: squawk reported \[constraint-missing/u);
    expect(result.lines[0]).toMatch(/expects \[.*require-concurrent-index-creation.*\]/u);
    expect(result.lines[1]).toMatch(/in-transaction\.sql: squawk reported \[\]/u);
  });

  test('fails when squawk reports nothing at all, canaries included', () => {
    const run = deps({ spawn: spawning(() => ({ code: 0, stdout: '[]', stderr: '' })) });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('2 canary problems, pinned image: see above');
  });

  test('fails when a canary that must be clean is reported: a rule the config meant to turn off', () => {
    const run = deps({
      spawn: spawning((args) => ({
        code: 1,
        stdout: report(args, [
          { file: 'checks/squawk/lock-safe.sql', rule: 'prefer-timestamp-tz' },
        ]),
        stderr: '',
      })),
    });
    const result = runSquawk(ROOT, run, options());
    expect(result.status).toBe('failed');
    expect(result.lines[0]).toMatch(/lock-safe\.sql: squawk reported \[prefer-timestamp-tz\]/u);
  });
});
