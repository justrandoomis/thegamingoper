import { useState } from "react";
import { Form, Link, useNavigate, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/rule";
import { useFormat, useLocale } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { conditionOptions } from "~/server/services/admin/promotions/coupons.server";
import { decideRule, dryRun, getRule, saveRule, setRuleActive, withdrawRuleRequest } from "~/server/services/admin/promotions/discounts.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { CHANNELS, DRY_RUN_DAYS, DRY_RUN_SKIPS, PRODUCT_KIND_OPTIONS, RULE_KINDS, RULE_STATE_TONE, bpsToPercent, parseDryRun, toBaghdadInput, type ConditionOptions, type DryRun, type RuleDetail, type RuleKind } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent, text } from "./promotions.server";
import { Arrow, Boundary, ChoiceList, Code, ConfirmAction, DemoNote, Facts, Failure, History, Kpis, Money, newKey, Notice, Num, Pct, Section, Tag, ToneStatus, useIntent, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/rules/:ruleId — 08.02, one automatic discount rule (":ruleId" = "new" opens the empty form): its
 * terms and conditions, the second person when they go beyond the limits, switching on and off, and the dry run — the
 * recent orders it would have changed and by how much (`?days=7|30|90&demo=1` in the URL), with the margin effect for
 * cost.read + profit.read only.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const creating = params.ruleId === "new";
  const { db, actor, locale, now } = await openPromotions(context, creating ? "promotions.rule.manage" : SECTION_READ.rules);
  const window = parseDryRun(new URL(request.url).searchParams);
  try {
    const [rule, options, run] = await Promise.all([
      creating ? Promise.resolve(null) : getRule(db, actor, params.ruleId, now),
      can(actor, "promotions.rule.manage") || !creating ? conditionOptions(db, locale) : Promise.resolve(null),
      creating ? Promise.resolve(null) : dryRun(db, actor, params.ruleId, window, now),
    ]);
    return { rule, options, run, window };
  } catch (error) {
    throwAsResponse(error);
  }
}

const MULTI = ["platformIds", "categoryIds", "productKinds", "segmentIds", "channels", "tierMinQty", "tierPercent"] as const;

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, SECTION_READ.rules);
  const form = await request.formData();
  const ruleId = params.ruleId === "new" ? undefined : params.ruleId;
  return respond(
    await runIntent(ctx, session, form, { save: ["promotions.rule.manage"], active: ["promotions.rule.manage"], decide: ["promotions.rule.manage", "pricing.discount.override"], withdraw: ["promotions.rule.manage"] }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "save": {
          const result = await saveRule(db, actor, { ...fields(form, MULTI), ruleId }, ctx.now, { demo: ctx.storeMode === "demo" });
          return { ok: true, intent, ...result };
        }
        case "active": {
          const expected = Number(text(form, "expectedUpdatedAt"));
          const result = await setRuleActive(db, actor, { ruleId, active: text(form, "active") === "1", reason: text(form, "reason"), ...(Number.isFinite(expected) && expected > 0 ? { expectedUpdatedAt: expected } : {}) }, ctx.now);
          return { ok: true, intent, ...result };
        }
        case "decide": {
          // only this page's rule: another rule's request id is not found here
          const result = await decideRule(db, actor, { approvalId: text(form, "approvalId"), ruleId: ruleId ?? "new", decision: text(form, "decision"), note: text(form, "note") }, ctx.now);
          return { ok: true, intent, ...result };
        }
        case "withdraw":
          await withdrawRuleRequest(db, actor, { approvalId: text(form, "approvalId"), ruleId: ruleId ?? "new" }, ctx.now);
          return { ok: true, intent };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, args.loaderData?.rule ? null : "rules.newTitle", undefined, args.loaderData?.rule?.name ?? null);

export default function RulePage({ loaderData }: Route.ComponentProps) {
  const program = useProgram();
  const t = usePromotionsT();
  const locale = useLocale();
  const { rule, options, run, window } = loaderData;
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.rules_manage ?? false;
  const back = (
    <p className="adm-eyebrow">
      <Link to="/admin/promotions/rules" className="adm-link">
        {t("rules.title")}
      </Link>
    </p>
  );
  if (!rule) {
    return (
      <>
        <header className="adm-page-head">
          {back}
          <h1 className="adm-title">{t("rules.newTitle")}</h1>
          <p className="max-w-[75ch] type-body text-ink-2">{t("rules.newLead")}</p>
        </header>
        <Boundary>{t("rules.boundary")}</Boundary>
        {options ? <RuleForm options={options} rule={null} /> : null}
      </>
    );
  }
  return (
    <>
      <header className="adm-page-head">
        {back}
        <h1 className="adm-title">{pick(rule.name, locale)}</h1>
        <div className="prm-actions">
          <ToneStatus tone={RULE_STATE_TONE[rule.state]}>{t(`rules.state.${rule.state}`)}</ToneStatus>
          <DemoNote show={rule.isDemo} />
          <span className="type-body text-ink-2">{t(`rules.kind.${rule.terms.kind}`)}</span>
        </div>
      </header>
      <Boundary>{t("rules.boundary")}</Boundary>
      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-rule-terms" title={t("coupons.terms")}>
            <RuleFacts rule={rule} options={options} />
            {rule.approvalReasons.length ? (
              <>
                <div className="prm-tags">
                  {rule.approvalReasons.map((reason) => (
                    <Tag key={reason} icon="seal-check">
                      {t(`reasons.${reason}`, { percent: program.limits.percentBps / 100 })}
                    </Tag>
                  ))}
                </div>
                <Notice icon="seal-check">{rule.approvedTerms ? t("coupons.approvedTerms") : t("rules.needsSecond")}</Notice>
              </>
            ) : null}
          </Section>
          {run ? <DryRunSection run={run} window={window} /> : null}
          {manage && options ? (
            <Disclosure summary={t("rules.edit")} variant="panel">
              <RuleForm options={options} rule={rule} />
            </Disclosure>
          ) : null}
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          <RuleSwitch rule={rule} manage={manage} />
          {rule.pending ? <RulePending rule={rule} /> : null}
          <Section id="prm-rule-history" title={t("common.history")}>
            <History rows={rule.history} />
          </Section>
        </aside>
      </div>
    </>
  );
}

function RuleFacts({ rule, options }: { rule: RuleDetail; options: ConditionOptions | null }) {
  const t = usePromotionsT();
  const locale = useLocale();
  const f = useFormat();
  const terms = rule.terms;
  const nameOf = (list: { id: string; name: string }[] | undefined, id: string) => list?.find((entry) => entry.id === id)?.name ?? id;
  const s = terms.scope;
  const scopeTags = [
    ...s.platformIds.map((id) => nameOf(options?.platforms, id)),
    ...s.categoryIds.map((id) => nameOf(options?.categories, id)),
    ...s.productKinds.map((kind) => t(`kinds.${kind}`)),
    ...s.segmentIds.map((id) => nameOf(options?.segments, id)),
    ...s.channels.map((channel) => t(`channels.${channel}`)),
    ...(s.minSubtotalIqd !== null ? [t("rules.minSubtotalLine", { amount: f.iqd(s.minSubtotalIqd) })] : []),
    ...(s.minQty !== null ? [t("coupons.minQtyLine", { n: s.minQty })] : []),
  ];
  return (
    <Facts
      rows={[
        {
          label: t("rules.f.value"),
          value:
            terms.kind === "percent" ? (
              <Pct bps={terms.value} />
            ) : terms.kind === "fixed" ? (
              <Money iqd={terms.value} />
            ) : terms.kind === "tiered" ? (
              <span className="prm-tags">
                {terms.tiers.map((tier) => (
                  <Tag key={tier.minQty}>{t("rules.tierLine", { qty: tier.minQty, percent: bpsToPercent(tier.bps) })}</Tag>
                ))}
              </span>
            ) : terms.kind === "bogo" && terms.bogo ? (
              t("rules.bogoLine", { buy: terms.bogo.buy, get: terms.bogo.get })
            ) : (
              t("rules.kind.free_shipping")
            ),
        },
        { label: t("coupons.f.maxDiscount"), value: terms.maxDiscountIqd === null ? t("coupons.noCeiling") : <Money iqd={terms.maxDiscountIqd} />, hidden: terms.kind === "fixed" },
        { label: t("rules.f.stack"), value: terms.stackable ? t("rules.stacks") : t("rules.notStacks") },
        { label: t("rules.f.priority"), value: <bdi className="nums">{terms.priority}</bdi> },
        { label: t("coupons.f.window"), value: <>{terms.startsAt ? <When at={terms.startsAt} /> : t("coupons.anyStart")}<Arrow />{terms.endsAt ? <When at={terms.endsAt} /> : t("coupons.noEnd")}</> },
        { label: t("coupons.f.conditions"), value: scopeTags.length ? <span className="prm-tags">{scopeTags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</span> : t("coupons.everyone") },
        { label: t("rules.f.description"), value: rule.description ? pick(rule.description, locale) : "—", hidden: !rule.description },
      ]}
    />
  );
}

function RuleForm({ options, rule }: { options: ConditionOptions; rule: RuleDetail | null }) {
  const t = usePromotionsT();
  const navigate = useNavigate();
  const terms = rule?.terms;
  const [kind, setKind] = useState<RuleKind>(terms?.kind ?? "percent");
  const [formKey] = useState(newKey);
  const { fetcher, pending, message, fields: errors } = useIntent(
    "save",
    (result) => (result.status === "requested" ? "done.requested" : result.status === "unchanged" ? "done.nothing" : rule ? "done.saved" : "done.created"),
    (result) => {
      if (!rule && typeof result.ruleId === "string") navigate(`/admin/promotions/rules/${result.ruleId}`);
    },
  );
  const s = terms?.scope;
  const tiers = terms?.tiers.length ? terms.tiers : [];
  return (
    <fetcher.Form method="post" className="prm-form" noValidate>
      <input type="hidden" name="intent" value="save" />
      {rule ? <input type="hidden" name="expectedUpdatedAt" value={rule.updatedAt} /> : <input type="hidden" name="idempotencyKey" value={formKey} />}
      <div className="prm-grid prm-grid--3">
        <TextField name="nameAr" label={t("rules.f.nameAr")} defaultValue={rule?.name.ar ?? ""} required maxLength={120} error={errors.nameAr} />
        <TextField name="nameEn" label={t("rules.f.nameEn")} defaultValue={rule?.name.en ?? ""} maxLength={120} dir="ltr" error={errors.nameEn} />
        <Select name="kind" label={t("rules.f.kind")} value={kind} onChange={(event) => setKind(event.currentTarget.value as RuleKind)} options={RULE_KINDS.map((entry) => ({ value: entry, label: t(`rules.kind.${entry}`) }))} />
        {kind === "percent" || kind === "fixed" ? (
          <TextField key={kind} name="value" label={kind === "percent" ? t("coupons.f.percent") : t("coupons.f.amount")} defaultValue={terms && terms.kind === kind && terms.value !== null ? (kind === "percent" ? bpsToPercent(terms.value) : String(terms.value)) : ""} inputMode="decimal" required error={errors.value} />
        ) : null}
        {kind === "bogo" ? (
          <>
            <TextField name="buy" label={t("rules.f.buy")} defaultValue={terms?.bogo?.buy ?? ""} inputMode="numeric" error={errors.buy} />
            <TextField name="get" label={t("rules.f.get")} defaultValue={terms?.bogo?.get ?? ""} inputMode="numeric" error={errors.get} />
          </>
        ) : null}
        {kind !== "fixed" ? <TextField name="maxDiscountIqd" label={kind === "free_shipping" ? t("rules.f.maxShipping") : t("coupons.f.maxDiscount")} defaultValue={terms?.maxDiscountIqd ?? ""} inputMode="numeric" error={errors.maxDiscountIqd} /> : null}
        <TextField name="priority" label={t("rules.f.priority")} hint={t("rules.f.priorityHint")} defaultValue={terms?.priority ?? 0} inputMode="numeric" error={errors.priority} />
        <TextField name="startsAt" type="datetime-local" label={t("coupons.f.startsAt")} hint={t("common.baghdadTime")} defaultValue={toBaghdadInput(terms?.startsAt)} error={errors.startsAt} />
        <TextField name="endsAt" type="datetime-local" label={t("coupons.f.endsAt")} hint={t("common.baghdadTime")} defaultValue={toBaghdadInput(terms?.endsAt)} error={errors.endsAt} />
        <div className="grid content-end">
          <Checkbox name="stackable" label={t("rules.f.stack")} hint={t("rules.f.stackHint")} defaultChecked={terms?.stackable ?? false} />
        </div>
      </div>
      {kind === "tiered" ? (
        <fieldset className="prm-form">
          <legend className="adm-h3">{t("rules.f.tiers")}</legend>
          {errors.tiers ? <Failure message={errors.tiers} /> : <p className="type-caption text-ink-2">{t("rules.f.tiersHint")}</p>}
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="grid grid-cols-2 gap-2 sm:max-w-[28rem]">
              <TextField name="tierMinQty" label={t("rules.f.tierQty", { n: index + 1 })} defaultValue={tiers[index]?.minQty ?? ""} inputMode="numeric" />
              <TextField name="tierPercent" label={t("rules.f.tierPercent", { n: index + 1 })} defaultValue={tiers[index] ? bpsToPercent(tiers[index].bps) : ""} inputMode="decimal" />
            </div>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="prm-form">
        <legend className="adm-h3">{t("coupons.f.conditions")}</legend>
        <div className="prm-grid prm-grid--3">
          <ChoiceList name="platformIds" legend={t("coupons.f.platforms")} options={options.platforms.map((entry) => ({ value: entry.id, label: entry.name }))} selected={s?.platformIds ?? []} error={errors.platformIds} />
          <ChoiceList name="categoryIds" legend={t("coupons.f.categories")} hint={t("coupons.f.categoriesHint")} options={options.categories.map((entry) => ({ value: entry.id, label: entry.name, depth: entry.depth }))} selected={s?.categoryIds ?? []} error={errors.categoryIds} />
          <ChoiceList name="productKinds" legend={t("coupons.f.productKinds")} options={PRODUCT_KIND_OPTIONS.map((entry) => ({ value: entry, label: t(`kinds.${entry}`) }))} selected={s?.productKinds ?? []} />
          <ChoiceList name="segmentIds" legend={t("coupons.f.segments")} hint={t("coupons.f.segmentsHint")} options={options.segments.map((entry) => ({ value: entry.id, label: entry.name }))} selected={s?.segmentIds ?? []} error={errors.segmentIds} />
          <ChoiceList name="channels" legend={t("coupons.f.channels")} options={CHANNELS.map((channel) => ({ value: channel, label: t(`channels.${channel}`) }))} selected={s?.channels ?? []} />
          <div className="grid content-start gap-3">
            <TextField name="minSubtotalIqd" label={t("coupons.f.minSubtotal")} defaultValue={s?.minSubtotalIqd ?? ""} inputMode="numeric" error={errors.minSubtotalIqd} />
            <TextField name="minQty" label={t("coupons.f.minQty")} defaultValue={s?.minQty ?? ""} inputMode="numeric" error={errors.minQty} />
          </div>
        </div>
      </fieldset>
      <div className="prm-grid">
        <TextField name="descriptionAr" label={t("rules.f.descriptionAr")} defaultValue={rule?.description?.ar ?? ""} maxLength={300} />
        <TextField name="descriptionEn" label={t("rules.f.descriptionEn")} defaultValue={rule?.description?.en ?? ""} maxLength={300} dir="ltr" />
      </div>
      {rule ? (
        <TextArea name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required rows={2} maxLength={500} error={errors.reason} />
      ) : (
        <>
          <Checkbox name="activate" label={t("rules.f.activate")} hint={t("rules.f.activateHint")} />
          <TextArea name="reason" label={t("coupons.f.why")} hint={t("coupons.f.whyHint")} rows={2} maxLength={500} error={errors.reason} />
        </>
      )}
      <Failure message={message} />
      <div className="prm-actions">
        <Key type="submit" loading={pending} icon={rule ? "floppy-disk" : "plus"}>
          {rule ? t("rules.save") : t("rules.create")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function RuleSwitch({ rule, manage }: { rule: RuleDetail; manage: boolean }) {
  const t = usePromotionsT();
  const needsApproval = !rule.isActive && rule.approvalReasons.length > 0 && !rule.approvedTerms;
  return (
    <div className="prm-panel">
      <p className="adm-h3">{t("coupons.switch.title")}</p>
      <p className="type-body text-ink-2">{rule.isActive ? t("rules.switch.onNow") : t("rules.switch.offNow")}</p>
      {manage ? (
        rule.isActive ? (
          <ConfirmAction intent="active" label={t("rules.switch.off")} title={t("rules.switch.offQ")} consequence={t("rules.switch.offWhat")} confirmLabel={t("rules.switch.off")} values={{ active: "0", expectedUpdatedAt: String(rule.updatedAt) }} tone="destructive" icon="x-circle" doneKey="done.switchedOff" />
        ) : (
          <ConfirmAction
            intent="active"
            label={needsApproval ? t("coupons.switch.request") : t("rules.switch.on")}
            title={needsApproval ? t("coupons.switch.requestQ") : t("rules.switch.onQ")}
            consequence={needsApproval ? t("rules.switch.requestWhat") : t("rules.switch.onWhat")}
            confirmLabel={needsApproval ? t("coupons.switch.request") : t("rules.switch.on")}
            values={{ active: "1", expectedUpdatedAt: String(rule.updatedAt) }}
            icon="check-circle"
            disabled={Boolean(rule.pending)}
            doneKey={(result) => (result.status === "requested" ? "done.requested" : "done.switchedOn")}
          />
        )
      ) : null}
    </div>
  );
}

function RulePending({ rule }: { rule: RuleDetail }) {
  const t = usePromotionsT();
  const pending = rule.pending;
  if (!pending) return null;
  return (
    <div className="prm-panel prm-panel--decide" role="region" aria-label={t("coupons.pending.title")}>
      <p className="adm-h3">{t("coupons.pending.title")}</p>
      <p className="type-body">{t(`coupons.pending.action.${pending.action}`)}</p>
      <p className="type-caption text-ink-2">
        {t("common.requestedBy", { name: pending.requestedByName ?? "—" })} · <When at={pending.requestedAt} />
      </p>
      {pending.reason ? <p className="type-body">{t("common.reasonWas", { reason: pending.reason })}</p> : null}
      {pending.mine ? (
        <>
          <Notice>{t("common.yourRequest")}</Notice>
          <ConfirmAction intent="withdraw" label={t("common.withdraw")} title={t("common.withdrawQ")} consequence={t("rules.pendingWithdrawWhat")} confirmLabel={t("common.withdraw")} values={{ approvalId: pending.approvalId }} reason={false} doneKey="done.withdrawn" />
        </>
      ) : pending.canDecide ? (
        <div className="prm-actions">
          <ConfirmAction intent="decide" label={t("common.approve")} title={t("rules.approveQ")} consequence={t("rules.approveWhat")} confirmLabel={t("common.approve")} values={{ approvalId: pending.approvalId, decision: "approve" }} reasonField="note" reasonLabel={t("common.note")} icon="check-circle" tone="commit" doneKey="done.approved" />
          <ConfirmAction intent="decide" label={t("common.reject")} title={t("coupons.pending.rejectQ")} consequence={t("rules.rejectWhat")} confirmLabel={t("common.reject")} values={{ approvalId: pending.approvalId, decision: "reject" }} reasonField="note" tone="destructive" icon="x-circle" doneKey="done.rejected" />
        </div>
      ) : (
        <Notice>{t("common.decidedBy")}</Notice>
      )}
    </div>
  );
}

function DryRunSection({ run, window }: { run: DryRun; window: { days: number; includeDemo: boolean } }) {
  const t = usePromotionsT();
  const f = useFormat();
  const columns: DataColumn<DryRun["orders"][number]>[] = [
    { key: "ref", header: t("rules.dry.order"), cell: (row) => <span className="inline-flex items-center gap-1"><Code value={row.ref} /><DemoNote show={row.isDemo} /></span> },
    { key: "at", header: t("rules.dry.placed"), cell: (row) => <When at={row.placedAt} style="date" /> },
    { key: "channel", header: t("coupons.f.channels"), cell: (row) => t(`channels.${row.channel}`) },
    { key: "subtotal", header: t("rules.dry.subtotal"), numeric: true, cell: (row) => <Money iqd={row.subtotalIqd} /> },
    { key: "coupon", header: t("rules.dry.coupon"), numeric: true, cell: (row) => <Money iqd={row.existingDiscountIqd} /> },
    { key: "rule", header: t("rules.dry.rule"), numeric: true, cell: (row) => <Money iqd={row.ruleDiscountIqd} /> },
    { key: "change", header: t("rules.dry.change"), numeric: true, cell: (row) => <Money iqd={-(row.changeIqd + row.shippingIqd)} /> },
  ];
  const skips = DRY_RUN_SKIPS.filter((skip) => (run.skips[skip] ?? 0) > 0);
  return (
    <Section id="prm-dry" title={t("rules.dry.title")} lead={t("rules.dry.lead")}>
      <Form method="get" className="flex flex-wrap items-end gap-3">
        <Select name="days" label={t("rules.dry.window")} defaultValue={String(window.days)} options={DRY_RUN_DAYS.map((days) => ({ value: String(days), label: t("rules.dry.days", { count: days }) }))} />
        <Checkbox name="demo" value="1" label={t("rules.dry.includeDemo")} defaultChecked={window.includeDemo} />
        <Key type="submit" icon="arrows-clockwise">
          {t("rules.dry.run")}
        </Key>
      </Form>
      <Kpis
        items={[
          { label: t("rules.dry.scanned"), value: <Num value={run.scanned} />, note: run.truncated ? t("rules.dry.truncated") : undefined },
          { label: t("rules.dry.changed"), value: <Num value={run.changed} /> },
          { label: t("rules.dry.discount"), value: <Money iqd={run.discountIqd} /> },
          { label: t("rules.dry.shipping"), value: <Money iqd={run.shippingDiscountIqd} /> },
        ]}
      />
      {!run.includeDemo && run.demoLeftOut > 0 ? <Notice>{t("rules.dry.demoLeftOut", { count: run.demoLeftOut })}</Notice> : null}
      {skips.length ? (
        <div className="prm-tags" aria-label={t("rules.dry.skipsLabel")}>
          {skips.map((skip) => (
            <Tag key={skip}>{t(`rules.dry.skip.${skip}`, { count: run.skips[skip] ?? 0 })}</Tag>
          ))}
        </div>
      ) : null}
      {run.margin ? (
        <dl className="prm-ledger prm-panel">
          <div>
            <dt>{t("rules.dry.revenueBefore")}</dt>
            <dd>
              <Money iqd={run.margin.revenueBeforeIqd} />
            </dd>
          </div>
          <div>
            <dt>{t("rules.dry.revenueAfter")}</dt>
            <dd>
              <Money iqd={run.margin.revenueAfterIqd} />
            </dd>
          </div>
          <div>
            <dt>{t("rules.dry.cost")}</dt>
            <dd>{run.margin.costIqd === null ? t("rules.dry.costUnknown", { count: run.margin.uncostedLines }) : <Money iqd={run.margin.costIqd} />}</dd>
          </div>
          <div>
            <dt>{t("rules.dry.margin")}</dt>
            <dd>
              {run.margin.marginBeforeBps === null ? "—" : <Pct bps={run.margin.marginBeforeBps} />}<Arrow />{run.margin.marginAfterBps === null ? "—" : <Pct bps={run.margin.marginAfterBps} />}
            </dd>
          </div>
        </dl>
      ) : null}
      {run.orders.length === 0 ? (
        <p className="type-body text-ink-2">{t("rules.dry.none", { days: run.days })}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable caption={t("rules.dry.title")} columns={columns} rows={run.orders} rowKey={(row) => row.ref} maxHeight="28rem" />
          </div>
          <ul className="prm-cards md:hidden">
            {run.orders.map((row) => (
              <li key={row.ref} className="prm-card">
                <span className="prm-card__top">
                  <Code value={row.ref} />
                  <Money iqd={-(row.changeIqd + row.shippingIqd)} className="type-strong" />
                </span>
                <span className="type-caption text-ink-2">{t("rules.dry.cardLine", { subtotal: f.iqd(row.subtotalIqd), coupon: f.iqd(row.existingDiscountIqd) })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Notice>{t("rules.dry.note")}</Notice>
    </Section>
  );
}
