/**
 * The shoppers' private-file route — GET /api/files/:fileId (owner: server core; docs/SECURITY.md §9, CONTRACTS §1).
 *
 * A stored transfer proof is shown back to the shopper of its order (the confirmation link's token, or the signed-in
 * owner), a wallet top-up proof to the customer who uploaded it — and to nobody else, with one 404 for every refusal.
 * The upload endpoint answers with that URL (`previewUrl`), so the picture still opens after a reload. Everything runs
 * through the real root middleware and the real route modules against a real local D1 + KV, on the wall clock (the
 * middleware stamps requests with it), so orders are placed "now".
 */
import { eq } from "drizzle-orm";
import { crc32 } from "node:zlib";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { loader as filesLoader } from "~/routes/api/files";
import { action as uploadAction } from "~/routes/api/upload-proof";
import type { Actor } from "~/server/actor";
import { CUSTOMER_COOKIE, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { files, paymentProofs, payments } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { saveTopupProof } from "~/server/services/account/topups.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { getPaymentProofFileForShopper, latestProofFileId, verifyPayment } from "~/server/services/payments/payments.server";
import { deleteFile, kvBlobStore, putFile, shopperFilePath } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
let verifierId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  verifierId = await make.employee();
});
afterAll(async () => {
  await t?.dispose();
});

const store = () => kvBlobStore(t.kv);

// ───────────────────────────────────────────────────────────────── a real PNG, with metadata that must not survive

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array([...Buffer.from(type, "latin1"), ...data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body) >>> 0);
  return out;
}

/** A 1×1 RGB PNG with a tEXt chunk, as phones write (the upload pipeline strips it). */
function png(marker = `GPS 33.3152N 44.3661E ${randomToken(6)}`): File {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  const text = new Uint8Array([...Buffer.from("Comment\0", "latin1"), ...Buffer.from(marker, "latin1")]);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", ihdr), ...pngChunk("tEXt", text), ...pngChunk("IDAT", idat), ...pngChunk("IEND", new Uint8Array())]);
  return new File([bytes], "receipt.png", { type: "image/png" });
}

// ───────────────────────────────────────────────────────────────── requests through the root middleware

let requests = 0;
const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

type Answer = { status: number; headers: Headers; body: Uint8Array; json: unknown };

/** Runs `handler` (a loader or an action) the way React Router does: root middleware first, its headers after. */
async function viaRoot(request: Request, handler: (args: never) => Promise<unknown>, params: Record<string, string> = {}): Promise<Answer> {
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  const response = (await requestContextMiddleware({ request, context, url, pattern: url.pathname, params } as never, async () => {
    let value: unknown;
    try {
      value = await handler({ request, context, params, url, pattern: url.pathname } as never);
    } catch (thrown) {
      value = thrown;
    }
    if (value instanceof Response) return value;
    const shaped = value as { data?: unknown; init?: { status?: number; headers?: HeadersInit } };
    return new Response(JSON.stringify(shaped.data ?? value), { status: shaped.init?.status ?? 200, headers: shaped.init?.headers });
  })) as Response;
  const body = new Uint8Array(await response.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    // not JSON: an image
  }
  return { status: response.status, headers: response.headers, body, json };
}

const ip = () => `198.18.60.${++requests % 250}`;

function open(path: string, cookies: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(path, SITE);
  const fileId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const headers: Record<string, string> = { "CF-Connecting-IP": ip() };
  if (Object.keys(cookies).length) headers.Cookie = cookieHeader(cookies);
  return viaRoot(new Request(url, { headers }), filesLoader as never, { fileId });
}

function upload(fields: Record<string, string>, file: File, cookies: Record<string, string> = {}): Promise<Answer> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", file);
  const headers: Record<string, string> = { Origin: SITE, "CF-Connecting-IP": ip() };
  if (Object.keys(cookies).length) headers.Cookie = cookieHeader(cookies);
  return viaRoot(new Request(`${SITE}/api/upload/proof`, { method: "POST", headers, body: form }), uploadAction as never);
}

// ───────────────────────────────────────────────────────────────── shoppers and orders

function ctxFor(): { ctx: RequestCtx; cookies: () => Record<string, string> } {
  const set: string[] = [];
  const ctx: RequestCtx = {
    requestId: `files-${++requests}`,
    nonce: "n",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: ip(),
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: (serialized) => {
      set.push(serialized);
    },
  };
  const cookies = () => {
    const jar: Record<string, string> = {};
    for (const serialized of set) {
      const [pair] = serialized.split(";");
      const at = pair.indexOf("=");
      jar[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
    }
    return jar;
  };
  return { ctx, cookies };
}

/** A signed-up customer and the cookies of their session. */
async function customer() {
  const { ctx, cookies } = ctxFor();
  const session = await signUpCustomer(ctx, t.db, { phone: make.phone(), password: "customer-password-1" });
  return { id: session.customer.id, actor: session.actor, cookies: { [CUSTOMER_COOKIE]: cookies()[CUSTOMER_COOKIE] } };
}

/** A bank-transfer order placed now (the proof window is open), by a guest or a signed-in customer. */
async function transferOrder(customerId: string | null = null) {
  const now = Date.now();
  const product = await make.product({ priceIqd: 150_000, stock: 3 });
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: product.variantId, qty: 1 }, now);
  const total = (await getCartView(t.db, { cartToken, customerId, locale: "ar", governorateId: governorateId("baghdad") }, now)).totalIqd;
  const placed = await placeOrder(
    t.db,
    { cartToken, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "demo" },
    {
      idempotencyKey: randomToken(),
      phone: make.phone(),
      governorateId: governorateId("baghdad"),
      districtId: districtId("baghdad", "karrada"),
      areaText: "الكرادة",
      addressText: "شارع 62، دار 14، قرب الجسر",
      marketingConsent: false,
      paymentMethod: "bank_transfer",
      expectedTotalIqd: total,
    },
    now,
  );
  return placed;
}

const verifier = (): Actor => ({ kind: "employee", id: verifierId, permissions: new Set(["orders.payment.verify"]) });

// ───────────────────────────────────────────────────────────────── transfer proofs

describe("GET /api/files/:fileId — transfer proofs", () => {
  test("the upload answers with a previewUrl that opens the stored picture — private, never cached, inert — for the link's holder only", async () => {
    const order = await transferOrder();
    const sent = await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.totalIqd) }, png("GPS 33.31N 44.36E"));
    expect(sent.status).toBe(200);
    const answer = sent.json as { ok: boolean; previewUrl: string };
    expect(answer.ok).toBe(true);
    const proof = (await t.db.select({ fileId: paymentProofs.fileId }).from(paymentProofs).innerJoin(payments, eq(payments.id, paymentProofs.paymentId)).where(eq(payments.orderId, order.orderId)).get())!;
    expect(answer.previewUrl).toBe(shopperFilePath(proof.fileId, order.accessToken));
    expect(answer.previewUrl).toBe(`/api/files/${proof.fileId}?t=${order.accessToken}`);
    // The answer says nothing staff-only (no duplicate flag, no storage key).
    expect(JSON.stringify(sent.json)).not.toMatch(/duplicate|prv_/);

    const shown = await open(answer.previewUrl);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Content-Type")).toBe("image/png");
    expect(shown.headers.get("Cache-Control")).toBe("private, no-store");
    expect(shown.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(shown.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(shown.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(shown.headers.get("Content-Disposition")).toBe("inline");
    expect(shown.headers.get("X-Robots-Tag")).toContain("noindex");
    // The bytes are the stored, cleaned picture: no metadata survived.
    const record = (await t.db.select().from(files).where(eq(files.id, proof.fileId)).get())!;
    const stored = await store().get(record.storageKey);
    expect(Buffer.from(shown.body).equals(Buffer.from(stored!.bytes))).toBe(true);
    expect(Buffer.from(shown.body).includes(Buffer.from("GPS"))).toBe(false);

    // Without the token, with a wrong one, with another order's token: the same 404, no picture, no hint.
    const other = await transferOrder();
    for (const path of [`/api/files/${proof.fileId}`, shopperFilePath(proof.fileId, randomToken()), shopperFilePath(proof.fileId, other.accessToken), shopperFilePath(proof.fileId, "short")]) {
      const refused = await open(path);
      expect(refused.status, path).toBe(404);
      expect(refused.json, path).toEqual({ ok: false, code: "not_found" });
      expect(refused.headers.get("Cache-Control"), path).toBe("no-store");
    }
    // A signed-in customer who does not own the order sees nothing either.
    const stranger = await customer();
    expect((await open(`/api/files/${proof.fileId}`, stranger.cookies)).status).toBe(404);
  });

  test("the signed-in owner opens their proof without a token; the answer's URL carries none", async () => {
    const owner = await customer();
    const order = await transferOrder(owner.id);
    const sent = await upload({ ref: order.ref, declaredAmountIqd: String(order.totalIqd) }, png(), owner.cookies);
    const answer = sent.json as { ok: boolean; previewUrl: string };
    expect(answer).toMatchObject({ ok: true, previewUrl: expect.stringMatching(/^\/api\/files\/[A-Za-z0-9_.:-]+$/) });
    expect((await open(answer.previewUrl, owner.cookies)).status).toBe(200);
    // The same URL for a guest, or another customer: 404.
    expect((await open(answer.previewUrl)).status).toBe(404);
    expect((await open(answer.previewUrl, (await customer()).cookies)).status).toBe(404);
  });

  test("after a rejection and a new upload, latestProofFileId names the new picture; both stay the shopper's own", async () => {
    const order = await transferOrder();
    expect(await latestProofFileId(t.db, order.ref)).toBeNull();
    const first = (await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "1000" }, png())).json as { previewUrl: string };
    const firstId = await latestProofFileId(t.db, order.ref);
    expect(first.previewUrl).toBe(shopperFilePath(firstId!, order.accessToken));
    const payment = (await t.db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)).get())!;
    await verifyPayment(t.db, verifier(), payment.id, { approve: false, note: "المبلغ لا يطابق المستحق" }, Date.now());
    const second = (await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.totalIqd) }, png())).json as { previewUrl: string };
    const secondId = await latestProofFileId(t.db, order.ref);
    expect(secondId).not.toBe(firstId);
    expect(second.previewUrl).toBe(shopperFilePath(secondId!, order.accessToken));
    expect(await latestProofFileId(t.db, order.ref.toLowerCase())).toBe(secondId);
    expect(await latestProofFileId(t.db, "not a ref")).toBeNull();
    for (const url of [first.previewUrl, second.previewUrl]) expect((await open(url)).status).toBe(200);
  });

  test("a deleted proof, an upload that was never attached, a public file and other private kinds are the same 404", async () => {
    const order = await transferOrder();
    const sent = (await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.totalIqd) }, png())).json as { previewUrl: string };
    const proofFileId = (await latestProofFileId(t.db, order.ref))!;
    expect((await open(sent.previewUrl)).status).toBe(200);
    await deleteFile(t.db, store(), proofFileId, Date.now());
    expect((await open(sent.previewUrl)).status).toBe(404);

    // A picture stored as a proof but never attached to one (no order binds it).
    const loose = await saveImageUpload(t.db, store(), png(), { visibility: "private", kind: "payment_proof", now: Date.now() });
    expect((await open(shopperFilePath(loose.file.id, order.accessToken))).status).toBe(404);
    expect(await getPaymentProofFileForShopper(t.db, store(), loose.file.id, { accessToken: order.accessToken })).toBeNull();

    // Public files are /media's; other private kinds have their own routes and rules.
    const owner = await customer();
    const bytes = new Uint8Array(await png().arrayBuffer());
    const shared = await putFile(t.db, store(), { bytes, mime: "image/png", visibility: "public", kind: "product_image", now: Date.now() });
    const tradeIn = await putFile(t.db, store(), { bytes, mime: "image/png", visibility: "private", kind: "trade_in_photo", createdBy: owner.actor, ownerType: "customer", ownerId: owner.id, now: Date.now() });
    for (const id of [shared.id, tradeIn.id, "fil_unknown_000000", "../../etc/passwd"]) {
      expect((await open(shopperFilePath(id, order.accessToken), owner.cookies)).status, id).toBe(404);
    }
    expect(await getPaymentProofFileForShopper(t.db, store(), 42, { accessToken: order.accessToken })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── wallet top-up proofs

describe("GET /api/files/:fileId — wallet top-up proofs", () => {
  test("only the customer who uploaded it; no token opens it", async () => {
    const owner = await customer();
    const saved = await saveTopupProof(t.db, store(), owner.actor, png(), Date.now());
    const path = shopperFilePath(saved.fileId);
    const shown = await open(path, owner.cookies);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Cache-Control")).toBe("private, no-store");
    expect(shown.headers.get("Content-Type")).toBe("image/png");
    expect((await open(path)).status).toBe(404);
    expect((await open(path, (await customer()).cookies)).status).toBe(404);
    const order = await transferOrder();
    expect((await open(shopperFilePath(saved.fileId, order.accessToken))).status).toBe(404);
  });
});
