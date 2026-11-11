/**
 * Turning what a seed writes into a plain SQL script.
 *
 *   const recorded: RecordedStatement[] = [];
 *   const db = createDb(recordWrites(d1, recorded));     // every write still runs against `d1`
 *   await seedReference(db, now); await seedDemo(db, now);
 *   writeFileSync("seed.sql", toSqlScript(recorded, ["TamTam demo seed"]));
 *   // npx wrangler d1 execute DB --remote --file seed.sql
 *
 * recordWrites() wraps a D1 binding: statements are passed through unchanged and every INSERT /
 * UPDATE / DELETE that SUCCEEDED is noted with its bound parameters, in execution order. Because
 * the statements really ran (against a throw-away database with the real schema), a script made
 * from them is known to apply to an empty migrated database; because the seeds only write
 * "insert if missing" statements, it is also safe on a database that already has some of the rows.
 *
 * No Node APIs here — writing the file is the caller's business (scripts/seed.ts).
 */

export type RecordedStatement = { sql: string; params: unknown[] };

const WRITE_STATEMENT = /^\s*(insert|update|delete|replace)\b/i;
/** Batch guards (expectChanged / expectThat) are checks, not data, and would misfire when replayed. */
const GUARD_TABLE = /\b_tx_guard\b/;

const isDataWrite = (sqlText: string) => WRITE_STATEMENT.test(sqlText) && !GUARD_TABLE.test(sqlText);

class RecordingStatement {
  constructor(
    readonly real: D1PreparedStatement,
    readonly sql: string,
    readonly params: unknown[],
    private readonly sink: RecordedStatement[],
  ) {}

  bind(...values: unknown[]): RecordingStatement {
    return new RecordingStatement(this.real.bind(...values), this.sql, values, this.sink);
  }

  /** Called after the statement has succeeded. */
  note(): void {
    if (isDataWrite(this.sql)) this.sink.push({ sql: this.sql, params: this.params });
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.real.run<T>();
    this.note();
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.real.all<T>();
    this.note();
    return result;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = options?.columnNames ? await this.real.raw<T>({ columnNames: true }) : await this.real.raw<T>();
    this.note();
    return result as T[];
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const result = column === undefined ? await this.real.first<T>() : await this.real.first<T>(column);
    this.note();
    return result;
  }
}

/**
 * A D1 binding that behaves like `real` and appends every successful data-changing statement to
 * `sink`. Statements in a batch are recorded only when the whole batch committed.
 */
export function recordWrites(real: D1Database, sink: RecordedStatement[]): D1Database {
  const recording = {
    prepare(query: string) {
      return new RecordingStatement(real.prepare(query), query, [], sink);
    },
    async batch(statements: RecordingStatement[]) {
      const results = await real.batch(statements.map((statement) => statement.real));
      for (const statement of statements) statement.note();
      return results;
    },
    exec(query: string) {
      // exec() takes raw multi-statement text with no parameters; seeds never use it.
      throw new Error(`recordWrites: exec() is not supported (got "${query.slice(0, 60)}…")`);
    },
  };
  return recording as unknown as D1Database;
}

// ───────────────────────────────────────────────────────────────── literals

const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A JavaScript value as a SQLite literal, exactly as D1 would have bound it. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`sqlLiteral: ${value} cannot be written to SQL`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new Error("sqlLiteral: a string containing NUL cannot be written to SQL");
    // Control characters (line breaks, tabs) are spliced in with char(), so every statement stays on
    // one line and no tool that splits scripts can be confused by a line break inside a literal.
    const parts = value.split(/([\u0001-\u001f\u007f])/);
    const pieces: string[] = [];
    parts.forEach((part, index) => {
      if (index % 2 === 1) pieces.push(`char(${part.charCodeAt(0)})`);
      else if (part !== "" || parts.length === 1) pieces.push(`'${part.replaceAll("'", "''")}'`);
    });
    return pieces.length === 1 ? pieces[0] : `(${pieces.join(" || ")})`;
  }
  if (value instanceof Uint8Array) return `X'${toHex(value)}'`;
  if (value instanceof ArrayBuffer) return `X'${toHex(new Uint8Array(value))}'`;
  throw new Error(`sqlLiteral: unsupported parameter type ${Object.prototype.toString.call(value)}`);
}

/**
 * Replaces the `?` / `?N` placeholders of a statement with literals. Placeholders inside string
 * literals, quoted identifiers and comments are left alone.
 */
export function inlineParams(sqlText: string, params: readonly unknown[]): string {
  let out = "";
  let next = 0;
  let used = 0;
  let i = 0;
  const skipQuoted = (quote: string) => {
    // SQL doubles the quote character to escape it; a doubled quote simply re-enters the loop.
    const start = i;
    i++;
    while (i < sqlText.length && sqlText[i] !== quote) i++;
    i++;
    out += sqlText.slice(start, i);
  };
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      skipQuoted(ch);
    } else if (ch === "[") {
      const end = sqlText.indexOf("]", i);
      const stop = end === -1 ? sqlText.length : end + 1;
      out += sqlText.slice(i, stop);
      i = stop;
    } else if (ch === "-" && sqlText[i + 1] === "-") {
      const end = sqlText.indexOf("\n", i);
      const stop = end === -1 ? sqlText.length : end;
      out += sqlText.slice(i, stop);
      i = stop;
    } else if (ch === "/" && sqlText[i + 1] === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      const stop = end === -1 ? sqlText.length : end + 2;
      out += sqlText.slice(i, stop);
      i = stop;
    } else if (ch === "?") {
      let digits = "";
      while (/[0-9]/.test(sqlText[i + 1 + digits.length] ?? "")) digits += sqlText[i + 1 + digits.length];
      const index = digits ? Number(digits) - 1 : next++;
      if (index < 0 || index >= params.length) throw new Error(`inlineParams: the statement uses parameter ${index + 1} but ${params.length} were bound`);
      out += sqlLiteral(params[index]);
      used = Math.max(used, index + 1);
      i += 1 + digits.length;
    } else {
      out += ch;
      i++;
    }
  }
  if (used !== params.length) throw new Error(`inlineParams: ${params.length} parameters were bound but the statement uses ${used}`);
  return out;
}

/** One recorded statement as a single line of SQL, without a trailing semicolon. */
export function statementToSql(statement: RecordedStatement): string {
  return inlineParams(statement.sql, statement.params).replace(/\s*\n\s*/g, " ").replace(/;\s*$/, "").trim();
}

/**
 * A script of the recorded statements, one per line, in execution order. `header` lines become
 * comments. The script contains no transaction statements: `wrangler d1 execute --file` applies a
 * file atomically on its own.
 */
export function toSqlScript(statements: readonly RecordedStatement[], header: readonly string[] = []): string {
  const lines = header.map((line) => `-- ${line.replace(/[\r\n]+/g, " ")}`);
  for (const statement of statements) lines.push(`${statementToSql(statement)};`);
  return `${lines.join("\n")}\n`;
}
