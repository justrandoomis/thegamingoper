/**
 * Data every page needs (loaded once by the root loader, revalidated after mutations):
 * cart badge count, signed-in customer, public store settings, exchange-rate snapshot.
 *
 * This module is the seam between the document shell and the domain services. It must stay cheap:
 * one batched database round-trip at most.
 */
import type { FxSnapshot } from "~/lib/money";
import type { RequestCtx } from "./context.server";

export type ShellCustomer = { id: string; name: string | null; phoneMasked: string };

export type ShellData = {
  cart: { count: number };
  customer: ShellCustomer | null;
  fx: FxSnapshot | null;
  /** Shopper has dismissed or completed the intro (cookie `tt_intro`). */
  introSeen: boolean;
  /** null = not asked yet. Personalised recommendations only run when true. */
  personalizationConsent: boolean | null;
};

export async function loadShell(ctx: RequestCtx): Promise<ShellData> {
  const consent = ctx.cookie("tt_consent");
  return {
    cart: { count: 0 },
    customer: null,
    fx: null,
    introSeen: ctx.cookie("tt_intro") === "1",
    personalizationConsent: consent === "1" ? true : consent === "0" ? false : null,
  };
}
