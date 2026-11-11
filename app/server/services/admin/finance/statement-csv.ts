/**
 * Bank-card, Zain Cash and carrier statements as CSV (10.02) — pure parsing, client-safe, no database.
 *
 *   const parsed = parseStatementCsv(text);   // { rows, columns, problem }
 *
 * What is accepted (a statement exported from a bank or wallet app, or typed in a spreadsheet):
 *   · a header row; columns found by their names in Arabic or English (date, amount — or credit and debit —,
 *     reference, counterparty, description, and an optional time);
 *   · separated by commas, semicolons or tabs; quotes as in RFC 4180; a byte-order mark is ignored;
 *   · dates "YYYY-MM-DD", "YYYY/MM/DD", "DD/MM/YYYY" or "DD-MM-YYYY", optionally followed by "HH:mm[:ss]" (Baghdad
 *     time, 24 hours) — Iraqi statements write the day first;
 *   · amounts in whole dinars with any thousands separator and Arabic-Indic or Persian digits; money out is negative
 *     (a minus sign, parentheses, or the debit column).
 * At most STATEMENT_MAX_ROWS data rows and STATEMENT_MAX_BYTES bytes.
 */
import { BAGHDAD_OFFSET_MS, latinDigits, parseAmount } from "./types";

export const STATEMENT_MAX_ROWS = 2000;
export const STATEMENT_MAX_BYTES = 1024 * 1024;

export type StatementColumn = "date" | "time" | "amount" | "credit" | "debit" | "reference" | "counterparty" | "description";

const HEADER_NAMES: Record<StatementColumn, readonly string[]> = {
  date: ["date", "transaction date", "value date", "posting date", "booking date", "التاريخ", "تاريخ", "تاريخ العملية", "تاريخ الحركة", "بەروار"],
  time: ["time", "الوقت", "وقت", "کات"],
  amount: ["amount", "value", "sum", "المبلغ", "القيمة", "مبلغ", "بڕ"],
  credit: ["credit", "in", "deposit", "money in", "دائن", "إيداع", "ايداع", "وارد", "الوارد"],
  debit: ["debit", "out", "withdrawal", "money out", "مدين", "سحب", "صادر", "الصادر"],
  reference: ["reference", "ref", "transaction id", "transaction", "tracking", "tracking no", "order", "المرجع", "رقم العملية", "رقم الحوالة", "رقم المرجع", "رقم التتبع", "الطلب", "رقم الطلب"],
  counterparty: ["counterparty", "name", "sender", "from", "customer", "payer", "الاسم", "المرسل", "العميل", "الطرف", "اسم المرسل"],
  description: ["description", "details", "narrative", "notes", "memo", "الوصف", "التفاصيل", "البيان", "ملاحظات"],
};

const normalizeHeader = (value: string) =>
  value
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[_\-.:]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[إأآ]/g, "ا");

export type ParsedStatementRow = {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  occurredAt: number | null;
  amountIqd: number | null;
  reference: string | null;
  counterparty: string | null;
  description: string | null;
  /** Why the row cannot be imported (an error key), or null. */
  error: "date_invalid" | "amount_invalid" | "amount_zero" | null;
  /** The original cells, by header. */
  raw: Record<string, string>;
};

export type ParsedStatement = {
  rows: ParsedStatementRow[];
  columns: Partial<Record<StatementColumn, string>>;
  /** A problem with the file as a whole (an error key), or null. */
  problem: "empty" | "too_large" | "too_many_rows" | "no_date_column" | "no_amount_column" | null;
};

/** Splits CSV text into rows of cells (RFC 4180 quotes, the given separator). */
export function csvRows(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function detectSeparator(headerLine: string): string {
  const counts = [",", ";", "\t"].map((sep) => ({ sep, n: headerLine.split(sep).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].sep : ",";
}

/** "2026-11-09", "09/11/2026", "2026/11/09 14:30" … in Baghdad time → epoch ms, or null. */
export function parseStatementDate(dateCell: string, timeCell = ""): number | null {
  const text = latinDigits(`${dateCell} ${timeCell}`).trim().replace(/\s+/g, " ");
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  let y: number, m: number, d: number;
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const hh = Number(match[4] ?? 0);
  const mm = Number(match[5] ?? 0);
  const ss = Number(match[6] ?? 0);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || hh > 23 || mm > 59 || ss > 59) return null;
  const utc = Date.UTC(y, m - 1, d, hh, mm, ss);
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) return null;
  return utc - BAGHDAD_OFFSET_MS;
}

const cleanCell = (value: string | undefined): string | null => {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text === "" ? null : text.slice(0, 200);
};

/** Parses a statement file (see the file header). */
export function parseStatementCsv(input: string): ParsedStatement {
  if (new TextEncoder().encode(input).length > STATEMENT_MAX_BYTES) return { rows: [], columns: {}, problem: "too_large" };
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = detectSeparator(firstLine);
  const table = csvRows(text, separator);
  if (table.length < 2) return { rows: [], columns: {}, problem: "empty" };
  if (table.length - 1 > STATEMENT_MAX_ROWS) return { rows: [], columns: {}, problem: "too_many_rows" };
  const header = table[0].map(normalizeHeader);
  const index: Partial<Record<StatementColumn, number>> = {};
  const columns: Partial<Record<StatementColumn, string>> = {};
  for (const column of Object.keys(HEADER_NAMES) as StatementColumn[]) {
    const names = HEADER_NAMES[column].map(normalizeHeader);
    const at = header.findIndex((name, i) => names.includes(name) && !Object.values(index).includes(i));
    if (at >= 0) {
      index[column] = at;
      columns[column] = table[0][at].replace(/^﻿/, "").trim();
    }
  }
  if (index.date === undefined) return { rows: [], columns, problem: "no_date_column" };
  if (index.amount === undefined && index.credit === undefined && index.debit === undefined) return { rows: [], columns, problem: "no_amount_column" };

  const rows: ParsedStatementRow[] = table.slice(1).map((cells, i) => {
    const raw: Record<string, string> = {};
    table[0].forEach((name, at) => {
      const key = (name.replace(/^﻿/, "").trim() || `col${at + 1}`).slice(0, 60);
      raw[key] = (cells[at] ?? "").slice(0, 200);
    });
    const occurredAt = parseStatementDate(cells[index.date as number] ?? "", index.time !== undefined ? (cells[index.time] ?? "") : "");
    let amount: number | undefined;
    let amountBad = false;
    if (index.amount !== undefined) {
      amount = parseAmount(cells[index.amount] ?? "", { signed: true });
      amountBad = amount === undefined || Number.isNaN(amount);
    } else {
      const credit = index.credit !== undefined ? parseAmount(cells[index.credit] ?? "", { signed: true }) : undefined;
      const debit = index.debit !== undefined ? parseAmount(cells[index.debit] ?? "", { signed: true }) : undefined;
      amountBad = (credit !== undefined && Number.isNaN(credit)) || (debit !== undefined && Number.isNaN(debit)) || (credit === undefined && debit === undefined);
      amount = (credit ?? 0) - Math.abs(debit ?? 0);
    }
    const error: ParsedStatementRow["error"] = occurredAt === null ? "date_invalid" : amountBad || amount === undefined ? "amount_invalid" : amount === 0 ? "amount_zero" : null;
    return {
      line: i + 2,
      occurredAt,
      amountIqd: amountBad || amount === undefined ? null : amount,
      reference: index.reference !== undefined ? cleanCell(cells[index.reference]) : null,
      counterparty: index.counterparty !== undefined ? cleanCell(cells[index.counterparty]) : null,
      description: index.description !== undefined ? cleanCell(cells[index.description]) : null,
      error,
      raw,
    };
  });
  return { rows, columns, problem: null };
}

/** A reference as compared when matching ("TT-7K4M 2Q9X" and "tt7k4m2q9x" are the same reference). */
export function normalizeReference(value: string | null | undefined): string {
  return latinDigits(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
