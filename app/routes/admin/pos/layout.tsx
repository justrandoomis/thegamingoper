import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { posAccess, POS_READERS } from "~/server/services/admin/pos/shared.server";
import { countReviewable, myShift } from "~/server/services/admin/pos/shifts.server";
import { Tabs } from "~/ui/Tabs";
import { openPos, posI18n } from "./pos.server";
import { usePosT } from "./ui";

import "./pos.css";

/**
 * /admin/pos/* — admin module 06 "Point of sale" (docs/areas/admin-pos.md). The shell's gate already let through only
 * employees who hold some pos.* permission; every page below checks its own permission again in its loader and
 * action (requireEmployee), and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, what this employee may open, their open shift and the shifts waiting for
 * their review.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, POS_READERS);
  const [shift, reviewable] = await Promise.all([myShift(db, actor, locale), countReviewable(db, actor)]);
  return { i18n: posI18n(locale), access: posAccess(actor), shift: shift ? { id: shift.id, register: shift.register.code } : null, reviewable };
}

export default function PosLayout({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { pathname } = useLocation();
  const { access, reviewable } = loaderData;
  const segment = pathname.replace(/^\/admin\/pos\/?/, "").split("/")[0] ?? "";
  const known = ["sell", "shift", "sales", "shifts", "registers", "receipts"];
  const current = segment === "receipts" ? "sales" : known.includes(segment) ? segment : "home";
  const items = [
    { value: "home", label: t("nav.home"), href: "/admin/pos", show: true },
    { value: "sell", label: t("nav.sell"), href: "/admin/pos/sell", show: access.sell },
    { value: "shift", label: t("nav.shift"), href: "/admin/pos/shift", show: access.open || access.close || access.cash },
    { value: "sales", label: t("nav.sales"), href: "/admin/pos/sales", show: access.review || access.reprint || access.sell },
    { value: "shifts", label: t("nav.shifts"), href: "/admin/pos/shifts", count: reviewable || undefined, show: access.review || access.open || access.close },
    { value: "registers", label: t("nav.registers"), href: "/admin/pos/registers", show: true },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  return (
    <div className="grid min-w-0 gap-5">
      <div className="pos-noprint min-w-0">
        <Tabs aria-label={t("nav.label")} value={current} items={items} />
      </div>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
