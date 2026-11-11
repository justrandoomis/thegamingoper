import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/cost-centers";
import { listCostCenters, saveCostCenter, type CostCenterRow } from "~/server/services/admin/finance/expense-views.server";
import { parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { checked, failed, financeT, ok, openFinance, optionalText, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, FormDialog, Money, Note, PageHead, Pair, RangeBar, ResponsiveTable, Section, useFinT } from "./ui";

/**
 * /admin/finance/cost-centers — 10.05: the cost centres expenses and journal lines are charged to (a branch, a team, a
 * campaign), with what was posted to each in the range. A code never changes once created (expenses and journal lines
 * keep it); names change and a centre can be switched off. finance.expense.manage.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.expense.manage");
  const range = parseRange(new URL(request.url).searchParams, now);
  const list = await orRespond(() => listCostCenters(db, actor, range, locale));
  return { list, range, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.expense.manage");
  const form = await request.formData();
  try {
    const { created } = await saveCostCenter(req.db, req.actor, { id: optionalText(form, "id"), code: optionalText(form, "code"), nameAr: text(form, "nameAr"), nameEn: optionalText(form, "nameEn"), isActive: checked(form, "isActive") }, req.now);
    return ok({ intent: "save", message: financeT(req.locale)(created ? "centers.created" : "centers.saved") });
  } catch (error) {
    return failed(error, req.locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "centers.title");

export default function CostCentersPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { list, range, now } = loaderData;
  const [editing, setEditing] = useState<CostCenterRow | "new" | null>(null);

  const columns: DataColumn<CostCenterRow>[] = [
    { key: "code", header: t("centers.code"), cell: (row) => <Code>{row.code}</Code> },
    { key: "name", header: t("centers.name"), cell: (row) => row.name },
    { key: "status", header: t("centers.status"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{t(row.isActive ? "centers.active" : "centers.inactive")}</Status> },
    {
      key: "posted",
      header: t("centers.posted"),
      numeric: true,
      cell: (row) => (
        <Link to={`/admin/finance/expenses${rangeSearch(range, { center: row.code, status: "posted" })}`} className="adm-link">
          <Money iqd={row.postedIqd} plain />
        </Link>
      ),
    },
    { key: "lines", header: t("centers.lines"), numeric: true, cell: (row) => <bdi className="nums">{row.lines}</bdi> },
    {
      key: "edit",
      header: <span className="sr-only">{t("centers.edit")}</span>,
      cell: (row) => (
        <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)}>
          {t("centers.edit")}
        </Key>
      ),
    },
  ];

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/finance/expenses" className="adm-link">
            {t("expenseNew.back")}
          </Link>
        }
        title={t("centers.title")}
        lead={t("centers.lead")}
        actions={
          <Key size="sm" variant="ink" icon="plus" onClick={() => setEditing("new")}>
            {t("centers.add")}
          </Key>
        }
      />
      <RangeBar range={range} action="/admin/finance/cost-centers" now={now} />
      <Section id="centers" title={t("centers.list")} className="mt-5">
        <ResponsiveTable
          caption={t("centers.list")}
          columns={columns}
          rows={list.rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title={t("centers.empty")}
              text={t("centers.emptyHint")}
              icon="stack"
              action={
                <Key size="sm" icon="plus" onClick={() => setEditing("new")}>
                  {t("centers.add")}
                </Key>
              }
            />
          }
          card={(row) => (
            <>
              <span className="flex items-baseline justify-between gap-2">
                <span>
                  <Code>{row.code}</Code> · {row.name}
                </span>
                <Status tone={row.isActive ? "ok" : "neutral"}>{t(row.isActive ? "centers.active" : "centers.inactive")}</Status>
              </span>
              <Pair label={t("centers.posted")}>
                <Money iqd={row.postedIqd} />
              </Pair>
              <div>
                <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)}>
                  {t("centers.edit")}
                </Key>
              </div>
            </>
          )}
        />
      </Section>
      <Note>
        <p>{t("centers.note")}</p>
      </Note>
      {editing ? (
        <FormDialog
          title={editing === "new" ? t("centers.addTitle") : t("centers.editTitle", { code: editing.code })}
          description={t("centers.formLead")}
          submitLabel={editing === "new" ? t("centers.add") : t("centers.save")}
          onClose={() => setEditing(null)}
          fetcherKey="center-save"
          hidden={editing === "new" ? undefined : { id: editing.id }}
        >
          {(fields) => (
            <>
              {editing === "new" ? (
                <TextField name="code" label={t("centers.code")} hint={t("centers.codeHint")} required ltr autoCapitalize="characters" maxLength={16} error={fields.code} />
              ) : (
                <p className="type-body">
                  {t("centers.code")}: <Code>{editing.code}</Code>
                </p>
              )}
              <TextField name="nameAr" label={t("centers.nameAr")} defaultValue={editing === "new" ? "" : editing.nameL10n.ar} required maxLength={80} error={fields.nameAr} />
              <TextField name="nameEn" label={t("centers.nameEn")} defaultValue={editing === "new" ? "" : (editing.nameL10n.en ?? "")} optional maxLength={80} error={fields.nameEn} />
              <Checkbox name="isActive" label={t("centers.active")} defaultChecked={editing === "new" ? true : editing.isActive} />
            </>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}
