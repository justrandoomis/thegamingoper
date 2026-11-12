import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 15 — Employees & HR (docs/areas/admin-staff.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/staff/.
 * Static segments outrank dynamic ones, so /admin/staff/payroll/advances never reaches the run page.
 *
 *   /admin/staff                          what waits for a decision, the team today, sections, limits, status   (all)
 *   /admin/staff/me                       my day: clock in/out, my shifts, leave, tasks, commissions, payslips    15.02 15.03 15.04
 *   /admin/staff/approvals                approvals across modules (the bell's queues), my requests, the store's  15.06
 *   /admin/staff/employees                the directory                                                           15.01
 *   /admin/staff/employees/:employeeId    one file: effective permissions, HR facts, pay, sessions, sign-ins,
 *                                         ending access                                                           15.01 15.07
 *   /admin/staff/schedule                 the week roster of work shifts                                          15.02
 *   /admin/staff/attendance               attendance records, manual entries, corrections, approvals              15.02
 *   /admin/staff/leave                    leave requests and decisions                                            15.02
 *   /admin/staff/tasks                    tasks                                                                   15.02
 *   /admin/staff/commissions              versioned plans and the month's commissions                             15.03
 *   /admin/staff/payroll                  runs and what a run would pay now                                       15.04
 *   /admin/staff/payroll/advances         salary advances                                                         15.04
 *   /admin/staff/payroll/:runId           one run: lines, approval, payment, payslips (print)                     15.04
 *   /admin/staff/performance              each employee's month, without supplier costs                           15.05
 */
export const staffAdminRoutes: RouteConfigEntry[] = [
  route("staff", "routes/admin/staff/layout.tsx", [
    index("routes/admin/staff/home.tsx"),
    route("me", "routes/admin/staff/me.tsx"),
    route("approvals", "routes/admin/staff/approvals.tsx"),
    route("employees", "routes/admin/staff/employees.tsx"),
    route("employees/:employeeId", "routes/admin/staff/employee.tsx"),
    route("schedule", "routes/admin/staff/schedule.tsx"),
    route("attendance", "routes/admin/staff/attendance.tsx"),
    route("leave", "routes/admin/staff/leave.tsx"),
    route("tasks", "routes/admin/staff/tasks.tsx"),
    route("commissions", "routes/admin/staff/commissions.tsx"),
    route("payroll", "routes/admin/staff/payroll.tsx"),
    route("payroll/advances", "routes/admin/staff/advances.tsx"),
    route("payroll/:runId", "routes/admin/staff/payroll-run.tsx"),
    route("performance", "routes/admin/staff/performance.tsx"),
  ]),
];
