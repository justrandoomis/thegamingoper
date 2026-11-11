import { redirect, redirectDocument } from "react-router";

import type { Route } from "./+types/language";
import { getCtx, serializeCookie } from "~/server/context.server";
import { adminBackPath } from "../shell/next.server";
import { ADMIN_LOCALE_COOKIE } from "../shell/shell.server";

/**
 * POST /admin/locale — the admin's language (Arabic, right to left, or English), a per-browser preference in the
 * `tt_admin_locale` cookie that the root middleware reads for every /admin request. `back` must be an /admin path
 * (sign-in and setup included); the reply is a document redirect so the whole page, its direction included, is drawn
 * again. Works from the sign-in page without a session, and without JavaScript.
 */
const ONE_YEAR = 60 * 60 * 24 * 365;

export function loader() {
  return redirect("/admin");
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const form = await request.formData();
  const locale = form.get("locale") === "en" ? "en" : "ar";
  const back = adminBackPath(form.get("back"));
  // Path=/ so the data requests of the admin home (/admin.data) carry it too; it is a preference, not a secret.
  ctx.setCookie(serializeCookie(ctx, ADMIN_LOCALE_COOKIE, locale, { maxAge: ONE_YEAR, path: "/", sameSite: "Lax" }));
  return redirectDocument(back, { headers: { "Cache-Control": "no-store" } });
}
