import type { Route } from "./+types/scan";
import { can } from "~/server/actor";
import { lookupCode, standardCostFor } from "~/server/services/admin/inventory/receiving.server";
import { openInventory } from "./inventory.server";

/**
 * GET /admin/inventory/scan?code=… — what a scanned or typed code is (a SKU, a barcode, a serial number for those who
 * may read serials, or a storage location), as JSON for the module's scan fields. Read-only; needs
 * inventory.stock.read. A variant's standard landed cost [P] is added only for employees with cost.read (the
 * receiving form prefills it). Never cached.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const hit = await lookupCode(db, actor, code, locale);
  const body = hit.kind === "variant" && can(actor, "cost.read") ? { ...hit, standardCostIqd: await standardCostFor(db, actor, hit.variant.id) } : hit;
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
