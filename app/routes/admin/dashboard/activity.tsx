import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/activity";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { activityFeed, FEED_PAGE } from "~/server/services/admin/dashboard/activity.server";
import { feedSearch, parseFeedFilters } from "~/server/services/admin/dashboard/types";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { useAdminT } from "../shell/i18n";
import { adminMeta } from "../shell/meta";
import { ActivityList } from "./components/cards";
import { useDashT, usePrintInLight } from "./components/kit";
import "./dashboard.css";

/**
 * /admin/dashboard/activity — admin 01.07, the whole activity feed: price changes, returns and approvals from the
 * audit trail, newest first, 25 a page ("older" by the last event's sequence number), filtered by kind in the URL.
 * Each line is shown only to an employee who may open that record's module screen (feed.ts); the kinds offered are
 * the ones they have lines of. dashboard.activity.read.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "dashboard.activity.read");
  const filters = parseFeedFilters(new URL(request.url).searchParams);
  const page = await activityFeed(db, actor, filters, FEED_PAGE);
  return { page, filters, title: serverT(ctx.locale, "admin-dashboard")("activity.pageTitle"), i18n: messagesFor(ctx.locale, "admin-dashboard") };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title ?? ((t) => t("modules.dashboard")));

export default function ActivityPage({ loaderData }: Route.ComponentProps) {
  const t = useDashT();
  const at = useAdminT();
  const { page, filters } = loaderData;
  const printed = useRef<HTMLDivElement>(null);
  usePrintInLight(printed);
  const chips = [{ value: null, label: t("activity.all") }, ...page.kinds.map((kind) => ({ value: kind, label: t(`activity.kinds.${kind}`) }))];
  return (
    <div ref={printed} className="dash-print">
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin" className="adm-link">
            {at("modules.dashboard")}
          </Link>
        </p>
        <h1 className="adm-title">{t("activity.pageTitle")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("activity.lead")}</p>
      </header>

      {page.kinds.length > 1 ? (
        <nav aria-label={t("activity.kindsLabel")} className="dash-period dash-noprint mb-4">
          {chips.map((chip) => {
            const held = filters.kind === chip.value;
            return (
              <Key key={chip.value ?? "all"} as={Link} to={`/admin/dashboard/activity${feedSearch({ kind: chip.value })}`} size="sm" held={held} aria-current={held ? "true" : undefined}>
                {chip.label}
              </Key>
            );
          })}
        </nav>
      ) : null}

      {page.lines.length > 0 ? (
        <div className="adm-card">
          <ActivityList lines={page.lines} />
        </div>
      ) : (
        <EmptyState icon="clock" title={page.kinds.length > 0 ? t("activity.empty") : t("activity.none")} />
      )}

      {page.next || filters.before ? (
        <nav className="mt-4 flex flex-wrap gap-2 dash-noprint" aria-label={t("activity.pageTitle")}>
          {filters.before ? (
            <Key as={Link} to={`/admin/dashboard/activity${feedSearch({ kind: filters.kind })}`} size="sm" variant="ghost">
              {t("activity.newest")}
            </Key>
          ) : null}
          {page.next ? (
            <Key as={Link} to={`/admin/dashboard/activity${feedSearch({ kind: filters.kind, before: page.next })}`} size="sm" iconEnd="arrow-right">
              {t("activity.older")}
            </Key>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
