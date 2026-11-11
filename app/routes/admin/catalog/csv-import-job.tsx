import { useEffect, useState } from "react";
import { data, Link, useFetcher } from "react-router";

import type { Route } from "./+types/csv-import-job";
import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { pick, type L10n } from "~/lib/locales";
import { applyImport, getImportJob, rollbackImport } from "~/server/services/admin/catalog/import.server";
import type { RowPlan } from "~/server/services/admin/catalog/import.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { Status, type StatusTone } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { blobStore, catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, JOB_TONE, isFailure, useAnswerToast, useCatalogT } from "./components/ui";

/**
 * /admin/catalog/import/:jobId — one CSV import (02.06, catalog.product.import): the dry run computed from the file
 * and the database as they are now (row by row: new product, update with each field's old and new value, no change,
 * or the errors), "apply the valid rows" (confirmed, double-submit safe), and after applying the rollback with its
 * result per product (a product changed after the import is left alone and listed).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, now, locale } = await catalogRequest(context, "catalog.product.import");
  const job = await getImportJob(db, blobStore(), actor, params.jobId, now, locale).catch((error: unknown) => {
    if ((error as { code?: string })?.code === "not_found") throw data({ error: "not_found" }, { status: 404 });
    throw error;
  });
  return { job };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.import");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    apply: async () => applyImport(req.db, blobStore(), req.actor, params.jobId, req.now, { demo: req.ctx.storeMode === "demo" }),
    rollback: async () => rollbackImport(req.db, req.actor, { jobId: params.jobId, reason: form.reason }, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("importer.title"));

const ACTION_TONE: Record<RowPlan["action"], StatusTone> = { create: "info", update: "ok", unchanged: "neutral", error: "bad" };

export default function CsvImportJob({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { job } = loaderData;
  const [confirm, setConfirm] = useState<"apply" | "rollback" | null>(null);
  const fetcher = useFetcher<typeof action>({ key: `catalog-import-${job.id}` });
  useAnswerToast(fetcher, (answer) =>
    answer.intent === "apply" ? t("importer.applied", { count: f.number(Number(answer.applied ?? 0)) }) : t("importer.rolledBack", { restored: f.number(Number(answer.restored ?? 0)), archived: f.number(Number(answer.archived ?? 0)) }),
  );
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data)) setConfirm(null);
  }, [fetcher.state, fetcher.data]);
  const plan = job.plan;
  const counts = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const row of plan?.rows ?? []) counts[row.action]++;
  const applicable = counts.create + counts.update - job.changedSincePreview.length;

  return (
    <>
      <header className="adm-page-head">
        <Link to="/admin/catalog/import" className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("importer.title")}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="adm-title">
            {t("importer.job")} <bdi dir="ltr" className="type-caption text-ink-2">{job.fileName ?? job.id}</bdi>
          </h1>
          <Status tone={JOB_TONE[job.status] ?? "neutral"}>{t(`importer.statuses.${job.status}`)}</Status>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 type-caption text-ink-2">
          <span className="nums">{f.dateTime(job.createdAt)}</span>
          {job.createdBy ? <span>{t("common.by", { name: job.createdBy })}</span> : null}
          <span className="nums">{t("importer.rows", { valid: f.number(job.validRows), total: f.number(job.totalRows) })}</span>
        </p>
      </header>

      {job.status === "validated" && plan ? (
        <section className="adm-section" aria-labelledby="dry-run">
          <div className="adm-section__head">
            <div className="grid gap-1">
              <h2 id="dry-run" className="adm-h2">
                {t("importer.dryRun")}
              </h2>
              <p className="type-caption text-ink-2">{t("importer.dryRunLead")}</p>
            </div>
            <Key variant="ink" icon="check" disabled={applicable <= 0} onClick={() => setConfirm("apply")}>
              {t("importer.apply")}
            </Key>
          </div>
          <p className="flex flex-wrap gap-3">
            {(Object.keys(counts) as RowPlan["action"][]).map((key) => (
              <Status key={key} tone={ACTION_TONE[key]}>
                {t(`importer.actions.${key}`)}: <bdi className="nums">{f.number(counts[key])}</bdi>
              </Status>
            ))}
          </p>
          {plan.fileErrors.length > 0 ? (
            <div className="adm-notice adm-notice--bad" role="alert">
              <Icon name="warning-circle" size={18} />
              <div>
                <p>{t("importer.fileErrors")}</p>
                <ul className="list-disc ps-5">
                  {plan.fileErrors.map((problem, index) => (
                    <li key={index}>{t(`errors.${problem.message}`)}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {plan.unknownColumns.length > 0 ? <p className="adm-notice">{t("importer.unknownColumns", { columns: plan.unknownColumns.join(", ") })}</p> : null}
          {job.changedSincePreview.length > 0 ? <p className="adm-notice adm-notice--warn">{t("importer.changedSince", { slugs: job.changedSincePreview.join(", ") })}</p> : null}
          <PlanTable rows={plan.rows} names={job.names} />
        </section>
      ) : null}

      {job.status !== "validated" && job.errors.length > 0 && !job.rollback?.applied?.length ? (
        <section className="adm-section" aria-labelledby="job-errors">
          <h2 id="job-errors" className="adm-h2">
            {t("importer.errorsTitle")}
          </h2>
          <ul className="grid gap-1 type-caption">
            {job.errors.slice(0, 200).map((problem, index) => (
              <li key={index}>
                {problem.row > 0 ? <bdi className="nums">{t("importer.colLine")} {f.number(problem.row)}</bdi> : null} {problem.field ? <bdi dir="ltr">{problem.field}</bdi> : null}: {t(`errors.${problem.message}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {job.rollback?.applied && job.rollback.applied.length > 0 ? (
        <section className="adm-section" aria-labelledby="applied-list">
          <div className="adm-section__head">
            <h2 id="applied-list" className="adm-h2">
              {t("importer.appliedList")}
            </h2>
            {job.status === "applied" || (job.status === "failed" && !job.rolledBackAt) ? (
              <Key icon="arrow-counter-clockwise" onClick={() => setConfirm("rollback")}>
                {t("importer.rollback")}
              </Key>
            ) : null}
          </div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {job.rollback.applied.map((entry) => (
              <li key={entry.productId} className="flex items-center gap-2 type-body">
                <Link to={`/admin/catalog/products/${entry.productId}/history`} className="adm-link">
                  <bdi dir="ltr">{entry.slug}</bdi>
                </Link>
                <span className="type-caption text-ink-2">{entry.created ? t("importer.created") : t("importer.actions.update")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {job.rollback?.rolledBack ? (
        <section className="adm-section" aria-labelledby="rolled-back">
          <h2 id="rolled-back" className="adm-h2">
            {t("importer.rolledBackList")}
          </h2>
          <ul className="grid gap-1 sm:grid-cols-2">
            {job.rollback.rolledBack.map((entry) => (
              <li key={entry.productId} className="flex items-center gap-2">
                <bdi dir="ltr">{entry.slug}</bdi>
                <Status tone={entry.outcome === "conflict" ? "warn" : "ok"}>{t(`importer.outcomes.${entry.outcome}`)}</Status>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {job.status !== "validated" && !job.rollback?.applied?.length && job.errors.length === 0 ? <p className="adm-notice">{t("importer.noPlan", { status: t(`importer.statuses.${job.status}`) })}</p> : null}

      <ConfirmDialog
        open={confirm === "apply"}
        onClose={() => setConfirm(null)}
        title={t("importer.applyQ", { count: f.number(applicable) })}
        consequence={t("importer.applyDo")}
        confirmLabel={t("importer.apply")}
        cancelLabel={t("common.cancel")}
        impact={[
          { label: t("importer.actions.create"), value: f.number(counts.create) },
          { label: t("importer.actions.update"), value: f.number(counts.update) },
          { label: t("impact.prices"), value: t("impact.pricesSame") },
          { label: t("impact.stock"), value: t("history.notRestored") },
        ]}
        pending={fetcher.state !== "idle"}
        error={isFailure(fetcher.data) ? <FailureNotice result={fetcher.data} /> : undefined}
        onConfirm={() => fetcher.submit({ intent: "apply" }, { method: "post" })}
      />
      <ConfirmDialog
        open={confirm === "rollback"}
        onClose={() => setConfirm(null)}
        tone="destructive"
        title={t("importer.rollbackQ")}
        consequence={t("importer.rollbackDo")}
        confirmLabel={t("importer.rollback")}
        cancelLabel={t("common.cancel")}
        impact={[{ label: t("impact.prices"), value: t("impact.pricesSame") }]}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={fetcher.state !== "idle"}
        error={isFailure(fetcher.data) ? <FailureNotice result={fetcher.data} /> : undefined}
        onConfirm={({ reason }) => fetcher.submit({ intent: "rollback", reason }, { method: "post" })}
      />
    </>
  );
}

function PlanTable({ rows, names }: { rows: RowPlan[]; names: Record<string, string> }) {
  const t = useCatalogT();
  const f = useFormat();
  const locale = useLocale();
  const value = (raw: unknown) => {
    if (raw === null || raw === undefined || raw === "") return "—";
    if (typeof raw === "string" && names[raw]) return names[raw];
    if (typeof raw === "object" && raw !== null && "ar" in raw) return pick(raw as L10n, locale);
    return String(raw);
  };
  return (
    <div className="overflow-x-auto rounded-sm border border-line" role="region" aria-label={t("importer.dryRun")} tabIndex={0} style={{ maxBlockSize: "min(70dvh, 720px)" }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t("importer.colLine")}</th>
            <th scope="col">{t("importer.colSlug")}</th>
            <th scope="col">{t("importer.colAction")}</th>
            <th scope="col">{t("importer.colChanges")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} aria-selected={row.action === "error" || undefined}>
              <td className="nums align-top">{f.number(row.line)}</td>
              <td className="align-top">
                {row.productId && row.action !== "create" ? (
                  <Link to={`/admin/catalog/products/${row.productId}`} className="adm-link">
                    <bdi dir="ltr">{row.slug || "—"}</bdi>
                  </Link>
                ) : (
                  <bdi dir="ltr">{row.slug || "—"}</bdi>
                )}
              </td>
              <td className="align-top">
                <Status tone={ACTION_TONE[row.action]}>{t(`importer.actions.${row.action}`)}</Status>
              </td>
              <td className="py-2 align-top">
                {row.errors.length > 0 ? (
                  <ul className="grid gap-0.5 type-caption text-red-ink">
                    {row.errors.map((problem, index) => (
                      <li key={index}>
                        {problem.field ? <bdi dir="ltr">{problem.field}</bdi> : null} {t(`errors.${problem.message}`)}
                      </li>
                    ))}
                  </ul>
                ) : row.changes.length > 0 ? (
                  <ul className="grid gap-0.5 type-caption">
                    {row.changes.map((change) => (
                      <li key={change.field}>
                        <span className="font-semibold">{t(`history.fields.${change.field}`)}</span>: <span className="text-ink-2 line-through">{value(change.from)}</span> <Icon name="arrow-right" size={12} className="inline align-middle text-ink-2" /> <span>{value(change.to)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="type-caption text-ink-2">{t("errors.unchanged")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
