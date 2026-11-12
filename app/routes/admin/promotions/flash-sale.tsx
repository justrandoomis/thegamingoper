import { Link } from "react-router";

import type { Route } from "./+types/flash-sale";
import { useFormat, useLocale } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { throwAsResponse } from "~/server/errors";
import { cancelFlashSale, decideFlashSale, getFlashSale, removeFlashItem, setFlashItem, submitFlashSale, updateFlashSale, withdrawFlashRequest } from "~/server/services/admin/promotions/flash.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { FLASH, FLASH_STATE_TONE, bpsToPercent, toBaghdadInput, type FlashDetail, type FlashItemView } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent, text } from "./promotions.server";
import { Arrow, Boundary, Code, ConfirmAction, DemoNote, Facts, Failure, History, Money, Notice, Num, Pct, Section, Tag, ToneStatus, useArrow, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/flash/:saleId — 08.03, one flash sale: its window, its SKUs (added by SKU or barcode — a scanner
 * types into the field) with the sale price, the allowance and the per-customer limit, each checked by pricing's own
 * rules (what needs a second person; the floor with cost.read, margins with profit.read only), the stock available
 * now and what the sale can still sell; submit, the second person's decision, cancel.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now, locale } = await openPromotions(context, SECTION_READ.flash);
  try {
    return { sale: await getFlashSale(db, actor, params.saleId, now, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, SECTION_READ.flash);
  const form = await request.formData();
  const saleId = params.saleId;
  const manage = ["promotions.flash_sale.manage"] as const;
  return respond(
    await runIntent(ctx, session, form, { update: manage, item: manage, remove: manage, submit: manage, decide: ["promotions.flash_sale.manage", "pricing.price.approve"], withdraw: manage, cancel: manage }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "update":
          return { ok: true, intent, ...(await updateFlashSale(db, actor, { ...fields(form), saleId }, ctx.now)) };
        case "item":
          return { ok: true, intent, ...(await setFlashItem(db, actor, { ...fields(form), saleId }, ctx.now, ctx.locale)) };
        case "remove":
          return { ok: true, intent, ...(await removeFlashItem(db, actor, { saleId, itemId: text(form, "itemId") }, ctx.now)) };
        case "submit":
          return { ok: true, intent, ...(await submitFlashSale(db, actor, { saleId, reason: text(form, "reason") }, ctx.now, ctx.locale)) };
        case "decide":
          return { ok: true, intent, ...(await decideFlashSale(db, actor, { approvalId: text(form, "approvalId"), saleId, decision: text(form, "decision"), note: text(form, "note") }, ctx.now, ctx.locale)) };
        case "withdraw":
          return { ok: true, intent, ...(await withdrawFlashRequest(db, actor, { approvalId: text(form, "approvalId"), saleId }, ctx.now)) };
        case "cancel":
          return { ok: true, intent, ...(await cancelFlashSale(db, actor, { saleId, reason: text(form, "reason") }, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, null, undefined, args.loaderData?.sale.name ?? null);

export default function FlashSalePage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const locale = useLocale();
  const { sale } = loaderData;
  const draft = sale.storedStatus === "draft";
  const editable = draft && !sale.pending && sale.can.manage;
  const problems = sale.items.some((item) => item.problems.length > 0);
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/promotions/flash" className="adm-link">
            {t("flash.title")}
          </Link>
        </p>
        <h1 className="adm-title">{pick(sale.name, locale)}</h1>
        <div className="prm-actions">
          <ToneStatus tone={FLASH_STATE_TONE[sale.state]}>{t(`flash.state.${sale.state}`)}</ToneStatus>
          <DemoNote show={sale.isDemo} />
          <span className="type-body text-ink-2">
            <When at={sale.startsAt} /><Arrow /><When at={sale.endsAt} />
          </span>
        </div>
      </header>
      <Boundary>{t("flash.boundary")}</Boundary>
      {/* the SKUs take the full width: up to eleven columns read badly beside the side column */}
      <ItemsSection sale={sale} editable={editable} />
      <div className={editable ? "prm-layout" : "prm-layout prm-layout--wide"}>
        {editable ? (
          <div className="prm-main">
            <AddItem />
            <Disclosure summary={t("flash.editWindow")} variant="panel">
              <WindowForm sale={sale} />
            </Disclosure>
          </div>
        ) : null}
        <aside className="prm-side" aria-label={t("common.side")}>
          <div className="prm-panel">
            <p className="adm-h3">{t("flash.next.title")}</p>
            <Facts
              rows={[
                { label: t("flash.f.starts"), value: <When at={sale.startsAt} /> },
                { label: t("flash.f.ends"), value: <When at={sale.endsAt} /> },
                { label: t("flash.f.items"), value: <Num value={sale.items.length} /> },
                { label: t("flash.f.createdBy"), value: <>{sale.createdBy ?? t("common.system")} · <When at={sale.createdAt} style="date" /></> },
              ]}
            />
            {draft && !sale.pending && sale.can.manage ? (
              <>
                <p className="type-body text-ink-2">{sale.items.length === 0 ? t("flash.next.empty") : problems ? t("flash.next.problems") : sale.needsApproval ? t("flash.next.needsApproval") : sale.decidedOnSubmit ? t("flash.next.onSubmit") : t("flash.next.direct")}</p>
                <ConfirmAction
                  intent="submit"
                  label={sale.needsApproval ? t("flash.submitRequest") : sale.decidedOnSubmit ? t("flash.submit") : t("flash.submitSchedule")}
                  title={sale.needsApproval ? t("flash.submitRequestQ") : sale.decidedOnSubmit ? t("flash.submitQ") : t("flash.submitScheduleQ")}
                  consequence={sale.needsApproval ? t("flash.submitRequestWhat") : sale.decidedOnSubmit ? t("flash.submitWhat") : t("flash.submitScheduleWhat")}
                  confirmLabel={sale.needsApproval ? t("flash.submitRequest") : sale.decidedOnSubmit ? t("flash.submit") : t("flash.submitSchedule")}
                  impact={[
                    { label: t("flash.f.items"), value: String(sale.items.length) },
                    { label: t("flash.impact.approval"), value: sale.needsApproval ? (sale.needsOverride ? t("flash.impact.override") : t("flash.impact.second")) : sale.decidedOnSubmit ? t("flash.impact.onSubmit") : t("flash.impact.none") },
                  ]}
                  icon="paper-plane-tilt"
                  disabled={sale.items.length === 0 || problems}
                  doneKey={(result) => (result.status === "requested" ? "done.requested" : "done.scheduled")}
                />
              </>
            ) : null}
            {sale.can.manage && (sale.state === "draft" || sale.state === "scheduled" || sale.state === "active" || sale.state === "pending") ? (
              <ConfirmAction
                intent="cancel"
                label={sale.state === "active" ? t("flash.stop") : t("flash.cancel")}
                title={sale.state === "active" ? t("flash.stopQ") : t("flash.cancelQ")}
                consequence={sale.state === "active" ? t("flash.stopWhat") : t("flash.cancelWhat")}
                confirmLabel={sale.state === "active" ? t("flash.stop") : t("flash.cancel")}
                tone="destructive"
                icon="x-circle"
                variant="ghost"
                doneKey="done.cancelled"
              />
            ) : null}
          </div>
          {sale.pending ? <FlashPending sale={sale} /> : null}
          <Section id="prm-flash-history" title={t("common.history")}>
            <History rows={sale.history} />
          </Section>
        </aside>
      </div>
    </>
  );
}

function ItemsSection({ sale, editable }: { sale: FlashDetail; editable: boolean }) {
  const t = usePromotionsT();
  const f = useFormat();
  const columns: DataColumn<FlashItemView>[] = [
    { key: "sku", header: t("flash.i.sku"), cell: (row) => <span className="grid min-w-0"><Code value={row.sku} className="prm-code--keep" /><span className="type-caption text-ink-2 line-clamp-2">{row.name}</span></span> },
    { key: "price", header: t("flash.i.price"), numeric: true, cell: (row) => <Money iqd={row.priceIqd} /> },
    { key: "sale", header: t("flash.i.sale"), numeric: true, cell: (row) => <Money iqd={row.salePriceIqd} className="type-strong" /> },
    {
      key: "cut",
      header: t("flash.i.cut"),
      numeric: true,
      cell: (row) => (
        <span className="grid justify-items-end">
          <Pct bps={row.check.dropBps} />
          {row.check.referencePriceIqd > row.priceIqd ? <span className="type-caption text-ink-2 whitespace-nowrap">{t("flash.i.fromHigh", { price: f.iqd(row.check.referencePriceIqd), cut: `${bpsToPercent(row.check.referenceDropBps ?? 0)}%` })}</span> : null}
        </span>
      ),
    },
    { key: "limit", header: t("flash.i.soldOfAllowance"), numeric: true, cell: (row) => <span className="whitespace-nowrap"><Num value={row.qtySold} /> / {row.qtyLimit === null ? t("flash.i.noLimit") : <Num value={row.qtyLimit} />}</span> },
    { key: "each", header: t("flash.i.perCustomer"), numeric: true, cell: (row) => (row.perCustomerLimit === null ? "—" : <Num value={row.perCustomerLimit} />) },
    { key: "stock", header: t("flash.i.stock"), numeric: true, cell: (row) => <span className="whitespace-nowrap"><Num value={row.available} /> / <Num value={row.canSell} /></span> },
    ...(sale.withProfit ? [{ key: "floor", header: t("flash.i.floor"), numeric: true, cell: (row: FlashItemView) => <Money iqd={row.check.floorIqd ?? null} /> }] : []),
    ...(sale.withProfit ? [{ key: "margin", header: t("flash.i.margin"), numeric: true, cell: (row: FlashItemView) => <span className="whitespace-nowrap"><Pct bps={row.check.marginBeforeBps ?? null} /><Arrow /><Pct bps={row.check.marginAfterBps ?? null} /></span> }] : []),
    { key: "checks", header: t("flash.i.checks"), cell: (row) => <ItemChecks item={row} decidedOnSubmit={sale.decidedOnSubmit} /> },
    ...(editable
      ? [
          {
            key: "remove",
            header: <span className="sr-only">{t("flash.i.remove")}</span>,
            cell: (row: FlashItemView) => (
              <ConfirmAction intent="remove" label={t("flash.i.remove")} title={t("flash.i.removeQ", { sku: row.sku })} consequence={t("flash.i.removeWhat")} confirmLabel={t("flash.i.remove")} values={{ itemId: row.id }} reason={false} variant="ghost" icon="trash" doneKey="done.removed" />
            ),
          },
        ]
      : []),
  ];
  return (
    <Section id="prm-flash-items" title={t("flash.items")} lead={t("flash.itemsLead")}>
      {sale.items.length === 0 ? (
        <p className="type-body text-ink-2">{t("flash.noItems")}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable caption={t("flash.items")} columns={columns} rows={sale.items} rowKey={(row) => row.id} maxHeight={null} />
          </div>
          <ul className="prm-cards md:hidden">
            {sale.items.map((item) => (
              <li key={item.id} className="prm-card">
                <span className="prm-card__top">
                  <Code value={item.sku} />
                  <Money iqd={item.salePriceIqd} className="type-strong" />
                </span>
                <span className="type-caption text-ink-2">{item.name}</span>
                <span className="type-caption">{t("flash.i.cardLine", { price: f.iqd(item.priceIqd), limit: item.qtyLimit ?? "∞", available: item.available, canSell: item.canSell })}</span>
                {item.check.referencePriceIqd > item.priceIqd ? <span className="type-caption text-ink-2">{t("flash.i.fromHigh", { price: f.iqd(item.check.referencePriceIqd), cut: `${bpsToPercent(item.check.referenceDropBps ?? 0)}%` })}</span> : null}
                <ItemChecks item={item} decidedOnSubmit={sale.decidedOnSubmit} />
                {editable ? <ConfirmAction intent="remove" label={t("flash.i.remove")} title={t("flash.i.removeQ", { sku: item.sku })} consequence={t("flash.i.removeWhat")} confirmLabel={t("flash.i.remove")} values={{ itemId: item.id }} reason={false} variant="ghost" icon="trash" doneKey="done.removed" /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {sale.withProfit ? null : <Notice>{t("flash.costHidden")}</Notice>}
    </Section>
  );
}

function ItemChecks({ item, decidedOnSubmit }: { item: FlashItemView; decidedOnSubmit: boolean }) {
  const t = usePromotionsT();
  const tags = [
    ...item.problems.map((problem) => ({ key: problem, text: t(`flash.problem.${problem}`), warn: true })),
    ...item.check.reasons.map((reason) => ({ key: reason, text: t(`pricingReasons.${reason}`), warn: false })),
  ];
  // without profit.read the cost rules are not shown: the server decides when the sale is sent (pricing's rule)
  if (tags.length === 0) return <span className="type-caption text-ink-2">{decidedOnSubmit ? t("flash.checkOnSubmit") : t("flash.noCheck")}</span>;
  return (
    <span className="prm-tags">
      {tags.map((tag) => (
        <Tag key={tag.key} icon={tag.warn ? "warning" : "seal-check"} warn={tag.warn}>
          {tag.text}
        </Tag>
      ))}
    </span>
  );
}

function AddItem() {
  const t = usePromotionsT();
  const { fetcher, pending, message, fields: errors } = useIntent("item", (result) => (result.created ? "done.itemAdded" : "done.itemSaved"));
  return (
    <Section id="prm-flash-add" title={t("flash.add.title")} lead={t("flash.add.lead")}>
      <fetcher.Form method="post" className="prm-form" noValidate>
        <input type="hidden" name="intent" value="item" />
        <div className="prm-grid prm-grid--3">
          <TextField name="code" label={t("flash.add.code")} hint={t("flash.add.codeHint")} required ltr autoComplete="off" error={errors.code} />
          <TextField name="salePrice" label={t("flash.add.price")} hint={t("flash.add.priceHint")} inputMode="numeric" required error={errors.salePrice} />
          <TextField name="qtyLimit" label={t("flash.add.allowance")} hint={t("flash.add.allowanceHint")} inputMode="numeric" error={errors.qtyLimit} />
          <TextField name="perCustomerLimit" label={t("flash.add.perCustomer")} hint={t("flash.add.perCustomerHint", { n: FLASH.maxPerCustomer })} inputMode="numeric" error={errors.perCustomerLimit} />
        </div>
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="plus">
            {t("flash.add.save")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}

function WindowForm({ sale }: { sale: FlashDetail }) {
  const t = usePromotionsT();
  const { fetcher, pending, message, fields: errors } = useIntent("update", (result) => (result.changed ? "done.saved" : "done.nothing"));
  return (
    <fetcher.Form method="post" className="prm-form" noValidate>
      <input type="hidden" name="intent" value="update" />
      <div className="prm-grid">
        <TextField name="nameAr" label={t("flash.f.nameAr")} defaultValue={sale.name.ar} required maxLength={120} error={errors.nameAr} />
        <TextField name="nameEn" label={t("flash.f.nameEn")} defaultValue={sale.name.en ?? ""} maxLength={120} dir="ltr" error={errors.nameEn} />
        <TextField name="startsAt" type="datetime-local" label={t("coupons.f.startsAt")} hint={t("common.baghdadTime")} defaultValue={toBaghdadInput(sale.startsAt)} required error={errors.startsAt} />
        <TextField name="endsAt" type="datetime-local" label={t("coupons.f.endsAt")} hint={t("flash.f.endsHint", { days: FLASH.maxDays })} defaultValue={toBaghdadInput(sale.endsAt)} required error={errors.endsAt} />
      </div>
      <Failure message={message} />
      <div>
        <Key type="submit" loading={pending} icon="floppy-disk">
          {t("flash.saveWindow")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function FlashPending({ sale }: { sale: FlashDetail }) {
  const t = usePromotionsT();
  const f = useFormat();
  const arrow = useArrow();
  const pending = sale.pending;
  if (!pending) return null;
  const blockedByOverride = pending.needsOverride && !sale.can.override;
  return (
    <div className="prm-panel prm-panel--decide" role="region" aria-label={t("coupons.pending.title")}>
      <p className="adm-h3">{t("coupons.pending.title")}</p>
      <p className="type-body">{pending.needsOverride ? t("flash.pending.override") : t("flash.pending.second")}</p>
      <p className="type-caption text-ink-2">
        {t("common.requestedBy", { name: pending.requestedByName ?? "—" })} · <When at={pending.requestedAt} />
      </p>
      {pending.reason ? <p className="type-body">{t("common.reasonWas", { reason: pending.reason })}</p> : null}
      {pending.mine ? (
        <>
          <Notice>{t("common.yourRequest")}</Notice>
          <ConfirmAction intent="withdraw" label={t("common.withdraw")} title={t("common.withdrawQ")} consequence={t("flash.pending.withdrawWhat")} confirmLabel={t("common.withdraw")} values={{ approvalId: pending.approvalId }} reason={false} doneKey="done.withdrawn" />
        </>
      ) : pending.canDecide ? (
        <div className="prm-actions">
          <ConfirmAction
            intent="decide"
            label={t("common.approve")}
            title={t("flash.pending.approveQ")}
            consequence={t("flash.pending.approveWhat", { start: f.dateTime(sale.startsAt) })}
            confirmLabel={t("common.approve")}
            values={{ approvalId: pending.approvalId, decision: "approve" }}
            impact={sale.items.map((item) => ({ label: item.sku, value: `${f.iqd(item.priceIqd)} ${arrow} ${f.iqd(item.salePriceIqd)}`, negative: true }))}
            reasonField="note"
            reasonLabel={t("common.note")}
            icon="check-circle"
            tone="commit"
            doneKey="done.approved"
          />
          <ConfirmAction intent="decide" label={t("common.reject")} title={t("coupons.pending.rejectQ")} consequence={t("flash.pending.rejectWhat")} confirmLabel={t("common.reject")} values={{ approvalId: pending.approvalId, decision: "reject" }} reasonField="note" tone="destructive" icon="x-circle" doneKey="done.rejected" />
        </div>
      ) : (
        <Notice>{blockedByOverride ? t("flash.pending.needsOverride") : t("common.decidedBy")}</Notice>
      )}
    </div>
  );
}
