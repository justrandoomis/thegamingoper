/**
 * Data every page needs (loaded once by the root loader, revalidated after mutations):
 * cart badge count, signed-in customer, exchange-rate snapshot, intro and consent state.
 *
 * This module is the seam between the document shell and the domain services. It runs on every
 * document request, so it stays cheap: ONE batched database round trip (three small indexed
 * reads), and no write except the hourly slide of a session's expiry.
 *
 *   loadShell(ctx)             what root.tsx calls — reads the database binding itself
 *   loadShellData(ctx, db)     the same work with the database passed in (tests, scripts)
 */
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import type { FxSnapshot } from "~/lib/money";
import { getCustomer, customerSessionQuery, readCustomerToken, resolveCustomerSession, shareCustomerLookup, type CustomerSession } from "./auth/customer.server";
import type { RequestCtx } from "./context.server";
import { getDb } from "./db.server";
import type { BatchStatement, Db } from "./db/drizzle.server";
import { cartItems, carts, fxRates } from "./db/schema";

export type ShellCustomer = { id: string; name: string | null; phoneMasked: string };

export type ShellData = {
  cart: { count: number };
  customer: ShellCustomer | null;
  fx: FxSnapshot | null;
  /**
   * True when the exchange rate is a placeholder from the demo seed, not a rate the store set.
   * Converted prices are approximations either way; with a demo rate they are not even that.
   */
  fxIsDemo: boolean;
  /** Shopper has dismissed or completed the intro (cookie `tt_intro`). */
  introSeen: boolean;
  /** null = not asked yet. Personalised recommendations only run when true. */
  personalizationConsent: boolean | null;
};

export const CART_COOKIE = "tt_cart";

/** The cart token in the `tt_cart` cookie, or null when it is absent or not shaped like one. */
function readCartToken(ctx: Pick<RequestCtx, "cookie">): string | null {
  const value = ctx.cookie(CART_COOKIE);
  return value && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

/** What can be known without the database. */
function cookieState(ctx: Pick<RequestCtx, "cookie">): Pick<ShellData, "introSeen" | "personalizationConsent"> {
  const consent = ctx.cookie("tt_consent");
  return {
    introSeen: ctx.cookie("tt_intro") === "1",
    personalizationConsent: consent === "1" ? true : consent === "0" ? false : null,
  };
}

const toShellCustomer = (session: CustomerSession | null): ShellCustomer | null =>
  session ? { id: session.customer.id, name: session.customer.name, phoneMasked: session.customer.phoneMasked } : null;

/**
 * The shell data, read in a single `db.batch`:
 *   · the latest USD rate that is already in effect
 *   · the number of items in the cart behind `tt_cart` (sum of quantities; `carts.token_hash` is
 *     sha256 of the cookie's token) — skipped when there is no cookie
 *   · the customer behind `tt_sid` — skipped when there is no cookie; the result is shared with
 *     getCustomer(), so route loaders asking for the customer in the same request do not query again
 */
export async function loadShellData(ctx: RequestCtx, db: Db): Promise<ShellData> {
  const cartToken = readCartToken(ctx);
  const customerToken = readCustomerToken(ctx);

  // Register the pending customer lookup BEFORE the first await, so loaders that start in the same
  // tick wait for this batch instead of running their own query.
  let settle: { resolve: (session: CustomerSession | null) => void; reject: (error: unknown) => void } | null = null;
  if (customerToken) {
    const pending = new Promise<CustomerSession | null>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Nobody may be waiting for it; a failure is reported through this function's own rejection.
    pending.catch(() => {});
    if (!shareCustomerLookup(ctx, pending)) settle = null;
  }
  const shared = settle as { resolve: (session: CustomerSession | null) => void; reject: (error: unknown) => void } | null;

  try {
    const [cartHash, sessionHash] = await Promise.all([cartToken ? sha256Hex(cartToken) : null, customerToken && shared ? sha256Hex(customerToken) : null]);

    const fxQuery = db
      .select({ iqdPerUnit: fxRates.iqdPerUnit, source: fxRates.source, isDemo: fxRates.isDemo, effectiveAt: fxRates.effectiveAt })
      .from(fxRates)
      .where(and(eq(fxRates.quote, "USD"), lte(fxRates.effectiveAt, ctx.now)))
      .orderBy(desc(fxRates.effectiveAt), desc(fxRates.createdAt))
      .limit(1);
    const cartQuery = cartHash
      ? db
          .select({ count: sql<number>`coalesce(sum(${cartItems.qty}), 0)` })
          .from(carts)
          .innerJoin(cartItems, eq(cartItems.cartId, carts.id))
          .where(and(eq(carts.tokenHash, cartHash), isNull(carts.convertedOrderId)))
      : null;
    const sessionQuery = sessionHash ? customerSessionQuery(db, sessionHash) : null;

    const statements: BatchStatement[] = [fxQuery];
    const cartIndex = cartQuery ? statements.push(cartQuery) - 1 : -1;
    const sessionIndex = sessionQuery ? statements.push(sessionQuery) - 1 : -1;
    const results = (await db.batch(statements as [BatchStatement, ...BatchStatement[]])) as unknown[];

    const fxRow = (results[0] as Awaited<typeof fxQuery>)[0];
    const cartCount = cartIndex === -1 ? 0 : Number((results[cartIndex] as { count: number | null }[])[0]?.count ?? 0);

    let session: CustomerSession | null = null;
    if (customerToken && shared && sessionIndex !== -1) {
      session = await resolveCustomerSession(ctx, db, customerToken, results[sessionIndex] as Awaited<NonNullable<typeof sessionQuery>>);
      shared.resolve(session);
    } else if (customerToken) {
      // A loader got there first: use its lookup.
      session = await getCustomer(ctx, db);
    }

    return {
      cart: { count: Number.isSafeInteger(cartCount) && cartCount > 0 ? cartCount : 0 },
      customer: toShellCustomer(session),
      fx: fxRow ? { iqdPerUnit: { USD: fxRow.iqdPerUnit }, source: fxRow.source, updatedAt: fxRow.effectiveAt } : null,
      fxIsDemo: fxRow?.isDemo === true,
      ...cookieState(ctx),
    };
  } catch (error) {
    shared?.reject(error);
    throw error;
  }
}

/** Warn once per isolate, not once per request. */
let warnedAboutDatabase = false;

/**
 * Shell data for the root loader. In development a missing or empty database (no migrations yet)
 * must not take every page down while the project is being set up: the shell then shows an empty
 * cart and no customer, and says why in the console. In production a database failure is a real
 * failure and reaches the error boundary — a cart that claims to be empty would be a lie.
 */
export async function loadShell(ctx: RequestCtx): Promise<ShellData> {
  try {
    return await loadShellData(ctx, getDb());
  } catch (error) {
    if (!ctx.isDev) throw error;
    if (!warnedAboutDatabase) {
      warnedAboutDatabase = true;
      console.warn(`[shell] database unavailable — showing an empty shell (run "npm run db:reset"): ${error instanceof Error ? error.message : String(error)}`);
    }
    return { cart: { count: 0 }, customer: null, fx: null, fxIsDemo: false, ...cookieState(ctx) };
  }
}
