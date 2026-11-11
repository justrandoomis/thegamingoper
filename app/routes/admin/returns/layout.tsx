import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { queueCounts, returnsAccess } from "~/server/services/admin/returns/rma.server";
import { Tabs } from "~/ui/Tabs";
import { openReturns, returnsI18n } from "./returns.server";
import { useReturnsT } from "./ui";

import "./returns.css";

/**
 * /admin/returns/* — admin module 12 "Returns & Warranty" (docs/areas/admin-returns.md). The shell's gate already let
 * through only employees who hold some returns.* permission; every page below checks its own permission again in its
 * loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open, and the number waiting in each queue.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context);
  const access = returnsAccess(actor);
  return { i18n: returnsI18n(locale), access, counts: await queueCounts(db, actor, now) };
}

export default function ReturnsLayout({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const { pathname } = useLocation();
  const { access, counts } = loaderData;
  const segment = pathname.replace(/^\/admin\/returns\/?/, "").split("/")[0] ?? "";
  const known = ["new", "repairs", "quarantine", "warranties", "policies"];
  const current = known.includes(segment) ? segment : "list";
  const waiting = (counts.decide ?? 0) + (counts.receive ?? 0) + (counts.inspect ?? 0) + (counts.refundApproval ?? 0);
  const items = [
    { value: "list", label: t("nav.list"), href: "/admin/returns", count: waiting || undefined, show: access.read || access.create },
    { value: "new", label: t("nav.new"), href: "/admin/returns/new", show: access.create },
    { value: "repairs", label: t("nav.repairs"), href: "/admin/returns/repairs", count: counts.repairsLate || undefined, show: access.repair || access.read || access.warranty },
    { value: "quarantine", label: t("nav.quarantine"), href: "/admin/returns/quarantine", count: counts.quarantine || undefined, show: access.quarantine },
    { value: "warranties", label: t("nav.warranties"), href: "/admin/returns/warranties", show: access.warranty || access.warrantyManage },
    { value: "policies", label: t("nav.policies"), href: "/admin/returns/policies", show: access.policyRead },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  return (
    <div className="grid min-w-0 gap-5">
      <div className="ret-noprint min-w-0">
        <Tabs aria-label={t("nav.label")} value={current} items={items} />
      </div>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
