import { useRef } from "react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/admin-home";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { activityFeed, FEED_PREVIEW } from "~/server/services/admin/dashboard/activity.server";
import { criticalTicketsAlert, lateOrdersAlert, lowStockAlert, unmatchedPaymentsAlert } from "~/server/services/admin/dashboard/alerts.server";
import { funnelCard } from "~/server/services/admin/dashboard/funnel.server";
import { resultCard, salesCard } from "~/server/services/admin/dashboard/kpis.server";
import { inboxCard, moneyCard, stockCard } from "~/server/services/admin/dashboard/roles.server";
import { branchOptions, dashboardAccess, effectiveBranch, effectiveView, settle, viewAccess } from "~/server/services/admin/dashboard/shared.server";
import {
  parseDashboardFilters,
  type AlertId,
  type AlertTile,
  type DashboardFilters,
  type DashboardView,
  type FeedPage,
  type FunnelCard,
  type InboxCard,
  type MoneyCard,
  type ResultCard,
  type SalesCard,
  type StockCard,
  type Streamed,
} from "~/server/services/admin/dashboard/types";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { ModuleFunctions, statusCounts } from "../blueprint-status";
import { useAdminShell } from "../shell/actions";
import { useAdminT } from "../shell/i18n";
import { adminMeta } from "../shell/meta";
import { ADMIN_MODULES, compareModules } from "../shell/modules";
import type { ShellQueueId, ShellWaiting } from "../shell/queues.server";
import { ActivityList, FunnelView, InboxFigures, MoneyFigures, ResultKpi, SalesKpis, StockFigures, TileLoading, UrgentTile } from "./components/cards";
import { CardFailed, CardLoading, Section, StreamedCard, useDashT, usePrintInLight } from "./components/kit";
import { PeriodBar, SearchBox, ViewTabs, type BranchChoice } from "./components/tools";
import "./dashboard.css";

/**
 * /admin — admin module 01, the command centre, and every employee's admin home.
 *
 *   01.02  what needs action: four tiles (late orders, mismatched payments, low stock, urgent tickets), each the
 *          module's own list for this employee (alerts.server.ts), and what waits for their own decision — the bell's
 *          queues, read from the layout's data (shell/queues.server.ts), never counted twice
 *   01.01  paid sales, new orders, open orders, average basket, net profit (cost.read + profit.read) — each against
 *          the same span before (kpis.server.ts, docs/metrics.md, finance's profitAndLoss)
 *   01.04  the period (today, this week, this month), the demo switch, the branch filter where branches exist
 *   01.03  the funnel cart → order → paid → delivered, by channel (funnel.server.ts)
 *   01.05  role views (finance, warehouse, support): only the views — and in each, only the cards — whose permission
 *          the employee holds (shared.server.ts dashboardAccess)
 *   01.06  the search box (→ /admin/dashboard/search)
 *   01.07  the latest activity (activity.server.ts), each line by its module's permission
 *
 * The page needs a signed-in employee and no particular permission: without dashboard.overview.read it is the plain
 * home (what waits for them, their sections). Every card is a promise that never rejects (settle), streamed on its
 * own: the page renders at once and one slow card never holds the others. Nothing here changes anything.
 */
type HomeCards = Partial<{
  late: Promise<Streamed<AlertTile>>;
  unmatched: Promise<Streamed<AlertTile>>;
  lowStock: Promise<Streamed<AlertTile>>;
  critical: Promise<Streamed<AlertTile>>;
  sales: Promise<Streamed<SalesCard>>;
  result: Promise<Streamed<ResultCard>>;
  funnel: Promise<Streamed<FunnelCard>>;
  money: Promise<Streamed<MoneyCard>>;
  stock: Promise<Streamed<StockCard>>;
  inbox: Promise<Streamed<InboxCard>>;
  activity: Promise<Streamed<FeedPage>>;
}>;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db);
  const access = dashboardAccess(actor);
  const views = viewAccess(access);
  const asked = parseDashboardFilters(new URL(request.url).searchParams);
  const options = access.overview ? await branchOptions(db, ctx.locale) : [];
  const branch = effectiveBranch(actor, asked.branch, options);
  const filters: DashboardFilters = { ...asked, view: effectiveView(asked.view, views), branch: branch.branch };
  const { now, locale } = ctx;
  const on = (allowed: boolean, inViews: readonly DashboardView[]) => allowed && inViews.includes(filters.view);

  const cards: HomeCards = {};
  if (on(access.lateOrders, ["overview", "warehouse", "support"])) cards.late = settle("late orders", () => lateOrdersAlert(db, actor, locale, now));
  if (on(access.unmatchedPayments, ["overview", "finance"])) cards.unmatched = settle("mismatched payments", () => unmatchedPaymentsAlert(db, actor, now));
  if (on(access.lowStock, ["overview", "warehouse"])) cards.lowStock = settle("low stock", () => lowStockAlert(db, actor, locale));
  if (on(access.criticalTickets, ["overview", "support"])) cards.critical = settle("urgent tickets", () => criticalTicketsAlert(db, actor, now));
  if (on(access.sales, ["overview", "finance"])) cards.sales = settle("sales", () => salesCard(db, actor, filters, now));
  if (on(access.result, ["overview", "finance"])) cards.result = settle("net result", () => resultCard(db, actor, filters, now));
  if (on(access.funnel, ["overview"])) cards.funnel = settle("funnel", () => funnelCard(db, actor, filters, now));
  if (on(access.money, ["finance"])) cards.money = settle("money held", () => moneyCard(db, actor, filters));
  if (on(access.stock, ["warehouse"])) cards.stock = settle("stock", () => stockCard(db, actor, now));
  if (on(access.inbox, ["support"])) cards.inbox = settle("inbox", () => inboxCard(db, actor, now));
  if (on(access.activity, ["overview", "finance"])) cards.activity = settle("activity", () => activityFeed(db, actor, { kind: null, before: null }, FEED_PREVIEW));

  const branchName = branch.branch ? (options.find((option) => option.id === branch.branch)?.name ?? branch.branch) : null;
  const branchChoice: BranchChoice = { options: branch.locked ? [] : options, locked: branch.locked, name: branchName };
  // the lead promises figures only to who gets some (a cashier's home is what waits and their sections)
  const figures = Object.keys(cards).length > 0;
  return { filters, views, overview: access.overview, figures, search: access.search, branch: branchChoice, cards, i18n: messagesFor(ctx.locale, "admin-dashboard") };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.dashboard"));

/** The bell's queues each role view leads with (the overview shows them all). */
const VIEW_QUEUES: Record<Exclude<DashboardView, "overview">, readonly ShellQueueId[]> = {
  finance: ["proofs", "refunds", "pos_shifts", "cod_settlements", "prices", "po_approvals", "invoice_mismatches", "topups", "adjustments", "expenses"],
  warehouse: ["counts", "transfers", "stuck_receipts", "failed_deliveries", "inspections", "tradein_inspections", "used_inspections", "used_listings"],
  support: ["rmas", "privacy_requests"],
};

function Waiting({ waiting, view }: { waiting: ShellWaiting; view: DashboardView }) {
  const at = useAdminT();
  const queues = view === "overview" ? waiting.queues : waiting.queues.filter((queue) => VIEW_QUEUES[view].includes(queue.id));
  const security = view === "overview" ? (waiting.notices[0] ?? null) : null;
  if (view !== "overview" && queues.length === 0) return null;
  return (
    <section className="adm-section" aria-labelledby="home-waiting">
      <h2 id="home-waiting" className="adm-h2">
        {at("home.waitingTitle")}
      </h2>
      {queues.length > 0 ? (
        // one raised card per decision (DESIGN.md §10: raised clay = act on this), the whole card opens the list
        <ul className="dash-queues">
          {queues.map((queue) => (
            <li key={queue.id}>
              <Link to={queue.href} prefetch="intent" className="adm-card adm-card--act dash-queue">
                <span className="type-kpi nums">
                  <bdi>{queue.count}</bdi>
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="type-body text-ink">{at(`notices.${queue.id}`, { count: queue.count })}</span>
                  <span className="type-caption text-ink-2">{at(`modules.${queue.module}`)}</span>
                </span>
                <Icon name="caret-right" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="adm-card">
          <p className="type-strong text-ink">{at("home.nothingWaiting")}</p>
          <p className="type-caption text-ink-2">{at("home.nothingWaitingHint")}</p>
        </div>
      )}
      {security ? (
        <div className="adm-notice adm-notice--warn dash-noprint" role="note">
          <Icon name="shield-check" size={18} />
          <div className="grid gap-2">
            <p className="type-strong text-ink">{security.id === "mfa_off" ? at("home.mfaTitle") : at("notices.recovery_low", { count: security.count ?? 0 })}</p>
            <p className="type-body text-ink">{security.id === "mfa_off" ? at("home.mfaText") : at("home.recoveryText")}</p>
            <div>
              <Key as={Link} to={security.href} size="sm" variant="ink">
                {security.id === "mfa_off" ? at("home.mfaAction") : at("home.recoveryAction")}
              </Key>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Sections({ visible }: { visible: readonly string[] }) {
  const at = useAdminT();
  const allowed = new Set<string>(visible);
  const modules = ADMIN_MODULES.filter((module) => module.slug !== "dashboard" && allowed.has(module.slug)).sort(compareModules);
  return (
    <section className="adm-section dash-noprint" aria-labelledby="home-modules">
      <div className="adm-section__head">
        <h2 id="home-modules" className="adm-h2">
          {at("home.modulesTitle")}
        </h2>
        <p className="type-caption text-ink-2">{at("home.modulesCount", { count: modules.length })}</p>
      </div>
      {modules.length > 0 ? (
        <ul className="adm-grid">
          {modules.map((module) => {
            const counts = statusCounts(module.id);
            return (
              <li key={module.slug}>
                <Link to={module.href} prefetch="intent" className="adm-module-link">
                  <Icon name={module.icon} size={22} />
                  <span className="grid min-w-0 flex-1">
                    <span className="type-strong">{at(`modules.${module.slug}`)}</span>
                    <span className="type-caption text-ink-2">{at("home.moduleProgress", { done: counts.implemented, total: counts.total })}</span>
                  </span>
                  <Icon name="caret-right" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="adm-card">
          <p className="type-body text-ink">{at("home.noModules")}</p>
        </div>
      )}
    </section>
  );
}

function PrintKey() {
  const t = useDashT();
  return (
    <Key type="button" size="sm" icon="printer" className="dash-noprint" onClick={() => window.print()}>
      {t("home.print")}
    </Key>
  );
}

export default function CommandCentre({ loaderData }: Route.ComponentProps) {
  const t = useDashT();
  const at = useAdminT();
  const shell = useAdminShell();
  const { search: here } = useLocation();
  const printed = useRef<HTMLDivElement>(null);
  usePrintInLight(printed);
  const { filters, views, cards } = loaderData;
  const name = shell?.employee.name ?? "";
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  const tiles = (
    [
      ["late_orders", cards.late],
      ["unmatched_payments", cards.unmatched],
      ["low_stock", cards.lowStock],
      ["critical_tickets", cards.critical],
    ] as const
  ).filter((entry): entry is readonly [AlertId, Promise<Streamed<AlertTile>>] => Boolean(entry[1]));
  const timed = Boolean(cards.sales || cards.result || cards.funnel);

  return (
    <div ref={printed} className="dash-print">
      <header className="adm-page-head">
        <p className="adm-eyebrow">{at("modules.dashboard")}</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title min-w-0">{at("home.title", { name: `⁨${firstName}⁩` })}</h1>
          {loaderData.overview ? <PrintKey /> : null}
        </div>
        <p className="max-w-[72ch] type-body text-ink-2">{loaderData.figures ? t("home.lead") : t("home.leadBasic")}</p>
      </header>

      <div className="dash-tools">
        {loaderData.search ? <SearchBox /> : null}
        <ViewTabs filters={filters} views={views} />
        {timed ? <PeriodBar filters={filters} branch={loaderData.branch} /> : null}
      </div>

      {tiles.length > 0 ? (
        <Section id="dash-urgent" title={t("urgent.title")} lead={t("urgent.lead")}>
          <div className="dash-tiles">
            {tiles.map(([id, promise]) => (
              <StreamedCard key={`${id}${here}`} resolve={promise} fallback={<TileLoading id={id} />} failed={<CardFailed title={t(`urgent.${id}.title`)} className="dash-tile" />}>
                {(tile) => <UrgentTile tile={tile} />}
              </StreamedCard>
            ))}
          </div>
        </Section>
      ) : null}

      {shell ? <Waiting waiting={shell.waiting} view={filters.view} /> : null}

      {cards.sales || cards.result ? (
        <Section
          id="dash-sales"
          title={t("sales.title")}
          aside={
            cards.result ? (
              <TextLink as={Link} to="/admin/finance/reports" className="dash-noprint">
                {t("sales.openFinance")}
              </TextLink>
            ) : undefined
          }
        >
          <div className="dash-kpis">
            {cards.sales ? (
              <StreamedCard
                key={`sales${here}`}
                resolve={cards.sales}
                fallback={
                  <>
                    <CardLoading title={t("sales.paidSales")} />
                    <CardLoading title={t("sales.ordersPlaced")} />
                    <CardLoading title={t("sales.openOrders")} />
                    <CardLoading title={t("sales.averageBasket")} />
                  </>
                }
                failed={<CardFailed title={t("sales.title")} />}
              >
                {(data) => <SalesKpis data={data} />}
              </StreamedCard>
            ) : null}
            {cards.result ? (
              <StreamedCard key={`result${here}`} resolve={cards.result} fallback={<CardLoading title={t("sales.net")} />} failed={<CardFailed title={t("sales.net")} />}>
                {(data) => <ResultKpi data={data} />}
              </StreamedCard>
            ) : null}
          </div>
          {filters.branch ? <p className="type-caption text-ink-2">{t("sales.branchNote")}</p> : null}
        </Section>
      ) : null}

      {cards.money ? (
        <Section id="dash-money" title={t("money.title")}>
          <StreamedCard key={`money${here}`} resolve={cards.money} fallback={<CardLoading title={t("money.title")} />} failed={<CardFailed title={t("money.title")} />}>
            {(data) => <MoneyFigures data={data} />}
          </StreamedCard>
        </Section>
      ) : null}

      {cards.stock ? (
        <Section
          id="dash-stock"
          title={t("stock.title")}
          aside={
            <TextLink as={Link} to="/admin/inventory" className="dash-noprint">
              {t("stock.open")}
            </TextLink>
          }
        >
          <StreamedCard key={`stock${here}`} resolve={cards.stock} fallback={<CardLoading title={t("stock.title")} />} failed={<CardFailed title={t("stock.title")} />}>
            {(data) => <StockFigures data={data} withoutLow={Boolean(cards.lowStock)} />}
          </StreamedCard>
        </Section>
      ) : null}

      {cards.inbox ? (
        <Section
          id="dash-inbox"
          title={t("inbox.title")}
          aside={
            <TextLink as={Link} to="/admin/support" className="dash-noprint">
              {t("inbox.open")}
            </TextLink>
          }
        >
          <StreamedCard key={`inbox${here}`} resolve={cards.inbox} fallback={<CardLoading title={t("inbox.title")} />} failed={<CardFailed title={t("inbox.title")} />}>
            {(data) => <InboxFigures data={data} />}
          </StreamedCard>
        </Section>
      ) : null}

      {cards.funnel ? (
        <Section id="dash-funnel" title={t("funnel.title")} lead={t("funnel.lead")}>
          <StreamedCard key={`funnel${here}`} resolve={cards.funnel} fallback={<CardLoading title={t("funnel.title")} />} failed={<CardFailed title={t("funnel.title")} />}>
            {(data) => <FunnelView data={data} />}
          </StreamedCard>
        </Section>
      ) : null}

      {cards.activity ? (
        <Section
          id="dash-activity"
          title={t("activity.title")}
          aside={
            <TextLink as={Link} to="/admin/dashboard/activity" className="dash-noprint">
              {t("activity.more")}
            </TextLink>
          }
        >
          <StreamedCard key={`activity${here}`} resolve={cards.activity} fallback={<CardLoading title={t("activity.title")} />} failed={<CardFailed title={t("activity.title")} />}>
            {(page) => (
              <div className="adm-card">
                {page.lines.length > 0 ? <ActivityList lines={page.lines} /> : <p className="type-body text-ink-2">{page.kinds.length > 0 ? t("activity.empty") : t("activity.none")}</p>}
              </div>
            )}
          </StreamedCard>
        </Section>
      ) : null}

      {filters.view === "overview" && shell ? <Sections visible={shell.modules} /> : null}

      <div className="dash-noprint">
        <ModuleFunctions moduleId="01" />
      </div>
    </div>
  );
}
