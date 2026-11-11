/**
 * Admin 20.08 (part 1) — abnormal sign-in attempts, from the security log `auth_events` (staff and customers: sign-ins,
 * failures with their reason, lockouts, second-step codes, two-step and password changes).
 *
 * Alerts are fixed rules with their numbers (types.ts SIGNIN_THRESHOLDS), never a score: a lockout; repeated failures
 * for one email or phone; many failures from one address; emails that match no account typed from one address
 * (spraying); a disabled account trying to sign in; wrong second-step codes; a refused attempt to turn two-step off;
 * a staff sign-in from an address that employee has not used in 90 days. Each alert links to the events behind it.
 *
 * Permission security.auth_event.read. What a person typed (`identifier`) holds full phone numbers: they are masked for
 * anyone without customer.phone.read_full (also when searching — a partial number only finds with the permission).
 * The log is pruned after RETENTION_DAYS.authEvents (180) by the nightly job.
 */
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { authEvents } from "~/server/db/schema";
import { authEventView } from "./staff.server";
import { employeeNames, identifierFor } from "./shared.server";
import { DAY_MS, SIGNIN_THRESHOLDS, WINDOW_MS, type AuthEventView, type SigninAlert, type SigninFilters, type SigninWindow } from "./types";

const PAGE_SIZE = 50;
const FAILED_KINDS = ["login", "mfa", "password_change", "mfa_enroll", "otp_verify"] as const;

export type SigninOverview = {
  window: SigninWindow;
  totals: { attempts: number; failures: number; lockouts: number; staffFailures: number; customerFailures: number };
  alerts: SigninAlert[];
};

type Group = { key: string; n: number; lastAt: number; identifier?: string | null; ip?: string | null; subjectId?: string | null; subjectKind?: string | null };

export async function signinOverview(db: Db, actor: Actor, window: SigninWindow, now: number): Promise<SigninOverview> {
  assertCan(actor, "security.auth_event.read");
  const since = now - WINDOW_MS[window];
  const failedKinds = JSON.stringify(FAILED_KINDS);
  const [totals, lockouts, identifiers, ips, sprays, disabled, mfa, offRefused, fresh] = await Promise.all([
    db.all<{ attempts: number; failures: number; staff: number; customers: number }>(sql`
      SELECT count(*) AS attempts, coalesce(sum(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failures,
             coalesce(sum(CASE WHEN success = 0 AND subject_kind = 'employee' THEN 1 ELSE 0 END), 0) AS staff,
             coalesce(sum(CASE WHEN success = 0 AND subject_kind = 'customer' THEN 1 ELSE 0 END), 0) AS customers
      FROM auth_events WHERE at >= ${since} AND kind IN ('login', 'mfa', 'otp_verify', 'lockout')`),
    db.all<Group>(sql`SELECT coalesce(identifier, subject_id, ip, '?') AS key, count(*) AS n, max(at) AS lastAt, identifier, ip, subject_id AS subjectId, subject_kind AS subjectKind FROM auth_events WHERE at >= ${since} AND kind = 'lockout' GROUP BY key ORDER BY lastAt DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT identifier AS key, count(*) AS n, max(at) AS lastAt, identifier, max(subject_id) AS subjectId, max(subject_kind) AS subjectKind FROM auth_events
      WHERE at >= ${since} AND success = 0 AND identifier IS NOT NULL AND kind IN (SELECT value FROM json_each(${failedKinds}))
      GROUP BY identifier HAVING count(*) >= ${SIGNIN_THRESHOLDS.identifierFailures} ORDER BY n DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT ip AS key, count(*) AS n, max(at) AS lastAt, ip FROM auth_events
      WHERE at >= ${since} AND success = 0 AND ip IS NOT NULL AND kind IN (SELECT value FROM json_each(${failedKinds}))
      GROUP BY ip HAVING count(*) >= ${SIGNIN_THRESHOLDS.ipFailures} ORDER BY n DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT ip AS key, count(DISTINCT identifier) AS n, max(at) AS lastAt, ip FROM auth_events
      WHERE at >= ${since} AND success = 0 AND kind = 'login' AND ip IS NOT NULL AND json_extract(details, '$.reason') = 'unknown_email'
      GROUP BY ip HAVING count(DISTINCT identifier) >= ${SIGNIN_THRESHOLDS.unknownFromIp} ORDER BY n DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT subject_id AS key, count(*) AS n, max(at) AS lastAt, max(identifier) AS identifier, subject_id AS subjectId, 'employee' AS subjectKind FROM auth_events
      WHERE at >= ${since} AND success = 0 AND kind = 'login' AND json_extract(details, '$.reason') = 'disabled' GROUP BY subject_id ORDER BY lastAt DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT subject_id AS key, count(*) AS n, max(at) AS lastAt, max(identifier) AS identifier, subject_id AS subjectId, 'employee' AS subjectKind FROM auth_events
      WHERE at >= ${since} AND success = 0 AND kind = 'mfa' AND subject_kind = 'employee' GROUP BY subject_id HAVING count(*) >= ${SIGNIN_THRESHOLDS.mfaFailures} ORDER BY n DESC LIMIT 50`),
    db.all<Group>(sql`
      SELECT subject_id AS key, count(*) AS n, max(at) AS lastAt, max(identifier) AS identifier, subject_id AS subjectId, 'employee' AS subjectKind FROM auth_events
      WHERE at >= ${since} AND success = 0 AND kind = 'mfa_enroll' AND json_extract(details, '$.change') = 'disable' GROUP BY subject_id ORDER BY lastAt DESC LIMIT 50`),
    // a staff sign-in from an address the same employee had not signed in from in the 90 days before it
    db.all<Group>(sql`
      SELECT e.id AS key, 1 AS n, e.at AS lastAt, e.identifier, e.ip, e.subject_id AS subjectId, 'employee' AS subjectKind FROM auth_events e
      WHERE e.at >= ${since} AND e.subject_kind = 'employee' AND e.kind = 'login' AND e.success = 1 AND e.ip IS NOT NULL
        AND EXISTS (SELECT 1 FROM auth_events p WHERE p.subject_kind = 'employee' AND p.subject_id = e.subject_id AND p.kind = 'login' AND p.success = 1 AND p.at < e.at)
        AND NOT EXISTS (SELECT 1 FROM auth_events p WHERE p.subject_kind = 'employee' AND p.subject_id = e.subject_id AND p.kind = 'login' AND p.success = 1 AND p.ip = e.ip AND p.at < e.at AND p.at >= e.at - ${SIGNIN_THRESHOLDS.newAddressDays * DAY_MS})
      ORDER BY e.at DESC LIMIT 50`),
  ]);
  const names = await employeeNames(db, [...lockouts, ...identifiers, ...disabled, ...mfa, ...offRefused, ...fresh].filter((group) => group.subjectKind === "employee").map((group) => group.subjectId));
  const alert = (rule: SigninAlert["rule"], group: Group, index: number): SigninAlert => {
    const shown = identifierFor(actor, group.identifier ?? null);
    return {
      rule,
      // the row key is opaque: the group's own key IS what was typed (a full phone number) for some rules, and keys
      // travel in the page's data like every other field (review 2026-11-11)
      key: `${rule}:${index}`,
      count: Number(group.n),
      lastAt: Number(group.lastAt),
      identifier: shown.text,
      identifierMasked: shown.masked,
      ip: group.ip ?? null,
      subjectId: group.subjectKind === "employee" ? (group.subjectId ?? null) : null,
      subjectName: group.subjectKind === "employee" && group.subjectId ? (names.get(group.subjectId) ?? null) : null,
    };
  };
  const alerts = [
    ...lockouts.map((group, index) => alert("lockout", group, index)),
    ...identifiers.map((group, index) => alert("identifier_failures", group, index)),
    ...ips.map((group, index) => alert("ip_failures", group, index)),
    ...sprays.map((group, index) => alert("unknown_spray", group, index)),
    ...disabled.map((group, index) => alert("disabled_account", group, index)),
    ...mfa.map((group, index) => alert("mfa_failures", group, index)),
    ...offRefused.map((group, index) => alert("two_step_off_refused", group, index)),
    ...fresh.map((group, index) => alert("new_address", group, index)),
  ].sort((a, b) => b.lastAt - a.lastAt);
  const total = totals[0];
  return {
    window,
    totals: { attempts: Number(total?.attempts ?? 0), failures: Number(total?.failures ?? 0), lockouts: lockouts.reduce((sum, group) => sum + Number(group.n), 0), staffFailures: Number(total?.staff ?? 0), customerFailures: Number(total?.customers ?? 0) },
    alerts,
  };
}

export type SigninPage = { rows: AuthEventView[]; total: number; page: number; pageCount: number; kinds: string[] };

/** The log itself, newest first, with the filters of the page (window, outcome, staff or customers, kind, search). */
export async function listAuthEvents(db: Db, actor: Actor, filters: SigninFilters, now: number): Promise<SigninPage> {
  assertCan(actor, "security.auth_event.read");
  const parts: SQL[] = [gte(authEvents.at, now - WINDOW_MS[filters.window])];
  if (filters.outcome) parts.push(eq(authEvents.success, filters.outcome === "succeeded"));
  if (filters.subject) parts.push(eq(authEvents.subjectKind, filters.subject));
  if (filters.kind) parts.push(eq(authEvents.kind, filters.kind));
  if (filters.q) {
    const phone = normalizeIraqPhone(filters.q);
    if (phone) {
      // a full number finds its events for everyone (it was typed in full); partial digits would reveal numbers, so no
      parts.push(eq(authEvents.identifier, phone));
    } else if (/^[0-9a-f:.]{3,45}$/i.test(filters.q)) {
      parts.push(sql`${authEvents.ip} LIKE ${`${filters.q}%`}`);
    } else {
      const text = `%${filters.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      parts.push(can(actor, "customer.phone.read_full") ? sql`${authEvents.identifier} LIKE ${text} ESCAPE '\\'` : sql`${authEvents.identifier} LIKE ${text} ESCAPE '\\' AND ${authEvents.subjectKind} = 'employee'`);
    }
  }
  const where = and(...parts);
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, kinds] = await Promise.all([
    db.select().from(authEvents).where(where).orderBy(desc(authEvents.at)).limit(PAGE_SIZE).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(authEvents).where(where).get(),
    db.all<{ kind: string }>(sql`SELECT DISTINCT kind FROM auth_events ORDER BY kind`),
  ]);
  const names = await employeeNames(
    db,
    rows.filter((row) => row.subjectKind === "employee").map((row) => row.subjectId),
  );
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => authEventView(actor, row, row.subjectKind === "employee" && row.subjectId ? (names.get(row.subjectId) ?? null) : null)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    kinds: kinds.map((row) => row.kind),
  };
}

/** For the module's front page: alerts in the last 24 hours. */
export async function alertCount(db: Db, actor: Actor, now: number): Promise<number | null> {
  if (!can(actor, "security.auth_event.read")) return null;
  return (await signinOverview(db, actor, "24h", now)).alerts.length;
}
