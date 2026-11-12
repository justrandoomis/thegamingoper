import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { countDecidableCampaigns } from "~/server/services/admin/marketing/campaigns.server";
import { pendingReviewCount } from "~/server/services/admin/marketing/reviews.server";
import { MARKETING_PERMISSIONS, marketingAccess } from "~/server/services/admin/marketing/shared.server";
import { Tabs } from "~/ui/Tabs";
import { marketingI18n, openMarketing } from "./marketing.server";
import { useMarketingT } from "./ui";

import "./marketing.css";

/**
 * /admin/marketing/* — admin module 16 "Marketing & growth" (docs/areas/admin-marketing.md). The shell's gate already
 * let through only employees who hold some marketing.* permission; every page below checks its own permission again
 * in its loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open, and what waits for their decision.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openMarketing(context, MARKETING_PERMISSIONS);
  const [decide, reviews] = await Promise.all([countDecidableCampaigns(db, actor), pendingReviewCount(db, actor)]);
  return { i18n: marketingI18n(locale), access: marketingAccess(actor), decide, reviews };
}

const SECTIONS = [
  { value: "home", path: "", access: null },
  { value: "campaigns", path: "campaigns", access: "campaigns" },
  { value: "segments", path: "segments", access: "segments" },
  { value: "carts", path: "carts", access: "carts" },
  { value: "links", path: "links", access: "links" },
  { value: "crossSell", path: "cross-sell", access: "crossSell" },
  { value: "reviews", path: "reviews", access: "reviews" },
  { value: "performance", path: "performance", access: "performance" },
] as const;

export default function MarketingLayout({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const { pathname } = useLocation();
  const { access, decide, reviews } = loaderData;
  const segment = pathname.replace(/^\/admin\/marketing\/?/, "").split("/")[0] ?? "";
  const current = SECTIONS.find((section) => section.path === segment)?.value ?? "home";
  const items = SECTIONS.filter((section) => section.access === null || access[section.access]).map((section) => ({
    value: section.value,
    label: t(`nav.${section.value}`),
    href: `/admin/marketing${section.path ? `/${section.path}` : ""}`,
    count: section.value === "campaigns" && decide ? decide : section.value === "reviews" && reviews ? reviews : undefined,
  }));
  return (
    <div className="grid min-w-0 gap-5">
      {items.length > 1 ? (
        <div className="mkt-noprint min-w-0">
          <Tabs aria-label={t("nav.label")} value={current} items={items} />
        </div>
      ) : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
