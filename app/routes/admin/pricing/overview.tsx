import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/overview";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getPricingOverview } from "~/server/services/admin/pricing/overview.server";
import { ModuleFunctions } from "../blueprint-status";
import { adminMeta } from "../shell/meta";
import { requirePricing } from "./route.server";
import { Iqd, PageHead, usePricingLayout, usePricingT } from "./shared";

/** /admin/pricing — what waits for this employee, the state of the price book, the module's pages and its blueprint status. */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  return { overview: await getPricingOverview(db, actor, ctx.now) };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.pricing"));

type CardProps = { label: string; value: ReactNode; note?: string; to?: string; act?: boolean; linkLabel?: string };

function Card({ label, value, note, to, act, linkLabel }: CardProps) {
  return (
    <div className={act ? "adm-card adm-card--act" : "adm-card"}>
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums">{value}</p>
      {note ? <p className="type-caption text-ink-2">{note}</p> : null}
      {to ? (
        <Link to={to} className="adm-link type-label" prefetch="intent">
          {linkLabel}
        </Link>
      ) : null}
    </div>
  );
}

export default function PricingOverview({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const layout = usePricingLayout();
  const { overview } = loaderData;
  const pages = layout?.pages;

  const links: { key: string; to: string; icon: IconName; show: boolean }[] = [
    { key: "skus", to: "/admin/pricing/skus", icon: "tag", show: true },
    { key: "changes", to: "/admin/pricing/changes", icon: "seal-check", show: true },
    { key: "landed", to: "/admin/pricing/landed", icon: "truck", show: Boolean(pages?.landed) },
    { key: "lists", to: "/admin/pricing/lists", icon: "stack", show: Boolean(pages?.lists) },
    { key: "simulate", to: "/admin/pricing/simulate", icon: "percent", show: Boolean(pages?.simulate) },
    { key: "special", to: "/admin/pricing/special", icon: "recycle", show: Boolean(pages?.special) },
    { key: "fx", to: "/admin/pricing/fx", icon: "currency-dollar", show: true },
  ];

  return (
    <>
      <PageHead title={t("overview.title")} lead={t("overview.lead")} />

      <section className="adm-section" aria-labelledby="pricing-waiting">
        <h2 id="pricing-waiting" className="adm-h2">
          {t("overview.waitingTitle")}
        </h2>
        <div className="adm-grid">
          <Card
            act={overview.decidable > 0}
            label={t("overview.decidable")}
            value={f.number(overview.decidable)}
            note={overview.decidable > 0 ? t("overview.decidableNote") : t("overview.decidableNone")}
            to={overview.decidable > 0 ? "/admin/pricing/changes" : undefined}
            linkLabel={t("overview.openQueue")}
          />
          {overview.usedDecidable > 0 ? (
            <Card act label={t("overview.usedDecidable")} value={f.number(overview.usedDecidable)} note={t("overview.decidableNote")} to="/admin/pricing/special?tab=used" linkLabel={t("overview.openUsed")} />
          ) : null}
          <Card label={t("overview.mine")} value={f.number(overview.mine)} note={t("overview.pendingAll", { count: overview.pending })} to={overview.mine > 0 ? "/admin/pricing/changes" : undefined} linkLabel={t("overview.openQueue")} />
          {overview.billsToAllocate !== undefined ? (
            <Card act={overview.billsToAllocate > 0} label={t("overview.bills")} value={f.number(overview.billsToAllocate)} note={t("overview.billsNote")} to="/admin/pricing/landed" linkLabel={t("overview.openLanded")} />
          ) : null}
        </div>
      </section>

      <section className="adm-section" aria-labelledby="pricing-book">
        <h2 id="pricing-book" className="adm-h2">
          {t("overview.bookTitle")}
        </h2>
        <div className="adm-grid">
          <Card label={t("overview.skus")} value={f.number(overview.skus)} note={t("overview.onSale", { count: overview.onSale })} to="/admin/pricing/skus" linkLabel={t("overview.openSkus")} />
          {overview.belowMin !== undefined ? (
            <Card act={overview.belowMin > 0} label={t("overview.belowMin")} value={f.number(overview.belowMin)} note={t("overview.belowTarget", { count: overview.belowTarget ?? 0 })} to="/admin/pricing/skus?view=below_min" linkLabel={t("overview.review")} />
          ) : null}
          {overview.noCost !== undefined ? <Card label={t("overview.noCost")} value={f.number(overview.noCost)} note={t("overview.noCostNote")} to="/admin/pricing/skus?view=no_cost" linkLabel={t("overview.review")} /> : null}
          <Card
            label={t("overview.fx")}
            value={overview.fx ? <Iqd value={overview.fx.iqdPerUnit} /> : "—"}
            note={overview.fx ? t(overview.fx.isDemo ? "overview.fxDemo" : "overview.fxSince", { date: f.dateTime(overview.fx.effectiveAt), source: overview.fx.source }) : t("overview.fxNone")}
            to="/admin/pricing/fx"
            linkLabel={t("overview.openFx")}
          />
          <Card label={t("overview.lists")} value={f.number(overview.activeLists)} note={t("overview.listsNote")} to={pages?.lists ? "/admin/pricing/lists" : undefined} linkLabel={t("overview.openLists")} />
        </div>
      </section>

      <section className="adm-section" aria-labelledby="pricing-pages">
        <h2 id="pricing-pages" className="adm-h2">
          {t("overview.pagesTitle")}
        </h2>
        <div className="adm-grid">
          {links
            .filter((link) => link.show)
            .map((link) => (
              <Link key={link.key} to={link.to} className="adm-module-link" prefetch="intent">
                <Icon name={link.icon} size={22} />
                <span className="grid gap-0.5">
                  <span className="type-strong">{t(`nav.${link.key}`)}</span>
                  <span className="type-caption text-ink-2">{t(`overview.page.${link.key}`)}</span>
                </span>
              </Link>
            ))}
        </div>
      </section>

      <ModuleFunctions moduleId="03" />
    </>
  );
}
