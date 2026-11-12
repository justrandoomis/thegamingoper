import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { opsAccess, type OpsAccess } from "~/server/services/admin/ops/shared.server";
import { Tabs } from "~/ui/Tabs";
import { OpsReporter } from "./components/Reporter";
import { OpsT, useCurrentTabInView, useOpsT } from "./components/ui";
import { opsTimingMiddleware } from "./observe.server";
import { ops } from "./ops.server";
import "./ops.css";

/**
 * /admin/ops/* — the frame of admin module 23 "Technical operations" (docs/areas/admin-ops.md): the module's strings
 * (one load for every page below), the section links this employee may open, the speed of its own requests (slow or
 * failed ones only, observe.server.ts) and its pages' browser errors and slow loads (components/Reporter.tsx). The
 * admin gate has already refused employees without any ops permission; every page checks its own permission again in
 * its loader and action, and the services check it once more.
 */
export const middleware: Route.MiddlewareFunction[] = [opsTimingMiddleware];

export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args);
  return { i18n: ops.i18n(req.locale), access: opsAccess(req.actor) };
}

const SECTIONS: { value: string; path: string; allowed: (a: OpsAccess) => boolean }[] = [
  { value: "overview", path: "", allowed: () => true },
  { value: "jobs", path: "/jobs", allowed: (a) => a.jobs },
  { value: "outbox", path: "/outbox", allowed: (a) => a.jobs },
  { value: "consistency", path: "/consistency", allowed: (a) => a.consistency },
  { value: "incidents", path: "/incidents", allowed: (a) => a.incidents },
  { value: "errors", path: "/errors", allowed: (a) => a.errors },
  { value: "performance", path: "/performance", allowed: (a) => a.performance },
  { value: "backups", path: "/backups", allowed: (a) => a.backups },
];

export default function OpsLayout({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/ops\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/ops${section.path}` }));
  useCurrentTabInView("ops-nav", current);
  return (
    <OpsT.Provider value={t}>
      <div className="grid min-w-0 gap-5">
        <Tabs aria-label={t("nav.label")} value={current} items={items} className="ops-nav ops-noprint" />
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
      <OpsReporter />
    </OpsT.Provider>
  );
}
