import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { can, canAny } from "~/server/actor";
import { Tabs } from "~/ui/Tabs";
import { ModuleT, useCurrentTabInView, useLayoutT } from "../security/components/ui";
import { SETTINGS_LAYOUT_ID, SETTINGS_NS } from "../security/meta";
import "../security/security.css";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/* — the frame of admin module 22 "Settings & System Administration" (docs/areas/admin-settings.md):
 * the module's strings and the section links this employee may open. The admin gate has already refused employees
 * without any settings permission; every page checks its own permission again, and the services once more.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await settingsKit.open(context);
  return {
    i18n: settingsKit.i18n(locale),
    access: { read: can(actor, "settings.read"), files: can(actor, "settings.file.manage"), any: canAny(actor, ["settings.read", "settings.file.manage"]) },
  };
}

const SECTIONS = [
  { value: "overview", path: "", files: false },
  { value: "changes", path: "/changes", files: false },
  { value: "currency", path: "/currency", files: false },
  { value: "policies", path: "/policies", files: false },
  { value: "fields", path: "/fields", files: false },
  { value: "templates", path: "/templates", files: false },
  { value: "files", path: "/files", files: true },
  { value: "locale", path: "/locale", files: false },
  { value: "environment", path: "/environment", files: false },
] as const;

export default function SettingsLayout({ loaderData }: Route.ComponentProps) {
  const t = useLayoutT(SETTINGS_LAYOUT_ID, SETTINGS_NS);
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/settings\/?/, "").split("/")[0] ?? "";
  const current = segment === "" || segment === "keys" ? "overview" : segment;
  const items = SECTIONS.filter((section) => (section.files ? loaderData.access.files : loaderData.access.read)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/settings${section.path}` }));
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
