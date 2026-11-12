import { Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { messagesFor } from "~/i18n/i18n.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { pricingPages } from "~/server/services/admin/pricing/overview.server";
import { countDecidable } from "~/server/services/admin/pricing/prices.server";
import { countUsedDecidable } from "~/server/services/admin/pricing/special.server";
import { getSetting } from "~/server/settings.server";
import { AdminErrorPage } from "../shell/ErrorPage";
import { requirePricing } from "./route.server";

/**
 * Admin module 03 — pricing and profitability (/admin/pricing/…). The layout only loads what every page of the module
 * needs: its strings, the pages this employee may open, how many price changes wait for their decision (the
 * navigation's count) and the cut limit in force (setting "pricing.drop_approval_bps", admin 22 — the words that name
 * it, useDropLimit). Each page still checks its own permission, and the services check again.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  const [decidable, usedDecidable, dropLimitBps] = await Promise.all([countDecidable(db, actor), countUsedDecidable(db, actor), getSetting(db, "pricing.drop_approval_bps")]);
  return { i18n: messagesFor(ctx.locale, "admin-pricing"), pages: pricingPages(actor), decidable, usedDecidable, dropLimitBps };
}

export default function PricingLayout() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <AdminErrorPage error={error} />;
}
