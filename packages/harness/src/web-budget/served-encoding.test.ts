import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, test } from 'bun:test';

import { brotliBytes } from './precompress.js';
import {
  BROWSER_BEHIND_PROXY,
  describeEncoding,
  parseServedEncoding,
  SERVED_MIME_TYPES,
  servedCompressible,
  servedMimeType,
  servedSize,
  servedVary,
} from './served-encoding.js';

const server = (body: string): string => `server {\n${body}\n    location / {\n    }\n}\n`;

const GENERATED = '/run/web/generated.conf';
const FEED = 'location = /feed.xml';

/** A full configuration of the kind a static web image ships. */
const SITE_CONF = `# a static site behind a proxy
include ${GENERATED};

server {
    listen 8080;
    root /usr/share/nginx/html;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 20;
    gzip_types text/css application/javascript application/json image/svg+xml;
    brotli_static on;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'" always;

    location = /runtime.js {
        brotli_static off;
        add_header Cache-Control "no-store";
    }

    ${FEED} {
        types { application/atom+xml xml; }
        default_type application/atom+xml;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;

const GZIP_6 = parseServedEncoding(
  server(
    'gzip on;\ngzip_proxied any;\ngzip_comp_level 6;\ngzip_types text/css application/javascript;',
  ),
);

/** Text a compressor can shrink, `length` bytes long. */
function script(length: number): Buffer {
  return Buffer.from(
    'export const value = "a row of the module";\n'.repeat(length).slice(0, length),
  );
}

describe('parseServedEncoding', () => {
  test('reads a full site configuration, with its allowed include and types location', () => {
    const encoding = parseServedEncoding(SITE_CONF, {
      allowedIncludes: [GENERATED],
      typesLocations: [FEED],
    });
    expect(encoding).toEqual({
      gzip: true,
      level: 6,
      minLength: 20,
      vary: true,
      proxied: 'any',
      brotliStatic: true,
      brotliOffPaths: ['/runtime.js'],
      types: [
        'text/html',
        'text/css',
        'application/javascript',
        'application/json',
        'image/svg+xml',
      ],
      mimeTypes: SERVED_MIME_TYPES,
    });
  });

  test("falls back to nginx's own defaults for what the configuration leaves out", () => {
    expect(parseServedEncoding(server('gzip on;'))).toEqual({
      gzip: true,
      level: 1,
      minLength: 20,
      types: ['text/html'],
      vary: false,
      proxied: 'off',
      brotliStatic: false,
      brotliOffPaths: [],
      mimeTypes: SERVED_MIME_TYPES,
    });
    expect(parseServedEncoding(server('listen 8080;')).gzip).toBe(false);
    expect(parseServedEncoding(server('gzip off;\ngzip_comp_level 9;')).gzip).toBe(false);
  });

  test('ignores a directive that is commented out', () => {
    expect(parseServedEncoding(server('gzip on;\n# gzip_comp_level 9;')).level).toBe(1);
  });

  test('refuses a compression directive it has no model for', () => {
    for (const directive of [
      'gzip_static on;',
      'brotli on;',
      'gunzip on;',
      'gzip_buffers 16 8k;',
      'zstd on;',
    ]) {
      expect(() => parseServedEncoding(server(`gzip on;\n${directive}`))).toThrow(
        'do not know how',
      );
    }
  });

  test('reads gzip_vary and gzip_proxied, and refuses a value of either it has no model for', () => {
    const read = (body: string) => parseServedEncoding(server(`gzip on;\n${body}`));
    expect(read('gzip_vary on;').vary).toBe(true);
    expect(read('gzip_vary off;').vary).toBe(false);
    expect(read('gzip_proxied any;').proxied).toBe('any');
    expect(read('gzip_proxied off;').proxied).toBe('off');
    expect(() => read('gzip_vary sometimes;')).toThrow('gzip_vary sometimes is neither on nor off');
    // These compress by what the RESPONSE says, so the answer for a file
    // depends on headers the model does not see: it never guesses.
    for (const value of ['expired no-cache', 'no-store', 'private auth', 'any off']) {
      expect(() => read(`gzip_proxied ${value};`)).toThrow('is neither any nor off');
    }
  });

  test('reads brotli_static, and refuses a value it has no model for', () => {
    const read = (body: string) => parseServedEncoding(server(`gzip on;\n${body}`));
    expect(read('brotli_static on;').brotliStatic).toBe(true);
    expect(read('brotli_static off;').brotliStatic).toBe(false);
    expect(read('').brotliStatic).toBe(false);
    expect(() => read('brotli_static always;')).toThrow(
      'brotli_static always is neither on nor off',
    );
  });

  test('refuses compression set inside a location, where the budgets do not look', () => {
    expect(() =>
      parseServedEncoding('server {\n gzip on;\n location /assets {\n gzip off;\n }\n}\n'),
    ).toThrow('sits in "location /assets"');
  });

  test('refuses an include that is not allowed, anywhere in the configuration', () => {
    expect(() => parseServedEncoding(server('gzip on;\ninclude extra.conf;'))).toThrow(
      'include extra.conf brings in directives the bundle budgets cannot read',
    );
    expect(() =>
      parseServedEncoding(`include /etc/nginx/conf.d/gzip.conf;\n${server('gzip on;')}`),
    ).toThrow('cannot read');
  });

  test('accepts an allowed include once, outside every block', () => {
    const options = { allowedIncludes: [GENERATED] };
    expect(parseServedEncoding(`include ${GENERATED};\n${server('gzip on;')}`, options).gzip).toBe(
      true,
    );
    expect(() => parseServedEncoding(server(`gzip on;\ninclude ${GENERATED};`), options)).toThrow(
      `include ${GENERATED} sits in "server"`,
    );
    expect(() =>
      parseServedEncoding(
        `server {\n gzip on;\n location /assets {\n include ${GENERATED};\n }\n}\n`,
        options,
      ),
    ).toThrow('sits in "location /assets"');
    expect(() =>
      parseServedEncoding(
        `include ${GENERATED};\ninclude ${GENERATED};\n${server('gzip on;')}`,
        options,
      ),
    ).toThrow(`include ${GENERATED} is written twice`);
  });

  test('refuses a types block that could change the Content-Type of a bundle file', () => {
    for (const conf of [
      server('gzip on;\ntypes {\n text/plain js;\n}'),
      'types {\n text/plain js;\n}\nserver {\n gzip on;\n}\n',
      'server {\n gzip on;\n location /assets {\n types { }\n }\n}\n',
      'server {\n gzip on;\n location ~ \\.js$ {\n types { }\n }\n}\n',
      'server {\n gzip on;\n location = /assets/index-abc.js {\n types { }\n }\n}\n',
      'server {\n gzip on;\n location = /feed.xml.js {\n types { }\n }\n}\n',
    ]) {
      expect(() => parseServedEncoding(conf, { typesLocations: [FEED] })).toThrow(
        'a types block in ',
      );
    }
  });

  test('accepts one types block in an allowed location, and refuses a second', () => {
    const one = `server {\n gzip on;\n ${FEED} {\n types { }\n }\n}\n`;
    expect(parseServedEncoding(one, { typesLocations: [FEED] }).gzip).toBe(true);
    const two = `server {\n gzip on;\n ${FEED} {\n types { }\n types { }\n }\n}\n`;
    expect(() => parseServedEncoding(two, { typesLocations: [FEED] })).toThrow(
      'a second types block in ',
    );
  });

  test('refuses a directive set twice and a value that is not one', () => {
    expect(() => parseServedEncoding(server('gzip on;\ngzip on;'))).toThrow('set twice');
    expect(() => parseServedEncoding(server('gzip maybe;'))).toThrow('neither on nor off');
    expect(() => parseServedEncoding(server('gzip_comp_level six;'))).toThrow('not a whole number');
    expect(() => parseServedEncoding(server('gzip_comp_level 12;'))).toThrow('outside 1 to 9');
    expect(() => parseServedEncoding(server('gzip_comp_level 0;'))).toThrow('outside 1 to 9');
    expect(() => parseServedEncoding(server('gzip_min_length 1 2;'))).toThrow('takes one value');
    expect(() => parseServedEncoding(server('gzip;'))).toThrow('takes one value');
  });
});

describe('servedSize', () => {
  test('weighs a script as gzip at the configured level, and the bytes are that file', () => {
    const body = script(4000);
    const served = servedSize(GZIP_6, 'assets/index-abc.js', body);
    expect(served).toEqual({ bytes: gzipSync(body, { level: 6 }).length, encoding: 'gzip' });
    expect(gunzipSync(gzipSync(body, { level: 6 })).equals(body)).toBe(true);
    expect(served.bytes).toBeLessThan(body.length);
  });

  test('follows the level: a lower one weighs more', () => {
    const body = script(40_000);
    const levelOne = parseServedEncoding(server('gzip on;\ngzip_types application/javascript;'));
    const near = { viaProxy: false, acceptsBrotli: false };
    expect(servedSize(levelOne, 'a.js', body, near).bytes).toBeGreaterThan(
      servedSize(GZIP_6, 'a.js', body).bytes,
    );
  });

  test('sends a file under the length floor as it is, and one at the floor compressed', () => {
    const floor = parseServedEncoding(
      server(
        'gzip on;\ngzip_proxied any;\ngzip_min_length 1024;\ngzip_types application/javascript;',
      ),
    );
    expect(servedSize(floor, 'a.js', script(1023))).toEqual({ bytes: 1023, encoding: 'identity' });
    expect(servedSize(floor, 'a.js', script(1024)).encoding).toBe('gzip');
  });

  test('sends a type the configuration does not list as it is', () => {
    const cssOnly = parseServedEncoding(
      server('gzip on;\ngzip_proxied any;\ngzip_types text/css;'),
    );
    expect(servedSize(cssOnly, 'a.js', script(4000))).toEqual({
      bytes: 4000,
      encoding: 'identity',
    });
    expect(servedSize(cssOnly, 'a.css', script(4000)).encoding).toBe('gzip');
    expect(servedSize(cssOnly, 'index.html', script(4000)).encoding).toBe('gzip');
  });

  test('sends everything as it is when gzip is off', () => {
    const off = parseServedEncoding(server('gzip off;'));
    expect(servedSize(off, 'a.js', script(4000))).toEqual({ bytes: 4000, encoding: 'identity' });
  });

  test('weighs a request that went through a proxy as the configuration treats it', () => {
    const body = script(4000);
    const any = parseServedEncoding(
      server('gzip on;\ngzip_proxied any;\ngzip_types application/javascript;'),
    );
    const off = parseServedEncoding(
      server('gzip on;\ngzip_proxied off;\ngzip_types application/javascript;'),
    );
    // `off` is nginx's default: a request that carries a Via header is sent
    // as it is, so a budget that assumed gzip would weigh bytes a proxied
    // browser never gets.
    expect(servedSize(any, 'a.js', body, { viaProxy: true, acceptsBrotli: true }).encoding).toBe(
      'gzip',
    );
    expect(servedSize(any, 'a.js', body, { viaProxy: false, acceptsBrotli: true }).encoding).toBe(
      'gzip',
    );
    expect(servedSize(off, 'a.js', body, { viaProxy: true, acceptsBrotli: true })).toEqual({
      bytes: 4000,
      encoding: 'identity',
    });
    expect(servedSize(off, 'a.js', body, { viaProxy: false, acceptsBrotli: true }).encoding).toBe(
      'gzip',
    );
    // The budgets weigh the browser behind a proxy unless told otherwise.
    expect(servedSize(off, 'a.js', body).encoding).toBe('identity');
    expect(servedSize(any, 'a.js', body).encoding).toBe('gzip');
  });

  describe('with brotli_static', () => {
    const brotli = parseServedEncoding(
      server(
        'gzip on;\ngzip_proxied any;\ngzip_vary on;\nbrotli_static on;\ngzip_types application/javascript text/css;',
      ),
    );
    const browser = { viaProxy: false, acceptsBrotli: true };
    const gzipOnly = { viaProxy: false, acceptsBrotli: false };

    test('weighs a file as the .br copy the precompress step writes when the client accepts br', () => {
      const body = script(4000);
      const served = servedSize(brotli, 'assets/index-abc.js', body, browser);
      expect(served).toEqual({ bytes: brotliBytes(body).length, encoding: 'br' });
      expect(brotliDecompressSync(brotliBytes(body)).equals(body)).toBe(true);
      expect(served.bytes).toBeLessThan(gzipSync(body, { level: 1 }).length);
    });

    test('falls back to gzip for a client that does not accept br', () => {
      const body = script(4000);
      expect(servedSize(brotli, 'a.js', body, gzipOnly)).toEqual({
        bytes: gzipSync(body, { level: 1 }).length,
        encoding: 'gzip',
      });
    });

    test('sends a client that accepts br a file with no copy as it is: the module stands gzip down', () => {
      const never = { never: ['runtime.js'] };
      expect(servedSize(brotli, 'runtime.js', script(4000), browser, never)).toEqual({
        bytes: 4000,
        encoding: 'identity',
      });
      expect(servedSize(brotli, 'a.js', script(10), browser).encoding).toBe('identity');
      expect(servedSize(brotli, 'runtime.js', script(4000), gzipOnly, never).encoding).toBe('gzip');
    });

    test('applies gzip as usual to a file served from a location with brotli_static off', () => {
      const off = parseServedEncoding(
        'server {\n gzip on;\n gzip_proxied any;\n brotli_static on;\n gzip_types application/javascript;\n' +
          ' location = /runtime.js {\n brotli_static off;\n }\n}\n',
      );
      expect(off.brotliOffPaths).toEqual(['/runtime.js']);
      expect(servedSize(off, 'runtime.js', script(4000), browser).encoding).toBe('gzip');
      expect(servedSize(off, '.\\runtime.js', script(4000), browser).encoding).toBe('gzip');
      expect(servedSize(off, 'a.js', script(4000), browser).encoding).toBe('br');
      expect(servedVary(off, 'runtime.js', script(4000))).toBe(false);
      const withVary = parseServedEncoding(
        'server {\n gzip on;\n gzip_vary on;\n brotli_static on;\n gzip_types application/javascript;\n' +
          ' location = /runtime.js {\n brotli_static off;\n }\n}\n',
      );
      expect(servedVary(withVary, 'runtime.js', script(4000))).toBe(true);
    });

    test('refuses brotli_static anywhere but the server block and an exact-match location set off', () => {
      for (const block of [
        'location /assets {\n brotli_static off;\n }',
        'location = /runtime.js {\n brotli_static on;\n }',
        'location ~ \\.js$ {\n brotli_static off;\n }',
      ]) {
        expect(() =>
          parseServedEncoding(`server {\n gzip on;\n brotli_static on;\n ${block}\n}\n`),
        ).toThrow(/ sits in /u);
      }
    });

    test('ignores gzip_proxied for br, which the module does not read, and applies it to gzip', () => {
      const off = parseServedEncoding(
        server(
          'gzip on;\ngzip_proxied off;\nbrotli_static on;\ngzip_types application/javascript;',
        ),
      );
      expect(
        servedSize(off, 'a.js', script(4000), { viaProxy: true, acceptsBrotli: true }).encoding,
      ).toBe('br');
      expect(
        servedSize(off, 'a.js', script(4000), { viaProxy: true, acceptsBrotli: false }).encoding,
      ).toBe('identity');
      const any = parseServedEncoding(
        server(
          'gzip on;\ngzip_proxied any;\nbrotli_static on;\ngzip_types application/javascript;',
        ),
      );
      expect(
        servedSize(any, 'a.js', script(4000), { viaProxy: true, acceptsBrotli: false }).encoding,
      ).toBe('gzip');
    });

    test('weighs the browser behind a proxy as brotli by default', () => {
      expect(BROWSER_BEHIND_PROXY.acceptsBrotli).toBe(true);
      expect(servedSize(brotli, 'a.js', script(4000)).encoding).toBe('br');
    });

    test('adds Vary to a precompressed response, as to a gzip one', () => {
      expect(servedVary(brotli, 'a.js', script(4000))).toBe(true);
    });
  });

  test('takes every Content-Type from the one table, which is an option', () => {
    for (const [extension, type] of Object.entries(SERVED_MIME_TYPES)) {
      expect(servedMimeType(`assets/index-a.${extension}`)).toBe(type);
    }
    expect(servedMimeType('a.mjs', { mjs: 'text/javascript' })).toBe('text/javascript');
    const mjs = parseServedEncoding(
      server('gzip on;\ngzip_proxied any;\ngzip_types text/javascript;'),
      {
        mimeTypes: { mjs: 'text/javascript' },
      },
    );
    expect(servedSize(mjs, 'a.mjs', script(4000)).encoding).toBe('gzip');
  });

  test('refuses a kind of file it does not know the Content-Type of', () => {
    expect(() => servedMimeType('assets/font.woff2')).toThrow('do not know how the server serves');
    expect(() => servedMimeType('assets/constructor')).toThrow('do not know how the server serves');
    expect(servedMimeType('C:\\dist\\assets\\index-a.js')).toBe('application/javascript');
  });
});

describe('servedVary', () => {
  const vary = (extra: string) =>
    parseServedEncoding(server(`gzip on;\ngzip_types application/javascript;\n${extra}`));

  test('adds Vary to what the server may compress, whether or not this client got it compressed', () => {
    const on = vary('gzip_vary on;');
    expect(servedCompressible(on, 'a.js', script(4000))).toBe(true);
    expect(servedVary(on, 'a.js', script(4000))).toBe(true);
    expect(servedVary(on, 'a.js', script(10))).toBe(false);
    expect(servedVary(on, 'a.css', script(4000))).toBe(false);
  });

  test('is off without gzip_vary, and with gzip off', () => {
    expect(servedCompressible(vary(''), 'a.js', script(4000))).toBe(true);
    expect(servedVary(vary(''), 'a.js', script(4000))).toBe(false);
    expect(
      servedVary(parseServedEncoding(server('gzip off;\ngzip_vary on;')), 'a.js', script(4000)),
    ).toBe(false);
  });
});

describe('describeEncoding', () => {
  test('names the encoding a budget prints', () => {
    expect(describeEncoding(GZIP_6)).toBe('gzip level 6');
    expect(describeEncoding(parseServedEncoding(server('gzip on;\ngzip_comp_level 6;')))).toBe(
      'gzip level 6, not for a request through a proxy (gzip_proxied off)',
    );
    expect(
      describeEncoding(
        parseServedEncoding(
          server('gzip on;\ngzip_proxied any;\ngzip_comp_level 6;\nbrotli_static on;'),
        ),
      ),
    ).toBe('brotli quality 11 (precompressed), gzip level 6');
    expect(describeEncoding(parseServedEncoding(server('gzip off;')))).toBe('no compression');
  });
});
