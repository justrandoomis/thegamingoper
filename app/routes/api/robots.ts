/**
 * GET /robots.txt (owner: content area). Crawling is allowed only for a LIVE store on its canonical host
 * (PUBLIC_ORIGIN): demo mode (placeholder prices and stock), *.workers.dev previews and any other host get
 * "Disallow: /". /admin and /api are disallowed in every case; a live store also closes the shopper's private pages
 * and points to /sitemap.xml. Rules: robotsIndexable / buildRobotsTxt in ~/server/services/content.server.
 * No database read: it answers even when the database does not.
 */
import { env } from "cloudflare:workers";
import type { Route } from "./+types/robots";
import { getCtx } from "~/server/context.server";
import { buildRobotsTxt, resolvePublicOrigin, robotsIndexable } from "~/server/services/content.server";

export function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const origin = resolvePublicOrigin((env as { PUBLIC_ORIGIN?: unknown }).PUBLIC_ORIGIN, ctx.origin);
  const indexable = robotsIndexable({ storeMode: ctx.storeMode, requestOrigin: ctx.origin, publicOrigin: origin });
  return new Response(buildRobotsTxt({ indexable, origin }), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
