/**
 * Admin module 13 — inspection checklists (13.02): the templates a technician fills for a console, a handheld PC, a
 * controller, a headset, other hardware or a used game (screen, battery, ports, buttons, temperature; for games the
 * disc or cartridge, the case and cover, region and platform — 13.05).
 *
 *   const list = await listTemplates(db, actor, locale);
 *   const editor = await getTemplateEditor(db, actor, "console", locale);
 *   await saveTemplate(db, actor, { kind, expectedVersion, name, items, reason }, now);   // a NEW version
 *
 * A change never edits a template in place: it saves version n + 1 and switches the older versions off, so every
 * filled checklist keeps pointing at the exact words it was filled with (`checklist.templateId`, blueprint entityRule).
 * Editing needs devices.inspection_template.manage; reading, any devices permission. A critical item must be a
 * required pass/fail question (it decides whether a unit may be listed).
 *
 * Errors: forbidden, invalid (fields: items, items.<n>.key = key_invalid | key_taken, items.<n>.label = required,
 * items.<n>.critical = critical_pass_fail, name = required, reason = reason_short), template_changed (409).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { inspectionTemplates, type InspectionKind, type InspectionTemplateItem } from "~/server/db/schema";
import { expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, zodFieldErrors } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { DEVICES_PERMISSIONS, assertAny, employeeNames } from "./shared.server";
import { INPUT_LIST, INSPECTION_KIND_LIST, MAX_TEMPLATE_ITEMS, type TemplateEditor, type TemplateSummary } from "./types";

export const TEMPLATE_ERROR_KEYS = ["template_changed", "key_invalid", "key_taken", "critical_pass_fail"] as const;

export async function listTemplates(db: Db, actor: Actor, locale: Locale): Promise<TemplateSummary[]> {
  assertAny(actor, DEVICES_PERMISSIONS);
  const rows = await db
    .select({ id: inspectionTemplates.id, kind: inspectionTemplates.deviceKind, name: inspectionTemplates.name, version: inspectionTemplates.version, items: inspectionTemplates.items, updatedAt: inspectionTemplates.updatedAt, updatedBy: inspectionTemplates.updatedBy })
    .from(inspectionTemplates)
    .where(eq(inspectionTemplates.isActive, true))
    .orderBy(asc(inspectionTemplates.deviceKind), desc(inspectionTemplates.version));
  const names = await employeeNames(db, rows.map((row) => row.updatedBy));
  const seen = new Set<string>();
  const out: TemplateSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.kind)) continue;
    seen.add(row.kind);
    const items = row.items ?? [];
    out.push({ id: row.id, kind: row.kind, name: pick(row.name, locale) || row.id, version: row.version, items: items.length, critical: items.filter((item) => item.critical).length, updatedAt: row.updatedAt, updatedBy: row.updatedBy ? (names.get(row.updatedBy) ?? null) : null });
  }
  return out;
}

export async function getTemplateEditor(db: Db, actor: Actor, kind: InspectionKind, locale: Locale): Promise<TemplateEditor> {
  assertAny(actor, DEVICES_PERMISSIONS);
  const rows = await db
    .select({ id: inspectionTemplates.id, version: inspectionTemplates.version, isActive: inspectionTemplates.isActive, updatedAt: inspectionTemplates.updatedAt, name: inspectionTemplates.name, items: inspectionTemplates.items })
    .from(inspectionTemplates)
    .where(eq(inspectionTemplates.deviceKind, kind))
    .orderBy(desc(inspectionTemplates.version));
  const current = rows.find((row) => row.isActive) ?? null;
  return {
    kind,
    current: current
      ? {
          id: current.id,
          kind,
          name: { ar: current.name?.ar ?? "", en: current.name?.en ?? "", ckb: current.name?.ckb ?? "" },
          version: current.version,
          items: current.items ?? [],
          updatedAt: current.updatedAt,
        }
      : null,
    versions: rows.map((row) => ({ id: row.id, version: row.version, isActive: row.isActive, updatedAt: row.updatedAt })),
  };
  void locale;
}

const words = (max: number, required: boolean) =>
  z.object({
    ar: required ? z.string().overwrite(cleanLine).trim().min(2, "required").max(max, "too_long") : z.string().overwrite(cleanLine).trim().max(max, "too_long").default(""),
    en: required ? z.string().overwrite(cleanLine).trim().min(2, "required").max(max, "too_long") : z.string().overwrite(cleanLine).trim().max(max, "too_long").default(""),
    ckb: z.string().overwrite(cleanLine).trim().max(max, "too_long").default(""),
  });

export const TemplateInput = z.object({
  kind: z.enum(INSPECTION_KIND_LIST, { error: "invalid" }),
  /** The version the form was opened on (null when the kind had no template): a newer save is never overwritten. */
  expectedVersion: z.number().int().min(0).nullable(),
  name: words(80, true),
  items: z
    .array(
      z.object({
        key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/, "key_invalid"),
        label: words(160, true),
        hint: words(200, false),
        input: z.enum(INPUT_LIST, { error: "invalid" }),
        required: z.boolean(),
        critical: z.boolean(),
      }),
    )
    .min(1, "required")
    .max(MAX_TEMPLATE_ITEMS, "too_long"),
  reason: z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "reason_short").max(300, "too_long"),
});

const l10n = (value: { ar: string; en: string; ckb: string }) => ({ ar: value.ar, ...(value.en ? { en: value.en } : {}), ...(value.ckb ? { ckb: value.ckb } : {}) });

/** Saves the next version of a kind's checklist and switches the older versions off (devices.inspection_template.manage). */
export async function saveTemplate(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ templateId: string; version: number }> {
  assertCan(actor, "devices.inspection_template.manage");
  const parsed = TemplateInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "template.save");
  const input = parsed.data;
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    if (seen.has(item.key)) fields[`items.${index}.key`] = "key_taken";
    seen.add(item.key);
    if (item.critical && (item.input !== "pass_fail" || !item.required)) fields[`items.${index}.critical`] = "critical_pass_fail";
  });
  if (Object.keys(fields).length > 0) throw invalid(fields, "template.save");
  const rows = await db.select({ id: inspectionTemplates.id, version: inspectionTemplates.version, isActive: inspectionTemplates.isActive, items: inspectionTemplates.items }).from(inspectionTemplates).where(eq(inspectionTemplates.deviceKind, input.kind));
  const active = rows.filter((row) => row.isActive).sort((a, b) => b.version - a.version)[0] ?? null;
  if ((active?.version ?? null) !== input.expectedVersion) throw new AppError("template_changed", 409);
  const version = Math.max(0, ...rows.map((row) => row.version)) + 1;
  const templateId = `itpl_${input.kind}_v${version}`;
  const items: InspectionTemplateItem[] = input.items.map((item) => ({
    key: item.key,
    label: l10n(item.label),
    ...(item.hint.ar || item.hint.en ? { hint: l10n({ ...item.hint, ar: item.hint.ar || item.hint.en }) } : {}),
    input: item.input,
    required: item.required,
    ...(item.critical ? { critical: true } : {}),
  }));
  try {
    await runBatch(db, [
      expectThat(db, sql`coalesce((SELECT max(version) FROM inspection_templates WHERE device_kind = ${input.kind} AND is_active = 1), -1) = ${input.expectedVersion ?? -1}`, { code: "TEMPLATE_CHANGED", detail: input.kind }),
      db.update(inspectionTemplates).set({ isActive: false }).where(and(eq(inspectionTemplates.deviceKind, input.kind), eq(inspectionTemplates.isActive, true))),
      db.insert(inspectionTemplates).values({ id: templateId, deviceKind: input.kind, items, name: l10n(input.name), version, isActive: true, updatedBy: actor.kind === "employee" ? actor.id : null, updatedAt: now }),
      auditStatement(db, {
        actor,
        action: "devices.template.save",
        entityType: "inspection_template",
        entityId: templateId,
        summary: `${input.kind} v${version}`,
        before: active ? { id: active.id, version: active.version, items: (active.items ?? []).map((item) => item.key) } : null,
        after: { id: templateId, version, items: items.map((item) => item.key), critical: items.filter((item) => item.critical).map((item) => item.key) },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error) || String((error as Error)?.message ?? "").includes("TEMPLATE_CHANGED")) throw new AppError("template_changed", 409, { cause: error });
    throw error;
  }
  return { templateId, version };
}
