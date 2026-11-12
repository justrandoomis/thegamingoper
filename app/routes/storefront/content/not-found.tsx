import { data } from "react-router";

import type { Route } from "./+types/not-found";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { redirectIfMoved } from "./redirect.server";

/**
 * Catch-all: any storefront path that matches no route renders the layout's error boundary with a real 404 status —
 * unless staff redirected that path in the content module (admin 17.04): then the shopper goes there instead (a safe,
 * same-site target only: ./redirect.server).
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  await redirectIfMoved(getDb(), url, ctx);
  throw data({ error: "not_found" }, { status: 404 });
}

export default function NotFound() {
  return null;
}
