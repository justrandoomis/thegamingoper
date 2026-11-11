import { redirect, redirectDocument } from "react-router";

import type { Route } from "./+types/sign-out";
import { getEmployee, revokeAllEmployeeSessions, signOutEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";

/**
 * POST /admin/logout — scope=one ends this device's session; scope=all ends every session of the employee (audited)
 * and this one. Then a document redirect to the sign-in page, which says what happened. Only POST signs out (the root
 * middleware refuses cross-site posts); GET just goes to the admin home.
 */
export function loader() {
  return redirect("/admin");
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const all = form.get("scope") === "all";
  const session = await getEmployee(ctx, db);
  if (all && session) await revokeAllEmployeeSessions(db, session.actor, { employeeId: session.employee.id }, ctx.now);
  await signOutEmployee(ctx, db);
  return redirectDocument(`/admin/login?signed_out=${all ? "all" : "one"}`, { headers: { "Cache-Control": "no-store" } });
}
