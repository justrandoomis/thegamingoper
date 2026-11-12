import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { countDecidable } from "~/server/services/admin/promotions/approvals.server";
import { PROMOTIONS_PERMISSIONS, promotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { Tabs } from "~/ui/Tabs";
import { openPromotions, promotionsI18n } from "./promotions.server";
import { usePromotionsT } from "./ui";

import "./promotions.css";

/**
 * /admin/promotions/* — admin module 08 "Promotions & loyalty" (docs/areas/admin-promotions.md). The shell's gate
 * already let through only employees who hold some promotions.* permission; every page below checks its own
 * permission again in its loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open, and how many requests wait for them.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPromotions(context, PROMOTIONS_PERMISSIONS);
  return { i18n: promotionsI18n(locale), access: promotionsAccess(actor), decide: await countDecidable(db, actor) };
}

const SECTIONS = [
  { value: "home", path: "", access: "any" },
  { value: "coupons", path: "coupons", access: "coupons" },
  { value: "rules", path: "rules", access: "rules" },
  { value: "flash", path: "flash", access: "flash" },
  { value: "points", path: "points", access: "points" },
  { value: "referrals", path: "referrals", access: "referrals" },
  { value: "vip", path: "vip", access: "vip" },
  { value: "giftCards", path: "gift-cards", access: "giftCards" },
  { value: "experiments", path: "experiments", access: "experiments" },
  { value: "approvals", path: "approvals", access: "any" },
] as const;

export default function PromotionsLayout({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const { pathname } = useLocation();
  const { access, decide } = loaderData;
  const segment = pathname.replace(/^\/admin\/promotions\/?/, "").split("/")[0] ?? "";
  const current = SECTIONS.find((section) => section.path === segment)?.value ?? "home";
  const items = SECTIONS.filter((section) => access[section.access]).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/promotions${section.path ? `/${section.path}` : ""}`, count: section.value === "approvals" && decide ? decide : undefined }));
  return (
    <div className="grid min-w-0 gap-5">
      {items.length > 1 ? (
        <div className="prm-noprint min-w-0">
          <Tabs aria-label={t("nav.label")} value={current} items={items} />
        </div>
      ) : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
