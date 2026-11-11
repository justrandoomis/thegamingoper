/**
 * CSV for the pricing exports — UTF-8 with a byte-order mark (so Excel reads Arabic), CRLF line ends, RFC 4180
 * quoting. Text cells that a spreadsheet would run as a formula (= + - @, a tab or a carriage return first) are
 * prefixed with an apostrophe. Numbers stay numbers; a value that cannot be computed is an empty cell, never 0.
 */
export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A download response: private, never cached, never indexed. */
export function csvResponse(filename: string, body: string): Response {
  const safe = filename.replace(/[^a-z0-9._-]/gi, "-");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Basis points as a percent number with two decimals (1250 → 12.5), for CSV cells. */
export const bpsCell = (bps: number | null | undefined): number | null => (bps === null || bps === undefined ? null : Math.round(bps) / 100);
