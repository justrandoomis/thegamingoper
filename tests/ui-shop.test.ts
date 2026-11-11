/**
 * Commerce components — the pure logic behind them (docs/ui/commerce.md). No DOM, no network, no database:
 * the cart count model, request coalescing, reading /api/cart answers, the totals check of the order summary, the
 * proof uploader's state machine, and the small rules of the badges. The components themselves are verified on
 * /design-system (#commerce) with scripts/shot.mjs.
 *
 *   npm test -- tests/ui-shop.test.ts
 */
import { describe, expect, it } from "vitest";

import messages from "~/i18n/messages/ui-shop";
import { lookup, type MessageTree } from "~/i18n/translate";
import type { CartView, ImageRef } from "~/lib/dto";
import { WALLET_ENTRY_KINDS } from "~/server/db/schema/commerce";
import {
  ADD_WINDOW_MS,
  CART_ERROR_CODES,
  cartErrorKey,
  createCoalescer,
  displayCount,
  INITIAL_COUNT,
  isCartView,
  itemKey,
  MAX_ADD_QTY,
  mediaUrl,
  readCartAnswer,
  readFailure,
  reduceCount,
  toastThumb,
  type CountEvent,
  type CountState,
  type Scheduler,
} from "~/ui/cart-client";
import { lineProblemLook } from "~/ui/CartLineRow";
import { arrowStep, stepIndex, swipeStep } from "~/ui/Gallery";
import { gradeKey, GRADES } from "~/ui/GradeBadge";
import { batteryPct, realPhotos } from "~/ui/InspectionCard";
import { totalsReconcile } from "~/ui/OrderSummary";
import { isIqd } from "~/ui/PriceTag";
import { checkProofFile, PROOF_IDLE, PROOF_MAX_BYTES, proofFailure, proofReducer, type ProofState } from "~/ui/ProofUploader";
import { isRealRating, starFills } from "~/ui/RatingStars";
import { signedAmount, walletAfter } from "~/ui/WalletBalance";

const run = (events: CountEvent[], from: CountState = INITIAL_COUNT) => events.reduce(reduceCount, from);

const cart = (count: number, extra: Partial<CartView> = {}): CartView => ({
  id: "crt_1",
  lines: [],
  count,
  subtotalIqd: 0,
  discountIqd: 0,
  coupon: null,
  shippingIqd: null,
  totalIqd: 0,
  blocked: false,
  ...extra,
});

/** A scheduler driven by the test: `tick(ms)` runs what is due. */
function manualScheduler() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const scheduler: Scheduler = {
    set: (callback, ms) => {
      const id = ++seq;
      due.set(id, { at: now + ms, run: callback });
      return id;
    },
    clear: (handle) => {
      due.delete(handle as number);
    },
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, job] of [...due].sort((a, b) => a[1].at - b[1].at)) {
      if (job.at <= now && due.has(id)) {
        due.delete(id);
        job.run();
      }
    }
  };
  return { scheduler, tick, pending: () => due.size };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cart count — what the badge shows", () => {
  it("starts from the root loader's count, adds changes in flight at once, and settles on the server's number", () => {
    expect(displayCount(INITIAL_COUNT, 2)).toBe(2);
    const tapped = run([{ type: "root", count: 2 }, { type: "optimistic", delta: 1 }]);
    expect(displayCount(tapped, 2)).toBe(3);
    const settled = reduceCount(tapped, { type: "settled", delta: 1, count: 3 });
    expect(settled.pending).toBe(0);
    expect(displayCount(settled, 2)).toBe(3);
  });

  it("rolls back exactly the failed part and never shows less than zero", () => {
    const state = run([{ type: "root", count: 1 }, { type: "optimistic", delta: 2 }, { type: "optimistic", delta: 1 }, { type: "failed", delta: 2 }]);
    expect(displayCount(state, 1)).toBe(2);
    expect(displayCount(run([{ type: "optimistic", delta: -5 }]), 1)).toBe(0);
  });

  it("keeps changes still in flight on top of a newer server answer", () => {
    // Two items tapped; the first answer arrives (count 4 includes it), the second is still out.
    const state = run([{ type: "root", count: 2 }, { type: "optimistic", delta: 1 }, { type: "optimistic", delta: 1 }, { type: "settled", delta: 1, count: 3 }]);
    expect(displayCount(state, 2)).toBe(4);
  });

  it("takes a fresh root read even when it repeats an earlier number (an emptied cart after checkout)", () => {
    const state = run([{ type: "root", count: 0 }, { type: "optimistic", delta: 3 }, { type: "settled", delta: 3, count: 3 }, { type: "root", count: 0 }]);
    expect(displayCount(state, 0)).toBe(0);
  });

  it("ignores malformed numbers and counts landings for the badge squish", () => {
    const state = run([{ type: "root", count: Number.NaN }, { type: "optimistic", delta: 0.5 }, { type: "settled", delta: Number.NaN, count: -1 }, { type: "received" }, { type: "received" }]);
    expect(state.confirmed).toBeNull();
    expect(state.pending).toBe(0);
    expect(state.bump).toBe(2);
  });
});

describe("cart requests — taps on one item within 250 ms are one request", () => {
  it("coalesces rapid taps into one send with the summed quantity, and every tap gets its result", async () => {
    const { scheduler, tick } = manualScheduler();
    const sent: { key: string; qty: number }[] = [];
    const adds = createCoalescer<{ name: string }, string>({
      windowMs: ADD_WINDOW_MS,
      maxQty: MAX_ADD_QTY,
      scheduler,
      send: async (key, qty) => {
        sent.push({ key, qty });
        return `${key}×${qty}`;
      },
      fallback: () => "failed",
    });
    const taps = [adds.push("v:a", 1, { name: "A" }), adds.push("v:a", 1, { name: "A" }), adds.push("v:b", 1, { name: "B" })];
    tick(100);
    taps.push(adds.push("v:a", 2, { name: "A" }));
    expect(adds.queued("v:a")).toBe(4);
    expect(sent).toEqual([]);
    tick(ADD_WINDOW_MS);
    expect(await Promise.all(taps)).toEqual(["v:a×4", "v:a×4", "v:b×1", "v:a×4"]);
    expect(sent).toEqual([
      { key: "v:a", qty: 4 },
      { key: "v:b", qty: 1 },
    ]);
  });

  it("sends at once when a batch reaches the per-line maximum, and opens a new window after it", async () => {
    const { scheduler, tick } = manualScheduler();
    const sent: number[] = [];
    const adds = createCoalescer<null, number>({ windowMs: 250, maxQty: 10, scheduler, send: async (_key, qty) => (sent.push(qty), qty), fallback: () => -1 });
    const first = adds.push("v:a", 7, null);
    const second = adds.push("v:a", 3, null);
    expect(sent).toEqual([10]);
    const third = adds.push("v:a", 1, null);
    tick(250);
    expect(await Promise.all([first, second, third])).toEqual([10, 10, 1]);
  });

  it("turns a rejected or throwing send into the fallback result instead of a rejection", async () => {
    const { scheduler, tick } = manualScheduler();
    const rejected = createCoalescer<null, string>({ windowMs: 250, maxQty: 10, scheduler, send: () => Promise.reject(new Error("offline")), fallback: (_e, qty) => `fallback ${qty}` });
    const throwing = createCoalescer<null, string>({
      windowMs: 250,
      maxQty: 10,
      scheduler,
      send: () => {
        throw new Error("boom");
      },
      fallback: (_e, qty) => `fallback ${qty}`,
    });
    const a = rejected.push("k", 2, null);
    const b = throwing.push("k", 1, null);
    tick(250);
    await flush();
    expect(await a).toBe("fallback 2");
    expect(await b).toBe("fallback 1");
  });

  it("keys variants and used units apart", () => {
    expect(itemKey({ variantId: "var_x" })).toBe("v:var_x");
    expect(itemKey({ usedUnitId: "usd_y" })).toBe("u:usd_y");
  });
});

describe("reading /api/cart answers", () => {
  it("accepts a success only with a real CartView, and keeps `added`", () => {
    expect(readCartAnswer(200, { ok: true, cart: cart(3), added: 2 })).toEqual({ ok: true, cart: cart(3), added: 2, status: 200 });
    expect(readCartAnswer(200, { ok: true, cart: { lines: [] } })).toMatchObject({ ok: false, code: "invalid" });
    expect(isCartView(cart(1, { totalIqd: Number.NaN }))).toBe(false);
  });

  it("names every failure: business codes, rate limits, a missing endpoint, no connection", () => {
    expect(readCartAnswer(409, { ok: false, code: "out_of_stock" })).toMatchObject({ ok: false, code: "out_of_stock", status: 409 });
    expect(readCartAnswer(429, { ok: false, code: "rate_limited", retryAfterSec: 12.2 })).toMatchObject({ code: "rate_limited", retryAfterSec: 13 });
    expect(readCartAnswer(429, undefined)).toMatchObject({ code: "rate_limited" });
    expect(readCartAnswer(405, undefined)).toMatchObject({ code: "endpoint_missing" });
    expect(readCartAnswer(404, undefined)).toMatchObject({ code: "endpoint_missing" });
    expect(readCartAnswer(500, undefined)).toMatchObject({ code: "generic" });
    expect(readFailure(0, null)).toMatchObject({ code: "network" });
    expect(readCartAnswer(400, { ok: false, code: "invalid", fields: { qty: "too_big" } })).toMatchObject({ code: "invalid", fields: { qty: "too_big" } });
  });

  it("maps codes to sentences that exist in all three languages", () => {
    for (const code of CART_ERROR_CODES) expect(cartErrorKey(code)).toBe(`errors.${code}`);
    expect(cartErrorKey("coupon_expired")).toBe("errors.coupon");
    expect(cartErrorKey("something_new")).toBe("errors.generic");
    for (const locale of ["ar", "en", "ckb"] as const) {
      const tree = messages[locale] as unknown as MessageTree;
      for (const code of [...CART_ERROR_CODES, "coupon_expired", "unknown"]) expect(typeof lookup(tree, cartErrorKey(code)), `${locale} ${code}`).toBe("string");
    }
  });
});

describe("toast thumbnails", () => {
  const ref = (over: Partial<ImageRef>): ImageRef => ({ artKey: null, mediaKey: null, alt: "", isIllustration: false, ...over });
  it("uses the art key for catalogue pictures and /media for uploads", () => {
    expect(toastThumb(ref({ artKey: "nintendo-switch-2--1" }))).toEqual({ art: "nintendo-switch-2--1" });
    expect(toastThumb(ref({ mediaKey: "pub_a b.webp", width: 800, height: 600 }))).toEqual({ image: { src: "/media/pub_a%20b.webp", width: 800, height: 600 } });
    expect(toastThumb(ref({}))).toEqual({});
    expect(toastThumb(null)).toEqual({});
    expect(mediaUrl("pub_x/../y")).toBe("/media/pub_x%2F..%2Fy");
  });
});

describe("order summary — figures must reconcile", () => {
  it("accepts total = subtotal − discount + delivery in whole dinars", () => {
    expect(totalsReconcile({ subtotalIqd: 1_205_000, discountIqd: 50_000, shippingIqd: 5_000, totalIqd: 1_160_000 })).toBe(true);
    expect(totalsReconcile({ subtotalIqd: 675_000, discountIqd: 0, shippingIqd: null, totalIqd: 675_000 })).toBe(true);
  });
  it("refuses NaN, fractions, negatives, a discount above the subtotal and a total that does not add up", () => {
    expect(totalsReconcile({ subtotalIqd: 675_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: Number.NaN })).toBe(false);
    expect(totalsReconcile({ subtotalIqd: 675_000.5, discountIqd: 0, shippingIqd: 5_000, totalIqd: 680_000.5 })).toBe(false);
    expect(totalsReconcile({ subtotalIqd: 675_000, discountIqd: -1, shippingIqd: 5_000, totalIqd: 680_001 })).toBe(false);
    expect(totalsReconcile({ subtotalIqd: 10_000, discountIqd: 20_000, shippingIqd: 5_000, totalIqd: 0 })).toBe(false);
    expect(totalsReconcile({ subtotalIqd: 675_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: 675_000 })).toBe(false);
    expect(totalsReconcile({ subtotalIqd: 675_000, discountIqd: 0, shippingIqd: Number.POSITIVE_INFINITY, totalIqd: 675_000 })).toBe(false);
  });
  it("treats only whole, non-negative dinars as money", () => {
    expect([0, 5_000, Number.MAX_SAFE_INTEGER].every(isIqd)).toBe(true);
    expect([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "5000", null].some(isIqd)).toBe(false);
  });
});

describe("proof uploader", () => {
  const file = { name: "receipt.jpg", size: 1_200_000, type: "image/jpeg" };

  it("checks type and size before anything is sent (the server's limits: JPEG, PNG, WebP up to 8 MB)", () => {
    expect(checkProofFile(file)).toBeNull();
    expect(checkProofFile({ name: "shot.PNG", size: 10, type: "" })).toBeNull(); // no declared type: the extension stands in
    expect(checkProofFile({ name: "photo.jpg", size: 10, type: "image/jpg" })).toBeNull();
    expect(checkProofFile({ name: "photo.heic", size: 10, type: "image/heic" })).toBe("type");
    expect(checkProofFile({ name: "statement.pdf", size: 10, type: "application/pdf" })).toBe("type");
    expect(checkProofFile({ ...file, size: 0 })).toBe("empty");
    expect(checkProofFile({ ...file, size: PROOF_MAX_BYTES + 1 })).toBe("size");
    expect(checkProofFile({ ...file, size: PROOF_MAX_BYTES })).toBeNull();
    expect(checkProofFile({ ...file, size: 600_000 }, { maxBytes: 500_000 })).toBe("size");
  });

  it("calls a dropped connection after some bytes 'interrupted', and says when retrying cannot help", () => {
    expect(proofFailure("network", 0.6)).toEqual({ phase: "interrupted" });
    expect(proofFailure("timeout", 0.2)).toEqual({ phase: "interrupted" });
    expect(proofFailure("network", 0)).toEqual({ phase: "failed", problem: "network", retry: true });
    expect(proofFailure("upload_too_large", 0.9)).toEqual({ phase: "failed", problem: "size", retry: false });
    expect(proofFailure("upload_type", 0)).toEqual({ phase: "failed", problem: "type", retry: false });
    expect(proofFailure("upload_corrupt", 0)).toEqual({ phase: "failed", problem: "corrupt", retry: false });
    expect(proofFailure("upload_dimensions", 0)).toEqual({ phase: "failed", problem: "dimensions", retry: false });
    expect(proofFailure("rate_limited", 0)).toEqual({ phase: "failed", problem: "rate_limited", retry: true });
    expect(proofFailure("whatever", 0.4)).toEqual({ phase: "failed", problem: "server", retry: true });
  });

  it("moves through its states: start → progress → done, interrupted, failed, cancelled, rejected", () => {
    const step = (state: ProofState, ...actions: Parameters<typeof proofReducer>[1][]) => actions.reduce(proofReducer, state);
    const uploading = step(PROOF_IDLE, { type: "start", file }, { type: "progress", fraction: 0.6 });
    expect(uploading).toEqual({ phase: "uploading", file, progress: 0.6 });
    expect(step(uploading, { type: "done", previewUrl: "/x.webp" })).toEqual({ phase: "uploaded", file, previewUrl: "/x.webp" });
    expect(step(uploading, { type: "fail", code: "network" })).toEqual({ phase: "interrupted", file, progress: 0.6 });
    expect(step(uploading, { type: "fail", code: "upload_type" })).toEqual({ phase: "failed", file, problem: "type", retry: false });
    expect(step(uploading, { type: "cancel" })).toEqual({ ...PROOF_IDLE, cancelled: true });
    expect(step(PROOF_IDLE, { type: "rejected", file, problem: "size" })).toEqual({ phase: "idle", problem: "size", file, cancelled: false });
    // A restart is honest: progress starts again from 0; progress is clamped to 0–1.
    expect(step(step(uploading, { type: "fail", code: "network" }), { type: "start", file })).toEqual({ phase: "uploading", file, progress: 0 });
    expect(step(uploading, { type: "progress", fraction: 7 })).toMatchObject({ progress: 1 });
    expect(step(uploading, { type: "progress", fraction: Number.NaN })).toMatchObject({ progress: 0 });
    // Late events from a finished upload change nothing.
    const done = step(uploading, { type: "done", previewUrl: null });
    expect(step(done, { type: "progress", fraction: 0.1 }, { type: "fail", code: "network" }, { type: "cancel" })).toBe(done);
  });

  it("has a sentence for every problem in every language", () => {
    const keys = ["proof.errors.empty", "proof.errors.type", "proof.errors.size", "proof.errors.corrupt", "proof.errors.dimensions", "proof.errors.network", "proof.errors.server", "errors.rate_limited"];
    for (const locale of ["ar", "en", "ckb"] as const) for (const key of keys) expect(typeof lookup(messages[locale] as unknown as MessageTree, key), `${locale} ${key}`).toBe("string");
  });

  it("never promises HEIC, which the server refuses", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const tree = messages[locale] as unknown as MessageTree;
      expect(String(lookup(tree, "proof.limits"))).not.toMatch(/HEIC/i);
      expect(String(lookup(tree, "proof.errors.type"))).not.toMatch(/HEIC/i);
    }
  });
});

describe("wallet", () => {
  it("signs ledger amounts: money in +, money spent − (red-ink in the UI)", () => {
    expect(signedAmount(250_000)).toEqual({ sign: "+", magnitude: 250_000, debit: false });
    expect(signedAmount(-675_000)).toEqual({ sign: "−", magnitude: 675_000, debit: true });
    expect(signedAmount(0)).toEqual({ sign: "", magnitude: 0, debit: false });
    expect(signedAmount(Number.NaN)).toBeNull();
    expect(signedAmount(1.5)).toBeNull();
  });
  it("says what remains after paying, or how much is missing", () => {
    expect(walletAfter(180_000, 110_000)).toEqual({ enough: true, remainsIqd: 70_000 });
    expect(walletAfter(180_000, 180_000)).toEqual({ enough: true, remainsIqd: 0 });
    expect(walletAfter(180_000, 675_000)).toEqual({ enough: false, shortIqd: 495_000 });
    expect(walletAfter(Number.NaN, 1)).toBeNull();
  });
  it("names every ledger kind the database can hold", () => {
    for (const locale of ["ar", "en", "ckb"] as const) for (const kind of WALLET_ENTRY_KINDS) expect(typeof lookup(messages[locale] as unknown as MessageTree, `wallet.kinds.${kind}`), `${locale} ${kind}`).toBe("string");
  });
});

describe("badges and small rules", () => {
  it("fills stars from the average, and shows a rating only when real reviews exist", () => {
    expect(starFills(4.6).map((n) => Math.round(n * 10) / 10)).toEqual([1, 1, 1, 1, 0.6]);
    expect(starFills(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFills(9)).toEqual([1, 1, 1, 1, 1]);
    expect(starFills(Number.NaN)).toEqual([0, 0, 0, 0, 0]);
    expect(isRealRating({ average: 4.6, count: 12 })).toBe(true);
    expect(isRealRating(null)).toBe(false);
    expect(isRealRating({ average: 4.6, count: 0 })).toBe(false);
    expect(isRealRating({ average: 5.4, count: 3 })).toBe(false);
    expect(isRealRating({ average: Number.NaN, count: 3 })).toBe(false);
  });

  it("reads grades into message keys, and an unknown grade as the lowest — never a better one", () => {
    expect(GRADES.map(gradeKey)).toEqual(["aplus", "a", "b", "c"]);
    expect(gradeKey("S")).toBe("c");
  });

  it("measures battery health only when it is a percentage, and treats illustrations as no evidence", () => {
    expect(batteryPct(86.6)).toBe(87);
    expect([null, undefined, -1, 101, Number.NaN].map(batteryPct)).toEqual([null, null, null, null, null]);
    const real: ImageRef = { artKey: null, mediaKey: "pub_unit_1.webp", alt: "", isIllustration: false };
    const illustration: ImageRef = { artKey: "nintendo-switch-oled--1", mediaKey: null, alt: "", isIllustration: true };
    const empty: ImageRef = { artKey: null, mediaKey: null, alt: "", isIllustration: false };
    expect(realPhotos([illustration, real, empty])).toEqual([real]);
  });

  it("steps the gallery inside its bounds, with swipes and arrows that follow the reading direction", () => {
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(3, 1, 4)).toBe(3);
    expect(stepIndex(1, 1, 4)).toBe(2);
    expect(stepIndex(Number.NaN, 0, 4)).toBe(0);
    expect(stepIndex(2, 1, 0)).toBe(0);
    // Arabic: a swipe toward the right (the reading start) is "next"; English: toward the left.
    expect(swipeStep(80, 5, true)).toBe(1);
    expect(swipeStep(80, 5, false)).toBe(-1);
    expect(swipeStep(-80, 5, false)).toBe(1);
    expect(swipeStep(30, 0, true)).toBe(0); // too short
    expect(swipeStep(60, 70, true)).toBe(0); // mostly vertical: a scroll, not a swipe
    expect(arrowStep("ArrowLeft", true)).toBe(1);
    expect(arrowStep("ArrowRight", true)).toBe(-1);
    expect(arrowStep("ArrowRight", false)).toBe(1);
    expect(arrowStep("Enter", false)).toBe(0);
  });

  it("shows blocking cart-line problems as errors and the others as notices", () => {
    expect(lineProblemLook(null)).toBeNull();
    expect(lineProblemLook("out_of_stock")).toMatchObject({ blocking: true, tone: "bad" });
    expect(lineProblemLook("unavailable")).toMatchObject({ blocking: true, tone: "bad" });
    expect(lineProblemLook("qty_reduced")).toMatchObject({ blocking: false, tone: "warn" });
    expect(lineProblemLook("price_changed")).toMatchObject({ blocking: false, tone: "info" });
  });
});
