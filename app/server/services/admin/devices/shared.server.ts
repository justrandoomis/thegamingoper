/**
 * Server helpers shared by the services of admin module 13 (devices, games & trade-in): who may do what, how a phone
 * may be shown, who is who, where a unit may be put, and the inspection checklists — which template applies to a
 * device, how a filled checklist reads, and how a form's answers become a stored checklist (13.02).
 *
 * Checklists are stored as `UsedChecklist` (schema/used.ts): `templateId` keeps the template version the inspector
 * filled (the original reference, never the editable words), `completedAt` is set only when every REQUIRED item of
 * that template has an answer — the database's listing trigger reads it.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertBranch, can, canAccessBranch, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { inspectionTemplates, inventoryLocations, usedUnits, type ChecklistResult, type InspectionKind, type InspectionTemplateItem, type UsedChecklist } from "~/server/db/schema";
import { forbidden, invalid } from "~/server/errors";
import { PERMISSIONS, type Permission } from "~/server/permissions";
import { employeeNames, phoneFor } from "../orders/shared.server";
import { CHECK_RESULT_LIST, parsePercent, type ChecklistLineView, type ChecklistView, type PhoneView, type TemplateOption } from "./types";

export { employeeNames };

export const DAY_MS = 86_400_000;
export const BAGHDAD_OFFSET_MS = 3 * 3_600_000;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const PAGE_SIZE = 25;

/** Every devices.* permission (the shell's gate lets an employee in with any of them). */
export const DEVICES_PERMISSIONS = PERMISSIONS.filter((key) => key.startsWith("devices.")) as Permission[];

export type DevicesAccess = ReturnType<typeof devicesAccess>;

/** What this employee may see and do in the module (the services check every action again). */
export function devicesAccess(actor: Actor) {
  const tradeRead = canAny(actor, ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"]);
  return {
    any: canAny(actor, DEVICES_PERMISSIONS),
    registry: can(actor, "devices.registry.read"),
    usedRead: canAny(actor, ["devices.registry.read", "devices.used.intake", "devices.used.inspect", "devices.used.grade", "devices.used.list", "devices.ownership.verify"]),
    usedInspect: can(actor, "devices.used.inspect"),
    usedGrade: can(actor, "devices.used.grade"),
    usedList: can(actor, "devices.used.list"),
    verify: can(actor, "devices.ownership.verify"),
    tradeRead,
    tradeInspect: can(actor, "devices.tradein.inspect"),
    tradeOffer: can(actor, "devices.tradein.offer"),
    tradePayout: can(actor, "devices.tradein.payout"),
    guides: can(actor, "devices.price_guide.manage"),
    guidesRead: can(actor, "devices.price_guide.manage") || tradeRead,
    templates: can(actor, "devices.inspection_template.manage"),
    codes: can(actor, "devices.digital_code.manage"),
    reveal: can(actor, "devices.digital_code.manage") && can(actor, "digital_code.reveal"),
    cost: can(actor, "cost.read"),
    profit: can(actor, "cost.read") && can(actor, "profit.read"),
    phone: can(actor, "customer.phone.read_full"),
    pricing: can(actor, "pricing.used.update"),
  };
}

/** Throws 403 unless the actor holds at least one of the permissions. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export function phoneView(actor: Actor, e164: string | null | undefined): PhoneView | null {
  return phoneFor(actor, e164);
}

export function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  if (value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** The L10n of a name column read through raw SQL (a JSON string) or Drizzle (an object). */
export const l10nOf = (value: unknown, locale: Locale): string => pick(parseJson<L10n>(value), locale);

/** "Product — variant title" for staff (the variant title alone when it already names the product). */
export function variantLabel(productName: unknown, variantTitle: unknown, locale: Locale): string {
  const product = l10nOf(productName, locale);
  const title = l10nOf(variantTitle, locale);
  if (!title) return product;
  if (!product || title.toLowerCase().includes(product.toLowerCase())) return title;
  return `${product} — ${title}`;
}

/** The Baghdad calendar day of an instant: "2026-11-11". */
export const baghdadDay = (at: number): string => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

/** Epoch ms of a Baghdad local date and time ("2026-11-12", "14:30"), or null when either is not a real value. */
export function baghdadInstant(day: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const parsed = Date.parse(`${day}T${time}:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 16) !== `${day}T${time}`) return null;
  return parsed - BAGHDAD_OFFSET_MS;
}

// ───────────────────────────────────────────────────────────────── locations

export type LocationOption = { id: string; code: string; name: string };

/** Active sellable locations this employee may put a unit at (an employee limited to a branch: that branch only). */
export async function unitLocations(db: Db, actor: Actor): Promise<LocationOption[]> {
  const rows = await db
    .select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name, branchId: inventoryLocations.branchId })
    .from(inventoryLocations)
    .where(and(eq(inventoryLocations.isActive, true), eq(inventoryLocations.isSellable, true)))
    // The shop floor first (a trade-in is received at the counter), then warehouses, then shelves and bins.
    .orderBy(sql`case ${inventoryLocations.kind} when 'store' then 0 when 'warehouse' then 1 else 2 end`, asc(inventoryLocations.sort), asc(inventoryLocations.code))
    .limit(300);
  return rows.filter((row) => canAccessBranch(actor, row.branchId)).map(({ id, code, name }) => ({ id, code, name }));
}

/** A location a unit may be put at: active, sellable, in the employee's branch (403 otherwise; unknown → field error). */
export async function assertUnitLocation(db: Db, actor: Actor, locationId: string): Promise<LocationOption> {
  const row = ID.test(locationId)
    ? await db
        .select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name, branchId: inventoryLocations.branchId, isActive: inventoryLocations.isActive, isSellable: inventoryLocations.isSellable })
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, locationId))
        .get()
    : undefined;
  if (!row || !row.isActive || !row.isSellable) throw invalid({ locationId: "location_invalid" });
  assertBranch(actor, row.branchId);
  return { id: row.id, code: row.code, name: row.name };
}

/**
 * The used units an employee limited to a branch works on, as a WHERE fragment: units at that branch's locations and
 * units without a location (undefined for everyone else). Lists AND their queue counts use it, so a count never names
 * units its list does not show.
 */
export function unitBranchWhere(actor: Actor): SQL | undefined {
  if (actor.kind !== "employee" || actor.branchId == null) return undefined;
  return sql`(${usedUnits.locationId} IS NULL OR ${usedUnits.locationId} IN (SELECT id FROM inventory_locations WHERE branch_id = ${actor.branchId}))`;
}

/** An employee limited to a branch works on units at that branch's locations (and on units without a location). */
export async function assertUnitBranch(db: Db, actor: Actor, locationId: string | null): Promise<void> {
  if (!locationId || actor.kind !== "employee" || actor.branchId == null) return;
  const row = await db.select({ branchId: inventoryLocations.branchId }).from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).get();
  assertBranch(actor, row?.branchId ?? null);
}

// ───────────────────────────────────────────────────────────────── inspection templates and checklists

/** Which checklist a device takes: a game's, a controller's or headset's, else its device model's kind (console by default). */
export function inspectionKindFor(input: { productKind?: string | null; deviceKind?: string | null }): InspectionKind {
  if (input.productKind === "game") return "game";
  if (input.productKind === "controller") return "controller";
  if (input.productKind === "headset") return "headset";
  const kind = input.deviceKind;
  if (kind === "console" || kind === "handheld_pc" || kind === "controller" || kind === "headset" || kind === "other") return kind;
  return "console";
}

/** The active template of each kind (its newest version), for the inspection forms. */
export async function activeTemplates(db: Db, locale: Locale): Promise<TemplateOption[]> {
  const rows = await db
    .select({ id: inspectionTemplates.id, kind: inspectionTemplates.deviceKind, name: inspectionTemplates.name, version: inspectionTemplates.version, items: inspectionTemplates.items })
    .from(inspectionTemplates)
    .where(eq(inspectionTemplates.isActive, true))
    .orderBy(asc(inspectionTemplates.deviceKind), desc(inspectionTemplates.version));
  const seen = new Set<string>();
  const out: TemplateOption[] = [];
  for (const row of rows) {
    if (seen.has(row.kind)) continue;
    seen.add(row.kind);
    out.push({ id: row.id, kind: row.kind, name: pick(row.name, locale) || row.id, version: row.version, items: row.items ?? [] });
  }
  return out;
}

/** A template by id, any version (a filled checklist keeps the version it was filled with). */
export async function templateById(db: Db, id: string | null | undefined): Promise<{ id: string; kind: InspectionKind; name: L10n | null; version: number; items: InspectionTemplateItem[]; isActive: boolean } | null> {
  if (!id || !ID.test(id)) return null;
  const row = await db
    .select({ id: inspectionTemplates.id, kind: inspectionTemplates.deviceKind, name: inspectionTemplates.name, version: inspectionTemplates.version, items: inspectionTemplates.items, isActive: inspectionTemplates.isActive })
    .from(inspectionTemplates)
    .where(eq(inspectionTemplates.id, id))
    .get();
  return row ? { ...row, items: row.items ?? [] } : null;
}

/** Templates by id, for history and list screens. */
export async function templatesByIds(db: Db, ids: readonly string[]): Promise<Map<string, { kind: InspectionKind; name: L10n | null; items: InspectionTemplateItem[] }>> {
  const wanted = [...new Set(ids.filter((id) => ID.test(id)))];
  const out = new Map<string, { kind: InspectionKind; name: L10n | null; items: InspectionTemplateItem[] }>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: inspectionTemplates.id, kind: inspectionTemplates.deviceKind, name: inspectionTemplates.name, items: inspectionTemplates.items }).from(inspectionTemplates).where(inArray(inspectionTemplates.id, wanted));
  for (const row of rows) out.set(row.id, { kind: row.kind, name: row.name, items: row.items ?? [] });
  return out;
}

const answered = (item: InspectionTemplateItem, entry: UsedChecklist["items"][number] | undefined): boolean => {
  if (!entry) return false;
  if (item.input === "text") return typeof entry.value === "string" && entry.value.trim() !== "";
  if (item.input === "percent") return entry.result === "na" || (typeof entry.value === "number" && entry.value >= 0 && entry.value <= 100);
  return entry.result === "pass" || entry.result === "fail" || entry.result === "na";
};

/** The checklist as a screen shows it: the template's words in the employee's language, answers, what is missing. */
export function checklistView(template: { id: string; kind: InspectionKind; name: L10n | string | null; items: InspectionTemplateItem[] } | null, checklist: UsedChecklist | null, locale: Locale, kind: InspectionKind): ChecklistView {
  const entries = new Map((checklist?.items ?? []).map((entry) => [entry.key, entry]));
  const items = template?.items ?? [];
  const lines: ChecklistLineView[] = items.map((item) => {
    const entry = entries.get(item.key);
    return {
      key: item.key,
      label: pick(item.label, locale) || item.key,
      hint: item.hint ? pick(item.hint, locale) || null : null,
      input: item.input,
      required: item.required,
      critical: item.critical === true,
      result: entry?.result ?? null,
      value: entry?.value ?? null,
      note: entry?.note ?? null,
    };
  });
  // Answers to items the template no longer has (an older checklist read against its own version is the normal case).
  for (const entry of checklist?.items ?? []) {
    if (items.some((item) => item.key === entry.key)) continue;
    lines.push({ key: entry.key, label: entry.key, hint: null, input: typeof entry.value === "string" ? "text" : "pass_fail", required: false, critical: false, result: entry.result ?? null, value: entry.value ?? null, note: entry.note ?? null });
  }
  const missing = items.filter((item) => item.required && !answered(item, entries.get(item.key))).map((item) => item.key);
  const criticalFailed = items.filter((item) => item.critical && entries.get(item.key)?.result !== "pass" && answered(item, entries.get(item.key))).map((item) => item.key);
  return {
    templateId: template?.id ?? checklist?.templateId ?? null,
    templateName: template ? (typeof template.name === "string" ? template.name : pick(template.name, locale)) || template.id : null,
    kind,
    lines,
    completedAt: checklist?.completedAt ?? null,
    completedBy: checklist?.completedBy ?? null,
    missing,
    criticalFailed,
    passed: lines.filter((line) => line.result === "pass").length,
    failed: lines.filter((line) => line.result === "fail").length,
  };
}

/** What a checklist form sends: per item key, the result (pass | fail | na), a value (percent or text) and a note. */
export type ChecklistAnswers = Record<string, { result?: string | null; value?: string | null; note?: string | null }>;

/**
 * A form's answers checked against the template: results only from the allowed list, percents whole 0–100 (Arabic-Indic
 * digits accepted), texts cleaned and bounded. `completedAt` = now when every required item is answered (else null).
 * Field errors use the item's key: `r.<key>` (result) and `v.<key>` (value).
 */
export function buildChecklist(template: { id: string; items: InspectionTemplateItem[] }, answers: ChecklistAnswers, actorId: string | null, now: number, clean: (value: string) => string): { checklist: UsedChecklist; complete: boolean; batteryPct: number | null } {
  const fields: Record<string, string> = {};
  const items: UsedChecklist["items"] = [];
  let batteryPct: number | null = null;
  for (const item of template.items) {
    const raw = answers[item.key] ?? {};
    const note = raw.note ? clean(String(raw.note)).trim().slice(0, 300) : "";
    const entry: UsedChecklist["items"][number] = { key: item.key, result: null };
    if (item.input === "text") {
      const value = raw.value ? clean(String(raw.value)).trim() : "";
      if (value.length > 300) fields[`v.${item.key}`] = "too_long";
      if (value) entry.value = value.slice(0, 300);
    } else if (item.input === "percent") {
      const result = raw.result ? String(raw.result) : "";
      const value = parsePercent(raw.value ?? null);
      if (result === "na") entry.result = "na";
      else if (value !== undefined) {
        if (Number.isNaN(value)) fields[`v.${item.key}`] = "percent_invalid";
        else {
          entry.value = value;
          entry.result = "pass";
          if (item.key === "battery") batteryPct = value;
        }
      }
    } else {
      const result = raw.result ? String(raw.result) : "";
      if (result) {
        if (!(CHECK_RESULT_LIST as readonly string[]).includes(result)) fields[`r.${item.key}`] = "invalid";
        else entry.result = result as ChecklistResult;
      }
    }
    if (note) entry.note = note;
    if (entry.result !== null || entry.value !== undefined || entry.note) items.push(entry);
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const byKey = new Map(items.map((entry) => [entry.key, entry]));
  const complete = template.items.every((item) => !item.required || answered(item, byKey.get(item.key)));
  return { checklist: { templateId: template.id, completedAt: complete ? now : null, completedBy: complete ? actorId : null, items }, complete, batteryPct };
}

/** Reads `r.<key>`, `v.<key>` and `n.<key>` fields of a checklist form. */
export function checklistAnswersFrom(form: FormData): ChecklistAnswers {
  const out: ChecklistAnswers = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const match = /^([rvn])\.([a-z0-9_]{1,40})$/.exec(name);
    if (!match) continue;
    const entry = (out[match[2]] ??= {});
    if (match[1] === "r") entry.result = value;
    else if (match[1] === "v") entry.value = value;
    else entry.note = value;
  }
  return out;
}

/** Accessory keys a complete unit comes with, from a guide's deduction keys ("missing_controller" → "controller"). */
export function accessoriesOf(deductions: Record<string, number> | null | undefined): string[] {
  return Object.keys(deductions ?? {})
    .filter((key) => key.startsWith("missing_") && key.length > "missing_".length)
    .map((key) => key.slice("missing_".length));
}

/** A SQL fragment for a LIKE search with the user's text escaped. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export const sqlTrue = sql`1 = 1`;
