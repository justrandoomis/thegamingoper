import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { channelsAccess } from "~/server/services/admin/channels/shared.server";
import type { ChannelsAccess } from "~/server/services/admin/channels/types";
import { Tabs } from "~/ui/Tabs";
import { ChT, useChT, useCurrentTabInView } from "./components/ui";
import { ch } from "./kit.server";
import "./channels.css";

/**
 * /admin/channels/* — the frame of admin module 21 "Branches, channels and integrations" (docs/areas/admin-channels.md):
 * the module's strings (one load for every page below) and the section links this employee may open. The admin gate
 * has already refused employees without any permission of the module; every page checks its own permission again in
 * its loader and action, and the services check it once more.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  return { i18n: ch.i18n(req.locale), access: channelsAccess(req.actor) };
}

const SECTIONS: { value: string; path: string; allowed: (a: ChannelsAccess) => boolean }[] = [
  { value: "overview", path: "", allowed: () => true },
  { value: "branches", path: "/branches", allowed: (a) => a.branches },
  { value: "sales", path: "/sales", allowed: (a) => a.channels },
  { value: "orders", path: "/orders", allowed: (a) => a.orders },
  { value: "profit", path: "/profit", allowed: (a) => a.profit },
  { value: "api", path: "/api", allowed: () => true },
  { value: "webhooks", path: "/webhooks", allowed: (a) => a.webhooks },
  { value: "monitor", path: "/monitor", allowed: (a) => a.monitor },
  { value: "providers", path: "/providers", allowed: (a) => a.providers },
];

export default function ChannelsLayout({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/channels\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({
    value: section.value,
    label: t(`nav.${section.value}`),
    // the API section opens on the keys for who manages them, on the reference for everyone else
    href: section.value === "api" && !loaderData.access.apiKeys ? "/admin/channels/api/docs" : `/admin/channels${section.path}`,
  }));
  useCurrentTabInView("ch-nav", current);
  return (
    <ChT.Provider value={t}>
      <div className="grid min-w-0 gap-5">
        <Tabs aria-label={t("nav.label")} value={current} items={items} className="ch-nav ch-noprint" />
        <div className="ch-page min-w-0">
          <Outlet />
        </div>
      </div>
    </ChT.Provider>
  );
}
