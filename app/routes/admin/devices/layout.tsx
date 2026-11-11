import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { devicesAccess } from "~/server/services/admin/devices/shared.server";
import { deviceQueueCounts } from "~/server/services/admin/devices/tradeins.server";
import { Tabs } from "~/ui/Tabs";
import { devicesI18n, openDevices } from "./devices.server";
import { useDevicesT } from "./ui";

import "./devices.css";

/**
 * /admin/devices/* — admin module 13 "Devices, games & trade-in" (docs/areas/admin-devices.md). The shell's gate already
 * let through only employees who hold some devices.* permission; every page below checks its own permission again in
 * its loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open, and what waits in each queue.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openDevices(context);
  return { i18n: devicesI18n(locale), access: devicesAccess(actor), counts: await deviceQueueCounts(db, actor, now) };
}

export default function DevicesLayout({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const { pathname } = useLocation();
  const { access, counts } = loaderData;
  const segment = pathname.replace(/^\/admin\/devices\/?/, "").split("/")[0] ?? "";
  const known = ["trade-ins", "used", "registry", "digital", "templates", "guides"];
  const current = known.includes(segment) ? segment : "overview";
  const tradeWaiting = (counts.toInspect ?? 0) + (counts.toOffer ?? 0) + (counts.toPay ?? 0);
  const unitsWaiting = (counts.unitsToInspect ?? 0) + (counts.toList ?? 0);
  const items = [
    { value: "overview", label: t("nav.overview"), href: "/admin/devices", show: true },
    { value: "trade-ins", label: t("nav.tradeIns"), href: "/admin/devices/trade-ins", count: tradeWaiting || undefined, show: access.tradeRead },
    { value: "used", label: t("nav.used"), href: "/admin/devices/used", count: unitsWaiting || undefined, show: access.usedRead },
    { value: "registry", label: t("nav.registry"), href: "/admin/devices/registry", show: access.registry },
    { value: "digital", label: t("nav.digital"), href: "/admin/devices/digital", show: access.any },
    { value: "templates", label: t("nav.templates"), href: "/admin/devices/templates", show: access.any },
    { value: "guides", label: t("nav.guides"), href: "/admin/devices/guides", show: access.guidesRead },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  return (
    <div className="grid min-w-0 gap-5">
      <div className="dev-noprint min-w-0">
        <Tabs aria-label={t("nav.label")} value={current} items={items} />
      </div>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
