/**
 * CSV for the catalogue's import and export (02.06) — RFC 4180, pure and client-safe.
 *
 *   parseCsv(text)           → { header, rows } (rows are records keyed by header names) or throws CsvError
 *   toCsv(header, rows)      → text with a UTF-8 byte-order mark, so Excel opens Arabic correctly
 *
 * Reading: quoted fields with "" inside, CR LF or LF line ends, a leading byte-order mark, comma or semicolon as the
 * separator (whichever the header line uses; Excel in some regions writes ";"). Header names are trimmed and
 * lower-cased. Blank lines are skipped. A row with more cells than the header is an error; fewer cells are empty.
 *
 * Writing: every cell that holds a separator, a quote, a line break or edge spaces is quoted. Cells that a
 * spreadsheet would run as a formula (= + - @ and tab or CR at the start — "-2+3+cmd|…" runs too) get a leading
 * apostrophe, except plain numbers ("-12.5" stays a number); reading strips it again, so an exported file imports
 * back unchanged.
 */
export class CsvError extends Error {
  constructor(
    readonly code: "csv_empty" | "csv_unterminated_quote" | "csv_too_many_cells" | "csv_duplicate_column" | "csv_no_header",
    readonly line: number,
  ) {
    super(`${code} at line ${line}`);
    this.name = "CsvError";
  }
}

export type ParsedCsv = {
  header: string[];
  /** One record per data row, keyed by header name; `line` is the 1-based line of the row in the file. */
  rows: { line: number; cells: Record<string, string> }[];
};

const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain number: its sign is not a formula (margins can be negative). */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

function splitRecords(text: string, separator: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushCell = () => {
    cells.push(cell);
    cell = "";
  };
  const pushRecord = () => {
    pushCell();
    // A line with one empty cell is a blank line: skipped.
    if (!(cells.length === 1 && cells[0] === "")) records.push({ line: recordLine, cells });
    cells = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === "\n") line++;
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === separator) {
      pushCell();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushRecord();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
    i++;
  }
  if (quoted) throw new CsvError("csv_unterminated_quote", recordLine);
  if (cell !== "" || cells.length > 0) pushRecord();
  return records;
}

/** Undoes the export's formula guard ("'=…" → "=…"). */
const unguard = (value: string) => (value.length > 1 && value[0] === "'" && /[=+\-@\t\r]/.test(value[1]) ? value.slice(1) : value);

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === "") throw new CsvError("csv_empty", 1);
  const firstLine = text.slice(0, Math.max(0, text.search(/\r?\n/)) || text.length);
  const separator = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const records = splitRecords(text, separator);
  if (records.length === 0) throw new CsvError("csv_empty", 1);
  const [headerRecord, ...dataRecords] = records;
  const header = headerRecord.cells.map((name) => name.trim().toLowerCase());
  if (header.every((name) => name === "")) throw new CsvError("csv_no_header", headerRecord.line);
  const seen = new Set<string>();
  for (const name of header) {
    if (name === "") continue;
    if (seen.has(name)) throw new CsvError("csv_duplicate_column", headerRecord.line);
    seen.add(name);
  }
  const rows = dataRecords.map((record) => {
    if (record.cells.length > header.length) throw new CsvError("csv_too_many_cells", record.line);
    const cells: Record<string, string> = {};
    header.forEach((name, index) => {
      if (name !== "") cells[name] = unguard(record.cells[index] ?? "");
    });
    return { line: record.line, cells };
  });
  return { header: header.filter((name) => name !== ""), rows };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const guarded = FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return /[",;\r\n]|^\s|\s$/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** CSV text (with a byte-order mark) for these columns and rows. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [header.map(cellText).join(","), ...rows.map((row) => header.map((name) => cellText(row[name])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
