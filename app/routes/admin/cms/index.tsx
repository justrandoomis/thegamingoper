import { Link } from "react-router";

import type { Route } from "./+types/index";
import { ModuleFunctions } from "~/routes/admin/blueprint-status";
import { getCmsOverview } from "~/server/services/admin/cms/overview.server";
import { HERO_PLATFORMS } from "~/server/services/admin/cms/rules";
import { cmsMeta } from "./meta";
import { openCms, orRespond } from "./cms.server";
import { DecisionCard, DemoTag, Figure, Note, PageHead, Section, StateBadge, When, useCmsT } from "./ui";

/**
 * /admin/cms — admin module 17: what waits for a decision (policies still served as code drafts, page drafts, waiting
 * pin changes, a navigation draft), what is live, what comes next in the schedule, and the blueprint status.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context);
  return { overview: await orRespond(() => getCmsOverview(db, actor, locale, now)), now };
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "home.title");

export default function CmsOverviewPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { overview } = loaderData;
  const { access } = overview;
  const decisions: { key: string; icon: "file-text" | "flag" | "list" | "pencil-simple"; title: string; text: string; to: string; action: string }[] = [];
  if (overview.pages && overview.pages.mineAwaiting > 0) decisions.push({ key: "policies", icon: "file-text", title: t("home.decide.policies", { count: overview.pages.mineAwaiting }), text: t("home.decide.policiesText"), to: "/admin/cms/pages", action: t("home.decide.open") });
  if (overview.pages && overview.pages.drafts > 0) decisions.push({ key: "drafts", icon: "pencil-simple", title: t("home.decide.drafts", { count: overview.pages.drafts }), text: t("home.decide.draftsText"), to: "/admin/cms/pages", action: t("home.decide.open") });
  if (overview.pins && overview.pins.waiting > 0) decisions.push({ key: "pins", icon: "flag", title: t("home.decide.pins", { count: overview.pins.waiting }), text: t("home.decide.pinsText"), to: "/admin/cms/home", action: t("home.decide.open") });
  if (overview.nav?.hasDraft) decisions.push({ key: "nav", icon: "list", title: t("home.decide.nav"), text: t("home.decide.navText"), to: "/admin/cms/navigation", action: t("home.decide.open") });

  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="decide" title={t("home.waiting")}>
        {decisions.length === 0 ? (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        ) : (
          <ul role="list" className="cms-decisions">
            {decisions.map((decision) => (
              <DecisionCard key={decision.key} icon={decision.icon} title={decision.title} text={decision.text} to={decision.to} action={decision.action} />
            ))}
          </ul>
        )}
      </Section>

      <Section id="now" title={t("home.now")}>
        <div className="cms-figures">
          {overview.pages ? <Figure label={t("home.fig.policies")} value={`${overview.pages.approved} / ${overview.pages.total}`} hint={t("home.fig.policiesHint")} to="/admin/cms/pages" /> : null}
          {overview.banners ? <Figure label={t("home.fig.banners")} value={String(overview.banners.live)} hint={t("home.fig.bannersHint", { count: overview.banners.upcoming })} to="/admin/cms/banners" /> : null}
          {overview.pins ? (
            <Figure
              label={t("home.fig.pins")}
              value={`${overview.pins.live.length} / ${HERO_PLATFORMS.length}`}
              hint={overview.pins.live.length > 0 ? overview.pins.live.map((platform) => t(`platform.${platform}`)).join(t("common.sep")) : t("home.fig.pinsNone")}
              to="/admin/cms/home"
            />
          ) : null}
          {overview.search ? <Figure label={t("home.fig.zero")} value={String(overview.search.zero7)} hint={t("home.fig.zeroHint", { count: overview.search.synonyms })} to="/admin/cms/search/zero?days=7" /> : null}
          {overview.redirects ? <Figure label={t("home.fig.redirects")} value={String(overview.redirects.active)} hint={t("home.fig.redirectsHint")} to="/admin/cms/redirects" /> : null}
        </div>
      </Section>

      {access.schedule ? (
        <Section
          id="next"
          title={t("home.next")}
          aside={
            <Link to="/admin/cms/schedule" className="adm-link type-label">
              {t("home.openSchedule")}
            </Link>
          }
        >
          {overview.next.length === 0 ? (
            <p className="type-body text-ink-2">{t("home.nothingNext")}</p>
          ) : (
            <ul role="list" className="grid gap-2">
              {overview.next.map((item) => (
                <li key={item.key} className="adm-card flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="type-caption text-ink-2">{t(`schedule.kind.${item.kind}`)} · {t(`schedule.edge.${item.edge}`)}</span>
                    <br />
                    <Link to={item.href} className="adm-link">
                      {item.title || "—"}
                    </Link>
                    {/* a draft's dates are a plan: nothing starts until it is published or scheduled; a demo row never shows */}
                    {item.draft || item.demo ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        {item.draft ? <StateBadge state="draft" /> : null}
                        <DemoTag show={item.demo} />
                      </span>
                    ) : null}
                  </span>
                  <When at={item.at} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Note>
        <p>{t("home.storefrontNote")}</p>
      </Note>

      <div className="mt-8">
        <ModuleFunctions moduleId="17" />
      </div>
    </>
  );
}
