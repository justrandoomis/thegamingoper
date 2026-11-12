/**
 * A customer's name as the admin shows it in other modules (orders, returns, finance): a link to the customer's 360°
 * profile (/admin/customers/:id) when the loader sent a `profileId` — which it does only for staff who may open the
 * profile (shell/access.server customerProfileId) — and plain text otherwise. Never a link inside another link: a row
 * or a card that is itself a link keeps the text.
 *
 *   <CustomerName profileId={order.customer.profileId}>{order.customer.name ?? t("list.noName")}</CustomerName>
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

export function customerProfileHref(profileId: string): string {
  return `/admin/customers/${encodeURIComponent(profileId)}`;
}

export function CustomerName({ profileId, children, className }: { profileId: string | null | undefined; children: ReactNode; className?: string }) {
  if (!profileId) return <>{children}</>;
  return (
    <Link to={customerProfileHref(profileId)} className={className ?? "adm-link"}>
      {children}
    </Link>
  );
}
