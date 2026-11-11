import { Link, Outlet, useLocation } from "react-router";

import type { Route } from "./+types/customer-layout";
import { throwAsResponse } from "~/server/errors";
import { customerHeader } from "~/server/services/admin/customers/profile.server";
import { customersAccess } from "~/server/services/admin/customers/shared.server";
import { Tabs } from "~/ui/Tabs";
import { openCustomers } from "./customers.server";
import { CustomerStatusBadge, DemoNote, FlagTags, PhoneText, SegmentBadge, useCustomersT, When } from "./ui";

/**
 * /admin/customers/:customerId/* — one customer: the header every page of the customer shares (name, phone as the
 * employee may see it, status, labels, segment) and the customer's sections. Each child page loads its own data with
 * its own permission.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.customer.read");
  try {
    return { header: await customerHeader(db, actor, params.customerId, now), access: customersAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export default function CustomerLayout({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { pathname } = useLocation();
  const { header, access } = loaderData;
  const base = `/admin/customers/${encodeURIComponent(header.id)}`;
  const tail = pathname.slice(base.length).replace(/^\//, "").split("/")[0] ?? "";
  const current = ["contact", "privacy", "messages", "merge"].includes(tail) ? tail : "profile";
  const changeable = header.status === "active" || header.status === "blocked";
  const items = [
    { value: "profile", label: t("customer.nav.profile"), href: base, show: true },
    { value: "contact", label: t("customer.nav.contact"), href: `${base}/contact`, show: true },
    { value: "privacy", label: t("customer.nav.privacy"), href: `${base}/privacy`, show: access.consents || access.privacy },
    { value: "messages", label: t("customer.nav.messages"), href: `${base}/messages`, show: access.communication },
    { value: "merge", label: t("customer.nav.merge"), href: `${base}/merge`, show: access.merge && changeable },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  // an erased account — or a duplicate merged into one that was erased later — has no name any more
  const title = header.status === "deleted" || header.anonymizedAt ? t("customer.erasedTitle") : (header.name ?? t("list.noName"));
  return (
    <div className="grid min-w-0 gap-5">
      <header className="adm-page-head">
        <p className="adm-eyebrow cus-noprint">
          <Link to="/admin/customers" className="adm-link">
            {t("customer.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <span className="min-w-0">{title}</span>
          <DemoNote show={header.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <CustomerStatusBadge status={header.status} />
          <span className="type-caption text-ink-2">
            <PhoneText phone={header.phone} />
          </span>
          {header.email ? (
            <bdi dir="ltr" className="type-caption text-ink-2">
              {header.email}
            </bdi>
          ) : null}
          <span className="type-caption text-ink-2">
            {t("customer.since")} <When at={header.createdAt} style="date" />
          </span>
          {header.segment ? <SegmentBadge segment={header.segment.key} /> : null}
          <FlagTags flags={header.flags} />
        </div>
        {header.mergedInto ? (
          <p className="adm-notice adm-notice--warn">
            {t("customer.mergedInto")}{" "}
            <Link to={`/admin/customers/${encodeURIComponent(header.mergedInto.id)}`} className="adm-link">
              {header.mergedInto.name ?? t("list.noName")}
            </Link>
          </p>
        ) : null}
        {header.anonymizedAt ? (
          <p className="adm-notice">
            {t("customer.erasedOn")} <When at={header.anonymizedAt} />
          </p>
        ) : null}
      </header>
      {items.length > 1 ? (
        <div className="cus-noprint min-w-0">
          <Tabs aria-label={t("customer.nav.label")} value={current} items={items} />
        </div>
      ) : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
