/**
 * Redirects staff set in the content module (admin 17.04), for the loaders that would answer 404: the catch-all
 * route, an unknown one-segment path (the home route under an invalid "locale"), a missing product, a missing
 * category and a missing landing page.
 *
 *   await redirectIfMoved(getDb(), url, ctx);    // throws the redirect when a safe one exists, else returns
 *   throw data({ error: "not_found" }, { status: 404 });
 *
 * The target is checked by findStoreRedirect (~/server/services/content.server): a same-site storefront path only —
 * never another host, never /admin or /api, never a loop or a chain — whatever the database holds. The hit is counted
 * after the response (the Worker's waitUntil); a lookup that fails leaves the 404 as it was (logged), never a 500.
 */
import * as workers from "cloudflare:workers";
import { redirect } from "react-router";

import type { Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { recordRedirectHit } from "~/server/services/admin/cms/redirects.server";
import { findStoreRedirect } from "~/server/services/content.server";

/** Runs `task` after the response when the runtime offers waitUntil (else it just runs); a failure is only logged. */
export function afterResponse(task: Promise<unknown>, what: string): void {
  const settled = task.catch((error: unknown) => console.error(`[storefront] ${what} failed`, error));
  const waitUntil = (workers as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
  if (typeof waitUntil !== "function") return;
  try {
    waitUntil(settled);
  } catch {
    // outside a request (tests): the promise runs on its own
  }
}

/** Throws the redirect for this 404 path when staff set a safe one; returns otherwise (the caller throws its 404). */
export async function redirectIfMoved(db: Db, url: URL, ctx: { locale: Locale; origin: string }): Promise<void> {
  let hit: Awaited<ReturnType<typeof findStoreRedirect>> = null;
  try {
    hit = await findStoreRedirect(db, url.pathname, ctx.locale, { origins: [ctx.origin] });
  } catch (error) {
    console.error("[storefront] redirect lookup failed — answering 404", error);
    return;
  }
  if (!hit) return;
  afterResponse(recordRedirectHit(db, hit.id), "redirect hit");
  throw redirect(hit.location, hit.code);
}
