import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/statement-import";
import { useFormat } from "~/i18n/react";
import { readFormData } from "~/server/body.server";
import { AppError } from "~/server/errors";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { importStatement, previewStatement, type StatementPreview } from "~/server/services/admin/finance/settlements.server";
import { STATEMENT_MAX_BYTES, STATEMENT_MAX_ROWS } from "~/server/services/admin/finance/statement-csv";
import { STATEMENT_SOURCES } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Select, TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { failed, financeT, ok, openFinance, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, FileField, Failure, failureOf, Ledger, Money, Note, PageHead, Pair, ResponsiveTable, Section, useFinT, When } from "./ui";

/**
 * /admin/finance/settlements/import — 10.02: a bank-card, Zain Cash or carrier statement (CSV) → a preview (new lines,
 * lines imported before, rows that cannot be read and why) → the import. Importing the same file again adds nothing
 * (each line's dedupe hash). Files share the admin's upload limit (20 per employee per 10 minutes).
 */
export async function loader({ context }: Route.LoaderArgs) {
  await openFinance(context, "finance.settlement.reconcile");
  return { maxRows: STATEMENT_MAX_ROWS, maxKb: Math.round(STATEMENT_MAX_BYTES / 1024) };
}

type ImportResult = { ok: true; intent: "preview"; preview: StatementPreview; csv: string } | { ok: true; intent: "apply"; message: string; inserted: number };

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.settlement.reconcile");
  try {
    const form = await readFormData(request, STATEMENT_MAX_BYTES + 64 * 1024);
    const intent = text(form, "intent");
    const source = text(form, "source");
    if (intent === "apply") {
      const csv = typeof form.get("csv") === "string" ? (form.get("csv") as string) : "";
      const result = await importStatement(req.db, req.actor, { source, csv }, req.now);
      return ok({ intent: "apply" as const, inserted: result.inserted, message: financeT(req.locale)("import.done", { inserted: result.inserted, skipped: result.skipped, errors: result.errors }) });
    }
    const file = form.get("file");
    let csv = typeof form.get("paste") === "string" ? (form.get("paste") as string) : "";
    if (file instanceof File && file.size > 0) {
      await enforceRateLimit(req.db, await limitKey("upload", "employee", req.actor.id), RATE_LIMITS.upload, req.now);
      if (file.size > STATEMENT_MAX_BYTES) throw new AppError("statement_too_large", 400, { fields: { file: "statement_too_large" } });
      csv = await file.text();
    }
    if (!csv.trim()) throw new AppError("statement_empty", 400, { fields: { file: "statement_empty" } });
    const preview = await previewStatement(req.db, req.actor, { source, csv });
    return ok({ intent: "preview" as const, preview, csv });
  } catch (error) {
    return failed(error, req.locale, "preview");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "import.title");

export default function StatementImportPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const navigation = useNavigation();
  const data = useActionData<typeof action>() as (ImportResult | { ok: false; message?: string; fields?: Record<string, string> }) | undefined;
  const failure = failureOf(data);
  const preview = data && data.ok && data.intent === "preview" ? data : null;
  const applied = data && data.ok && data.intent === "apply" ? data : null;
  const busy = navigation.state !== "idle";

  const columns: DataColumn<StatementPreview["rows"][number]>[] = [
    { key: "line", header: t("import.col.line"), numeric: true, cell: (row) => <bdi className="nums">{row.line}</bdi> },
    { key: "state", header: t("import.col.state"), cell: (row) => <Status tone={row.state === "new" ? "ok" : row.state === "duplicate" ? "neutral" : "bad"}>{t(`import.state.${row.state}`)}</Status> },
    { key: "date", header: t("import.col.date"), cell: (row) => (row.occurredAt ? <When at={row.occurredAt} /> : "—") },
    { key: "amount", header: t("import.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} plain unknown={row.error ? t(`import.error.${row.error}`) : undefined} /> },
    { key: "reference", header: t("import.col.reference"), cell: (row) => (row.reference ? <Code>{row.reference}</Code> : "—") },
    { key: "who", header: t("import.col.counterparty"), cell: (row) => row.counterparty ?? row.description ?? "—" },
    { key: "why", header: t("import.col.problem"), cell: (row) => (row.error ? <span className="text-red-ink">{t(`import.error.${row.error}`)}</span> : "") },
  ];

  return (
    <div className="max-w-5xl">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/settlements" className="adm-link">
            {t("import.back")}
          </Link>
        }
        title={t("import.title")}
        lead={t("import.lead")}
      />

      {applied ? (
        <Note icon="check-circle" tone="ok">
          <p>{applied.message}</p>
          <p>
            <Link to="/admin/finance/settlements?status=unmatched" className="adm-link">
              {t("import.toLines")}
            </Link>
          </p>
        </Note>
      ) : null}

      {!preview ? (
        <Form method="post" encType="multipart/form-data" className="grid gap-5" noValidate>
          <input type="hidden" name="intent" value="preview" />
          <Section id="import-file" title={t("import.file")}>
            <Select name="source" label={t("import.source")} defaultValue="bank_card" options={STATEMENT_SOURCES.map((source) => ({ value: source, label: t(`source.${source}`) }))} error={failure?.fields?.source} />
            <FileField name="file" label={t("import.csvFile")} accept=".csv,text/csv,text/plain" hint={t("import.fileHint", { rows: f.number(loaderData.maxRows), kb: f.number(loaderData.maxKb) })} error={failure?.fields?.file} />
            <TextArea name="paste" label={t("import.paste")} hint={t("import.pasteHint")} optional rows={5} dir="ltr" />
            <Failure message={failure && !failure.fields ? failure.message : null} />
            <div>
              <Key type="submit" variant="ink" icon="eye" loading={busy}>
                {t("import.previewKey")}
              </Key>
            </div>
          </Section>
          <Section id="import-format" title={t("import.format")}>
            <ul className="grid list-disc gap-1 ps-5 type-body text-ink-2">
              <li>{t("import.rule1")}</li>
              <li>{t("import.rule2")}</li>
              <li>{t("import.rule3")}</li>
              <li>{t("import.rule4")}</li>
            </ul>
            <pre dir="ltr" className="adm-card overflow-x-auto type-data-sm">{"date,amount,reference,counterparty,description\n2026-11-09 14:30,754000,TT-7K4M2Q9X,Ali,Card transfer\n09/11/2026,-5000,,Bank,Fee"}</pre>
          </Section>
        </Form>
      ) : (
        <Form method="post" encType="multipart/form-data" className="grid gap-5">
          <input type="hidden" name="intent" value="apply" />
          <input type="hidden" name="source" value={preview.preview.source} />
          <textarea name="csv" defaultValue={preview.csv} hidden readOnly aria-hidden="true" tabIndex={-1} />
          <Section id="import-preview" title={t("import.preview")}>
            <Ledger
              className="adm-card max-w-lg"
              rows={[
                { label: t("import.source"), value: t(`source.${preview.preview.source}`) },
                { label: t("import.new"), value: <bdi className="nums">{f.number(preview.preview.counts.fresh)}</bdi> },
                { label: t("import.duplicates"), value: <bdi className="nums">{f.number(preview.preview.counts.duplicate)}</bdi> },
                { label: t("import.errors"), value: <bdi className="nums">{f.number(preview.preview.counts.error)}</bdi> },
                { label: t("import.moneyIn"), value: <Money iqd={preview.preview.inIqd} /> },
                { label: t("import.moneyOut"), value: <Money iqd={-preview.preview.outIqd} /> },
              ]}
            />
            <p className="type-caption text-ink-2">
              {t("import.columns")}{" "}
              {Object.entries(preview.preview.columns).map(([column, header]) => (
                <span key={column} className="me-2">
                  {t(`import.column.${column}`)} ← <Code>{header}</Code>
                </span>
              ))}
            </p>
            <ResponsiveTable
              caption={t("import.preview")}
              columns={columns}
              rows={preview.preview.rows}
              rowKey={(row) => String(row.line)}
              card={(row) => (
                <>
                  <span className="flex items-baseline justify-between gap-2">
                    <Status tone={row.state === "new" ? "ok" : row.state === "duplicate" ? "neutral" : "bad"}>{t(`import.state.${row.state}`)}</Status>
                    <Money iqd={row.amountIqd} />
                  </span>
                  <Pair label={t("import.col.line")}>{row.line}</Pair>
                  {row.occurredAt ? (
                    <Pair label={t("import.col.date")}>
                      <When at={row.occurredAt} />
                    </Pair>
                  ) : null}
                  {row.error ? <p className="type-caption text-red-ink">{t(`import.error.${row.error}`)}</p> : null}
                </>
              )}
            />
            {preview.preview.counts.total > preview.preview.rows.length ? <p className="type-caption text-ink-2">{t("import.moreRows", { shown: preview.preview.rows.length, total: preview.preview.counts.total })}</p> : null}
          </Section>
          <div className="flex flex-wrap gap-2">
            <Key type="submit" variant="ink" icon="upload-simple" loading={busy} disabled={preview.preview.counts.fresh === 0}>
              {t("import.applyKey", { count: preview.preview.counts.fresh })}
            </Key>
            <Key as={Link} to="/admin/finance/settlements/import">
              {t("import.another")}
            </Key>
          </div>
        </Form>
      )}
    </div>
  );
}
