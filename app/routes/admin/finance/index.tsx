import { Link } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { financeOverview } from "~/server/services/admin/finance/overview.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { queueHref } from "../shell/queues.server";
import { openFinance } from "./finance.server";
import { financeMeta } from "./meta";
import { Kpi, Money, Note, PeriodName, Section, useFinT } from "./ui";

/**
 * /admin/finance — the module's front page: what waits for this employee's decision (raised clay only there), the
 * figures their permissions open (each absent without its permission — never a zero), the sections, and the module's
 * blueprint status.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context);
  // The expenses card opens what it counts — drafts of any month, demo ones too — like the bell's link (the list alone
  // opens on this month's real expenses).
  return { overview: await financeOverview(db, actor, now), now, expensesHref: queueHref("expenses", now) };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, null);

type Card = { id: string; count: number; to: string; icon: IconName };

export default function FinanceHome({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const locale = useLocale();
  const { overview, expensesHref } = loaderData;
  const { access, waiting } = overview;
  const blueprint = blueprintModule("10");

  const candidates: (Card | null)[] = [
    waiting.topups !== null ? { id: "topups", count: waiting.topups, to: "/admin/finance/wallets?tab=topups", icon: "wallet" } : null,
    waiting.adjustments !== null ? { id: "adjustments", count: waiting.adjustments, to: "/admin/finance/wallets?tab=adjustments", icon: "hand-coins" } : null,
    waiting.expenses !== null ? { id: "expenses", count: waiting.expenses, to: expensesHref, icon: "receipt" } : null,
    waiting.statements !== null ? { id: "statements", count: waiting.statements, to: "/admin/finance/settlements?status=unmatched", icon: "bank" } : null,
    waiting.critical !== null ? { id: "critical", count: waiting.critical, to: "/admin/finance/anomalies", icon: "warning" } : null,
  ];
  const cards = candidates.filter((card): card is Card => card !== null);

  const sections: { to: string; icon: IconName; key: string; show: boolean }[] = [
    { to: "/admin/finance/journal", icon: "book-open", key: "journal", show: access.books },
    { to: "/admin/finance/accounts", icon: "table", key: "accounts", show: access.books },
    { to: "/admin/finance/settlements", icon: "bank", key: "settlements", show: access.reconcile },
    { to: "/admin/finance/revenue", icon: "trend-up", key: "revenue", show: access.reports },
    { to: "/admin/finance/expenses", icon: "receipt", key: "expenses", show: access.expenses },
    { to: "/admin/finance/reports", icon: "chart-bar", key: "reports", show: access.reports },
    { to: "/admin/finance/wallets", icon: "wallet", key: "wallets", show: access.wallet },
    { to: "/admin/finance/tax", icon: "percent", key: "tax", show: access.tax },
    { to: "/admin/finance/close", icon: "lock", key: "close", show: access.closeView },
    { to: "/admin/finance/anomalies", icon: "warning", key: "anomalies", show: access.anomalies },
  ];

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("overview.eyebrow", { id: "10", priority: blueprint?.priority ?? "P0" })}</p>
        {/* the blueprint names the module in ar and en only: Sorani uses the module's own title */}
        <h1 className="adm-title">{blueprint && locale !== "ckb" ? blueprint[locale === "en" ? "en" : "ar"] : t("overview.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("overview.lead")}</p>
      </header>

      {cards.length ? (
        <Section id="fin-waiting" title={t("overview.waiting")}>
          <div className="adm-grid">
            {cards.map((card) => (
              <article key={card.id} className={card.count > 0 ? "adm-card adm-card--act" : "adm-card"}>
                <p className="flex items-center gap-2 type-caption text-ink-2">
                  <Icon name={card.icon} size={16} />
                  {t(`overview.cards.${card.id}.label`)}
                </p>
                <p className="type-kpi nums">
                  <bdi>{f.number(card.count)}</bdi>
                </p>
                <p className="type-caption text-ink-2">{card.count > 0 ? t(`overview.cards.${card.id}.some`, { count: card.count }) : t(`overview.cards.${card.id}.none`)}</p>
                <div>
                  <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                    {t(`overview.cards.${card.id}.open`)}
                  </Key>
                </div>
              </article>
            ))}
            {waiting.closeDue ? (
              <article className="adm-card adm-card--act">
                <p className="flex items-center gap-2 type-caption text-ink-2">
                  <Icon name="lock" size={16} />
                  {t("overview.cards.close.label")}
                </p>
                <p className="type-sub">
                  <PeriodName period={waiting.closeDue} />
                </p>
                <p className="type-caption text-ink-2">{t("overview.cards.close.some")}</p>
                <div>
                  <Key as={Link} to={`/admin/finance/close?period=${waiting.closeDue}`} size="sm" iconEnd="arrow-right">
                    {t("overview.cards.close.open")}
                  </Key>
                </div>
              </article>
            ) : null}
          </div>
        </Section>
      ) : null}

      {overview.revenue || overview.cash || overview.wallet ? (
        <Section id="fin-figures" title={t("overview.figures")} aside={<PeriodName period={overview.period} />}>
          <div className="fin-kpis">
            {overview.revenue ? (
              <>
                <Kpi icon="trend-up" label={t("overview.kpi.netRevenue")} value={<Money iqd={overview.revenue.netIqd} />} hint={t("overview.kpi.netRevenueHint", { count: overview.revenue.ordersRecognised })} />
                <Kpi icon="hourglass" label={t("overview.kpi.open")} value={<Money iqd={overview.revenue.openIqd} />} hint={t("overview.kpi.openHint", { count: overview.revenue.openOrders })} />
              </>
            ) : null}
            {overview.cash ? (
              <>
                <Kpi icon="money" label={t("overview.kpi.cash")} value={<Money iqd={overview.cash.cashIqd} />} hint={t("overview.kpi.cashHint")} />
                <Kpi icon="bank" label={t("overview.kpi.bank")} value={<Money iqd={overview.cash.bankIqd} />} hint={t("overview.kpi.bankHint")} />
              </>
            ) : null}
            {overview.wallet ? <Kpi icon="wallet" label={t("overview.kpi.wallet")} value={<Money iqd={overview.wallet.liabilityIqd} />} hint={t("overview.kpi.walletHint")} /> : null}
          </div>
          {overview.demo.entries > 0 ? (
            <Note>
              <p>{t("overview.demoNote", { count: overview.demo.entries })}</p>
            </Note>
          ) : null}
        </Section>
      ) : null}

      <Section id="fin-sections" title={t("overview.sections")}>
        <ul className="adm-grid" role="list">
          {sections
            .filter((section) => section.show)
            .map((section) => (
              <li key={section.key}>
                <Link to={section.to} prefetch="intent" className="adm-module-link">
                  <Icon name={section.icon} size={22} />
                  <span className="grid gap-0.5">
                    <span className="type-strong">{t(`nav.${section.key}`)}</span>
                    <span className="type-caption text-ink-2">{t(`overview.about.${section.key}`)}</span>
                  </span>
                </Link>
              </li>
            ))}
        </ul>
      </Section>

      <ModuleFunctions moduleId="10" />
    </>
  );
}
