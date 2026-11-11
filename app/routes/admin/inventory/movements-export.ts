import type { Route } from "./+types/movements-export";
import { csvHeaders } from "~/server/services/admin/inventory/csv";
import { movementsCsv, parseMovementFilters } from "~/server/services/admin/inventory/movements.server";
import { baghdadDate } from "~/server/services/admin/inventory/shared.server";
import { inventoryT, openInventory } from "./inventory.server";

/**
 * GET /admin/inventory/movements/export?… — the movement log as CSV with the page's filters (04.04), up to 10,000
 * rows. Column titles in the admin's language. The serial column only for inventory.serial.read, the unit cost
 * column only for cost.read (blueprint acceptance #5: no supplier cost through an export either). Never cached.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.movement.read");
  const t = inventoryT(locale);
  const filters = { ...parseMovementFilters(new URL(request.url).searchParams), page: 1 };
  const headers = {
    at: t("common.when"),
    kind: t("movements.kind"),
    sku: t("common.sku"),
    product: t("common.product"),
    location: t("common.location"),
    qty: t("movements.change"),
    reserved: t("movements.reservedChange"),
    refType: t("common.reference"),
    ref: t("common.reference"),
    reason: t("common.reason"),
    actorKind: t("common.by"),
    actor: t("common.by"),
    serial: t("movements.serial"),
    unitCost: t("movements.unitCost"),
  };
  const { csv } = await movementsCsv(db, actor, filters, locale, headers);
  return new Response(csv, { headers: csvHeaders(`stock-movements-${baghdadDate(now)}.csv`) });
}
