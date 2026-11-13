import { Form, Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/rules";
import { throwAsResponse } from "~/server/errors";
import { listRules } from "~/server/services/admin/promotions/discounts.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { RULE_STATE_TONE, RULE_VIEWS, parseRuleFilters, ruleSearch, type RuleRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { openPromotions } from "./promotions.server";
import { Arrow, DemoNote, Money, Pct, SectionState, Section, ToneStatus, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/rules — 08.02: the automatic discount rules (no code needed) with their state, kind, priority and
 * window; views and search in the URL. The online checkout applies the rules that are on (the note says so, and that
 * the till does not: checkout-state.ts); each rule's page shows what it would have done to the recent orders.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now, locale } = await openPromotions(context, SECTION_READ.rules);
  const filters = parseRuleFilters(new URL(request.url).searchParams);
  try {
    return { page: await listRules(db, actor, filters, now, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "rules.title");

function RuleValue({ row }: { row: Pick<RuleRow, "kind" | "value"> }) {
  const t = usePromotionsT();
  if (row.kind === "percent") return <Pct bps={row.value} />;
  if (row.kind === "fixed") return <Money iqd={row.value} />;
  return <span>{t(`rules.kind.${row.kind}`)}</span>;
}

export default function RulesPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.rules_manage ?? false;
  const { page, filters } = loaderData;
  const filtered = Boolean(filters.q) || filters.view !== "all";
  const columns: DataColumn<RuleRow>[] = [
    {
      key: "name",
      header: t("rules.col.name"),
      cell: (row) => (
        <Link to={`/admin/promotions/rules/${row.id}`} className="adm-link">
          {row.name}
        </Link>
      ),
    },
    {
      key: "state",
      header: t("rules.col.state"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <ToneStatus tone={RULE_STATE_TONE[row.state]}>{t(`rules.state.${row.state}`)}</ToneStatus>
          {row.pending && row.state !== "pending" ? <span className="prm-tag">{t("coupons.editWaiting")}</span> : null}
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "kind", header: t("rules.col.kind"), cell: (row) => t(`rules.kind.${row.kind}`) },
    { key: "value", header: t("rules.col.value"), numeric: true, cell: (row) => <RuleValue row={row} /> },
    { key: "stack", header: t("rules.col.stack"), cell: (row) => (row.stackable ? t("rules.stacks") : t("rules.notStacks")) },
    { key: "priority", header: t("rules.col.priority"), numeric: true, cell: (row) => <bdi className="nums">{row.priority}</bdi> },
    { key: "window", header: t("rules.col.window"), cell: (row) => <span className="whitespace-nowrap type-caption">{row.startsAt ? <When at={row.startsAt} style="date" /> : t("coupons.anyStart")}<Arrow />{row.endsAt ? <When at={row.endsAt} style="date" /> : t("coupons.noEnd")}</span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.02" })}</p>
        <h1 className="adm-title">{t("rules.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("rules.lead")}</p>
        {manage ? (
          <div className="prm-actions">
            <Key as={Link} to="/admin/promotions/rules/new" icon="plus">
              {t("rules.new")}
            </Key>
          </div>
        ) : null}
      </header>
      <SectionState id="rules" />
      <Section id="prm-rules" title={t("rules.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {RULE_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/promotions/rules${ruleSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`rules.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
              </Key>
            );
          })}
        </nav>
        <Form method="get" action="/admin/promotions/rules" className="flex flex-wrap items-end gap-2">
          {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <TextField name="q" label={t("rules.search")} defaultValue={filters.q} type="search" maxLength={40} className="min-w-[14rem] flex-1" />
          <Key type="submit" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: page.total })}
        </p>
        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("rules.emptyFiltered") : t("rules.empty")}
            text={filtered ? t("common.emptyFilteredHint") : t("rules.emptyHint")}
            icon="percent"
            action={
              filtered ? (
                <Key as={Link} to="/admin/promotions/rules">
                  {t("common.clear")}
                </Key>
              ) : manage ? (
                <Key as={Link} to="/admin/promotions/rules/new" icon="plus">
                  {t("rules.new")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("rules.listTitle")} columns={columns} rows={page.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => ruleSearch({ ...filters, page: n }) || "?"} />} />
            </div>
            <ul className="prm-cards md:hidden" aria-label={t("rules.listTitle")}>
              {page.rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/promotions/rules/${row.id}`} className="prm-card">
                    <span className="prm-card__top">
                      <span className="type-strong">{row.name}</span>
                      <ToneStatus tone={RULE_STATE_TONE[row.state]}>{t(`rules.state.${row.state}`)}</ToneStatus>
                    </span>
                    <span className="prm-card__top type-body text-ink-2">
                      <span>{t(`rules.kind.${row.kind}`)}</span>
                      <RuleValue row={row} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
