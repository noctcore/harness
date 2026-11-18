import { describe, expect, test } from 'bun:test';

import { nginxStatements } from './nginx-conf.js';

describe('nginxStatements', () => {
  test('lists every directive with its arguments and the block it sits in, at any depth', () => {
    const conf = `include /run/a.conf;
server {
    listen 8080;
    location = /feed.xml {
        types { application/atom+xml xml; }
        default_type application/atom+xml;
    }
    gzip on;
}
`;
    expect(nginxStatements(conf)).toEqual([
      { block: '', words: ['include', '/run/a.conf'] },
      { block: '', words: ['server'] },
      { block: 'server', words: ['listen', '8080'] },
      { block: 'server', words: ['location', '=', '/feed.xml'] },
      { block: 'location = /feed.xml', words: ['types'] },
      { block: 'types', words: ['application/atom+xml', 'xml'] },
      { block: 'location = /feed.xml', words: ['default_type', 'application/atom+xml'] },
      { block: 'server', words: ['gzip', 'on'] },
    ]);
  });

  test('reads comments, quoted strings and ${variables} as nginx does', () => {
    const conf = `server {
    # gzip on; { a brace in a comment }
    add_header X-Note "a; b { c }" always;
    add_header X-Single 'one two';
    set $x "\\"escaped\\"";
    return 200 \${scheme}://host;
}`;
    expect(nginxStatements(conf)).toEqual([
      { block: '', words: ['server'] },
      { block: 'server', words: ['add_header', 'X-Note', '"a;_b_{_c_}"', 'always'] },
      { block: 'server', words: ['add_header', 'X-Single', "'one_two'"] },
      { block: 'server', words: ['set', '$x', '"\\"escaped\\""'] },
      { block: 'server', words: ['return', '200', '${scheme}://host'] },
    ]);
  });

  test('a comment on the last line ends the file', () => {
    expect(nginxStatements('gzip on; # trailing')).toEqual([{ block: '', words: ['gzip', 'on'] }]);
  });

  test('refuses braces and quotes that do not pair up', () => {
    expect(() => nginxStatements('server {\n gzip on;\n')).toThrow('"server" is never closed');
    expect(() => nginxStatements('gzip on;\n}')).toThrow('closes nothing');
    expect(() => nginxStatements('server {\n gzip on\n}')).toThrow('"gzip on" has no semicolon');
    expect(() => nginxStatements('add_header X "open;')).toThrow('never closes');
    expect(() => nginxStatements('return 200 ${scheme')).toThrow('the variable at offset');
  });
});
