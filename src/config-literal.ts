/**
 * A tolerant reader for the object literal inside `deploykit.config.ts`.
 *
 * The config is TypeScript so editors can type it, but its payload has to be
 * readable as *data* — deploykit never executes the user's config. `JSON.parse`
 * is the obvious reader and the wrong one: the file lands in a repo whose
 * formatter (Biome, Prettier, an editor on save) rewrites it on the next
 * commit — unquoting keys, switching to single quotes, adding trailing commas —
 * and `deploykit generate` would then fail on a file deploykit wrote itself.
 *
 * So we accept the JS object-literal subset formatters produce, and reject
 * anything that would need evaluating (identifiers, spreads, calls) with a
 * message pointing at the line.
 */

export type ParseLiteralResult =
  | { value: unknown; error?: undefined }
  | { value?: undefined; error: string };

interface Reader {
  source: string;
  pos: number;
}

class LiteralSyntaxError extends Error {}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/;
const QUOTES = new Set(['"', "'", "`"]);

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * Read the object literal starting at `from` (leading trivia is skipped).
 * Parsing stops at the literal's closing brace; whatever follows it in the
 * file is ignored, so the surrounding TypeScript doesn't have to be understood.
 */
export function parseObjectLiteral({
  source,
  from = 0,
}: {
  source: string;
  from?: number;
}): ParseLiteralResult {
  const reader: Reader = { source, pos: from };
  try {
    skipTrivia(reader);
    if (reader.source[reader.pos] !== "{") {
      fail(reader, "expected an object literal");
    }
    return { value: parseObject(reader) };
  } catch (err) {
    if (err instanceof LiteralSyntaxError) return { error: err.message };
    throw err;
  }
}

const lineOf = (r: Reader) => r.source.slice(0, r.pos).split("\n").length;

function fail(r: Reader, message: string): never {
  throw new LiteralSyntaxError(`${message} (line ${lineOf(r)})`);
}

/** Skip whitespace, `//` line comments and `/* *\/` block comments. */
function skipTrivia(r: Reader) {
  for (;;) {
    const ch = r.source[r.pos];
    if (ch === undefined) return;
    if (/\s/.test(ch)) {
      r.pos++;
      continue;
    }
    if (ch !== "/") return;
    const next = r.source[r.pos + 1];
    if (next === "/") {
      const newline = r.source.indexOf("\n", r.pos);
      r.pos = newline === -1 ? r.source.length : newline + 1;
      continue;
    }
    if (next === "*") {
      const end = r.source.indexOf("*/", r.pos + 2);
      if (end === -1) fail(r, "unterminated block comment");
      r.pos = end + 2;
      continue;
    }
    return;
  }
}

function parseValue(r: Reader): unknown {
  skipTrivia(r);
  const ch = r.source[r.pos];
  if (ch === undefined) fail(r, "unexpected end of file");
  if (ch === "{") return parseObject(r);
  if (ch === "[") return parseArray(r);
  if (QUOTES.has(ch)) return parseString(r);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(r);
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (!isKeywordAt(r, word)) continue;
    r.pos += word.length;
    return value;
  }
  fail(
    r,
    `expected a value, found ${JSON.stringify(ch)} — the config holds plain data only (no variables, spreads or expressions)`,
  );
}

/** True when `word` sits at the cursor and isn't the head of a longer name. */
function isKeywordAt(r: Reader, word: string) {
  if (!r.source.startsWith(word, r.pos)) return false;
  const after = r.source[r.pos + word.length];
  return after === undefined || !IDENT_PART.test(after);
}

function parseObject(r: Reader) {
  r.pos++; // consume "{"
  const out: Record<string, unknown> = {};
  skipTrivia(r);
  if (r.source[r.pos] === "}") {
    r.pos++;
    return out;
  }
  for (;;) {
    skipTrivia(r);
    const key = parseKey(r);
    skipTrivia(r);
    if (r.source[r.pos] !== ":") fail(r, `expected ":" after key ${key}`);
    r.pos++;
    defineEntry({ target: out, key, value: parseValue(r) });
    skipTrivia(r);
    const ch = r.source[r.pos];
    if (ch === "}") {
      r.pos++;
      return out;
    }
    if (ch !== ",") fail(r, 'expected "," or "}" in object');
    r.pos++; // consume "," — a trailing one is fine
    skipTrivia(r);
    if (r.source[r.pos] === "}") {
      r.pos++;
      return out;
    }
  }
}

/**
 * Assign without going through the `__proto__` setter, which a hostile or
 * careless config could otherwise use to reach the object prototype.
 */
const defineEntry = ({
  target,
  key,
  value,
}: {
  target: Record<string, unknown>;
  key: string;
  value: unknown;
}) =>
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });

function parseArray(r: Reader) {
  r.pos++; // consume "["
  const out: unknown[] = [];
  skipTrivia(r);
  if (r.source[r.pos] === "]") {
    r.pos++;
    return out;
  }
  for (;;) {
    out.push(parseValue(r));
    skipTrivia(r);
    const ch = r.source[r.pos];
    if (ch === "]") {
      r.pos++;
      return out;
    }
    if (ch !== ",") fail(r, 'expected "," or "]" in array');
    r.pos++;
    skipTrivia(r);
    if (r.source[r.pos] === "]") {
      r.pos++;
      return out;
    }
  }
}

/** A property name: quoted, or a bare identifier once a formatter is done. */
function parseKey(r: Reader) {
  const ch = r.source[r.pos];
  if (ch !== undefined && QUOTES.has(ch)) return parseString(r);
  if (ch === undefined || !IDENT_START.test(ch)) {
    fail(r, "expected a property name");
  }
  const start = r.pos;
  while (r.pos < r.source.length) {
    const c = r.source[r.pos];
    if (c === undefined || !IDENT_PART.test(c)) break;
    r.pos++;
  }
  return r.source.slice(start, r.pos);
}

function parseString(r: Reader) {
  const quote = r.source[r.pos];
  r.pos++;
  let out = "";
  for (;;) {
    const ch = r.source[r.pos];
    if (ch === undefined) fail(r, "unterminated string");
    if (ch === "\n" && quote !== "`") fail(r, "unterminated string");
    if (ch === quote) {
      r.pos++;
      return out;
    }
    if (quote === "`" && ch === "$" && r.source[r.pos + 1] === "{") {
      fail(
        r,
        "template placeholders aren't supported — values must be literal",
      );
    }
    if (ch === "\\") {
      out += readEscape(r);
      continue;
    }
    out += ch;
    r.pos++;
  }
}

function readEscape(r: Reader) {
  r.pos++; // consume "\"
  const ch = r.source[r.pos];
  if (ch === undefined) fail(r, "unterminated escape sequence");
  r.pos++;
  if (ch === "u") return readCodePoint({ r, digits: 4 });
  if (ch === "x") return readCodePoint({ r, digits: 2 });
  // Anything else stands for itself, as it does in JS: \\ \" \' \` \/ and the
  // named escapes above.
  return ESCAPES[ch] ?? ch;
}

function readCodePoint({ r, digits }: { r: Reader; digits: number }) {
  const raw = r.source.slice(r.pos, r.pos + digits);
  if (raw.length < digits || !/^[0-9a-fA-F]+$/.test(raw)) {
    fail(r, "invalid escape sequence");
  }
  r.pos += digits;
  return String.fromCharCode(Number.parseInt(raw, 16));
}

function parseNumber(r: Reader) {
  const match = NUMBER.exec(r.source.slice(r.pos));
  if (!match) fail(r, "invalid number");
  r.pos += match[0].length;
  return Number(match[0]);
}
