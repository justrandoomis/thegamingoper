/**
 * Admin module 13 "devices" — used units, inspection templates, price guides, digital codes and the registry, on a
 * real local D1 with the demo catalogue and the built-in roles.
 *
 *   · a used unit from a paid trade-in to the shop window: checklist (13.02), grade and words (13.09), price through
 *     pricing's rules, photos — private until a person says they show THIS unit, published when listed — and the
 *     database's evidence rule for real (non-demo) units; a listed unit keeps its last real photo; unlist; the
 *     re-inspection of a returned unit reopens the checklist and the wipe
 *   · templates: a save is a new version, the old one switched off, a stale page refused, critical = required
 *     pass/fail; guides: one active per model and scope, audited
 *   · digital codes: encrypted at rest, duplicates never stored twice, never in a list, reveal only with both
 *     permissions and a reason (audited, limited), never for an unpaid order; revoke
 *   · the registry: serials with their source and condition, cost only with cost.read, movements only with
 *     inventory.movement.read; private files only for the staff of their record
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { decryptSecret } from "~/server/crypto.server";
import { auditEvents, digitalCodes, employeeRoles, files, inspectionTemplates, media, products, serials, tradeInPriceGuides, usedUnits, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { codeContext, deliveryClass, digitalOverview, importCodes, listCodes, normalizeCode, revealCode, revokeCode } from "~/server/services/admin/devices/codes.server";
import { devicesFile } from "~/server/services/admin/devices/files.server";
import { listGuides, saveGuide } from "~/server/services/admin/devices/guides.server";
import { getRegistryDetail, listRegistry } from "~/server/services/admin/devices/registry.server";
import { activeTemplates } from "~/server/services/admin/devices/shared.server";
import { getTemplateEditor, listTemplates, saveTemplate } from "~/server/services/admin/devices/templates.server";
import { confirmWipe, makeOffer, payOut, recordAnswer, recordInspection } from "~/server/services/admin/devices/tradeins.server";
import { parseRegistryFilters, type TemplateOption } from "~/server/services/admin/devices/types";
import { assertUnitPhotoSlot, confirmUnitChecks, getUsedUnitDetail, listUnit, recordUnitPhoto, removeUnitPhoto, saveUnitChecklist, saveUnitGrading, setPhotoReal, startReinspection, UNIT_PHOTO_KIND, unlistUnit } from "~/server/services/admin/devices/used.server";
import { decideUsedPrice, setUsedUnitPrice } from "~/server/services/admin/pricing/special.server";
import { createTradeIn, listTradeInDevices, type TradeInDevice } from "~/server/services/tradein.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const DATA_KEY = TEST_VARS.DATA_KEY;
const urls = { file: (id: string) => `/admin/devices/files/${id}` };
/** A tiny valid PNG (1×1). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let t: TestDb;
let make: Fixtures;
let store: BlobStore;
let device: TradeInDevice;
let template: TemplateOption;
let variant: { id: string };
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  store = kvBlobStore(t.kv);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "inventory", "support", "content", "finance"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
  const templates = await activeTemplates(t.db, "ar");
  for (const candidate of await listTradeInDevices(t.db, "ar")) {
    const found = await t.db.select({ id: variants.id }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(products.deviceModelId, candidate.id), eq(variants.trackSerials, true))).get();
    const tpl = templates.find((entry) => entry.kind === candidate.kind);
    if (found && tpl) {
      device = candidate;
      variant = found;
      template = tpl;
      break;
    }
  }
  if (!device) throw new Error("no device the store buys in the demo seed");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}
const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[], id = as("manager").id): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

let n = 0;
const passing = (tpl: TemplateOption) => Object.fromEntries(tpl.items.map((item) => [item.key, item.input === "percent" ? { value: "88" } : item.input === "text" ? { value: "ok" } : { result: "pass" }]));

/** A paid-out trade-in's used unit (live store mode: a real unit, so the database's evidence rule applies). */
async function paidUnit(options: { complete?: boolean } = {}): Promise<{ unitId: string; tradeInId: string }> {
  const made = await createTradeIn(t.db, { customerId: null, ip: null, locale: "ar", storeMode: "live" }, { idempotencyKey: randomToken(), device: device.slug, answers: { power: "works", body: "like_new", ...(device.hasScreen ? { screen: "perfect" as const } : {}), included: [...device.accessories], account: "yes" }, phone: `0773${String(1_000_000 + ++n).slice(-7)}`, ownershipConfirmed: true }, NOW);
  await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: `UNIT-SN-${n}`, grade: "A", answers: passing(template), included: [...device.accessories], ownershipOk: true, accountLockOk: true }, NOW + MIN);
  await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 200_000 }, NOW + 2 * MIN);
  await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
  await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
  const paid = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
  if (options.complete === false) await t.db.update(usedUnits).set({ checklist: { templateId: template.id, completedAt: null, completedBy: null, items: [] }, status: "intake" }).where(eq(usedUnits.id, paid.usedUnitId));
  return { unitId: paid.usedUnitId, tradeInId: made.tradeInId };
}

async function photo(unitId: string, actor = as("manager")): Promise<{ mediaId: string; fileId: string }> {
  const unit = await assertUnitPhotoSlot(t.db, actor, unitId);
  const { file } = await saveImageUpload(t.db, store, PNG, { visibility: "private", kind: UNIT_PHOTO_KIND, ownerType: "used_unit", ownerId: unitId, createdBy: actor, now: NOW });
  const { mediaId } = await recordUnitPhoto(t.db, actor, unit, file.id, NOW, "الواجهة الأمامية");
  return { mediaId, fileId: file.id };
}

async function priced(unitId: string, price = 350_000) {
  const result = await setUsedUnitPrice(t.db, as("manager"), { usedUnitId: unitId, price, expectedPriceIqd: 0, reason: "سعر أول للجهاز" }, NOW + 6 * MIN);
  if (result.status === "pending" && result.requestId) await decideUsedPrice(t.db, as("manager2"), { approvalId: result.requestId, decision: "approve", note: "مناسب" }, NOW + 7 * MIN);
}

describe("used units: from intake to the shop window", () => {
  test("the evidence a real unit needs before it is listed, and what listing publishes", async () => {
    const { unitId } = await paidUnit();
    let unit = await getUsedUnitDetail(t.db, as("manager"), unitId, "ar", urls);
    expect(unit.status).toBe("ready");
    expect(unit.listBlockers).toEqual(expect.arrayContaining(["price_missing", "photo_missing", "notes_missing"]));
    expect(await failureOf(listUnit(t.db, store, as("manager"), { usedUnitId: unitId }, NOW + 8 * MIN))).toMatchObject({ code: "not_listable" });

    await priced(unitId);
    await saveUnitGrading(t.db, as("manager"), { usedUnitId: unitId, grade: "A", cosmeticNotes: { ar: "خدوش خفيفة جداً على الظهر.", en: "Very light scratches on the back." }, defects: [{ area: "back", severity: "minor", note: { ar: "خدش خفيف" } }], included: [{ key: "controller" }, { key: "power_cable" }], warrantyDays: "٣٠" }, NOW + 8 * MIN, () => undefined);
    const { mediaId, fileId } = await photo(unitId);
    unit = await getUsedUnitDetail(t.db, as("manager"), unitId, "ar", urls);
    expect(unit.photos.find((entry) => entry.mediaId === mediaId)).toMatchObject({ real: false, published: false, url: urls.file(fileId) });
    expect(unit.listBlockers).toEqual(["photo_missing"]);
    expect(unit.warrantyDays).toBe(30);

    // a person says the photo shows THIS unit; listing publishes it
    expect(await failureOf(setPhotoReal(t.db, store, as("support"), { usedUnitId: unitId, mediaId, real: true }, NOW))).toMatchObject({ code: "forbidden" });
    await setPhotoReal(t.db, store, custom(["devices.used.grade"]), { usedUnitId: unitId, mediaId, real: true }, NOW + 9 * MIN);
    expect((await t.db.select().from(files).where(eq(files.id, fileId)).get())?.visibility).toBe("private");
    expect(await failureOf(listUnit(t.db, store, as("inventory"), { usedUnitId: unitId }, NOW + 10 * MIN))).toMatchObject({ code: "forbidden" });
    await listUnit(t.db, store, as("manager"), { usedUnitId: unitId }, NOW + 10 * MIN);
    const row = await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get();
    expect(row).toMatchObject({ status: "listed", listedAt: NOW + 10 * MIN });
    expect((await t.db.select().from(files).where(eq(files.id, fileId)).get())?.visibility).toBe("public");
    expect((await t.db.select().from(serials).where(eq(serials.id, row?.serialId as string)).get())?.status).toBe("in_stock");
    expect(await listUnit(t.db, store, as("manager"), { usedUnitId: unitId }, NOW + 11 * MIN)).toMatchObject({ replayed: true });

    // a listed unit keeps its last real photo, and is not edited while on sale
    expect(await failureOf(removeUnitPhoto(t.db, store, as("manager"), { usedUnitId: unitId, mediaId }, NOW + 12 * MIN))).toMatchObject({ code: "last_real_photo" });
    expect(await failureOf(setPhotoReal(t.db, store, as("manager"), { usedUnitId: unitId, mediaId, real: false }, NOW + 12 * MIN))).toMatchObject({ code: "last_real_photo" });
    expect(await failureOf(saveUnitGrading(t.db, as("manager"), { usedUnitId: unitId, grade: "B", cosmeticNotes: { ar: "تغيير بعد العرض" }, warrantyDays: 0 }, NOW + 12 * MIN, () => undefined))).toMatchObject({ code: "unit_not_editable" });
    // the database's own rule: a real unit cannot lose its evidence while listed
    await expect(t.db.update(usedUnits).set({ dataWipedAt: null }).where(eq(usedUnits.id, unitId))).rejects.toThrow();

    expect(await failureOf(unlistUnit(t.db, as("manager"), { usedUnitId: unitId, reason: "x" }, NOW + 13 * MIN))).toMatchObject({ code: "invalid" });
    await unlistUnit(t.db, as("manager"), { usedUnitId: unitId, reason: "خدش جديد يحتاج فحصاً" }, NOW + 13 * MIN);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("ready");
    const actions = (await t.db.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.entityType, "used_unit"), eq(auditEvents.entityId, unitId)))).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["devices.used.intake", "devices.used.grade", "devices.used.photo", "devices.used.photo_real", "devices.used.list", "devices.used.unlist"]));
  });

  test("the checklist moves the status; a critical failure keeps the unit out of the shop", async () => {
    const { unitId } = await paidUnit({ complete: false });
    expect((await getUsedUnitDetail(t.db, as("inventory"), unitId, "ar", urls)).status).toBe("intake");
    const answers = passing(template);
    const critical = template.items.find((item) => item.critical);
    if (!critical) throw new Error("the template has no critical item");
    await saveUnitChecklist(t.db, as("inventory"), { usedUnitId: unitId, templateId: template.id, answers: { ...answers, [critical.key]: { result: "fail" } } }, NOW + 6 * MIN);
    let unit = await getUsedUnitDetail(t.db, as("inventory"), unitId, "ar", urls);
    expect(unit.status).toBe("testing");
    expect(unit.checklist.criticalFailed).toEqual([critical.key]);
    expect(unit.listBlockers).toContain("critical_failed");
    await saveUnitChecklist(t.db, as("inventory"), { usedUnitId: unitId, templateId: template.id, answers }, NOW + 7 * MIN);
    unit = await getUsedUnitDetail(t.db, as("inventory"), unitId, "ar", urls);
    expect(unit.status).toBe("ready");
    // a template of another kind is refused
    const other = (await activeTemplates(t.db, "ar")).find((entry) => entry.kind !== template.kind) as TemplateOption;
    expect(await failureOf(saveUnitChecklist(t.db, as("inventory"), { usedUnitId: unitId, templateId: other.id, answers: passing(other) }, NOW + 8 * MIN))).toMatchObject({ code: "invalid", fields: { templateId: "template_invalid" } });
    // inventory sees no serial-free cost: never the acquisition cost
    expect("acquisitionCostIqd" in unit).toBe(false);
    expect(unit.serial).not.toBeNull();
    // support (no devices.used.* nor registry) cannot open units
    expect(await failureOf(getUsedUnitDetail(t.db, as("support"), unitId, "ar", urls))).toMatchObject({ code: "forbidden" });
  });

  test("a returned unit is inspected again before it is sold again: checklist reopened, wipe confirmed again", async () => {
    const { unitId } = await paidUnit();
    await t.db.update(usedUnits).set({ status: "returned" }).where(eq(usedUnits.id, unitId));
    expect(await failureOf(saveUnitGrading(t.db, as("manager"), { usedUnitId: unitId, grade: "B", cosmeticNotes: { ar: "رجع من العميل" }, warrantyDays: 7 }, NOW + 6 * MIN, () => undefined))).toMatchObject({ code: "unit_returned_reinspect" });
    await startReinspection(t.db, as("inventory"), { usedUnitId: unitId, reason: "رجع عبر طلب إرجاع" }, NOW + 6 * MIN);
    let row = await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get();
    expect(row).toMatchObject({ status: "testing", dataWipedAt: null });
    expect(row?.checklist?.completedAt).toBeNull();
    await saveUnitChecklist(t.db, as("inventory"), { usedUnitId: unitId, templateId: template.id, answers: passing(template) }, NOW + 7 * MIN);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("testing");
    expect(await failureOf(confirmUnitChecks(t.db, as("inventory"), { usedUnitId: unitId, wipe: true }, NOW + 8 * MIN))).toMatchObject({ code: "forbidden" });
    await confirmUnitChecks(t.db, as("manager"), { usedUnitId: unitId, wipe: true, note: "أعيد ضبط المصنع" }, NOW + 8 * MIN);
    row = await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get();
    expect(row).toMatchObject({ status: "ready", dataWipedAt: NOW + 8 * MIN, dataWipedBy: as("manager").id });
    expect(await confirmUnitChecks(t.db, as("manager"), { usedUnitId: unitId, wipe: true }, NOW + 9 * MIN)).toMatchObject({ replayed: true });
  });

  test("private files: a unit's photo for unit staff, a trade-in's for trade-in staff, nothing else", async () => {
    const { unitId, tradeInId } = await paidUnit();
    const { fileId } = await photo(unitId);
    expect(await devicesFile(t.db, as("inventory"), fileId)).toEqual({ id: fileId });
    expect(await devicesFile(t.db, as("support"), fileId)).toBeNull();
    expect(await devicesFile(t.db, as("content"), fileId)).toBeNull();
    const { file } = await saveImageUpload(t.db, store, PNG, { visibility: "private", kind: "trade_in_inspection", ownerType: "trade_in", ownerId: tradeInId, createdBy: as("manager"), now: NOW });
    expect(await devicesFile(t.db, as("support"), file.id)).toEqual({ id: file.id });
    expect(await devicesFile(t.db, as("inventory"), file.id)).toBeNull();
    // another module's private file is never served here
    const { file: proof } = await saveImageUpload(t.db, store, PNG, { visibility: "private", kind: "payment_proof", ownerType: "order", ownerId: "ord_x", now: NOW });
    expect(await devicesFile(t.db, as("owner"), proof.id)).toBeNull();
    expect(await devicesFile(t.db, as("owner"), "fil_nope")).toBeNull();
  });
});

describe("inspection templates and price guides", () => {
  test("a save is a new version; the old one is switched off and keeps its words; a stale page is refused", async () => {
    const before = await getTemplateEditor(t.db, as("manager"), "controller", "ar");
    const current = before.current;
    if (!current) throw new Error("no controller template");
    const items = current.items.map((item) => ({ key: item.key, label: { ar: item.label.ar, en: item.label.en ?? item.label.ar, ckb: "" }, hint: { ar: "", en: "", ckb: "" }, input: item.input, required: item.required, critical: item.critical === true }));
    expect(await failureOf(saveTemplate(t.db, as("inventory"), { kind: "controller", expectedVersion: current.version, name: current.name, items, reason: "إضافة بند" }, NOW))).toMatchObject({ code: "forbidden" });
    const bad = await failureOf(saveTemplate(t.db, as("manager"), { kind: "controller", expectedVersion: current.version, name: current.name, items: [...items, { ...items[0], critical: true, input: "text" }], reason: "إضافة بند" }, NOW));
    expect(bad.fields).toMatchObject({ [`items.${items.length}.key`]: "key_taken", [`items.${items.length}.critical`]: "critical_pass_fail" });
    const saved = await saveTemplate(t.db, as("manager"), { kind: "controller", expectedVersion: current.version, name: current.name, items: [...items, { key: "drift_test", label: { ar: "اختبار الانحراف لدقيقة", en: "One-minute drift test", ckb: "" }, hint: { ar: "", en: "", ckb: "" }, input: "pass_fail", required: true, critical: false }], reason: "إضافة اختبار الانحراف" }, NOW + MIN);
    expect(saved).toMatchObject({ version: current.version + 1, templateId: `itpl_controller_v${current.version + 1}` });
    const rows = await t.db.select().from(inspectionTemplates).where(eq(inspectionTemplates.deviceKind, "controller"));
    expect(rows.filter((row) => row.isActive).map((row) => row.id)).toEqual([saved.templateId]);
    expect(rows.find((row) => row.id === current.id)?.items).toEqual(current.items);
    expect(await failureOf(saveTemplate(t.db, as("manager"), { kind: "controller", expectedVersion: current.version, name: current.name, items, reason: "صفحة قديمة" }, NOW + 2 * MIN))).toMatchObject({ code: "template_changed" });
    expect((await listTemplates(t.db, as("inventory"), "ar")).find((entry) => entry.kind === "controller")?.version).toBe(current.version + 1);
    expect(await failureOf(listTemplates(t.db, as("content"), "ar"))).toMatchObject({ code: "forbidden" });
  });

  test("a guide: one active per model and scope; read by trade-in staff, changed only with its permission; audited", async () => {
    const guides = await listGuides(t.db, as("support"), "ar");
    const guide = guides.find((entry) => entry.modelId === device.id && entry.isActive && !entry.variant);
    if (!guide) throw new Error("no active guide for the device");
    expect(await failureOf(listGuides(t.db, as("inventory"), "ar"))).toMatchObject({ code: "forbidden" });
    const raw = { deviceModelId: device.id, baseIqd: "٤٥٠٬٠٠٠", multipliers: { "A+": "100", A: "90", B: "75", C: "55" }, deductions: [{ key: "controller", amountIqd: "40000" }], isActive: true, reason: "تحديث سعر السوق" };
    expect(await failureOf(saveGuide(t.db, as("support"), raw, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(saveGuide(t.db, as("manager"), { ...raw, deductions: [{ key: "controller", amountIqd: "1" }, { key: "controller", amountIqd: "2" }] }, NOW))).toMatchObject({ code: "invalid", fields: { "deductions.1.key": "key_taken" } });
    const created = await saveGuide(t.db, as("manager"), raw, NOW + MIN);
    const active = await t.db.select().from(tradeInPriceGuides).where(and(eq(tradeInPriceGuides.deviceModelId, device.id), eq(tradeInPriceGuides.isActive, true)));
    expect(active.filter((row) => row.variantId === null).map((row) => row.id)).toEqual([created.guideId]);
    expect(active.find((row) => row.id === created.guideId)).toMatchObject({ baseIqd: 450_000, gradeMultipliers: { "A+": 10_000, A: 9_000, B: 7_500, C: 5_500 }, deductions: { missing_controller: 40_000 } });
    // editing with a stale page is refused; the change is audited with before and after
    expect(await failureOf(saveGuide(t.db, as("manager"), { ...raw, guideId: created.guideId, expectedUpdatedAt: NOW, baseIqd: "460000" }, NOW + 2 * MIN))).toMatchObject({ code: "guide_changed" });
    await saveGuide(t.db, as("manager"), { ...raw, guideId: created.guideId, expectedUpdatedAt: NOW + MIN, baseIqd: "460000" }, NOW + 2 * MIN);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityType, "trade_in_price_guide"), eq(auditEvents.entityId, created.guideId)));
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ reason: "تحديث سعر السوق", before: expect.objectContaining({ baseIqd: 450_000 }), after: expect.objectContaining({ baseIqd: 460_000 }) });
    // a variant of another model is refused
    const otherModelVariant = await t.db.select({ sku: variants.sku }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(products.kind, "game"))).get();
    expect(await failureOf(saveGuide(t.db, as("manager"), { ...raw, variantCode: otherModelVariant?.sku }, NOW + 3 * MIN))).toMatchObject({ code: "invalid", fields: { variantCode: "variant_not_model" } });
  });
});

describe("digital products and codes (13.06, 13.07)", () => {
  let digitalVariantId: string;
  beforeAll(async () => {
    const row = await t.db.select({ id: variants.id }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(products.kind, "digital")).get();
    if (!row) throw new Error("no digital product in the demo seed");
    digitalVariantId = row.id;
  });

  test("delivery classes from the catalogue's own facts", async () => {
    expect(deliveryClass({ kind: "game", mediaFormat: "physical", licenseType: null, platformSlug: "playstation" })).toBe("disc");
    expect(deliveryClass({ kind: "game", mediaFormat: "physical", licenseType: null, platformSlug: "nintendo" })).toBe("cartridge");
    expect(deliveryClass({ kind: "digital", mediaFormat: "digital", licenseType: "subscription" })).toBe("subscription");
    expect(deliveryClass({ kind: "digital", mediaFormat: "digital", licenseType: null })).toBe("code");
    expect(deliveryClass({ kind: "game", mediaFormat: null, licenseType: null })).toBe("unclassified");
    const overview = await digitalOverview(t.db, as("inventory"), "ar");
    expect(overview.classes.length).toBeGreaterThan(0);
    expect(overview.variants.some((row) => row.variantId === digitalVariantId)).toBe(true);
    expect(overview.canManage).toBe(false);
    expect(await failureOf(digitalOverview(t.db, as("content"), "ar"))).toMatchObject({ code: "forbidden" });
  });

  test("codes are stored encrypted, never twice, never in a list; revealing needs both permissions and a reason", async () => {
    const manager = as("manager");
    expect(await failureOf(importCodes(t.db, as("inventory"), DATA_KEY, { variantId: digitalVariantId, codes: "AAAA-BBBB" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(importCodes(t.db, custom(["devices.digital_code.manage"]), DATA_KEY, { variantId: digitalVariantId, codes: "AAAA-BBBB", unitCostIqd: "9000" }, NOW))).toMatchObject({ code: "forbidden" });
    const imported = await importCodes(t.db, manager, DATA_KEY, { variantId: digitalVariantId, codes: "  ABCD-EFGH-1234 \nabcd efgh 1234\nWXYZ-0000-9999\n\n", unitCostIqd: "٩٬٥٠٠" }, NOW);
    expect(imported).toEqual({ added: 2, duplicates: 1 });
    expect(await importCodes(t.db, manager, DATA_KEY, { variantId: digitalVariantId, codes: "WXYZ-0000-9999" }, NOW + MIN)).toEqual({ added: 0, duplicates: 1 });
    const rows = await t.db.select().from(digitalCodes).where(eq(digitalCodes.variantId, digitalVariantId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.codeEnc).not.toMatch(/ABCD|WXYZ/);
      expect(["ABCD-EFGH-1234", "WXYZ-0000-9999"]).toContain(await decryptSecret(row.codeEnc, DATA_KEY, codeContext(row.id)));
      expect(row.costIqd).toBe(9_500);
    }
    // a ciphertext copied into another row does not decrypt
    await expect(decryptSecret(rows[0].codeEnc, DATA_KEY, codeContext(rows[1].id))).rejects.toThrow();
    expect(normalizeCode("ab-cd ٠١")).toBe("ABCD01");

    const list = await listCodes(t.db, manager, digitalVariantId, { status: null, page: 1 }, "ar");
    expect(JSON.stringify(list)).not.toMatch(/ABCD|WXYZ|codeEnc|code_enc/);
    expect(list.rows[0]).toHaveProperty("costIqd", 9_500);
    const blind = await listCodes(t.db, custom(["devices.digital_code.manage"]), digitalVariantId, { status: null, page: 1 }, "ar");
    expect(blind.rows.every((row) => !("costIqd" in row))).toBe(true);
    expect(blind.canReveal).toBe(false);

    expect(await failureOf(revealCode(t.db, custom(["devices.digital_code.manage"]), DATA_KEY, { codeId: rows[0].id, reason: "العميل فقد الرمز" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(revealCode(t.db, custom(["digital_code.reveal"]), DATA_KEY, { codeId: rows[0].id, reason: "العميل فقد الرمز" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: rows[0].id, reason: "" }, NOW))).toMatchObject({ code: "invalid" });
    // never before payment: an unsold code stays sealed (review: it used to be revealable "to check it before sale")
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: rows[0].id, variantId: digitalVariantId, reason: "تحقق قبل البيع" }, NOW + MIN))).toMatchObject({ code: "code_unpaid" });
    // a code delivered on a paid order can be shown again (the buyer lost it)
    const paid = await make.order([{ variantId: digitalVariantId, sku: "DIG" }], { paymentStatus: "paid" });
    await t.db.update(digitalCodes).set({ status: "delivered", orderItemId: paid.itemIds[0], deliveredAt: NOW }).where(eq(digitalCodes.id, rows[0].id));
    const shown = await revealCode(t.db, manager, DATA_KEY, { codeId: rows[0].id, variantId: digitalVariantId, reason: "العميل فقد الرمز بعد الدفع" }, NOW + 2 * MIN);
    expect(["ABCD-EFGH-1234", "WXYZ-0000-9999"]).toContain(shown.code);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "devices.digital_code.reveal"), eq(auditEvents.entityId, rows[0].id))).get();
    expect(audit).toMatchObject({ actorId: manager.id, reason: "العميل فقد الرمز بعد الدفع" });
    expect(JSON.stringify(audit)).not.toContain(shown.code);
    expect((await listCodes(t.db, manager, digitalVariantId, { status: "delivered", page: 1 }, "ar")).rows.find((row) => row.id === rows[0].id)).toMatchObject({ revealable: true, orderPaid: true });
    // another variant's page cannot reach this code
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: rows[0].id, variantId: variant.id, reason: "خطأ" }, NOW))).toMatchObject({ code: "not_found" });

    // never before payment: a code held for an order that is not paid
    const order = await make.order([{ variantId: digitalVariantId, sku: "DIG" }], { paymentStatus: "unpaid" });
    await t.db.update(digitalCodes).set({ status: "reserved", orderItemId: order.itemIds[0] }).where(eq(digitalCodes.id, rows[1].id));
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: rows[1].id, reason: "طلب العميل" }, NOW))).toMatchObject({ code: "code_unpaid" });
    expect(await failureOf(revokeCode(t.db, manager, { codeId: rows[1].id, reason: "رمز معيب" }, NOW))).toMatchObject({ code: "code_not_available" });
    // revoking an unsold code; a revoked code is never revealed
    await importCodes(t.db, manager, DATA_KEY, { variantId: digitalVariantId, codes: "LEAK-0000-7777" }, NOW + 2 * MIN);
    const leaked = (await t.db.select().from(digitalCodes).where(and(eq(digitalCodes.variantId, digitalVariantId), eq(digitalCodes.status, "available")))).find((row) => row.id !== rows[0].id && row.id !== rows[1].id);
    if (!leaked) throw new Error("no third code");
    await revokeCode(t.db, manager, { codeId: leaked.id, reason: "رمز مسرّب" }, NOW + 3 * MIN);
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: leaked.id, reason: "بعد الإلغاء" }, NOW + 4 * MIN))).toMatchObject({ code: "code_not_revealable" });
    expect(await revokeCode(t.db, manager, { codeId: leaked.id, reason: "مرة ثانية" }, NOW + 5 * MIN)).toMatchObject({ replayed: true });
  });

  test("reveals are limited per employee", async () => {
    const actor = await employee("manager");
    await importCodes(t.db, actor, DATA_KEY, { variantId: digitalVariantId, codes: "LIMIT-CODE-0001" }, NOW);
    const row = await t.db.select().from(digitalCodes).where(eq(digitalCodes.createdBy, actor.id)).get();
    // only a code delivered on a paid order can be revealed at all
    const order = await make.order([{ variantId: digitalVariantId, sku: "DIG" }], { paymentStatus: "paid" });
    await t.db.update(digitalCodes).set({ status: "delivered", orderItemId: order.itemIds[0], deliveredAt: NOW }).where(eq(digitalCodes.id, row?.id as string));
    let refused: AppError | null = null;
    for (let i = 0; i < 25 && !refused; i++) {
      try {
        await revealCode(t.db, actor, DATA_KEY, { codeId: row?.id as string, reason: "اختبار الحد" }, NOW + i);
      } catch (error) {
        refused = toAppError(error);
      }
    }
    expect(refused?.code).toBe("rate_limited");
  });
});

describe("the device registry (13.01)", () => {
  test("serials with condition and source; cost only with cost.read; movements only with the movement log's permission", async () => {
    const { unitId } = await paidUnit();
    const unit = await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get();
    const inventory = await listRegistry(t.db, as("inventory"), parseRegistryFilters(new URLSearchParams("condition=used")), "ar");
    expect(inventory.withCost).toBe(false);
    const row = inventory.rows.find((entry) => entry.id === unit?.serialId);
    expect(row).toMatchObject({ condition: "used", grade: "A", source: { kind: "trade_in", tradeInRef: expect.stringMatching(/^TI-/) } });
    expect(inventory.rows.every((entry) => !("costIqd" in entry))).toBe(true);
    const fresh = await listRegistry(t.db, as("manager"), parseRegistryFilters(new URLSearchParams("condition=new")), "ar");
    expect(fresh.rows.length).toBeGreaterThan(0);
    expect(fresh.rows.every((entry) => entry.condition === "new" && "costIqd" in entry)).toBe(true);
    expect(fresh.rows.some((entry) => entry.source.kind === "opening")).toBe(true);
    // search by serial number, case and spaces ignored
    const found = await listRegistry(t.db, as("inventory"), parseRegistryFilters(new URLSearchParams(`q=${encodeURIComponent("unit-sn")}`)), "ar");
    expect(found.rows.length).toBeGreaterThan(0);
    const detail = await getRegistryDetail(t.db, as("inventory"), unit?.serialId as string, "ar");
    expect(detail.usedUnit?.id).toBe(unitId);
    expect(detail.tradeIns).toHaveLength(1);
    expect("movements" in detail).toBe(true); // inventory holds inventory.movement.read
    const noMoves = await getRegistryDetail(t.db, custom(["devices.registry.read"]), unit?.serialId as string, "ar");
    expect("movements" in noMoves).toBe(false);
    expect("costIqd" in noMoves).toBe(false);
    expect(await failureOf(listRegistry(t.db, as("support"), parseRegistryFilters(new URLSearchParams()), "ar"))).toMatchObject({ code: "forbidden" });
  });

  test("a photo slot is checked before anything is stored, with a limit", async () => {
    const { unitId } = await paidUnit();
    expect(await failureOf(assertUnitPhotoSlot(t.db, as("support"), unitId))).toMatchObject({ code: "forbidden" });
    for (let i = 0; i < 12; i++) await t.db.insert(media).values({ id: `med_${randomToken(8)}`, ownerType: "used_unit", ownerId: unitId, kind: "image", isIllustration: true, sort: i, createdAt: NOW });
    expect(await failureOf(assertUnitPhotoSlot(t.db, as("inventory"), unitId))).toMatchObject({ code: "photo_limit" });
  });
});
