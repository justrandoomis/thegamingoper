import { useState } from "react";
import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";
import { useFormat } from "~/i18n/react";

import type { Route } from "./+types/coupons";
import { throwAsResponse } from "~/server/errors";
import { deactivateCoupons, listCoupons } from "~/server/services/admin/promotions/coupons.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { COUPON_SORTS, COUPON_STATE_TONE, COUPON_VIEWS, DISCOUNT_LIMITS, couponSearch, parseCouponFilters, type CouponRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent, text } from "./promotions.server";
import { Arrow, Code, ConfirmAction, DemoNote, Money, Notice, Num, Pct, Section, ToneStatus, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/coupons — 08.01: every coupon with its state (live, scheduled, waiting for a second person, off,
 * expired, used up), uses against the limit and the discount given (redemptions not voided). Saved views, search and
 * sort in the URL (GET form, works without JavaScript); a dense table from 768px, cards below; switching several off at
 * once (with a reason). The core validates and redeems coupons at checkout — this page never does.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.coupons);
  const filters = parseCouponFilters(new URL(request.url).searchParams);
  try {
    return { page: await listCoupons(db, actor, filters, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.coupon.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { "bulk-off": ["promotions.coupon.manage"] }, async (intent) => {
      const result = await deactivateCoupons(db, session.actor, { couponIds: form.getAll("couponIds").map(String), reason: text(form, "reason") }, ctx.now);
      return { ok: true, intent, ...result };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "coupons.title");

function CouponValue({ row }: { row: Pick<CouponRow, "kind" | "value"> }) {
  return row.kind === "percent" ? <Pct bps={row.value} /> : <Money iqd={row.value} />;
}

export default function CouponsPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const navigation = useNavigation();
  const f = useFormat();
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.coupons_manage ?? false;
  const { page, filters } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/promotions/coupons";
  const filtered = Boolean(filters.q) || filters.view !== "all";

  const columns: DataColumn<CouponRow>[] = [
    {
      key: "code",
      header: t("coupons.col.code"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/promotions/coupons/${row.id}`} className="adm-link">
            <Code value={row.code} />
          </Link>
          {row.description ? <span className="type-caption text-ink-2 line-clamp-1">{row.description}</span> : null}
        </span>
      ),
    },
    {
      key: "state",
      header: t("coupons.col.state"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <ToneStatus tone={COUPON_STATE_TONE[row.state]}>{t(`coupons.state.${row.state}`)}</ToneStatus>
          {row.pending && row.state !== "pending" ? <span className="prm-tag">{t("coupons.editWaiting")}</span> : null}
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "value", header: t("coupons.col.value"), numeric: true, cell: (row) => <CouponValue row={row} /> },
    {
      key: "uses",
      header: t("coupons.col.uses"),
      numeric: true,
      cell: (row) => (
        <span className="whitespace-nowrap">
          <Num value={row.used} />
          {row.usageLimit !== null ? (
            <span className="text-ink-2">
              {" / "}
              <Num value={row.usageLimit} />
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "given", header: t("coupons.col.given"), numeric: true, cell: (row) => <Money iqd={row.discountGivenIqd} /> },
    {
      key: "window",
      header: t("coupons.col.window"),
      cell: (row) => (
        <span className="whitespace-nowrap type-caption">
          {row.startsAt ? <When at={row.startsAt} style="date" /> : t("coupons.anyStart")}<Arrow />{row.endsAt ? <When at={row.endsAt} style="date" /> : t("coupons.noEnd")}
        </span>
      ),
    },
    { key: "created", header: t("coupons.col.created"), cell: (row) => <span className="whitespace-nowrap"><When at={row.createdAt} style="date" /></span> },
  ];

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.01" })}</p>
        <h1 className="adm-title">{t("coupons.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("coupons.lead", { percent: DISCOUNT_LIMITS.percentBps / 100, amount: f.iqd(DISCOUNT_LIMITS.perOrderIqd) })}</p>
        {manage ? (
          <div className="prm-actions">
            <Key as={Link} to="/admin/promotions/coupons/new" icon="plus">
              {t("coupons.new")}
            </Key>
          </div>
        ) : null}
      </header>

      <Section id="prm-coupons" title={t("coupons.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {COUPON_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/promotions/coupons${couponSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`coupons.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("common.filters")} variant="panel" defaultOpen={Boolean(filters.q) || filters.sort !== "newest"}>
          <Form method="get" action="/admin/promotions/coupons" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" label={t("coupons.search")} hint={t("coupons.searchHint")} defaultValue={filters.q} type="search" maxLength={40} />
            <Select name="sort" label={t("common.sort")} defaultValue={filters.sort} options={COUPON_SORTS.map((sort) => ({ value: sort, label: t(`coupons.sorts.${sort}`) }))} />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
              <Key type="submit" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/promotions/coupons">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("coupons.emptyFiltered") : t("coupons.empty")}
            text={filtered ? t("common.emptyFilteredHint") : manage ? t("coupons.emptyHint") : t("coupons.emptyHintRead")}
            icon="ticket"
            action={
              filtered ? (
                <Key as={Link} to="/admin/promotions/coupons">
                  {t("common.clear")}
                </Key>
              ) : manage ? (
                <Key as={Link} to="/admin/promotions/coupons/new" icon="plus">
                  {t("coupons.new")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("coupons.listTitle")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.code}
                busy={busy}
                maxHeight={null}
                {...(manage
                  ? {
                      selected,
                      onSelectedChange: setSelected,
                      bulkActions: (ids: readonly string[]) => (
                        <ConfirmAction
                          intent="bulk-off"
                          label={t("coupons.bulkOff", { count: ids.length })}
                          title={t("coupons.bulkOffQ", { count: ids.length })}
                          consequence={t("coupons.bulkOffWhat")}
                          confirmLabel={t("coupons.bulkOffConfirm")}
                          values={{ couponIds: [...ids] }}
                          impact={[{ label: t("coupons.impact.shoppers"), value: t("coupons.impact.codesStop", { count: ids.length }) }]}
                          tone="destructive"
                          icon="x-circle"
                          doneKey={(result) => (Number(result.changed) > 0 ? "done.bulkOff" : "done.nothing")}
                          onDone={() => setSelected([])}
                        />
                      ),
                    }
                  : {})}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => couponSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="prm-cards" aria-label={t("coupons.listTitle")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <Link to={`/admin/promotions/coupons/${row.id}`} className="prm-card">
                      <span className="prm-card__top">
                        <Code value={row.code} />
                        <ToneStatus tone={COUPON_STATE_TONE[row.state]}>{t(`coupons.state.${row.state}`)}</ToneStatus>
                      </span>
                      <span className="prm-card__top type-body">
                        <CouponValue row={row} />
                        <span className="text-ink-2">{t("coupons.usesLine", { used: row.used, limit: row.usageLimit ?? "∞" })}</span>
                      </span>
                      {row.description ? <span className="type-caption text-ink-2">{row.description}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => couponSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
        <Notice icon="seal-check">{t("coupons.rule", { percent: DISCOUNT_LIMITS.percentBps / 100, amount: f.iqd(DISCOUNT_LIMITS.perOrderIqd) })}</Notice>
      </Section>
    </>
  );
}
