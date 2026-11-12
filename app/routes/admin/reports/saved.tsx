import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/saved";
import { AppError } from "~/server/errors";
import { deleteSavedReport, listSavedReports, saveReport, updateSavedReport, type SavedReportView } from "~/server/services/admin/reports/saved.server";
import { reportsAccess } from "~/server/services/admin/reports/shared.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { reportsMeta } from "./meta";
import { checked, failed, ok, openReports, reportsT, text, whole } from "./reports.server";
import { ActionDialog, FormDialog, isolated, Name, Note, PageHead, Pair, ResponsiveTable, Section, usePeriodLabel, useRepT, When } from "./ui";

/**
 * /admin/reports/saved — 18.06: the saved reports this employee may open (their own and those shared with them, only
 * of reports they hold the permission for) — open one with its choices, rename or share one's own, delete one's own
 * with a reason (confirm dialog; a shared one disappears for everyone). Saving happens from each report ("save this
 * view"), posting here. Scheduled delivery is a boundary: no e-mail provider is configured, so none is offered.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openReports(context);
  return { saved: await listSavedReports(db, actor), access: reportsAccess(actor) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const req = await openReports(context, "reports.saved.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = reportsT(req.locale);
  try {
    if (intent === "create") {
      const result = await saveReport(req.db, req.actor, { reportKey: text(form, "reportKey"), name: text(form, "name"), search: text(form, "search"), shared: checked(form, "shared"), idempotencyKey: text(form, "idempotencyKey") }, req.now);
      return ok({ intent, id: result.id, replayed: result.replayed, message: t("saved.saved") });
    }
    if (intent === "update") {
      const result = await updateSavedReport(req.db, req.actor, { id: text(form, "id"), name: text(form, "name"), shared: checked(form, "shared"), expectedUpdatedAt: whole(form, "expectedUpdatedAt") }, req.now);
      return ok({ intent, changed: result.changed, message: result.changed ? t("saved.updated") : t("saved.unchanged") });
    }
    if (intent === "delete") {
      await deleteSavedReport(req.db, req.actor, { id: text(form, "id"), reason: text(form, "reason"), expectedUpdatedAt: whole(form, "expectedUpdatedAt") }, req.now);
      return ok({ intent, message: t("saved.deleted") });
    }
    return failed(new AppError("invalid", 400), req.locale, intent);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "saved.title");

export default function SavedPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { saved, access } = loaderData;
  const [editing, setEditing] = useState<SavedReportView | null>(null);
  const [deleting, setDeleting] = useState<SavedReportView | null>(null);
  const summary = useSummary();
  const columns: DataColumn<SavedReportView>[] = [
    {
      key: "name",
      header: t("saved.name"),
      cell: (row) => (
        <Link to={row.href} prefetch="intent" className="adm-link type-label">
          <Name text={row.name} />
        </Link>
      ),
    },
    { key: "report", header: t("saved.report"), cell: (row) => <span>{t(`${row.reportKey}.title`)}</span> },
    { key: "choices", header: t("saved.choices"), cell: (row) => <span className="type-caption">{summary(row)}</span> },
    { key: "owner", header: t("saved.owner"), cell: (row) => <span>{row.mine ? t("saved.mine") : <Name text={row.owner.name ?? "—"} />}{row.shared ? <span className="rep-flag ms-2">{t("saved.shared")}</span> : null}</span> },
    { key: "updated", header: t("saved.updatedAt"), cell: (row) => <When at={row.updatedAt} /> },
    { key: "actions", header: <span className="sr-only">{t("saved.actions")}</span>, cell: (row) => <RowActions row={row} canManage={access.saved} onEdit={setEditing} onDelete={setDeleting} /> },
  ];
  return (
    <>
      <PageHead eyebrow={t("saved.eyebrow")} title={t("saved.title")} lead={t("saved.lead")} />
      {!access.wholeCompany ? (
        <Note icon="lock" tone="warn">
          <p>{t("common.branchLimited")}</p>
        </Note>
      ) : null}
      <Note icon="envelope-simple">
        <p>{t("saved.scheduleBoundary")}</p>
      </Note>
      <Section id="saved-list" title={t("saved.listTitle")}>
        <ResponsiveTable
          caption={t("saved.listTitle")}
          columns={columns}
          rows={saved}
          rowKey={(row) => row.id}
          card={(row) => (
            <>
              <Link to={row.href} className="adm-link type-strong">
                <Name text={row.name} />
              </Link>
              <Pair label={t("saved.report")}>{t(`${row.reportKey}.title`)}</Pair>
              <p className="type-caption text-ink-2">{summary(row)}</p>
              <Pair label={t("saved.owner")}>{row.mine ? t("saved.mine") : <Name text={row.owner.name ?? "—"} />}</Pair>
              <RowActions row={row} canManage={access.saved} onEdit={setEditing} onDelete={setDeleting} />
            </>
          )}
          empty={<EmptyState icon="floppy-disk" title={t("saved.none")} text={access.saved ? t("saved.noneHint") : access.wholeCompany ? t("saved.noneReadOnly") : undefined} />}
        />
      </Section>

      {editing ? (
        <FormDialog title={t("saved.editTitle")} submitLabel={t("saved.saveChanges")} onClose={() => setEditing(null)} hidden={{ intent: "update", id: editing.id, expectedUpdatedAt: String(editing.updatedAt) }} successMessage={t("saved.updated")}>
          {(fields) => (
            <>
              <TextField name="name" label={t("saved.name")} defaultValue={editing.name} error={fields.name} required maxLength={80} autoComplete="off" />
              <Checkbox name="shared" label={t("saved.shareLabel")} hint={t("saved.shareHint")} defaultChecked={editing.shared} />
            </>
          )}
        </FormDialog>
      ) : null}
      <ActionDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("saved.deleteQ")}
        consequence={deleting?.shared ? t("saved.deleteSharedWhat") : t("saved.deleteWhat")}
        confirmLabel={t("saved.delete")}
        tone="destructive"
        impact={deleting ? [{ label: isolated(deleting.name), value: deleting.shared ? t("saved.impactShared") : t("saved.impactMine") }] : undefined}
        reason={{ minLength: 3, hint: t("saved.reasonHint") }}
        fields={deleting ? { intent: "delete", id: deleting.id, expectedUpdatedAt: String(deleting.updatedAt) } : {}}
        successMessage={t("saved.deleted")}
      />
    </>
  );
}

function RowActions({ row, canManage, onEdit, onDelete }: { row: SavedReportView; canManage: boolean; onEdit: (row: SavedReportView) => void; onDelete: (row: SavedReportView) => void }) {
  const t = useRepT();
  if (!row.mine || !canManage) return null;
  return (
    <span className="flex flex-wrap gap-2">
      <Key type="button" size="sm" variant="ghost" icon="pencil-simple" onClick={() => onEdit(row)}>
        {t("saved.edit")}
      </Key>
      <Key type="button" size="sm" variant="ghost" icon="trash" className="text-red-ink" onClick={() => onDelete(row)}>
        {t("saved.delete")}
      </Key>
    </span>
  );
}

/** The saved choices in words: the month or the days, demo, the view. */
function useSummary(): (row: SavedReportView) => string {
  const t = useRepT();
  const month = usePeriodLabel();
  return (row) => {
    const p = row.params;
    const parts: string[] = [];
    if (p.period) parts.push(month(p.period));
    else if (p.from || p.to) parts.push(`${p.from ?? ""} — ${p.to ?? ""}`);
    else parts.push(t("saved.currentMonth"));
    const view = p.by ?? p.view;
    if (view) parts.push(t(`saved.view.${view}`));
    if (p.basis === "units") parts.push(t("inventory.basisOf.units"));
    if (p.class) parts.push(t(`inventory.class.${p.class}`));
    if (p.q) parts.push(`«${isolated(p.q)}»`);
    if (p.demo === "1") parts.push(t("saved.withDemo"));
    return parts.join(" · ");
  };
}
