import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { messagesFor } from "~/i18n/i18n.server";
import { inventoryAccess, type InventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { Tabs } from "~/ui/Tabs";
import { useInvT } from "./components/kit";
import { openInventory } from "./inventory.server";
import "./inventory.css";

/**
 * /admin/inventory/* — the frame of admin module 04: the module's strings (one load for every page below) and the
 * row of section links the employee may open. The admin gate has already refused employees without any inventory
 * permission; every page below checks its own permission again in its loader and action.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await openInventory(context);
  return { i18n: messagesFor(locale, "admin-inventory"), access: inventoryAccess(actor) };
}

export type InventoryLayoutData = { access: InventoryAccess };

const SECTIONS = [
  { value: "overview", path: "", allowed: (a: InventoryAccess) => a.stock },
  { value: "stock", path: "/stock", allowed: (a: InventoryAccess) => a.stock },
  { value: "receive", path: "/receive", allowed: (a: InventoryAccess) => a.receive },
  { value: "transfers", path: "/transfers", allowed: (a: InventoryAccess) => a.stock },
  { value: "counts", path: "/counts", allowed: (a: InventoryAccess) => a.stock },
  { value: "reservations", path: "/reservations", allowed: (a: InventoryAccess) => a.stock },
  { value: "movements", path: "/movements", allowed: (a: InventoryAccess) => a.movements },
  { value: "reorder", path: "/reorder", allowed: (a: InventoryAccess) => a.stock },
  { value: "locations", path: "/locations", allowed: (a: InventoryAccess) => a.stock },
  { value: "serials", path: "/serials", allowed: (a: InventoryAccess) => a.stock && a.serials },
  { value: "oversell", path: "/oversell", allowed: (a: InventoryAccess) => a.stock },
  { value: "costing", path: "/costing", allowed: (a: InventoryAccess) => a.stock && a.cost },
  { value: "reports", path: "/reports", allowed: (a: InventoryAccess) => a.reports },
] as const;

export default function InventoryLayout({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/inventory\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/inventory${section.path}` }));
  return (
    <div className="inv grid min-w-0 gap-5">
      <Tabs aria-label={t("nav.label")} value={current} items={items} className="inv-nav" />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
