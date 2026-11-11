import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { shippingAccess, type ShippingAccess } from "~/server/services/admin/shipping/shared.server";
import { Tabs } from "~/ui/Tabs";
import { useShipT } from "./components/kit";
import { openShipping, shippingI18n } from "./shipping.server";
import "./shipping.css";

/**
 * /admin/shipping/* — the frame of admin module 11 "Shipping & Delivery" (docs/areas/admin-shipping.md): the module's
 * strings (one load for every page below) and the row of section links this employee may open. The admin gate has
 * already refused employees without any shipping permission; every page below checks its own permission again in its
 * loader and action, and the services check it once more.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await openShipping(context);
  return { i18n: shippingI18n(locale), access: shippingAccess(actor) };
}

export type ShippingLayoutData = { access: ShippingAccess };

const SECTIONS = [
  { value: "overview", path: "", allowed: (a: ShippingAccess) => a.read || a.cod || a.carriers || a.zones || a.rates },
  { value: "shipments", path: "/shipments", allowed: (a: ShippingAccess) => a.read },
  { value: "attempts", path: "/attempts", allowed: (a: ShippingAccess) => a.read },
  { value: "cod", path: "/cod", allowed: (a: ShippingAccess) => a.cod },
  { value: "carriers", path: "/carriers", allowed: (a: ShippingAccess) => a.read || a.carriers },
  { value: "zones", path: "/zones", allowed: (a: ShippingAccess) => a.read || a.zones || a.rates || a.carriers },
] as const;

export default function ShippingLayout({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/shipping\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment === "print" || segment === "files" ? "shipments" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/shipping${section.path}` }));
  return (
    <div className="grid min-w-0 gap-5">
      <Tabs aria-label={t("nav.label")} value={current} items={items} className="shp-nav shp-noprint" />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
