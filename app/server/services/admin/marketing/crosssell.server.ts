/**
 * Admin 16.05 — cross-sell with a device (a case, a controller, protection…) as staff rules over the recommendation
 * engine's own controls (`recommendation_rules`, read by recommendations.server.ts — rule 5 of its header):
 *
 *   pin      puts the product first on the device's shelves (it still has to pass the engine's hard compatibility
 *            filter and its stock rule — a rule never makes a product "fit")
 *   boost    adds its weight to the product's score there
 *   exclude  removes the product from those shelves
 *
 *   listCrossSellRules(db, actor, filters, locale, now)        marketing.recommendation.manage
 *   deviceAddOns(db, actor, deviceModelId, locale, now)        the add-ons VERIFIED on a device (what may be pinned or boosted)
 *   saveCrossSellRule / setCrossSellRuleActive(db, actor, raw, now)
 *   previewDeviceShelf(db, actor, deviceModelId, locale, now)  the device page's "complete your setup" shelf, as shoppers see it now
 *
 * VERIFIED COMPATIBILITY ONLY: a pin or a boost is refused unless the product is verified on the device by the
 * catalogue's compatibility rules (compatibility.server.ts — partial, incompatible and unverified are refused, with
 * the status said), and it must be an add-on (ADDON_KINDS). Re-activating a rule checks again. The list says, for
 * every rule, what it does on the storefront now (shows, removed, or why it does not show).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ProductCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { recommendationRules } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { getCardsByIds, MAX_CARD_IDS } from "~/server/services/catalog/cards.server";
import { compatibilityForModels, loadDeviceTargets, type DeviceTarget } from "~/server/services/compatibility.server";
import { getRecommendations } from "~/server/services/recommendations.server";
import { actorId, assertAny, employeeNames, ID, num, SECTION_READ } from "./shared.server";
import { ADDON_KINDS, CROSS_SELL_PLACEMENTS, RULE_KINDS, RULE_WEIGHT_MAX, dayStart, DAY_MS, latinDigits, normalizeDay, type RuleEffect, type RuleFilters, type RuleKind } from "./types";

/**
 * True when no OTHER active rule of this kind names the product on this device and shelf ("one active rule per kind,
 * product, device and shelf") — a guard inside the write, so two requests at once never leave two.
 */
function noActiveTwin(rule: { kind: string; productId: string; deviceModelId: string; placement: string; exceptId?: string }) {
  return sql`NOT EXISTS (SELECT 1 FROM recommendation_rules WHERE is_active = 1 AND kind = ${rule.kind} AND product_id = ${rule.productId}
    AND json_extract(context, '$.deviceModelId') = ${rule.deviceModelId} AND COALESCE(json_extract(context, '$.placement'), '') = ${rule.placement}
    AND id <> ${rule.exceptId ?? ""})`;
}
const TWIN = { fields: { productId: "rule_exists" } };

export type DeviceOption = { id: string; slug: string; name: string; platformId: string };
export type AddOnOption = { productId: string; name: string; kind: string; stock: string | null };

export type CrossSellRuleRow = {
  id: string;
  kind: RuleKind;
  productId: string;
  productName: string;
  productKind: string | null;
  deviceModelId: string | null;
  deviceName: string | null;
  placement: string;
  weight: number;
  reason: string | null;
  isActive: boolean;
  startsAt: number | null;
  endsAt: number | null;
  createdAt: number;
  createdBy: string | null;
  effect: RuleEffect;
};

type RuleDbRow = { id: string; kind: string; context: string | null; product_id: string; weight: number; reason: string | null; created_by: string | null; is_active: number; starts_at: number | null; ends_at: number | null; created_at: number; product_name: string | null; product_kind: string | null; product_status: string | null };

const parseL10n = (text: string | null): L10n => {
  try {
    return text ? (JSON.parse(text) as L10n) : { ar: "" };
  } catch {
    return { ar: text ?? "" };
  }
};
const parseContext = (text: string | null): { deviceModelId?: string; placement?: string } => {
  try {
    const value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { deviceModelId: typeof value.deviceModelId === "string" ? value.deviceModelId : undefined, placement: typeof value.placement === "string" ? value.placement : undefined };
  } catch {
    return {};
  }
};

export async function deviceOptions(db: Db, locale: Locale): Promise<{ targets: DeviceTarget[]; options: DeviceOption[] }> {
  const targets = (await loadDeviceTargets(db)).filter((target) => target.platformActive);
  return { targets, options: targets.map((target) => ({ id: target.id, slug: target.slug, name: pick(target.name, locale) || target.slug, platformId: target.platformId })) };
}

async function cardsOf(db: Db, locale: Locale, ids: readonly string[], now: number): Promise<Map<string, ProductCardData>> {
  const out = new Map<string, ProductCardData>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += MAX_CARD_IDS) for (const card of await getCardsByIds(db, locale, unique.slice(i, i + MAX_CARD_IDS), { now })) out.set(card.id, card);
  return out;
}

/** The compatibility answer of products on a device ("unverified" without a rule). */
async function compatOn(db: Db, target: DeviceTarget, productIds?: readonly string[]): Promise<Map<string, string>> {
  const compat = await compatibilityForModels(db, [target]);
  const answers = compat.byModel.get(target.id) ?? new Map();
  const out = new Map<string, string>();
  for (const [productId, resolution] of answers) out.set(productId, resolution.status);
  if (productIds) for (const id of productIds) if (!out.has(id)) out.set(id, "unverified");
  return out;
}

export type CrossSellPage = { rows: CrossSellRuleRow[]; total: number; page: number; pageCount: number; devices: DeviceOption[] };

export async function listCrossSellRules(db: Db, actor: Actor, filters: RuleFilters, locale: Locale, now: number): Promise<CrossSellPage> {
  assertAny(actor, SECTION_READ.crossSell);
  const { targets, options } = await deviceOptions(db, locale);
  const active = filters.active === "active" ? sql`r.is_active = 1` : filters.active === "inactive" ? sql`r.is_active = 0` : sql`1 = 1`;
  const kind = filters.kind ? sql`r.kind = ${filters.kind}` : sql`1 = 1`;
  const device = filters.device ? sql`json_extract(r.context, '$.deviceModelId') = ${filters.device}` : sql`1 = 1`;
  const rows = await db.all<RuleDbRow>(sql`
    SELECT r.*, p.name AS product_name, p.kind AS product_kind, p.status AS product_status
    FROM recommendation_rules r LEFT JOIN products p ON p.id = r.product_id
    WHERE ${active} AND ${kind} AND ${device}
    ORDER BY r.is_active DESC, r.created_at DESC LIMIT 500`);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const visible = rows.slice((page - 1) * 25, page * 25);
  const names = await employeeNames(db, visible.map((row) => row.created_by));
  const cards = await cardsOf(db, locale, visible.map((row) => row.product_id), now);
  // compatibility per device of the visible rules (one round trip per device)
  const byDevice = new Map<string, Map<string, string>>();
  for (const deviceId of new Set(visible.map((row) => parseContext(row.context).deviceModelId).filter((id): id is string => Boolean(id)))) {
    const target = targets.find((entry) => entry.id === deviceId);
    if (target) byDevice.set(deviceId, await compatOn(db, target));
  }
  return {
    rows: visible.map((row) => {
      const context = parseContext(row.context);
      const target = context.deviceModelId ? targets.find((entry) => entry.id === context.deviceModelId) : undefined;
      const effect = effectOf(row, context, byDevice.get(context.deviceModelId ?? "") ?? null, cards.get(row.product_id) ?? null, now);
      return {
        id: row.id,
        kind: (RULE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as RuleKind) : "boost",
        productId: row.product_id,
        productName: pick(parseL10n(row.product_name), locale) || row.product_id,
        productKind: row.product_kind,
        deviceModelId: context.deviceModelId ?? null,
        deviceName: target ? pick(target.name, locale) || target.slug : null,
        placement: context.placement ?? "",
        weight: num(row.weight),
        reason: row.reason,
        isActive: num(row.is_active) === 1,
        startsAt: row.starts_at === null ? null : num(row.starts_at),
        endsAt: row.ends_at === null ? null : num(row.ends_at),
        createdAt: num(row.created_at),
        createdBy: row.created_by ? (names.get(row.created_by) ?? null) : null,
        effect,
      };
    }),
    total,
    page,
    pageCount,
    devices: options,
  };
}

/** What a rule does on the storefront now (the engine's rules, read the same way). */
function effectOf(row: RuleDbRow, context: { deviceModelId?: string }, compat: Map<string, string> | null, card: ProductCardData | null, now: number): RuleEffect {
  if (num(row.is_active) !== 1) return "inactive";
  if (row.ends_at !== null && num(row.ends_at) <= now) return "ended";
  if (row.starts_at !== null && num(row.starts_at) > now) return "not_started";
  if (row.kind === "exclude") return "removes";
  if (row.product_status !== "published") return "not_published";
  if (context.deviceModelId) {
    const status = compat?.get(row.product_id) ?? "unverified";
    if (status !== "verified") return status === "partial" ? "partial" : status === "incompatible" ? "incompatible" : "unverified";
  }
  if (!card || card.stock === "out_of_stock") return "out_of_stock";
  return "shows";
}

/** The published add-ons VERIFIED on a device (what a pin or a boost may name), with their stock state. */
export async function deviceAddOns(db: Db, actor: Actor, deviceModelId: string, locale: Locale, now: number): Promise<{ device: DeviceOption | null; addOns: AddOnOption[] }> {
  assertAny(actor, SECTION_READ.crossSell);
  const { targets, options } = await deviceOptions(db, locale);
  const target = targets.find((entry) => entry.id === deviceModelId);
  if (!target) return { device: null, addOns: [] };
  const compat = await compatibilityForModels(db, [target]);
  const verified = [...(compat.byModel.get(target.id) ?? new Map()).entries()]
    .filter(([productId, resolution]) => resolution.status === "verified" && (ADDON_KINDS as readonly string[]).includes(compat.products.get(productId)?.kind ?? ""))
    .map(([productId]) => productId);
  const cards = await cardsOf(db, locale, verified, now);
  const addOns = verified
    .map((productId) => {
      const card = cards.get(productId);
      return { productId, name: card?.name ?? productId, kind: compat.products.get(productId)?.kind ?? "", stock: card?.stock ?? null };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { device: options.find((option) => option.id === target.id) ?? null, addOns };
}

const SaveInput = z.object({
  kind: z.enum(RULE_KINDS, { error: "required" }),
  deviceModelId: z.string({ error: "device_required" }).regex(ID, "device_required"),
  productId: z.string({ error: "required" }).regex(ID, "required"),
  placement: z.preprocess((value) => (typeof value === "string" ? value : ""), z.enum(CROSS_SELL_PLACEMENTS, { error: "invalid" })),
  // a whole number in Latin, Arabic-Indic or Persian digits — never "0x10", "1e2" or " 5 0"
  weight: z.preprocess(
    (value) => {
      if (value === "" || value === undefined || value === null) return 0;
      const text = latinDigits(String(value).trim());
      return /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
    },
    z.number({ error: "number_invalid" }).int("number_invalid").min(0, "number_invalid").max(RULE_WEIGHT_MAX, "number_invalid"),
  ),
  reason: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, "reason_required").min(3, "too_short").max(300, "too_long")),
  startsOn: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().max(20)),
  endsOn: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().max(20)),
});
export type SaveRuleInput = z.input<typeof SaveInput>;

/** A new rule. A pin or a boost needs the product VERIFIED on the device and an add-on; a boost a weight of 1–100. */
export async function saveCrossSellRule(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ ruleId: string }> {
  assertAny(actor, ["marketing.recommendation.manage"]);
  const input = SaveInput.parse(raw ?? {});
  const fields: Record<string, string> = {};
  const targets = await loadDeviceTargets(db);
  const target = targets.find((entry) => entry.id === input.deviceModelId && entry.platformActive);
  if (!target) throw invalid({ deviceModelId: "device_required" });
  const product = (await db.all<{ id: string; kind: string; status: string }>(sql`SELECT id, kind, status FROM products WHERE id = ${input.productId}`))[0];
  if (!product) throw invalid({ productId: "required" });
  if (!(ADDON_KINDS as readonly string[]).includes(product.kind)) throw invalid({ productId: "product_not_addon" });
  if (input.kind !== "exclude") {
    if (product.status !== "published") fields.productId = "not_published";
    const status = (await compatOn(db, target, [product.id])).get(product.id) ?? "unverified";
    if (status !== "verified") throw new AppError("rule_not_verified", 409, { fields: { productId: `compat_${status}` }, detail: status });
    if (input.kind === "boost" && input.weight < 1) fields.weight = "number_invalid";
  }
  const startsOn = input.startsOn ? normalizeDay(input.startsOn) : null;
  const endsOn = input.endsOn ? normalizeDay(input.endsOn) : null;
  if (input.startsOn && !startsOn) fields.startsOn = "date_invalid";
  if (input.endsOn && !endsOn) fields.endsOn = "date_invalid";
  if (startsOn && endsOn && startsOn > endsOn) fields.endsOn = "range_order";
  const endsAt = endsOn ? (dayStart(endsOn) as number) + DAY_MS : null;
  if (endsAt !== null && endsAt <= now) fields.endsOn = "end_past";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const context: Record<string, string> = { deviceModelId: target.id };
  if (input.placement) context.placement = input.placement;
  const duplicate = await db.all<{ id: string }>(sql`
    SELECT id FROM recommendation_rules WHERE is_active = 1 AND kind = ${input.kind} AND product_id = ${product.id}
      AND json_extract(context, '$.deviceModelId') = ${target.id} AND COALESCE(json_extract(context, '$.placement'), '') = ${input.placement}`);
  if (duplicate.length > 0) throw new AppError("rule_changed", 409, TWIN);
  const ruleId = newRuleId();
  await runBatch(db, [
    expectThat(db, noActiveTwin({ kind: input.kind, productId: product.id, deviceModelId: target.id, placement: input.placement }), "RULE_EXISTS"),
    db.insert(recommendationRules).values({
      id: ruleId,
      kind: input.kind,
      context,
      productId: product.id,
      weight: input.kind === "exclude" ? 0 : input.weight,
      reason: input.reason,
      createdBy: actorId(actor),
      isActive: true,
      startsAt: startsOn ? dayStart(startsOn) : null,
      endsAt,
      createdAt: now,
    }),
    auditStatement(db, { actor, action: "marketing.recommendation.create", entityType: "recommendation_rule", entityId: ruleId, after: { kind: input.kind, productId: product.id, deviceModelId: target.id, placement: input.placement || null, weight: input.weight, startsOn, endsOn }, reason: input.reason, at: now }),
  ]).catch((error) => {
    // the same rule was made by someone else just before this write
    if (mapDbError(error)?.code === "RULE_EXISTS") throw new AppError("rule_changed", 409, TWIN);
    throw error;
  });
  return { ruleId };
}

function newRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `rrl_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const ActiveInput = z.object({
  ruleId: z.string().regex(ID, "invalid"),
  active: z.preprocess((value) => value === true || value === "1" || value === "true", z.boolean()),
  reason: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, "reason_required").min(3, "too_short").max(300, "too_long")),
});

/**
 * Switches a rule off or on again (with a reason). Switching on keeps "one active rule per kind, product, device and
 * shelf" (also inside the write), and a pin or a boost is verified again: the device must still be published and the
 * product verified on it — a device that can no longer be checked is a refusal, never a skipped check.
 */
export async function setCrossSellRuleActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertAny(actor, ["marketing.recommendation.manage"]);
  const input = ActiveInput.parse(raw ?? {});
  const row = (await db.all<RuleDbRow>(sql`SELECT r.*, NULL AS product_name, p.kind AS product_kind, p.status AS product_status FROM recommendation_rules r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ${input.ruleId}`))[0];
  if (!row) throw new AppError("not_found", 404);
  if ((num(row.is_active) === 1) === input.active) return { changed: false };
  const context = parseContext(row.context);
  const statements: BatchStatement[] = [];
  if (input.active) {
    if (row.kind !== "exclude") {
      const target = context.deviceModelId ? (await loadDeviceTargets(db)).find((entry) => entry.id === context.deviceModelId && entry.platformActive) : undefined;
      if (!target) throw new AppError("rule_not_verified", 409, { fields: { productId: "compat_unverified" }, detail: "device" });
      const status = (await compatOn(db, target, [row.product_id])).get(row.product_id) ?? "unverified";
      if (status !== "verified") throw new AppError("rule_not_verified", 409, { fields: { productId: `compat_${status}` }, detail: status });
    }
    if (context.deviceModelId) {
      const twin = { kind: row.kind, productId: row.product_id, deviceModelId: context.deviceModelId, placement: context.placement ?? "", exceptId: row.id };
      if ((await db.all<{ ok: number }>(sql`SELECT CASE WHEN ${noActiveTwin(twin)} THEN 1 ELSE 0 END AS ok`))[0]?.ok !== 1) throw new AppError("rule_changed", 409, TWIN);
      statements.push(expectThat(db, noActiveTwin(twin), "RULE_EXISTS"));
    }
  }
  try {
    await runBatch(db, [
      ...statements,
      db.update(recommendationRules).set({ isActive: input.active }).where(sql`${recommendationRules.id} = ${row.id} AND ${recommendationRules.isActive} = ${input.active ? 0 : 1}`),
      expectChanged(db, 1, "RULE_CHANGED"),
      auditStatement(db, { actor, action: input.active ? "marketing.recommendation.activate" : "marketing.recommendation.deactivate", entityType: "recommendation_rule", entityId: row.id, before: { isActive: !input.active }, after: { isActive: input.active }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "RULE_CHANGED") throw new AppError("rule_changed", 409);
    if (code === "RULE_EXISTS") throw new AppError("rule_changed", 409, TWIN);
    throw error;
  }
  return { changed: true };
}

export type ShelfPreview = { title: string; reason: string | null; items: { productId: string; name: string; kind: string; ruled: "pin" | "boost" | null }[] } | null;

/** The device page's setup shelf as a shopper without personal signals sees it now (the engine itself, read only). */
export async function previewDeviceShelf(db: Db, actor: Actor, deviceModelId: string, locale: Locale, now: number): Promise<ShelfPreview> {
  assertAny(actor, SECTION_READ.crossSell);
  if (!ID.test(deviceModelId)) return null;
  const shelves = await getRecommendations(db, { locale, context: "device_hub", deviceModelId, consent: false, now }, 8);
  const shelf = shelves[0];
  if (!shelf) return null;
  const rules = await db.all<{ product_id: string; kind: string }>(sql`
    SELECT product_id, kind FROM recommendation_rules
    WHERE is_active = 1 AND kind IN ('pin', 'boost') AND json_extract(context, '$.deviceModelId') = ${deviceModelId}
      AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now})`);
  const ruled = new Map<string, "pin" | "boost">();
  for (const rule of rules) if (rule.kind === "pin" || !ruled.has(rule.product_id)) ruled.set(rule.product_id, rule.kind as "pin" | "boost");
  return { title: shelf.title, reason: shelf.reason ?? null, items: shelf.items.map((card) => ({ productId: card.id, name: card.name, kind: card.kind, ruled: ruled.get(card.id) ?? null })) };
}
