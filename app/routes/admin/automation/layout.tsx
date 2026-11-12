import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { automationAccess, type AutomationAccess } from "~/server/services/admin/automation/shared.server";
import { Tabs } from "~/ui/Tabs";
import { AdminErrorPage } from "../shell/ErrorPage";
import { automation } from "./automation.server";
import { AutoT, useAutoT, useCurrentTabInView } from "./components/ui";
import "./automation.css";

/**
 * /admin/automation/* — the frame of admin module 19 "Automation and AI" (docs/areas/admin-automation.md): the module's
 * strings (one load for every page below) and the section links this employee may open. The admin gate has already
 * refused employees without any automation permission; every page checks its own permission again in its loader and
 * action, and the services check it once more.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args);
  return { i18n: automation.i18n(req.locale), access: automationAccess(req.actor) };
}

const SECTIONS: { value: string; path: string; allowed: (a: AutomationAccess) => boolean }[] = [
  { value: "overview", path: "", allowed: () => true },
  { value: "rules", path: "/rules", allowed: (a) => a.rules },
  { value: "runs", path: "/runs", allowed: (a) => a.rules },
  { value: "suggestions", path: "/suggestions", allowed: (a) => a.suggestions },
  { value: "forecast", path: "/forecast", allowed: (a) => a.suggestions },
  { value: "anomalies", path: "/anomalies", allowed: (a) => a.anomalies },
  { value: "tickets", path: "/tickets", allowed: (a) => a.tickets },
  { value: "assistant", path: "/assistant", allowed: (a) => a.assistant },
];

function Frame({ access, children }: { access: AutomationAccess; children: ReactNode }) {
  const t = useAutoT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/automation\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/automation${section.path}` }));
  useCurrentTabInView("auto-nav", current);
  return (
    <AutoT.Provider value={t}>
      <div className="grid min-w-0 gap-5">
        <Tabs aria-label={t("nav.label")} value={current} items={items} className="auto-nav" />
        <div className="min-w-0">{children}</div>
      </div>
    </AutoT.Provider>
  );
}

export default function AutomationLayout({ loaderData }: Route.ComponentProps) {
  return (
    <Frame access={loaderData.access}>
      <Outlet />
    </Frame>
  );
}

/**
 * A page below refused or failed (403 for a permission this employee lacks, 404, …): the module's tabs stay, so the
 * employee sees the sections they may open. When the frame's own loader failed there are no tabs to show.
 */
export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  if (!loaderData) return <AdminErrorPage error={error} />;
  return (
    <Frame access={loaderData.access}>
      <AdminErrorPage error={error} />
    </Frame>
  );
}
