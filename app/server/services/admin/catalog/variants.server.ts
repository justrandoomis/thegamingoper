/**
 * Admin catalogue — SKU variants of a parent product (02.01): platform, colour, capacity (storage), edition, region
 * and condition, the maker's model number and barcodes.
 *
 *   const data = await getVariantsEditor(db, actor, productId, locale);       // rows + read-only price/stock (+ cost)
 *   await saveVariant(db, actor, raw, now);                                     // add (no variantId) or edit
 *   await setVariantActive(db, actor, { productId, variantId, version, active, reason }, now);
 *
 * Rules
 *   · SKU: upper-case letters, digits, - _ . ; unique. Barcodes: 8, 12, 13 or 14 digits with a valid GS1 check digit;
 *     extra barcodes of one SKU live in attributes.variantBarcodes (the first is the variant's own column). A code
 *     names ONE variant: a code another variant holds is refused (`barcode_taken`) — receiving and packing find the
 *     variant by the scanned code.
 *   · Prices are module 03's: a new variant has no price (0) until Pricing sets one; nothing here writes a price. On a
 *     product that is in the store (or scheduled), a new variant therefore starts SWITCHED OFF — an active variant
 *     without a price would be sold at 0 IQD as soon as stock arrives — and it can be switched on once it is priced.
 *   · A variant change never makes a live product less complete (region of a digital code, prices, components).
 *   · Serial tracking can be switched only while the variant holds no stock, reservation or serial: the stock core
 *     relies on it when it ships (a database guard in the same batch, not a check that could go stale).
 *   · Variants are never deleted (orders and stock movements reference them): they are deactivated, with a reason.
 *     The last active variant of a live product cannot be deactivated.
 *   · Cost columns (landed cost, margin) are read only when the employee holds cost.read / profit.read — absent
 *     otherwise, not masked.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { variantCosts, variants, type Product, type Variant } from "~/server/db/schema";
import { expectThat, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { getAvailability } from "~/server/services/inventory/stock.server";
import {
  assertNoRegression,
  barcodeHolders,
  baselines,
  catalogError,
  commitStatements,
  completenessWith,
  parseInput,
  productCompleteness,
  recordedBarcodes,
  requireProductState,
  rethrowCatalog,
  zBool,
  zId,
  zL10n,
  zReason,
  zText,
  zVersion,
} from "./common.server";
import { barcodeCheckDigitOk, KNOWN_OPTION_KEYS, OPTION_AXES, SKU_PATTERN, VARIANT_CONDITIONS } from "./rules";

export type VariantEditorRow = {
  id: string;
  sku: string;
  barcode: string | null;
  extraBarcodes: string[];
  title: L10n | null;
  titleText: string;
  options: Record<string, string>;
  /** Option keys outside the standard axes, as "key=value" lines. */
  otherOptions: string;
  isDefault: boolean;
  isActive: boolean;
  trackSerials: boolean;
  sort: number;
  priceIqd: number;
  compareAtIqd: number | null;
  available: number;
  /** Present only for holders of cost.read. */
  landedCostIqd?: number | null;
  /** Present only for holders of profit.read: (price − landed cost) / price, in basis points. */
  marginBps?: number | null;
};

export type VariantsEditor = {
  productId: string;
  version: number;
  kind: Product["kind"];
  live: boolean;
  rows: VariantEditorRow[];
  showCost: boolean;
  showMargin: boolean;
};

const variantBarcodesOf = recordedBarcodes;

/** On the storefront, or committed to go there: what a variant change may not make less complete. */
const isLiveStatus = (status: string) => status === "published" || status === "scheduled";

/** The variant names its own region (counts as the product's region for digital codes; rules.ts `region`). */
const hasRegion = (variant: Pick<Variant, "options">) => typeof variant.options?.region === "string" && variant.options.region.trim() !== "";

export async function getVariantsEditor(db: Db, actor: Actor, productId: string, locale: Locale): Promise<VariantsEditor> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const ids = state.variants.map((variant) => variant.id);
  const showCost = can(actor, "cost.read");
  const showMargin = can(actor, "profit.read");
  // [P] data: selected only for employees who may see it.
  const costs =
    (showCost || showMargin) && ids.length > 0 ? await db.select({ variantId: variantCosts.variantId, landed: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, ids)) : [];
  const costOf = new Map(costs.map((row) => [row.variantId, row.landed]));
  const availability = await getAvailability(db, ids);
  const extra = variantBarcodesOf(state.product.attributes);
  return {
    productId,
    version: state.product.version,
    kind: state.product.kind,
    live: state.product.status === "published" || state.product.status === "scheduled",
    showCost,
    showMargin,
    rows: state.variants.map((variant) => {
      const options = variant.options ?? {};
      const row: VariantEditorRow = {
        id: variant.id,
        sku: variant.sku,
        barcode: variant.barcode,
        extraBarcodes: (extra[variant.sku] ?? []).filter((code) => code !== variant.barcode),
        title: variant.title,
        titleText: pick(variant.title, locale),
        options,
        otherOptions: Object.entries(options)
          .filter(([key]) => !KNOWN_OPTION_KEYS.includes(key))
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        isDefault: variant.isDefault,
        isActive: variant.isActive,
        trackSerials: variant.trackSerials,
        sort: variant.sort,
        priceIqd: variant.priceIqd,
        compareAtIqd: variant.compareAtIqd,
        available: availability.get(variant.id)?.available ?? 0,
      };
      const landed = costOf.get(variant.id);
      if (showCost) row.landedCostIqd = landed ?? null;
      if (showMargin) row.marginBps = landed !== undefined && variant.priceIqd > 0 ? Math.round(((variant.priceIqd - landed) / variant.priceIqd) * 10_000) : null;
      return row;
    }),
  };
}

// ───────────────────────────────────────────────────────────────── save (add / edit)

const optionText = zText(80);
const upperSku = z.preprocess((value) => (typeof value === "string" ? value.trim().toUpperCase() : value), z.string({ error: "required" }).min(1, "required").max(64, "too_long").regex(SKU_PATTERN, "sku_invalid"));

export const VariantInput = z.object({
  productId: zId,
  version: zVersion,
  variantId: z.preprocess((value) => (value === "" ? undefined : value), zId.optional()),
  sku: upperSku,
  barcode: z.preprocess((value) => (typeof value === "string" ? (value.replace(/\s+/g, "") === "" ? undefined : value.replace(/\s+/g, "")) : value), z.string().optional()),
  extraBarcodes: zText(400),
  title: zL10n(200, false),
  options: z
    .object({
      platform: optionText,
      color: optionText,
      storage: optionText,
      edition: optionText,
      region: optionText,
      condition: z.preprocess((value) => (value === "" ? undefined : value), z.enum(VARIANT_CONDITIONS, { error: "invalid" }).optional()),
      model: optionText,
    })
    .optional(),
  otherOptions: zText(1000),
  trackSerials: zBool,
  isDefault: zBool,
  sort: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(999, "too_big").optional()),
  reason: zReason(false),
});

function parseOtherOptions(text: string | undefined): { options: Record<string, string>; error: string | null } {
  const options: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) return { options, error: "options_invalid" };
    const key = trimmed.slice(0, at).trim().toLowerCase();
    const value = trimmed.slice(at + 1).trim();
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || KNOWN_OPTION_KEYS.includes(key) || !value || value.length > 80) return { options, error: "options_invalid" };
    options[key] = value;
  }
  if (Object.keys(options).length > 12) return { options, error: "options_invalid" };
  return { options, error: null };
}

function parseBarcodes(main: string | undefined, extra: string | undefined): { barcode: string | null; all: string[]; error: Record<string, string> } {
  const error: Record<string, string> = {};
  if (main && !barcodeCheckDigitOk(main)) error.barcode = "barcode_invalid";
  const others = (extra ?? "")
    .split(/[\s,;]+/)
    .map((code) => code.trim())
    .filter(Boolean);
  if (others.some((code) => !barcodeCheckDigitOk(code))) error.extraBarcodes = "barcode_invalid";
  if (others.length > 10) error.extraBarcodes = "too_long";
  const all = [...new Set([...(main ? [main] : []), ...others])];
  return { barcode: main ?? null, all, error };
}

export async function saveVariant(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ variantId: string; version: number }> {
  // The permission first (editing an existing variant or adding one), before the input is read: a role without it
  // gets "forbidden", never a list of field errors.
  const editing = typeof raw === "object" && raw !== null && typeof (raw as { variantId?: unknown }).variantId === "string" && (raw as { variantId: string }).variantId !== "";
  assertCan(actor, editing ? "catalog.product.update" : "catalog.product.create");
  const input = parseInput(VariantInput, raw);
  const state = await requireProductState(db, input.productId);
  const { product } = state;
  if (product.version !== input.version) throw catalogError("product_changed");
  if (product.status === "archived") throw catalogError("status_not_allowed", 409, { detail: "archived" });

  const other = parseOtherOptions(input.otherOptions);
  const codes = parseBarcodes(input.barcode, input.extraBarcodes);
  const fieldErrors: Record<string, string> = { ...codes.error };
  if (other.error) fieldErrors.otherOptions = other.error;
  if (Object.keys(fieldErrors).length > 0) throw invalid(fieldErrors);

  const existing = input.variantId ? state.variants.find((variant) => variant.id === input.variantId) : undefined;
  if (input.variantId && !existing) throw notFound("variant");
  const skuOwner = await db.select({ id: variants.id }).from(variants).where(eq(variants.sku, input.sku)).get();
  if (skuOwner && skuOwner.id !== existing?.id) throw catalogError("sku_taken", 409, { fields: { sku: "sku_taken" } });

  // One code, one variant. Codes this variant already carries are not checked again (an old duplicate does not block
  // an unrelated edit); every code it gains must be free — in another variant's column or another SKU's extra codes.
  const held = new Set(existing ? [existing.barcode, ...(variantBarcodesOf(product.attributes)[existing.sku] ?? [])].filter((code): code is string => Boolean(code)) : []);
  const taken = new Set((await barcodeHolders(db, codes.all.filter((code) => !held.has(code)))).map((holder) => holder.code));
  if (taken.size > 0) {
    const fields: Record<string, string> = {};
    if (codes.barcode && taken.has(codes.barcode)) fields.barcode = "barcode_taken";
    if (codes.all.some((code) => code !== codes.barcode && taken.has(code))) fields.extraBarcodes = "barcode_taken";
    throw catalogError("barcode_taken", 409, { fields });
  }

  const options: Record<string, string> = { ...other.options };
  for (const axis of [...OPTION_AXES, "model"] as const) {
    const value = input.options?.[axis];
    if (value) options[axis] = value;
  }

  const live = isLiveStatus(product.status);
  const variantId = existing?.id ?? newId("var");
  const sort = input.sort ?? existing?.sort ?? (state.variants.reduce((max, variant) => Math.max(max, variant.sort), -1) + 1);
  // A new variant of a live product starts switched off: it has no price until Pricing sets one, and an active
  // unpriced variant would be sold at 0 IQD as soon as stock arrives. A switched-off variant is not the default.
  const startsOff = !existing && live;
  const isDefault = (input.isDefault && !startsOff) || (!existing && state.variants.length === 0);
  const nextVariant: Variant = {
    ...(existing ?? {
      id: variantId,
      productId: product.id,
      priceIqd: 0,
      compareAtIqd: null,
      isActive: !startsOff,
      weightGrams: null,
      createdAt: now,
      updatedAt: now,
    }),
    sku: input.sku,
    barcode: codes.barcode,
    title: input.title,
    options: Object.keys(options).length > 0 ? options : null,
    trackSerials: input.trackSerials,
    isDefault,
    sort,
  } as Variant;

  const nextVariants = existing ? state.variants.map((variant) => (variant.id === existing.id ? nextVariant : variant)) : [...state.variants, nextVariant];
  // One default variant: choosing this one clears the others.
  const withDefault = isDefault ? nextVariants.map((variant) => (variant.id === variantId ? variant : { ...variant, isDefault: false })) : nextVariants;

  // Extra barcodes per SKU (and the old SKU's entry moves with a renamed SKU).
  const attributes: Record<string, unknown> = { ...(product.attributes ?? {}) };
  const barcodeMap: Record<string, string[]> = { ...variantBarcodesOf(product.attributes) };
  if (existing && existing.sku !== input.sku) delete barcodeMap[existing.sku];
  if (codes.all.length > 1) barcodeMap[input.sku] = codes.all;
  else delete barcodeMap[input.sku];
  if (Object.keys(barcodeMap).length > 0) attributes.variantBarcodes = barcodeMap;
  else delete attributes.variantBarcodes;
  const nextProduct: Product = { ...product, attributes: Object.keys(attributes).length > 0 ? attributes : null };

  // A live product keeps every requirement it meets (a digital code's region may live on its variants only).
  if (live) {
    const before = await productCompleteness(db, product.id);
    if (before) {
      const active = withDefault.filter((variant) => variant.isActive);
      assertNoRegression(
        product.status,
        before.completeness,
        completenessWith(before.facts, { activeVariants: active.length, unpricedVariants: active.filter((variant) => variant.priceIqd <= 0).length, variantsHaveRegion: active.every(hasRegion) }),
      );
    }
  }

  const extra = [];
  // The variant's own barcode column, checked again inside the batch (two staff saving the same code at once).
  if (codes.barcode && !held.has(codes.barcode)) {
    extra.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM variants WHERE barcode = ${codes.barcode} AND id <> ${variantId})`, { code: "BARCODE_TAKEN", detail: codes.barcode }));
  }
  // Serial tracking changes only while nothing of this variant is in stock, reserved or serialised.
  if (existing && existing.trackSerials !== input.trackSerials) {
    extra.push(
      expectThat(
        db,
        sql`NOT EXISTS (SELECT 1 FROM stock_levels WHERE variant_id = ${existing.id} AND (on_hand <> 0 OR reserved <> 0))
          AND NOT EXISTS (SELECT 1 FROM serials WHERE variant_id = ${existing.id} AND status IN ('in_stock', 'reserved', 'intake'))
          AND NOT EXISTS (SELECT 1 FROM stock_reservations WHERE variant_id = ${existing.id} AND status = 'active')`,
        { code: "TRACK_SERIALS_LOCKED", detail: existing.id },
      ),
    );
  }

  const hasBaseline = (await baselines(db, [product])).has(product.id);
  const plan = commitStatements(db, {
    actor,
    now,
    before: state,
    after: { product: nextProduct, variants: withDefault },
    inserts: existing ? [] : [{ ...nextVariant }],
    action: existing ? "catalog.variant.update" : "catalog.variant.create",
    reason: input.reason ?? null,
    summary: `${product.slug} · ${input.sku}`,
    extra,
    hasBaseline,
  });
  await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
  return { variantId, version: plan.version };
}

// ───────────────────────────────────────────────────────────────── activate / deactivate

export const VariantActiveInput = z.object({
  productId: zId,
  variantId: zId,
  version: zVersion,
  active: zBool,
  reason: zReason(true),
});

export async function setVariantActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ version: number }> {
  assertCan(actor, "catalog.product.update");
  const input = parseInput(VariantActiveInput, raw);
  const state = await requireProductState(db, input.productId);
  const { product } = state;
  if (product.version !== input.version) throw catalogError("product_changed");
  const target = state.variants.find((variant) => variant.id === input.variantId);
  if (!target) throw notFound("variant");
  if (target.isActive === input.active) return { version: product.version };

  if (!input.active) {
    const before = await productCompleteness(db, product.id);
    if (before) {
      const remaining = state.variants.filter((variant) => variant.isActive && variant.id !== target.id);
      const after = completenessWith(before.facts, {
        activeVariants: remaining.length,
        unpricedVariants: remaining.filter((variant) => variant.priceIqd <= 0).length,
        variantsWithoutComponents: Math.max(0, before.facts.variantsWithoutComponents - (await isComponentless(db, target.id))),
      });
      if (remaining.length === 0 && isLiveStatus(product.status)) throw catalogError("variant_last_active");
      assertNoRegression(product.status, before.completeness, after);
    }
  } else if (isLiveStatus(product.status)) {
    // Switching on: on a live product the variant must be ready to sell — a price (an unpriced active variant would
    // sell at 0 IQD), its region where the kind needs one, its components for a bundle.
    const before = await productCompleteness(db, product.id);
    if (before) {
      const active = [...state.variants.filter((variant) => variant.isActive), target];
      const after = completenessWith(before.facts, {
        activeVariants: active.length,
        unpricedVariants: active.filter((variant) => variant.priceIqd <= 0).length,
        variantsHaveRegion: active.every(hasRegion),
        variantsWithoutComponents: before.facts.variantsWithoutComponents + (await hasNoComponents(db, target.id)),
      });
      assertNoRegression(product.status, before.completeness, after);
    }
  }

  let next = state.variants.map((variant) => (variant.id === target.id ? { ...variant, isActive: input.active } : variant));
  // The default moves to the first other active variant when the default is switched off.
  if (!input.active && target.isDefault) {
    const heir = next.find((variant) => variant.isActive && variant.id !== target.id);
    if (heir) next = next.map((variant) => ({ ...variant, isDefault: variant.id === heir.id }));
  }
  const hasBaseline = (await baselines(db, [product])).has(product.id);
  const plan = commitStatements(db, {
    actor,
    now,
    before: state,
    after: { product, variants: next },
    action: input.active ? "catalog.variant.activate" : "catalog.variant.deactivate",
    reason: input.reason,
    summary: `${product.slug} · ${target.sku}`,
    hasBaseline,
  });
  await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
  return { version: plan.version };
}

/** 1 when the variant is active and has no bundle component (it counted as "without components"), else 0. */
async function isComponentless(db: Db, variantId: string): Promise<number> {
  const row = await db.get<{ n: number }>(sql`SELECT (SELECT is_active FROM variants WHERE id = ${variantId}) = 1 AND NOT EXISTS (SELECT 1 FROM bundle_items WHERE bundle_variant_id = ${variantId}) AS n`);
  return Number(row?.n ?? 0);
}

/** 1 when the variant has no bundle component (whether or not it is active), else 0. */
async function hasNoComponents(db: Db, variantId: string): Promise<number> {
  const row = await db.get<{ n: number }>(sql`SELECT NOT EXISTS (SELECT 1 FROM bundle_items WHERE bundle_variant_id = ${variantId}) AS n`);
  return Number(row?.n ?? 0);
}

/** Variants by SKU (any product), for pickers that accept a typed or scanned SKU or barcode. */
export async function findVariantByCode(db: Db, code: string): Promise<{ id: string; productId: string; sku: string } | null> {
  const clean = code.trim();
  if (!clean || clean.length > 64) return null;
  const row = await db
    .select({ id: variants.id, productId: variants.productId, sku: variants.sku })
    .from(variants)
    .where(sql`${variants.sku} = ${clean.toUpperCase()} OR ${variants.barcode} = ${clean}`)
    .get();
  return row ?? null;
}

