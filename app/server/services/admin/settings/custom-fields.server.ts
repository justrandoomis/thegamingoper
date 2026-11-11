/**
 * Admin 22.03 — custom fields per product kind (`custom_fields`, entity "product"). The catalogue (module 02) already
 * renders them in the product editor, checks each value by its type (number, date, one of the options…) and treats an
 * active REQUIRED field as a publishing requirement — so making a field required, or adding one, changes which
 * products can be published. The editor shows that impact before saving: how many live and draft products of the kind
 * have no value (live ones stay on sale and show as incomplete; a draft cannot be published until it is filled).
 *
 * Rules (settings.custom_field.manage to change; settings.read to see):
 *   · The key is the reference products keep their values under: it never changes once created (key_locked), and one
 *     key means one field across all kinds (key_taken) — "*" and a kind cannot both define it.
 *   · The type cannot change once any product holds a value (type_locked); an option cannot be removed while products
 *     use it (option_in_use) — relabelling is fine.
 *   · Switching a field off keeps the values (hidden from the editor and from the requirements); switching it on again
 *     brings them back.
 * Not here: min/max/pattern rules (the `validation` column) — the catalogue does not enforce them, so offering them
 * would be a rule on paper only (requested from the catalogue's owner).
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { CUSTOM_FIELD_TYPES, PRODUCT_KIND_SCOPES, customFields, type CustomField, type CustomFieldType, type ProductKindScope } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";

const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const OPTION_VALUE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export type FieldUsage = { withValue: number; liveMissing: number; draftMissing: number };

export type CustomFieldRow = {
  id: string;
  key: string;
  label: string;
  labelL10n: L10n;
  productKind: ProductKindScope;
  type: CustomFieldType;
  options: { value: string; label: string; labelL10n: L10n }[];
  required: boolean;
  filterable: boolean;
  sort: number;
  isActive: boolean;
  usage: FieldUsage;
};

/** Products of a kind ("*" = all) holding a value for `key`, and the live / draft ones that do not. */
async function usageOf(db: Db, key: string, kind: ProductKindScope): Promise<FieldUsage> {
  if (!KEY.test(key)) return { withValue: 0, liveMissing: 0, draftMissing: 0 };
  const path = `$.${key}`;
  const kindSql = kind === "*" ? sql`1 = 1` : sql`kind = ${kind}`;
  const rows = await db.all<{ withValue: number; liveMissing: number; draftMissing: number }>(sql`
    SELECT
      coalesce(sum(CASE WHEN json_extract(attributes, ${path}) IS NOT NULL THEN 1 ELSE 0 END), 0) AS withValue,
      coalesce(sum(CASE WHEN json_extract(attributes, ${path}) IS NULL AND status IN ('published', 'scheduled') THEN 1 ELSE 0 END), 0) AS liveMissing,
      coalesce(sum(CASE WHEN json_extract(attributes, ${path}) IS NULL AND status IN ('draft', 'review') THEN 1 ELSE 0 END), 0) AS draftMissing
    FROM products WHERE ${kindSql}`);
  return { withValue: Number(rows[0]?.withValue ?? 0), liveMissing: Number(rows[0]?.liveMissing ?? 0), draftMissing: Number(rows[0]?.draftMissing ?? 0) };
}

/** Products per kind that are live and that are drafts — for the impact of a NEW required field (none has a value yet). */
export async function productCountsByKind(db: Db): Promise<Record<string, { live: number; drafts: number }>> {
  const rows = await db.all<{ kind: string; live: number; drafts: number }>(sql`
    SELECT kind, sum(CASE WHEN status IN ('published', 'scheduled') THEN 1 ELSE 0 END) AS live, sum(CASE WHEN status IN ('draft', 'review') THEN 1 ELSE 0 END) AS drafts FROM products GROUP BY kind`);
  const out: Record<string, { live: number; drafts: number }> = { "*": { live: 0, drafts: 0 } };
  for (const row of rows) {
    out[row.kind] = { live: Number(row.live), drafts: Number(row.drafts) };
    out["*"].live += Number(row.live);
    out["*"].drafts += Number(row.drafts);
  }
  return out;
}

const view = (row: CustomField, locale: Locale, usage: FieldUsage): CustomFieldRow => ({
  id: row.id,
  key: row.key,
  label: pick(row.label, locale),
  labelL10n: row.label,
  productKind: row.productKind,
  type: row.type,
  options: (row.options ?? []).map((option) => ({ value: option.value, label: pick(option.label, locale), labelL10n: option.label })),
  required: row.required,
  filterable: row.filterable,
  sort: row.sort,
  isActive: row.isActive,
  usage,
});

export async function listCustomFields(db: Db, actor: Actor, locale: Locale): Promise<{ rows: CustomFieldRow[]; canManage: boolean; counts: Record<string, { live: number; drafts: number }> }> {
  assertCan(actor, "settings.read");
  const rows = await db.select().from(customFields).where(eq(customFields.entity, "product")).orderBy(asc(customFields.productKind), asc(customFields.sort), asc(customFields.key));
  const usages = await Promise.all(rows.map((row) => usageOf(db, row.key, row.productKind)));
  return { rows: rows.map((row, index) => view(row, locale, usages[index])), canManage: can(actor, "settings.custom_field.manage"), counts: await productCountsByKind(db) };
}

export async function getCustomField(db: Db, actor: Actor, fieldId: string, locale: Locale): Promise<CustomFieldRow & { version: string }> {
  assertCan(actor, "settings.read");
  const row = await db.select().from(customFields).where(and(eq(customFields.id, fieldId), eq(customFields.entity, "product"))).get();
  if (!row) throw notFound("custom_field");
  return { ...view(row, locale, await usageOf(db, row.key, row.productKind)), version: fingerprint(row) };
}

/** What a field looked like when the form was built (fields have no updated_at column). */
const fingerprint = (row: CustomField) => JSON.stringify([row.label, row.productKind, row.type, row.options ?? [], row.required, row.filterable, row.sort, row.isActive]);

const text = (max: number) => z.string().trim().max(max, "too_long");
const OptionInput = z.object({ value: z.string().trim().regex(OPTION_VALUE, "option_invalid"), labelAr: z.string().trim().min(1, "required").max(80, "too_long"), labelEn: text(80).optional() });

export const CustomFieldInput = z.object({
  fieldId: z.string().max(64).optional(),
  version: z.string().max(10_000).optional(),
  key: z.string().trim().toLowerCase().regex(KEY, "key_invalid"),
  productKind: z.enum(PRODUCT_KIND_SCOPES, { error: "required" }),
  labelAr: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  labelEn: text(80).optional(),
  labelCkb: text(80).optional(),
  type: z.enum(CUSTOM_FIELD_TYPES, { error: "required" }),
  options: z.array(OptionInput).max(60).default([]),
  required: z.boolean(),
  filterable: z.boolean(),
  sort: z.number().int().min(0).max(999).default(0),
  reason: z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long"),
});

/** Creates or updates a field (see the rules above). Returns its id and what the change does to products. */
export async function saveCustomField(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ fieldId: string; created: boolean; usage: FieldUsage }> {
  assertCan(actor, "settings.custom_field.manage");
  const input = CustomFieldInput.parse(raw);
  const withOptions = input.type === "select" || input.type === "multiselect";
  if (withOptions && input.options.length === 0) throw invalid({ options: "required" });
  const values = new Set(input.options.map((option) => option.value));
  if (values.size !== input.options.length) throw invalid({ options: "option_duplicate" });
  const options = withOptions ? input.options.map((option) => ({ value: option.value, label: { ar: option.labelAr, ...(option.labelEn ? { en: option.labelEn } : {}) } })) : null;
  const label: L10n = { ar: input.labelAr, ...(input.labelEn ? { en: input.labelEn } : {}), ...(input.labelCkb ? { ckb: input.labelCkb } : {}) };
  const set = { label, productKind: input.productKind, type: input.type, options, required: input.required, filterable: input.filterable, sort: input.sort };

  // one key, one field: no other field (any kind) holds this key
  const otherWithKey = (exceptId: string | null) => sql`NOT EXISTS (SELECT 1 FROM custom_fields WHERE entity = 'product' AND key = ${input.key} ${exceptId ? sql`AND id <> ${exceptId}` : sql``})`;

  if (!input.fieldId) {
    const id = newId("cfd");
    try {
      await runBatch(db, [
        expectThat(db, otherWithKey(null), { code: "KEY_TAKEN", detail: input.key }),
        db.insert(customFields).values({ id, entity: "product", key: input.key, ...set, isActive: true }),
        auditStatement(db, { actor, action: "settings.custom_field.create", entityType: "custom_field", entityId: id, summary: input.key, after: { key: input.key, ...set }, reason: input.reason, at: now }),
      ]);
    } catch (error) {
      const info = mapDbError(error);
      if (info?.code === "KEY_TAKEN" || info?.kind === "unique") throw new AppError("key_taken", 409, { fields: { key: "key_taken" } });
      throw error;
    }
    return { fieldId: id, created: true, usage: await usageOf(db, input.key, input.productKind) };
  }

  const row = await db.select().from(customFields).where(and(eq(customFields.id, input.fieldId), eq(customFields.entity, "product"))).get();
  if (!row) throw notFound("custom_field");
  if (input.version !== fingerprint(row)) throw new AppError("field_changed", 409);
  if (row.key !== input.key) throw new AppError("key_locked", 409, { fields: { key: "key_locked" } });
  const usage = await usageOf(db, row.key, "*");
  if (row.type !== input.type && usage.withValue > 0) throw new AppError("type_locked", 409, { fields: { type: "type_locked" } });
  const removed = (row.options ?? []).map((option) => option.value).filter((value) => !values.has(value));
  if (removed.length > 0 && withOptions) {
    const used = await db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM products WHERE json_extract(attributes, ${`$.${row.key}`}) IS NOT NULL AND (
        json_extract(attributes, ${`$.${row.key}`}) IN (SELECT value FROM json_each(${JSON.stringify(removed)}))
        OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(attributes, ${`$.${row.key}`}) = 'array' THEN json_extract(attributes, ${`$.${row.key}`}) ELSE '[]' END) j WHERE j.value IN (SELECT value FROM json_each(${JSON.stringify(removed)}))))`);
    if (Number(used[0]?.n ?? 0) > 0) throw new AppError("option_in_use", 409, { fields: { options: "option_in_use" }, detail: removed.join(",") });
  }
  try {
    await runBatch(db, [
      expectThat(db, otherWithKey(row.id), { code: "KEY_TAKEN", detail: row.key }),
      db
        .update(customFields)
        .set(set)
        .where(and(eq(customFields.id, row.id), eq(customFields.type, row.type), eq(customFields.productKind, row.productKind), eq(customFields.required, row.required), eq(customFields.sort, row.sort))),
      expectChanged(db, 1, { code: "FIELD_CHANGED", detail: row.id }),
      auditStatement(db, {
        actor,
        action: "settings.custom_field.update",
        entityType: "custom_field",
        entityId: row.id,
        summary: row.key,
        before: { label: row.label, productKind: row.productKind, type: row.type, options: row.options, required: row.required, filterable: row.filterable, sort: row.sort },
        after: set,
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "KEY_TAKEN") throw new AppError("key_taken", 409, { fields: { key: "key_taken" } });
    if (code === "FIELD_CHANGED") throw new AppError("field_changed", 409);
    throw error;
  }
  return { fieldId: row.id, created: false, usage: await usageOf(db, row.key, input.productKind) };
}

const ActiveInput = z.object({ fieldId: z.string().max(64), active: z.boolean(), reason: z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long") });

/** Switches a field off (values kept, no longer shown or required) or on again. */
export async function setCustomFieldActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "settings.custom_field.manage");
  const input = ActiveInput.parse(raw);
  const row = await db.select().from(customFields).where(and(eq(customFields.id, input.fieldId), eq(customFields.entity, "product"))).get();
  if (!row) throw notFound("custom_field");
  if (row.isActive === input.active) return { changed: false };
  try {
    await runBatch(db, [
      db.update(customFields).set({ isActive: input.active }).where(and(eq(customFields.id, row.id), ne(customFields.isActive, input.active))),
      expectChanged(db, 1, { code: "FIELD_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: input.active ? "settings.custom_field.activate" : "settings.custom_field.deactivate", entityType: "custom_field", entityId: row.id, summary: row.key, before: { isActive: row.isActive }, after: { isActive: input.active }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code === "FIELD_CHANGED") return { changed: false };
    throw error;
  }
  return { changed: true };
}
