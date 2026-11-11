/**
 * Admin module 13 "devices" — the adversarial review. Each test is an attack that worked against the module as it was
 * built (it fails on that code) and is refused now. Real local D1 with the demo catalogue and the built-in roles;
 * fixtures are chosen by their properties, never by slug. Races are run deterministically: the competing request
 * completes just before the request under test reaches its FIRST write batch.
 *
 *   1. money: a store-credit payout racing a cash payout, a cancel or a serial that entered stock pays once or not at
 *      all — never credit AND cash, never credit for a cancelled trade-in or for a device the store did not take
 *   2. four eyes: whoever last set the price guide cannot also make an offer on it and pay it out alone
 *   3. 13.07: a digital code is never revealed before it is paid for (an unsold code included)
 *   4. 13.02: a new checklist is filled on the CURRENT version of its template (a switched-off version is refused)
 *   5. the used unit a payout creates is "ready" only without a failed critical item
 *   6. 13.09 photos: a photo taken off a unit is private again; published inspection photos still show on the
 *      trade-in page; a photo published for a "real" mark that then failed goes back to private
 *   7. 13.08: confirming ownership and the account lock needs devices.ownership.verify, not only the inspector's right
 *   8. the customer's in-person answer is double-submit safe; the units queue counts what a branch-limited employee sees
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { templateItemsFrom } from "~/routes/admin/devices/templates.server";
import { tradeInAction } from "~/routes/admin/devices/trade-in.server";
import { type EmployeeActor } from "~/server/actor";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { branches, digitalCodes, employeeRoles, files, inventoryLocations, journalEntries, media, products, serials, tradeIns, usedUnits, variants, walletLedger } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { decryptSecret } from "~/server/crypto.server";
import { codeContext, importCodes, revealCode } from "~/server/services/admin/devices/codes.server";
import { listGuides, saveGuide } from "~/server/services/admin/devices/guides.server";
import { activeTemplates } from "~/server/services/admin/devices/shared.server";
import { getTemplateEditor, saveTemplate } from "~/server/services/admin/devices/templates.server";
import {
  cancelTradeIn,
  confirmWipe,
  deviceQueueCounts,
  getTradeInDetail,
  guideFor,
  INSPECTION_PHOTO_KIND,
  listTradeIns,
  makeOffer,
  payOut,
  payoutJournalKey,
  payoutWalletKey,
  recordAnswer,
  recordInspection,
  scheduleInspection,
} from "~/server/services/admin/devices/tradeins.server";
import { parseTradeInFilters, parseUsedFilters, type TemplateOption } from "~/server/services/admin/devices/types";
import { listUnit, listUsedUnits, removeUnitPhoto, saveUnitChecklist, saveUnitGrading, setPhotoReal } from "~/server/services/admin/devices/used.server";
import { decideUsedPrice, setUsedUnitPrice } from "~/server/services/admin/pricing/special.server";
import { createTradeIn, listTradeInDevices, respondToOffer, type TradeInAnswers, type TradeInDevice } from "~/server/services/tradein.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const DAY = 86_400_000;
const DATA_KEY = TEST_VARS.DATA_KEY;
const urls = { file: (id: string) => `/admin/devices/files/${id}` };
/** A tiny valid PNG (1×1). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let t: TestDb;
let make: Fixtures;
let store: BlobStore;
let device: TradeInDevice;
let template: TemplateOption;
let variant: { id: string; trackSerials: boolean; sku: string };
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  store = kvBlobStore(t.kv);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "inventory", "support"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
  // A device the store buys: a home console whose guide prices accessories, with a serial-tracked variant and a
  // checklist that has a critical item.
  const devices = await listTradeInDevices(t.db, "ar");
  const templates = await activeTemplates(t.db, "ar");
  for (const candidate of devices) {
    const found = await t.db
      .select({ id: variants.id, trackSerials: variants.trackSerials, sku: variants.sku })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(products.deviceModelId, candidate.id), eq(variants.trackSerials, true), eq(products.kind, "console")))
      .get();
    const tpl = templates.find((entry) => entry.kind === candidate.kind);
    if (found && tpl && tpl.items.some((item) => item.critical) && !candidate.hasScreen && candidate.accessories.length > 0) {
      device = candidate;
      variant = found;
      template = tpl;
      break;
    }
  }
  if (!device) throw new Error("the demo seed has no home console with a guide, a serial-tracked variant and a critical checklist item");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey, branchId: string | null = null): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key, branchId };
}
const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[], options: { id?: string; branchId?: string | null } = {}): EmployeeActor => ({ kind: "employee", id: options.id ?? as("manager").id, permissions: new Set(permissions), branchId: options.branchId ?? null });

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

/**
 * The database a request uses, with a competing request run to its end just before this request's FIRST write batch —
 * the worst moment for a check made before the batch instead of inside it.
 */
function racing(db: Db, competitor: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: Parameters<Db["batch"]>[0]) => {
          if (!fired) {
            fired = true;
            await competitor();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let phones = 0;
const phone = () => `0774${String(1_000_000 + ++phones).slice(-7)}`;
let serialNo = 0;
const serial = () => `RV-SN-${String(++serialNo).padStart(5, "0")}`;

function answersFor(d: TradeInDevice): TradeInAnswers {
  return { power: "works", body: "like_new", ...(d.hasScreen ? { screen: "perfect" as const } : {}), included: [...d.accessories], account: "yes" };
}
function passing(tpl: TemplateOption): Record<string, { result?: string; value?: string }> {
  return Object.fromEntries(tpl.items.map((item) => [item.key, item.input === "percent" ? { value: "90" } : item.input === "text" ? { value: "ok" } : { result: "pass" }]));
}

async function storefrontRequest(options: { customerId?: string | null } = {}) {
  return createTradeIn(t.db, { customerId: options.customerId ?? null, ip: null, locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(), device: device.slug, answers: answersFor(device), contactName: "زبون المراجعة", phone: phone(), ownershipConfirmed: true }, NOW);
}

async function inspected(options: { customerId?: string | null; answers?: Record<string, { result?: string; value?: string }>; by?: EmployeeActor; serial?: string } = {}) {
  const made = await storefrontRequest(options);
  await recordInspection(
    t.db,
    options.by ?? as("manager"),
    { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: options.serial ?? serial(), grade: "A", answers: options.answers ?? passing(template), included: [...device.accessories], ownershipOk: true, accountLockOk: true },
    NOW + MIN,
  );
  return made;
}

async function suggestion(ref: string, actor = as("manager")): Promise<number> {
  const detail = await getTradeInDetail(t.db, actor, ref, "ar", NOW + 2 * MIN, urls);
  if (detail.valuation?.suggestedIqd == null) throw new Error("no suggestion");
  return detail.valuation.suggestedIqd;
}

/** Inspected → offered at the guide's suggestion → accepted by the shopper → wiped. */
async function acceptedAndWiped(options: { customerId?: string | null; payout?: "cash" | "store_credit"; offerBy?: EmployeeActor; answers?: Record<string, { result?: string; value?: string }>; amount?: number; serial?: string } = {}) {
  const made = await inspected(options);
  const amount = options.amount ?? (await suggestion(made.ref));
  await makeOffer(t.db, options.offerBy ?? as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 7 }, NOW + 2 * MIN);
  await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: options.payout ?? "cash" }, NOW + 3 * MIN);
  await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
  return { ...made, amount };
}

const walletEntries = (tradeInId: string) => t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, payoutWalletKey(tradeInId)));
const cashEntries = (tradeInId: string) => t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, payoutJournalKey(tradeInId)));

// ───────────────────────────────────────────────────────────────── 1. money moves once, with the device, or not at all

describe("the payout under a race", () => {
  test("a store-credit payout racing a cash payout pays once: never credit AND cash", async () => {
    const customerId = await make.customer();
    const made = await acceptedAndWiped({ customerId, payout: "store_credit" });
    const cash = () => payOut(t.db, as("owner"), { tradeInId: made.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID, reason: "فضّل النقد عند الاستلام" }, NOW + 6 * MIN);
    const result = await payOut(racing(t.db, cash), as("manager2"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN);
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect(await walletEntries(made.tradeInId)).toHaveLength(0);
    expect(await cashEntries(made.tradeInId)).toHaveLength(1);
    // the answer names the payout that really happened
    expect(result).toMatchObject({ replayed: true, method: "cash" });
    expect(await t.db.select().from(usedUnits).where(eq(usedUnits.tradeInId, made.tradeInId))).toHaveLength(1);
  });

  test("a payout racing a cancel credits nothing for the cancelled trade-in", async () => {
    const customerId = await make.customer();
    const made = await acceptedAndWiped({ customerId, payout: "store_credit" });
    const cancel = () => cancelTradeIn(t.db, as("manager"), { tradeInId: made.tradeInId, reason: "تراجع العميل في آخر لحظة" }, NOW + 6 * MIN);
    const refused = await failureOf(payOut(racing(t.db, cancel), as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN));
    expect(refused.status).toBe(409);
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get())?.status).toBe("cancelled");
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect(await walletEntries(made.tradeInId)).toHaveLength(0);
  });

  test("a payout whose stock side is refused (the serial entered stock meanwhile) moves no money", async () => {
    const customerId = await make.customer();
    const sn = serial();
    const made = await acceptedAndWiped({ customerId, payout: "store_credit", serial: sn });
    // another receipt books the very same serial into stock just before the payout's write
    const receipt = () => t.db.insert(serials).values({ id: `ser_${randomToken(8)}`, serial: sn, variantId: variant.id, status: "in_stock", source: "purchase", sourceRef: "rcv-race", createdAt: NOW, updatedAt: NOW });
    const refused = await failureOf(payOut(racing(t.db, receipt), as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN));
    expect(refused).toMatchObject({ code: "invalid", fields: { serial: "serial_in_stock" } });
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get())?.status).toBe("accepted");
  });
});

// ───────────────────────────────────────────────────────────────── 2. four eyes: the guide's author is not the independent check

describe("four eyes on the price guide", () => {
  test("the employee who last set the guide cannot also make an offer on it and pay it out alone", async () => {
    const author = await employee("manager");
    const pricing = await guideFor(t.db, device.id, variant.id);
    const guide = (await listGuides(t.db, author, "ar")).find((entry) => entry.id === pricing?.id);
    if (!guide) throw new Error("no active guide prices the device");
    // the author doubles the reference price of the model…
    await saveGuide(
      t.db,
      author,
      {
        guideId: guide.id,
        expectedUpdatedAt: guide.updatedAt,
        deviceModelId: device.id,
        variantCode: guide.variant?.sku ?? "",
        baseIqd: String(guide.baseIqd * 2),
        multipliers: Object.fromEntries(Object.entries(guide.multipliers).map(([grade, bps]) => [grade, String((bps as number) / 100)])),
        deductions: guide.deductions.map((line) => ({ key: line.key, amountIqd: String(line.amountIqd) })),
        isActive: true,
        reason: "سعر السوق ارتفع",
      },
      NOW,
    );
    // …then offers exactly the new "suggestion", records the acceptance and pays it out
    const made = await inspected({ by: author });
    const amount = await suggestion(made.ref, author);
    await makeOffer(t.db, author, { tradeInId: made.tradeInId, amountIqd: amount, validDays: 7 }, NOW + 2 * MIN);
    await recordAnswer(t.db, author, { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, author, { tradeInId: made.tradeInId }, NOW + 4 * MIN);
    const detail = await getTradeInDetail(t.db, author, made.ref, "ar", NOW + 5 * MIN, urls);
    expect(detail.can.payoutNeedsSecond).toBe(true);
    expect(detail.payoutBlockers).toContain("payout_second_person");
    expect(await failureOf(payOut(t.db, author, { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN))).toMatchObject({ code: "payout_second_person", status: 403 });
    expect(await cashEntries(made.tradeInId)).toHaveLength(0);
    // another employee may pay it out
    expect(await payOut(t.db, as("manager2"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN)).toMatchObject({ replayed: false, method: "cash" });
    // an offer within a guide someone else set is still the offerer's to pay out
    const within = await acceptedAndWiped({ payout: "cash", offerBy: as("manager2") });
    expect(await payOut(t.db, as("manager2"), { tradeInId: within.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN)).toMatchObject({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── 3. 13.07 never revealed before payment

describe("digital codes", () => {
  test("a code is never revealed before it is paid for — an unsold code included", async () => {
    const digital = await t.db.select({ id: variants.id, sku: variants.sku }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(products.kind, "digital")).get();
    if (!digital) throw new Error("no digital product in the demo seed");
    const manager = as("manager");
    await importCodes(t.db, manager, DATA_KEY, { variantId: digital.id, codes: "REVIEW-UNSOLD-0001\nREVIEW-PAID-0002" }, NOW);
    const rows = await t.db.select().from(digitalCodes).where(eq(digitalCodes.variantId, digital.id));
    const texts = await Promise.all(rows.map((row) => decryptSecret(row.codeEnc, DATA_KEY, codeContext(row.id))));
    const unsold = rows[texts.indexOf("REVIEW-UNSOLD-0001")];
    const sold = rows[texts.indexOf("REVIEW-PAID-0002")];
    // nobody has paid for an available code: its text stays sealed
    expect(await failureOf(revealCode(t.db, manager, DATA_KEY, { codeId: unsold.id, variantId: digital.id, reason: "تحقق قبل البيع" }, NOW + MIN))).toMatchObject({ code: "code_unpaid", status: 409 });
    // a code delivered on a paid order can be shown again (a buyer who lost it)
    const order = await make.order([{ variantId: digital.id, sku: digital.sku }], { paymentStatus: "paid" });
    await t.db.update(digitalCodes).set({ status: "delivered", orderItemId: order.itemIds[0], deliveredAt: NOW }).where(eq(digitalCodes.id, sold.id));
    const shown = await revealCode(t.db, manager, DATA_KEY, { codeId: sold.id, variantId: digital.id, reason: "العميل فقد الرمز بعد الدفع" }, NOW + 2 * MIN);
    expect(shown.code).toBe("REVIEW-PAID-0002");
  });
});

// ───────────────────────────────────────────────────────────────── 5. the unit a payout creates

describe("the used unit a payout creates", () => {
  test("is not 'ready' when a critical checklist item failed (it stays out of the listing queue)", async () => {
    const critical = template.items.find((item) => item.critical);
    if (!critical) throw new Error("the template has no critical item");
    const answers = { ...passing(template), [critical.key]: { result: "fail" } };
    const made = await acceptedAndWiped({ payout: "cash", answers, amount: 50_000 });
    const before = (await deviceQueueCounts(t.db, as("manager"), NOW + 5 * MIN)).toList;
    const paid = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    const unit = await t.db.select().from(usedUnits).where(eq(usedUnits.id, paid.usedUnitId)).get();
    expect(unit?.status).toBe("testing");
    expect((await deviceQueueCounts(t.db, as("manager"), NOW + 6 * MIN)).toList).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────── 6. photos

describe("photos of a unit (13.09)", () => {
  test("a photo taken off a listed unit is private again; published inspection photos still show on the trade-in page", async () => {
    const made = await inspected();
    const uploads: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { file } = await saveImageUpload(t.db, store, PNG, { visibility: "private", kind: INSPECTION_PHOTO_KIND, ownerType: "trade_in", ownerId: made.tradeInId, createdBy: as("manager"), now: NOW + MIN });
      uploads.push(file.id);
    }
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: await suggestion(made.ref), validDays: 7 }, NOW + 2 * MIN);
    await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
    const { usedUnitId } = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    const photos = await t.db.select().from(media).where(and(eq(media.ownerType, "used_unit"), eq(media.ownerId, usedUnitId)));
    expect(photos).toHaveLength(2);
    for (const photo of photos) await setPhotoReal(t.db, store, as("manager"), { usedUnitId, mediaId: photo.id, real: true }, NOW + 6 * MIN);
    const price = await setUsedUnitPrice(t.db, as("manager"), { usedUnitId, price: 350_000, expectedPriceIqd: 0, reason: "سعر أول للجهاز" }, NOW + 6 * MIN);
    if (price.status === "pending" && price.requestId) await decideUsedPrice(t.db, as("manager2"), { approvalId: price.requestId, decision: "approve", note: "مناسب" }, NOW + 6 * MIN);
    await saveUnitGrading(t.db, as("manager"), { usedUnitId, grade: "A", cosmeticNotes: { ar: "خدوش خفيفة على الظهر." }, warrantyDays: "30" }, NOW + 7 * MIN, () => undefined);
    await listUnit(t.db, store, as("manager"), { usedUnitId }, NOW + 8 * MIN);
    for (const id of uploads) expect((await t.db.select().from(files).where(eq(files.id, id)).get())?.visibility).toBe("public");

    // the trade-in page shows the published photos from where they are now served
    const detail = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 9 * MIN, urls);
    const inspection = detail.photos.filter((photo) => photo.kind === "inspection");
    expect(inspection).toHaveLength(2);
    for (const photo of inspection) expect(photo.url.startsWith("/media/")).toBe(true);

    // one photo is taken off the unit (it showed something it should not): it is no longer public
    await removeUnitPhoto(t.db, store, as("manager"), { usedUnitId, mediaId: photos[0].id }, NOW + 10 * MIN);
    expect((await t.db.select().from(files).where(eq(files.id, photos[0].fileId as string)).get())?.visibility).toBe("private");
    expect((await t.db.select().from(files).where(eq(files.id, photos[1].fileId as string)).get())?.visibility).toBe("public");
  });
});

// ───────────────────────────────────────────────────────────────── 7. 13.08 ownership needs its own permission

describe("ownership and the account lock (13.08)", () => {
  test("an inspector without devices.ownership.verify records the checklist but cannot confirm ownership", async () => {
    const made = await storefrontRequest();
    const inspector = custom(["devices.tradein.inspect", "devices.tradein.read"], { id: as("inventory").id });
    const raw = { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: "B" as const, answers: passing(template), included: [], ownershipOk: true, accountLockOk: true };
    expect(await failureOf(recordInspection(t.db, inspector, raw, NOW + MIN))).toMatchObject({ code: "forbidden", status: 403 });
    // the checklist itself is the inspector's: saved with the checks left open
    await recordInspection(t.db, inspector, { ...raw, ownershipOk: false, accountLockOk: false }, NOW + MIN);
    let row = await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get();
    expect(row).toMatchObject({ status: "inspected", ownershipOk: false, accountLockOk: false });
    // someone who may verify confirms both; the inspector can inspect again without undoing that
    await recordInspection(t.db, as("manager"), raw, NOW + 2 * MIN);
    await recordInspection(t.db, inspector, { ...raw, grade: "A" }, NOW + 3 * MIN);
    row = await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get();
    expect(row).toMatchObject({ ownershipOk: true, accountLockOk: true });
    expect((row?.inspection as { grade?: string })?.grade).toBe("A");
  });
});

// ───────────────────────────────────────────────────────────────── 8. double submit, branch counts

describe("small things that misled staff", () => {
  test("the customer's in-person answer sent twice is answered once, not as an error", async () => {
    const made = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: await suggestion(made.ref), validDays: 7 }, NOW + 2 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    expect(await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN + 500)).toMatchObject({ status: "accepted", replayed: true });
    // a different answer after the first is still refused
    expect(await failureOf(recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "decline", reason: "غيّر رأيه" }, NOW + 4 * MIN))).toMatchObject({ code: "offer_closed" });
    // through the page's action, the replay is a success
    const session = (actor: EmployeeActor): EmployeeSession =>
      ({
        employee: { id: actor.id, email: "x@tamtam.test", name: "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
        actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
        roles: [],
        session: { id: "s", createdAt: NOW, expiresAt: NOW + DAY, mfaOk: true },
      }) as EmployeeSession;
    const form = new FormData();
    form.set("intent", "answer");
    form.set("decision", "accept");
    form.set("payout", "cash");
    expect(await tradeInAction({ locale: "ar", now: NOW + 3 * MIN + 900 }, t.db, session(as("manager")), made.ref, form, () => store)).toMatchObject({ ok: true, intent: "answer", status: "accepted" });
  });

  test("each trade-in queue counts exactly what the list it opens shows", async () => {
    // one in each awkward state: an inspection booked, an offer declined, an offer past its date nobody recorded yet
    const booked = await storefrontRequest();
    const day = new Date(NOW + 2 * DAY + 3 * 3_600_000).toISOString().slice(0, 10);
    await scheduleInspection(t.db, as("manager"), { tradeInId: booked.tradeInId, day, time: "11:00" }, NOW + MIN);
    const declined = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: declined.tradeInId, amountIqd: 90_000, validDays: 7 }, NOW + 2 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: declined.tradeInId, decision: "decline", reason: "يريد أكثر" }, NOW + 3 * MIN);
    const lapsed = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: lapsed.tradeInId, amountIqd: 90_000, validDays: 1 }, NOW + 2 * MIN);
    const open = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: open.tradeInId, amountIqd: 90_000, validDays: 30 }, NOW + 2 * MIN);
    const at = NOW + 3 * DAY;
    const counts = await deviceQueueCounts(t.db, as("manager"), at);
    const total = async (view: string) => (await listTradeIns(t.db, as("manager"), parseTradeInFilters(new URLSearchParams(`view=${view}`)), "ar", at)).total;
    // the cards' links (index.tsx): toInspect → ?view=new, toOffer → ?view=inspected, awaitingAnswer → ?view=offered, toPay → ?view=accepted
    expect(counts.toInspect).toBe(await total("new"));
    expect(counts.toOffer).toBe(await total("inspected"));
    expect(counts.awaitingAnswer).toBe(await total("offered"));
    expect(counts.toPay).toBe(await total("accepted"));
    const offeredRefs = (await listTradeIns(t.db, as("manager"), parseTradeInFilters(new URLSearchParams("view=offered")), "ar", at)).rows.map((row) => row.ref);
    expect(offeredRefs).toContain(open.ref);
    expect(offeredRefs).not.toContain(lapsed.ref);
    const waiting = (await listTradeIns(t.db, as("manager"), parseTradeInFilters(new URLSearchParams("view=inspected")), "ar", at)).rows.map((row) => row.ref);
    expect(waiting).toEqual(expect.arrayContaining([declined.ref, lapsed.ref]));
  });

  test("the units queue counts what a branch-limited employee's list shows", async () => {
    const branchId = `brn_${randomToken(8)}`;
    await t.db.insert(branches).values({ id: branchId, code: `BR-${randomToken(4)}`, name: { ar: "فرع المراجعة", en: "Review branch" }, createdAt: NOW });
    const locationId = `loc_${randomToken(8)}`;
    await t.db.insert(inventoryLocations).values({ id: locationId, code: `RV-${randomToken(4)}`, name: "رف فرع المراجعة", kind: "store", branchId, isSellable: true, isActive: true });
    // one unit at the branch, the others (from the tests above and this one) at the main warehouse
    const here = await acceptedAndWiped({ payout: "cash" });
    await payOut(t.db, as("owner"), { tradeInId: here.tradeInId, locationId }, NOW + 5 * MIN);
    const there = await acceptedAndWiped({ payout: "cash" });
    await payOut(t.db, as("owner"), { tradeInId: there.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    const local = custom(["devices.used.inspect", "devices.used.list", "devices.registry.read"], { id: as("inventory").id, branchId });
    const counts = await deviceQueueCounts(t.db, local, NOW + 6 * MIN);
    const ready = await listUsedUnits(t.db, local, parseUsedFilters(new URLSearchParams("view=ready")), "ar");
    const todo = await listUsedUnits(t.db, local, parseUsedFilters(new URLSearchParams("view=todo")), "ar");
    expect(ready.total).toBe(1);
    expect(counts.toList).toBe(ready.total);
    expect(counts.unitsToInspect).toBe(todo.total);
  });
});

describe("digits typed on an Arabic or Kurdish keyboard", () => {
  test("a checklist item's position and a code batch's expiry date accept Arabic-Indic and Persian digits", async () => {
    const form = new FormData();
    const rows = [
      { key: "power", ar: "يعمل", position: "٣" },
      { key: "ports", ar: "المنافذ", position: "۱" },
      { key: "fan", ar: "المروحة", position: "2" },
    ];
    rows.forEach((row, index) => {
      form.set(`i.${index}.key`, row.key);
      form.set(`i.${index}.ar`, row.ar);
      form.set(`i.${index}.en`, row.key);
      form.set(`i.${index}.keep`, "on");
      form.set(`i.${index}.position`, row.position);
    });
    expect(templateItemsFrom(form).map((item) => item.key)).toEqual(["ports", "fan", "power"]);

    const digital = await t.db.select({ id: variants.id }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(products.kind, "digital")).get();
    if (!digital) throw new Error("no digital product in the demo seed");
    await importCodes(t.db, as("manager"), DATA_KEY, { variantId: digital.id, codes: "DIGITS-EXPIRY-0001", expiresOn: "٢٠٢٧-٠١-٣١" }, NOW);
    const row = (await t.db.select().from(digitalCodes).where(eq(digitalCodes.variantId, digital.id))).find((code) => code.expiresAt !== null);
    // the end of 31 January 2027, Baghdad time
    expect(row?.expiresAt).toBe(Date.UTC(2027, 0, 31, 21, 0, 0) - 1);
  });
});

// ───────────────────────────────────────────────────────────────── 4. 13.02 the current checklist (last: it switches a template version off)

describe("inspection checklists (13.02)", () => {
  test("a new checklist is filled on the current version of its template; a switched-off version is refused", async () => {
    const editor = await getTemplateEditor(t.db, as("manager"), template.kind, "ar");
    const current = editor.current;
    if (!current) throw new Error("no current template");
    const items = current.items.map((item) => ({ key: item.key, label: { ar: item.label.ar, en: item.label.en ?? item.label.ar, ckb: "" }, hint: { ar: "", en: "", ckb: "" }, input: item.input, required: item.required, critical: item.critical === true }));
    const saved = await saveTemplate(
      t.db,
      as("manager"),
      { kind: template.kind, expectedVersion: current.version, name: current.name, items: [...items, { key: "fan_noise", label: { ar: "صوت المروحة تحت الحمل", en: "Fan noise under load", ckb: "" }, hint: { ar: "", en: "", ckb: "" }, input: "pass_fail", required: true, critical: true }], reason: "بند حاسم جديد للحرارة" },
      NOW,
    );
    expect(saved.version).toBe(current.version + 1);
    // a trade-in inspected on the old version (fewer required checks) after the new one exists
    const made = await storefrontRequest();
    const old = { tradeInId: made.tradeInId, templateId: current.id, variantId: variant.id, serial: serial(), grade: "A" as const, answers: passing(template), included: [], ownershipOk: true, accountLockOk: true };
    expect(await failureOf(recordInspection(t.db, as("manager"), old, NOW + MIN))).toMatchObject({ code: "invalid", fields: { templateId: "template_changed" } });
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get())?.status).not.toBe("inspected");
    // the same for a used unit's checklist
    const fresh = (await activeTemplates(t.db, "ar")).find((entry) => entry.kind === template.kind) as TemplateOption;
    expect(fresh.id).toBe(saved.templateId);
    const later = await storefrontRequest();
    await recordInspection(t.db, as("manager"), { ...old, tradeInId: later.tradeInId, templateId: fresh.id, answers: passing(fresh), serial: serial() }, NOW + 2 * MIN);
    await makeOffer(t.db, as("manager"), { tradeInId: later.tradeInId, amountIqd: 50_000, validDays: 7 }, NOW + 3 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: later.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, as("manager"), { tradeInId: later.tradeInId }, NOW + 4 * MIN);
    const { usedUnitId } = await payOut(t.db, as("owner"), { tradeInId: later.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    expect(await failureOf(saveUnitChecklist(t.db, as("inventory"), { usedUnitId, templateId: current.id, answers: passing(template) }, NOW + 6 * MIN))).toMatchObject({ code: "invalid", fields: { templateId: "template_changed" } });
    await saveUnitChecklist(t.db, as("inventory"), { usedUnitId, templateId: fresh.id, answers: passing(fresh) }, NOW + 6 * MIN);
  });
});
