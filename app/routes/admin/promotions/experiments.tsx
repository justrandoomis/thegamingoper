import { useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/experiments";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { couponChoices } from "~/server/services/admin/promotions/coupons.server";
import { listExperiments, saveExperiment } from "~/server/services/admin/promotions/experiments.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { EXPERIMENT, EXPERIMENT_STATUS_TONE, type ExperimentRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent } from "./promotions.server";
import { Code, Failure, newKey, SectionState, Section, ToneStatus, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/experiments — 08.08: A/B tests of offers (each variant a coupon), their state and the measurement
 * rule they were started with; a new test is a draft here — its rule is written on its own page before it can start.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.experiments);
  try {
    const [rows, coupons] = await Promise.all([listExperiments(db, actor), can(actor, "promotions.experiment.manage") ? couponChoices(db, actor, now) : Promise.resolve([])]);
    return { rows, coupons, manage: can(actor, "promotions.experiment.manage") };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.experiment.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { create: ["promotions.experiment.manage"] }, async (intent) => ({ ok: true, intent, ...(await saveExperiment(db, session.actor, fields(form, ["couponIds"]), ctx.now)) })),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "ab.title");

export default function ExperimentsPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const { rows, coupons, manage } = loaderData;
  const columns: DataColumn<ExperimentRow>[] = [
    { key: "name", header: t("ab.col.name"), cell: (row) => <Link to={`/admin/promotions/experiments/${row.id}`} className="adm-link grid"><span>{row.name}</span><Code value={row.key} className="type-caption text-ink-2" /></Link> },
    { key: "status", header: t("ab.col.status"), cell: (row) => <ToneStatus tone={EXPERIMENT_STATUS_TONE[row.status]}>{t(`ab.status.${row.status}`)}</ToneStatus> },
    { key: "metric", header: t("ab.col.metric"), cell: (row) => (row.primaryMetric ? t(`ab.metric.${row.primaryMetric}`) : <span className="text-ink-2">{t("ab.noRule")}</span>) },
    { key: "variants", header: t("ab.col.variants"), numeric: true, cell: (row) => <bdi className="nums">{row.variants}</bdi> },
    { key: "start", header: t("ab.col.start"), cell: (row) => (row.startsAt ? <When at={row.startsAt} style="date" /> : "—") },
    { key: "winner", header: t("ab.col.winner"), cell: (row) => (row.winner ? t("ab.variant", { key: row.winner }) : "—") },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.08" })}</p>
        <h1 className="adm-title">{t("ab.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("ab.lead")}</p>
      </header>
      <SectionState id="experiments" />
      {manage ? (
        <div className="prm-block">
          <CreateTest coupons={coupons} />
        </div>
      ) : null}
      <Section id="prm-ab" title={t("ab.listTitle")}>
        {rows.length === 0 ? (
          <EmptyState title={t("ab.empty")} text={manage ? t("ab.emptyHint") : t("ab.emptyHintRead")} icon="chart-bar" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("ab.listTitle")} columns={columns} rows={rows} rowKey={(row) => row.id} maxHeight={null} />
            </div>
            <ul className="prm-cards md:hidden">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/promotions/experiments/${row.id}`} className="prm-card">
                    <span className="prm-card__top">
                      <span className="type-strong">{row.name}</span>
                      <ToneStatus tone={EXPERIMENT_STATUS_TONE[row.status]}>{t(`ab.status.${row.status}`)}</ToneStatus>
                    </span>
                    <span className="type-caption text-ink-2">{row.primaryMetric ? t(`ab.metric.${row.primaryMetric}`) : t("ab.noRule")}</span>
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

function CreateTest({ coupons }: { coupons: { id: string; code: string; state: string }[] }) {
  const t = usePromotionsT();
  const navigate = useNavigate();
  const [formKey] = useState(newKey);
  const { fetcher, pending, message, fields: errors } = useIntent("create", "done.created", (result) => {
    if (typeof result.experimentId === "string") navigate(`/admin/promotions/experiments/${result.experimentId}`);
  });
  const options = [{ value: "", label: t("ab.pickCoupon") }, ...coupons.map((coupon) => ({ value: coupon.id, label: `${coupon.code} · ${t(`coupons.state.${coupon.state}`)}` }))];
  return (
    <Disclosure summary={t("ab.new")} variant="panel">
      <fetcher.Form method="post" className="prm-form" noValidate>
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <div className="prm-grid">
          <TextField name="name" label={t("ab.f.name")} required maxLength={120} error={errors.name} />
          <TextField name="key" label={t("ab.f.key")} hint={t("ab.f.keyHint")} required ltr maxLength={40} error={errors.key} />
          {Array.from({ length: EXPERIMENT.maxVariants }, (_, index) => (
            <Select key={index} name="couponIds" label={t("ab.f.variant", { key: String.fromCharCode(65 + index) })} hint={index < 2 ? t("ab.f.variantHint") : t("common.optional")} options={options} error={index === 0 ? errors.couponIds : undefined} />
          ))}
          <TextArea name="description" label={t("ab.f.description")} hint={t("ab.f.descriptionHint")} rows={2} maxLength={600} className="prm-span" />
        </div>
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="plus">
            {t("ab.create")}
          </Key>
        </div>
      </fetcher.Form>
    </Disclosure>
  );
}
