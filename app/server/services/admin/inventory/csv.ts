/**
 * CSV for the inventory exports (movement log, reports) — pure.
 *
 *   const text = toCsv([["SKU", "Qty"], ["PS5-SLIM", 3]]);   // UTF-8 with a byte-order mark so Excel reads Arabic
 *
 * Every cell that a spreadsheet would run as a formula (starting with = + - @, a tab or a carriage return) is
 * prefixed with an apostrophe (CSV injection), except plain numbers, which stay numbers. Quotes are doubled and
 * cells with a comma, quote or line break are quoted (RFC 4180). Lines end with CRLF.
 */
export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  if (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Headers for a CSV download (never cached: exports can carry protected data). */
export function csvHeaders(filename: string): HeadersInit {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safe}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
