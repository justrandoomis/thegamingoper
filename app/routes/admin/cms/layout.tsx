import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { cmsAccess } from "~/server/services/admin/cms/shared.server";
import { Tabs } from "~/ui/Tabs";
import { cmsI18n, openCms } from "./cms.server";
import { CmsTProvider, useCmsLayoutT } from "./ui";

import "./cms.css";

/**
 * /admin/cms/* — admin module 17 "Content & storefront experience" (docs/areas/admin-cms.md). The shell's gate already
 * let through only employees who hold some cms.* permission; every page below checks its own permission again in its
 * loader and action (requireEmployee), and the services check it once more (assertCan).
 *
 * This layout sends the module's strings and the sections this employee may open.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await openCms(context);
  return { i18n: cmsI18n(locale), access: cmsAccess(actor) };
}

const SECTIONS = ["overview", "home", "banners", "pages", "schedule", "navigation", "search", "seo", "redirects"] as const;

export default function CmsLayout({ loaderData }: Route.ComponentProps) {
  const t = useCmsLayoutT();
  const { pathname } = useLocation();
  const { access } = loaderData;
  const segment = pathname.replace(/^\/admin\/cms\/?/, "").split("/")[0] ?? "";
  const current = (SECTIONS as readonly string[]).includes(segment) ? segment : "overview";
  const items = SECTIONS.filter((section) => section === "overview" || access[section]).map((section) => ({ value: section, label: t(`nav.${section}`), href: section === "overview" ? "/admin/cms" : `/admin/cms/${section}` }));
  return (
    <CmsTProvider value={t}>
      <div className="grid min-w-0 gap-5">
        {segment !== "preview" ? <Tabs aria-label={t("nav.label")} value={current} items={items} className="cms-nav" /> : null}
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </CmsTProvider>
  );
}
