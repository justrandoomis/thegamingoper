import { useState } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/coupon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { conditionOptions, decideCoupon, getCoupon, saveCoupon, setCouponActive, tryCoupon, withdrawCouponRequest } from "~/server/services/admin/promotions/coupons.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { CHANNELS, COUPON_STATE_TONE, PRODUCT_KIND_OPTIONS, bpsToPercent, toBaghdadInput, type ConditionOptions, type CouponDetail, type CouponTerms } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent, text } from "./promotions.server";
import { Arrow, ChoiceList, Code, ConfirmAction, DemoNote, Facts, Failure, History, Money, Notice, Num, Pct, PhoneText, Section, Tag, ToneStatus, useIntent, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/coupons/:couponId — 08.01, one coupon (":couponId" = "new" opens the empty form): its terms and
 * conditions, why they need a second person (DISCOUNT_LIMITS), the waiting request (approve / reject for someone else
 * holding pricing.discount.override, withdraw for the requester), switching on and off with a reason, "try this
 * coupon" (the commerce core's own evaluateCoupon on a sample cart), the redemptions and the history.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const creating = params.couponId === "new";
  const { db, actor, locale, now } = await openPromotions(context, creating ? "promotions.coupon.manage" : SECTION_READ.coupons);
  try {
    const [coupon, options] = await Promise.all([creating ? Promise.resolve(null) : getCoupon(db, actor, params.couponId, now), can(actor, "promotions.coupon.manage") ? conditionOptions(db, locale) : Promise.resolve(null)]);
    return { coupon, options };
  } catch (error) {
    throwAsResponse(error);
  }
}

const MULTI = ["platformIds", "categoryIds", "productKinds", "segmentIds", "channels"] as const;

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, SECTION_READ.coupons);
  const form = await request.formData();
  const couponId = params.couponId === "new" ? undefined : params.couponId;
  return respond(
    await runIntent(ctx, session, form, { save: ["promotions.coupon.manage"], active: ["promotions.coupon.manage"], decide: ["promotions.coupon.manage", "pricing.discount.override"], withdraw: ["promotions.coupon.manage"], try: [] }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "save": {
          const result = await saveCoupon(db, actor, { ...fields(form, MULTI), couponId }, ctx.now, { demo: ctx.storeMode === "demo" });
          return { ok: true, intent, ...result };
        }
        case "active": {
          const result = await setCouponActive(db, actor, { couponId, active: text(form, "active") === "1", reason: text(form, "reason"), expected: text(form, "expected") || undefined }, ctx.now);
          return { ok: true, intent, ...result };
        }
        case "decide": {
          // only this page's coupon: another coupon's request id is not found here
          const result = await decideCoupon(db, actor, { approvalId: text(form, "approvalId"), couponId: couponId ?? "new", decision: text(form, "decision"), note: text(form, "note") }, ctx.now);
          return { ok: true, intent, ...result };
        }
        case "withdraw":
          await withdrawCouponRequest(db, actor, { approvalId: text(form, "approvalId"), couponId: couponId ?? "new" }, ctx.now);
          return { ok: true, intent };
        case "try": {
          const codes = form.getAll("sku").map(String);
          const qtys = form.getAll("qty").map(String);
          // quantities as typed (Arabic-Indic and Persian digits too): the service reads them
          const lines = codes.map((code, index) => ({ code: code.trim(), qty: (qtys[index] ?? "").trim() })).filter((line) => line.code);
          const result = await tryCoupon(db, actor, { code: text(form, "code"), lines, phone: text(form, "phone") || undefined, channel: text(form, "channel") || "web" }, ctx.now);
          return { ok: true, intent, ...result };
        }
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, null, undefined, args.loaderData?.coupon?.code ?? null);

export default function CouponPage({ loaderData }: Route.ComponentProps) {
  const program = useProgram();
  const t = usePromotionsT();
  const { coupon, options } = loaderData;
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.coupons_manage ?? false;

  if (!coupon) {
    return (
      <>
        <header className="adm-page-head">
          <p className="adm-eyebrow">
            <Link to="/admin/promotions/coupons" className="adm-link">
              {t("coupons.title")}
            </Link>
          </p>
          <h1 className="adm-title">{t("coupons.newTitle")}</h1>
          <p className="max-w-[75ch] type-body text-ink-2">{t("coupons.newLead")}</p>
        </header>
        {options ? <CouponForm options={options} coupon={null} /> : null}
      </>
    );
  }

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/promotions/coupons" className="adm-link">
            {t("coupons.title")}
          </Link>
        </p>
        <h1 className="adm-title">
          <Code value={coupon.code} />
        </h1>
        <div className="prm-actions">
          <ToneStatus tone={COUPON_STATE_TONE[coupon.state]}>{t(`coupons.state.${coupon.state}`)}</ToneStatus>
          <DemoNote show={coupon.isDemo} />
          {coupon.description ? <span className="type-body text-ink-2">{coupon.description}</span> : null}
        </div>
      </header>

      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-terms" title={t("coupons.terms")}>
            <TermsFacts terms={coupon.terms} options={options} />
            {coupon.approvalReasons.length ? (
              <div className="prm-tags">
                {coupon.approvalReasons.map((reason) => (
                  <Tag key={reason} icon="seal-check">
                    {t(`reasons.${reason}`, { percent: program.limits.percentBps / 100 })}
                  </Tag>
                ))}
              </div>
            ) : null}
            {coupon.approvalReasons.length ? <Notice icon="seal-check">{coupon.approvedTerms ? t("coupons.approvedTerms") : t("coupons.needsSecond")}</Notice> : null}
          </Section>

          {manage && options ? (
            <Disclosure summary={t("coupons.edit")} variant="panel" defaultOpen={false}>
              <CouponForm options={options} coupon={coupon} />
            </Disclosure>
          ) : null}

          <Usage coupon={coupon} />
        </div>

        <aside className="prm-side" aria-label={t("common.side")}>
          <SwitchPanel coupon={coupon} manage={manage} />
          {coupon.pending ? <PendingPanel coupon={coupon} options={options} /> : null}
          <TryPanel code={coupon.code} />
          <Section id="prm-history" title={t("common.history")}>
            <History rows={coupon.history} />
          </Section>
        </aside>
      </div>
    </>
  );
}

function TermsFacts({ terms, options }: { terms: CouponTerms; options: ConditionOptions | null }) {
  const t = usePromotionsT();
  const nameOf = (list: { id: string; name: string }[] | undefined, id: string) => list?.find((entry) => entry.id === id)?.name ?? id;
  const c = terms.conditions;
  return (
    <Facts
      rows={[
        { label: t("coupons.f.value"), value: terms.kind === "percent" ? <Pct bps={terms.value} /> : <Money iqd={terms.value} /> },
        { label: t("coupons.f.maxDiscount"), value: terms.kind === "percent" ? (terms.maxDiscountIqd === null ? t("coupons.noCeiling") : <Money iqd={terms.maxDiscountIqd} />) : t("common.notApplicable") },
        { label: t("coupons.f.minSubtotal"), value: terms.minSubtotalIqd === null ? t("common.none") : <Money iqd={terms.minSubtotalIqd} /> },
        { label: t("coupons.f.limits"), value: t("coupons.limitsLine", { total: terms.usageLimit ?? "∞", each: terms.perCustomerLimit ?? "∞" }) },
        { label: t("coupons.f.window"), value: <>{terms.startsAt ? <When at={terms.startsAt} /> : t("coupons.anyStart")}<Arrow />{terms.endsAt ? <When at={terms.endsAt} /> : t("coupons.noEnd")}</> },
        {
          label: t("coupons.f.conditions"),
          value:
            [...c.platformIds, ...c.categoryIds, ...c.productKinds, ...c.segmentIds, ...c.channels, ...c.productIds].length === 0 && !c.firstOrderOnly && c.minQty === null ? (
              t("coupons.everyone")
            ) : (
              <span className="prm-tags">
                {c.platformIds.map((id) => (
                  <Tag key={id}>{nameOf(options?.platforms, id)}</Tag>
                ))}
                {c.categoryIds.map((id) => (
                  <Tag key={id}>{nameOf(options?.categories, id)}</Tag>
                ))}
                {c.productKinds.map((kind) => (
                  <Tag key={kind}>{t(`kinds.${kind}`)}</Tag>
                ))}
                {c.segmentIds.map((id) => (
                  <Tag key={id} icon="users">
                    {nameOf(options?.segments, id)}
                  </Tag>
                ))}
                {c.channels.map((channel) => (
                  <Tag key={channel}>{t(`channels.${channel}`)}</Tag>
                ))}
                {c.productIds.length ? <Tag>{t("coupons.productList", { count: c.productIds.length })}</Tag> : null}
                {c.firstOrderOnly ? <Tag>{t("coupons.f.firstOrderOnly")}</Tag> : null}
                {c.minQty !== null ? <Tag>{t("coupons.minQtyLine", { n: c.minQty })}</Tag> : null}
              </span>
            ),
        },
      ]}
    />
  );
}

function CouponForm({ options, coupon }: { options: ConditionOptions; coupon: CouponDetail | null }) {
  const program = useProgram();
  const t = usePromotionsT();
  const navigate = useNavigate();
  const fmt = useFormat();
  const terms = coupon?.terms;
  const [kind, setKind] = useState<"fixed" | "percent">(terms?.kind ?? "percent");
  const { fetcher, pending, message, fields: errors } = useIntent(
    "save",
    (result) => (result.status === "requested" ? "done.requested" : result.status === "unchanged" ? "done.nothing" : coupon ? "done.saved" : "done.created"),
    (result) => {
      if (!coupon && typeof result.couponId === "string") navigate(`/admin/promotions/coupons/${result.couponId}`);
    },
  );
  const c = terms?.conditions;
  return (
    <fetcher.Form method="post" className="prm-form" noValidate>
      <input type="hidden" name="intent" value="save" />
      {coupon ? <input type="hidden" name="expected" value={coupon.fingerprint} /> : null}
      <div className="prm-grid prm-grid--3">
        {coupon ? null : <TextField name="code" label={t("coupons.f.code")} hint={t("coupons.f.codeHint")} required maxLength={32} ltr autoCapitalize="characters" error={errors.code} />}
        <Select name="kind" label={t("coupons.f.kind")} value={kind} onChange={(event) => setKind(event.currentTarget.value as "fixed" | "percent")} options={[{ value: "percent", label: t("coupons.kind.percent") }, { value: "fixed", label: t("coupons.kind.fixed") }]} />
        <TextField
          key={kind}
          name="value"
          label={kind === "percent" ? t("coupons.f.percent") : t("coupons.f.amount")}
          defaultValue={terms && terms.kind === kind ? (kind === "percent" ? bpsToPercent(terms.value) : String(terms.value)) : ""}
          inputMode="decimal"
          required
          error={errors.value}
        />
        {kind === "percent" ? <TextField name="maxDiscountIqd" label={t("coupons.f.maxDiscount")} hint={t("coupons.f.maxDiscountHint", { amount: fmt.iqd(program.limits.perOrderIqd) })} defaultValue={terms?.maxDiscountIqd ?? ""} inputMode="numeric" error={errors.maxDiscountIqd} /> : null}
        <TextField name="minSubtotalIqd" label={t("coupons.f.minSubtotal")} defaultValue={terms?.minSubtotalIqd ?? ""} inputMode="numeric" error={errors.minSubtotalIqd} />
        <TextField name="usageLimit" label={t("coupons.f.usageLimit")} hint={t("coupons.f.usageLimitHint")} defaultValue={terms?.usageLimit ?? ""} inputMode="numeric" error={errors.usageLimit} />
        <TextField name="perCustomerLimit" label={t("coupons.f.perCustomer")} hint={t("coupons.f.perCustomerHint")} defaultValue={terms?.perCustomerLimit ?? ""} inputMode="numeric" error={errors.perCustomerLimit} />
        <TextField name="startsAt" type="datetime-local" label={t("coupons.f.startsAt")} hint={t("common.baghdadTime")} defaultValue={toBaghdadInput(terms?.startsAt)} error={errors.startsAt} />
        <TextField name="endsAt" type="datetime-local" label={t("coupons.f.endsAt")} hint={t("common.baghdadTime")} defaultValue={toBaghdadInput(terms?.endsAt)} error={errors.endsAt} />
        <TextField name="description" label={t("coupons.f.description")} hint={t("coupons.f.descriptionHint")} defaultValue={coupon?.description ?? ""} maxLength={200} className="prm-span" error={errors.description} />
      </div>
      <fieldset className="prm-form">
        <legend className="adm-h3">{t("coupons.f.conditions")}</legend>
        <p className="type-caption text-ink-2">{t("coupons.f.conditionsHint")}</p>
        <div className="prm-grid prm-grid--3">
          <ChoiceList name="platformIds" legend={t("coupons.f.platforms")} options={options.platforms.map((entry) => ({ value: entry.id, label: entry.name }))} selected={c?.platformIds ?? []} error={errors.platformIds} />
          <ChoiceList name="categoryIds" legend={t("coupons.f.categories")} hint={t("coupons.f.categoriesHint")} options={options.categories.map((entry) => ({ value: entry.id, label: entry.name, depth: entry.depth }))} selected={c?.categoryIds ?? []} error={errors.categoryIds} />
          <ChoiceList name="productKinds" legend={t("coupons.f.productKinds")} options={PRODUCT_KIND_OPTIONS.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) }))} selected={c?.productKinds ?? []} />
          <ChoiceList name="segmentIds" legend={t("coupons.f.segments")} hint={t("coupons.f.segmentsHint")} options={options.segments.map((entry) => ({ value: entry.id, label: entry.name }))} selected={c?.segmentIds ?? []} error={errors.segmentIds} />
          <ChoiceList name="channels" legend={t("coupons.f.channels")} options={CHANNELS.map((channel) => ({ value: channel, label: t(`channels.${channel}`) }))} selected={c?.channels ?? []} />
          <div className="grid content-start gap-3">
            <TextField name="minQty" label={t("coupons.f.minQty")} defaultValue={c?.minQty ?? ""} inputMode="numeric" error={errors.minQty} />
            <Checkbox name="firstOrderOnly" label={t("coupons.f.firstOrderOnly")} defaultChecked={c?.firstOrderOnly ?? false} />
          </div>
        </div>
      </fieldset>
      {coupon ? (
        <TextArea name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required rows={2} maxLength={500} error={errors.reason} />
      ) : (
        <>
          <Checkbox name="activate" label={t("coupons.f.activate")} hint={t("coupons.f.activateHint")} defaultChecked />
          <TextArea name="reason" label={t("coupons.f.why")} hint={t("coupons.f.whyHint")} rows={2} maxLength={500} error={errors.reason} />
        </>
      )}
      <Notice icon="seal-check">{t("coupons.rule", { percent: program.limits.percentBps / 100, amount: fmt.iqd(program.limits.perOrderIqd) })}</Notice>
      <Failure message={message} />
      <div className="prm-actions">
        <Key type="submit" loading={pending} icon={coupon ? "floppy-disk" : "plus"}>
          {coupon ? t("coupons.save") : t("coupons.create")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function SwitchPanel({ coupon, manage }: { coupon: CouponDetail; manage: boolean }) {
  const t = usePromotionsT();
  const needsApproval = !coupon.isActive && coupon.approvalReasons.length > 0 && !coupon.approvedTerms;
  return (
    <div className="prm-panel">
      <p className="adm-h3">{t("coupons.switch.title")}</p>
      <p className="type-body text-ink-2">{coupon.isActive ? t("coupons.switch.onNow") : t("coupons.switch.offNow")}</p>
      {manage ? (
        coupon.isActive ? (
          <ConfirmAction
            intent="active"
            label={t("coupons.switch.off")}
            title={t("coupons.switch.offQ", { code: coupon.code })}
            consequence={t("coupons.switch.offWhat")}
            confirmLabel={t("coupons.switch.off")}
            values={{ active: "0", expected: coupon.fingerprint }}
            impact={[{ label: t("coupons.impact.shoppers"), value: t("coupons.impact.codeStops") }]}
            tone="destructive"
            icon="x-circle"
            doneKey="done.switchedOff"
          />
        ) : (
          <ConfirmAction
            intent="active"
            label={needsApproval ? t("coupons.switch.request") : t("coupons.switch.on")}
            title={needsApproval ? t("coupons.switch.requestQ") : t("coupons.switch.onQ", { code: coupon.code })}
            consequence={needsApproval ? t("coupons.switch.requestWhat") : t("coupons.switch.onWhat")}
            confirmLabel={needsApproval ? t("coupons.switch.request") : t("coupons.switch.on")}
            values={{ active: "1", expected: coupon.fingerprint }}
            impact={[{ label: t("coupons.impact.shoppers"), value: needsApproval ? t("coupons.impact.afterApproval") : t("coupons.impact.codeWorks") }]}
            icon="check-circle"
            disabled={Boolean(coupon.pending)}
            doneKey={(result) => (result.status === "requested" ? "done.requested" : "done.switchedOn")}
          />
        )
      ) : null}
    </div>
  );
}

function PendingPanel({ coupon, options }: { coupon: CouponDetail; options: ConditionOptions | null }) {
  const program = useProgram();
  const t = usePromotionsT();
  const pending = coupon.pending;
  if (!pending) return null;
  return (
    <div className="prm-panel prm-panel--decide" role="region" aria-label={t("coupons.pending.title")}>
      <p className="adm-h3">{t("coupons.pending.title")}</p>
      <p className="type-body">{t(`coupons.pending.action.${pending.action}`)}</p>
      <p className="type-caption text-ink-2">
        {t("common.requestedBy", { name: pending.requestedByName ?? "—" })} · <When at={pending.requestedAt} />
      </p>
      {pending.reason ? <p className="type-body">{t("common.reasonWas", { reason: pending.reason })}</p> : null}
      {pending.terms ? <TermsFacts terms={pending.terms} options={options} /> : null}
      <div className="prm-tags">
        {pending.reasons.map((reason) => (
          <Tag key={reason} icon="seal-check">
            {t(`reasons.${reason}`, { percent: program.limits.percentBps / 100 })}
          </Tag>
        ))}
      </div>
      {pending.mine ? (
        <>
          <Notice>{t("common.yourRequest")}</Notice>
          <ConfirmAction intent="withdraw" label={t("common.withdraw")} title={t("common.withdrawQ")} consequence={t("coupons.pending.withdrawWhat")} confirmLabel={t("common.withdraw")} values={{ approvalId: pending.approvalId }} reason={false} doneKey="done.withdrawn" />
        </>
      ) : pending.canDecide ? (
        <div className="prm-actions">
          <ConfirmAction
            intent="decide"
            label={t("common.approve")}
            title={t("coupons.pending.approveQ", { code: coupon.code })}
            consequence={pending.action === "update" ? t("coupons.pending.approveUpdate") : t("coupons.pending.approveOn")}
            confirmLabel={t("common.approve")}
            values={{ approvalId: pending.approvalId, decision: "approve" }}
            reasonField="note"
            reasonLabel={t("common.note")}
            icon="check-circle"
            tone="commit"
            doneKey="done.approved"
          />
          <ConfirmAction intent="decide" label={t("common.reject")} title={t("coupons.pending.rejectQ")} consequence={t("coupons.pending.rejectWhat")} confirmLabel={t("common.reject")} values={{ approvalId: pending.approvalId, decision: "reject" }} reasonField="note" tone="destructive" icon="x-circle" doneKey="done.rejected" />
        </div>
      ) : (
        <Notice>{t("common.decidedBy")}</Notice>
      )}
    </div>
  );
}

function TryPanel({ code }: { code: string }) {
  const t = usePromotionsT();
  const f = useFormat();
  const { fetcher, pending, message, fields: errors, data } = useIntent("try", "done.tried");
  const result = data?.result as { ok: boolean; discountIqd?: number; label?: string; reason?: string } | undefined;
  const [rows, setRows] = useState(1);
  return (
    <Section id="prm-try" title={t("coupons.try.title")} lead={t("coupons.try.lead")}>
      <fetcher.Form method="post" className="prm-form" noValidate>
        <input type="hidden" name="intent" value="try" />
        <input type="hidden" name="code" value={code} />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
            <TextField name="sku" label={t("coupons.try.sku")} hint={index === 0 ? t("coupons.try.skuHint") : undefined} ltr required={index === 0} error={index === 0 ? errors.lines : undefined} />
            <TextField name="qty" label={t("coupons.try.qty")} defaultValue="1" inputMode="numeric" />
          </div>
        ))}
        {rows < 5 ? (
          <div>
            <Key size="sm" variant="ghost" icon="plus" onClick={() => setRows(rows + 1)}>
              {t("coupons.try.addLine")}
            </Key>
          </div>
        ) : null}
        <TextField name="phone" type="tel" label={t("coupons.try.phone")} hint={t("coupons.try.phoneHint")} error={errors.phone} />
        <Select name="channel" label={t("coupons.f.channels")} options={CHANNELS.map((channel) => ({ value: channel, label: t(`channels.${channel}`) }))} />
        <Failure message={message} />
        <div>
          <Key type="submit" size="sm" loading={pending} icon="magnifying-glass">
            {t("coupons.try.run")}
          </Key>
        </div>
      </fetcher.Form>
      {result ? (
        <div className="prm-panel" aria-live="polite">
          {result.ok ? (
            <p className="type-body">{t("coupons.try.applies", { amount: f.iqd(result.discountIqd ?? 0), subtotal: f.iqd(Number(data?.subtotalIqd ?? 0)) })}</p>
          ) : (
            <p className="type-body">{t("coupons.try.refused", { why: t(`errors.coupon_${result.reason}`) })}</p>
          )}
        </div>
      ) : null}
    </Section>
  );
}

function Usage({ coupon }: { coupon: CouponDetail }) {
  const t = usePromotionsT();
  type Row = CouponDetail["redemptions"][number];
  const columns: DataColumn<Row>[] = [
    { key: "order", header: t("coupons.use.order"), cell: (row) => (row.orderRef ? <Code value={row.orderRef} /> : "—") },
    { key: "customer", header: t("coupons.use.customer"), cell: (row) => <span className="grid">{row.customer ?? t("common.guest")}<span className="type-caption text-ink-2"><PhoneText phone={row.phone} /></span></span> },
    { key: "amount", header: t("coupons.use.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} /> },
    { key: "at", header: t("coupons.use.at"), cell: (row) => <When at={row.at} /> },
    { key: "state", header: t("coupons.use.state"), cell: (row) => (row.voidedAt ? <ToneStatus tone="out">{t("coupons.use.voided")}</ToneStatus> : <ToneStatus tone="ok">{t("coupons.use.counted")}</ToneStatus>) },
  ];
  return (
    <Section id="prm-usage" title={t("coupons.usage")}>
      <Facts
        rows={[
          { label: t("coupons.f.used"), value: <><Num value={coupon.used} />{coupon.terms.usageLimit !== null ? <> / <Num value={coupon.terms.usageLimit} /></> : null}</> },
          { label: t("coupons.f.voided"), value: <Num value={coupon.voided} /> },
          { label: t("coupons.f.given"), value: <Money iqd={coupon.discountGivenIqd} /> },
          { label: t("coupons.f.created"), value: <>{coupon.createdBy ?? t("common.system")} · <When at={coupon.createdAt} /></> },
        ]}
      />
      {coupon.redemptions.length === 0 ? (
        <p className="type-body text-ink-2">{t("coupons.use.none")}</p>
      ) : (
        <DataTable caption={t("coupons.usage")} columns={columns} rows={coupon.redemptions} rowKey={(row) => row.id} maxHeight="24rem" />
      )}
    </Section>
  );
}
