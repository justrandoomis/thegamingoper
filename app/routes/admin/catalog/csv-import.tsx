import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/csv-import";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { listImportJobs, previewImport } from "~/server/services/admin/catalog/import.server";
import { CSV_MAX_ROWS, CSV_PRODUCT_COLUMNS } from "~/server/services/admin/catalog/rules";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { blobStore, catalogRequest, enforceUploadLimit, failed } from "./catalog.server";
import { FailureNotice, FileInput, JOB_TONE, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/import — CSV import (02.06, catalog.product.import): the file's rules, the upload that stores the
 * file privately and validates it WITHOUT writing any product (the preview opens next), the recent imports, and the
 * exports (catalog.product.export) whose product sheet has the same columns.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await catalogRequest(context, "catalog.product.read");
  const canImport = can(actor, "catalog.product.import");
  return { jobs: canImport ? await listImportJobs(db, actor) : [], can: { import: canImport, export: can(actor, "catalog.product.export") } };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.import");
  const form = await request.formData();
  const file = form.get("file");
  try {
    await enforceUploadLimit(req);
    const { jobId } = await previewImport(req.db, blobStore(), req.actor, file, { fileName: file instanceof File ? file.name.slice(0, 120) : undefined }, req.now);
    return redirect(`/admin/catalog/import/${jobId}`);
  } catch (error) {
    return failed(error, req.locale, "preview");
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("importer.title"));

export default function CsvImport({ loaderData, actionData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const navigation = useNavigation();
  const fieldError = useFieldError(actionData);
  const { jobs, can: allowed } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("importer.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("importer.lead")}</p>
      </header>

      {allowed.import ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="adm-card content-start" aria-labelledby="import-upload">
            <h2 id="import-upload" className="adm-h2">
              {t("importer.preview")}
            </h2>
            <Form method="post" encType="multipart/form-data" className="grid gap-3">
              <FileInput name="file" label={t("importer.file")} accept=".csv,text/csv" required hint={t("importer.fileHint")} error={fieldError("file")} />
              {actionData && !actionData.fields ? <FailureNotice result={actionData} /> : null}
              <div>
                <Key type="submit" variant="ink" icon="upload-simple" loading={navigation.state === "submitting"}>
                  {t("importer.preview")}
                </Key>
              </div>
            </Form>
          </section>
          <section className="adm-card content-start" aria-labelledby="import-rules">
            <h2 id="import-rules" className="adm-h3">
              {t("importer.rulesTitle")}
            </h2>
            <ul className="grid list-disc gap-1.5 ps-5 type-caption text-ink">
              <li>
                {t("importer.rule1")}
                <bdi dir="ltr" className="mt-1 block break-words text-ink-2">
                  {CSV_PRODUCT_COLUMNS.join(", ")}
                </bdi>
              </li>
              <li>{t("importer.rule2")}</li>
              <li>{t("importer.rule3")}</li>
              <li>{t("importer.rule4", { rows: f.number(CSV_MAX_ROWS) })}</li>
            </ul>
          </section>
        </div>
      ) : null}

      {allowed.export ? (
        <section className="adm-section mt-6" aria-labelledby="export-title">
          <h2 id="export-title" className="adm-h2">
            {t("importer.export")}
          </h2>
          <p className="type-caption text-ink-2">{t("importer.exportLead")}</p>
          <div className="flex flex-wrap gap-2">
            <Key as="a" href="/admin/catalog/export?level=products" icon="download-simple">
              {t("list.exportProducts")}
            </Key>
            <Key as="a" href="/admin/catalog/export?level=variants" icon="download-simple">
              {t("list.exportVariants")}
            </Key>
          </div>
        </section>
      ) : null}

      {!allowed.import && !allowed.export ? <p className="adm-notice">{t("errors.forbidden")}</p> : null}

      {allowed.import ? (
        <section className="adm-section mt-6" aria-labelledby="import-jobs">
          <h2 id="import-jobs" className="adm-h2">
            {t("importer.jobs")}
          </h2>
          {jobs.length === 0 ? (
            <EmptyState icon="file-text" title={t("importer.noJobs")} />
          ) : (
            <div className="overflow-x-auto rounded-sm border border-line">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("importer.colWhen")}</th>
                    <th scope="col">{t("importer.colWho")}</th>
                    <th scope="col">{t("importer.colRows")}</th>
                    <th scope="col">{t("importer.colStatus")}</th>
                    <th scope="col" className="hidden md:table-cell">
                      <span className="sr-only">{t("common.open")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      {/* The date opens the import too: on a phone the last column is out of view. */}
                      <td className="nums whitespace-nowrap">
                        <Link to={`/admin/catalog/import/${job.id}`} className="adm-link">
                          {f.dateTime(job.createdAt)}
                        </Link>
                      </td>
                      <td>{job.createdBy ?? "—"}</td>
                      <td className="nums">{t("importer.rows", { valid: f.number(job.validRows), total: f.number(job.totalRows) })}</td>
                      <td>
                        <Status tone={JOB_TONE[job.status] ?? "neutral"}>{t(`importer.statuses.${job.status}`)}</Status>
                      </td>
                      <td className="hidden md:table-cell">
                        <Link to={`/admin/catalog/import/${job.id}`} className="adm-link inline-flex items-center gap-1" tabIndex={-1} aria-hidden="true">
                          {t("common.open")}
                          <Icon name="caret-right" size={14} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
