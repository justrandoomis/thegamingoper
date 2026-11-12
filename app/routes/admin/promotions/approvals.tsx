import { Link } from "react-router";

import type { Route } from "./+types/approvals";
import { bpsToPercent } from "~/server/services/admin/promotions/types";
import { throwAsResponse } from "~/server/errors";
import { listApprovals } from "~/server/services/admin/promotions/approvals.server";
import { PROMOTIONS_PERMISSIONS } from "~/server/services/admin/promotions/shared.server";
import { formatMoney } from "~/lib/money";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { promotionsMeta } from "./meta";
import { openPromotions } from "./promotions.server";
import { Notice, Section, usePromotionsT, When } from "./ui";
import type { ApprovalCard } from "~/server/services/admin/promotions/types";

/**
 * /admin/promotions/approvals — the module's decisions in one queue, mobile first: coupon and rule terms beyond the
 * limits, flash sales whose prices need a second person, large gift cards and point adjustments. Each card opens the
 * page that decides it (with the impact and a reason); the employee's own requests are listed apart, to withdraw —
 * the requester never decides.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPromotions(context, PROMOTIONS_PERMISSIONS);
  try {
    const iqd = (value: number) => formatMoney(value, "IQD", locale);
    return await listApprovals(db, actor, locale, { iqd, percent: (bps) => `${bpsToPercent(bps)}%`, points: (value) => String(value) });
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "approvals.title");

export default function ApprovalsPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const { decide, mine } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("title")}</p>
        <h1 className="adm-title">{t("approvals.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("approvals.lead")}</p>
      </header>
      <Section id="prm-decide" title={t("approvals.decide", { count: decide.length })}>
        {decide.length === 0 ? <EmptyState title={t("approvals.none")} text={t("approvals.noneHint")} icon="seal-check" /> : <Cards cards={decide} />}
      </Section>
      <Section id="prm-mine" title={t("approvals.mine", { count: mine.length })}>
        {mine.length === 0 ? <p className="type-body text-ink-2">{t("approvals.noneMine")}</p> : <Cards cards={mine} />}
        <Notice>{t("approvals.mineNote")}</Notice>
      </Section>
    </>
  );
}

function Cards({ cards }: { cards: ApprovalCard[] }) {
  const t = usePromotionsT();
  return (
    <ul className="prm-cards">
      {cards.map((card) => (
        <li key={card.id} className={card.canDecide ? "prm-card prm-panel--decide" : "prm-card"}>
          <span className="prm-card__top">
            <span className="type-strong">
              <bdi>{card.title}</bdi>
            </span>
            <span className="prm-tag">{t(`approvals.kind.${card.kind}`)}</span>
          </span>
          {card.facts.length ? (
            <span className="prm-tags">
              {card.facts.map((fact) => (
                <span key={fact.label} className="prm-tag">
                  {t(`approvals.fact.${fact.label}`, { value: fact.label === "action" ? t(`approvals.action.${fact.value}`) : fact.value })}
                </span>
              ))}
            </span>
          ) : null}
          <span className="type-caption text-ink-2">
            {t("common.requestedBy", { name: card.requestedBy ?? "—" })} · <When at={card.requestedAt} />
          </span>
          {card.reason ? <span className="type-body">{t("common.reasonWas", { reason: card.reason })}</span> : null}
          <span>
            <Key as={Link} to={card.href} size="sm" iconEnd="arrow-right">
              {card.canDecide ? t("approvals.openDecide") : t("approvals.open")}
            </Key>
          </span>
        </li>
      ))}
    </ul>
  );
}
