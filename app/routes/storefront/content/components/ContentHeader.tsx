import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { Breadcrumbs, type Crumb } from "~/ui/Breadcrumbs";
import { cx } from "~/ui/cx";

/**
 * The top of every content page: breadcrumbs (with schema.org JSON-LD on the store's public origin), the page's one
 * <h1> (the shell owns <main>), a lead sentence and whatever status line the page needs under it.
 */
export function ContentHeader({ crumbs, title, lead, children, className }: { crumbs: Crumb[]; title: ReactNode; lead?: ReactNode; children?: ReactNode; className?: string }) {
  const origin = usePublicOrigin();
  return (
    <header className={cx("grid max-w-[44rem] gap-3", className)}>
      <Breadcrumbs items={crumbs} jsonLd={origin ? { origin } : undefined} />
      <h1 className="type-title text-ink">{title}</h1>
      {lead ? <p className="type-body text-ink-2">{lead}</p> : null}
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

/** A section with a visible heading that names it for assistive technology. `heading` replaces the type role. */
export function Section({ id, title, children, className, heading = "type-section" }: { id: string; title: ReactNode; children: ReactNode; className?: string; heading?: "type-section" | "type-sub" }) {
  return (
    <section aria-labelledby={id} className={cx("grid content-start gap-4", className)}>
      <h2 id={id} className={cx(heading, "text-ink")}>
        {title}
      </h2>
      {children}
    </section>
  );
}
