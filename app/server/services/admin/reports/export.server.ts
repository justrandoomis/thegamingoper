/**
 * Admin 18.06 — a report as a file: CSV (UTF-8 with a byte-order mark, formula-safe cells — module 04's writer, the
 * same rule as the catalogue's: a cell starting with = + - @ gets an apostrophe unless it is a plain number) or XLSX
 * (./xlsx.ts: inline strings, never formulas), with exactly the figures the report shows THIS employee: cost columns
 * only with cost.read, profit columns only with cost.read + profit.read — absent from the file, not empty
 * (blueprint acceptance #5). Needs reports.export.create AND the report's own permission. Every export is audited
 * (`reports.export.create`: the report, its parameters, the format, the rows, whether protected figures were in it).
 *
 *   const file = await exportReport(db, actor, { key: "sales", format: "xlsx", params: url.searchParams }, locale, now, t);
 *   return new Response(file.body, { headers: file.headers });
 */
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { runBatch } from "~/server/db/tx.server";
import type { Locale } from "~/lib/locales";
import { parseCsv } from "../catalog/csv";
import { csvHeaders, toCsv, type CsvCell } from "../inventory/csv";
import { customerReport } from "./customers.server";
import { abcRows, stockReportCsv } from "./inventory.server";
import { marginRows, marginSortFor, marginTotals, sortMarginRows } from "./margin.server";
import { performanceReport } from "./performance.server";
import { salesReport } from "./sales.server";
import { assertReport, reportsAccess } from "./shared.server";
import {
  COHORT_MONTHS,
  MAX_EXPORT_ROWS,
  MAX_LINE_ORDERS,
  parseCustomerParams,
  parseInventoryParams,
  parseMarginParams,
  parsePerformanceParams,
  parseSalesParams,
  savedParamsOf,
  type ReportKey,
  type SalesRow,
} from "./types";
import { toXlsx, xlsxHeaders } from "./xlsx";

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

type T = (key: string, vars?: Record<string, string | number>) => string;
/** Which protected figures the file carries (recorded in the audit event). */
type Protects = { cost: boolean; profit: boolean };
const NONE: Protects = { cost: false, profit: false };
type Table = { name: string; header: string[]; rows: CsvCell[][]; protects: Protects };
type RawTable = { csv: string; name: string; header: string[]; protects: Protects };

const pct = (value: number | null | undefined, digits = 1): CsvCell => (value === null || value === undefined || !Number.isFinite(value) ? "" : Number((value * 100).toFixed(digits)));
const bpsPct = (value: number | null | undefined): CsvCell => (value === null || value === undefined ? "" : Number((value / 100).toFixed(2)));

function salesLabel(row: SalesRow, t: T): string {
  switch (row.label.kind) {
    case "day":
      return row.label.day;
    case "channel":
      return t(`channel.${row.label.channel}`);
    case "branch":
      return row.label.id ? (row.name ?? row.label.id) : t(row.label.channel === "pos" ? "sales.branchNone" : "sales.online");
    default:
      return row.label.id ? (row.name ?? row.label.id) : t("sales.noPlatform");
  }
}

/** The report as one table: header in the admin's language, rows of plain values. */
async function tableOf(db: Db, actor: Actor, key: ReportKey, params: URLSearchParams, locale: Locale, now: number, t: T): Promise<Table | RawTable> {
  const access = reportsAccess(actor);
  if (key === "sales") {
    const state = parseSalesParams(params, now);
    const report = await salesReport(db, actor, state, locale, now, { all: true });
    const platform = state.by === "platform";
    const header = [t(`sales.by.${state.by}`), t("col.placed"), ...(platform ? [] : [t("col.gmvIqd"), t("col.cancelled")]), t("col.recognised"), t("col.revenueIqd"), t("col.discountsIqd"), t("col.refundsIqd"), t("col.netRevenueIqd"), t("col.shippingIqd"), t("col.units")];
    const line = (label: string, row: { placed: number | null; gmvIqd: number | null; cancelled: number | null; ordersRecognised: number; revenue: SalesRow["revenue"]; units: number | null }): CsvCell[] => [
      label,
      row.placed ?? "",
      ...(platform ? [] : [row.gmvIqd ?? "", row.cancelled ?? ""]),
      row.ordersRecognised,
      row.revenue.grossIqd,
      row.revenue.discountsIqd,
      row.revenue.refundsIqd,
      row.revenue.netIqd,
      row.revenue.shippingIqd,
      row.units ?? "",
    ];
    const rows: CsvCell[][] = report.rows.map((row) => line(salesLabel(row, t), row));
    if (report.unattributed.grossIqd || report.unattributed.discountsIqd || report.unattributed.refundsIqd || report.unattributed.shippingIqd)
      rows.push(line(t("sales.unattributed"), { placed: null, gmvIqd: null, cancelled: null, ordersRecognised: 0, revenue: report.unattributed, units: null }));
    rows.push(line(t("sales.totalBooks"), { placed: report.operations.placed, gmvIqd: report.operations.gmvIqd, cancelled: report.operations.cancelled, ordersRecognised: report.totals.ordersRecognised, revenue: report.totals, units: report.operations.unitsSold }));
    if (report.tooMany) return { name: t("sales.title"), header: [t("export.note")], rows: [[t("common.tooMany", { count: report.tooMany.orders, max: MAX_LINE_ORDERS })]], protects: NONE };
    return { name: t("sales.title"), header, rows, protects: NONE };
  }
  if (key === "margin") {
    const state = parseMarginParams(params, now);
    const result = await marginRows(db, actor, state.range, locale);
    if (result.tooMany) return { name: t("margin.title"), header: [t("export.note")], rows: [[t("common.tooMany", { count: result.tooMany.orders, max: MAX_LINE_ORDERS })]], protects: NONE };
    const sorted = sortMarginRows(result.rows, { sort: marginSortFor(state.sort, result.access), dir: state.dir, q: state.q });
    const header = [t("col.sku"), t("col.product"), t("col.condition"), t("col.orders"), t("col.units"), t("col.revenueIqd"), t("col.discountsIqd"), t("col.refundsIqd"), t("col.netRevenueIqd")];
    // the file keeps the definitions' signs: cost, net delivery cost (carrier − fee) and commissions as amounts
    if (result.access.cost) header.push(t("col.cogsIqd"), t("col.uncosted"), t("col.subsidyIqd"), t("col.carrierUnknown"));
    if (result.access.profit) header.push(t("col.commissionsIqd"), t("col.netProfitIqd"), t("col.netMarginPct"));
    const rows: CsvCell[][] = sorted.map((row) => [
      row.sku,
      row.name,
      t(row.used ? "margin.used" : "margin.new"),
      row.orders,
      row.units,
      row.revenueIqd,
      row.discountsIqd,
      row.refundsIqd,
      row.netRevenueIqd,
      ...(result.access.cost ? [row.cogsIqd ?? "", row.uncostedUnits ?? "", row.shippingSubsidyIqd ?? "", row.carrierUnknownOrders ?? ""] : []),
      ...(result.access.profit ? [row.commissionsIqd ?? "", row.netProfitIqd ?? "", bpsPct(row.netMarginBps)] : []),
    ]);
    // the total row adds up to the rows in the file: a search keeps the SKUs it matches, and their total is theirs
    // (each order once); without a search, the orders column is every order delivered in the range
    const s = state.q ? marginTotals(sorted, result.sets, result.access) : result.totals;
    rows.push([
      t("margin.total"),
      "",
      "",
      state.q ? s.orders : result.orders,
      s.units,
      s.revenueIqd,
      s.discountsIqd,
      s.refundsIqd,
      s.netRevenueIqd,
      ...(result.access.cost ? [s.cogsIqd ?? "", s.uncostedUnits ?? "", s.shippingSubsidyIqd ?? "", s.carrierUnknownOrders ?? ""] : []),
      ...(result.access.profit ? [s.commissionsIqd ?? "", s.netProfitIqd ?? "", bpsPct(s.netMarginBps)] : []),
    ]);
    return { name: t("margin.title"), header, rows, protects: { cost: result.access.cost, profit: result.access.profit } };
  }
  if (key === "inventory") {
    const state = parseInventoryParams(params, now);
    if (state.view === "abc") {
      const result = await abcRows(db, actor, state.range, state.basis, locale);
      if (result.tooMany) return { name: t("inventory.title"), header: [t("export.note")], rows: [[t("common.tooMany", { count: result.tooMany.orders, max: MAX_LINE_ORDERS })]], protects: NONE };
      const list = state.abcClass ? result.rows.filter((row) => row.abcClass === state.abcClass) : result.rows;
      const header = [t("col.sku"), t("col.product"), t("col.condition"), t("col.class"), t("col.netRevenueIqd"), t("col.units"), t("col.sharePct"), t("col.cumulativePct")];
      const rows: CsvCell[][] = list.map((row) => [row.sku, row.name, t(row.used ? "margin.used" : "margin.new"), row.abcClass, row.netRevenueIqd, row.units, pct(row.share), pct(row.cumulative)]);
      return { name: t("inventory.view.abc"), header, rows, protects: NONE };
    }
    assertCan(actor, "inventory.report.read");
    const h: Record<string, string> = {
      sku: t("col.sku"),
      product: t("col.product"),
      onHand: t("col.onHand"),
      lastSale: t("col.lastSale"),
      lastReceipt: t("col.lastReceipt"),
      valueIqd: t("col.stockValueIqd"),
      unlayered: t("col.unlayered"),
      sold: t("col.sold"),
      onHandStart: t("col.onHandStart"),
      onHandEnd: t("col.onHandEnd"),
      averageOnHand: t("col.averageOnHand"),
      turnover: t("col.turnover"),
      daysOfInventory: t("col.daysOfInventory"),
      cogsIqd: t("col.cogsIqd"),
    };
    const csv = await stockReportCsv(db, actor, state, locale, now, h);
    const header =
      state.view === "dead" ? [h.sku, h.product, h.onHand, h.lastSale, h.lastReceipt, ...(access.cost ? [h.valueIqd, h.unlayered] : [])] : [h.sku, h.product, h.sold, h.onHandStart, h.onHandEnd, h.averageOnHand, h.turnover, h.daysOfInventory, ...(access.cost ? [h.cogsIqd] : [])];
    return { csv, name: t(`inventory.view.${state.view}`), header, protects: { cost: access.cost, profit: false } };
  }
  if (key === "customers") {
    const state = parseCustomerParams(params, now);
    const report = await customerReport(db, actor, state, now);
    if (state.view === "value" && report.value) {
      const header = [t("col.segment"), t("col.customers"), t("col.sharePct"), t("col.keptIqd"), t("col.avgKeptIqd")];
      const rows: CsvCell[][] = report.value.segments.map((row) => [t(`segment.${row.segment}`), row.customers, bpsPct(row.shareBps), row.keptIqd, row.avgKeptIqd ?? ""]);
      rows.push([t("customers.allCustomers"), report.value.customers, 100, report.value.keptIqd, report.value.avgKeptIqd ?? ""]);
      return { name: t("customers.view.value"), header, rows, protects: NONE };
    }
    const header = [t("col.cohort"), t("col.customers"), ...Array.from({ length: COHORT_MONTHS }, (_, k) => t("customers.monthN", { n: k })), t("col.valuePerCustomerIqd")];
    const rows: CsvCell[][] = report.cohorts.map((row) => [row.cohort, row.customers, ...row.retention.map((value) => pct(value)), row.valuePerCustomerIqd]);
    return { name: t("customers.view.cohorts"), header, rows, protects: NONE };
  }
  const state = parsePerformanceParams(params, now);
  const report = await performanceReport(db, actor, state, locale, now);
  if (report.suppliers) {
    const header = [t("col.code"), t("col.supplier"), t("col.grade"), t("col.score"), t("col.onTimePct"), t("col.defectPct"), t("col.receipts"), t("col.leadDays"), t("col.promisedLeadDays")];
    const rows: CsvCell[][] = report.suppliers.rows.map((row) => [row.code, row.name, row.rating.grade ?? "", row.rating.score ?? "", pct(row.rating.onTimeRate), pct(row.rating.defectRate), row.rating.receipts, row.rating.avgLeadDays ?? "", row.rating.promisedLeadDays ?? ""]);
    return { name: t("performance.view.suppliers"), header, rows, protects: NONE };
  }
  if (report.employees) {
    const header = [t("col.employee"), t("col.orders"), t("col.units"), t("col.netSalesIqd"), t("col.refundsIqd"), t("col.refundedOrders"), t("col.basketIqd"), t("col.packed")];
    const rows: CsvCell[][] = report.employees.rows.map((row) => [row.employee.name, row.sales.orders, row.sales.units, row.sales.netIqd, row.sales.refundsIqd, row.sales.refundedOrders, row.sales.basketIqd ?? "", row.packed]);
    return { name: t("performance.view.employees"), header, rows, protects: NONE };
  }
  if (report.shipping) {
    const header = [t("col.carrier"), t("col.sent"), t("col.delivered"), t("col.returned"), t("col.open"), t("col.successPct"), t("col.firstAttemptPct"), t("col.failedAttempts"), t("col.deliveryDays"), t("col.codDelivered"), t("col.codSettled"), t("col.settleDays"), t("col.codAwaiting"), t("col.oldestAwaitingDays")];
    const line = (name: string, row: (typeof report.shipping.rows)[number]): CsvCell[] => [name, row.sent, row.delivered, row.returned, row.open, pct(row.successRate), pct(row.firstAttemptRate), row.failedAttempts, row.medianDeliveryDays ?? "", row.cod.delivered, row.cod.settled, row.cod.medianSettleDays ?? "", row.cod.awaiting, row.cod.oldestAwaitingDays ?? ""];
    const rows = report.shipping.rows.map((row) => line(row.name ?? t("performance.noCarrier"), row));
    rows.push(line(t("performance.allCarriers"), report.shipping.total));
    return { name: t("performance.view.shipping"), header, rows, protects: NONE };
  }
  if (report.support) {
    const metrics = report.support.metrics;
    const header = [t("col.agent"), t("col.answered"), t("col.firstResponseMin"), t("col.resolved"), t("col.resolutionMin")];
    const rows: CsvCell[][] = metrics.byAgent.map((row) => [row.name, row.answered, row.firstResponse.median ?? "", row.resolved, row.resolution.median ?? ""]);
    rows.push([t("performance.allAgents"), metrics.tickets.firstResponse.count, metrics.tickets.firstResponse.median ?? "", metrics.tickets.resolution.count, metrics.tickets.resolution.median ?? ""]);
    return { name: t("performance.view.support"), header, rows, protects: NONE };
  }
  // the section needs another module's permission the employee does not hold: refused like that module refuses it
  assertCan(actor, report.sections[report.view].needs ?? "reports.performance.read");
  return { name: t("performance.title"), header: [t("export.note")], rows: [], protects: NONE };
}

export type ExportFile = { body: string | Uint8Array<ArrayBuffer>; headers: HeadersInit; rows: number; truncated: boolean };

/** Builds the file and records the export (one audit event) — reports.export.create + the report's permission. */
export async function exportReport(db: Db, actor: Actor, input: { key: ReportKey; format: ExportFormat; params: URLSearchParams }, locale: Locale, now: number, t: T): Promise<ExportFile> {
  assertCan(actor, "reports.export.create");
  assertReport(actor, input.key);
  const table = await tableOf(db, actor, input.key, input.params, locale, now, t);
  const saved = savedParamsOf(input.key, input.params, now);
  const stamp = `${saved.period ?? `${saved.from ?? ""}_${saved.to ?? ""}`}`.replace(/[^0-9A-Za-z_-]/g, "");
  const view = input.params.get("view") ?? input.params.get("by") ?? "";
  const base = `tamtam-${input.key}${view ? `-${view.replace(/[^a-z]/g, "")}` : ""}${stamp ? `-${stamp}` : ""}`;

  let rows: CsvCell[][];
  let header: string[];
  if ("csv" in table) {
    // module 04's own export: its CSV as it is, or (XLSX) its rows read back
    if (input.format === "csv") {
      const lines = Math.max(0, table.csv.split("\r\n").length - 2);
      await audit(db, actor, input, saved, now, { rows: lines, truncated: false, protects: table.protects });
      return { body: table.csv, headers: csvHeaders(`${base}.csv`), rows: lines, truncated: false };
    }
    const parsed = parseCsv(table.csv);
    header = table.header;
    // the SKU and the product's name stay text ("000123" is a SKU, not 123); the figures become numbers again
    rows = parsed.rows.map((row) => parsed.header.map((name, index) => (index < STOCK_TEXT_COLUMNS ? (row.cells[name] ?? "") : cellBack(row.cells[name] ?? ""))));
  } else {
    header = table.header;
    rows = table.rows;
  }
  const truncated = rows.length > MAX_EXPORT_ROWS;
  const kept = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;
  if (truncated) kept.push([t("export.truncated", { count: MAX_EXPORT_ROWS })]);
  await audit(db, actor, input, saved, now, { rows: Math.min(rows.length, MAX_EXPORT_ROWS), truncated, protects: table.protects });
  if (input.format === "xlsx") return { body: toXlsx({ name: table.name, rows: [header, ...kept], rtl: locale !== "en" }), headers: xlsxHeaders(`${base}.xlsx`), rows: kept.length, truncated };
  return { body: toCsv([header, ...kept]), headers: csvHeaders(`${base}.csv`), rows: kept.length, truncated };
}

/** Module 04's turnover and dead-stock files start with the SKU and the product's name — text, whatever they look like. */
const STOCK_TEXT_COLUMNS = 2;

/** A figure read back from a CSV: plain numbers become numbers again (so a spreadsheet can add them up). */
function cellBack(value: string): CsvCell {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

async function audit(db: Db, actor: Actor, input: { key: ReportKey; format: ExportFormat }, params: Record<string, string>, now: number, facts: { rows: number; truncated: boolean; protects: Protects }) {
  await runBatch(db, [
    auditStatement(db, {
      actor,
      action: "reports.export.create",
      entityType: "report",
      entityId: input.key,
      after: { format: input.format, params, rows: facts.rows, truncated: facts.truncated, includedProtected: facts.protects },
      at: now,
    }),
  ]);
}
