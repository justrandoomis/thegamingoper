import { Link } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { promotionsOverview } from "~/server/services/admin/promotions/overview.server";
import { PROMOTIONS_PERMISSIONS } from "~/server/services/admin/promotions/shared.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { promotionsMeta } from "./meta";
import { openPromotions } from "./promotions.server";
import { Section, usePromotionsT } from "./ui";

/**
 * /admin/promotions — the module's front page: what waits for this employee's decision, each section with the
 * figures counted from its tables (only the sections this employee may open), what the checkout applies today and
 * what it does not yet, and the module's blueprint status.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, PROMOTIONS_PERMISSIONS);
  try {
    return { overview: await promotionsOverview(db, actor, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, null);

type Card = { id: string; to: string; icon: IconName; lines: string[] };

export default function PromotionsHome({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const f = useFormat();
  const { overview } = loaderData;
  const blueprint = blueprintModule("08");
  const n = (value: number) => f.number(value);
  const cards: Card[] = [];
  if (overview.coupons) cards.push({ id: "coupons", to: "/admin/promotions/coupons", icon: "ticket", lines: [t("home.coupons.live", { count: overview.coupons.live, n: n(overview.coupons.live) }), t("home.coupons.used", { count: overview.coupons.usedThisMonth, n: n(overview.coupons.usedThisMonth) })] });
  if (overview.rules) cards.push({ id: "rules", to: "/admin/promotions/rules", icon: "percent", lines: [t("home.rules.live", { count: overview.rules.live, n: n(overview.rules.live) })] });
  if (overview.flash) cards.push({ id: "flash", to: "/admin/promotions/flash", icon: "lightning", lines: [t("home.flash.running", { count: overview.flash.running, n: n(overview.flash.running) }), t("home.flash.scheduled", { count: overview.flash.scheduled, n: n(overview.flash.scheduled) })] });
  if (overview.points) cards.push({ id: "points", to: "/admin/promotions/points", icon: "coins", lines: [t("home.points.outstanding", { n: n(overview.points.outstanding) }), t("home.points.waiting", { count: overview.points.ordersWaiting, n: n(overview.points.ordersWaiting) })] });
  if (overview.referrals) cards.push({ id: "referrals", to: "/admin/promotions/referrals", icon: "users", lines: [t("home.referrals.review", { count: overview.referrals.review, n: n(overview.referrals.review) })] });
  if (overview.vip) cards.push({ id: "vip", to: "/admin/promotions/vip", icon: "star", lines: [t("home.vip.members", { count: overview.vip.members, n: n(overview.vip.members) }), t("home.vip.eligible", { count: overview.vip.eligible, n: n(overview.vip.eligible) })] });
  if (overview.giftCards) cards.push({ id: "giftCards", to: "/admin/promotions/gift-cards", icon: "gift", lines: [t("home.giftCards.outstanding", { amount: f.iqd(overview.giftCards.outstandingIqd) }), t("home.giftCards.active", { count: overview.giftCards.active, n: n(overview.giftCards.active) })] });
  if (overview.experiments) cards.push({ id: "experiments", to: "/admin/promotions/experiments", icon: "chart-bar", lines: [t("home.experiments.running", { count: overview.experiments.running, n: n(overview.experiments.running) })] });

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "08", priority: blueprint?.priority ?? "P1" })}</p>
        <h1 className="adm-title">{t("title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      <Section id="prm-waiting" title={t("home.waiting")}>
        <div className="adm-grid">
          <article className={overview.decide > 0 ? "adm-card adm-card--act" : "adm-card"}>
            <p className="flex items-center gap-2 type-caption text-ink-2">
              <Icon name="seal-check" size={16} />
              {t("home.decide.label")}
            </p>
            <p className="type-kpi nums">
              <bdi>{f.number(overview.decide)}</bdi>
            </p>
            <p className="type-caption text-ink-2">{overview.decide > 0 ? t("home.decide.some") : t("home.decide.none")}</p>
            <div>
              <Key as={Link} to="/admin/promotions/approvals" size="sm" iconEnd="arrow-right">
                {t("home.decide.open")}
              </Key>
            </div>
          </article>
        </div>
      </Section>

      <Section id="prm-sections" title={t("home.sections")}>
        <div className="adm-grid">
          {cards.map((card) => (
            <article key={card.id} className="adm-card">
              <p className="flex items-center gap-2 type-strong">
                <Icon name={card.icon} size={18} />
                {t(`nav.${card.id}`)}
              </p>
              {card.lines.map((line) => (
                <p key={line} className="type-body text-ink-2">
                  {line}
                </p>
              ))}
              <div>
                <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                  {t("home.open")}
                </Key>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section id="prm-checkout" title={t("home.checkout.title")} lead={t("home.checkout.lead")}>
        <ul className="prm-rows">
          {(["coupons", "rules", "flash", "points", "vip", "giftCards", "referrals", "experiments"] as const).map((id) => (
            <li key={id} className="prm-row">
              <span className="type-strong">{t(`nav.${id}`)}</span>
              <span className="flex items-start gap-2 type-body text-ink-2">
                <Icon name={id === "coupons" || id === "giftCards" ? "check-circle" : "plugs-connected"} size={18} className={id === "coupons" || id === "giftCards" ? "mt-0.5 flex-none text-ok" : "mt-0.5 flex-none text-warn"} />
                <span>{t(`home.checkout.${id}`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <ModuleFunctions moduleId="08" />
    </>
  );
}
