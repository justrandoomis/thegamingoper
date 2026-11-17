/**
 * A review of what the customer received (polish round 2026-11-13; admin 16.06's model — the `reviews` table moderated
 * in /admin/marketing/reviews): account/reviews.server and the account's order page — the form that posts without
 * script, the action behind it and the state of a sent review. Real local D1.
 *
 * The rules under test: only the buyer, only a delivered line, once per line (and per product: the table's unique
 * index), pending and shown nowhere until staff approve it; a demo order's review never counts as a verified purchase.
 */
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import type { CustomerActor, EmployeeActor } from "~/server/actor";
import { signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { auditEvents, customers, reviews, usedUnits } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { listOrderReviewSlots, ownRejectCode, REVIEW_WRITES, reviewLocale, submitLineReview } from "~/server/services/account/reviews.server";
import type { ReviewSlot } from "~/server/services/account/types";
import { moderateReview } from "~/server/services/admin/marketing/reviews.server";
import { getOrderForCustomer } from "~/server/services/orders/manage.server";
import type { OrderView } from "~/server/services/orders/types";
import { getReviewSummary, listVerifiedReviews } from "~/server/services/reviews.server";
import OrderPage, { action as orderAction } from "~/routes/storefront/account/order";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
/** Staff who decide reviews (content's role holds marketing.review.moderate). */
const STAFF: EmployeeActor = { kind: "employee", id: "emp_reviews_test", permissions: new Set(["marketing.review.moderate"]), label: "test" };

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t.dispose();
});

let ipCount = 0;
/** A customer as the account pages see them, from their own network address (each test its own, for the limit). */
const buyer = async (overrides: Parameters<Fixtures["customer"]>[0] = {}): Promise<CustomerActor> => ({ kind: "customer", id: await make.customer(overrides), ip: `198.51.100.${++ipCount}` });
const delivered = (customerId: string, lines: Parameters<Fixtures["order"]>[0], extra: Parameters<Fixtures["order"]>[1] = {}) =>
  make.order(lines, { customerId, status: "delivered", placedAt: NOW - 3 * DAY, deliveredAt: NOW - DAY, ...extra });
const ar = { now: NOW, locale: "ar" as Locale };

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

const reviewRows = (customerId: string) => t.db.select().from(reviews).where(eq(reviews.customerId, customerId));

describe("a review of a delivered order line (account/reviews.server)", () => {
  test("only the buyer reviews a line of their delivered order: saved pending, verified, and counted nowhere until staff approve it", async () => {
    const me = await buyer();
    const stranger = await buyer();
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [{ ...product, qty: 1 }]);
    const [line] = order.itemIds;

    // someone else posting the buyer's line learns nothing (the same answer as a line that does not exist)
    expect(await failureOf(submitLineReview(t.db, stranger, { orderItemId: line, rating: "5" }, ar))).toMatchObject({ code: "review_line_unknown", status: 404 });
    expect(await reviewRows(stranger.id)).toEqual([]);

    // the text is cleaned like every shopper's text (a right-to-left override cannot disguise it where staff read it)
    const saved = await submitLineReview(t.db, me, { orderItemId: line, rating: "4", body: "  جهاز ممتاز، ‮وصل‬ سليماً  " }, ar);
    expect(saved).toEqual({ id: expect.stringMatching(/^rev_/), status: "pending", verified: true });
    const [row] = await reviewRows(me.id);
    expect(row).toMatchObject({ id: saved.id, productId: product.productId, orderItemId: line, rating: 4, title: null, body: "جهاز ممتاز، وصل سليماً", status: "pending", isVerifiedPurchase: true, createdAt: NOW, locale: "ar", moderatedBy: null });

    // pending: the store counts nothing and lists nothing
    expect(await getReviewSummary(t.db, product.productId)).toMatchObject({ count: 0, average: null });
    expect(await listVerifiedReviews(t.db, product.productId)).toEqual([]);
    // the buyer sees their own review on the order, waiting
    expect(await listOrderReviewSlots(t.db, me.id, order.ref)).toEqual([
      { orderItemId: line, productId: product.productId, review: { id: saved.id, rating: 4, body: "جهاز ممتاز، وصل سليماً", status: "pending", verified: true, createdAt: NOW, rejectCode: null, here: true } },
    ]);
    // nobody else does
    expect(await listOrderReviewSlots(t.db, stranger.id, order.ref)).toEqual([]);

    // audited with the rating, never the text
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, saved.id), eq(auditEvents.action, "customers.review.submit"))).get();
    expect(audit).toMatchObject({ actorKind: "customer", actorId: me.id });
    expect(JSON.stringify(audit)).not.toContain("ممتاز");

    // staff approve it in the review hub: now the store counts it — and never says who wrote it
    await moderateReview(t.db, STAFF, { reviewId: saved.id, decision: "approve", expectedStatus: "pending" }, NOW + DAY);
    expect(await getReviewSummary(t.db, product.productId)).toMatchObject({ count: 1, average: 4 });
    const shown = await listVerifiedReviews(t.db, product.productId);
    expect(shown).toEqual([expect.objectContaining({ id: saved.id, rating: 4, body: "جهاز ممتاز، وصل سليماً" })]);
    expect(JSON.stringify(shown)).not.toContain(me.id);
    expect((await listOrderReviewSlots(t.db, me.id, order.ref))[0].review).toMatchObject({ status: "approved" });
  });

  test("only delivered lines: an order on its way, cancelled or returned cannot be reviewed — and has no slots", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 9 });
    for (const status of ["new", "confirmed", "shipped", "cancelled", "returned"] as const) {
      const order = await make.order([{ ...product, qty: 1 }], { customerId: me.id, status, placedAt: NOW - DAY });
      expect(await failureOf(submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 5 }, ar)), status).toMatchObject({ code: "review_not_delivered", status: 409 });
      expect(await listOrderReviewSlots(t.db, me.id, order.ref), status).toEqual([]);
    }
    expect(await reviewRows(me.id)).toEqual([]);
  });

  test("once per line — and once per product: a second send, or the same product from another order, is refused and shows the first review", async () => {
    const me = await buyer();
    const pad = await make.product({ stock: 9 });
    const cable = await make.product({ stock: 9 });
    const first = await delivered(me.id, [
      { ...pad, qty: 1 },
      { ...cable, qty: 2 },
    ]);
    const second = await delivered(me.id, [{ ...pad, qty: 1 }], { placedAt: NOW - DAY });
    const [padLine, cableLine] = first.itemIds;

    const saved = await submitLineReview(t.db, me, { orderItemId: padLine, rating: 2, body: "وصلت يد التحكم وفيها خدش." }, ar);
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: padLine, rating: 5 }, ar))).toMatchObject({ code: "review_exists", status: 409 });
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: second.itemIds[0], rating: 5 }, ar))).toMatchObject({ code: "review_exists", status: 409 });
    expect((await reviewRows(me.id)).map((row) => [row.productId, row.rating])).toEqual([[pad.productId, 2]]);

    // the first order: the pad's review (written here) and the cable still open
    expect(await listOrderReviewSlots(t.db, me.id, first.ref)).toEqual([
      { orderItemId: padLine, productId: pad.productId, review: expect.objectContaining({ id: saved.id, rating: 2, here: true }) },
      { orderItemId: cableLine, productId: cable.productId, review: null },
    ]);
    // the second order shows the same review, written from the earlier order
    expect(await listOrderReviewSlots(t.db, me.id, second.ref)).toEqual([{ orderItemId: second.itemIds[0], productId: pad.productId, review: expect.objectContaining({ id: saved.id, here: false }) }]);

    // two lines of one product in one order (two options of a pad) are one slot
    const both = await delivered(me.id, [
      { ...cable, qty: 1 },
      { ...cable, qty: 1 },
    ]);
    expect(await listOrderReviewSlots(t.db, me.id, both.ref)).toEqual([{ orderItemId: both.itemIds[0], productId: cable.productId, review: null }]);
    await submitLineReview(t.db, me, { orderItemId: both.itemIds[1], rating: 5 }, ar);
    // the line that holds the review stands for its product
    expect(await listOrderReviewSlots(t.db, me.id, both.ref)).toEqual([{ orderItemId: both.itemIds[1], productId: cable.productId, review: expect.objectContaining({ rating: 5, here: true }) }]);
  });

  test("a double send at the same moment (two tabs, a double tap) saves one review; the other is told it exists", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [
      { ...product, qty: 1 },
      { ...product, qty: 1 },
    ]);
    const results = await Promise.allSettled([
      submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 5 }, ar),
      submitLineReview(t.db, me, { orderItemId: order.itemIds[1], rating: 1 }, ar),
      submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 3 }, ar),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(toAppError(result.reason)).toMatchObject({ code: "review_exists", status: 409 });
    expect(await reviewRows(me.id)).toHaveLength(1);
  });

  test("a delivered order that is returned before the send cannot be reviewed any more", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const order = await make.order([{ ...product, qty: 1 }], { customerId: me.id, status: "returned", placedAt: NOW - 9 * DAY, deliveredAt: NOW - 8 * DAY });
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 1 }, ar))).toMatchObject({ code: "review_not_delivered", status: 409 });
    expect(await reviewRows(me.id)).toEqual([]);
  });

  test("a demo order is no real purchase: its review reaches the staff queue, but staff cannot approve it and the store never counts it", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5, isDemo: true });
    const order = await delivered(me.id, [{ ...product, qty: 1 }], { isDemo: true });
    const saved = await submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 5, body: "رائع" }, ar);
    expect(saved).toMatchObject({ status: "pending", verified: false });
    expect((await reviewRows(me.id))[0]).toMatchObject({ status: "pending", isVerifiedPurchase: false });
    expect(await failureOf(moderateReview(t.db, STAFF, { reviewId: saved.id, decision: "approve", expectedStatus: "pending" }, NOW))).toMatchObject({ code: "review_not_verified" });
    expect(await getReviewSummary(t.db, product.productId)).toMatchObject({ count: 0 });
    expect((await listOrderReviewSlots(t.db, me.id, order.ref))[0].review).toMatchObject({ status: "pending", verified: false });
    // staff can still turn it down; the buyer reads the reason's words, never the staff's note
    await moderateReview(t.db, STAFF, { reviewId: saved.id, decision: "reject", expectedStatus: "pending", code: "spam", note: "internal: a test order" }, NOW);
    const review = (await listOrderReviewSlots(t.db, me.id, order.ref))[0].review;
    expect(review).toMatchObject({ status: "rejected", rejectCode: "spam" });
    expect(JSON.stringify(review)).not.toContain("internal");
  });

  test("a used unit's line is not a product review: refused, and left out of the slots", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const unitId = newId("uu");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used-unit"), variantId: product.variantId, grade: "A", priceIqd: 300_000, status: "sold", soldAt: NOW - 3 * DAY });
    const accessory = await make.product({ stock: 5 });
    const order = await delivered(me.id, [
      { ...product, qty: 1, usedUnitId: unitId },
      { ...accessory, qty: 1 },
    ]);
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 5 }, ar))).toMatchObject({ code: "review_used_unit", status: 409 });
    expect(await listOrderReviewSlots(t.db, me.id, order.ref)).toEqual([{ orderItemId: order.itemIds[1], productId: accessory.productId, review: null }]);
  });

  test("the fields: a rating from one to five stars, an optional text of 3 to 500 characters", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [{ ...product, qty: 1 }]);
    const line = order.itemIds[0];
    for (const rating of [undefined, "", "0", "6", "4.5", "x", 7]) {
      expect(await failureOf(submitLineReview(t.db, me, { orderItemId: line, rating }, ar)), String(rating)).toMatchObject({ code: "invalid", fields: { rating: "review_rating_required" } });
    }
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: line, rating: 3, body: "ok" }, ar))).toMatchObject({ code: "invalid", fields: { body: "review_too_short" } });
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: line, rating: 3, body: "ا".repeat(501) }, ar))).toMatchObject({ code: "invalid", fields: { body: "review_too_long" } });
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: "not a line!", rating: 3 }, ar))).toMatchObject({ code: "review_line_unknown", status: 404 });
    expect(await failureOf(submitLineReview(t.db, me, { rating: 3 }, ar))).toMatchObject({ code: "review_line_unknown" });
    // a blank text is no text; Arabic-Indic digits are a rating
    await submitLineReview(t.db, me, { orderItemId: line, rating: "٥", body: "   " }, ar);
    expect((await reviewRows(me.id))[0]).toMatchObject({ rating: 5, body: null });
    // three characters are a text
    const other = await delivered(me.id, [{ ...(await make.product({ stock: 5 })), qty: 1 }]);
    await submitLineReview(t.db, me, { orderItemId: other.itemIds[0], rating: 3, body: "جيد" }, ar);
    expect((await reviewRows(me.id)).map((row) => row.body).sort()).toEqual(["جيد", null].sort());
  });

  test("a blocked account cannot review", async () => {
    const me = await buyer({ status: "blocked" });
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [{ ...product, qty: 1 }]);
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 5 }, ar))).toMatchObject({ code: "customer_unavailable", status: 409 });
  });

  test("sends are counted per customer and per network address — refused ones too", async () => {
    const me = await buyer();
    for (let i = 0; i < REVIEW_WRITES.limit; i++) {
      expect((await failureOf(submitLineReview(t.db, me, { orderItemId: `oit_probe_${i}`, rating: 5 }, ar))).code).toBe("review_line_unknown");
    }
    expect(await failureOf(submitLineReview(t.db, me, { orderItemId: "oit_probe_last", rating: 5 }, ar))).toMatchObject({ code: "rate_limited", status: 429 });
    // another account from the same address is held too
    const neighbour: CustomerActor = { kind: "customer", id: await make.customer(), ip: me.ip };
    expect(await failureOf(submitLineReview(t.db, neighbour, { orderItemId: "oit_probe_other", rating: 5 }, ar))).toMatchObject({ code: "rate_limited" });
    // a new hour, a new budget
    expect((await failureOf(submitLineReview(t.db, me, { orderItemId: "oit_probe_later", rating: 5 }, { ...ar, now: NOW + 2 * 60 * 60 * 1000 }))).code).toBe("review_line_unknown");
  });

  test("the review's language is the page's, unless the text plainly says otherwise; the buyer reads the reason's code, never the note", () => {
    expect(reviewLocale("ar", null)).toBe("ar");
    expect(reviewLocale("en", "جهاز ممتاز")).toBe("ar");
    expect(reviewLocale("ckb", "Great pad")).toBe("en");
    expect(reviewLocale("ckb", "باشە")).toBe("ckb");
    expect(reviewLocale("ar", "PS5 ممتاز")).toBe("ar");
    expect(ownRejectCode("personal_data:رقم هاتف في النص")).toBe("personal_data");
    expect(ownRejectCode("spam")).toBe("spam");
    expect(ownRejectCode("other:أي شيء")).toBeNull();
    expect(ownRejectCode("free text from an old row")).toBeNull();
    expect(ownRejectCode(null)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── the order page

function renderOrder(order: OrderView, reviewSlots: ReviewSlot[], locale: Locale = "ar", actionData?: unknown): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "account/orders/:ref", Component: OrderPage as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [`/account/orders/${order.ref}`],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") },
          page: { order, reviews: reviewSlots, now: NOW, i18n: messagesFor(locale, "account", "checkout", "errors") },
        },
        ...(actionData ? { actionData: { page: actionData as never } } : {}),
      },
    }),
  );
}

const SITE = "http://localhost:5173";

/** The order page's action the way React Router runs it: the root middleware (context, the same-site check, cookies) first. */
async function postOrderAction(ref: string, form: Record<string, string>, cookies: Record<string, string>, ip: string) {
  const request = new Request(`${SITE}/account/orders/${ref}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: SITE, "CF-Connecting-IP": ip, Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
    body: new URLSearchParams(form),
  });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let value: unknown;
  const response = (await requestContextMiddleware({ request, context, url, pattern: "/account/orders/:ref", params: { ref } } as never, async () => {
    value = await (orderAction as (args: never) => Promise<unknown>)({ request, context, params: { ref }, url, pattern: "/account/orders/:ref" } as never);
    const init = (value as { init?: { status?: number } }).init;
    return new Response(null, { status: init?.status ?? 200 });
  })) as Response;
  return { status: response.status, data: (value as { data?: unknown }).data ?? value };
}

/** A signed-up customer with a live session (the sign-up's own cookie). */
async function signedIn(phone: string): Promise<{ id: string; token: string }> {
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `rev-${phone}`,
    nonce: "n",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: NOW,
    ip: "198.18.200.1",
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "live",
    cookie: () => null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  const session = await signUpCustomer(ctx, t.db, { phone, password: "review-password-1" });
  const sid = setCookies.find((cookie) => cookie.startsWith("tt_sid="));
  return { id: session.customer.id, token: decodeURIComponent(sid!.split(";")[0].slice("tt_sid=".length)) };
}

describe("the order page's review card", () => {
  test("without script each open product is a plain post form — the line, five star radios, the text, a send key; a demo order says it is never published", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [{ ...product, qty: 1 }], { isDemo: true });
    const view = (await getOrderForCustomer(t.db, me.id, order.ref, "ar", NOW)) as OrderView;
    const slots = await listOrderReviewSlots(t.db, me.id, order.ref);
    const html = renderOrder(view, slots);
    expect(html).toContain("قيّم ما استلمته");
    const form = /<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/.exec(html.slice(html.indexOf("قيّم ما استلمته")))?.[1] ?? "";
    expect(form).toContain('name="intent" value="review"');
    expect(form).toContain(`name="orderItemId" value="${order.itemIds[0]}"`);
    expect([...form.matchAll(/<input(?=[^>]*type="radio")(?=[^>]*name="rating")[^>]*value="(\d)"/g)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "5"]);
    // each star is named for a screen reader («4 نجوم من 5»), never a bare icon
    expect(form).toContain("4 نجوم من 5");
    expect(form).toMatch(/<textarea(?=[^>]*name="body")(?=[^>]*maxLength="500")[^>]*>/);
    expect(form).toMatch(/<button[^>]*type="submit"[\s\S]*?أرسل المراجعة/);
    // honest about a demo order, and about what happens to a review
    expect(html).toContain("ولا تُنشر في المتجر لأن الطلب ليس شراءً حقيقياً");
    expect(html).toContain("لا نحجب مراجعة لأنها سلبية.");

    // sent: the state replaces the form
    await submitLineReview(t.db, me, { orderItemId: order.itemIds[0], rating: 4, body: "وصل سليماً" }, ar);
    const after = renderOrder(view, await listOrderReviewSlots(t.db, me.id, order.ref));
    expect(after).not.toMatch(/name="intent" value="review"/);
    expect(after).toContain("للتجربة، لا تُنشر");
    expect(after).toContain("وصل سليماً");
    expect(after).toMatch(/role="img" aria-label="4 نجوم من 5"/);
  });

  test("an order not delivered has no review card; a refused post without script comes back with its sentence and the stars and text it sent", async () => {
    const me = await buyer();
    const product = await make.product({ stock: 5 });
    const open = await make.order([{ ...product, qty: 1 }], { customerId: me.id, status: "shipped", placedAt: NOW });
    const openView = (await getOrderForCustomer(t.db, me.id, open.ref, "ar", NOW)) as OrderView;
    expect(renderOrder(openView, [])).not.toContain("قيّم ما استلمته");

    const order = await delivered(me.id, [{ ...product, qty: 1 }]);
    const view = (await getOrderForCustomer(t.db, me.id, order.ref, "en", NOW)) as OrderView;
    const slots = await listOrderReviewSlots(t.db, me.id, order.ref);
    const answer = { ok: false, code: "invalid", message: "Some details are not valid.", fields: { body: "Write 500 characters at most." }, intent: "review", orderItemId: order.itemIds[0], rating: "3", body: "too long a text" };
    const html = renderOrder(view, slots, "en", answer);
    expect(html).toContain("Write 500 characters at most.");
    expect(html).toMatch(/<input(?=[^>]*name="rating")(?=[^>]*value="3")(?=[^>]*checked)[^>]*>/);
    expect(html).not.toMatch(/<input(?=[^>]*name="rating")(?=[^>]*value="4")(?=[^>]*checked)[^>]*>/);
    expect(html).toMatch(/<textarea[^>]*name="body"[^>]*>too long a text<\/textarea>/);

    // review round: a refusal with NO star chosen still shows the text it refused (its error link must lead somewhere) —
    // the form says it was refused, so the CSS that holds the text back until a star is chosen lets it show
    const noStar = { ok: false, code: "invalid", message: "Some details are not valid.", fields: { rating: "Choose 1 to 5 stars.", body: "Write 3 characters at least." }, intent: "review", orderItemId: order.itemIds[0], rating: null, body: "ok" };
    const refusedHtml = renderOrder(view, slots, "en", noStar);
    expect(refusedHtml).toMatch(/<form(?=[^>]*class="acct-review__form")(?=[^>]*data-refused="true")[^>]*>/);
    // an untouched form is not marked (the text waits for the first star)
    expect(renderOrder(view, slots, "en")).not.toContain("data-refused");
  });

  test("the action: a signed-in buyer's post saves the review; a refusal answers its sentence with the line it was for", async () => {
    const me = await signedIn(make.phone().replace("+964", "0"));
    const product = await make.product({ stock: 5 });
    const order = await delivered(me.id, [{ ...product, qty: 1 }]);
    const refused = await postOrderAction(order.ref, { intent: "review", orderItemId: order.itemIds[0], rating: "9", body: "x" }, { tt_sid: me.token }, "203.0.113.71");
    expect(refused.status).toBe(400);
    expect(refused.data).toMatchObject({ ok: false, code: "invalid", intent: "review", orderItemId: order.itemIds[0], rating: "9", body: "x", fields: { rating: "اختر من نجمة واحدة إلى خمس نجوم." } });

    const sent = await postOrderAction(order.ref, { intent: "review", orderItemId: order.itemIds[0], rating: "5", body: "سريع ومرتب" }, { tt_sid: me.token }, "203.0.113.71");
    expect(sent).toMatchObject({ status: 200, data: { ok: true, intent: "review", orderItemId: order.itemIds[0], verified: true } });
    expect(await t.db.select({ rating: reviews.rating, body: reviews.body, status: reviews.status }).from(reviews).where(eq(reviews.customerId, me.id))).toEqual([{ rating: 5, body: "سريع ومرتب", status: "pending" }]);

    // a line of another of the buyer's orders is not this page's line
    const other = await delivered(me.id, [{ ...(await make.product({ stock: 5 })), qty: 1 }]);
    const elsewhere = await postOrderAction(order.ref, { intent: "review", orderItemId: other.itemIds[0], rating: "5" }, { tt_sid: me.token }, "203.0.113.71");
    expect(elsewhere).toMatchObject({ status: 404, data: { ok: false, code: "review_line_unknown" } });
    expect(await t.db.select().from(customers).where(eq(customers.id, me.id))).toHaveLength(1);
  });
});
