/*
 * Just enough of the nginx configuration grammar to answer one question: which
 * directives does each block hold, at any depth, with their arguments. A
 * pattern that stops at the first closing brace cuts a block at its first
 * inner block (`types { }`) and never sees what follows it.
 */

/** One directive as written: `gzip_comp_level 6;` in the `server` block. */
export interface INginxStatement {
  /** The head of the block the directive sits in directly, single-spaced, or '' outside every block. */
  readonly block: string;
  /** The directive's name and its arguments. A quoted argument has its whitespace as `_`. */
  readonly words: readonly string[];
}

/** Where the quoted string that opens at `start` ends: the index of its closing quote. */
function quoteEnd(conf: string, start: number): number {
  const quote = conf[start];
  for (let index = start + 1; index < conf.length; index += 1) {
    if (conf[index] === '\\') index += 1;
    else if (conf[index] === quote) return index;
  }
  throw new Error(`nginx config: the quote opened at offset ${start} never closes`);
}

/**
 * Every directive of an nginx configuration, in the order written, with its
 * arguments and the block it sits in. A directive that opens a block is one
 * too, in the block around it. Comments, quoted strings and `${variable}`
 * references are read as nginx reads them, so a brace or a semicolon inside
 * one opens and ends nothing. Throws on braces that do not pair up.
 */
export function nginxStatements(conf: string): INginxStatement[] {
  const statements: INginxStatement[] = [];
  const open: string[] = [];
  let statement = '';

  const endStatement = (): string => {
    const words = statement.trim().split(/\s+/u);
    statement = '';
    if ((words[0] ?? '') !== '') statements.push({ block: open.at(-1) ?? '', words });
    return words.join(' ');
  };

  for (let index = 0; index < conf.length; index += 1) {
    const char = conf[index] as string;
    if (char === '#') {
      const lineEnd = conf.indexOf('\n', index);
      index = lineEnd === -1 ? conf.length : lineEnd;
      statement += ' ';
    } else if (char === '"' || char === "'") {
      const end = quoteEnd(conf, index);
      statement += conf.slice(index, end + 1).replace(/\s/gu, '_');
      index = end;
    } else if (char === '$' && conf[index + 1] === '{') {
      const end = conf.indexOf('}', index);
      if (end === -1) throw new Error(`nginx config: the variable at offset ${index} never closes`);
      statement += conf.slice(index, end + 1);
      index = end;
    } else if (char === ';') {
      endStatement();
    } else if (char === '{') {
      open.push(endStatement());
    } else if (char === '}') {
      if (statement.trim() !== '') {
        throw new Error(`nginx config: ${JSON.stringify(statement.trim())} has no semicolon`);
      }
      if (open.pop() === undefined) {
        throw new Error(`nginx config: the closing brace at offset ${index} closes nothing`);
      }
    } else {
      statement += char;
    }
  }
  if (open.length > 0) {
    throw new Error(`nginx config: ${JSON.stringify(open.at(-1))} is never closed`);
  }
  return statements;
}
