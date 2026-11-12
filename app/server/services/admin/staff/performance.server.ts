/**
 * Admin 15.05 — each employee's performance in a month, WITHOUT protected supplier costs: no cost, landed cost,
 * margin or profit is selected anywhere in this file (cost_snapshot_iqd is never read). What it shows:
 *   sales      counter sales they rang up (POS orders with them as cashier, delivered): orders, units kept, net sales
 *              (total − refunds), refunds on their sales, average basket — a demo order counts only for a demo employee
 *   commission what they earned in the month (net of clawbacks) — only for viewers who see pay (staff.payroll.read or
 *              staff.commission.manage); null otherwise
 *   attendance planned shifts, shifts attended, late arrivals, missed shifts, hours clocked
 *   tasks      done in the month, open and overdue now
 *   packing    orders they were assigned that shipped in the month
 * Permission: staff.performance.read.
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { assertAny, branchLimit, peopleById, personOf, rolesOf } from "./shared.server";
import { LATE_GRACE_MINUTES, periodRange, type PersonRef, type RoleRef } from "./types";

export type PerformanceRow = {
  employee: PersonRef;
  roles: RoleRef[];
  sales: { orders: number; units: number; netIqd: number; refundsIqd: number; refundedOrders: number; basketIqd: number | null };
  commissionIqd: number | null;
  attendance: { planned: number; attended: number; late: number; missed: number; minutes: number };
  tasks: { done: number; overdue: number };
  packed: number;
};

export type PerformanceView = { period: string; rows: PerformanceRow[]; totals: { netIqd: number; orders: number; units: number }; can: { pay: boolean } };

type Num = { employeeId: string; [key: string]: number | string };

export async function performance(db: Db, actor: Actor, input: { period: string; employeeId?: string | null }, locale: Locale, now: number): Promise<PerformanceView> {
  assertAny(actor, ["staff.performance.read"]);
  const { from, to } = periodRange(input.period);
  const pay = can(actor, "staff.payroll.read") || can(actor, "staff.commission.manage");
  // every query joins the employee as `e`: one employee when asked, and only the staff of a branch-limited viewer's branch
  const limit = branchLimit(actor);
  const one = sql`${input.employeeId ? sql`AND e.id = ${input.employeeId}` : sql``} ${limit ? sql`AND e.branch_id = ${limit}` : sql``}`;
  const grace = LATE_GRACE_MINUTES * 60_000;
  const [sales, attendanceRows, tasks, packed, commission] = await Promise.all([
    db.all<Num>(sql`
      SELECT o.cashier_id AS employeeId, count(DISTINCT o.id) AS orders,
             coalesce(sum(o.total_iqd - o.refunded_iqd), 0) AS net, coalesce(sum(o.refunded_iqd), 0) AS refunds,
             coalesce(sum(CASE WHEN o.refunded_iqd > 0 THEN 1 ELSE 0 END), 0) AS refundedOrders,
             coalesce((SELECT sum(oi.qty - oi.refunded_qty) FROM order_items AS oi JOIN orders AS o2 ON o2.id = oi.order_id
                       WHERE o2.cashier_id = o.cashier_id AND o2.channel = 'pos' AND o2.delivered_at >= ${from} AND o2.delivered_at < ${to}
                         AND o2.status IN ('delivered', 'returned') AND (o2.is_demo = 0 OR e.is_demo = 1)), 0) AS units
      FROM orders AS o JOIN employees AS e ON e.id = o.cashier_id
      WHERE o.channel = 'pos' AND o.cashier_id IS NOT NULL AND o.status IN ('delivered', 'returned') AND o.delivered_at >= ${from} AND o.delivered_at < ${to}
        AND (o.is_demo = 0 OR e.is_demo = 1) ${one}
      GROUP BY o.cashier_id`),
    db.all<Num>(sql`
      SELECT s.employee_id AS employeeId,
             count(*) AS planned,
             coalesce(sum(CASE WHEN EXISTS (SELECT 1 FROM attendance AS a WHERE a.shift_id = s.id) THEN 1 ELSE 0 END), 0) AS attended,
             coalesce(sum(CASE WHEN (SELECT min(a.clock_in_at) FROM attendance AS a WHERE a.shift_id = s.id) > s.starts_at + ${grace} THEN 1 ELSE 0 END), 0) AS late,
             coalesce(sum(CASE WHEN s.status = 'missed' OR (s.status = 'scheduled' AND s.ends_at < ${now} AND NOT EXISTS (SELECT 1 FROM attendance AS a WHERE a.shift_id = s.id)) THEN 1 ELSE 0 END), 0) AS missed
      FROM shifts AS s JOIN employees AS e ON e.id = s.employee_id
      WHERE s.status <> 'cancelled' AND s.starts_at >= ${from} AND s.starts_at < ${to} ${one}
      GROUP BY s.employee_id`),
    db.all<Num>(sql`
      SELECT t.assigned_to AS employeeId,
             coalesce(sum(CASE WHEN t.status = 'done' AND t.completed_at >= ${from} AND t.completed_at < ${to} THEN 1 ELSE 0 END), 0) AS done,
             coalesce(sum(CASE WHEN t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at < ${now} THEN 1 ELSE 0 END), 0) AS overdue
      FROM staff_tasks AS t JOIN employees AS e ON e.id = t.assigned_to
      WHERE 1 = 1 ${one}
      GROUP BY t.assigned_to`),
    db.all<Num>(sql`
      SELECT o.assigned_to AS employeeId, count(*) AS packed FROM orders AS o JOIN employees AS e ON e.id = o.assigned_to
      WHERE o.shipped_at >= ${from} AND o.shipped_at < ${to} AND (o.is_demo = 0 OR e.is_demo = 1) ${one}
      GROUP BY o.assigned_to`),
    pay
      ? db.all<Num>(sql`
          SELECT c.employee_id AS employeeId, coalesce(sum(c.amount_iqd), 0) AS amount FROM commissions AS c JOIN employees AS e ON e.id = c.employee_id
          WHERE c.period = ${input.period} AND c.status <> 'void' ${one}
          GROUP BY c.employee_id`)
      : Promise.resolve([] as Num[]),
  ]);
  const minutes = await db.all<Num>(sql`
    SELECT a.employee_id AS employeeId, coalesce(sum((a.clock_out_at - a.clock_in_at) / 60000), 0) AS minutes
    FROM attendance AS a JOIN employees AS e ON e.id = a.employee_id
    WHERE a.clock_out_at IS NOT NULL AND a.clock_in_at >= ${from} AND a.clock_in_at < ${to} ${one}
    GROUP BY a.employee_id`);
  const ids = new Set<string>([...sales, ...attendanceRows, ...tasks, ...packed, ...commission, ...minutes].map((row) => row.employeeId));
  if (input.employeeId && !limit) ids.add(input.employeeId);
  const [people, roleMap] = await Promise.all([peopleById(db, [...ids]), rolesOf(db, [...ids], locale)]);
  const pickNum = (rows: Num[], id: string, key: string) => Number(rows.find((row) => row.employeeId === id)?.[key] ?? 0);
  const rows: PerformanceRow[] = [...ids]
    .filter((id) => people.has(id))
    .map((id) => {
      const orders = pickNum(sales, id, "orders");
      const net = pickNum(sales, id, "net");
      const tasksDone = pickNum(tasks, id, "done");
      const overdue = pickNum(tasks, id, "overdue");
      return {
        employee: personOf(people, id),
        roles: roleMap.get(id) ?? [],
        sales: { orders, units: pickNum(sales, id, "units"), netIqd: net, refundsIqd: pickNum(sales, id, "refunds"), refundedOrders: pickNum(sales, id, "refundedOrders"), basketIqd: orders > 0 ? Math.round(net / orders) : null },
        commissionIqd: pay ? pickNum(commission, id, "amount") : null,
        attendance: { planned: pickNum(attendanceRows, id, "planned"), attended: pickNum(attendanceRows, id, "attended"), late: pickNum(attendanceRows, id, "late"), missed: pickNum(attendanceRows, id, "missed"), minutes: Math.round(pickNum(minutes, id, "minutes")) },
        tasks: { done: tasksDone, overdue },
        packed: pickNum(packed, id, "packed"),
      };
    })
    .filter((row) => input.employeeId || row.sales.orders > 0 || row.attendance.planned > 0 || row.tasks.done > 0 || row.tasks.overdue > 0 || row.packed > 0 || (row.commissionIqd ?? 0) !== 0 || row.attendance.minutes > 0)
    .sort((a, b) => b.sales.netIqd - a.sales.netIqd || a.employee.name.localeCompare(b.employee.name, "ar"));
  return {
    period: input.period,
    rows,
    totals: rows.reduce((sum, row) => ({ netIqd: sum.netIqd + row.sales.netIqd, orders: sum.orders + row.sales.orders, units: sum.units + row.sales.units }), { netIqd: 0, orders: 0, units: 0 }),
    can: { pay },
  };
}
