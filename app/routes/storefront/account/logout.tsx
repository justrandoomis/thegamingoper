import type { Route } from "./+types/logout";
import { signOutCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { clearGuestCookies, localeRedirect } from "./account.server";

/**
 * POST /account/logout — ends this device's session (the row is revoked, the cookie removed) and drops the cart and
 * favourites cookies, which now point at the account's things, so the next person on the device starts clean.
 * GET does nothing but go to the account: signing out is never a link (a prefetch or a crawler must not sign anyone out).
 */
export async function loader({ context }: Route.LoaderArgs) {
  throw localeRedirect("/account", getCtx(context).locale);
}

export async function action({ context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  await signOutCustomer(ctx, getDb());
  clearGuestCookies(ctx);
  return localeRedirect("/account/login?signedout=1", ctx.locale);
}
