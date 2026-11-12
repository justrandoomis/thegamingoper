import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { Breadcrumbs, type Crumb } from "~/ui/Breadcrumbs";
import { cx } from "~/ui/cx";

/**
 * The top of every content page (Design System v2 §6.15): breadcrumbs from 768 (with schema.org JSON-LD on the store's
 * public origin, phones included), the page's one <h1> (the shell owns <main>), a lead sentence and whatever status
 * line the page needs under it — all in the 720px reading column.
 */
export function ContentHeader({ crumbs, title, lead, children, className }: { crumbs: Crumb[]; title: ReactNode; lead?: ReactNode; children?: ReactNode; className?: string }) {
  const origin = usePublicOrigin();
  return (
    <header className={cx("chead ccol", className)}>
      <Breadcrumbs items={crumbs} jsonLd={origin ? { origin } : undefined} />
      <h1 className="chead__title">{title}</h1>
      {lead ? <p className="chead__lead">{lead}</p> : null}
      {children}
    </header>
  );
}

/** PUBLIC_ORIGIN as the storefront layout loaded it (canonical URLs use the same value). */
export function usePublicOrigin(): string | null {
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: Pick<ShellData, "publicOrigin"> } | undefined;
  return layout?.shell?.publicOrigin ?? null;
}

/** The storefront layout's navigation taxonomy (platforms with products), when the layout loaded it. */
export function useShellNav(): ShellData["nav"] | null {
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: Pick<ShellData, "nav"> } | undefined;
  return layout?.shell?.nav ?? null;
}

/**
 * Whether the store has published a way to reach it (`store.contact`, as the layout read it for the footer). While it
 * has not, /contact stays out of the content pages' links and they point to «تحدّث مع موظف» instead (v2 §6.15).
 */
export function useHasContact(): boolean {
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: Pick<ShellData, "contact"> } | undefined;
  const contact = layout?.shell?.contact;
  return Boolean(contact && (contact.links.length > 0 || contact.address));
}

/**
 * A section with a visible heading that names it for assistive technology: the h2 role (`size="sm"`: the h3 look for
 * a short aside group, still an h2 in the outline), an optional one-line explanation under it.
 */
export function Section({ id, title, text, children, className, size = "md" }: { id: string; title: ReactNode; text?: ReactNode; children: ReactNode; className?: string; size?: "md" | "sm" }) {
  return (
    <section aria-labelledby={id} className={cx("csec", className)}>
      <div className="csec__head">
        <h2 id={id} className={cx("csec__title", size === "sm" && "csec__title--sm")}>
          {title}
        </h2>
        {text ? <p className="csec__text">{text}</p> : null}
      </div>
      {children}
    </section>
  );
}
