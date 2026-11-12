import { useRef } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/experiment";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { couponChoices } from "~/server/services/admin/promotions/coupons.server";
import { completeExperiment, getExperiment, pauseExperiment, resumeExperiment, saveExperiment, startExperiment } from "~/server/services/admin/promotions/experiments.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { EXPERIMENT, EXPERIMENT_METRICS, EXPERIMENT_STATUS_TONE, METRIC_BETTER, baghdadDay, type ExperimentDetail, type VariantResult } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent, text } from "./promotions.server";
import { Boundary, Code, ConfirmAction, Facts, Failure, History, Money, Notice, Num, Pct, Section, Tag, ToneStatus, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/experiments/:experimentId — 08.08, one A/B test: the measurement rule (metric, minimum orders per
 * variant, planned end) written before it starts, what still stops it from starting, the results per variant from
 * real orders (`?demo=1` adds demo orders, labelled), the decision rule's state (a leader is named only when every
 * variant has its minimum — a reading, not a significance test), and start / pause / resume / complete.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.experiments);
  const includeDemo = new URL(request.url).searchParams.get("demo") === "1";
  try {
    const [experiment, coupons] = await Promise.all([getExperiment(db, actor, params.experimentId, now, { includeDemo }), can(actor, "promotions.experiment.manage") ? couponChoices(db, actor, now) : Promise.resolve([])]);
    return { experiment, coupons };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.experiment.manage");
  const form = await request.formData();
  const experimentId = params.experimentId;
  const manage = ["promotions.experiment.manage"] as const;
  return respond(
    await runIntent(ctx, session, form, { save: manage, start: manage, pause: manage, resume: manage, complete: manage }, async (intent) => {
      const { actor } = session;
      const reason = text(form, "reason");
      switch (intent) {
        case "save":
          return { ok: true, intent, ...(await saveExperiment(db, actor, { ...fields(form, ["couponIds"]), experimentId }, ctx.now)) };
        case "start":
          return { ok: true, intent, ...(await startExperiment(db, actor, { experimentId, reason }, ctx.now)) };
        case "pause":
          return { ok: true, intent, ...(await pauseExperiment(db, actor, { experimentId, reason }, ctx.now)) };
        case "resume":
          return { ok: true, intent, ...(await resumeExperiment(db, actor, { experimentId, reason }, ctx.now)) };
        case "complete":
          return { ok: true, intent, ...(await completeExperiment(db, actor, { experimentId, winner: text(form, "winner"), reason }, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, null, undefined, args.loaderData?.experiment.name ?? null);

export default function ExperimentPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const { experiment, coupons } = loaderData;
  const manage = experiment.can.manage;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/promotions/experiments" className="adm-link">
            {t("ab.title")}
          </Link>
        </p>
        <h1 className="adm-title">{experiment.name}</h1>
        <div className="prm-actions">
          <ToneStatus tone={EXPERIMENT_STATUS_TONE[experiment.status]}>{t(`ab.status.${experiment.status}`)}</ToneStatus>
          <Code value={experiment.key} className="type-caption text-ink-2" />
          {experiment.winner ? <Tag icon="star">{t("ab.winnerIs", { key: experiment.winner })}</Tag> : null}
        </div>
        {experiment.description ? <p className="max-w-[75ch] type-body text-ink-2">{experiment.description}</p> : null}
      </header>
      <Boundary>{t("ab.boundary")}</Boundary>
      <div className="prm-layout">
        <div className="prm-main">
          <Results experiment={experiment} />
          {manage && experiment.status === "draft" ? (
            <Disclosure summary={t("ab.editDraft")} variant="panel" defaultOpen={experiment.problems.length > 0}>
              <DraftForm experiment={experiment} coupons={coupons} />
            </Disclosure>
          ) : null}
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          <RulePanel experiment={experiment} />
          {manage ? <Controls experiment={experiment} /> : null}
          <Section id="prm-ab-history" title={t("common.history")}>
            <History rows={experiment.history} />
          </Section>
        </aside>
      </div>
    </>
  );
}

function RulePanel({ experiment }: { experiment: ExperimentDetail }) {
  const t = usePromotionsT();
  return (
    <div className={experiment.problems.length ? "prm-panel prm-panel--decide" : "prm-panel"}>
      <p className="adm-h3">{t("ab.rule.title")}</p>
      <Facts
        rows={[
          { label: t("ab.rule.metric"), value: experiment.primaryMetric ? `${t(`ab.metric.${experiment.primaryMetric}`)} · ${t(`ab.better.${METRIC_BETTER[experiment.primaryMetric]}`)}` : "—" },
          { label: t("ab.rule.sample"), value: experiment.minSample === null ? "—" : t("ab.rule.sampleValue", { n: experiment.minSample }) },
          { label: t("ab.rule.end"), value: experiment.plannedEnd ? <When at={experiment.plannedEnd} style="date" /> : experiment.endsAt && experiment.status === "completed" ? <When at={experiment.endsAt} /> : "—" },
          { label: t("ab.rule.started"), value: experiment.startsAt ? <When at={experiment.startsAt} /> : "—" },
        ]}
      />
      {experiment.problems.length ? (
        <ul className="grid gap-1">
          {experiment.problems.map((problem) => (
            <li key={problem}>
              <Notice tone="warn" icon="warning">
                {t(`ab.problem.${problem}`, { n: EXPERIMENT.minSampleFloor })}
              </Notice>
            </li>
          ))}
        </ul>
      ) : null}
      <Notice>{t("ab.rule.decision")}</Notice>
    </div>
  );
}

function Results({ experiment }: { experiment: ExperimentDetail }) {
  const t = usePromotionsT();
  const columns: DataColumn<VariantResult>[] = [
    {
      key: "variant",
      header: t("ab.r.variant"),
      width: "13rem",
      cell: (row) => (
        <span className="grid gap-1 py-1">
          <span className="whitespace-nowrap">{t("ab.variant", { key: row.key })}</span>
          {row.couponCode ? <Code value={row.couponCode} className="whitespace-nowrap" /> : null}
          {experiment.decision.leader === row.key ? <Tag icon="trend-up">{t("ab.r.leader")}</Tag> : null}
        </span>
      ),
    },
    { key: "orders", header: t("ab.r.orders"), numeric: true, cell: (row) => <Num value={row.orders} /> },
    { key: "net", header: t("ab.r.net"), numeric: true, cell: (row) => <Money iqd={row.netRevenueIqd} /> },
    { key: "avg", header: t("ab.r.avg"), numeric: true, cell: (row) => <Money iqd={row.avgOrderIqd} /> },
    { key: "discount", header: t("ab.r.discount"), numeric: true, cell: (row) => <Money iqd={row.discountPerOrderIqd} /> },
    { key: "refunds", header: t("ab.r.refunds"), numeric: true, cell: (row) => <Pct bps={row.refundRateBps} /> },
  ];
  const decision = experiment.decision;
  return (
    <Section id="prm-ab-results" title={t("ab.r.title")} lead={experiment.startsAt ? t("ab.r.lead") : t("ab.r.notStarted")}>
      <Form method="get" className="flex flex-wrap items-end gap-3">
        <Checkbox name="demo" value="1" label={t("ab.r.includeDemo")} defaultChecked={experiment.includeDemo} />
        <Key type="submit" size="sm" icon="arrows-clockwise">
          {t("common.apply")}
        </Key>
      </Form>
      <DataTable caption={t("ab.r.title")} columns={columns} rows={experiment.results} rowKey={(row) => row.key} maxHeight={null} />
      {decision.ready ? (
        <Notice icon="seal-check">{decision.leader ? t("ab.r.ready", { key: decision.leader }) : t("ab.r.tie")}</Notice>
      ) : decision.short.length ? (
        <Notice icon="hourglass">{t("ab.r.short", { list: decision.short.map((entry) => t("ab.r.shortItem", { key: entry.key, n: entry.missing })).join("، ") })}</Notice>
      ) : null}
      <Notice icon="info">{t("ab.r.visitors", { n: experiment.visitorEvents })}</Notice>
    </Section>
  );
}

function Controls({ experiment }: { experiment: ExperimentDetail }) {
  const t = usePromotionsT();
  const winnerRef = useRef<HTMLSelectElement | null>(null);
  const status = experiment.status;
  return (
    <div className="prm-panel">
      <p className="adm-h3">{t("ab.c.title")}</p>
      <div className="prm-actions">
        {status === "draft" ? <ConfirmAction intent="start" label={t("ab.c.start")} title={t("ab.c.startQ")} consequence={t("ab.c.startWhat")} confirmLabel={t("ab.c.start")} disabled={experiment.problems.length > 0} icon="arrow-right" doneKey="done.started" /> : null}
        {status === "running" ? <ConfirmAction intent="pause" label={t("ab.c.pause")} title={t("ab.c.pauseQ")} consequence={t("ab.c.pauseWhat")} confirmLabel={t("ab.c.pause")} icon="hourglass" doneKey="done.paused" /> : null}
        {status === "paused" ? <ConfirmAction intent="resume" label={t("ab.c.resume")} title={t("ab.c.resumeQ")} consequence={t("ab.c.resumeWhat")} confirmLabel={t("ab.c.resume")} icon="arrows-clockwise" doneKey="done.resumed" /> : null}
        {status === "running" || status === "paused" ? (
          <ConfirmAction intent="complete" label={t("ab.c.complete")} title={t("ab.c.completeQ")} consequence={experiment.decision.ready ? t("ab.c.completeReady") : t("ab.c.completeNotReady")} confirmLabel={t("ab.c.complete")} extra={() => ({ winner: winnerRef.current?.value ?? "" })} icon="flag" doneKey="done.completed">
            <Select
              ref={winnerRef}
              name="winner"
              label={t("ab.c.winner")}
              hint={experiment.decision.ready ? t("ab.c.winnerHint") : t("ab.c.winnerLocked")}
              options={[{ value: "", label: t("ab.c.noWinner") }, ...(experiment.decision.ready && experiment.decision.leader ? [{ value: experiment.decision.leader, label: t("ab.variant", { key: experiment.decision.leader }) }] : [])]}
            />
          </ConfirmAction>
        ) : null}
      </div>
      {status === "draft" && experiment.problems.length > 0 ? <p className="type-caption text-ink-2">{t("ab.c.startBlocked")}</p> : null}
    </div>
  );
}

function DraftForm({ experiment, coupons }: { experiment: ExperimentDetail; coupons: { id: string; code: string; state: string }[] }) {
  const t = usePromotionsT();
  const { fetcher, pending, message, fields: errors } = useIntent("save", "done.saved");
  const options = [{ value: "", label: t("ab.pickCoupon") }, ...coupons.map((coupon) => ({ value: coupon.id, label: `${coupon.code} · ${t(`coupons.state.${coupon.state}`)}` }))];
  return (
    <fetcher.Form method="post" className="prm-form" noValidate>
      <input type="hidden" name="intent" value="save" />
      <div className="prm-grid">
        <TextField name="name" label={t("ab.f.name")} defaultValue={experiment.name} required maxLength={120} error={errors.name} />
        <TextField name="key" label={t("ab.f.key")} defaultValue={experiment.key} required ltr maxLength={40} error={errors.key} />
        {Array.from({ length: EXPERIMENT.maxVariants }, (_, index) => (
          <Select key={index} name="couponIds" label={t("ab.f.variant", { key: String.fromCharCode(65 + index) })} defaultValue={experiment.variants[index]?.couponId ?? ""} options={options} error={index === 0 ? errors.couponIds : undefined} />
        ))}
        <Select name="metric" label={t("ab.rule.metric")} hint={t("ab.f.metricHint")} defaultValue={experiment.primaryMetric ?? ""} options={[{ value: "", label: t("ab.f.pickMetric") }, ...EXPERIMENT_METRICS.map((metric) => ({ value: metric, label: `${t(`ab.metric.${metric}`)} (${t(`ab.better.${METRIC_BETTER[metric]}`)})` }))]} error={errors.metric} />
        <TextField name="minOrders" label={t("ab.rule.sample")} hint={t("ab.f.sampleHint", { min: EXPERIMENT.minSampleFloor, n: EXPERIMENT.minSampleDefault })} defaultValue={experiment.minSample ?? ""} inputMode="numeric" error={errors.minOrders} />
        <TextField name="plannedEnd" type="date" label={t("ab.rule.end")} hint={t("ab.f.endHint", { days: EXPERIMENT.maxDays })} defaultValue={experiment.plannedEnd ? baghdadDay(experiment.plannedEnd) : ""} error={errors.plannedEnd} />
        <TextArea name="description" label={t("ab.f.description")} defaultValue={experiment.description ?? ""} rows={2} maxLength={600} className="prm-span" />
      </div>
      <Failure message={message} />
      <div>
        <Key type="submit" loading={pending} icon="floppy-disk">
          {t("ab.save")}
        </Key>
      </div>
    </fetcher.Form>
  );
}
