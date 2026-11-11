/**
 * Suppliers (admin 09.01): the profile — code, names, country, the currency it quotes in, payment terms, promised
 * lead time, contacts, status — and its quality as the rating computes it (09.08, rating.server.ts).
 *
 *   const { supplierId } = await createSupplier(db, actor, { code: "SUP-DXB", name: "…", currency: "USD", … }, now);
 *   await updateSupplier(db, actor, { supplierId, version, …fields }, now);           // stale tab → supplier_changed
 *   await setSupplierStatus(db, actor, { supplierId, status: "blocked", reason }, now);
 *   await saveContact(db, actor, { supplierId, name, role, phone, email, isPrimary }, now);
 *
 * Permissions: purchasing.supplier.read (view), purchasing.supplier.manage (write), purchasing.supplier.rate (a staff
 * review note, kept in the audit trail). A blocked or inactive supplier gets no new orders, quotes or awards; orders
 * already open keep running (receiving, invoices, claims). Nothing here is cost data — order totals on the profile
 * appear only for cost.read.
 * Error codes: forbidden (403), not_found (404), invalid (400), code_taken, supplier_changed (409).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { supplierContacts, suppliers, SUPPLIER_STATUSES, type SupplierStatus } from "~/server/db/schema";
import { expectChanged, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { supplierRatings } from "./rating.server";
import { SUPPLIER_SORTS, isCostCurrency, isLate, normalizeDigits, parseCount, type SupplierRating } from "./rules";
import { actorId, branchCondition, cleanQuery, historyOf, idField, likePattern, optionalText, pageOf, reasonField, type HistoryEntry } from "./shared.server";

export { SUPPLIER_SORTS };
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];
export type SupplierFilters = { q: string; status: SupplierStatus | "all"; sort: SupplierSort; page: number };

export function parseSupplierFilters(params: URLSearchParams): SupplierFilters {
  const status = params.get("status");
  const sort = params.get("sort");
  return {
    q: cleanQuery(params.get("q")),
    status: (SUPPLIER_STATUSES as readonly string[]).includes(status ?? "") ? (status as SupplierStatus) : "all",
    sort: (SUPPLIER_SORTS as readonly string[]).includes(sort ?? "") ? (sort as SupplierSort) : "name",
    page: pageOf(params.get("page")),
  };
}

export type SupplierRow = {
  id: string;
  code: string;
  name: string;
  country: string | null;
  currency: string;
  status: SupplierStatus;
  leadTimeDays: number | null;
  contacts: number;
  openOrders: number;
  rating: Pick<SupplierRating, "score" | "grade" | "enough" | "onTimeRate" | "defectRate" | "receipts">;
};

export type SupplierPage = { rows: SupplierRow[]; total: number; page: number; pageCount: number; counts: Record<SupplierStatus | "all", number> };

const SUPPLIER_PAGE = 25;

export async function listSuppliers(db: Db, actor: Actor, filters: SupplierFilters, now: number): Promise<SupplierPage> {
  assertCan(actor, "purchasing.supplier.read");
  const conditions = [sql`1 = 1`];
  if (filters.q) {
    const like = likePattern(filters.q);
    conditions.push(sql`(s.name LIKE ${like} ESCAPE '\\' OR s.code LIKE ${like} ESCAPE '\\' OR coalesce(s.legal_name, '') LIKE ${like} ESCAPE '\\' OR coalesce(s.country, '') LIKE ${like} ESCAPE '\\' OR coalesce(s.email, '') LIKE ${like} ESCAPE '\\')`);
  }
  const where = sql.join(conditions, sql` AND `);
  const [rows, counts] = await Promise.all([
    db.all<{ id: string; code: string; name: string; country: string | null; currency: string; status: SupplierStatus; leadTimeDays: number | null; contacts: number; openOrders: number }>(sql`
      SELECT s.id AS id, s.code AS code, s.name AS name, s.country AS country, s.currency AS currency, s.status AS status, s.lead_time_days AS leadTimeDays,
             (SELECT count(*) FROM supplier_contacts AS c WHERE c.supplier_id = s.id) AS contacts,
             (SELECT count(*) FROM purchase_orders AS po WHERE po.supplier_id = s.id AND po.status IN ('approved', 'sent', 'partially_received') AND ${branchCondition(actor, sql`po.location_id`)}) AS openOrders
      FROM suppliers AS s
      WHERE ${where} ${filters.status === "all" ? sql`` : sql`AND s.status = ${filters.status}`}
      ORDER BY s.name LIMIT 1000`),
    db.all<{ status: SupplierStatus; n: number }>(sql`SELECT s.status AS status, count(*) AS n FROM suppliers AS s WHERE ${where} GROUP BY s.status`),
  ]);
  const ratings = await supplierRatings(
    db,
    rows.map((row) => row.id),
    now,
  );
  const all: SupplierRow[] = rows.map((row) => {
    const rating = ratings.get(row.id);
    return {
      ...row,
      contacts: Number(row.contacts),
      openOrders: Number(row.openOrders),
      rating: { score: rating?.score ?? null, grade: rating?.grade ?? null, enough: rating?.enough ?? false, onTimeRate: rating?.onTimeRate ?? null, defectRate: rating?.defectRate ?? null, receipts: rating?.receipts ?? 0 },
    };
  });
  const byName = (a: SupplierRow, b: SupplierRow) => a.name.localeCompare(b.name);
  const sorted = [...all].sort((a, b) => {
    switch (filters.sort) {
      case "code":
        return a.code.localeCompare(b.code);
      case "rating":
        return (b.rating.score ?? -1) - (a.rating.score ?? -1) || byName(a, b);
      case "lead":
        return (a.leadTimeDays ?? Number.MAX_SAFE_INTEGER) - (b.leadTimeDays ?? Number.MAX_SAFE_INTEGER) || byName(a, b);
      default:
        return byName(a, b);
    }
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / SUPPLIER_PAGE));
  const page = Math.min(filters.page, pageCount);
  const tally = { all: 0, active: 0, inactive: 0, blocked: 0 } as Record<SupplierStatus | "all", number>;
  for (const row of counts) {
    tally[row.status] = Number(row.n);
    tally.all += Number(row.n);
  }
  return { rows: sorted.slice((page - 1) * SUPPLIER_PAGE, page * SUPPLIER_PAGE), total: sorted.length, page, pageCount, counts: tally };
}

/** Active suppliers for a select box (new order, RFQ quote, claim). */
export async function supplierOptions(db: Db, actor: Actor, options: { includeInactive?: boolean } = {}): Promise<{ value: string; label: string; currency: string; status: SupplierStatus; paymentTerms: string | null }[]> {
  assertCan(actor, "purchasing.supplier.read");
  const rows = await db
    .select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, currency: suppliers.currency, status: suppliers.status, paymentTerms: suppliers.paymentTerms })
    .from(suppliers)
    .where(options.includeInactive ? sql`1 = 1` : eq(suppliers.status, "active"))
    .orderBy(asc(suppliers.name));
  return rows.map((row) => ({ value: row.id, label: `${row.name} · ${row.code}`, currency: row.currency, status: row.status, paymentTerms: row.paymentTerms }));
}

// ───────────────────────────────────────────────────────────────── one supplier

export type ContactView = { id: string; name: string; role: string | null; phone: string | null; email: string | null; isPrimary: boolean; notes: string | null };
export type SupplierOrderRow = { id: string; ref: string; status: string; expectedAt: number | null; late: boolean; createdAt: number; units: number; unitsReceived: number; totalMinor?: number; totalIqd?: number | null };
export type SupplierReview = { at: number; by: string | null; score: number | null; note: string | null };
export type SupplierDetail = {
  supplier: {
    id: string;
    code: string;
    name: string;
    legalName: string | null;
    country: string | null;
    currency: string;
    paymentTerms: string | null;
    leadTimeDays: number | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    status: SupplierStatus;
    isDemo: boolean;
    createdAt: number;
    updatedAt: number;
  };
  contacts: ContactView[];
  rating: SupplierRating;
  orders: SupplierOrderRow[];
  claims: { open: number; total: number };
  reviews: SupplierReview[];
  history: HistoryEntry[];
};

export async function getSupplier(db: Db, actor: Actor, supplierId: string, now: number): Promise<SupplierDetail> {
  assertCan(actor, "purchasing.supplier.read");
  const row = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get();
  if (!row) throw notFound("supplier");
  const withCost = can(actor, "cost.read");
  const [contacts, ratings, orders, claimRows, reviewRows, history] = await Promise.all([
    db.select().from(supplierContacts).where(eq(supplierContacts.supplierId, supplierId)).orderBy(sql`${supplierContacts.isPrimary} DESC`, asc(supplierContacts.name)),
    supplierRatings(db, [supplierId], now),
    db.all<{ id: string; ref: string; status: string; expectedAt: number | null; createdAt: number; units: number; unitsReceived: number; totalMinor: number; totalIqd: number | null }>(sql`
      SELECT po.id AS id, po.ref AS ref, po.status AS status, po.expected_at AS expectedAt, po.created_at AS createdAt, po.total_minor AS totalMinor, po.total_iqd AS totalIqd,
             coalesce((SELECT SUM(qty_ordered) FROM po_items WHERE po_id = po.id), 0) AS units, coalesce((SELECT SUM(qty_received) FROM po_items WHERE po_id = po.id), 0) AS unitsReceived
      FROM purchase_orders AS po WHERE po.supplier_id = ${supplierId} AND ${branchCondition(actor, sql`po.location_id`)} ORDER BY po.created_at DESC LIMIT 20`),
    // Open = not settled yet (open, submitted, accepted), as the claims list counts them.
    db.all<{ open: number; total: number }>(sql`
      SELECT SUM(CASE WHEN c.status IN ('open', 'submitted', 'accepted') THEN 1 ELSE 0 END) AS open, count(*) AS total
      FROM supplier_claims AS c LEFT JOIN purchase_orders AS po ON po.id = c.po_id LEFT JOIN receipts AS r ON r.id = c.receipt_id
      WHERE c.supplier_id = ${supplierId} AND ${branchCondition(actor, sql`coalesce(r.location_id, po.location_id)`)}`),
    db.all<{ at: number; actorId: string | null; after: string | null; reason: string | null }>(sql`
      SELECT at, actor_id AS actorId, after, reason FROM audit_events WHERE action = 'purchasing.supplier.review' AND entity_type = 'supplier' AND entity_id = ${supplierId} ORDER BY seq DESC LIMIT 10`),
    historyOf(db, "supplier", supplierId, 20),
  ]);
  const names = new Map<string, string>();
  if (reviewRows.length > 0) {
    const ids = [...new Set(reviewRows.map((review) => review.actorId).filter((id): id is string => Boolean(id)))];
    if (ids.length > 0) for (const person of await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM employees WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)) names.set(person.id, person.name);
  }
  return {
    supplier: {
      id: row.id,
      code: row.code,
      name: row.name,
      legalName: row.legalName,
      country: row.country,
      currency: row.currency,
      paymentTerms: row.paymentTerms,
      leadTimeDays: row.leadTimeDays,
      phone: row.phone,
      email: row.email,
      address: row.address,
      notes: row.notes,
      status: row.status,
      isDemo: row.isDemo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    contacts: contacts.map((contact) => ({ id: contact.id, name: contact.name, role: contact.role, phone: contact.phone, email: contact.email, isPrimary: contact.isPrimary, notes: contact.notes })),
    rating: ratings.get(supplierId)!,
    orders: orders.map((order) => {
      const base: SupplierOrderRow = { id: order.id, ref: order.ref, status: order.status, expectedAt: order.expectedAt, late: isLate(order, now), createdAt: order.createdAt, units: Number(order.units), unitsReceived: Number(order.unitsReceived) };
      return withCost ? { ...base, totalMinor: order.totalMinor, totalIqd: order.totalIqd } : base;
    }),
    claims: { open: Number(claimRows[0]?.open ?? 0), total: Number(claimRows[0]?.total ?? 0) },
    reviews: reviewRows.map((review) => {
      let after: { score?: number; note?: string } = {};
      try {
        after = review.after ? (JSON.parse(review.after) as typeof after) : {};
      } catch {
        after = {};
      }
      return { at: review.at, by: review.actorId ? (names.get(review.actorId) ?? null) : null, score: typeof after.score === "number" ? after.score : null, note: review.reason ?? after.note ?? null };
    }),
    history,
  };
}

// ───────────────────────────────────────────────────────────────── writes

const phoneField = z
  .string()
  .trim()
  .max(40, "too_long")
  .transform((value) => normalizeDigits(value).replace(/\s+/g, " ").trim())
  .refine((value) => value === "" || /^[+0-9][0-9 ()-]{4,39}$/.test(value), "phone_invalid")
  .optional()
  .transform((value) => (value ? value : null));
const emailField = z
  .string()
  .trim()
  .max(200, "too_long")
  .refine((value) => value === "" || z.email().safeParse(value).success, "email_invalid")
  .optional()
  .transform((value) => (value ? value.toLowerCase() : null));
const leadField = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value, ctx) => {
    const parsed = parseCount(value);
    if (parsed === undefined) return null;
    if (Number.isNaN(parsed) || parsed > 365) {
      ctx.addIssue({ code: "custom", message: Number.isNaN(parsed) ? "invalid" : "too_big" });
      return z.NEVER;
    }
    return parsed;
  });

export const SupplierInput = z.object({
  code: z
    .string({ error: "required" })
    .trim()
    .transform((value) => normalizeDigits(value).toUpperCase())
    .pipe(z.string().min(1, "required").regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "code_invalid")),
  name: z.string({ error: "required" }).trim().min(2, "too_short").max(120, "too_long"),
  legalName: optionalText(160),
  country: optionalText(60),
  currency: z.string({ error: "required" }).trim().toUpperCase().refine(isCostCurrency, "invalid"),
  paymentTerms: optionalText(120),
  leadTimeDays: leadField,
  phone: phoneField,
  email: emailField,
  address: optionalText(300),
  notes: optionalText(1000),
});

const auditView = (row: z.output<typeof SupplierInput>) => ({ ...row });

/** Creates a supplier (status active). A code already in use → code_taken. */
export async function createSupplier(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ supplierId: string }> {
  assertCan(actor, "purchasing.supplier.manage");
  const input = SupplierInput.parse(raw);
  const taken = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.code, input.code)).get();
  if (taken) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
  const supplierId = newId("sup");
  try {
    await runBatch(db, [
      db.insert(suppliers).values({ id: supplierId, ...input, status: "active", isDemo: options.demo ?? false, createdAt: now, updatedAt: now }),
      auditStatement(db, { actor, action: "purchasing.supplier.create", entityType: "supplier", entityId: supplierId, summary: `${input.code} · ${input.name}`, after: auditView(input), at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "suppliers.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
    throw toAppError(error) ?? error;
  }
  return { supplierId };
}

export const UpdateSupplierInput = SupplierInput.extend({
  supplierId: idField,
  version: z.coerce.number().int(),
  reason: z.string().trim().max(500, "too_long").optional(),
});

/** Edits the profile; `version` is the updated_at the form was built on (a newer save in between → supplier_changed). */
export async function updateSupplier(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "purchasing.supplier.manage");
  const input = UpdateSupplierInput.parse(raw);
  const row = await db.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!row) throw notFound("supplier");
  if (row.updatedAt !== input.version) throw new AppError("supplier_changed", 409);
  const { supplierId, version, reason, ...fields } = input;
  const before = { code: row.code, name: row.name, legalName: row.legalName, country: row.country, currency: row.currency, paymentTerms: row.paymentTerms, leadTimeDays: row.leadTimeDays, phone: row.phone, email: row.email, address: row.address, notes: row.notes };
  const changed = (Object.keys(before) as (keyof typeof before)[]).some((key) => before[key] !== fields[key]);
  if (!changed) return { changed: false };
  if (fields.code !== row.code) {
    const taken = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.code, fields.code)).get();
    if (taken && taken.id !== supplierId) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
  }
  try {
    await runBatch(db, [
      db
        .update(suppliers)
        .set({ ...fields, updatedAt: now })
        .where(and(eq(suppliers.id, supplierId), eq(suppliers.updatedAt, version))),
      expectChanged(db, 1, { code: "SUPPLIER_CHANGED", detail: supplierId }),
      auditStatement(db, { actor, action: "purchasing.supplier.update", entityType: "supplier", entityId: supplierId, summary: `${fields.code} · ${fields.name}`, before, after: fields, reason: reason || null, at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "suppliers.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
    throw toAppError(error) ?? error;
  }
  return { changed: true };
}

export const SupplierStatusInput = z.object({ supplierId: idField, status: z.enum(SUPPLIER_STATUSES, { error: "invalid" }), reason: reasonField });

/** Active, inactive or blocked, always with a reason (audited). */
export async function setSupplierStatus(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "purchasing.supplier.manage");
  const input = SupplierStatusInput.parse(raw);
  const row = await db.select({ id: suppliers.id, status: suppliers.status, code: suppliers.code }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!row) throw notFound("supplier");
  if (row.status === input.status) return { changed: false };
  await runBatch(db, [
    db
      .update(suppliers)
      .set({ status: input.status, updatedAt: now })
      .where(and(eq(suppliers.id, row.id), eq(suppliers.status, row.status))),
    expectChanged(db, 1, { code: "SUPPLIER_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "purchasing.supplier.status", entityType: "supplier", entityId: row.id, summary: row.code, before: { status: row.status }, after: { status: input.status }, reason: input.reason, at: now }),
  ]).catch((error) => {
    throw toAppError(error) ?? error;
  });
  return { changed: true };
}

export const ContactInput = z.object({
  supplierId: idField,
  contactId: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "invalid").optional(),
  name: z.string({ error: "required" }).trim().min(2, "too_short").max(120, "too_long"),
  role: optionalText(80),
  phone: phoneField,
  email: emailField,
  isPrimary: z.boolean().optional().default(false),
  notes: optionalText(300),
});

const MAX_CONTACTS = 20;

/** Adds or edits a contact person; one primary contact per supplier (marking one unmarks the others). */
export async function saveContact(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ contactId: string }> {
  assertCan(actor, "purchasing.supplier.manage");
  const input = ContactInput.parse(raw);
  const supplier = await db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!supplier) throw notFound("supplier");
  const existing = input.contactId ? await db.select().from(supplierContacts).where(and(eq(supplierContacts.id, input.contactId), eq(supplierContacts.supplierId, supplier.id))).get() : undefined;
  if (input.contactId && !existing) throw notFound("contact");
  if (!existing) {
    const count = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM supplier_contacts WHERE supplier_id = ${supplier.id}`);
    if (Number(count[0]?.n ?? 0) >= MAX_CONTACTS) throw invalid({ name: "too_many" });
  }
  const contactId = existing?.id ?? newId("spc");
  const values = { name: input.name, role: input.role, phone: input.phone, email: input.email, isPrimary: input.isPrimary, notes: input.notes };
  const statements: BatchStatement[] = [];
  if (input.isPrimary) statements.push(db.update(supplierContacts).set({ isPrimary: false }).where(eq(supplierContacts.supplierId, supplier.id)));
  statements.push(
    existing ? db.update(supplierContacts).set(values).where(eq(supplierContacts.id, contactId)) : db.insert(supplierContacts).values({ id: contactId, supplierId: supplier.id, ...values }),
    db.update(suppliers).set({ updatedAt: now }).where(eq(suppliers.id, supplier.id)),
    auditStatement(db, { actor, action: existing ? "purchasing.supplier.contact.update" : "purchasing.supplier.contact.add", entityType: "supplier", entityId: supplier.id, summary: `${supplier.code} · ${input.name}`, before: existing ? { name: existing.name, role: existing.role, phone: existing.phone, email: existing.email, isPrimary: existing.isPrimary } : null, after: values, at: now }),
  );
  await runBatch(db, statements);
  return { contactId };
}

export const RemoveContactInput = z.object({ supplierId: idField, contactId: idField });

export async function removeContact(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "purchasing.supplier.manage");
  const input = RemoveContactInput.parse(raw);
  const contact = await db.select().from(supplierContacts).where(and(eq(supplierContacts.id, input.contactId), eq(supplierContacts.supplierId, input.supplierId))).get();
  if (!contact) throw notFound("contact");
  await runBatch(db, [
    db.delete(supplierContacts).where(eq(supplierContacts.id, contact.id)),
    db.update(suppliers).set({ updatedAt: now }).where(eq(suppliers.id, input.supplierId)),
    auditStatement(db, { actor, action: "purchasing.supplier.contact.remove", entityType: "supplier", entityId: input.supplierId, summary: contact.name, before: { name: contact.name, role: contact.role, phone: contact.phone, email: contact.email }, at: now }),
  ]);
}

export const ReviewInput = z.object({
  supplierId: idField,
  score: z.union([z.string(), z.number()]).transform((value, ctx) => {
    const parsed = parseCount(value);
    if (parsed === undefined || Number.isNaN(parsed) || parsed < 1 || parsed > 5) {
      ctx.addIssue({ code: "custom", message: parsed === undefined ? "required" : "invalid" });
      return z.NEVER;
    }
    return parsed;
  }),
  note: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

/**
 * A staff review of the supplier (purchasing.supplier.rate): a 1–5 score and what it is based on, kept in the audit
 * trail next to the computed rating — labelled as a person's judgement, never mixed into the computed score.
 */
export async function reviewSupplier(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "purchasing.supplier.rate");
  const input = ReviewInput.parse(raw);
  const supplier = await db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!supplier) throw notFound("supplier");
  await runBatch(db, [auditStatement(db, { actor, action: "purchasing.supplier.review", entityType: "supplier", entityId: supplier.id, summary: `${supplier.code} · ${input.score}/5`, after: { score: input.score, by: actorId(actor) }, reason: input.note, at: now })]);
}

/** For forms: the supplier's row (404 when it does not exist). */
export async function supplierRow(db: Db, supplierId: string) {
  const row = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get();
  if (!row) throw notFound("supplier");
  return row;
}

export type { SupplierRating };
export type SupplierLocaleView = { locale: Locale };
