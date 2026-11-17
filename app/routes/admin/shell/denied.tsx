import { data, redirect } from "react-router";

import type { Route } from "./+types/denied";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { canSeeModule } from "./access.server";
import { DENIED_PATH } from "./gate.server";
import { adminMeta } from "./meta";
import { isAdminModuleSlug, moduleBySlug, moduleOfPath } from "./modules";
import { adminNextPath } from "./next.server";

/**
 * /admin/denied?module=<slug>&from=<the page asked for> — where the admin gate sends a page the BROWSER opened itself
 * (typed, bookmarked, a link from a message or another tab) that the employee may not open (gate.server.ts). The gate
 * refused it before any of the module's code ran; this page only says so, inside the admin frame — the employee's
 * navigation, language and bell — so they can move on (polish 2026-11-13: before, such a page was the root's bare
 * error page without the frame). It answers 403 itself, rendered by the layout's error boundary (shell/ErrorPage.tsx):
 * the section's name, the page they asked for, "try again" and the way home.
 *
 *   module   an admin module's slug, or nothing (a route outside every module, refused for everyone)
 *   from     the page asked for: an admin path only (adminNextPath — never another site, never sign-in or this page)
 *
 * Who may open what is decided by the gate alone: a module the employee may open after all (a role was given since, or
 * a hand-made link) goes straight to the page asked for — or the module's home —, where the gate decides again.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { actor } = await requireEmployee(getCtx(context), getDb());
  const params = new URL(request.url).searchParams;
  const raw = params.get("module");
  const module = isAdminModuleSlug(raw) ? raw : null;
  const target = adminNextPath(params.get("from") ?? "", "");
  const from = target && !target.startsWith(DENIED_PATH) ? target : null;
  if (module && canSeeModule(actor, module)) {
    const home = moduleBySlug(module)?.href ?? "/admin";
    throw redirect(from && moduleOfPath(from.split(/[?#]/)[0] ?? "")?.slug === module ? from : home);
  }
  throw data({ error: "forbidden", ...(module ? { module } : {}), ...(from ? { from } : {}) }, { status: 403 });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("errors.forbiddenTitle"));

/** Never rendered: the loader answers 403 (the layout's error boundary says it) or sends the employee on. */
export default function AdminDenied() {
  return null;
}
