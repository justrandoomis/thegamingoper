import type { Route } from "./+types/csv-export";
import { exportProductsCsv, exportVariantsCsv } from "~/server/services/admin/catalog/import.server";
import { parseProductFilters } from "~/server/services/admin/catalog/product.server";
import { catalogRequest } from "./catalog.server";

/**
 * GET /admin/catalog/export?level=products|variants&<list filters> — the CSV download (catalog.product.export).
 * The product sheet has the import's columns (export → edit → import works); the variant sheet carries landed cost
 * and margin only for employees holding cost.read / profit.read — for anyone else those columns do not exist in the
 * file. Every export is audited. Never cached.
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.export");
  const filters = { ...parseProductFilters(url.searchParams), page: 1 };
  const level = url.searchParams.get("level") === "variants" ? "variants" : "products";
  const csv = level === "variants" ? await exportVariantsCsv(db, actor, filters, locale, now) : await exportProductsCsv(db, actor, filters, locale, now);
  const day = new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tamtam-${level}-${day}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
