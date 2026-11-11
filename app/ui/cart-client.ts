/**
 * cart-client — the browser side of the cart, shared by every commerce component (docs/ui/commerce.md).
 *
 *   const { count, bump } = useCartCount();               the shell's cart bead: server count + changes in flight
 *   const outcome = await addToCart({ variantId, qty });   optimistic, coalesced (250 ms per item), never throws
 *   const editor = useCartEditor(loaderData.cart);         the cart page: quantities, remove with undo, restore
 *   const cart = useCartView(loaderData.cart);             any view that must follow changes made elsewhere
 *   announce(t("add.announceAdded", { name }));            the one polite live region for cart feedback
 *
 * The count (DESIGN.md §7.2 "Fly to cart", step 1): the badge changes the moment the shopper taps — base + changes
 * in flight — and settles on the server's `cart.count` when the JSON answer arrives. The base is the newest server
 * figure: an /api/cart answer, or a fresh root-loader result (recognised by identity, so a component that mounts
 * later never replays an old count, and "0 after checkout" counts even when the page started at 0). A failed change
 * rolls its part back. Rapid taps on one item are coalesced into one POST per 250 ms (at most 10 units per request,
 * the server's per-line maximum).
 *
 * Why `fetch` and not `useFetcher`: React Router 8 routes a fetcher's failures — a network error, a thrown 5xx, a
 * path whose resource route does not exist yet — to the route's ErrorBoundary (router.js `setFetcherError`), which
 * would replace the whole page because one add failed. Here every failure is a value the component rolls back and
 * explains (DESIGN.md §9.16). The trade-off: route loaders are not revalidated automatically — `useCartView` /
 * `onCartChange` carry the new CartView to whoever shows the cart, and the root's `shouldRevalidate` would skip a
 * manual revalidation anyway.
 *
 * Server-only state never lives here: the module store is touched only from event handlers and effects (browser),
 * and the server snapshot is always the root loader's count, so SSR and hydration agree.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";

import type { CartLine, CartView, ImageRef } from "~/lib/dto";
import type { Locale } from "~/lib/locales";
import { toast, type ToastImage } from "./toast-store";

/* ═══════════════════════════════ pure: the count model ═══════════════════════════════ */

/** Taps on the same item within this window become one request. */
export const ADD_WINDOW_MS = 250;
/** The server accepts at most this many units in one add (MAX_LINE_QTY in cart.server.ts). */
export const MAX_ADD_QTY = 10;
const REQUEST_TIMEOUT_MS = 15_000;

export type CountState = {
  /** Last authoritative count (a fresh root-loader read or a server answer); null until the first one is known. */
  confirmed: number | null;
  /** Signed sum of changes sent or about to be sent and not settled yet. */
  pending: number;
  /** Increments every time a bead lands on the cart (`tt:cart-received`). */
  bump: number;
};

export const INITIAL_COUNT: CountState = { confirmed: null, pending: 0, bump: 0 };

export type CountEvent =
  /** A fresh root-loader read (dispatched once per loader result — see useCartCount). */
  | { type: "root"; count: number }
  | { type: "optimistic"; delta: number }
  | { type: "settled"; delta: number; count: number | null }
  | { type: "failed"; delta: number }
  | { type: "received" };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDelta = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export function reduceCount(state: CountState, event: CountEvent): CountState {
  switch (event.type) {
    case "root":
      // Even when it equals the old number: after checkout an emptied cart reads 0 again, and that 0 is the truth.
      if (!isCount(event.count) || event.count === state.confirmed) return state;
      return { ...state, confirmed: event.count };
    case "optimistic":
      return isDelta(event.delta) && event.delta !== 0 ? { ...state, pending: state.pending + event.delta } : state;
    case "settled":
      return {
        ...state,
        pending: isDelta(event.delta) ? state.pending - event.delta : state.pending,
        confirmed: isCount(event.count) ? event.count : state.confirmed,
      };
    case "failed":
      return isDelta(event.delta) && event.delta !== 0 ? { ...state, pending: state.pending - event.delta } : state;
    case "received":
      return { ...state, bump: state.bump + 1 };
  }
}

/** What the badge shows: the newest known count plus changes in flight, never below zero. */
export function displayCount(state: CountState, rootCount: number): number {
  const base = state.confirmed ?? (isCount(rootCount) ? rootCount : 0);
  return Math.max(0, base + state.pending);
}

/* ═══════════════════════════════ pure: coalescing ═══════════════════════════════ */

export type Scheduler = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

export type Coalescer<M, R> = {
  /** Add `qty` to the open batch of `key` (or open one). Resolves with the result of the request that carried it. */
  push: (key: string, qty: number, meta: M) => Promise<R>;
  /** Send open batches now (all, or one key). */
  flush: (key?: string) => void;
  /** Units waiting in the open batch of `key`. */
  queued: (key: string) => number;
};

/**
 * One request per key per window: the first push opens a batch and starts the window; pushes inside it add to the
 * batch; the batch is sent when the window ends — or at once when it reaches `maxQty`. Every push resolves with the
 * result of its batch. `send` must not reject; a rejection is passed to `onError` and resolves nothing else.
 */
export function createCoalescer<M, R>(options: {
  windowMs: number;
  maxQty: number;
  scheduler: Scheduler;
  send: (key: string, qty: number, meta: M) => Promise<R>;
  fallback: (error: unknown, qty: number) => R;
}): Coalescer<M, R> {
  type Batch = { qty: number; meta: M; handle: unknown; waiters: ((result: R) => void)[] };
  const open = new Map<string, Batch>();

  const fire = (key: string) => {
    const batch = open.get(key);
    if (!batch) return;
    open.delete(key);
    options.scheduler.clear(batch.handle);
    let request: Promise<R>;
    try {
      request = options.send(key, batch.qty, batch.meta);
    } catch (error) {
      request = Promise.resolve(options.fallback(error, batch.qty));
    }
    request.then(
      (result) => batch.waiters.forEach((resolve) => resolve(result)),
      (error: unknown) => {
        const result = options.fallback(error, batch.qty);
        batch.waiters.forEach((resolve) => resolve(result));
      },
    );
  };

  return {
    push(key, qty, meta) {
      return new Promise<R>((resolve) => {
        let batch = open.get(key);
        if (!batch) {
          batch = { qty: 0, meta, handle: options.scheduler.set(() => fire(key), options.windowMs), waiters: [] };
          open.set(key, batch);
        }
        batch.qty += qty;
        batch.meta = meta;
        batch.waiters.push(resolve);
        if (batch.qty >= options.maxQty) fire(key);
      });
    },
    flush(key) {
      for (const k of key === undefined ? [...open.keys()] : [key]) fire(k);
    },
    queued: (key) => open.get(key)?.qty ?? 0,
  };
}

/* ═══════════════════════════════ pure: reading answers ═══════════════════════════════ */

export type CartFailure = { ok: false; code: string; status: number; retryAfterSec?: number; fields?: Record<string, string> };
export type CartSuccess = { ok: true; cart: CartView; added?: number; status: number };
export type CartAnswer = CartSuccess | CartFailure;

export function isCartView(value: unknown): value is CartView {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CartView>;
  return Array.isArray(v.lines) && isCount(v.count) && isCount(v.subtotalIqd) && isCount(v.totalIqd);
}

/**
 * Turn an HTTP answer of /api/cart (or any `ActionResult` endpoint) into a value. `body` is the parsed JSON, or
 * undefined when the answer was not JSON (an HTML error page: the endpoint is missing or broken).
 */
export function readCartAnswer(status: number, body: unknown): CartAnswer {
  const json = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (json?.ok === true && isCartView(json.cart)) {
    const added = typeof json.added === "number" && Number.isSafeInteger(json.added) && json.added >= 0 ? json.added : undefined;
    return { ok: true, cart: json.cart, status, ...(added === undefined ? null : { added }) };
  }
  return readFailure(status, json);
}

/** The failure half, shared with endpoints that do not return a cart (wishlist). */
export function readFailure(status: number, json: Record<string, unknown> | null): CartFailure {
  const retry = json?.retryAfterSec;
  const retryAfterSec = typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
  const fields = json?.fields && typeof json.fields === "object" ? (json.fields as Record<string, string>) : undefined;
  const base = { ok: false as const, status, ...(retryAfterSec === undefined ? null : { retryAfterSec }), ...(fields ? { fields } : null) };
  if (json?.ok === false && typeof json.code === "string" && json.code) return { ...base, code: json.code };
  if (status === 429) return { ...base, code: "rate_limited" };
  if (!json && (status === 404 || status === 405 || status === 501)) return { ...base, code: "endpoint_missing" };
  if (status === 0) return { ...base, code: "network" };
  return { ...base, code: json?.ok === true ? "invalid" : "generic" };
}

/** Failure codes with their own sentence in ui-shop:errors.*; everything else falls back to "generic". */
export const CART_ERROR_CODES = [
  "out_of_stock",
  "insufficient_stock",
  "unavailable",
  "max_qty_reached",
  "cart_full",
  "rate_limited",
  "network",
  "timeout",
  "not_found",
  "invalid",
  "endpoint_missing",
] as const;

/** ui-shop key of the sentence that explains a failure code. */
export function cartErrorKey(code: string): string {
  if ((CART_ERROR_CODES as readonly string[]).includes(code)) return `errors.${code}`;
  if (code.startsWith("coupon_")) return "errors.coupon";
  return "errors.generic";
}

/* ═══════════════════════════════ network ═══════════════════════════════ */

export type Fields = Record<string, string | number | null | undefined>;

export type PostOutcome = { kind: "answer"; status: number; json: unknown } | { kind: "network" } | { kind: "timeout" };

/** POST form fields to a same-origin endpoint and read JSON. Never throws. Cookies go with it (same origin). */
export async function postForm(url: string, fields: Fields, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PostOutcome> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== null && value !== undefined && value !== "") body.set(key, String(value));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", body, headers: { Accept: "application/json" }, credentials: "same-origin", signal: controller.signal });
    const type = response.headers.get("Content-Type") ?? "";
    const json: unknown = type.includes("json") ? await response.json().catch(() => undefined) : undefined;
    return { kind: "answer", status: response.status, json };
  } catch {
    return timedOut ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** One call to POST /api/cart (intent add | set | remove | coupon). Never throws. */
export async function cartRequest(fields: Fields): Promise<CartAnswer> {
  const outcome = await postForm("/api/cart", fields);
  if (outcome.kind === "network") return { ok: false, code: "network", status: 0 };
  if (outcome.kind === "timeout") return { ok: false, code: "timeout", status: 0 };
  return readCartAnswer(outcome.status, outcome.json);
}

/* ═══════════════════════════════ the store (browser) ═══════════════════════════════ */

let state: CountState = INITIAL_COUNT;
const listeners = new Set<() => void>();
let receiving = false;

function dispatch(event: CountEvent) {
  const next = reduceCount(state, event);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!receiving && typeof document !== "undefined") {
    // The Motion Engine dispatches this (bubbling) on the cart target when a bead lands, or at once without a flight.
    document.addEventListener("tt:cart-received", () => dispatch({ type: "received" }));
    receiving = true;
  }
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;
const getServerState = () => INITIAL_COUNT;

type RootCart = { cart?: { count?: unknown } | null };

const countOf = (root: RootCart | undefined): number => {
  const count = root?.cart?.count;
  return isCount(count) ? count : 0;
};

/** The root loader's `cart.count` (0 when absent or malformed). */
export function useRootCartCount(): number {
  return countOf(useRouteLoaderData("root") as RootCart | undefined);
}

/**
 * Root-loader results already folded into the store. React Router hands out a new data object only when the root
 * loader ran again (after a mutation), so identity — not the number — says "fresh read": a component that mounts
 * later must not replay an old count over a newer server answer, and a new read of the same number still counts.
 */
const seenRoots = new WeakSet<object>();

export type CartCount = {
  /** The number for the cart bead. */
  count: number;
  /** Increments when a bead lands on the cart — key a badge effect on it if you want one. */
  bump: number;
  /** A change is waiting for the server. */
  pending: boolean;
};

/**
 * The cart badge's number for the shell: `<b className="bead" data-cart-badge>{f.number(count)}</b>` inside the
 * `data-cart-target` element. Server-rendered and hydrated from the root loader's `cart.count`.
 */
export function useCartCount(): CartCount {
  const root = useRouteLoaderData("root") as RootCart | undefined;
  const rootCount = countOf(root);
  useEffect(() => {
    if (!root || seenRoots.has(root)) return;
    seenRoots.add(root);
    dispatch({ type: "root", count: countOf(root) });
  }, [root]);
  const current = useSyncExternalStore(subscribe, getState, getServerState);
  return { count: displayCount(current, rootCount), bump: current.bump, pending: current.pending !== 0 };
}

/* ── cart changes for views that show the cart ── */

const cartListeners = new Set<(cart: CartView) => void>();

/** Called with the new CartView after every successful change made through this module. Returns an unsubscribe. */
export function onCartChange(listener: (cart: CartView) => void): () => void {
  cartListeners.add(listener);
  return () => {
    cartListeners.delete(listener);
  };
}

function publishCart(cart: CartView) {
  for (const listener of cartListeners) listener(cart);
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("tt:cart-changed", { detail: { cart } }));
}

/** A CartView that starts from the loader's and follows every change made on the page (adds from shelves, edits). */
export function useCartView<T extends CartView | null>(initial: T): T | CartView {
  const [view, setView] = useState<T | CartView>(initial);
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setView(initial);
  }
  useEffect(() => onCartChange(setView), []);
  return view;
}

/* ── adding ── */

export type AddItem = { variantId: string; usedUnitId?: undefined } | { usedUnitId: string; variantId?: undefined };
export type AddRequest = AddItem & { qty?: number; locale?: Locale };
export type AddOutcome =
  | { ok: true; requested: number; added: number; cart: CartView }
  | { ok: false; requested: number; code: string; retryAfterSec?: number };

type AddMeta = { item: AddItem; locale?: Locale };

const browserScheduler: Scheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function sendAdd(_key: string, qty: number, meta: AddMeta): Promise<AddOutcome> {
  const answer = await cartRequest({ intent: "add", variantId: meta.item.variantId, usedUnitId: meta.item.usedUnitId, qty, locale: meta.locale });
  if (answer.ok) {
    dispatch({ type: "settled", delta: qty, count: answer.cart.count });
    publishCart(answer.cart);
    return { ok: true, requested: qty, added: answer.added ?? qty, cart: answer.cart };
  }
  dispatch({ type: "failed", delta: qty });
  return { ok: false, requested: qty, code: answer.code, ...(answer.retryAfterSec ? { retryAfterSec: answer.retryAfterSec } : null) };
}

const adds = createCoalescer<AddMeta, AddOutcome>({
  windowMs: ADD_WINDOW_MS,
  maxQty: MAX_ADD_QTY,
  scheduler: browserScheduler,
  send: sendAdd,
  fallback: (_error, qty) => {
    dispatch({ type: "failed", delta: qty });
    return { ok: false, requested: qty, code: "generic" };
  },
});

export const itemKey = (item: AddItem) => (item.variantId ? `v:${item.variantId}` : `u:${item.usedUnitId}`);

/**
 * Add to the cart: the count changes now; the request leaves within 250 ms together with any other taps on the same
 * item. Resolves with the outcome of the request that carried this tap (shared by the taps of one batch).
 */
export function addToCart(request: AddRequest): Promise<AddOutcome> {
  const qty = Math.max(1, Math.trunc(request.qty ?? 1));
  const item: AddItem = request.variantId ? { variantId: request.variantId } : { usedUnitId: request.usedUnitId as string };
  dispatch({ type: "optimistic", delta: qty });
  return adds.push(itemKey(item), qty, { item, locale: request.locale });
}

/** Take back what an add put in (the toast's undo): the line drops by `added`, or goes when nothing is left. */
export async function undoAdd(outcome: Extract<AddOutcome, { ok: true }>, item: AddItem, locale?: Locale): Promise<CartAnswer> {
  const line = outcome.cart.lines.find((l) => (item.variantId ? l.variantId === item.variantId : l.usedUnitId === item.usedUnitId));
  if (!line) return { ok: false, code: "not_found", status: 0 };
  const qty = Math.max(0, line.qty - outcome.added);
  const delta = qty - line.qty;
  dispatch({ type: "optimistic", delta });
  const answer = await cartRequest({ intent: "set", lineId: line.id, qty, locale });
  if (answer.ok) {
    dispatch({ type: "settled", delta, count: answer.cart.count });
    publishCart(answer.cart);
  } else dispatch({ type: "failed", delta });
  return answer;
}

/* ── editing (the cart page) ── */

export type CartEditorRow = {
  line: CartLine;
  /** Removed, showing its undo row. */
  removed: boolean;
  /** Waiting for the server. */
  busy: boolean;
  /** ui-shop error code of the last failed change (cartErrorKey turns it into a sentence). */
  error: string | null;
};

export type CartEditor = {
  /** The newest CartView the server has confirmed (totals come from here). */
  view: CartView;
  /** Lines in order, with removed lines kept in place until restored or dismissed. */
  rows: CartEditorRow[];
  setQty: (lineId: string, qty: number) => void;
  remove: (lineId: string) => void;
  restore: (lineId: string) => void;
  dismiss: (lineId: string) => void;
  /** Some change is waiting for the server: the totals may be about to change. */
  pending: boolean;
};

type Ghost = { line: CartLine; index: number };

const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};
const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) => new Map(map).set(key, value);

/**
 * The cart page's state: quantity changes (optimistic, sent after `qtyDelayMs` of quiet), removal with an undo row,
 * restore, and the badge kept in step. Feed it the loader's CartView; a newer loader view replaces it.
 *
 *   const editor = useCartEditor(loaderData.cart, { locale });
 *   {editor.rows.map((row) => (
 *     <CartLineRow key={row.line.id} {...row} onQtyChange={(q) => editor.setQty(row.line.id, q)}
 *       onRemove={() => editor.remove(row.line.id)} onRestore={() => editor.restore(row.line.id)} onDismiss={() => editor.dismiss(row.line.id)} />
 *   ))}
 *   <OrderSummary {...editor.view} pending={editor.pending} />
 */
export function useCartEditor(initial: CartView, options: { locale?: Locale; governorateId?: string | null; qtyDelayMs?: number } = {}): CartEditor {
  const [view, setView] = useState(initial);
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setView(initial);
  }
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, Ghost>>(() => new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [busy, setBusy] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const unsent = useRef(new Map<string, number>()); // optimistic delta per line not yet sent
  const versions = useRef(new Map<string, number>());
  const latest = useRef({ view, ghosts, drafts });
  latest.current = { view, ghosts, drafts };
  const settings = useRef(options);
  settings.current = options;

  useEffect(() => onCartChange(setView), []);
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach(clearTimeout);
  }, []);

  const startBusy = (lineId: string) => setBusy((map) => withEntry(map, lineId, (map.get(lineId) ?? 0) + 1));
  const endBusy = (lineId: string) =>
    setBusy((map) => {
      const n = (map.get(lineId) ?? 0) - 1;
      return n > 0 ? withEntry(map, lineId, n) : without(map, lineId);
    });
  const fail = (lineId: string, code: string) => setErrors((map) => withEntry(map, lineId, code));
  const clearError = (lineId: string) => setErrors((map) => (map.has(lineId) ? without(map, lineId) : map));
  const common = () => ({ locale: settings.current.locale, governorateId: settings.current.governorateId ?? undefined });
  const apply = (cart: CartView) => {
    setView(cart);
    publishCart(cart);
  };

  const sendQty = useCallback(async (lineId: string, qty: number) => {
    const delta = unsent.current.get(lineId) ?? 0;
    unsent.current.delete(lineId);
    const version = versions.current.get(lineId) ?? 0;
    startBusy(lineId);
    const answer = await cartRequest({ intent: "set", lineId, qty, ...common() });
    endBusy(lineId);
    const newest = (versions.current.get(lineId) ?? 0) === version;
    if (answer.ok) {
      dispatch({ type: "settled", delta, count: answer.cart.count });
      apply(answer.cart);
      clearError(lineId);
    } else {
      dispatch({ type: "failed", delta });
      fail(lineId, answer.code);
    }
    // A newer change is already queued: keep its draft; otherwise the server's line is the truth again.
    if (newest) setDrafts((map) => without(map, lineId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- everything it reads is a ref or a state setter
  }, []);

  const setQty = useCallback(
    (lineId: string, qty: number) => {
      const line = latest.current.view.lines.find((l) => l.id === lineId);
      if (!line || !Number.isSafeInteger(qty) || qty < 0) return;
      const shown = latest.current.drafts.get(lineId) ?? line.qty;
      const delta = qty - shown;
      if (delta === 0) return;
      dispatch({ type: "optimistic", delta });
      unsent.current.set(lineId, (unsent.current.get(lineId) ?? 0) + delta);
      versions.current.set(lineId, (versions.current.get(lineId) ?? 0) + 1);
      setDrafts((map) => withEntry(map, lineId, qty));
      clearError(lineId);
      clearTimeout(timers.current.get(lineId));
      timers.current.set(
        lineId,
        setTimeout(() => {
          timers.current.delete(lineId);
          void sendQty(lineId, qty);
        }, settings.current.qtyDelayMs ?? 400),
      );
    },
    [sendQty],
  );

  const remove = useCallback(async (lineId: string) => {
    const index = latest.current.view.lines.findIndex((l) => l.id === lineId);
    const line = latest.current.view.lines[index];
    if (!line) return;
    // A quantity change still waiting is overtaken by the removal.
    clearTimeout(timers.current.get(lineId));
    timers.current.delete(lineId);
    const waiting = unsent.current.get(lineId) ?? 0;
    unsent.current.delete(lineId);
    if (waiting) dispatch({ type: "failed", delta: waiting });
    // The undo row keeps the quantity the shopper saw; the badge drops by what the server holds.
    const shown = latest.current.drafts.get(lineId) ?? line.qty;
    setDrafts((map) => without(map, lineId));
    const delta = -line.qty;
    dispatch({ type: "optimistic", delta });
    setGhosts((map) => withEntry(map, lineId, { line: { ...line, qty: shown, lineTotalIqd: line.unitPriceIqd * shown }, index }));
    clearError(lineId);
    startBusy(lineId);
    const answer = await cartRequest({ intent: "remove", lineId, ...common() });
    endBusy(lineId);
    if (answer.ok) {
      dispatch({ type: "settled", delta, count: answer.cart.count });
      apply(answer.cart);
    } else {
      dispatch({ type: "failed", delta });
      setGhosts((map) => without(map, lineId));
      fail(lineId, answer.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters only
  }, []);

  const restore = useCallback(async (lineId: string) => {
    const ghost = latest.current.ghosts.get(lineId);
    if (!ghost) return;
    const { line } = ghost;
    const qty = Math.min(MAX_ADD_QTY, Math.max(1, line.qty));
    dispatch({ type: "optimistic", delta: qty });
    clearError(lineId);
    startBusy(lineId);
    const answer = await cartRequest({ intent: "add", variantId: line.variantId, usedUnitId: line.usedUnitId, qty, ...common() });
    endBusy(lineId);
    if (answer.ok) {
      dispatch({ type: "settled", delta: qty, count: answer.cart.count });
      setGhosts((map) => without(map, lineId));
      apply(answer.cart);
    } else {
      dispatch({ type: "failed", delta: qty });
      fail(lineId, answer.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters only
  }, []);

  const dismiss = useCallback((lineId: string) => {
    setGhosts((map) => without(map, lineId));
    setErrors((map) => without(map, lineId));
  }, []);

  const rows: CartEditorRow[] = view.lines
    .filter((line) => !ghosts.has(line.id))
    .map((line) => {
      const draft = drafts.get(line.id);
      const shown = draft === undefined ? line : { ...line, qty: draft, lineTotalIqd: line.unitPriceIqd * draft };
      return { line: shown, removed: false, busy: busy.has(line.id) || draft !== undefined, error: errors.get(line.id) ?? null };
    });
  [...ghosts.entries()]
    .sort((a, b) => a[1].index - b[1].index)
    .forEach(([id, ghost]) => {
      rows.splice(Math.min(ghost.index, rows.length), 0, { line: ghost.line, removed: true, busy: busy.has(id), error: errors.get(id) ?? null });
    });

  return {
    view,
    rows,
    setQty,
    remove: (lineId) => void remove(lineId),
    restore: (lineId) => void restore(lineId),
    dismiss,
    pending: busy.size > 0 || drafts.size > 0,
  };
}

/* ═══════════════════════════════ feedback ═══════════════════════════════ */

let region: HTMLElement | null = null;
let regionTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Say something through the page's one polite live region for cart feedback (created on first use). The text is set
 * in the next task, so the same sentence twice in a row is still read.
 */
export function announce(message: string): void {
  if (typeof document === "undefined" || !message) return;
  if (!region?.isConnected) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.dataset.shopAnnouncer = "";
    // Modal layers make the rest of <body> inert (~/ui/Dialog); an inert region would be silent while a sheet is open.
    region.setAttribute("data-overlay-keep", "");
    document.body.appendChild(region);
  }
  const target = region;
  target.textContent = "";
  clearTimeout(regionTimer);
  regionTimer = setTimeout(() => {
    target.textContent = message;
  }, 60);
}

/**
 * The two toasts the commerce components show through the shared store (~/ui/toast-store, DESIGN.md §9.13):
 *   "added" — thumbnail, "أُضيف إلى السلة", "name · variant" and an undo key (toast.cart: rapid adds refresh ONE toast);
 *   "error" — the reason in words and one retry key (toast.error: never pushed away by a less important toast).
 * A toast is a courtesy: the sentence beside the control and the live region already said everything, so nothing
 * depends on a toast being seen (on the server, or without a mounted <Toaster>, nothing shows).
 */
export type ShopToast =
  | {
      kind: "added";
      title: string;
      name: string;
      variant?: string | null;
      image?: ImageRef | null;
      undo?: { label: string; onUndo: () => void } | null;
    }
  | {
      kind: "error";
      title: string;
      detail?: string | null;
      retry?: { label: string; onRetry: () => void } | null;
    };

/** `/media/<key>` — uploaded files (used-unit photos); the server decides what is public. */
export const mediaUrl = (mediaKey: string) => `/media/${encodeURIComponent(mediaKey)}`;

/** An ImageRef as the toast's thumbnail: a catalogue picture by its art key, or an uploaded photo. */
export function toastThumb(image: ImageRef | null | undefined): { art?: string; image?: ToastImage } {
  if (image?.artKey) return { art: image.artKey };
  if (image?.mediaKey) return { image: { src: mediaUrl(image.mediaKey), width: image.width ?? 1200, height: image.height ?? 900 } };
  return {};
}

/** Show a commerce toast. Returns the toast id ("" on the server, where nothing is shown). */
export function showShopToast(input: ShopToast): string {
  if (input.kind === "added") {
    return toast.cart({
      title: input.title,
      name: input.name,
      variant: input.variant ?? undefined,
      ...toastThumb(input.image),
      onUndo: input.undo?.onUndo,
      undoLabel: input.undo?.label,
    });
  }
  return toast.error(input.title, {
    detail: input.detail ?? undefined,
    action: input.retry ? { label: input.retry.label, onAction: input.retry.onRetry } : undefined,
  });
}
