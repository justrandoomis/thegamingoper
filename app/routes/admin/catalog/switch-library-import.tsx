import { useEffect, useId, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/switch-library-import";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { applyLibraryCsv, previewLibraryCsv, SWITCH_LIBRARY_MANAGE, type ApplyCsvResult, type LibraryCsvPlan, type LibraryCsvRow } from "~/server/services/admin/switch-library.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { Status, type StatusTone } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { catalogRequest, enforceUploadLimit, runIntent } from "./catalog.server";
import { LIBRARY_CSV_COLUMNS, LIBRARY_CSV_MAX_CHANGES, LIBRARY_CSV_MAX_ROWS, LIBRARY_CSV_READ_ONLY } from "./switch-library-input";
import { GameName, LIBRARY_PATH, LibraryFailure, isLibraryFailure, libraryGamePath, useLibraryErrors, useLibraryFieldError, useLibraryList, useLibraryT, useLibraryToast } from "./switch-library-ui";

/**
 * /admin/catalog/switch-library/import — CSV import of TamTam's library data (docs/switch-builder.md §7,
 * catalog.switch_library.manage): choose a file → PREVIEW (nothing is written: per row "new", "update" with each
 * field's old and new value, or its errors; unchanged rows are counted) → APPLY the changed rows, confirmed. The file
 * is not stored: the apply sends it again with the preview's fingerprint, and the server refuses when the file or the
 * library changed in between. Both steps count against the upload limit. The export (same columns) is beside it.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { locale } = await catalogRequest(context, SWITCH_LIBRARY_MANAGE);
  return { title: serverT(locale, "admin-switch-library")("importer.title"), i18n: messagesFor(locale, "admin-switch-library") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, SWITCH_LIBRARY_MANAGE);
  const form = await request.formData();
  const file = form.get("file");
  const fileName = file instanceof File ? file.name.slice(0, 120) : undefined;
  return runIntent(req, form.get("intent"), {
    preview: async () => {
      await enforceUploadLimit(req);
      return { plan: await previewLibraryCsv(req.db, req.actor, file, req.now) };
    },
    apply: async () => {
      await enforceUploadLimit(req);
      return { result: await applyLibraryCsv(req.db, req.actor, file, { fingerprint: form.get("fingerprint"), fileName }, req.now) };
    },
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title);

const ACTION_TONE: Record<LibraryCsvRow["action"], StatusTone> = { create: "info", update: "ok", error: "bad" };

export default function SwitchLibraryImport() {
  const t = useLibraryT();
  const f = useFormat();
  const errorText = useLibraryErrors();
  const inputId = useId();
  const preview = useFetcher<typeof action>({ key: "switch-library-preview" });
  const apply = useFetcher<typeof action>({ key: "switch-library-apply" });
  const previewError = useLibraryFieldError(preview.data)("file");
  /** The chosen file, the file the shown preview read, and the preview an apply was sent for. */
  const [file, setFile] = useState<File | null>(null);
  const [previewed, setPreviewed] = useState<File | null>(null);
  const [appliedFor, setAppliedFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [round, setRound] = useState(0);

  const answerPlan = !isLibraryFailure(preview.data) ? ((preview.data as { plan?: LibraryCsvPlan } | undefined)?.plan ?? null) : null;
  // A preview belongs to its file: choosing another file hides it until that one is previewed.
  const plan = answerPlan && previewed !== null && previewed === file ? answerPlan : null;
  const answerResult = !isLibraryFailure(apply.data) ? ((apply.data as { result?: ApplyCsvResult } | undefined)?.result ?? null) : null;
  const applied = plan && appliedFor === plan.fingerprint ? answerResult : null;
  const applyFailure = plan && appliedFor === plan.fingerprint && isLibraryFailure(apply.data) ? apply.data : null;
  const changes = plan ? plan.totals.create + plan.totals.update : 0;
  const canApply = Boolean(plan && plan.fileErrors.length === 0 && changes > 0 && !plan.tooManyChanges && !applied);

  useLibraryToast(apply, (data) => {
    const result = data.result as ApplyCsvResult | undefined;
    return result ? t("importer.applied", { count: f.number(result.created + result.updated) }) : null;
  });
  useEffect(() => {
    if (apply.state === "idle" && apply.data) setConfirm(false);
  }, [apply.state, apply.data]);

  const send = (intent: "preview" | "apply") => {
    if (!file) return;
    const data = new FormData();
    data.set("intent", intent);
    data.set("file", file, file.name);
    if (intent === "apply") {
      if (!plan) return;
      data.set("fingerprint", plan.fingerprint);
      setAppliedFor(plan.fingerprint);
    } else setPreviewed(file);
    (intent === "preview" ? preview : apply).submit(data, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <>
      <header className="adm-page-head">
        <Link to={LIBRARY_PATH} className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("title")}
        </Link>
        <h1 className="adm-title">{t("importer.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("importer.lead")}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="adm-card content-start" aria-labelledby="library-import-file">
          <h2 id="library-import-file" className="adm-h2">
            {t("importer.preview")}
          </h2>
          <form
            key={round}
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              send("preview");
            }}
          >
            <div className="grid gap-1">
              <span className="type-label text-ink" id={`${inputId}-label`}>
                {t("importer.file")}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id={inputId}
                  type="file"
                  accept=".csv,text/csv"
                  required
                  className="peer sr-only"
                  aria-labelledby={`${inputId}-label`}
                  aria-describedby={`${inputId}-hint`}
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                />
                <Key as="label" htmlFor={inputId} icon="paperclip" className="cursor-pointer peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ink">
                  {t("common.chooseFile")}
                </Key>
                <bdi className="min-w-0 truncate type-caption text-ink-2">{file?.name ?? t("common.noFile")}</bdi>
              </div>
              <span id={`${inputId}-hint`} className="type-caption text-ink-2">
                {t("importer.fileHint", { rows: f.number(LIBRARY_CSV_MAX_ROWS) })}
              </span>
            </div>
            {previewed === file && isLibraryFailure(preview.data) ? (
              previewError ? (
                <p className="adm-notice adm-notice--bad" role="alert">
                  <Icon name="warning-circle" size={18} />
                  <span>{previewError}</span>
                </p>
              ) : (
                <LibraryFailure answer={preview.data} />
              )
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Key type="submit" variant="ink" icon="upload-simple" loading={preview.state !== "idle"} disabled={!file}>
                {t("importer.preview")}
              </Key>
              {plan ? (
                <Key
                  onClick={() => {
                    setFile(null);
                    setRound((value) => value + 1);
                  }}
                >
                  {t("importer.another")}
                </Key>
              ) : null}
            </div>
          </form>
        </section>

        <section className="adm-card content-start" aria-labelledby="library-import-rules">
          <h2 id="library-import-rules" className="adm-h3">
            {t("importer.rulesTitle")}
          </h2>
          <ul className="grid list-disc gap-1.5 ps-5 type-caption text-ink">
            <li>
              {t("importer.rule1")}
              <bdi dir="ltr" className="mt-1 block break-words text-ink-2">
                {LIBRARY_CSV_COLUMNS.join(", ")}
              </bdi>
            </li>
            <li>
              {t("importer.rule2")}
              <bdi dir="ltr" className="mt-1 block break-words text-ink-2">
                {LIBRARY_CSV_READ_ONLY.join(", ")}
              </bdi>
            </li>
            <li>{t("importer.rule3")}</li>
            <li>{t("importer.rule4")}</li>
            <li>{t("importer.rule5", { max: f.number(LIBRARY_CSV_MAX_CHANGES) })}</li>
          </ul>
          <div className="grid gap-2 border-t border-line pt-3">
            <p className="type-caption text-ink-2">{t("importer.exportLead")}</p>
            <div>
              <Key as="a" href={`${LIBRARY_PATH}/export`} icon="download-simple" size="sm">
                {t("list.export")}
              </Key>
            </div>
          </div>
        </section>
      </div>

      {plan ? (
        <section className="adm-section mt-6" aria-labelledby="library-dry-run">
          <div className="adm-section__head">
            <div className="grid gap-1">
              <h2 id="library-dry-run" className="adm-h2">
                {t("importer.dryRun")}
              </h2>
              <p className="type-caption text-ink-2">{applied ? t("importer.dryRunDone") : t("importer.dryRunLead")}</p>
            </div>
            <Key variant="ink" icon="check" disabled={!canApply} onClick={() => setConfirm(true)}>
              {t("importer.apply")}
            </Key>
          </div>
          <p className="flex flex-wrap gap-3">
            {(["create", "update", "unchanged", "error"] as const).map((key) => (
              <Status key={key} tone={key === "error" ? "bad" : key === "unchanged" ? "neutral" : ACTION_TONE[key]}>
                {t(`importer.totals.${key}`)}: <bdi className="nums">{f.number(plan.totals[key])}</bdi>
              </Status>
            ))}
          </p>
          {plan.fileErrors.length > 0 ? (
            <div className="adm-notice adm-notice--bad" role="alert">
              <Icon name="warning-circle" size={18} />
              <div className="grid gap-1">
                <p>{t("importer.fileErrors")}</p>
                <ul className="list-disc ps-5">
                  {plan.fileErrors.map((problem, index) => (
                    <li key={index}>{problem.line ? t("importer.lineError", { line: f.number(problem.line), message: errorText(problem.message) }) : errorText(problem.message)}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {plan.unknownColumns.length > 0 ? (
            <p className="adm-notice">
              <Icon name="info" size={18} />
              <span>
                {t("importer.unknownColumns")} <bdi dir="ltr">{plan.unknownColumns.join(", ")}</bdi>
              </span>
            </p>
          ) : null}
          {plan.tooManyChanges ? (
            <p className="adm-notice adm-notice--warn" role="alert">
              <Icon name="warning" size={18} />
              <span>{t("importer.tooMany", { count: f.number(changes), max: f.number(LIBRARY_CSV_MAX_CHANGES) })}</span>
            </p>
          ) : null}
          {plan.fileErrors.length === 0 && changes === 0 && plan.totals.error === 0 ? <p className="adm-notice">{t("importer.noChanges")}</p> : null}
          {applied ? <AppliedNotice result={applied} /> : null}
          {applyFailure ? (
            <div className="grid gap-2">
              <LibraryFailure answer={applyFailure} />
              {applyFailure.code === "import_stale" ? (
                <div>
                  <Key icon="arrows-clockwise" onClick={() => send("preview")}>
                    {t("importer.previewAgain")}
                  </Key>
                </div>
              ) : null}
            </div>
          ) : null}
          {plan.rows.length > 0 ? <PlanTable rows={plan.rows} /> : null}
          {plan.moreRows > 0 ? <p className="type-caption text-ink-2">{t("importer.moreRows", { count: f.number(plan.moreRows) })}</p> : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("importer.applyQ", { count: f.number(changes) })}
        consequence={t("importer.applyDo")}
        confirmLabel={t("importer.apply")}
        cancelLabel={t("common.cancel")}
        impact={
          plan
            ? [
                { label: t("importer.totals.create"), value: f.number(plan.totals.create) },
                { label: t("importer.totals.update"), value: f.number(plan.totals.update) },
                { label: t("importer.totals.error"), value: t("importer.errorsLeftOut", { count: f.number(plan.totals.error) }) },
              ]
            : undefined
        }
        pending={apply.state !== "idle"}
        error={applyFailure ? <LibraryFailure answer={applyFailure} /> : undefined}
        onConfirm={() => send("apply")}
      />
    </>
  );
}

function AppliedNotice({ result }: { result: ApplyCsvResult }) {
  const t = useLibraryT();
  const f = useFormat();
  return (
    <div className={result.interrupted ? "adm-notice adm-notice--warn" : "adm-notice"} role="status">
      <Icon name={result.interrupted ? "warning" : "check"} size={18} />
      <div className="grid gap-1">
        <p>{t("importer.appliedDetail", { created: f.number(result.created), updated: f.number(result.updated), unchanged: f.number(result.unchanged), skipped: f.number(result.skipped) })}</p>
        {result.interrupted ? <p>{t("importer.interrupted")}</p> : null}
        <p>
          <Link to={LIBRARY_PATH} className="adm-link">
            {t("importer.backToList")}
          </Link>
        </p>
      </div>
    </div>
  );
}

function PlanTable({ rows }: { rows: LibraryCsvRow[] }) {
  const t = useLibraryT();
  const f = useFormat();
  const errorText = useLibraryErrors();
  const { byId } = useLibraryList();
  const value = (field: string, text: string | null) => {
    if (text === null) return "—";
    if (field === "hidden") return text === "yes" ? t("common.yes") : t("common.no");
    return text;
  };
  return (
    <div className="overflow-x-auto rounded-sm border border-line" role="region" aria-label={t("importer.dryRun")} tabIndex={0} style={{ maxBlockSize: "min(70dvh, 720px)" }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t("importer.colLine")}</th>
            <th scope="col">{t("importer.colGame")}</th>
            <th scope="col">{t("importer.colAction")}</th>
            <th scope="col">{t("importer.colChanges")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} aria-selected={row.action === "error" || undefined}>
              <td className="nums align-top">{f.number(row.line)}</td>
              <td className="py-2 align-top">
                {row.gameId && row.action !== "error" ? (
                  <Link to={libraryGamePath(row.gameId)} className="adm-link grid gap-0.5">
                    <GameName game={byId.get(row.gameId)} gameId={row.gameId} />
                  </Link>
                ) : (
                  <bdi dir="ltr">{row.gameId || "—"}</bdi>
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
                        {problem.field ? <bdi dir="ltr" className="font-semibold">{problem.field}</bdi> : null} {errorText(problem.message)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="grid gap-0.5 type-caption">
                    {row.changes.map((change) => (
                      <li key={change.field}>
                        <span className="font-semibold">{t(`csv.columns.${change.field}`)}</span>: <bdi className="text-ink-2 line-through">{value(change.field, change.from)}</bdi>{" "}
                        <Icon name="arrow-right" size={12} className="inline align-middle text-ink-2" /> <bdi>{value(change.field, change.to)}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
