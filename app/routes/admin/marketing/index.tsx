import { Link } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { marketingOverview } from "~/server/services/admin/marketing/overview.server";
import { MARKETING_PERMISSIONS } from "~/server/services/admin/marketing/shared.server";
import { SEND_LIMITS } from "~/server/services/admin/marketing/types";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { marketingMeta } from "./meta";
import { openMarketing } from "./marketing.server";
import { Boundary, Section, useMarketingT } from "./ui";

/**
 * /admin/marketing — the module's front page: what waits for this employee's decision, each section with the
 * figures counted from its tables (only the sections this employee may open), the honest boundaries (no message
 * provider, no recorded source on orders), and the module's blueprint status.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openMarketing(context, MARKETING_PERMISSIONS);
  try {
    return { overview: await marketingOverview(db, actor, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, null);

type Card = { id: string; to: string; icon: IconName; lines: string[] };

export default function MarketingHome({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const f = useFormat();
  const { overview } = loaderData;
  const blueprint = blueprintModule("16");
  const n = (value: number) => f.number(value);
  const cards: Card[] = [];
  if (overview.campaigns)
    cards.push({
      id: "campaigns",
      to: "/admin/marketing/campaigns",
      icon: "paper-plane-tilt",
      lines: [
        t("home.campaigns.drafts", { count: overview.campaigns.drafts, n: n(overview.campaigns.drafts) }),
        t("home.campaigns.released", { count: overview.campaigns.released, n: n(overview.campaigns.released) }),
        t("home.campaigns.held", { count: overview.campaigns.held, n: n(overview.campaigns.held) }),
        ...(overview.campaigns.demo > 0 ? [t("home.campaigns.demo", { count: overview.campaigns.demo, n: n(overview.campaigns.demo) })] : []),
      ],
    });
  if (overview.campaigns) cards.push({ id: "segments", to: "/admin/marketing/segments", icon: "users", lines: [t("home.segments.line")] });
  if (overview.carts) cards.push({ id: "carts", to: "/admin/marketing/carts", icon: "shopping-cart-simple", lines: [t("home.carts.week", { count: overview.carts.remindedThisWeek, n: n(overview.carts.remindedThisWeek) })] });
  if (overview.links) cards.push({ id: "links", to: "/admin/marketing/links", icon: "link", lines: [t("home.links.total", { count: overview.links.total, n: n(overview.links.total) }), t("home.links.attributed", { count: overview.links.attributedOrders, n: n(overview.links.attributedOrders) })] });
  if (overview.rules) cards.push({ id: "crossSell", to: "/admin/marketing/cross-sell", icon: "game-controller", lines: [t("home.rules.active", { count: overview.rules.active, n: n(overview.rules.active) })] });
  if (overview.reviews !== null) cards.push({ id: "reviews", to: "/admin/marketing/reviews", icon: "star", lines: [t("home.reviews.pending", { count: overview.reviews, n: n(overview.reviews) })] });
  if (overview.spend) cards.push({ id: "performance", to: "/admin/marketing/performance", icon: "chart-line", lines: [t("home.performance.spend", { count: overview.spend.campaigns, n: n(overview.spend.campaigns) })] });

  const waiting = [
    overview.decide !== null ? { id: "decide", icon: "seal-check" as IconName, count: overview.decide, to: "/admin/marketing/campaigns?view=decide" } : null,
    overview.due !== null ? { id: "due", icon: "clock" as IconName, count: overview.due, to: "/admin/marketing/campaigns?view=due" } : null,
    overview.reviews !== null ? { id: "reviews", icon: "star" as IconName, count: overview.reviews, to: "/admin/marketing/reviews" } : null,
  ].filter((entry): entry is { id: string; icon: IconName; count: number; to: string } => entry !== null);

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "16", priority: blueprint?.priority ?? "P1" })}</p>
        <h1 className="adm-title">{t("title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      <Boundary title={t("home.boundary.title")}>{t("home.boundary.text", { max: SEND_LIMITS.maxPerWindow, days: SEND_LIMITS.windowDays })}</Boundary>

      {waiting.length > 0 ? (
        <Section id="mkt-waiting" title={t("home.waiting")}>
          <div className="adm-grid">
            {waiting.map((entry) => (
              <article key={entry.id} className={entry.count > 0 ? "adm-card adm-card--act" : "adm-card"}>
                <p className="flex items-center gap-2 type-caption text-ink-2">
                  <Icon name={entry.icon} size={16} />
                  {t(`home.wait.${entry.id}.label`)}
                </p>
                <p className="type-kpi nums">
                  <bdi>{f.number(entry.count)}</bdi>
                </p>
                <p className="type-caption text-ink-2">{entry.count > 0 ? t(`home.wait.${entry.id}.some`) : t(`home.wait.${entry.id}.none`)}</p>
                <div>
                  <Key as={Link} to={entry.to} size="sm" iconEnd="arrow-right">
                    {t("home.open")}
                  </Key>
                </div>
              </article>
            ))}
          </div>
        </Section>
      ) : null}

      <Section id="mkt-sections" title={t("home.sections")}>
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

      <ModuleFunctions moduleId="16" />
    </>
  );
}
