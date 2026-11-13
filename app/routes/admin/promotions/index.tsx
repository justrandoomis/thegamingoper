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
import { STATE_SECTIONS, type StateSection } from "./checkout-state";
import { promotionsMeta } from "./meta";
import { openPromotions } from "./promotions.server";
import { Section, StateLines, usePromotionsT } from "./ui";

/**
 * /admin/promotions — the module's front page: what waits for this employee's decision, each section with the
 * figures counted from its tables (only the sections this employee may open), where each section is applied today —
 * at the online checkout and at the till, in words with a dot and the exact sentence (./checkout-state.ts, the same
 * lines as each section's note) — and the module's blueprint status.
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

type Card = { id: StateSection; to: string; lines: string[] };

/** Each section's icon — on its card and on its row of «ما يُطبَّق اليوم». */
const SECTION_ICON: Readonly<Record<StateSection, IconName>> = { coupons: "ticket", rules: "percent", flash: "lightning", points: "coins", vip: "star", giftCards: "gift", referrals: "users", experiments: "chart-bar" };

export default function PromotionsHome({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const f = useFormat();
  const { overview } = loaderData;
  const blueprint = blueprintModule("08");
  const n = (value: number) => f.number(value);
  const cards: Card[] = [];
  if (overview.coupons) cards.push({ id: "coupons", to: "/admin/promotions/coupons", lines: [t("home.coupons.live", { count: overview.coupons.live, n: n(overview.coupons.live) }), t("home.coupons.used", { count: overview.coupons.usedThisMonth, n: n(overview.coupons.usedThisMonth) })] });
  if (overview.rules) cards.push({ id: "rules", to: "/admin/promotions/rules", lines: [t("home.rules.live", { count: overview.rules.live, n: n(overview.rules.live) })] });
  if (overview.flash) cards.push({ id: "flash", to: "/admin/promotions/flash", lines: [t("home.flash.running", { count: overview.flash.running, n: n(overview.flash.running) }), t("home.flash.scheduled", { count: overview.flash.scheduled, n: n(overview.flash.scheduled) })] });
  if (overview.points) cards.push({ id: "points", to: "/admin/promotions/points", lines: [t("home.points.outstanding", { n: n(overview.points.outstanding) }), t("home.points.waiting", { count: overview.points.ordersWaiting, n: n(overview.points.ordersWaiting) })] });
  if (overview.referrals) cards.push({ id: "referrals", to: "/admin/promotions/referrals", lines: [t("home.referrals.review", { count: overview.referrals.review, n: n(overview.referrals.review) })] });
  if (overview.vip) cards.push({ id: "vip", to: "/admin/promotions/vip", lines: [t("home.vip.members", { count: overview.vip.members, n: n(overview.vip.members) }), t("home.vip.eligible", { count: overview.vip.eligible, n: n(overview.vip.eligible) })] });
  if (overview.giftCards) cards.push({ id: "giftCards", to: "/admin/promotions/gift-cards", lines: [t("home.giftCards.outstanding", { amount: f.iqd(overview.giftCards.outstandingIqd) }), t("home.giftCards.active", { count: overview.giftCards.active, n: n(overview.giftCards.active) })] });
  if (overview.experiments) cards.push({ id: "experiments", to: "/admin/promotions/experiments", lines: [t("home.experiments.running", { count: overview.experiments.running, n: n(overview.experiments.running) })] });

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
                <Icon name={SECTION_ICON[card.id]} size={18} />
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

      {/* where each section is applied today, online and at the till — from checkout-state.ts, never per-row guesses */}
      <Section id="prm-checkout" title={t("home.checkout.title")} lead={t("home.checkout.lead")}>
        <ul className="prm-state-list">
          {STATE_SECTIONS.map((id) => (
            <li key={id} className="prm-state-row">
              <p className="flex items-center gap-2 type-strong">
                <Icon name={SECTION_ICON[id]} size={18} className="flex-none" />
                {t(`nav.${id}`)}
              </p>
              <StateLines id={id} />
            </li>
          ))}
        </ul>
      </Section>

      <ModuleFunctions moduleId="08" />
    </>
  );
}
