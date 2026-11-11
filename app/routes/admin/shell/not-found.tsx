import { data } from "react-router";

import type { Route } from "./+types/not-found";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";

/** /admin/* that matches nothing: a 404 rendered inside the shell by the layout's error boundary (signed-in only). */
export async function loader({ context }: Route.LoaderArgs) {
  await requireEmployee(getCtx(context), getDb());
  throw data({ error: "not_found" }, { status: 404 });
}

export default function AdminNotFound() {
  return null;
}
