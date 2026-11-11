/**
 * Admin module 13 — trade-in price guides (13.03): the reference market price of a grade-A+ unit of a device model
 * (or one exact variant), the share of it each grade is worth, and what a missing accessory takes off. The storefront
 * estimates a RANGE from the model's guide; the admin shows the guide's suggestion next to the inspection — neither is
 * an offer.
 *
 *   const guides = await listGuides(db, actor, locale);
 *   await saveGuide(db, actor, { guideId?, expectedUpdatedAt?, deviceModelId, variantCode?, baseIqd, multipliers, deductions, isActive, reason }, now);
 *
 * Reading: devices.price_guide.manage or any trade-in permission; saving: devices.price_guide.manage. One active guide
 * per model and scope (model-wide, or one variant): activating a guide switches the other active one of the same scope
 * off in the same batch. Every change is audited with the values before and after (valuation changes are traceable;
 * each storefront estimate also keeps the guide it used).
 *
 * Errors: forbidden, invalid (fields: deviceModelId, variantCode = unknown_code | variant_not_model, baseIqd,
 * multipliers.<grade>, deductions.<n>.key = key_invalid | key_taken, reason), guide_changed (409), not_found.
 */
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, platforms, products, tradeInPriceGuides, variants, type UsedGrade } from "~/server/db/schema";
import { expectChanged, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { ID, employeeNames } from "./shared.server";
import { GRADE_LIST, MAX_DEDUCTIONS, MAX_GUIDE_BASE_IQD, MAX_MULTIPLIER_BPS, latinDigits, type GuideRow, type ModelOption } from "./types";

export const GUIDE_ERROR_KEYS = ["guide_changed", "variant_not_model", "unknown_code", "key_invalid", "key_taken"] as const;

function assertReader(actor: Actor): void {
  if (!canAny(actor, ["devices.price_guide.manage", "devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"])) throw forbidden("devices.price_guide.manage");
}

export async function listGuides(db: Db, actor: Actor, locale: Locale): Promise<GuideRow[]> {
  assertReader(actor);
  const rows = await db
    .select({ guide: tradeInPriceGuides, model: deviceModels.name, modelSlug: deviceModels.slug, sku: variants.sku, platformSort: platforms.sort, modelSort: deviceModels.sort })
    .from(tradeInPriceGuides)
    .innerJoin(deviceModels, eq(deviceModels.id, tradeInPriceGuides.deviceModelId))
    .innerJoin(platforms, eq(platforms.id, deviceModels.platformId))
    .leftJoin(variants, eq(variants.id, tradeInPriceGuides.variantId))
    .orderBy(asc(platforms.sort), asc(deviceModels.sort), desc(tradeInPriceGuides.isActive), desc(tradeInPriceGuides.updatedAt))
    .limit(300);
  const names = await employeeNames(db, rows.map((row) => row.guide.updatedBy));
  return rows.map((row) => ({
    id: row.guide.id,
    modelId: row.guide.deviceModelId,
    model: pick(row.model, locale) || row.modelSlug,
    modelSlug: row.modelSlug,
    variant: row.guide.variantId && row.sku ? { id: row.guide.variantId, sku: row.sku } : null,
    baseIqd: row.guide.baseIqd,
    multipliers: row.guide.gradeMultipliers ?? {},
    deductions: Object.entries(row.guide.deductions ?? {})
      .filter(([key]) => key.startsWith("missing_"))
      .map(([key, amountIqd]) => ({ key: key.slice("missing_".length), amountIqd })),
    isActive: row.guide.isActive,
    updatedAt: row.guide.updatedAt,
    updatedBy: row.guide.updatedBy ? (names.get(row.guide.updatedBy) ?? null) : null,
  }));
}

/** Device models a guide can be for. */
export async function modelOptions(db: Db, actor: Actor, locale: Locale): Promise<ModelOption[]> {
  assertReader(actor);
  const rows = await db
    .select({ id: deviceModels.id, slug: deviceModels.slug, name: deviceModels.name, kind: deviceModels.deviceKind, platform: platforms.name })
    .from(deviceModels)
    .innerJoin(platforms, eq(platforms.id, deviceModels.platformId))
    .where(ne(deviceModels.status, "archived"))
    .orderBy(asc(platforms.sort), asc(deviceModels.sort), asc(deviceModels.slug))
    .limit(300);
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: pick(row.name, locale) || row.slug, kind: row.kind, platform: pick(row.platform, locale) }));
}

const whole = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const digits = latinDigits(value).replace(/[,\s٬،]/g, "");
  if (digits === "") return undefined;
  return /^\d{1,13}$/.test(digits) ? Number(digits) : Number.NaN;
};

const percent = z.preprocess(whole, z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(MAX_MULTIPLIER_BPS / 100, "too_big").optional());

export const GuideInput = z.object({
  guideId: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(ID, "invalid").optional()),
  /** The guide's updated_at when the form was opened (an existing guide): a newer save is never overwritten. */
  expectedUpdatedAt: z.number().int().optional(),
  deviceModelId: z.string({ error: "required" }).regex(ID, "invalid"),
  /** Optional: a guide for one exact variant (SKU or barcode). Empty = every variant of the model. */
  variantCode: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().trim().max(80, "too_long").optional()),
  baseIqd: z.preprocess(whole, z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(1_000, "too_small").max(MAX_GUIDE_BASE_IQD, "too_big")),
  /** Percent of the base price per grade (100 = the base price). */
  multipliers: z.object({ "A+": percent, A: percent, B: percent, C: percent }),
  deductions: z
    .array(z.object({ key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/, "key_invalid"), amountIqd: z.preprocess(whole, z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(MAX_GUIDE_BASE_IQD, "too_big")) }))
    .max(MAX_DEDUCTIONS, "too_long")
    .default([]),
  isActive: z.boolean(),
  reason: z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "reason_short").max(300, "too_long"),
});

/** Creates or changes a guide (devices.price_guide.manage); see the file header. */
export async function saveGuide(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ guideId: string; replayed: boolean }> {
  assertCan(actor, "devices.price_guide.manage");
  const parsed = GuideInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "guide.save");
  const input = parsed.data;
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  input.deductions.forEach((line, index) => {
    if (seen.has(line.key)) fields[`deductions.${index}.key`] = "key_taken";
    seen.add(line.key);
  });
  const multipliers: Partial<Record<UsedGrade, number>> = {};
  for (const grade of GRADE_LIST) {
    const value = input.multipliers[grade];
    if (value !== undefined) multipliers[grade] = value * 100;
  }
  if (Object.keys(multipliers).length === 0) fields["multipliers.A+"] = "required";
  const model = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, input.deviceModelId)).get();
  if (!model) fields.deviceModelId = "invalid";
  let variantId: string | null = null;
  if (input.variantCode && model) {
    const code = latinDigits(input.variantCode).trim();
    const variant = await db
      .select({ id: variants.id, modelId: products.deviceModelId })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(or(sql`upper(${variants.sku}) = ${code.toUpperCase()}`, eq(variants.barcode, code)))
      .get();
    if (!variant) fields.variantCode = "unknown_code";
    else if (variant.modelId !== model.id) fields.variantCode = "variant_not_model";
    else variantId = variant.id;
  }
  if (Object.keys(fields).length > 0) throw invalid(fields, "guide.save");
  const deductions = Object.fromEntries(input.deductions.map((line) => [`missing_${line.key}`, line.amountIqd]));
  const actorId = actor.kind === "employee" ? actor.id : null;
  const existing = input.guideId ? await db.select().from(tradeInPriceGuides).where(eq(tradeInPriceGuides.id, input.guideId)).get() : undefined;
  if (input.guideId && !existing) throw notFound("guide");
  if (existing && input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) throw new AppError("guide_changed", 409);
  const guideId = existing?.id ?? newId("tig");
  const scope = variantId ? eq(tradeInPriceGuides.variantId, variantId) : isNull(tradeInPriceGuides.variantId);
  const after = { deviceModelId: model?.id, variantId, baseIqd: input.baseIqd, multipliers, deductions, isActive: input.isActive };
  if (existing && existing.baseIqd === input.baseIqd && existing.isActive === input.isActive && existing.variantId === variantId && existing.deviceModelId === input.deviceModelId && JSON.stringify(existing.gradeMultipliers ?? {}) === JSON.stringify(multipliers) && JSON.stringify(existing.deductions ?? {}) === JSON.stringify(deductions)) {
    return { guideId, replayed: true };
  }
  await runBatch(db, [
    ...(input.isActive ? [db.update(tradeInPriceGuides).set({ isActive: false, updatedAt: now, updatedBy: actorId }).where(and(eq(tradeInPriceGuides.deviceModelId, input.deviceModelId), scope, eq(tradeInPriceGuides.isActive, true), ne(tradeInPriceGuides.id, guideId)))] : []),
    existing
      ? db
          .update(tradeInPriceGuides)
          .set({ deviceModelId: input.deviceModelId, variantId, baseIqd: input.baseIqd, gradeMultipliers: multipliers, deductions, isActive: input.isActive, updatedBy: actorId, updatedAt: now })
          .where(and(eq(tradeInPriceGuides.id, existing.id), eq(tradeInPriceGuides.updatedAt, existing.updatedAt)))
      : db.insert(tradeInPriceGuides).values({ id: guideId, deviceModelId: input.deviceModelId, variantId, baseIqd: input.baseIqd, gradeMultipliers: multipliers, deductions, isActive: input.isActive, updatedBy: actorId, updatedAt: now }),
    expectChanged(db, 1, { code: "GUIDE_CHANGED", detail: guideId }),
    auditStatement(db, {
      actor,
      action: "devices.guide.save",
      entityType: "trade_in_price_guide",
      entityId: guideId,
      before: existing ? { deviceModelId: existing.deviceModelId, variantId: existing.variantId, baseIqd: existing.baseIqd, multipliers: existing.gradeMultipliers, deductions: existing.deductions, isActive: existing.isActive } : null,
      after,
      reason: input.reason,
      at: now,
    }),
  ]).catch((error: unknown) => {
    if (String((error as Error)?.message ?? "").includes("GUIDE_CHANGED")) throw new AppError("guide_changed", 409, { cause: error });
    throw error;
  });
  return { guideId, replayed: false };
}
