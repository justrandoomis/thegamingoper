/**
 * Admin 19.02 — stock-out alerts with a suggested purchase order ready for approval.
 *
 *   await scanStockOuts(db, actor, now);                       // a reorder suggestion per SKU that needs one (no order)
 *   await listSuggestions(db, actor, filters, locale, now);     // automation.suggestion.read
 *   const { poId } = await createDraftOrder(db, actor, { suggestionIds, supplierId, locationId, currency, lines, … }, now, locale);
 *   await dismissSuggestion(db, actor, { suggestionId, reason }, now);
 *
 * RULES
 *   · The numbers are module 04's: `listReorder` (inventory/analytics.server.ts) gives each SKU's available units, what
 *     is on the way, the reorder point and quantity, the sales rate and the cover plan (forecast.ts). A SKU whose plan
 *     is out / below its reorder point / running out within SOON_DAYS AND that has a suggested quantity gets ONE
 *     suggestion per stock episode: its id is derived from the SKU and the latest arrival of stock, so a second scan, a
 *     second rule or a dismissed suggestion never brings the same need back until new stock arrives. A SKU without an
 *     honest quantity (no sales rate, no reorder quantity) gets none — 04's reorder page shows it.
 *   · A suggestion moves nothing. A person with automation.suggestion.approve turns one or more open suggestions into a
 *     DRAFT purchase order through module 09's `savePurchaseOrder` (which needs purchasing.po.create and cost.read):
 *     supplier, destination, currency and unit costs are theirs to confirm; 09's submit, spending limit and second
 *     person decide the order. The suggestions are TAKEN first (guarded on their being open, linked to the draft the
 *     form's key names), so two people at once, a second tab or a stale form never make a second draft; a draft 09
 *     refuses gives them back at once. A draft that 09 cancels — or that was never written because the request
 *     stopped half way (after CLAIM_RELEASE_MS) — opens the suggestion again on the next scan.
 *   · Supplier cost stays in 09's tables: the last unit cost on the order form is read only with cost.read.
 *   · Demo SKUs (the demo catalogue) give demo suggestions, marked so, and their drafts are demo purchase orders.
 * Errors: forbidden (403), not_found (404), invalid (400), suggestion_changed, suggestion_not_open, suggestions_mixed,
 * nothing_selected, too_many (409), plus 09's codes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { reorderSuggestions } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid } from "~/server/errors";
import { listReorder, type ReorderRow } from "../inventory/analytics.server";
import { locationOptions, locationTree } from "../inventory/shared.server";
import { savePurchaseOrder } from "../purchasing/orders.server";
import { decimalsOf } from "../purchasing/rules";
import { idFromKey as purchasingIdFromKey } from "../purchasing/shared.server";
import { supplierOptions } from "../purchasing/suppliers.server";
import { LIMITS, parseWhole } from "./catalog";
import { cleanLine } from "./definition";
import { employeeNames, personOf, recordHref, runnerActor, skuName, stampOf, suggestionIdFor } from "./shared.server";
import { PAGE_SIZE, SUGGESTION_VIEWS, type DraftOrderForm, type SuggestionBasis, type SuggestionFilters, type SuggestionPage, type SuggestionRow, type SuggestionView } from "./types";

const MAX_DRAFT_LINES = 50;
/** Suggestions taken for a draft that 09 never wrote (the request stopped half way) are released by a scan after this. */
export const CLAIM_RELEASE_MS = 15 * 60_000;
const num = (value: unknown) => Number(value ?? 0);
/** Ids as ONE bound value (D1 binds at most 100 per statement): `id IN (SELECT value FROM json_each(…))`. */
const idList = (ids: readonly string[]) => sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`;

// ───────────────────────────────────────────────────────────────── planning one suggestion

export type SuggestionPlan = {
  id: string;
  variantId: string;
  sku: string;
  qty: number;
  supplierId: string | null;
  basis: SuggestionBasis;
};

export type SuggestionSkip = { skip: "no_quantity" | "not_needed" | "unknown_variant" };

const NEEDS = new Set(["out", "below_reorder", "soon"]);

/** Every SKU 04's reorder page lists under "needs attention" (all pages). */
async function attentionRows(db: Db, now: number): Promise<ReorderRow[]> {
  const out: ReorderRow[] = [];
  const actor = runnerActor();
  for (let page = 1; page <= 200; page++) {
    const result = await listReorder(db, actor, { show: "attention", q: "", page }, "ar", now);
    out.push(...result.rows);
    if (page >= result.pageCount) break;
  }
  return out;
}

/** The latest arrival of stock of each SKU (any location): the episode a suggestion belongs to. */
async function lastArrivals(db: Db, variantIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!variantIds.length) return out;
  const rows = await db.all<{ variantId: string; id: string }>(sql`
    SELECT m.variant_id AS variantId, (SELECT m2.id FROM stock_movements AS m2 WHERE m2.variant_id = m.variant_id AND m2.qty_delta > 0 ORDER BY m2.at DESC, m2.id DESC LIMIT 1) AS id
    FROM (SELECT DISTINCT value AS variant_id FROM json_each(${JSON.stringify([...new Set(variantIds)])})) AS m`);
  for (const row of rows) if (row.id) out.set(row.variantId, row.id);
  return out;
}

/** The supplier each SKU was last ordered from (supplier names are not cost data). */
async function lastSuppliers(db: Db, variantIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!variantIds.length) return out;
  const rows = await db.all<{ variantId: string; supplierId: string }>(sql`
    SELECT pi.variant_id AS variantId, o.supplier_id AS supplierId FROM po_items AS pi JOIN purchase_orders AS o ON o.id = pi.po_id
    WHERE pi.variant_id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(variantIds)])})) AND o.status <> 'cancelled'
    ORDER BY o.created_at DESC, o.id DESC`);
  for (const row of rows) if (!out.has(row.variantId)) out.set(row.variantId, row.supplierId);
  return out;
}

async function demoVariants(db: Db, variantIds: readonly string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const rows = await db.all<{ id: string }>(sql`
    SELECT v.id AS id FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE p.is_demo = 1 AND v.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(variantIds)])}))`);
  return new Set(rows.map((row) => row.id));
}

async function plansFor(db: Db, rows: readonly ReorderRow[], source: SuggestionBasis["source"], ruleId: string | null): Promise<SuggestionPlan[]> {
  const needed = rows.filter((row) => NEEDS.has(row.plan.status) && row.plan.suggestedQty !== null && row.plan.suggestedQty > 0);
  const ids = needed.map((row) => row.variant.id);
  const [arrivals, suppliers, demo] = await Promise.all([lastArrivals(db, ids), lastSuppliers(db, ids), demoVariants(db, ids)]);
  const out: SuggestionPlan[] = [];
  for (const row of needed) {
    const episode = arrivals.get(row.variant.id) ?? "none";
    out.push({
      id: await suggestionIdFor(row.variant.id, episode),
      variantId: row.variant.id,
      sku: row.variant.sku,
      qty: row.plan.suggestedQty as number,
      supplierId: suppliers.get(row.variant.id) ?? null,
      basis: {
        status: row.plan.status,
        available: row.available,
        incoming: row.incoming,
        reorderPoint: row.reorderPoint,
        reorderQty: row.reorderQty,
        sold30: row.sold30,
        sold90: row.sold90,
        rate: { basis: row.rate.basis, perDay: row.rate.perDay, days: row.rate.days },
        daysOfCover: row.plan.daysOfCover,
        stockOutAt: row.plan.stockOutAt,
        demo: demo.has(row.variant.id),
        source,
        ruleId,
      },
    });
  }
  return out;
}

/** 04's reorder rows of every active SKU (all pages), by SKU id: loaded once per run, and only when a rule needs it. */
export async function reorderIndex(db: Db, now: number): Promise<Map<string, ReorderRow>> {
  const out = new Map<string, ReorderRow>();
  const actor = runnerActor();
  for (let page = 1; page <= 200; page++) {
    const result = await listReorder(db, actor, { show: "all", q: "", page }, "ar", now);
    for (const row of result.rows) out.set(row.variant.id, row);
    if (page >= result.pageCount) break;
  }
  return out;
}

/** The suggestion a rule's "suggest a purchase" action makes for one SKU (04's plan for that SKU). */
export async function planSuggestion(db: Db, row: ReorderRow | undefined, ruleId: string): Promise<SuggestionPlan | SuggestionSkip> {
  if (!row) return { skip: "unknown_variant" };
  if (!NEEDS.has(row.plan.status)) return { skip: "not_needed" };
  if (row.plan.suggestedQty === null || row.plan.suggestedQty <= 0) return { skip: "no_quantity" };
  const [plan] = await plansFor(db, [row], "rule", ruleId);
  return plan ?? { skip: "no_quantity" };
}

/** The insert of one planned suggestion (guarded: an id already there fails the batch, which re-plans). */
export function suggestionStatements(db: Db, actor: Actor, plan: SuggestionPlan, now: number, guard: boolean): BatchStatement[] {
  return [
    db
      .insert(reorderSuggestions)
      .values({ id: plan.id, variantId: plan.variantId, locationId: null, supplierId: plan.supplierId, suggestedQty: plan.qty, daysOfCover: plan.basis.daysOfCover, basis: plan.basis, status: "open", createdAt: now })
      .onConflictDoNothing(),
    ...(guard ? [expectChanged(db, 1, { code: "SUGGESTION_EXISTS", detail: plan.id })] : []),
    auditStatement(db, {
      actor,
      action: "automation.suggestion.create",
      entityType: "reorder_suggestion",
      entityId: plan.id,
      summary: `${plan.sku}: ${plan.qty}`,
      after: { variantId: plan.variantId, qty: plan.qty, status: plan.basis.status, daysOfCover: plan.basis.daysOfCover, source: plan.basis.source, ruleId: plan.basis.ruleId ?? null, demo: plan.basis.demo },
      at: now,
    }),
  ];
}

export const isSuggestionExists = (error: unknown) => isDbError(error, "SUGGESTION_EXISTS");

// ───────────────────────────────────────────────────────────────── the scan

export type ScanResult = { checked: number; created: number; reopened: number; existing: number; withoutQuantity: number };

/**
 * Creates the suggestions that 04's numbers call for (the scheduled run calls it as the system; a person with
 * automation.suggestion.approve may "check now"), and opens again a suggestion whose draft order 09 cancelled.
 */
export async function scanStockOuts(db: Db, actor: Actor, now: number): Promise<ScanResult> {
  assertCan(actor, "automation.suggestion.approve");
  const rows = await attentionRows(db, now);
  const plans = await plansFor(db, rows, "scan", null);
  const withoutQuantity = rows.filter((row) => NEEDS.has(row.plan.status) && !(row.plan.suggestedQty !== null && row.plan.suggestedQty > 0)).length;
  if (!plans.length) return { checked: rows.length, created: 0, reopened: 0, existing: 0, withoutQuantity };
  // one bound value for the ids, however many SKUs need stock (D1 binds at most 100 values per statement)
  const existing = await db.all<{ id: string; status: string; purchaseOrderId: string | null; decidedAt: number | null }>(sql`
    SELECT id, status, purchase_order_id AS purchaseOrderId, decided_at AS decidedAt FROM reorder_suggestions WHERE id IN ${idList(plans.map((plan) => plan.id))}`);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const fresh = plans.filter((plan) => !byId.has(plan.id));
  // approved suggestions whose draft the need is still there for: 09 cancelled the draft, or it was never written (a
  // request took the suggestions and stopped before 09 wrote it — released once it cannot still be running)
  const approved = existing.filter((row) => row.status === "approved" && row.purchaseOrderId);
  const drafts = approved.length ? await db.all<{ id: string; status: string }>(sql`SELECT id, status FROM purchase_orders WHERE id IN ${idList(approved.map((row) => row.purchaseOrderId as string))}`) : [];
  const draftStatus = new Map(drafts.map((row) => [row.id, row.status]));
  const reopen = approved
    .map((row) => {
      const status = draftStatus.get(row.purchaseOrderId as string);
      const why = status === "cancelled" ? "draft_order_cancelled" : status === undefined && num(row.decidedAt) <= now - CLAIM_RELEASE_MS ? "draft_order_missing" : null;
      return why ? { ...row, why } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const statements: BatchStatement[] = [];
  for (const plan of fresh) statements.push(...suggestionStatements(db, actor, plan, now, false));
  for (const row of reopen) {
    const plan = plans.find((candidate) => candidate.id === row.id);
    statements.push(
      db
        .update(reorderSuggestions)
        .set({ status: "open", purchaseOrderId: null, decidedBy: null, decidedAt: null, suggestedQty: plan?.qty ?? sql`${reorderSuggestions.suggestedQty}`, basis: plan?.basis ?? sql`${reorderSuggestions.basis}` })
        .where(and(eq(reorderSuggestions.id, row.id), eq(reorderSuggestions.status, "approved"), eq(reorderSuggestions.purchaseOrderId, row.purchaseOrderId as string))),
      auditStatement(db, { actor, action: "automation.suggestion.reopen", entityType: "reorder_suggestion", entityId: row.id, summary: plan?.sku ?? row.id, before: { status: "approved", purchaseOrderId: row.purchaseOrderId }, after: { status: "open" }, reason: row.why, at: now }),
    );
  }
  if (statements.length) {
    if (actor.kind === "employee") statements.push(auditStatement(db, { actor, action: "automation.suggestion.scan", entityType: "reorder_suggestion", entityId: null, summary: `created ${fresh.length}, reopened ${reopen.length}`, after: { checked: rows.length, created: fresh.length, reopened: reopen.length }, at: now }));
    await runBatch(db, statements);
  } else if (actor.kind === "employee") {
    await runBatch(db, [auditStatement(db, { actor, action: "automation.suggestion.scan", entityType: "reorder_suggestion", entityId: null, summary: "nothing new", after: { checked: rows.length, created: 0, reopened: 0 }, at: now })]);
  }
  return { checked: rows.length, created: fresh.length, reopened: reopen.length, existing: plans.length - fresh.length, withoutQuantity };
}

// ───────────────────────────────────────────────────────────────── the list

type ListRow = {
  id: string;
  status: "open" | "approved" | "dismissed" | "ordered";
  variantId: string;
  sku: string;
  title: string | null;
  productName: string;
  qty: number;
  basis: string | null;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  poId: string | null;
  poRef: string | null;
  poStatus: string | null;
};

const viewWhere = (view: SuggestionView) => (view === "all" ? sql`1 = 1` : view === "approved" ? sql`rs.status IN ('approved', 'ordered')` : sql`rs.status = ${view}`);

function parseBasis(value: unknown): SuggestionBasis | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as SuggestionBasis) : (value as SuggestionBasis);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listSuggestions(db: Db, actor: Actor, filters: SuggestionFilters, locale: Locale, now?: number): Promise<SuggestionPage> {
  assertCan(actor, "automation.suggestion.read");
  const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const text = like ? sql`AND (v.sku LIKE ${like} ESCAPE '\\' OR json_extract(p.name, '$.ar') LIKE ${like} ESCAPE '\\' OR json_extract(p.name, '$.en') LIKE ${like} ESCAPE '\\')` : sql``;
  const [rows, countRows, lastJob, lastManual] = await Promise.all([
    db.all<ListRow>(sql`
      SELECT rs.id AS id, rs.status AS status, rs.variant_id AS variantId, v.sku AS sku, v.title AS title, p.name AS productName, rs.suggested_qty AS qty, rs.basis AS basis,
             rs.supplier_id AS supplierId, s.name AS supplierName, rs.created_at AS createdAt, rs.decided_at AS decidedAt, rs.decided_by AS decidedBy,
             po.id AS poId, po.ref AS poRef, po.status AS poStatus
      FROM reorder_suggestions AS rs JOIN variants AS v ON v.id = rs.variant_id JOIN products AS p ON p.id = v.product_id
      LEFT JOIN suppliers AS s ON s.id = rs.supplier_id LEFT JOIN purchase_orders AS po ON po.id = rs.purchase_order_id
      WHERE ${viewWhere(filters.view)} ${text}
      ORDER BY CASE rs.status WHEN 'open' THEN 0 WHEN 'approved' THEN 1 WHEN 'ordered' THEN 2 ELSE 3 END, coalesce(json_extract(rs.basis, '$.daysOfCover'), 1000000000) ASC, rs.created_at DESC, rs.id
      LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ status: string; n: number }>(sql`
      SELECT rs.status AS status, count(*) AS n FROM reorder_suggestions AS rs JOIN variants AS v ON v.id = rs.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE 1 = 1 ${text} GROUP BY rs.status`),
    db.all<{ at: number | null }>(sql`SELECT max(started_at) AS at FROM job_runs WHERE job = 'automation.run' AND status = 'succeeded'`),
    // a person's "check now", or their "run the active rules now" whose scan ran (runAutomation's stats.scanned)
    db.all<{ at: number | null }>(sql`SELECT max(at) AS at FROM audit_events WHERE action = 'automation.suggestion.scan' OR (action = 'automation.rule.run_now' AND json_extract(after, '$.scanned') = 1)`),
  ]);
  const byStatus = new Map(countRows.map((row) => [row.status, num(row.n)]));
  const counts = Object.fromEntries(SUGGESTION_VIEWS.map((view) => [view, 0])) as Record<SuggestionView, number>;
  counts.open = byStatus.get("open") ?? 0;
  counts.approved = (byStatus.get("approved") ?? 0) + (byStatus.get("ordered") ?? 0);
  counts.dismissed = byStatus.get("dismissed") ?? 0;
  counts.all = counts.open + counts.approved + counts.dismissed;
  const total = counts[filters.view];
  const names = await employeeNames(db, rows.map((row) => row.decidedBy));
  const page = rows.map((row): SuggestionRow => {
    const basis = parseBasis(row.basis);
    return {
      id: row.id,
      status: row.status === "ordered" ? "approved" : row.status,
      variant: { id: row.variantId, sku: row.sku, name: skuName(row.productName, row.title, locale) },
      qty: num(row.qty),
      basis,
      supplier: row.supplierId ? { id: row.supplierId, name: row.supplierName ?? "—" } : null,
      createdAt: num(row.createdAt),
      decidedAt: row.decidedAt === null ? null : num(row.decidedAt),
      decidedBy: personOf(names, row.decidedBy),
      dismissReason: (basis as (SuggestionBasis & { dismissReason?: string }) | null)?.dismissReason ?? null,
      order: row.poId ? { id: row.poId, ref: row.poRef, status: row.poStatus, href: recordHref(actor, "purchase_order", { id: row.poId }) } : null,
      demo: basis?.demo === true,
    };
  });
  const lastScanAt = Math.max(num(lastJob[0]?.at), num(lastManual[0]?.at)) || null;
  // the alerts that cannot become a suggestion: 04's reorder page is where a quantity is set (its readers only)
  const withoutQuantity = can(actor, "inventory.stock.read") && now !== undefined ? (await attentionRows(db, now)).filter((row) => NEEDS.has(row.plan.status) && !(row.plan.suggestedQty !== null && row.plan.suggestedQty > 0)).length : null;
  return { rows: page, total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), counts, lastScanAt, withoutQuantity };
}

// ───────────────────────────────────────────────────────────────── from suggestions to a draft purchase order

const IdList = z.array(z.string().regex(/^rsg_[a-z0-9]{10,40}$/, "invalid")).max(MAX_DRAFT_LINES, "too_many");

async function openSuggestions(db: Db, ids: readonly string[]) {
  if (!ids.length) return [];
  return db.all<{ id: string; status: string; variantId: string; sku: string; title: string | null; productName: string; qty: number; supplierId: string | null; basis: string | null; purchaseOrderId: string | null }>(sql`
    SELECT rs.id AS id, rs.status AS status, rs.variant_id AS variantId, v.sku AS sku, v.title AS title, p.name AS productName, rs.suggested_qty AS qty, rs.supplier_id AS supplierId, rs.basis AS basis,
           rs.purchase_order_id AS purchaseOrderId
    FROM reorder_suggestions AS rs JOIN variants AS v ON v.id = rs.variant_id JOIN products AS p ON p.id = v.product_id
    WHERE rs.id IN ${idList(ids)}`);
}

/** What the "draft purchase order" form shows for the chosen open suggestions (automation.suggestion.approve). */
export async function draftOrderForm(db: Db, actor: Actor, rawIds: readonly string[], locale: Locale): Promise<DraftOrderForm> {
  assertCan(actor, "automation.suggestion.approve");
  // a link with ids that are not suggestions (typed by hand, cut short) counts them as skipped, never a failure
  const ids = { data: [...new Set(rawIds)].filter((id) => /^rsg_[a-z0-9]{10,40}$/.test(id)).slice(0, MAX_DRAFT_LINES) };
  const rows = (await openSuggestions(db, ids.data)).filter((row) => row.status === "open");
  const missingPermissions = (["purchasing.po.create", "cost.read", "purchasing.supplier.read"] as const).filter((permission) => !can(actor, permission));
  const withCost = can(actor, "cost.read");
  const lastCosts = new Map<string, { currency: string; minor: number; supplierId: string }>();
  if (withCost && rows.length) {
    const costs = await db.all<{ variantId: string; currency: string; unitCostMinor: number; supplierId: string }>(sql`
      SELECT pi.variant_id AS variantId, o.currency AS currency, pi.unit_cost_minor AS unitCostMinor, o.supplier_id AS supplierId
      FROM po_items AS pi JOIN purchase_orders AS o ON o.id = pi.po_id
      WHERE o.status <> 'cancelled' AND pi.variant_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.variantId))}))
      ORDER BY o.created_at DESC, o.id DESC`);
    for (const cost of costs) if (!lastCosts.has(cost.variantId)) lastCosts.set(cost.variantId, { currency: cost.currency, minor: num(cost.unitCostMinor), supplierId: cost.supplierId });
  }
  const suppliers = can(actor, "purchasing.supplier.read") ? await supplierOptions(db, actor) : [];
  const tree = await locationTree(db);
  const locations = locationOptions(tree).filter((option) => option.isSellable);
  const supplierCounts = new Map<string, number>();
  for (const row of rows) if (row.supplierId) supplierCounts.set(row.supplierId, (supplierCounts.get(row.supplierId) ?? 0) + 1);
  const supplierId = [...supplierCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const supplier = suppliers.find((option) => option.value === supplierId);
  const currency = supplier?.currency ?? "IQD";
  return {
    lines: rows.map((row) => {
      const cost = lastCosts.get(row.variantId);
      return {
        suggestionId: row.id,
        variantId: row.variantId,
        sku: row.sku,
        name: skuName(row.productName, row.title, locale),
        qty: num(row.qty),
        lastUnitCost: withCost && cost ? { currency: cost.currency, minor: cost.minor, decimals: decimalsOf(cost.currency) } : null,
      };
    }),
    suppliers: suppliers.map((option) => ({ value: option.value, label: option.label, currency: option.currency })),
    locations: locations.map((option) => ({ value: option.value, label: option.label })),
    supplierId: supplier ? supplierId : null,
    locationId: locations.some((option) => option.value === DEFAULT_LOCATION_ID) ? DEFAULT_LOCATION_ID : (locations[0]?.value ?? null),
    currency,
    demo: rows.length > 0 && rows.every((row) => parseBasis(row.basis)?.demo === true),
    skipped: new Set(rawIds).size - rows.length,
    missingPermissions,
  };
}

/** Gives back suggestions a draft request took (still linked to its draft id); a failure is left to the next scan. */
async function release(db: Db, taken: readonly string[], draftId: string): Promise<void> {
  if (!taken.length) return;
  await runBatch(db, [
    db
      .update(reorderSuggestions)
      .set({ status: "open", purchaseOrderId: null, decidedBy: null, decidedAt: null })
      .where(and(inArray(reorderSuggestions.id, [...taken]), eq(reorderSuggestions.status, "approved"), eq(reorderSuggestions.purchaseOrderId, draftId))),
  ]).catch(() => undefined);
}

const DraftInput = z.object({
  suggestionIds: IdList.min(1, "nothing_selected"),
  supplierId: z.string().trim().min(1, "required"),
  locationId: z.string().trim().min(1, "required"),
  currency: z.string().trim().min(3, "required").max(3, "invalid"),
  fxRate: z.string().optional(),
  expectedOn: z.string().optional(),
  notes: z.string().optional().default(""),
  lines: z.array(z.object({ suggestionId: z.string(), qty: z.string().optional(), unitCost: z.string().optional() })).max(MAX_DRAFT_LINES, "too_many"),
  idempotencyKey: z.string().trim().min(16, "invalid").max(128, "invalid"),
});

/**
 * Turns open suggestions into ONE draft purchase order through 09's `savePurchaseOrder` (its rules: purchasing.po.create
 * + cost.read, the supplier active, the destination valid, unit costs in the currency's minor units).
 *   1. The suggestions are TAKEN first: "approved", linked to the draft the form's key names (09 derives the draft's id
 *      from the person and the key), guarded on their all being open — of two people at once, or two tabs, one wins
 *      and the other is told (suggestion_changed) before any draft exists.
 *   2. 09 writes the draft. If it refuses (a field, the supplier, a limit), the suggestions are open again at once; a
 *      request that stops between 1 and 2 leaves them to the next scan (CLAIM_RELEASE_MS).
 *   3. The supplier and the audit events, in one batch.
 * Suggestions that are no longer open are refused (suggestion_not_open) — unless every one of them is linked to this
 * very form's draft: a replay, which returns that draft (09's idempotency). Demo suggestions only make a demo order,
 * and never mixed with real ones.
 */
export async function createDraftOrder(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<{ poId: string; ref: string; replayed: boolean; linked: number }> {
  assertCan(actor, "automation.suggestion.approve");
  if (!can(actor, "purchasing.po.create")) throw forbidden("purchasing.po.create");
  if (!can(actor, "cost.read")) throw forbidden("cost.read");
  const parsed = DraftInput.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "_")] ??= /^[a-z_]+$/.test(issue.message) ? issue.message : "invalid";
    if (fields.suggestionIds === "nothing_selected") throw new AppError("nothing_selected", 409);
    throw invalid(fields);
  }
  const input = parsed.data;
  // in the order the form sent them: 09's field errors ("lines.<n>.qty") name the n-th of these
  const found = new Map((await openSuggestions(db, input.suggestionIds)).map((row) => [row.id, row]));
  const rows = [...new Set(input.suggestionIds)].map((id) => found.get(id)).filter((row): row is NonNullable<typeof row> => row !== undefined);
  if (rows.length !== new Set(input.suggestionIds).size) throw new AppError("suggestion_changed", 409);
  const demoFlags = new Set(rows.map((row) => parseBasis(row.basis)?.demo === true));
  if (demoFlags.size > 1) throw new AppError("suggestions_mixed", 409);
  const demo = demoFlags.has(true);
  const lineOf = new Map(input.lines.map((line) => [line.suggestionId, line]));
  // the draft 09 makes for this person and this form (its id comes from the key)
  const draftId = await purchasingIdFromKey("po", actor, input.idempotencyKey);
  const stillOpen = rows.filter((row) => row.status === "open");
  const notOpen = rows.filter((row) => row.status !== "open");
  // only this very form finds its suggestions taken — by its own draft (a replay); anything else is refused
  const replay = notOpen.length > 0 && notOpen.every((row) => row.status === "approved" && row.purchaseOrderId === draftId);
  if (notOpen.length && (stillOpen.length || !replay)) throw new AppError("suggestion_not_open", 409, { detail: notOpen.map((row) => row.id).join(",") });
  const lines = rows.map((row) => {
    const line = lineOf.get(row.id);
    return { code: row.sku, qty: line?.qty?.trim() ? line.qty : String(row.qty), unitCost: line?.unitCost ?? "" };
  });
  const notes = cleanLine(input.notes).slice(0, LIMITS.description);
  const taken = stillOpen.map((row) => row.id);
  if (taken.length) {
    try {
      await runBatch(db, [
        db
          .update(reorderSuggestions)
          .set({ status: "approved", purchaseOrderId: draftId, decidedBy: stampOf(actor), decidedAt: now })
          .where(and(inArray(reorderSuggestions.id, taken), eq(reorderSuggestions.status, "open"))),
        expectChanged(db, taken.length, { code: "SUGGESTION_CHANGED", detail: draftId }),
      ]);
    } catch (error) {
      if (isDbError(error, "SUGGESTION_CHANGED")) throw new AppError("suggestion_changed", 409, { detail: draftId, cause: error });
      throw error;
    }
  }
  let order: Awaited<ReturnType<typeof savePurchaseOrder>>;
  try {
    order = await savePurchaseOrder(
      db,
      actor,
      {
        supplierId: input.supplierId,
        locationId: input.locationId,
        currency: input.currency,
        fxRate: input.fxRate,
        expectedOn: input.expectedOn,
        notes: notes || `اقتراحات إعادة الطلب (${rows.length})`,
        lines,
        idempotencyKey: input.idempotencyKey,
      },
      now,
      locale,
      { demo },
    );
  } catch (error) {
    // 09 refused the draft: what this request took is open again (a failure here is left to the next scan)
    await release(db, taken, draftId);
    throw error;
  }
  if (!taken.length) return { ...order, linked: 0 };
  // 09 already had this form's draft while its suggestions were open: an old form sent again after that draft was
  // cancelled and the suggestions reopened — never linked to the cancelled draft; a fresh form makes a new one
  if (order.replayed) {
    await release(db, taken, draftId);
    throw new AppError("idempotency_mismatch", 409, { detail: order.poId });
  }
  const statements: BatchStatement[] = [
    db
      .update(reorderSuggestions)
      .set({ purchaseOrderId: order.poId, supplierId: input.supplierId })
      .where(and(inArray(reorderSuggestions.id, taken), eq(reorderSuggestions.status, "approved"), eq(reorderSuggestions.purchaseOrderId, draftId))),
    expectChanged(db, taken.length, { code: "SUGGESTION_CHANGED", detail: order.poId }),
    ...stillOpen.map((row) =>
      auditStatement(db, {
        actor,
        action: "automation.suggestion.approve",
        entityType: "reorder_suggestion",
        entityId: row.id,
        summary: `${row.sku} → ${order.ref}`,
        before: { status: "open", qty: num(row.qty) },
        after: { status: "approved", purchaseOrderId: order.poId, qty: parseWhole(lineOf.get(row.id)?.qty) ?? num(row.qty) },
        at: now,
      }),
    ),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "SUGGESTION_CHANGED")) throw new AppError("suggestion_changed", 409, { detail: order.poId, cause: error });
    throw error;
  }
  return { ...order, linked: taken.length };
}

const DismissInput = z.object({ suggestionId: z.string().regex(/^rsg_[a-z0-9]{10,40}$/, "invalid"), reason: z.string().trim().min(3, "reason_required").max(LIMITS.reason, "too_long") });

/** An open suggestion closed by a person, with a reason (automation.suggestion.approve). The same need does not come back until new stock arrives. */
export async function dismissSuggestion(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "automation.suggestion.approve");
  const parsed = DismissInput.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "_")] ??= /^[a-z_]+$/.test(issue.message) ? issue.message : "invalid";
    throw invalid(fields);
  }
  const { suggestionId, reason } = parsed.data;
  const row = await db.select({ id: reorderSuggestions.id, status: reorderSuggestions.status, decidedBy: reorderSuggestions.decidedBy, variantId: reorderSuggestions.variantId, qty: reorderSuggestions.suggestedQty }).from(reorderSuggestions).where(eq(reorderSuggestions.id, suggestionId)).get();
  if (!row) throw new AppError("not_found", 404);
  if (row.status === "dismissed" && row.decidedBy === stampOf(actor)) return { replayed: true };
  if (row.status !== "open") throw new AppError("suggestion_not_open", 409);
  const cleaned = cleanLine(reason);
  try {
    await runBatch(db, [
      db
        .update(reorderSuggestions)
        .set({ status: "dismissed", decidedBy: stampOf(actor), decidedAt: now, basis: sql`json_set(coalesce(${reorderSuggestions.basis}, '{}'), '$.dismissReason', ${cleaned})` })
        .where(and(eq(reorderSuggestions.id, row.id), eq(reorderSuggestions.status, "open"))),
      expectChanged(db, 1, { code: "SUGGESTION_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "automation.suggestion.dismiss", entityType: "reorder_suggestion", entityId: row.id, before: { status: "open", qty: row.qty }, after: { status: "dismissed" }, reason: cleaned, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "SUGGESTION_CHANGED")) throw new AppError("suggestion_changed", 409, { cause: error });
    throw error;
  }
  return { replayed: false };
}

/** Open suggestions (for the module's home and the admin bell), or null without automation.suggestion.read. */
export async function countOpenSuggestions(db: Db, actor: Actor): Promise<number | null> {
  if (!can(actor, "automation.suggestion.read")) return null;
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM reorder_suggestions WHERE status = 'open'`);
  return num(rows[0]?.n);
}

