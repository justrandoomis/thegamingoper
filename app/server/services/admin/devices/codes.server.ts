/**
 * Admin module 13 — digital products (13.06) and their codes (13.07).
 *
 *   const overview = await digitalOverview(db, actor, locale);                 // discs, cartridges, codes, subscriptions…
 *   const page = await listCodes(db, actor, variantId, { status, page }, locale);
 *   await importCodes(db, actor, dataKey, { variantId, codes, expiresOn?, unitCostIqd? }, now);
 *   const { code } = await revealCode(db, actor, dataKey, { codeId, reason }, now);   // audited, rate-limited
 *   await revokeCode(db, actor, { codeId, reason }, now);
 *
 * 13.06 reads the catalogue's own facts together — products.kind, media_format (physical | digital) and license_type
 * (game_key | dlc | subscription | wallet_topup | account) — into one delivery class per product (disc, cartridge,
 * code, subscription, wallet top-up, DLC, account), and lists the products whose facts disagree (a digital product
 * without a licence type, a game without a format, a licence type on a physical product). The facts are edited in the
 * catalogue (module 02).
 *
 * 13.07: a code is stored ENCRYPTED (AES-256-GCM with DATA_KEY, bound to its row: context "digital_code:<id>"); its
 * sha256 over the normalized text (upper case, no spaces or dashes) only finds duplicates — the same code is never
 * stored twice. Lists never carry the text. Revealing it to staff needs devices.digital_code.manage AND the field
 * permission digital_code.reveal, a reason, and a code someone has paid for: delivered on a paid order line that was
 * not refunded (`code_unpaid` for unsold stock, unpaid orders and refunded lines) — codes are never revealed before
 * payment; every reveal is an audit event (without the code) and counts against a per-employee limit. A unit cost [P]
 * is entered and shown only with cost.read.
 *
 * Errors: forbidden, not_found, invalid (fields: codes = required | too_many | too_long, expiresOn, unitCostIqd),
 * not_digital, code_unpaid, code_not_revealable, code_not_available, rate_limited.
 */
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { decryptSecret, encryptSecret } from "~/server/crypto.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { digitalCodes, orderItems, orders, products, variants, type DigitalCodeStatus, type LicenseType, type MediaFormat } from "~/server/db/schema";
import { chunkRows, expectChanged, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, rateLimited, zodFieldErrors } from "~/server/errors";
import { limitKey, rateLimit } from "~/server/ratelimit.server";
import { cleanLine } from "~/server/text.server";
import { BAGHDAD_OFFSET_MS, DAY_MS, DEVICES_PERMISSIONS, ID, PAGE_SIZE, assertAny, employeeNames, variantLabel } from "./shared.server";
import { CODE_STATUS_LIST, MAX_CODES_PER_IMPORT, MAX_CODE_LENGTH, latinDigits, type ClassRow, type CodePage, type CodeRow, type DeliveryClass, type DigitalOverview, type DigitalVariantRow, type UnclassifiedRow } from "./types";

export const CODE_ERROR_KEYS = ["not_digital", "code_unpaid", "code_not_revealable", "code_not_available", "too_many"] as const;

/** Staff reveals per employee: generous for real work, tight for someone harvesting codes. */
export const REVEAL_LIMIT = { limit: 20, windowSec: 10 * 60 } as const;

/** The encryption context of a code: a ciphertext copied into another row does not decrypt. */
export const codeContext = (codeId: string) => `digital_code:${codeId}`;

/** "abcd-efgh 1234" → "ABCDEFGH1234" — what duplicates are compared on. */
export function normalizeCode(raw: string): string {
  return latinDigits(raw).toUpperCase().replace(/[\s-]+/g, "");
}

/** The delivery class of a product (pure). */
export function deliveryClass(input: { kind: string; mediaFormat: MediaFormat | null; licenseType: LicenseType | null; platformSlug?: string | null }): DeliveryClass {
  if (input.licenseType === "subscription") return "subscription";
  if (input.licenseType === "wallet_topup") return "wallet_topup";
  if (input.licenseType === "dlc") return "dlc";
  if (input.licenseType === "account") return "account";
  if (input.licenseType === "game_key" || (input.kind === "digital" && input.mediaFormat === "digital")) return "code";
  if (input.kind === "game" && input.mediaFormat === "physical") return input.platformSlug === "nintendo" ? "cartridge" : "disc";
  return "unclassified";
}

const PAID = ["paid", "partially_refunded", "refunded"] as const;

/**
 * Has someone paid for this code (pure)? It was delivered on an order line, the order is paid (or partly refunded),
 * and that line was not refunded in full. Only then may staff reveal it again (13.07 "never revealed before payment").
 */
export function codePaidFor(row: { status: string; orderItemId: string | null; paymentStatus: string | null; lineQty: number | null; lineRefunded: number | null }): boolean {
  if (row.status !== "delivered") return false;
  if (!row.orderItemId || (row.paymentStatus !== "paid" && row.paymentStatus !== "partially_refunded")) return false;
  return (row.lineRefunded ?? 0) < (row.lineQty ?? 0);
}

export async function digitalOverview(db: Db, actor: Actor, locale: Locale): Promise<DigitalOverview> {
  assertAny(actor, DEVICES_PERMISSIONS);
  const rows = await db.all<{ id: string; name: string; kind: string; media_format: MediaFormat | null; license_type: LicenseType | null; platform: string | null; variants: number }>(sql`
    SELECT p.id, p.name, p.kind, p.media_format, p.license_type, pl.slug AS platform,
      (SELECT count(*) FROM variants AS v WHERE v.product_id = p.id) AS variants
    FROM products AS p LEFT JOIN platforms AS pl ON pl.id = p.platform_id
    WHERE p.kind IN ('game', 'digital') AND p.status <> 'archived'
    ORDER BY p.kind, p.slug`);
  const classes = new Map<DeliveryClass, ClassRow>();
  const problems: UnclassifiedRow[] = [];
  for (const row of rows) {
    const cls = deliveryClass({ kind: row.kind, mediaFormat: row.media_format, licenseType: row.license_type, platformSlug: row.platform });
    const entry = classes.get(cls) ?? { cls, products: 0, variants: 0 };
    entry.products += 1;
    entry.variants += Number(row.variants);
    classes.set(cls, entry);
    const name = pick(JSON.parse(row.name), locale);
    if (row.kind === "digital" && !row.license_type) problems.push({ productId: row.id, name, kind: row.kind, problem: "digital_without_license" });
    else if (row.kind === "game" && !row.media_format) problems.push({ productId: row.id, name, kind: row.kind, problem: "game_without_format" });
    else if (row.license_type && row.media_format === "physical") problems.push({ productId: row.id, name, kind: row.kind, problem: "license_on_physical" });
  }
  const variantRows = await db
    .select({ variantId: variants.id, productId: products.id, sku: variants.sku, title: variants.title, name: products.name, kind: products.kind, mediaFormat: products.mediaFormat, licenseType: products.licenseType, isActive: variants.isActive })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(sql`(${products.kind} = 'digital' OR ${products.mediaFormat} = 'digital')`, sql`${products.status} <> 'archived'`))
    .orderBy(asc(products.slug), asc(variants.sort))
    .limit(300);
  const codeCounts = await db.select({ variantId: digitalCodes.variantId, status: digitalCodes.status, n: count() }).from(digitalCodes).groupBy(digitalCodes.variantId, digitalCodes.status);
  const byVariant = new Map<string, DigitalVariantRow["codes"]>();
  for (const row of codeCounts) {
    const entry = byVariant.get(row.variantId) ?? {};
    entry[row.status] = Number(row.n);
    byVariant.set(row.variantId, entry);
  }
  const order: DeliveryClass[] = ["disc", "cartridge", "code", "dlc", "subscription", "wallet_topup", "account", "unclassified"];
  return {
    classes: order.map((cls) => classes.get(cls)).filter((entry): entry is ClassRow => Boolean(entry)),
    variants: variantRows.map((row) => ({
      variantId: row.variantId,
      productId: row.productId,
      name: variantLabel(row.name, row.title, locale),
      sku: row.sku,
      cls: deliveryClass({ kind: row.kind, mediaFormat: row.mediaFormat, licenseType: row.licenseType }),
      licenseType: row.licenseType,
      isActive: row.isActive,
      codes: byVariant.get(row.variantId) ?? {},
    })),
    problems,
    canManage: can(actor, "devices.digital_code.manage"),
    canEditCatalog: can(actor, "catalog.product.update"),
  };
}

async function digitalVariant(db: Db, variantId: string) {
  const row = ID.test(variantId)
    ? await db
        .select({ id: variants.id, sku: variants.sku, title: variants.title, name: products.name, kind: products.kind, licenseType: products.licenseType, mediaFormat: products.mediaFormat, isActive: variants.isActive })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(eq(variants.id, variantId))
        .get()
    : undefined;
  if (!row) throw notFound("variant");
  return row;
}

export async function listCodes(db: Db, actor: Actor, variantId: string, filters: { status: DigitalCodeStatus | null; page: number }, locale: Locale): Promise<CodePage> {
  assertCan(actor, "devices.digital_code.manage");
  const variant = await digitalVariant(db, variantId);
  const withCost = can(actor, "cost.read");
  const where = filters.status ? and(eq(digitalCodes.variantId, variant.id), eq(digitalCodes.status, filters.status)) : eq(digitalCodes.variantId, variant.id);
  const [rows, totals, counts] = await Promise.all([
    db
      .select({
        id: digitalCodes.id,
        status: digitalCodes.status,
        createdAt: digitalCodes.createdAt,
        createdBy: digitalCodes.createdBy,
        expiresAt: digitalCodes.expiresAt,
        deliveredAt: digitalCodes.deliveredAt,
        revealCount: digitalCodes.revealCount,
        isDemo: digitalCodes.isDemo,
        costIqd: digitalCodes.costIqd,
        orderItemId: digitalCodes.orderItemId,
        orderRef: orders.ref,
        paymentStatus: orders.paymentStatus,
        lineQty: orderItems.qty,
        lineRefunded: orderItems.refundedQty,
      })
      .from(digitalCodes)
      .leftJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
      .leftJoin(orders, eq(orders.id, orderItems.orderId))
      .where(where)
      .orderBy(desc(digitalCodes.createdAt), desc(digitalCodes.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(digitalCodes).where(where),
    db.select({ status: digitalCodes.status, n: count() }).from(digitalCodes).where(eq(digitalCodes.variantId, variant.id)).groupBy(digitalCodes.status),
  ]);
  const names = await employeeNames(db, rows.map((row) => row.createdBy));
  const total = Number(totals[0]?.n ?? 0);
  return {
    variant: { id: variant.id, sku: variant.sku, name: variantLabel(variant.name, variant.title, locale), licenseType: variant.licenseType, mediaFormat: variant.mediaFormat, isActive: variant.isActive },
    rows: rows.map((row) => {
      const out: CodeRow = {
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
        expiresAt: row.expiresAt,
        orderRef: row.orderRef ?? null,
        orderPaid: row.paymentStatus ? (PAID as readonly string[]).includes(row.paymentStatus) : false,
        revealable: codePaidFor(row),
        deliveredAt: row.deliveredAt,
        revealCount: row.revealCount,
        isDemo: row.isDemo,
      };
      if (withCost) out.costIqd = row.costIqd;
      return out;
    }),
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.n)])) as CodePage["counts"],
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    status: filters.status,
    withCost,
    canReveal: can(actor, "digital_code.reveal"),
  };
}

export const ImportCodesInput = z.object({
  variantId: z.string({ error: "required" }).regex(ID, "invalid"),
  /** One code per line (spaces at the ends ignored, empty lines skipped). */
  codes: z.string({ error: "required" }).max(MAX_CODES_PER_IMPORT * (MAX_CODE_LENGTH + 2), "too_long"),
  /** Optional: the codes stop working at the end of this Baghdad day. */
  expiresOn: z.preprocess((value) => (value === "" || value === null ? undefined : typeof value === "string" ? latinDigits(value).trim() : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid").optional()),
  /** [P] What one code cost the store, integer IQD — only with cost.read. */
  unitCostIqd: z.preprocess((value) => {
    if (value === "" || value === null || value === undefined) return undefined;
    if (typeof value === "number") return value;
    const digits = latinDigits(String(value)).replace(/[,\s٬،]/g, "");
    return /^\d{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
  }, z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(100_000_000, "too_big").optional()),
});

/**
 * Stores codes for a digital variant, encrypted (devices.digital_code.manage). A code already in the store (here or
 * for any other variant) is skipped and counted, never stored twice. One audit event per import, without the codes.
 */
export async function importCodes(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ added: number; duplicates: number }> {
  assertCan(actor, "devices.digital_code.manage");
  const parsed = ImportCodesInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "codes.import");
  const input = parsed.data;
  if (input.unitCostIqd !== undefined && !can(actor, "cost.read")) throw forbidden("cost.read");
  const variant = await digitalVariant(db, input.variantId);
  if (variant.kind !== "digital" && variant.mediaFormat !== "digital") throw new AppError("not_digital", 409);
  const lines = input.codes
    .split(/\r?\n/)
    .map((line) => cleanLine(line).trim())
    .filter(Boolean);
  if (lines.length === 0) throw invalid({ codes: "required" });
  if (lines.length > MAX_CODES_PER_IMPORT) throw invalid({ codes: "too_many" });
  if (lines.some((line) => line.length > MAX_CODE_LENGTH || normalizeCode(line).length < 4)) throw invalid({ codes: "code_invalid" });
  let expiresAt: number | null = null;
  if (input.expiresOn) {
    const start = Date.parse(`${input.expiresOn}T00:00:00Z`);
    if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== input.expiresOn) throw invalid({ expiresOn: "invalid" });
    expiresAt = start - BAGHDAD_OFFSET_MS + DAY_MS - 1;
    if (expiresAt <= now) throw invalid({ expiresOn: "expires_past" });
  }
  // The same code twice in one paste counts once.
  const unique = new Map<string, string>();
  for (const line of lines) {
    const normalized = normalizeCode(line);
    if (!unique.has(normalized)) unique.set(normalized, line);
  }
  const prepared: (typeof digitalCodes.$inferInsert)[] = [];
  for (const [normalized, original] of unique) {
    const id = newId("dgc");
    prepared.push({
      id,
      variantId: variant.id,
      codeEnc: await encryptSecret(original, dataKey, codeContext(id)),
      codeHash: await sha256Hex(`tamtam.digital_code.v1|${normalized}`),
      status: "available",
      costIqd: input.unitCostIqd ?? null,
      expiresAt,
      isDemo: options.demo ?? false,
      createdBy: actor.kind === "employee" ? actor.id : null,
      createdAt: now,
    });
  }
  const hashes = prepared.map((row) => row.codeHash);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += 90) {
    const found = await db.select({ hash: digitalCodes.codeHash }).from(digitalCodes).where(inArray(digitalCodes.codeHash, hashes.slice(i, i + 90)));
    for (const row of found) existing.add(row.hash);
  }
  const fresh = prepared.filter((row) => !existing.has(row.codeHash));
  const statements: BatchStatement[] = [];
  for (const rows of chunkRows(digitalCodes, fresh)) statements.push(db.insert(digitalCodes).values(rows).onConflictDoNothing({ target: digitalCodes.codeHash }));
  statements.push(
    auditStatement(db, {
      actor,
      action: "devices.digital_code.import",
      entityType: "variant",
      entityId: variant.id,
      summary: variant.sku,
      after: { added: fresh.length, duplicates: lines.length - fresh.length, expiresAt, withCost: input.unitCostIqd !== undefined },
      at: now,
    }),
  );
  await runBatch(db, statements);
  // A code that arrived through another import meanwhile was skipped by the unique hash: count what is really stored.
  let added = 0;
  const ids = fresh.map((row) => row.id as string);
  for (let i = 0; i < ids.length; i += 90) added += Number((await db.select({ n: count() }).from(digitalCodes).where(inArray(digitalCodes.id, ids.slice(i, i + 90))).get())?.n ?? 0);
  return { added, duplicates: lines.length - added };
}

export const RevealInput = z.object({ codeId: z.string({ error: "required" }).regex(ID, "invalid"), variantId: z.string().regex(ID, "invalid").optional(), reason: z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "reason_short").max(300, "too_long") });

/**
 * The plain text of one code, for staff who may see it (devices.digital_code.manage + digital_code.reveal), with a
 * reason — e.g. a buyer who lost it. Only a code someone has PAID for (13.07 "never revealed before payment"):
 * delivered on an order line whose order is paid and which was not refunded in full (`codePaidFor`). An unsold code
 * (available, no order), a code held for an unpaid order, and a revoked or expired code stay sealed. Every reveal is
 * audited (code id, order, reason — never the code) and limited per employee.
 */
export async function revealCode(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ code: string }> {
  assertCan(actor, "devices.digital_code.manage");
  assertCan(actor, "digital_code.reveal");
  const parsed = RevealInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "codes.reveal");
  const input = parsed.data;
  const row = await db
    .select({ id: digitalCodes.id, variantId: digitalCodes.variantId, codeEnc: digitalCodes.codeEnc, status: digitalCodes.status, orderItemId: digitalCodes.orderItemId, orderRef: orders.ref, paymentStatus: orders.paymentStatus, lineQty: orderItems.qty, lineRefunded: orderItems.refundedQty })
    .from(digitalCodes)
    .leftJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
    .leftJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(digitalCodes.id, input.codeId))
    .get();
  // A page acts on its own variant's codes only: another variant's code is the same 404 as an unknown one.
  if (!row || (input.variantId && row.variantId !== input.variantId)) throw notFound("digital_code");
  if (row.status === "revoked" || row.status === "expired") throw new AppError("code_not_revealable", 409);
  // Nobody has paid for a code that is on no order (unsold stock), on an order that is not paid, or on a line whose
  // money went back: sealed.
  if (!codePaidFor(row)) throw new AppError("code_unpaid", 409);
  const verdict = await rateLimit(db, await limitKey("code-reveal", "employee", actor.kind === "employee" ? actor.id : "system"), REVEAL_LIMIT, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
  const code = await decryptSecret(row.codeEnc, dataKey, codeContext(row.id));
  await runBatch(db, [auditStatement(db, { actor, action: "devices.digital_code.reveal", entityType: "digital_code", entityId: row.id, after: { variantId: row.variantId, status: row.status, orderRef: row.orderRef ?? null }, reason: input.reason, at: now })]);
  return { code };
}

export const RevokeInput = z.object({ codeId: z.string({ error: "required" }).regex(ID, "invalid"), variantId: z.string().regex(ID, "invalid").optional(), reason: z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "reason_short").max(300, "too_long") });

/** Takes an unused code out of sale for good (devices.digital_code.manage): faulty, leaked, returned to the supplier. */
export async function revokeCode(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "devices.digital_code.manage");
  const parsed = RevokeInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "codes.revoke");
  const input = parsed.data;
  const row = await db.select({ id: digitalCodes.id, status: digitalCodes.status, variantId: digitalCodes.variantId }).from(digitalCodes).where(eq(digitalCodes.id, input.codeId)).get();
  if (!row || (input.variantId && row.variantId !== input.variantId)) throw notFound("digital_code");
  if (row.status === "revoked") return { replayed: true };
  if (row.status !== "available") throw new AppError("code_not_available", 409);
  await runBatch(db, [
    db.update(digitalCodes).set({ status: "revoked" }).where(and(eq(digitalCodes.id, row.id), eq(digitalCodes.status, "available"))),
    expectChanged(db, 1, { code: "CODE_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "devices.digital_code.revoke", entityType: "digital_code", entityId: row.id, before: { status: "available" }, after: { status: "revoked", variantId: row.variantId }, reason: input.reason, at: now }),
  ]).catch((error: unknown) => {
    if (String((error as Error)?.message ?? "").includes("CODE_CHANGED")) throw new AppError("code_not_available", 409, { cause: error });
    throw error;
  });
  return { replayed: false };
}

export const CODE_STATUSES = CODE_STATUS_LIST;
