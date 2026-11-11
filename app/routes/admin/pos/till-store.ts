/**
 * What the till keeps ON THIS DEVICE (localStorage, client only): the catalogue snapshot for offline sales, the cart
 * in progress (a reload does not lose it), and the queue of sales rung up without a connection. Each queued sale
 * carries the idempotency key it got when it was charged, so replaying it — once or ten times — records it once.
 *
 * Honest limits: this is the browser's storage of one device. Nothing here reaches the server until a sync succeeds;
 * clearing the browser's data loses the queue (the page warns while it is not empty); no service worker caches the
 * app, so the till must be open before the connection drops.
 */
import type { CatalogSnapshot, SaleOutcome, SaleRequest, TillItem } from "~/server/services/admin/pos/types";

const QUEUE_KEY = "tt_pos_queue_v1";
const CATALOG_KEY = "tt_pos_catalog_v1";
const CART_KEY = "tt_pos_cart_v1";
export const QUEUE_EVENT = "tt-pos-queue";

export type QueuedSale = {
  key: string;
  shiftId: string;
  createdAt: number;
  totalIqd: number;
  lines: number;
  request: SaleRequest;
  status: "queued" | "conflict";
  outcome: Extract<SaleOutcome, { ok: false }> | null;
  attempts: number;
  lastTriedAt: number | null;
};

export type CartLine = {
  id: string;
  item: TillItem;
  qty: number;
  discountIqd: number;
  /** The line's discount field holds something that is not an amount (shown as an error; the sale waits). */
  discountInvalid?: boolean;
  serials: string[];
};

export type StoredCart = {
  key: string | null;
  lines: CartLine[];
  orderDiscountIqd: number;
  customer: { id: string | null; phone: string; name: string | null; walletIqd: number | null; phoneMasked: string | null } | null;
  discountReason: string;
};

function read<T>(name: string): T | null {
  try {
    const raw = window.localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(name: string, value: unknown): boolean {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ── the queue

export function readQueue(): QueuedSale[] {
  const list = read<QueuedSale[]>(QUEUE_KEY);
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.key === "string") : [];
}

function saveQueue(list: QueuedSale[]): boolean {
  const ok = write(QUEUE_KEY, list.length ? list : null);
  try {
    window.dispatchEvent(new Event(QUEUE_EVENT));
  } catch {
    /* no window */
  }
  return ok;
}

/** Sales this device holds for a shift (queued or in conflict). */
export function queuedFor(shiftId: string): number {
  if (typeof window === "undefined") return 0;
  return readQueue().filter((entry) => entry.shiftId === shiftId).length;
}

/** Adds a sale (its key decides: the same key twice stays one entry). False when the device refused to store it. */
export function enqueue(sale: Omit<QueuedSale, "status" | "outcome" | "attempts" | "lastTriedAt">): boolean {
  const list = readQueue().filter((entry) => entry.key !== sale.key);
  list.push({ ...sale, status: "queued", outcome: null, attempts: 0, lastTriedAt: null });
  return saveQueue(list);
}

export function updateQueued(key: string, patch: Partial<QueuedSale>): void {
  saveQueue(readQueue().map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
}

export function removeQueued(key: string): void {
  saveQueue(readQueue().filter((entry) => entry.key !== key));
}

// ── the catalogue snapshot (per register)

export function readCatalog(registerId: string): CatalogSnapshot | null {
  const all = read<Record<string, CatalogSnapshot>>(CATALOG_KEY);
  return all?.[registerId] ?? null;
}

export function writeCatalog(snapshot: CatalogSnapshot): boolean {
  // One register's snapshot per device is enough; drop the others so the storage stays small.
  return write(CATALOG_KEY, { [snapshot.registerId]: snapshot });
}

/** An item of the snapshot by SKU or one of its barcodes (offline scans). */
export function findInCatalog(snapshot: CatalogSnapshot | null, code: string): TillItem | null {
  if (!snapshot) return null;
  const upper = code.trim().toUpperCase();
  return snapshot.items.find((item) => item.sku.toUpperCase() === upper || item.barcodes.includes(code.trim())) ?? null;
}

// ── the cart in progress (per shift)

export function readCart(shiftId: string): StoredCart | null {
  const cart = read<StoredCart & { shiftId: string }>(CART_KEY);
  return cart && cart.shiftId === shiftId && Array.isArray(cart.lines) ? cart : null;
}

export function writeCart(shiftId: string, cart: StoredCart | null): void {
  write(CART_KEY, cart ? { ...cart, shiftId } : null);
}
