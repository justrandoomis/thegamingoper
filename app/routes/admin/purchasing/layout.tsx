import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { messagesFor } from "~/i18n/i18n.server";
import { purchasingAccess, type PurchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { Tabs } from "~/ui/Tabs";
import { AdminErrorPage } from "../shell/ErrorPage";
import { usePurT } from "./components/kit";
import { openPurchasing } from "./purchasing.server";
import "./purchasing.css";

/**
 * /admin/purchasing/* — the frame of admin module 09: the module's strings (one load for every page below) and the row
 * of section links the employee may open. The admin gate has already refused employees without any purchasing
 * permission; every page below checks its own permission again in its loader and action, and the services again.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale } = await openPurchasing(context);
  return { i18n: messagesFor(locale, "admin-purchasing"), access: purchasingAccess(actor) };
}

export type PurchasingLayoutData = { access: PurchasingAccess };

const SECTIONS = [
  { value: "overview", path: "", allowed: () => true },
  { value: "orders", path: "/orders", allowed: (a: PurchasingAccess) => a.poRead },
  { value: "receipts", path: "/receipts", allowed: (a: PurchasingAccess) => a.poRead || a.receive },
  { value: "invoices", path: "/invoices", allowed: (a: PurchasingAccess) => a.invoice },
  { value: "claims", path: "/claims", allowed: (a: PurchasingAccess) => a.claim },
  { value: "alerts", path: "/alerts", allowed: (a: PurchasingAccess) => a.poRead || a.invoice || a.claim },
  { value: "rfqs", path: "/rfqs", allowed: (a: PurchasingAccess) => a.rfq },
  { value: "suppliers", path: "/suppliers", allowed: (a: PurchasingAccess) => a.supplierRead },
] as const;

export default function PurchasingLayout({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/purchasing\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(`nav.${section.value}`), href: `/admin/purchasing${section.path}` }));
  return (
    <div className="pur grid min-w-0 gap-5">
      <Tabs aria-label={t("nav.label")} value={current} items={items} className="pur-nav" />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <AdminErrorPage error={error} />;
}
