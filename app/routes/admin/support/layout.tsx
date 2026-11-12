import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { countWaitingToRoute } from "~/server/services/admin/support/routing.server";
import { supportQueueCounts } from "~/server/services/admin/support/inbox.server";
import { SUPPORT_PERMISSIONS, supportAccess } from "~/server/services/admin/support/shared.server";
import { Tabs } from "~/ui/Tabs";
import { openSupport, supportI18n } from "./support.server";
import { useSupportT } from "./ui";

import "./support.css";

/**
 * /admin/support/* — admin module 14 "Customer Service" (docs/areas/admin-support.md). The shell's gate already let
 * through only employees who hold some support.* permission; every page below checks its own permission again in its
 * loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open and what waits for them.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openSupport(context, SUPPORT_PERMISSIONS);
  const access = supportAccess(actor);
  const [counts, waiting] = await Promise.all([supportQueueCounts(db, actor, now), access.assign ? countWaitingToRoute(db) : Promise.resolve(null)]);
  return { i18n: supportI18n(locale), access, counts, waiting };
}

export default function SupportLayout({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const { pathname } = useLocation();
  const { access, counts } = loaderData;
  const segment = pathname.replace(/^\/admin\/support\/?/, "").split("/")[0] ?? "";
  const known = ["new", "knowledge", "replies", "routing", "sla", "metrics"];
  const current = known.includes(segment) ? segment : "inbox";
  const waiting = (counts.escalatedToMe ?? 0) + (counts.mineLate ?? 0);
  const items = [
    { value: "inbox", label: t("nav.inbox"), href: "/admin/support", count: waiting || undefined, show: access.read },
    { value: "new", label: t("nav.new"), href: "/admin/support/new", show: access.reply },
    { value: "knowledge", label: t("nav.knowledge"), href: "/admin/support/knowledge", show: access.read || access.knowledge || access.approve },
    { value: "replies", label: t("nav.replies"), href: "/admin/support/replies", show: access.reply || access.canned },
    { value: "routing", label: t("nav.routing"), href: "/admin/support/routing", show: access.assign || access.routing },
    { value: "sla", label: t("nav.sla"), href: "/admin/support/sla", show: access.read },
    { value: "metrics", label: t("nav.metrics"), href: "/admin/support/metrics", show: access.metrics },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  return (
    <div className="grid min-w-0 gap-5">
      {items.length > 1 ? (
        <div className="sup-noprint min-w-0" data-adm-tabs="">
          <Tabs aria-label={t("nav.label")} value={current} items={items} />
        </div>
      ) : null}
      <div className="sup-page min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
