/**
 * Builds the client-safe OrderView / OrderSummary (./types) from an order row. Reads only.
 * Never selects cost columns ([P]), internal notes, risk flags, staff ids or serial numbers.
 * Transfer instructions are read from settings at request time, never stored on the order.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ImageRef, UsedGrade } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { maskPhone } from "~/lib/phone";
import type { Db } from "~/server/db/drizzle.server";
import { carriers, districts, files, governorates, media, orderEvents, orderItems, paymentProofs, payments, products, refunds, shipmentEvents, shipments, usedUnits, variants, type Order } from "~/server/db/schema";
import { getSettings } from "~/server/settings.server";
import { orderDigitalLines } from "./digital.server";
import { adjustmentsView, PROMOTIONS_EVENT, type PromotionsRecord } from "./promotions.server";
import { ORDER_TIMELINE_KINDS, PREFERRED_WINDOWS, type OrderLineView, type OrderSummary, type OrderTimelineKind, type OrderView, type PreferredWindow, type ProofStatus, type ShipmentView, type TransferInstructions } from "./types";

const TRANSFER_METHODS = new Set(["bank_transfer", "zaincash"]);
/** Order payment states in which nothing more is owed (a shortfall accepted by an override included). */
const SETTLED_PAYMENT = new Set<string>(["paid", "partially_refunded", "refunded"]);
const STATUS_TIMELINE = new Set<string>(["confirmed", "preparing", "shipped", "delivered", "cancelled", "returned"]);
const PLACEHOLDER = (alt: string): ImageRef => ({ artKey: null, mediaKey: null, alt, isIllustration: true });

type ImageKey = `${"variant" | "product" | "used_unit"}:${string}`;

/** First picture per owner: used units prefer real photos; others keep the gallery order. Public files only. */
async function loadImages(db: Db, owners: { variant: string[]; product: string[]; used_unit: string[] }, locale: Locale): Promise<Map<ImageKey, ImageRef>> {
  const out = new Map<ImageKey, ImageRef>();
  if (owners.variant.length + owners.product.length + owners.used_unit.length === 0) return out;
  const rows = await db
    .select({ ownerType: media.ownerType, ownerId: media.ownerId, artKey: media.artKey, alt: media.alt, isIllustration: media.isIllustration, sort: media.sort, storageKey: files.storageKey, visibility: files.visibility, width: files.width, height: files.height })
    .from(media)
    .leftJoin(files, eq(files.id, media.fileId))
    .where(
      sql`${media.kind} IN ('image', 'render') AND (
        (${media.ownerType} = 'variant' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.variant)})))
        OR (${media.ownerType} = 'product' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.product)})))
        OR (${media.ownerType} = 'used_unit' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.used_unit)})))
      )`,
    )
    .orderBy(asc(media.sort), asc(media.id));
  const sorted = [...rows].sort((a, b) => (a.ownerType === "used_unit" && b.ownerType === "used_unit" ? Number(a.isIllustration) - Number(b.isIllustration) : 0) || a.sort - b.sort);
  for (const row of sorted) {
    const key = `${row.ownerType}:${row.ownerId}` as ImageKey;
    if (out.has(key)) continue;
    const mediaKey = row.storageKey && row.visibility === "public" ? row.storageKey : null;
    if (!mediaKey && !row.artKey) continue;
    out.set(key, {
      artKey: mediaKey ? null : row.artKey,
      mediaKey,
      alt: pick(row.alt as L10n | null, locale),
      isIllustration: row.isIllustration,
      ...(mediaKey && row.width && row.height ? { width: row.width, height: row.height } : {}),
    });
  }
  return out;
}

type LineRow = {
  id: string;
  variantId: string;
  usedUnitId: string | null;
  nameSnapshot: L10n;
  optionsSnapshot: Record<string, string> | null;
  unitPriceIqd: number;
  qty: number;
  totalIqd: number;
  refundedQty: number;
  warrantyMonths: number | null;
  warrantyDays: number | null;
};

async function lineViews(db: Db, lines: LineRow[], locale: Locale): Promise<OrderLineView[]> {
  if (lines.length === 0) return [];
  const variantIds = [...new Set(lines.map((line) => line.variantId))];
  const usedIds = lines.flatMap((line) => (line.usedUnitId ? [line.usedUnitId] : []));
  const [variantRows, usedRows] = await Promise.all([
    db
      .select({ variantId: variants.id, productId: products.id, slug: products.slug, status: products.status })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.id, variantIds)),
    usedIds.length ? db.select({ unitId: usedUnits.id, grade: usedUnits.grade }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : Promise.resolve([]),
  ]);
  const productOf = new Map(variantRows.map((row) => [row.variantId, row]));
  const gradeOf = new Map(usedRows.map((row) => [row.unitId, row.grade as UsedGrade]));
  const images = await loadImages(db, { variant: variantIds, product: [...new Set(variantRows.map((row) => row.productId))], used_unit: usedIds }, locale);

  return lines.map((line) => {
    const product = productOf.get(line.variantId);
    const name = pick(line.nameSnapshot, locale);
    const image =
      (line.usedUnitId ? images.get(`used_unit:${line.usedUnitId}`) : undefined) ?? images.get(`variant:${line.variantId}`) ?? (product ? images.get(`product:${product.productId}`) : undefined) ?? PLACEHOLDER(name);
    return {
      id: line.id,
      kind: line.usedUnitId ? "used_unit" : "variant",
      name,
      grade: line.usedUnitId ? (gradeOf.get(line.usedUnitId) ?? ((line.optionsSnapshot?.grade as UsedGrade | undefined) ?? null)) : null,
      // A used unit's page is gone once it is sold; a product page only while it is published.
      href: !line.usedUnitId && product && product.status === "published" ? `/p/${product.slug}` : null,
      image: { ...image, alt: image.alt || name },
      qty: line.qty,
      unitPriceIqd: line.unitPriceIqd,
      lineTotalIqd: line.totalIqd,
      refundedQty: line.refundedQty,
      warranty: line.warrantyMonths && line.warrantyMonths > 0 ? { months: line.warrantyMonths } : line.warrantyDays && line.warrantyDays > 0 ? { days: line.warrantyDays } : null,
    } satisfies OrderLineView;
  });
}

function trackingUrl(template: string | null, trackingNo: string | null): string | null {
  if (!template || !trackingNo || !template.includes("{tracking_no}")) return null;
  const url = template.replace("{tracking_no}", encodeURIComponent(trackingNo));
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The transfer instructions for an order's method, from settings. */
export async function transferInstructions(db: Db, method: string | null): Promise<TransferInstructions | null> {
  if (method !== "bank_transfer" && method !== "zaincash") return null;
  const values = await getSettings(db, ["payments.bank_transfer", "payments.zaincash"]);
  if (method === "bank_transfer") return { method, accountNumber: values["payments.bank_transfer"].account_number, recipientName: values["payments.bank_transfer"].recipient_name };
  return { method, number: values["payments.zaincash"].number };
}

/**
 * The full shopper view of one order. The caller has already decided the shopper may see it.
 * `now` decides whether the proof-upload window is still open (default: the current time).
 */
export async function buildOrderView(db: Db, order: Order, locale: Locale, now: number = Date.now()): Promise<OrderView> {
  const [lines, geo, paymentRows, shipmentRows, eventRows, refundRows] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        usedUnitId: orderItems.usedUnitId,
        nameSnapshot: orderItems.nameSnapshot,
        optionsSnapshot: orderItems.optionsSnapshot,
        unitPriceIqd: orderItems.unitPriceIqd,
        qty: orderItems.qty,
        totalIqd: orderItems.totalIqd,
        refundedQty: orderItems.refundedQty,
        warrantyMonths: orderItems.warrantyMonths,
        warrantyDays: orderItems.warrantyDays,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id)),
    Promise.all([
      order.governorateId ? db.select({ name: governorates.name }).from(governorates).where(eq(governorates.id, order.governorateId)).get() : Promise.resolve(undefined),
      order.districtId ? db.select({ name: districts.name }).from(districts).where(eq(districts.id, order.districtId)).get() : Promise.resolve(undefined),
    ]),
    db.select({ id: payments.id, method: payments.method, status: payments.status, amountIqd: payments.amountIqd }).from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.createdAt), asc(payments.id)),
    db
      .select({ id: shipments.id, status: shipments.status, trackingNo: shipments.trackingNo, shippedAt: shipments.shippedAt, deliveredAt: shipments.deliveredAt, carrierName: carriers.name, template: carriers.trackingUrlTemplate })
      .from(shipments)
      .leftJoin(carriers, eq(carriers.id, shipments.carrierId))
      .where(eq(shipments.orderId, order.id))
      .orderBy(asc(shipments.createdAt), asc(shipments.id)),
    db.select({ kind: orderEvents.kind, data: orderEvents.data, at: orderEvents.at }).from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(asc(orderEvents.at), asc(orderEvents.id)),
    db
      .select({ amountIqd: refunds.amountIqd, method: refunds.method, status: refunds.status, createdAt: refunds.createdAt, paidAt: refunds.paidAt })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, ["pending", "paid"])))
      .orderBy(asc(refunds.createdAt)),
  ]);

  const transfer = paymentRows.filter((row) => TRANSFER_METHODS.has(row.method));
  const transferPayment = transfer[transfer.length - 1];
  const [proof, shipmentEventRows, lineList, instructions, digital] = await Promise.all([
    transferPayment
      ? db
          .select({ status: paymentProofs.status, createdAt: paymentProofs.createdAt, declaredAmountIqd: paymentProofs.declaredAmountIqd, reviewNote: paymentProofs.reviewNote })
          .from(paymentProofs)
          .where(eq(paymentProofs.paymentId, transferPayment.id))
          .orderBy(sql`${paymentProofs.createdAt} DESC`, sql`${paymentProofs.id} DESC`)
          .limit(1)
          .get()
      : Promise.resolve(undefined),
    shipmentRows.length
      ? db
          .select({ shipmentId: shipmentEvents.shipmentId, kind: shipmentEvents.kind, at: shipmentEvents.at })
          .from(shipmentEvents)
          .where(inArray(shipmentEvents.shipmentId, shipmentRows.map((row) => row.id)))
          .orderBy(asc(shipmentEvents.at), asc(shipmentEvents.id))
      : Promise.resolve([]),
    lineViews(db, lines as LineRow[], locale),
    order.status === "awaiting_payment" ? transferInstructions(db, order.paymentMethod) : Promise.resolve(null),
    orderDigitalLines(db, order, locale),
  ]);
  // what the order recorded about its promotions (its latest "promotions" event — an edit that re-priced the coupon or
  // the delivery appends one), and a split payment's wallet part
  const promotionsEvent = [...eventRows].reverse().find((event) => event.kind === PROMOTIONS_EVENT && event.data);
  const adjustments = promotionsEvent ? adjustmentsView(promotionsEvent.data as unknown as PromotionsRecord, locale) : null;
  const walletPaidIqd = order.paymentMethod !== "wallet" ? paymentRows.filter((row) => row.method === "wallet" && row.status === "paid").reduce((sum, row) => sum + row.amountIqd, 0) : 0;

  const proofStatus: ProofStatus = proof ? proof.status : "none";
  const timeline: OrderView["timeline"] = [];
  for (const event of eventRows) {
    const to = typeof event.data?.to === "string" ? event.data.to : null;
    const kind = event.kind === "status_changed" ? (to && STATUS_TIMELINE.has(to) ? to : null) : event.kind;
    if (kind && (ORDER_TIMELINE_KINDS as readonly string[]).includes(kind)) timeline.push({ kind: kind as OrderTimelineKind, at: event.at });
  }

  const shipmentViews: ShipmentView[] = shipmentRows
    .filter((row) => row.status !== "cancelled")
    .map((row) => ({
      status: row.status,
      carrierName: row.carrierName ?? null,
      trackingNo: row.trackingNo,
      trackingUrl: trackingUrl(row.template ?? null, row.trackingNo),
      shippedAt: row.shippedAt,
      deliveredAt: row.deliveredAt,
      events: shipmentEventRows.filter((event) => event.shipmentId === row.id).map((event) => ({ kind: event.kind, at: event.at })),
    }));

  const awaitingTransfer = order.status === "awaiting_payment" && TRANSFER_METHODS.has(order.paymentMethod ?? "");
  // A proof can be sent while the transfer payment waits for one: first upload, or after a rejection.
  const proofExpected = awaitingTransfer && (transferPayment?.status === "pending" || transferPayment?.status === "rejected");
  const settled = SETTLED_PAYMENT.has(order.paymentStatus) || order.status === "cancelled";
  const window = PREFERRED_WINDOWS.includes(order.preferredWindow as PreferredWindow) ? (order.preferredWindow as PreferredWindow) : null;
  return {
    ref: order.ref,
    status: order.status,
    placedAt: order.placedAt,
    confirmedAt: order.confirmedAt,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    cancelledAt: order.cancelledAt,
    isDemo: order.isDemo,
    contact: { name: order.contactName, phoneMasked: order.contactPhoneE164 ? maskPhone(order.contactPhoneE164) : "" },
    delivery: {
      governorate: pick(geo[0]?.name ?? null, locale),
      district: geo[1] ? pick(geo[1].name, locale) : null,
      area: order.areaText,
      address: order.addressText,
      notes: order.notes,
      preferredDay: order.preferredDay,
      preferredWindow: window,
    },
    lines: lineList,
    itemCount: lines.reduce((sum, line) => sum + line.qty, 0),
    totals: { subtotalIqd: order.subtotalIqd, discountIqd: order.discountIqd, shippingIqd: order.shippingIqd, totalIqd: order.totalIqd },
    coupon: order.couponCode ? { code: order.couponCode } : null,
    payment: {
      method: order.paymentMethod === "pos_cash" || order.paymentMethod === "pos_card" ? null : order.paymentMethod,
      status: order.paymentStatus,
      amountDueIqd: settled ? 0 : Math.max(0, order.totalIqd - order.paidIqd),
      paidIqd: order.paidIqd,
      refundedIqd: order.refundedIqd,
      dueAt: awaitingTransfer ? order.paymentDueAt : null,
      instructions: awaitingTransfer ? instructions : null,
      proof: {
        status: proofStatus,
        submittedAt: proof?.createdAt ?? null,
        declaredAmountIqd: proof?.declaredAmountIqd ?? null,
        rejectReason: proof?.status === "rejected" ? proof.reviewNote : null,
      },
      canUploadProof: proofExpected && proofStatus !== "submitted" && (order.paymentDueAt === null || now < order.paymentDueAt),
    },
    shipments: shipmentViews,
    refunds: refundRows.map((row) => ({ amountIqd: row.amountIqd, method: row.method, status: row.status === "paid" ? "paid" : "pending", at: row.paidAt ?? row.createdAt })),
    timeline,
    adjustments,
    walletPaidIqd,
    digital,
  };
}

/** Rows of "my orders" for a page of order rows (newest first, as given). */
export async function buildOrderSummaries(db: Db, rows: Order[], locale: Locale): Promise<OrderSummary[]> {
  if (rows.length === 0) return [];
  const items = await db
    .select({ orderId: orderItems.orderId, id: orderItems.id, variantId: orderItems.variantId, usedUnitId: orderItems.usedUnitId, nameSnapshot: orderItems.nameSnapshot, qty: orderItems.qty })
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)))
    .orderBy(asc(orderItems.id));
  const first = new Map<string, (typeof items)[number]>();
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!first.has(item.orderId)) first.set(item.orderId, item);
    counts.set(item.orderId, (counts.get(item.orderId) ?? 0) + item.qty);
  }
  const firstLines = [...first.values()];
  const variantIds = [...new Set(firstLines.map((item) => item.variantId))];
  const productRows = variantIds.length ? await db.select({ variantId: variants.id, productId: variants.productId }).from(variants).where(inArray(variants.id, variantIds)) : [];
  const productOf = new Map(productRows.map((row) => [row.variantId, row.productId]));
  const images = await loadImages(
    db,
    { variant: variantIds, product: [...new Set(productRows.map((row) => row.productId))], used_unit: firstLines.flatMap((item) => (item.usedUnitId ? [item.usedUnitId] : [])) },
    locale,
  );
  return rows.map((order) => {
    const line = first.get(order.id);
    const productId = line ? productOf.get(line.variantId) : undefined;
    const image = line ? ((line.usedUnitId ? images.get(`used_unit:${line.usedUnitId}`) : undefined) ?? images.get(`variant:${line.variantId}`) ?? (productId ? images.get(`product:${productId}`) : undefined) ?? null) : null;
    const name = line ? pick(line.nameSnapshot, locale) : "";
    return {
      ref: order.ref,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod === "pos_cash" || order.paymentMethod === "pos_card" ? null : order.paymentMethod,
      placedAt: order.placedAt,
      totalIqd: order.totalIqd,
      itemCount: counts.get(order.id) ?? 0,
      firstItemName: name,
      image: image ? { ...image, alt: image.alt || name } : null,
      isDemo: order.isDemo,
    };
  });
}
