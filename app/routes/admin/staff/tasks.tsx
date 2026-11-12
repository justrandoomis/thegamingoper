import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/tasks";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { createTask, listTasks, moveTask, reassignTask } from "~/server/services/admin/staff/tasks.server";
import { addDays, baghdadDay, parseTaskFilters, TASK_PRIORITY_LIST, TASK_STATUS_LIST, taskSearch, type TaskFilters, type TaskRow, type TaskStatusKey } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { staffMeta } from "./meta";
import { failed, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, FormDialog, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveTable, Section, StateTag, When, useStaffT } from "./ui";

/**
 * /admin/staff/tasks — 15.02 tasks: staff.task.manage gives a task to an active employee and hands it over; the
 * assignee moves it on (open → in progress → done); a task another module made about one of its records (an order to
 * pack) links to that record and changes only there. Everyone sees their own; the team's list needs staff.task.manage
 * or staff.employee.read. Status and assignee in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const filters = parseTaskFilters(new URL(request.url).searchParams);
  const page = await orRespond(() => listTasks(db, actor, filters, now));
  return { page, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "create":
        await createTask(req.db, req.actor, { title: text(form, "title"), description: optional(form, "description"), assigneeId: text(form, "assigneeId"), priority: (optional(form, "priority") ?? "normal") as never, dueDay: optional(form, "dueDay"), dueTime: optional(form, "dueTime") }, req.now);
        return ok(intent, { message: t("tasks.created") });
      case "move": {
        const result = await moveTask(req.db, req.actor, { taskId: text(form, "taskId"), to: text(form, "to") as never, reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t(`tasks.moved.${result.status}`) });
      }
      case "reassign":
        await reassignTask(req.db, req.actor, { taskId: text(form, "taskId"), assigneeId: text(form, "assigneeId") }, req.now);
        return ok(intent, { message: t("tasks.reassigned") });
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "tasks.title");

type Page = Route.ComponentProps["loaderData"]["page"];
type Moving = { row: TaskRow; to: TaskStatusKey } | null;

export default function TasksPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { page, filters, now } = loaderData;
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Moving>(null);
  const [handing, setHanding] = useState<TaskRow | null>(null);
  const href = (patch: Partial<TaskFilters>) => `/admin/staff/tasks${taskSearch({ ...filters, ...patch, page: 1 })}` || "/admin/staff/tasks";
  const actions = (row: TaskRow) => (
    <span className="inline-flex flex-wrap gap-1 stf-noprint">
      {row.moves
        .filter((to) => to !== "cancelled")
        .map((to) => (
          <Key key={to} size="sm" variant={to === "done" ? "secondary" : "ghost"} icon={to === "done" ? "check" : to === "in_progress" ? "arrow-right" : "arrow-counter-clockwise"} onClick={() => setMoving({ row, to })}>
            {t(`tasks.to.${to}`)}
          </Key>
        ))}
      {page.can.manage && !row.ref && (row.status === "open" || row.status === "in_progress") ? (
        <Key size="sm" variant="ghost" icon="users" onClick={() => setHanding(row)}>
          {t("tasks.handOver")}
        </Key>
      ) : null}
      {row.moves.includes("cancelled") ? (
        <Key size="sm" variant="ghost" icon="x" onClick={() => setMoving({ row, to: "cancelled" })}>
          {t("tasks.to.cancelled")}
        </Key>
      ) : null}
    </span>
  );
  const columns: DataColumn<TaskRow>[] = [
    {
      key: "title",
      header: t("tasks.col.title"),
      cell: (row) => (
        <span className="grid min-w-[12rem] py-1">
          <span className="type-label">{row.title}</span>
          {row.description ? <span className="type-caption text-ink-2">{row.description}</span> : null}
          {row.ref ? (
            row.ref.href ? (
              <Link to={row.ref.href} className="adm-link type-caption">
                {t("tasks.managedIn", { label: row.ref.label ?? row.ref.type })}
              </Link>
            ) : (
              <span className="type-caption text-ink-2">{t("tasks.managedElsewhere")}</span>
            )
          ) : null}
        </span>
      ),
    },
    {
      key: "assignee",
      header: t("tasks.col.assignee"),
      cell: (row) =>
        row.assignee ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            {row.assignee.name}
            {!row.assigneeActive ? <Status tone="bad">{t("tasks.assigneeGone")}</Status> : null}
          </span>
        ) : (
          <span className="text-ink-2">—</span>
        ),
    },
    { key: "priority", header: t("tasks.col.priority"), cell: (row) => <StateTag group="priority" value={row.priority} label={t(`priority.${row.priority}`)} /> },
    {
      key: "due",
      header: t("tasks.col.due"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <When at={row.dueAt} />
          {row.overdue ? <Status tone="bad">{t("tasks.overdue")}</Status> : null}
        </span>
      ),
    },
    { key: "status", header: t("tasks.col.status"), cell: (row) => <StateTag group="task" value={row.status} label={t(`taskStatus.${row.status}`)} /> },
    { key: "act", header: <span className="sr-only">{t("common.actions")}</span>, cell: actions },
  ];
  return (
    <>
      <PageHead
        title={t("tasks.title")}
        lead={page.can.seeAll ? t("tasks.lead") : t("tasks.leadMine")}
        actions={
          page.can.manage ? (
            <Key size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t("tasks.new")}
            </Key>
          ) : null
        }
      />
      <div className="stf-kpis mb-5">
        <Kpi label={t("taskStatus.open")} value={f.number(page.counts.open)} to={href({ status: "open" })} />
        <Kpi label={t("taskStatus.in_progress")} value={f.number(page.counts.inProgress)} to={href({ status: "in_progress" })} />
        <Kpi label={t("tasks.overdue")} value={f.number(page.counts.overdue)} />
        <Kpi label={t("tasks.mine")} value={f.number(page.counts.mine)} to={href({ mine: true })} />
      </div>
      <Section id="list" title={t("tasks.list")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("tasks.statusFilter")}
            items={[
              { value: "active", label: t("tasks.active"), href: href({ status: "active" }), selected: filters.status === "active" },
              ...TASK_STATUS_LIST.map((status) => ({ value: status, label: t(`taskStatus.${status}`), href: href({ status }), selected: filters.status === status })),
              { value: "all", label: t("common.all"), href: href({ status: "all" }), selected: filters.status === "all" },
            ]}
          />
          {page.can.seeAll ? (
            <Form method="get" action="/admin/staff/tasks" className="stf-filters stf-noprint">
              {filters.status !== "active" ? <input type="hidden" name="status" value={filters.status} /> : null}
              <Select name="assignee" label={t("tasks.col.assignee")} defaultValue={filters.assignee ?? ""} options={[{ value: "", label: t("common.any") }, ...page.employees.map((person) => ({ value: person.id, label: person.name }))]} />
              <div className="flex items-end gap-2">
                <Key type="submit" size="sm" icon="funnel">
                  {t("common.apply")}
                </Key>
                <Key as={Link} to={href({ mine: !filters.mine })} size="sm" held={filters.mine}>
                  {t("tasks.mineOnly")}
                </Key>
              </div>
            </Form>
          ) : null}
          <ResponsiveTable
            caption={t("tasks.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("tasks.empty")} text={page.can.manage ? t("tasks.emptyManage") : t("tasks.emptyHint")} icon="kanban" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/tasks${taskSearch(filters, n)}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <span className="type-strong">{row.title}</span>
                  <StateTag group="task" value={row.status} label={t(`taskStatus.${row.status}`)} />
                </div>
                {row.description ? <p className="type-caption text-ink-2">{row.description}</p> : null}
                {row.assignee ? <Pair label={t("tasks.col.assignee")}>{row.assignee.name}</Pair> : null}
                <Pair label={t("tasks.col.priority")}>{t(`priority.${row.priority}`)}</Pair>
                <Pair label={t("tasks.col.due")}>
                  <When at={row.dueAt} />
                </Pair>
                {row.overdue ? <Status tone="bad">{t("tasks.overdue")}</Status> : null}
                {row.ref?.href ? (
                  <Link to={row.ref.href} className="adm-link type-caption">
                    {t("tasks.managedIn", { label: row.ref.label ?? row.ref.type })}
                  </Link>
                ) : null}
                {actions(row)}
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>{t("tasks.rules")}</p>
      </Note>

      {creating ? <NewTask page={page} now={now} onClose={() => setCreating(false)} /> : null}
      {moving ? (
        <ActionDialog
          open
          onClose={() => setMoving(null)}
          tone={moving.to === "cancelled" ? "destructive" : "neutral"}
          title={t(`tasks.moveQ.${moving.to}`, { title: moving.row.title })}
          consequence={t(`tasks.moveWhat.${moving.to}`)}
          confirmLabel={t(`tasks.to.${moving.to}`)}
          reason={moving.to === "cancelled"}
          fields={{ intent: "move", taskId: moving.row.id, to: moving.to }}
          successMessage={t("tasks.updated")}
        />
      ) : null}
      {handing ? (
        <FormDialog title={t("tasks.handOverTitle", { title: handing.title })} submitLabel={t("tasks.handOver")} onClose={() => setHanding(null)} successMessage={t("tasks.reassigned")} hidden={{ intent: "reassign", taskId: handing.id }}>
          {(fields) => (
            <Select name="assigneeId" label={t("tasks.col.assignee")} required error={fields.assigneeId} options={[{ value: "", label: t("common.choose") }, ...page.employees.filter((person) => person.status === "active" && person.id !== handing.assignee?.id).map((person) => ({ value: person.id, label: person.name }))]} />
          )}
        </FormDialog>
      ) : null}
    </>
  );
}

function NewTask({ page, now, onClose }: { page: Page; now: number; onClose: () => void }) {
  const t = useStaffT();
  return (
    <FormDialog title={t("tasks.newTitle")} submitLabel={t("tasks.newKey")} onClose={onClose} successMessage={t("tasks.created")} hidden={{ intent: "create" }}>
      {(fields) => (
        <>
          <TextField name="title" label={t("tasks.col.title")} required minLength={3} maxLength={120} error={fields.title} />
          <TextArea name="description" label={t("tasks.description")} optional maxLength={500} rows={3} error={fields.description} />
          <Select name="assigneeId" label={t("tasks.col.assignee")} required error={fields.assigneeId} options={[{ value: "", label: t("common.choose") }, ...page.employees.filter((person) => person.status === "active").map((person) => ({ value: person.id, label: person.name }))]} />
          <Select name="priority" label={t("tasks.col.priority")} defaultValue="normal" options={TASK_PRIORITY_LIST.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))} />
          <div className="grid grid-cols-2 gap-3">
            <TextField name="dueDay" type="date" label={t("tasks.dueDay")} optional defaultValue={addDays(baghdadDay(now), 1)} ltr error={fields.dueDay} />
            <TextField name="dueTime" type="time" label={t("tasks.dueTime")} optional ltr error={fields.dueTime} />
          </div>
        </>
      )}
    </FormDialog>
  );
}
