/**
 * Admin 15.02 — staff tasks (table `staff_tasks`): staff.task.manage gives a task to an active employee (title,
 * details, priority, due); the assignee moves it open → in progress → done (or back to open); a task manager may also
 * cancel it (with a reason) or hand it to someone else. Tasks that another module created about one of its records
 * (an order to pack, ref_type "order") are shown with a link to that record and change only there
 * (task_managed_elsewhere): the orders module closes them when the order ships.
 *
 * Errors: forbidden, not_found, invalid (fields), task_not_open, task_managed_elsewhere, task_not_yours (403),
 * employee_inactive.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { orders, staffTasks } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { actorId, activeEmployee, assertAny, assertReach, assertReachOf, branchLimit, cleanLine, employeeOptions, IdSchema, OptionalNote, peopleById, personOf, reachSql, stamp } from "./shared.server";
import { dayStart, DAY_MS, isDay, PAGE_SIZE, parseClock, TASK_PRIORITY_LIST, type PersonRef, type TaskFilters, type TaskRow, type TaskStatusKey } from "./types";

type Row = typeof staffTasks.$inferSelect;

/** Where each module's tasks lead (the ref types other modules write). */
async function refLinks(db: Db, rows: readonly Row[]): Promise<Map<string, { href: string | null; label: string | null }>> {
  const out = new Map<string, { href: string | null; label: string | null }>();
  const orderIds = [...new Set(rows.filter((row) => row.refType === "order" && row.refId).map((row) => row.refId as string))];
  if (orderIds.length) {
    const found = await db.select({ id: orders.id, ref: orders.ref }).from(orders).where(inArray(orders.id, orderIds));
    for (const order of found) out.set(`order:${order.id}`, { href: `/admin/orders/${order.ref}`, label: order.ref });
  }
  return out;
}

/** The moves this employee may make on a task. */
export function taskMoves(actor: Actor, row: Pick<Row, "status" | "assignedTo" | "refType">): TaskStatusKey[] {
  if (row.refType) return [];
  const manager = can(actor, "staff.task.manage");
  const assignee = row.assignedTo !== null && actorId(actor) === row.assignedTo;
  const moves: TaskStatusKey[] = [];
  if (manager || assignee) {
    if (row.status === "open") moves.push("in_progress", "done");
    if (row.status === "in_progress") moves.push("done", "open");
  }
  if (manager && (row.status === "open" || row.status === "in_progress")) moves.push("cancelled");
  return moves;
}

function viewOf(actor: Actor, people: Map<string, PersonRef & { status?: string }>, links: Map<string, { href: string | null; label: string | null }>, row: Row, now: number): TaskRow {
  const assignee = row.assignedTo ? personOf(people, row.assignedTo) : null;
  const link = row.refType && row.refId ? links.get(`${row.refType}:${row.refId}`) : undefined;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assignee,
    assigneeActive: row.assignedTo ? (people.get(row.assignedTo) as { status?: string } | undefined)?.status !== "disabled" : true,
    priority: row.priority,
    status: row.status,
    dueAt: row.dueAt,
    overdue: row.dueAt !== null && row.dueAt < now && (row.status === "open" || row.status === "in_progress"),
    ref: row.refType && row.refId ? { type: row.refType, id: row.refId, href: link?.href ?? null, label: link?.label ?? null } : null,
    createdBy: row.createdBy ? (people.get(row.createdBy)?.name ?? null) : null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    moves: taskMoves(actor, row),
  };
}

export type TaskPage = {
  rows: TaskRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: { open: number; inProgress: number; overdue: number; mine: number };
  employees: (PersonRef & { status: "active" | "disabled" })[];
  can: { manage: boolean; seeAll: boolean };
};

/**
 * Tasks with filters in the URL. Everyone sees their own; the whole team's list needs staff.task.manage or
 * staff.employee.read (otherwise the list is one's own whatever the filter says).
 */
export async function listTasks(db: Db, actor: Actor, filters: TaskFilters, now: number): Promise<TaskPage> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const seeAll = can(actor, "staff.task.manage") || can(actor, "staff.employee.read");
  const limit = branchLimit(actor);
  const where: SQL[] = [];
  if (!seeAll || filters.mine) where.push(eq(staffTasks.assignedTo, me));
  else {
    // the team's list of an employee limited to a branch: that branch's staff (and their own tasks)
    if (limit) where.push(sql`(${staffTasks.assignedTo} = ${me} OR ${reachSql(actor, staffTasks.assignedTo)})`);
    if (filters.assignee) where.push(eq(staffTasks.assignedTo, filters.assignee));
  }
  if (filters.status === "active") where.push(inArray(staffTasks.status, ["open", "in_progress"]));
  else if (filters.status !== "all") where.push(eq(staffTasks.status, filters.status));
  const condition = where.length ? and(...where) : undefined;
  const scope = !seeAll ? sql`assigned_to = ${me}` : limit ? sql`(assigned_to = ${me} OR assigned_to IN (SELECT reach.id FROM employees AS reach WHERE reach.branch_id = ${limit}))` : sql`1 = 1`;
  const [rows, count, counts, options] = await Promise.all([
    db
      .select()
      .from(staffTasks)
      .where(condition)
      .orderBy(sql`CASE ${staffTasks.status} WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END`, sql`${staffTasks.dueAt} IS NULL`, staffTasks.dueAt, desc(staffTasks.createdAt))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(staffTasks).where(condition).get(),
    db.all<{ open: number; progress: number; overdue: number; mine: number }>(sql`SELECT
        coalesce(sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
        coalesce(sum(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS progress,
        coalesce(sum(CASE WHEN status IN ('open', 'in_progress') AND due_at IS NOT NULL AND due_at < ${now} THEN 1 ELSE 0 END), 0) AS overdue,
        coalesce(sum(CASE WHEN status IN ('open', 'in_progress') AND assigned_to = ${me} THEN 1 ELSE 0 END), 0) AS mine
      FROM staff_tasks WHERE ${scope}`),
    seeAll ? employeeOptions(db, { branchId: limit }) : Promise.resolve([]),
  ]);
  const [people, links] = await Promise.all([peopleById(db, [...rows.map((row) => row.assignedTo), ...rows.map((row) => row.createdBy)]), refLinks(db, rows)]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => viewOf(actor, people, links, row, now)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { open: Number(counts[0]?.open ?? 0), inProgress: Number(counts[0]?.progress ?? 0), overdue: Number(counts[0]?.overdue ?? 0), mine: Number(counts[0]?.mine ?? 0) },
    employees: options,
    can: { manage: can(actor, "staff.task.manage"), seeAll },
  };
}

const CreateInput = z.object({
  title: z.string({ error: "required" }).overwrite(cleanLine).min(3, "too_short").max(120, "too_long"),
  description: OptionalNote,
  assigneeId: IdSchema,
  priority: z.enum(TASK_PRIORITY_LIST).default("normal"),
  dueDay: z
    .string()
    .nullish()
    .transform((value) => value || null)
    .refine((value) => value === null || isDay(value), "invalid"),
  dueTime: z
    .string()
    .nullish()
    .transform((value) => value || null),
});

/** Gives a task to an active employee (staff.task.manage). */
export async function createTask(db: Db, actor: Actor, raw: z.input<typeof CreateInput>, now: number): Promise<{ taskId: string }> {
  assertAny(actor, ["staff.task.manage"]);
  const input = CreateInput.parse(raw);
  let dueAt: number | null = null;
  if (input.dueDay) {
    const minutes = input.dueTime ? parseClock(input.dueTime) : 17 * 60;
    if (minutes === null) throw invalid({ dueTime: "invalid" });
    dueAt = dayStart(input.dueDay) + minutes * 60_000;
    if (dueAt < now - DAY_MS) throw invalid({ dueDay: "due_in_past" });
  }
  const assignee = await activeEmployee(db, input.assigneeId);
  assertReach(actor, assignee);
  const id = newId("tsk");
  await runBatch(db, [
    db.insert(staffTasks).values({ id, title: input.title, description: input.description, assignedTo: assignee.id, priority: input.priority, status: "open", dueAt, refType: null, refId: null, createdBy: stamp(actor), createdAt: now }),
    auditStatement(db, { actor, action: "staff.task.create", entityType: "staff_task", entityId: id, summary: `${input.title} → ${assignee.name}`, after: { assignedTo: assignee.id, priority: input.priority, dueAt }, at: now }),
  ]);
  return { taskId: id };
}

const MoveInput = z.object({ taskId: IdSchema, to: z.enum(["open", "in_progress", "done", "cancelled"]), reason: OptionalNote });

/** Moves a task on (its assignee or a task manager); cancelling needs staff.task.manage and a reason. */
export async function moveTask(db: Db, actor: Actor, raw: z.input<typeof MoveInput>, now: number): Promise<{ status: TaskStatusKey }> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const input = MoveInput.parse(raw);
  const row = await db.select().from(staffTasks).where(eq(staffTasks.id, input.taskId)).get();
  if (!row) throw notFound("staff_task");
  if (row.refType) throw new AppError("task_managed_elsewhere", 409);
  const manager = can(actor, "staff.task.manage");
  if (!manager && row.assignedTo !== me) throw new AppError("task_not_yours", 403);
  if (row.assignedTo !== me) await assertReachOf(db, actor, row.assignedTo);
  if (!taskMoves(actor, row).includes(input.to)) throw new AppError("task_not_open", 409);
  if (input.to === "cancelled" && (!input.reason || input.reason.length < 3)) throw invalid({ reason: "reason_required" });
  const finished = input.to === "done" || input.to === "cancelled";
  try {
    await runBatch(db, [
      db
        .update(staffTasks)
        .set({ status: input.to, completedAt: finished ? now : null })
        .where(and(eq(staffTasks.id, row.id), eq(staffTasks.status, row.status), isNull(staffTasks.refType))),
      expectChanged(db, 1, { code: "TASK_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.task.move", entityType: "staff_task", entityId: row.id, before: { status: row.status }, after: { status: input.to }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "TASK_CHANGED")) throw new AppError("task_not_open", 409);
    throw error;
  }
  return { status: input.to };
}

const ReassignInput = z.object({ taskId: IdSchema, assigneeId: IdSchema });

/** Hands an open task to another active employee (staff.task.manage). */
export async function reassignTask(db: Db, actor: Actor, raw: z.input<typeof ReassignInput>, now: number): Promise<{ assignedTo: string }> {
  assertAny(actor, ["staff.task.manage"]);
  const input = ReassignInput.parse(raw);
  const row = await db.select().from(staffTasks).where(eq(staffTasks.id, input.taskId)).get();
  if (!row) throw notFound("staff_task");
  if (row.refType) throw new AppError("task_managed_elsewhere", 409);
  if (row.status !== "open" && row.status !== "in_progress") throw new AppError("task_not_open", 409);
  await assertReachOf(db, actor, row.assignedTo);
  const assignee = await activeEmployee(db, input.assigneeId);
  assertReach(actor, assignee);
  if (assignee.id === row.assignedTo) return { assignedTo: assignee.id };
  try {
    await runBatch(db, [
      db
        .update(staffTasks)
        .set({ assignedTo: assignee.id, status: "open" })
        .where(and(eq(staffTasks.id, row.id), eq(staffTasks.status, row.status))),
      expectChanged(db, 1, { code: "TASK_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.task.reassign", entityType: "staff_task", entityId: row.id, before: { assignedTo: row.assignedTo }, after: { assignedTo: assignee.id }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "TASK_CHANGED")) throw new AppError("task_not_open", 409);
    throw error;
  }
  return { assignedTo: assignee.id };
}
