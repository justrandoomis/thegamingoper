import { useState } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/flash";
import { throwAsResponse } from "~/server/errors";
import { createFlashSale, listFlashSales } from "~/server/services/admin/promotions/flash.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { FLASH, FLASH_STATE_TONE, FLASH_VIEWS, flashSearch, parseFlashFilters, type FlashRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent } from "./promotions.server";
import { Arrow, Boundary, DemoNote, Failure, newKey, Num, Section, ToneStatus, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/flash — 08.03: flash sales with their window (Baghdad time), state (draft, waiting for a second
 * person, scheduled, running, ended), SKUs, allowance and units sold; a new sale starts as a draft here, its SKUs and
 * prices are set on its own page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now, locale } = await openPromotions(context, SECTION_READ.flash);
  const filters = parseFlashFilters(new URL(request.url).searchParams);
  try {
    return { page: await listFlashSales(db, actor, filters, now, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.flash_sale.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { create: ["promotions.flash_sale.manage"] }, async (intent) => {
      const result = await createFlashSale(db, session.actor, fields(form), ctx.now, { demo: ctx.storeMode === "demo" });
      return { ok: true, intent, ...result };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "flash.title");

export default function FlashPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.flash_manage ?? false;
  const { page, filters } = loaderData;
  const columns: DataColumn<FlashRow>[] = [
    {
      key: "name",
      header: t("flash.col.name"),
      cell: (row) => (
        <Link to={`/admin/promotions/flash/${row.id}`} className="adm-link">
          {row.name}
        </Link>
      ),
    },
    {
      key: "state",
      header: t("flash.col.state"),
      cell: (row) => (
        <span className="inline-flex items-center gap-1">
          <ToneStatus tone={FLASH_STATE_TONE[row.state]}>{t(`flash.state.${row.state}`)}</ToneStatus>
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "starts", header: t("flash.col.starts"), cell: (row) => <When at={row.startsAt} /> },
    { key: "ends", header: t("flash.col.ends"), cell: (row) => <When at={row.endsAt} /> },
    { key: "items", header: t("flash.col.items"), numeric: true, cell: (row) => <Num value={row.items} /> },
    { key: "sold", header: t("flash.col.sold"), numeric: true, cell: (row) => <span className="whitespace-nowrap"><Num value={row.sold} />{row.allowance !== null ? <span className="text-ink-2"> / <Num value={row.allowance} /></span> : null}</span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.03" })}</p>
        <h1 className="adm-title">{t("flash.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("flash.lead")}</p>
      </header>
      <Boundary>{t("flash.boundary")}</Boundary>
      {manage ? (
        <div className="prm-block">
          <CreateSale />
        </div>
      ) : null}
      <Section id="prm-flash" title={t("flash.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {FLASH_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/promotions/flash${flashSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`flash.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
              </Key>
            );
          })}
        </nav>
        {page.rows.length === 0 ? (
          <EmptyState title={filters.view === "all" ? t("flash.empty") : t("flash.emptyFiltered")} text={filters.view === "all" ? t("flash.emptyHint") : t("common.emptyFilteredHint")} icon="lightning" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("flash.listTitle")} columns={columns} rows={page.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => flashSearch({ ...filters, page: n }) || "?"} />} />
            </div>
            <ul className="prm-cards md:hidden" aria-label={t("flash.listTitle")}>
              {page.rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/promotions/flash/${row.id}`} className="prm-card">
                    <span className="prm-card__top">
                      <span className="type-strong">{row.name}</span>
                      <ToneStatus tone={FLASH_STATE_TONE[row.state]}>{t(`flash.state.${row.state}`)}</ToneStatus>
                    </span>
                    <span className="type-caption text-ink-2">
                      <When at={row.startsAt} /><Arrow /><When at={row.endsAt} />
                    </span>
                    <span className="type-body">{t("flash.cardLine", { items: row.items, sold: row.sold })}</span>
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

function CreateSale() {
  const t = usePromotionsT();
  const navigate = useNavigate();
  const [formKey] = useState(newKey);
  const { fetcher, pending, message, fields: errors } = useIntent("create", "done.created", (result) => {
    if (typeof result.saleId === "string") navigate(`/admin/promotions/flash/${result.saleId}`);
  });
  return (
    <Disclosure summary={t("flash.new")} variant="panel">
      <fetcher.Form method="post" className="prm-form" noValidate>
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <div className="prm-grid">
          <TextField name="nameAr" label={t("flash.f.nameAr")} required maxLength={120} error={errors.nameAr} />
          <TextField name="nameEn" label={t("flash.f.nameEn")} maxLength={120} ltr lang="en" error={errors.nameEn} />
          <TextField name="startsAt" type="datetime-local" label={t("coupons.f.startsAt")} hint={t("common.baghdadTime")} required error={errors.startsAt} />
          <TextField name="endsAt" type="datetime-local" label={t("coupons.f.endsAt")} hint={t("flash.f.endsHint", { days: FLASH.maxDays })} required error={errors.endsAt} />
        </div>
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="plus">
            {t("flash.create")}
          </Key>
        </div>
      </fetcher.Form>
    </Disclosure>
  );
}
