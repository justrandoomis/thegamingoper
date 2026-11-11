/**
 * Admin module 13 — used units: from intake to the shop window (13.02 inspection, 13.08 ownership and wipe, 13.09
 * grading, actual-condition photos, listing).
 *
 *   const page = await listUsedUnits(db, actor, parseUsedFilters(url.searchParams), locale);
 *   const unit = await getUsedUnitDetail(db, actor, id, locale, { file });
 *   await saveUnitChecklist(db, actor, { usedUnitId, templateId, answers }, now);
 *   await saveUnitGrading(db, actor, { usedUnitId, grade, cosmeticNotes, defects, included, warrantyDays }, now);
 *   await confirmUnitChecks(db, actor, { usedUnitId, ownership, wipe, note }, now);
 *   await setPhotoReal(db, store, actor, { usedUnitId, mediaId, real }, now);       // "this is a photo of THIS unit"
 *   await listUnit(db, store, actor, { usedUnitId }, now);                          // publishes the real photos
 *
 * A unit's life: intake (arrived) → testing (checklist started) → ready (checklist complete with no critical failure,
 * grade, ownership checked, data wiped) → listed → reserved / sold (the commerce core) → returned (module 12) → a
 * re-inspection starts it again (checklist reopened, the wipe confirmed again). Listing also needs a price (pricing 03:
 * setUsedUnitPrice), Arabic condition notes and at least one photo staff confirmed shows THIS unit; the database
 * refuses a real unit listed without a real photo, a completed checklist, the ownership check and the wipe
 * (TT:USED_UNIT_NOT_LISTABLE), and a listed unit losing its last real photo.
 *
 * Photos: private uploads (kind "used_photo"), each a `media` row with is_illustration = 1 until a person marks it
 * as a real photo of this unit (is_illustration = 0); only those are made public — when the unit is listed, or at
 * once for a listed unit. The storefront labels everything else «صورة توضيحية».
 *
 * Fields: the acquisition cost [P] only with cost.read; the margin only with cost.read and profit.read; serial numbers
 * only for staff who handle the device (registry, inspection, ownership checks). Branch-limited employees work on
 * units at their branch's locations.
 *
 * Errors: forbidden, not_found, invalid (fields), unit_changed, unit_not_editable, unit_returned_reinspect,
 * unit_not_returned, unit_not_ready, unit_not_listed, unit_reserved, not_listable (+ the blocker keys), last_real_photo,
 * photo_limit, template_invalid.
 */
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  approvals,
  auditEvents,
  compatibilityRules,
  deviceGenerations,
  deviceModels,
  files,
  inventoryLocations,
  media,
  orderItems,
  orders,
  platforms,
  products,
  serials,
  tradeIns,
  usedUnits,
  variants,
  type IncludedItem,
  type UsedChecklist,
  type UsedDefect,
  type UsedUnit,
} from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, toAppError, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { deleteFile, setFileVisibility, type BlobStore } from "~/server/storage.server";
import { activeTemplates, assertUnitBranch, buildChecklist, checklistView, employeeNames, ID, inspectionKindFor, likePattern, PAGE_SIZE, templateById, unitBranchWhere, variantLabel, type ChecklistAnswers } from "./shared.server";
import {
  DEFECT_SEVERITY_LIST,
  GRADE_LIST,
  MAX_DEFECTS,
  MAX_INCLUDED,
  MAX_UNIT_PHOTOS,
  MAX_USED_WARRANTY_DAYS,
  USED_EDITABLE,
  USED_VIEW_STATUSES,
  latinDigits,
  type HistoryEntry,
  type UnitPhoto,
  type UsedDetail,
  type UsedFilters,
  type UsedListRow,
  type UsedPage,
  type UsedStatusKey,
} from "./types";

export const USED_ADMIN_ERROR_KEYS = ["unit_changed", "unit_not_editable", "unit_returned_reinspect", "unit_not_returned", "unit_not_ready", "unit_not_listed", "unit_reserved", "not_listable", "last_real_photo", "photo_limit", "template_invalid"] as const;
/** Why a unit cannot be listed yet (shown as a checklist on its page). */
export const LIST_BLOCKERS = ["status_not_ready", "price_missing", "checklist_incomplete", "critical_failed", "ownership_missing", "wipe_missing", "photo_missing", "notes_missing"] as const;
export type ListBlocker = (typeof LIST_BLOCKERS)[number];

export const UNIT_PHOTO_KIND = "used_photo";
/** Areas a defect can name (stored as keys; their words are in admin-devices → defectArea.*). */
export const DEFECT_AREAS = ["screen", "shell", "back", "top", "corner", "ports", "buttons", "sticks", "triggers", "grips", "kickstand", "disc_drive", "battery", "fan", "case", "cover", "disc", "other"] as const;
/** What can come with a unit (admin-devices → accessory.*). */
export const INCLUDED_KEYS = ["controller", "controllers", "power_cable", "hdmi_cable", "usb_cable", "dock", "joy_con", "joy_con_pair", "joy_con_grip", "charger", "ac_adapter", "case", "carrying_case", "original_box", "manual", "extra"] as const;

const READ_PERMISSIONS = ["devices.registry.read", "devices.used.intake", "devices.used.inspect", "devices.used.grade", "devices.used.list", "devices.ownership.verify"] as const;
const SERIAL_READERS = ["devices.registry.read", "devices.used.inspect", "devices.ownership.verify", "devices.tradein.inspect"] as const;

function assertReader(actor: Actor): void {
  if (!canAny(actor, READ_PERMISSIONS)) throw forbidden("devices.registry.read");
}

const branchWhere = unitBranchWhere;

async function unitById(db: Db, actor: Actor, id: string): Promise<UsedUnit> {
  const row = ID.test(id) ? await db.select().from(usedUnits).where(eq(usedUnits.id, id)).get() : undefined;
  if (!row) throw notFound("used_unit");
  // A unit at another branch is not this employee's: the same 404 as an unknown one.
  try {
    await assertUnitBranch(db, actor, row.locationId);
  } catch {
    throw notFound("used_unit");
  }
  return row;
}

const REAL_PHOTOS = sql<number>`(SELECT count(*) FROM media AS m JOIN files AS f ON f.id = m.file_id AND f.deleted_at IS NULL WHERE m.owner_type = 'used_unit' AND m.owner_id = ${usedUnits.id} AND m.kind = 'image' AND m.is_illustration = 0)`;

// ───────────────────────────────────────────────────────────────── list

export async function listUsedUnits(db: Db, actor: Actor, filters: UsedFilters, locale: Locale): Promise<UsedPage> {
  assertReader(actor);
  const withCost = can(actor, "cost.read");
  const withSerial = canAny(actor, SERIAL_READERS);
  const where: SQL[] = [];
  const branch = branchWhere(actor);
  if (branch) where.push(branch);
  if (filters.view !== "all") where.push(inArray(usedUnits.status, [...USED_VIEW_STATUSES[filters.view]]));
  if (filters.status) where.push(eq(usedUnits.status, filters.status));
  if (filters.grade) where.push(eq(usedUnits.grade, filters.grade));
  if (filters.q) {
    const like = likePattern(filters.q);
    const parts: SQL[] = [sql`${usedUnits.slug} LIKE ${like} ESCAPE '\\'`, sql`${variants.sku} LIKE ${like} ESCAPE '\\'`, sql`${products.name} LIKE ${like} ESCAPE '\\'`, sql`${tradeIns.ref} = ${filters.q.toUpperCase()}`];
    if (withSerial) parts.push(sql`upper(${serials.serial}) LIKE ${likePattern(latinDigits(filters.q).toUpperCase())} ESCAPE '\\'`);
    where.push(or(...parts) as SQL);
  }
  const condition = where.length ? and(...where) : undefined;
  const base = db
    .select({
      unit: usedUnits,
      sku: variants.sku,
      title: variants.title,
      name: products.name,
      serial: serials.serial,
      tradeInRef: tradeIns.ref,
      location: inventoryLocations.code,
      realPhotos: REAL_PHOTOS,
    })
    .from(usedUnits)
    .innerJoin(variants, eq(variants.id, usedUnits.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(serials, eq(serials.id, usedUnits.serialId))
    .leftJoin(tradeIns, eq(tradeIns.id, usedUnits.tradeInId))
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, usedUnits.locationId));
  const [rows, totals, counts] = await Promise.all([
    base
      .where(condition)
      .orderBy(desc(usedUnits.updatedAt), desc(usedUnits.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db
      .select({ n: count() })
      .from(usedUnits)
      .innerJoin(variants, eq(variants.id, usedUnits.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(serials, eq(serials.id, usedUnits.serialId))
      .leftJoin(tradeIns, eq(tradeIns.id, usedUnits.tradeInId))
      .where(condition),
    db.select({ status: usedUnits.status, n: count() }).from(usedUnits).where(branch).groupBy(usedUnits.status),
  ]);
  const total = Number(totals[0]?.n ?? 0);
  return {
    rows: rows.map((row): UsedListRow => {
      const out: UsedListRow = {
        id: row.unit.id,
        slug: row.unit.slug,
        name: variantLabel(row.name, row.title, locale),
        sku: row.sku,
        grade: row.unit.grade,
        status: row.unit.status,
        priceIqd: row.unit.priceIqd,
        serial: withSerial ? (row.serial ?? null) : null,
        source: row.unit.source,
        tradeInRef: row.tradeInRef ?? null,
        realPhotos: Number(row.realPhotos ?? 0),
        checklistComplete: Boolean(row.unit.checklist?.completedAt),
        ownershipChecked: row.unit.ownershipCheckedAt !== null,
        dataWiped: row.unit.dataWipedAt !== null,
        location: row.location ?? null,
        updatedAt: row.unit.updatedAt,
        isDemo: row.unit.isDemo,
      };
      if (withCost) out.acquisitionCostIqd = row.unit.acquisitionCostIqd;
      return out;
    }),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.n)])) as UsedPage["counts"],
    withCost,
  };
}

// ───────────────────────────────────────────────────────────────── detail

type UnitFacts = { unit: UsedUnit; productKind: string; deviceKind: string | null };

async function unitFacts(db: Db, unit: UsedUnit): Promise<UnitFacts> {
  const row = await db
    .select({ kind: products.kind, deviceKind: deviceModels.deviceKind })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(deviceModels, eq(deviceModels.id, products.deviceModelId))
    .where(eq(variants.id, unit.variantId))
    .get();
  return { unit, productKind: row?.kind ?? "console", deviceKind: row?.deviceKind ?? null };
}

/** Real (person-confirmed) photos of a unit that have a stored file. */
async function realPhotoFiles(db: Db, unitId: string): Promise<{ mediaId: string; fileId: string; visibility: string }[]> {
  const rows = await db
    .select({ mediaId: media.id, fileId: files.id, visibility: files.visibility })
    .from(media)
    .innerJoin(files, and(eq(files.id, media.fileId), isNull(files.deletedAt)))
    .where(and(eq(media.ownerType, "used_unit"), eq(media.ownerId, unitId), eq(media.kind, "image"), eq(media.isIllustration, false)));
  return rows;
}

const hasArabic = (value: L10n | null | undefined) => typeof value?.ar === "string" && value.ar.trim().length >= 3;

/** Why the unit cannot be listed now (empty = it can). Pure over the unit's facts. */
export function listBlockers(input: { status: UsedStatusKey; priceIqd: number; checklist: UsedChecklist | null; missing: number; criticalFailed: number; ownership: boolean; wipe: boolean; realPhotos: number; notes: L10n | null; isDemo: boolean }): ListBlocker[] {
  const out: ListBlocker[] = [];
  if (input.status !== "ready") out.push("status_not_ready");
  if (input.priceIqd <= 0) out.push("price_missing");
  if (!input.checklist?.completedAt || input.missing > 0 || (input.checklist.items?.length ?? 0) === 0) out.push("checklist_incomplete");
  if (input.criticalFailed > 0) out.push("critical_failed");
  if (!input.ownership) out.push("ownership_missing");
  if (!input.wipe) out.push("wipe_missing");
  if (input.realPhotos === 0) out.push("photo_missing");
  if (!hasArabic(input.notes)) out.push("notes_missing");
  return out;
}

/**
 * What the unit's status should be after its evidence changed (only intake / testing / ready move by themselves):
 * ready = the checklist complete on its own template version with no critical item failed, a grade, the ownership
 * check and the data wipe. The payout of a trade-in uses the same rule for the unit it creates.
 */
export async function settledStatus(db: Db, unit: Pick<UsedUnit, "status" | "checklist" | "grade" | "ownershipCheckedAt" | "dataWipedAt">, kind: ReturnType<typeof inspectionKindFor>): Promise<UsedStatusKey> {
  if (!["intake", "testing", "ready"].includes(unit.status)) return unit.status;
  const template = unit.checklist?.templateId ? await templateById(db, unit.checklist.templateId) : null;
  const view = checklistView(template, unit.checklist ?? null, "ar", kind);
  const complete = Boolean(unit.checklist?.completedAt) && view.missing.length === 0 && (unit.checklist?.items?.length ?? 0) > 0;
  if (complete && view.criticalFailed.length === 0 && unit.grade && unit.ownershipCheckedAt !== null && unit.dataWipedAt !== null) return "ready";
  return (unit.checklist?.items?.length ?? 0) > 0 ? "testing" : "intake";
}

export type UnitUrls = { file: (fileId: string) => string };

export async function getUsedUnitDetail(db: Db, actor: Actor, id: string, locale: Locale, urls: UnitUrls): Promise<UsedDetail> {
  assertReader(actor);
  const unit = await unitById(db, actor, id);
  const withCost = can(actor, "cost.read");
  const withProfit = withCost && can(actor, "profit.read");
  const withSerial = canAny(actor, SERIAL_READERS);
  const product = await db
    .select({ id: products.id, slug: products.slug, kind: products.kind, name: products.name, region: products.region, mediaFormat: products.mediaFormat, platformName: platforms.name, deviceKind: deviceModels.deviceKind, sku: variants.sku, title: variants.title, newPrice: variants.priceIqd })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(platforms, eq(platforms.id, products.platformId))
    .leftJoin(deviceModels, eq(deviceModels.id, products.deviceModelId))
    .where(eq(variants.id, unit.variantId))
    .get();
  if (!product) throw notFound("variant");
  const kind = inspectionKindFor({ productKind: product.kind, deviceKind: product.deviceKind });
  const [serial, location, tradeIn, sold, photoRows, templates, pending, events] = await Promise.all([
    unit.serialId ? db.select({ id: serials.id, serial: serials.serial, status: serials.status }).from(serials).where(eq(serials.id, unit.serialId)).get() : Promise.resolve(undefined),
    unit.locationId ? db.select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name }).from(inventoryLocations).where(eq(inventoryLocations.id, unit.locationId)).get() : Promise.resolve(undefined),
    unit.tradeInId ? db.select({ id: tradeIns.id, ref: tradeIns.ref }).from(tradeIns).where(eq(tradeIns.id, unit.tradeInId)).get() : Promise.resolve(undefined),
    unit.soldOrderItemId ? db.select({ ref: orders.ref }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orderItems.id, unit.soldOrderItemId)).get() : Promise.resolve(undefined),
    db
      .select({ id: media.id, fileId: media.fileId, artKey: media.artKey, alt: media.alt, isIllustration: media.isIllustration, sort: media.sort, visibility: files.visibility, storageKey: files.storageKey, width: files.width, height: files.height, deletedAt: files.deletedAt })
      .from(media)
      .leftJoin(files, eq(files.id, media.fileId))
      .where(and(eq(media.ownerType, "used_unit"), eq(media.ownerId, unit.id)))
      .orderBy(asc(media.sort), asc(media.id)),
    activeTemplates(db, locale),
    db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.kind, "used_price"), eq(approvals.entityId, unit.id), eq(approvals.status, "pending"))).get(),
    db
      .select({ id: auditEvents.id, action: auditEvents.action, at: auditEvents.at, actorKind: auditEvents.actorKind, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, reason: auditEvents.reason })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "used_unit"), eq(auditEvents.entityId, unit.id)))
      .orderBy(desc(auditEvents.seq))
      .limit(60),
  ]);
  const template = unit.checklist?.templateId ? await templateById(db, unit.checklist.templateId) : null;
  const fallback = templates.find((entry) => entry.kind === kind) ?? null;
  const checklist = checklistView(template ?? fallback, unit.checklist ?? null, locale, kind);
  const photos: UnitPhoto[] = photoRows
    .filter((row) => row.deletedAt === null || row.deletedAt === undefined)
    .map((row) => ({
      mediaId: row.id,
      fileId: row.fileId,
      // A published photo is served by /media like every public file; a private one only through the admin file route.
      url: row.fileId ? (row.visibility === "public" && row.storageKey ? `/media/${encodeURIComponent(row.storageKey)}` : urls.file(row.fileId)) : null,
      real: !row.isIllustration,
      published: row.visibility === "public",
      alt: row.alt ? pick(row.alt, locale) || null : null,
      width: row.width ?? null,
      height: row.height ?? null,
      artKey: row.artKey,
    }));
  const realPhotos = photos.filter((photo) => photo.real && photo.fileId).length;
  const names = await employeeNames(db, [unit.ownershipCheckedBy, unit.dataWipedBy, ...events.map((event) => (event.actorKind === "employee" ? event.actorId : null))]);
  const history: HistoryEntry[] = events.map((event) => ({ id: event.id, kind: event.action, at: event.at, actorKind: event.actorKind, actor: (event.actorId && names.get(event.actorId)) || event.actorLabel || null, data: event.reason ? { reason: event.reason } : {} }));
  const editable = (USED_EDITABLE as readonly string[]).includes(unit.status) && unit.status !== "returned";
  const blockers = listBlockers({ status: unit.status, priceIqd: unit.priceIqd, checklist: unit.checklist ?? null, missing: checklist.missing.length, criticalFailed: checklist.criticalFailed.length, ownership: unit.ownershipCheckedAt !== null, wipe: unit.dataWipedAt !== null, realPhotos, notes: unit.cosmeticNotes ?? null, isDemo: unit.isDemo });
  const game =
    product.kind === "game"
      ? {
          region: product.region,
          platform: product.platformName ? pick(product.platformName, locale) : null,
          mediaFormat: product.mediaFormat,
          compatibility: await gameCompatibility(db, product.id, locale),
        }
      : null;
  const triple = (value: L10n | null | undefined) => ({ ar: value?.ar ?? "", en: value?.en ?? "", ckb: value?.ckb ?? "" });
  const detail: UsedDetail = {
    id: unit.id,
    slug: unit.slug,
    status: unit.status,
    isDemo: unit.isDemo,
    source: unit.source,
    name: variantLabel(product.name, product.title, locale),
    productId: product.id,
    productKind: product.kind,
    productSlug: product.slug,
    sku: product.sku,
    variantId: unit.variantId,
    serial: withSerial && serial ? serial : null,
    grade: unit.grade,
    batteryHealthPct: unit.batteryHealthPct,
    cosmeticNotes: triple(unit.cosmeticNotes),
    defects: (unit.defects ?? []).map((defect) => ({ area: defect.area, severity: defect.severity, note: triple(defect.note) })),
    included: (unit.included ?? []).map((item) => ({ key: item.key, label: triple(item.label) })),
    warrantyDays: unit.warrantyDays,
    priceIqd: unit.priceIqd,
    newPriceIqd: product.newPrice,
    location: location ?? null,
    tradeIn: tradeIn ?? null,
    ownership: { at: unit.ownershipCheckedAt, by: unit.ownershipCheckedBy ? (names.get(unit.ownershipCheckedBy) ?? null) : null },
    wipe: { at: unit.dataWipedAt, by: unit.dataWipedBy ? (names.get(unit.dataWipedBy) ?? null) : null },
    listedAt: unit.listedAt,
    soldAt: unit.soldAt,
    soldOrderRef: sold?.ref ?? null,
    checklist,
    templates: templates.filter((entry) => entry.kind === kind),
    checklistForm: checklistView(fallback, unit.checklist ?? null, locale, kind),
    photos,
    game,
    pricing: { canEdit: can(actor, "pricing.used.update") && ["intake", "testing", "ready", "listed"].includes(unit.status), pending: Boolean(pending) },
    history,
    listBlockers: blockers,
    can: {
      inspect: can(actor, "devices.used.inspect") && (editable || unit.status === "returned"),
      grade: can(actor, "devices.used.grade") && editable,
      photo: canAny(actor, ["devices.used.inspect", "devices.used.grade"]) && ["intake", "testing", "ready", "listed", "returned"].includes(unit.status),
      verify: can(actor, "devices.ownership.verify") && editable,
      list: can(actor, "devices.used.list") && unit.status === "ready",
      unlist: can(actor, "devices.used.list") && unit.status === "listed",
      price: can(actor, "pricing.used.update"),
      editable,
    },
  };
  if (withCost) detail.acquisitionCostIqd = unit.acquisitionCostIqd;
  if (withProfit) detail.marginBps = unit.acquisitionCostIqd !== null && unit.priceIqd > 0 ? Math.floor(((unit.priceIqd - unit.acquisitionCostIqd) * 10_000) / unit.priceIqd) : null;
  return detail;
}

/** A game's platform compatibility as the catalogue records it (13.05): device models and generations, with their status. */
async function gameCompatibility(db: Db, productId: string, locale: Locale): Promise<{ target: string; status: string }[]> {
  const rows = await db
    .select({ targetType: compatibilityRules.targetType, status: compatibilityRules.status, model: deviceModels.name, generation: deviceGenerations.name, platform: platforms.name })
    .from(compatibilityRules)
    .leftJoin(deviceModels, and(eq(compatibilityRules.targetType, "device_model"), eq(deviceModels.id, compatibilityRules.targetId)))
    .leftJoin(deviceGenerations, and(eq(compatibilityRules.targetType, "generation"), eq(deviceGenerations.id, compatibilityRules.targetId)))
    .leftJoin(platforms, and(eq(compatibilityRules.targetType, "platform"), eq(platforms.id, compatibilityRules.targetId)))
    .where(and(eq(compatibilityRules.subjectType, "product"), eq(compatibilityRules.subjectId, productId)))
    .limit(40);
  return rows.map((row) => ({ target: pick(row.model ?? row.generation ?? row.platform, locale) || row.targetType, status: row.status }));
}

// ───────────────────────────────────────────────────────────────── the checklist (13.02)

export const UnitChecklistInput = z.object({
  usedUnitId: z.string().regex(ID, "invalid"),
  templateId: z.string().regex(ID, "invalid"),
  answers: z.record(z.string(), z.object({ result: z.string().max(10).nullish(), value: z.string().max(400).nullish(), note: z.string().max(400).nullish() })),
});

function parseInput<T extends z.ZodType>(schema: T, raw: unknown, detail: string): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), detail);
  return parsed.data;
}

function assertEditable(unit: UsedUnit): void {
  if (unit.status === "returned") throw new AppError("unit_returned_reinspect", 409);
  if (!(USED_EDITABLE as readonly string[]).includes(unit.status)) throw new AppError("unit_not_editable", 409);
}

const settleUnit = (error: unknown): never => {
  const app = toAppError(error);
  if (app && (app.code === "no_rows_changed" || app.code === "unit_changed" || app.code === "guard_failed")) throw new AppError("unit_changed", 409, { cause: error });
  if (isDbError(error, "USED_UNIT_NOT_LISTABLE")) throw new AppError("not_listable", 409, { cause: error });
  throw app ?? error;
};

/** Saves the unit's inspection checklist (devices.used.inspect) against its template; the status follows. */
export async function saveUnitChecklist(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: UsedStatusKey; complete: boolean }> {
  assertCan(actor, "devices.used.inspect");
  const input = parseInput(UnitChecklistInput, raw, "used.checklist");
  const unit = await unitById(db, actor, input.usedUnitId);
  assertEditable(unit);
  const facts = await unitFacts(db, unit);
  const kind = inspectionKindFor({ productKind: facts.productKind, deviceKind: facts.deviceKind });
  const template = await templateById(db, input.templateId);
  if (!template || template.kind !== kind) throw invalid({ templateId: "template_invalid" });
  // A checklist is filled on the CURRENT version: a switched-off one (fewer or older checks) is a stale page.
  if (!template.isActive) throw invalid({ templateId: "template_changed" });
  const built = buildChecklist(template, input.answers as ChecklistAnswers, actor.kind === "employee" ? actor.id : null, now, cleanLine);
  const next = { ...unit, checklist: built.checklist, batteryHealthPct: built.batteryPct ?? (template.items.some((item) => item.key === "battery") ? null : unit.batteryHealthPct) };
  const status = await settledStatus(db, next, kind);
  try {
    await runBatch(db, [
      db
        .update(usedUnits)
        .set({ checklist: built.checklist, batteryHealthPct: next.batteryHealthPct, status, updatedAt: now })
        .where(and(eq(usedUnits.id, unit.id), eq(usedUnits.updatedAt, unit.updatedAt), inArray(usedUnits.status, ["intake", "testing", "ready"]))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, {
        actor,
        action: "devices.used.inspect",
        entityType: "used_unit",
        entityId: unit.id,
        summary: unit.slug,
        before: { status: unit.status, complete: Boolean(unit.checklist?.completedAt) },
        after: { status, complete: built.complete, templateId: template.id, passed: built.checklist.items.filter((item) => item.result === "pass").length, failed: built.checklist.items.filter((item) => item.result === "fail").length },
        at: now,
      }),
    ]);
  } catch (error) {
    settleUnit(error);
  }
  return { status, complete: built.complete };
}

// ───────────────────────────────────────────────────────────────── grading (13.09)

const l10nInput = (max: number, required = false) =>
  z.object({
    ar: required ? z.string().overwrite(cleanBlock).trim().min(3, "required").max(max, "too_long") : z.string().overwrite(cleanBlock).trim().max(max, "too_long").default(""),
    en: z.string().overwrite(cleanBlock).trim().max(max, "too_long").default(""),
    ckb: z.string().overwrite(cleanBlock).trim().max(max, "too_long").default(""),
  });

export const UnitGradingInput = z.object({
  usedUnitId: z.string().regex(ID, "invalid"),
  grade: z.enum(GRADE_LIST, { error: "invalid" }),
  cosmeticNotes: l10nInput(1000),
  defects: z
    .array(z.object({ area: z.enum(DEFECT_AREAS, { error: "invalid" }), severity: z.enum(DEFECT_SEVERITY_LIST, { error: "invalid" }), note: l10nInput(300, true) }))
    .max(MAX_DEFECTS, "too_long")
    .default([]),
  included: z
    .array(z.object({ key: z.enum(INCLUDED_KEYS, { error: "invalid" }), label: l10nInput(80).optional() }))
    .max(MAX_INCLUDED, "too_long")
    .default([]),
  warrantyDays: z.preprocess((value) => (typeof value === "string" ? (value.trim() === "" ? 0 : Number(latinDigits(value).trim())) : value), z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(MAX_USED_WARRANTY_DAYS, "too_big")),
});

const toL10n = (value: { ar: string; en: string; ckb: string }): L10n | null => (value.ar || value.en || value.ckb ? { ar: value.ar || value.en || value.ckb, ...(value.en ? { en: value.en } : {}), ...(value.ckb ? { ckb: value.ckb } : {}) } : null);

/**
 * The quality grade and what the customer will read (devices.used.grade): grade A+…C, condition notes, each disclosed
 * defect (area, severity, words), what comes with it, and the store warranty in days. Audited before/after.
 */
export async function saveUnitGrading(db: Db, actor: Actor, raw: unknown, now: number, labels: (key: string) => L10n | undefined): Promise<{ status: UsedStatusKey }> {
  assertCan(actor, "devices.used.grade");
  const input = parseInput(UnitGradingInput, raw, "used.grade");
  const unit = await unitById(db, actor, input.usedUnitId);
  assertEditable(unit);
  const facts = await unitFacts(db, unit);
  const kind = inspectionKindFor({ productKind: facts.productKind, deviceKind: facts.deviceKind });
  const defects: UsedDefect[] = input.defects.map((defect) => ({ area: defect.area, severity: defect.severity, note: toL10n(defect.note) ?? { ar: defect.note.ar } }));
  const seen = new Set<string>();
  const included: IncludedItem[] = [];
  for (const item of input.included) {
    if (item.key !== "extra" && seen.has(item.key)) continue;
    seen.add(item.key);
    const custom = item.label ? toL10n(item.label) : null;
    const label = custom ?? labels(item.key);
    included.push(label ? { key: item.key, label } : { key: item.key });
  }
  const cosmeticNotes = toL10n(input.cosmeticNotes);
  const status = await settledStatus(db, { ...unit, grade: input.grade }, kind);
  try {
    await runBatch(db, [
      db
        .update(usedUnits)
        .set({ grade: input.grade, cosmeticNotes, defects, included, warrantyDays: input.warrantyDays, status, updatedAt: now })
        .where(and(eq(usedUnits.id, unit.id), eq(usedUnits.updatedAt, unit.updatedAt), inArray(usedUnits.status, ["intake", "testing", "ready"]))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, {
        actor,
        action: "devices.used.grade",
        entityType: "used_unit",
        entityId: unit.id,
        summary: unit.slug,
        before: { grade: unit.grade, defects: unit.defects?.length ?? 0, included: (unit.included ?? []).map((item) => item.key), warrantyDays: unit.warrantyDays },
        after: { grade: input.grade, defects: defects.length, included: included.map((item) => item.key), warrantyDays: input.warrantyDays },
        at: now,
      }),
    ]);
  } catch (error) {
    settleUnit(error);
  }
  return { status };
}

// ───────────────────────────────────────────────────────────────── ownership and wipe (13.08)

export const UnitChecksInput = z.object({
  usedUnitId: z.string().regex(ID, "invalid"),
  ownership: z.boolean().default(false),
  wipe: z.boolean().default(false),
  note: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().overwrite(cleanBlock).trim().min(3, "reason_short").max(300, "too_long").optional()),
});

/**
 * Confirms the ownership check (proof the store may sell the unit) and/or the data wipe (accounts unlinked, factory
 * reset) of a unit (devices.ownership.verify) — with the person and the time; the status follows.
 */
export async function confirmUnitChecks(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: UsedStatusKey; replayed: boolean }> {
  assertCan(actor, "devices.ownership.verify");
  const input = parseInput(UnitChecksInput, raw, "used.checks");
  if (!input.ownership && !input.wipe) throw invalid({ checks: "required" });
  const unit = await unitById(db, actor, input.usedUnitId);
  assertEditable(unit);
  const ownership = input.ownership && unit.ownershipCheckedAt === null;
  const wipe = input.wipe && unit.dataWipedAt === null;
  if (!ownership && !wipe) return { status: unit.status, replayed: true };
  const actorId = actor.kind === "employee" ? actor.id : null;
  const facts = await unitFacts(db, unit);
  const kind = inspectionKindFor({ productKind: facts.productKind, deviceKind: facts.deviceKind });
  const next = { ...unit, ownershipCheckedAt: ownership ? now : unit.ownershipCheckedAt, dataWipedAt: wipe ? now : unit.dataWipedAt };
  const status = await settledStatus(db, next, kind);
  try {
    await runBatch(db, [
      db
        .update(usedUnits)
        .set({
          ...(ownership ? { ownershipCheckedAt: now, ownershipCheckedBy: actorId } : {}),
          ...(wipe ? { dataWipedAt: now, dataWipedBy: actorId } : {}),
          status,
          updatedAt: now,
        })
        .where(and(eq(usedUnits.id, unit.id), eq(usedUnits.updatedAt, unit.updatedAt), inArray(usedUnits.status, ["intake", "testing", "ready"]))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, { actor, action: "devices.used.verify", entityType: "used_unit", entityId: unit.id, summary: unit.slug, after: { ownershipChecked: ownership || undefined, dataWiped: wipe || undefined, status }, reason: input.note ?? null, at: now }),
    ]);
  } catch (error) {
    settleUnit(error);
  }
  return { status, replayed: false };
}

export const ReinspectInput = z.object({ usedUnitId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(300, "too_long") });

/**
 * A unit that came back from a customer (status returned, module 12) is inspected again before it is sold again
 * (devices.used.inspect): its checklist reopens (answers kept as a starting point) and the data wipe must be confirmed
 * again; the ownership check stays.
 */
export async function startReinspection(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: UsedStatusKey }> {
  assertCan(actor, "devices.used.inspect");
  const input = parseInput(ReinspectInput, raw, "used.reinspect");
  const unit = await unitById(db, actor, input.usedUnitId);
  if (unit.status !== "returned") throw new AppError("unit_not_returned", 409);
  const checklist: UsedChecklist | null = unit.checklist ? { ...unit.checklist, completedAt: null, completedBy: null } : null;
  try {
    await runBatch(db, [
      db
        .update(usedUnits)
        .set({ status: "testing", checklist, dataWipedAt: null, dataWipedBy: null, updatedAt: now })
        .where(and(eq(usedUnits.id, unit.id), eq(usedUnits.status, "returned"), eq(usedUnits.updatedAt, unit.updatedAt))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, { actor, action: "devices.used.reinspect", entityType: "used_unit", entityId: unit.id, summary: unit.slug, before: { status: "returned" }, after: { status: "testing" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    settleUnit(error);
  }
  return { status: "testing" };
}

// ───────────────────────────────────────────────────────────────── photos (13.09)

/** Authorizes a photo BEFORE it is stored: who may, a unit not sold or on hold, room left. */
export async function assertUnitPhotoSlot(db: Db, actor: Actor, usedUnitId: string): Promise<UsedUnit> {
  if (!canAny(actor, ["devices.used.inspect", "devices.used.grade"])) throw forbidden("devices.used.inspect");
  const unit = await unitById(db, actor, usedUnitId);
  if (!["intake", "testing", "ready", "listed", "returned"].includes(unit.status)) throw new AppError("unit_not_editable", 409);
  const total = await db.select({ n: count() }).from(media).where(and(eq(media.ownerType, "used_unit"), eq(media.ownerId, unit.id))).get();
  if (Number(total?.n ?? 0) >= MAX_UNIT_PHOTOS) throw new AppError("photo_limit", 409);
  return unit;
}

/** The stored photo becomes a media row of the unit — not yet confirmed as a real photo of it. */
export async function recordUnitPhoto(db: Db, actor: Actor, unit: UsedUnit, fileId: string, now: number, alt?: string | null): Promise<{ mediaId: string }> {
  const last = await db.select({ sort: sql<number>`coalesce(max(${media.sort}), -1)` }).from(media).where(and(eq(media.ownerType, "used_unit"), eq(media.ownerId, unit.id))).get();
  const mediaId = newId("med");
  const caption = alt ? cleanLine(alt).trim().slice(0, 140) : "";
  await runBatch(db, [
    db.insert(media).values({ id: mediaId, ownerType: "used_unit", ownerId: unit.id, fileId, kind: "image", isIllustration: true, alt: caption ? { ar: caption } : null, sort: Number(last?.sort ?? -1) + 1, createdAt: now }),
    auditStatement(db, { actor, action: "devices.used.photo", entityType: "used_unit", entityId: unit.id, summary: unit.slug, after: { mediaId, fileId }, at: now }),
  ]);
  return { mediaId };
}

export const PhotoRealInput = z.object({ usedUnitId: z.string().regex(ID, "invalid"), mediaId: z.string().regex(ID, "invalid"), real: z.boolean() });

async function unitMedia(db: Db, unitId: string, mediaId: string) {
  const row = await db
    .select({ id: media.id, fileId: media.fileId, isIllustration: media.isIllustration, visibility: files.visibility, fileOwnerType: files.ownerType, fileOwnerId: files.ownerId })
    .from(media)
    .leftJoin(files, eq(files.id, media.fileId))
    .where(and(eq(media.id, mediaId), eq(media.ownerType, "used_unit"), eq(media.ownerId, unitId)))
    .get();
  if (!row) throw notFound("media");
  return row;
}

/**
 * Says whether a photo shows THIS unit (devices.used.grade): real → is_illustration = 0 (and public at once when the
 * unit is listed); not real → back to an illustration, private again. A listed unit keeps at least one real photo.
 */
export async function setPhotoReal(db: Db, store: BlobStore, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "devices.used.grade");
  const input = parseInput(PhotoRealInput, raw, "used.photo");
  const unit = await unitById(db, actor, input.usedUnitId);
  if (!["intake", "testing", "ready", "listed", "returned"].includes(unit.status)) throw new AppError("unit_not_editable", 409);
  const photo = await unitMedia(db, unit.id, input.mediaId);
  if (!photo.fileId) throw invalid({ mediaId: "invalid" });
  if (photo.isIllustration === !input.real) return { replayed: true };
  const publishing = input.real && unit.status === "listed" && photo.visibility === "private";
  if (publishing) await setFileVisibility(db, store, photo.fileId, "public");
  try {
    await runBatch(db, [
      db.update(media).set({ isIllustration: !input.real }).where(and(eq(media.id, photo.id), eq(media.ownerId, unit.id))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, { actor, action: input.real ? "devices.used.photo_real" : "devices.used.photo_unreal", entityType: "used_unit", entityId: unit.id, summary: unit.slug, after: { mediaId: photo.id, real: input.real }, at: now }),
    ]);
  } catch (error) {
    // Published for a mark that was not saved: private again (nobody confirmed it shows this unit).
    if (publishing) await setFileVisibility(db, store, photo.fileId, "private").catch(() => null);
    if (isDbError(error, "USED_UNIT_NOT_LISTABLE")) throw new AppError("last_real_photo", 409, { cause: error });
    settleUnit(error);
  }
  if (!input.real && photo.visibility === "public") await setFileVisibility(db, store, photo.fileId, "private");
  return { replayed: false };
}

export const PhotoRemoveInput = z.object({ usedUnitId: z.string().regex(ID, "invalid"), mediaId: z.string().regex(ID, "invalid") });

/** Removes a photo from the unit (devices.used.grade); its file is deleted when it belongs to the unit (not a trade-in's). */
export async function removeUnitPhoto(db: Db, store: BlobStore, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "devices.used.grade");
  const input = parseInput(PhotoRemoveInput, raw, "used.photo");
  const unit = await unitById(db, actor, input.usedUnitId);
  if (!["intake", "testing", "ready", "listed", "returned"].includes(unit.status)) throw new AppError("unit_not_editable", 409);
  const photo = await unitMedia(db, unit.id, input.mediaId);
  try {
    await runBatch(db, [
      db.delete(media).where(and(eq(media.id, photo.id), eq(media.ownerId, unit.id))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, { actor, action: "devices.used.photo_remove", entityType: "used_unit", entityId: unit.id, summary: unit.slug, after: { mediaId: photo.id, fileId: photo.fileId }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "USED_UNIT_NOT_LISTABLE")) throw new AppError("last_real_photo", 409, { cause: error });
    settleUnit(error);
  }
  if (!photo.fileId) return;
  if (photo.fileOwnerType === "used_unit" && photo.fileOwnerId === unit.id) {
    await deleteFile(db, store, photo.fileId, now);
    return;
  }
  // Another record's file (a trade-in inspection photo) stays with that record — but no longer public, unless another
  // unit still shows it as a confirmed real photo: a photo taken off a unit (it showed a face, a document…) must not
  // stay reachable at its public address.
  if (photo.visibility === "public") {
    const stillShown = await db
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.fileId, photo.fileId), eq(media.ownerType, "used_unit"), eq(media.isIllustration, false)))
      .get();
    if (!stillShown) await setFileVisibility(db, store, photo.fileId, "private");
  }
}

// ───────────────────────────────────────────────────────────────── listing

export const ListInput = z.object({ usedUnitId: z.string().regex(ID, "invalid") });

/**
 * Puts a ready unit on sale (devices.used.list): every blocker cleared (re-checked here), the real photos published
 * first, then one batch — status listed, its serial sellable (in_stock), audit. The database's evidence rule is the
 * backstop (→ not_listable). A photo published for a listing that then failed goes back to private.
 */
export async function listUnit(db: Db, store: BlobStore, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "devices.used.list");
  const input = parseInput(ListInput, raw, "used.list");
  const unit = await unitById(db, actor, input.usedUnitId);
  if (unit.status === "listed") return { replayed: true };
  if (unit.status !== "ready") throw new AppError("unit_not_ready", 409);
  const facts = await unitFacts(db, unit);
  const kind = inspectionKindFor({ productKind: facts.productKind, deviceKind: facts.deviceKind });
  const template = unit.checklist?.templateId ? await templateById(db, unit.checklist.templateId) : null;
  const view = checklistView(template, unit.checklist ?? null, "ar", kind);
  const real = await realPhotoFiles(db, unit.id);
  const blockers = listBlockers({ status: unit.status, priceIqd: unit.priceIqd, checklist: unit.checklist ?? null, missing: view.missing.length, criticalFailed: view.criticalFailed.length, ownership: unit.ownershipCheckedAt !== null, wipe: unit.dataWipedAt !== null, realPhotos: real.length, notes: unit.cosmeticNotes ?? null, isDemo: unit.isDemo });
  if (blockers.length > 0) throw new AppError("not_listable", 409, { detail: blockers.join(","), fields: { listing: blockers[0] } });
  const published: string[] = [];
  for (const photo of real) {
    if (photo.visibility === "public") continue;
    await setFileVisibility(db, store, photo.fileId, "public");
    published.push(photo.fileId);
  }
  const statements: BatchStatement[] = [
    db
      .update(usedUnits)
      .set({ status: "listed", listedAt: now, updatedAt: now })
      .where(and(eq(usedUnits.id, unit.id), eq(usedUnits.status, "ready"), eq(usedUnits.updatedAt, unit.updatedAt), sql`${usedUnits.priceIqd} > 0`)),
    expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
  ];
  if (unit.serialId) {
    statements.push(
      db.update(serials).set({ status: "in_stock", updatedAt: now }).where(and(eq(serials.id, unit.serialId), inArray(serials.status, ["intake", "returned"]))),
      expectThat(db, sql`(SELECT status FROM serials WHERE id = ${unit.serialId}) = 'in_stock'`, { code: "SERIAL_NOT_SELLABLE", detail: unit.serialId }),
    );
  }
  statements.push(auditStatement(db, { actor, action: "devices.used.list", entityType: "used_unit", entityId: unit.id, summary: unit.slug, before: { status: "ready" }, after: { status: "listed", priceIqd: unit.priceIqd, photos: real.length }, at: now }));
  try {
    await runBatch(db, statements);
  } catch (error) {
    for (const fileId of published) await setFileVisibility(db, store, fileId, "private").catch(() => null);
    const app = toAppError(error);
    if (app?.code === "serial_not_sellable") throw new AppError("not_listable", 409, { detail: "serial", fields: { listing: "serial_not_sellable" }, cause: error });
    settleUnit(error);
  }
  return { replayed: false };
}

export const UnlistInput = z.object({ usedUnitId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(300, "too_long") });

/** Takes a listed unit off sale (devices.used.list), with a reason. A unit held by an order is the order's (unit_reserved). */
export async function unlistUnit(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "devices.used.list");
  const input = parseInput(UnlistInput, raw, "used.unlist");
  const unit = await unitById(db, actor, input.usedUnitId);
  if (unit.status === "ready") return { replayed: true };
  if (unit.status === "reserved") throw new AppError("unit_reserved", 409);
  if (unit.status !== "listed") throw new AppError("unit_not_listed", 409);
  try {
    await runBatch(db, [
      db.update(usedUnits).set({ status: "ready", updatedAt: now }).where(and(eq(usedUnits.id, unit.id), eq(usedUnits.status, "listed"))),
      expectChanged(db, 1, { code: "UNIT_CHANGED", detail: unit.id }),
      auditStatement(db, { actor, action: "devices.used.unlist", entityType: "used_unit", entityId: unit.id, summary: unit.slug, before: { status: "listed" }, after: { status: "ready" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    settleUnit(error);
  }
  return { replayed: false };
}

/** The unit's id by its id or slug (for links from the storefront's words). */
export async function usedUnitIdOf(db: Db, key: string): Promise<string | null> {
  if (!/^[a-z0-9_-]{1,128}$/i.test(key)) return null;
  const row = await db.select({ id: usedUnits.id }).from(usedUnits).where(or(eq(usedUnits.id, key), eq(usedUnits.slug, key.toLowerCase()))).get();
  return row?.id ?? null;
}
