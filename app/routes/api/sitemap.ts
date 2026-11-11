/**
 * GET /sitemap.xml — every public page in Arabic, English and Kurdish (Sorani), each with its hreflang alternates on
 * PUBLIC_ORIGIN (owner: content area; what is listed and why: getSitemapEntries in ~/server/services/content.server).
 *
 * Draft policies, noindex products and categories and private pages never appear. While the store is in demo mode
 * the file still answers (useful to check), but robots.txt does not point to it and every response carries
 * `X-Robots-Tag: noindex` (security headers). A failed read answers 503 with Retry-After — never a partial or empty
 * sitemap that a crawler would take as "the store has no pages".
 */
import { env } from "cloudflare:workers";
import type { Route } from "./+types/sitemap";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { buildSitemapXml, getSitemapEntries, resolvePublicOrigin } from "~/server/services/content.server";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  try {
    const entries = await getSitemapEntries(getDb(), ctx.now);
    const origin = resolvePublicOrigin((env as { PUBLIC_ORIGIN?: unknown }).PUBLIC_ORIGIN, ctx.origin);
    return new Response(buildSitemapXml(entries, origin), {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  } catch (error) {
    console.error("[sitemap] could not be built", error);
    return new Response("Sitemap temporarily unavailable.\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "3600" },
    });
  }
}
