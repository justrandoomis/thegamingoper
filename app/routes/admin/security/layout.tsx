import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { securityAccess, type SecurityAccess } from "~/server/services/admin/security/shared.server";
import { Tabs } from "~/ui/Tabs";
import { ModuleT, useCurrentTabInView, useLayoutT } from "./components/ui";
import { SECURITY_LAYOUT_ID, SECURITY_NS } from "./meta";
import { sec } from "./security.server";
import "./security.css";

/**
 * /admin/security/* — the frame of admin module 20 "Security & Compliance" (docs/areas/admin-security.md): the module's
 * strings (one load for every page below) and the section links this employee may open. The admin gate has already
 * refused employees without any security permission; every page checks its own permission again in its loader and
 * action, and the services check it once more.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await sec.open(context);
  return { i18n: sec.i18n(locale), access: securityAccess(actor) };
}

const SECTIONS: { value: string; path: string; allowed: (a: SecurityAccess) => boolean }[] = [
  { value: "overview", path: "", allowed: () => true },
  { value: "staff", path: "/staff", allowed: (a) => a.staff },
  { value: "roles", path: "/roles", allowed: (a) => a.roles },
  { value: "audit", path: "/audit", allowed: (a) => a.audit },
  { value: "sign-ins", path: "/sign-ins", allowed: (a) => a.signins },
  { value: "refunds", path: "/refunds", allowed: (a) => a.refunds },
  { value: "protections", path: "/protections", allowed: (a) => a.verify || a.refunds },
  { value: "backups", path: "/backups", allowed: (a) => a.backups },
  { value: "retention", path: "/retention", allowed: (a) => a.retention },
];

export default function SecurityLayout({ loaderData }: Route.ComponentProps) {
  const t = useLayoutT(SECURITY_LAYOUT_ID, SECURITY_NS);
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/security\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/security${section.path}` }));
  useCurrentTabInView("sec-nav", current);
  return (
    <ModuleT.Provider value={t}>
      <div className="grid min-w-0 gap-5">
        <Tabs aria-label={t("nav.label")} value={current} items={items} className="sec-nav" />
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </ModuleT.Provider>
  );
}
