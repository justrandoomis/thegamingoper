/**
 * Staff accounts in the auth core (SECURITY.md §6–7) — what modules 15 (staff) and 20 (security) call to create,
 * re-open and protect employee accounts. Sessions, sign-in and two-step verification themselves live in
 * ./admin.server.ts; this module only adds the account lifecycle around them.
 *
 *   createEmployee        a new account (no password yet) with its roles, and a ONE-TIME password-set link
 *   issuePasswordLink     a new link for an employee (a new hire whose link ran out, a forgotten password)
 *   checkPasswordLink     who a link is for (the /admin/welcome page, before the password is typed)
 *   setPasswordWithLink   the employee sets their password with the link: once, before it runs out
 *   enableEmployee        a disabled account opens again (optionally with a new password link)
 *   setRoleTwoStepRequired / roleTwoStep   two-step verification required for everyone holding a role
 *
 * The link: `/admin/welcome#<token>` — the token is random (256 bits), shown ONCE to the staff member who made it, and
 * never stored (only its SHA-256), never written to the audit trail and never sent: there is no message provider, so
 * the staff member hands it over in person. It sits in the URL's fragment, which browsers never send to a server, so
 * it reaches no request log either. A link works once, for PASSWORD_LINK_HOURS, and only while it is the employee's
 * newest (making a new one revokes the older ones) and the account was never closed since it was made (disableEmployee
 * revokes every unused link, and enableEmployee whatever is left: re-opening an account never brings an old link
 * back); setting the password with it signs the employee out everywhere. Two-step verification is untouched by it: a
 * reset by link never removes the second factor. The /admin/welcome page's look-ups count per address (origin).
 *
 * Who may act on whom — the hierarchy rule (SECURITY.md §7): giving a role needs every permission it grants (the
 * owner's wildcard only from an owner), and making a link for, or enabling, someone needs every permission they hold
 * (holdsEverythingOf, read inside the change's batch). A branch-limited employee works only on their branch's staff.
 *
 * Errors (texts: `errors.<code>`, CORE_ERROR_KEYS): forbidden (403; detail "branch" for another branch),
 * grant_exceeds_own (403), target_more_privileged (403), own_account_here (409), email_taken (409, fields.email),
 * employee_not_active (409), employee_already_active (409), password_link_invalid (410), not_found (404), invalid
 * (400, fields — fields.branchId for a branch that does not exist), rate_limited (429).
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { assertCan, canAccessBranch, type Actor } from "../actor";
import { auditStatement } from "../audit.server";
import { hashPassword } from "../crypto.server";
import type { BatchStatement, Db } from "../db/drizzle.server";
import { branches, employeePasswordLinks, employeeRoles, employees, roles, type PasswordLinkPurpose } from "../db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "../db/tx.server";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { PERMISSIONS, WILDCARD_PERMISSION } from "../permissions";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "../ratelimit.server";
import { cleanLine } from "../text.server";
import { holdsEverythingOf, revokeEmployeeSessionsStatement, revokePasswordLinksStatement, targetMorePrivileged } from "./admin.server";
import { EMPLOYEE_PASSWORD_MIN, authEventStatement, passwordField } from "./common.server";

/** How long a password-set link works. */
export const PASSWORD_LINK_HOURS = 72;
const PASSWORD_LINK_MS = PASSWORD_LINK_HOURS * 60 * 60 * 1000;

/** The page that takes the link (app/routes/admin/shell/welcome.tsx): the token follows it as the URL's fragment. */
export const PASSWORD_LINK_PATH = "/admin/welcome";

export type PasswordLink = {
  /** Shown ONCE to the staff member who made the link; never stored, never sent. */
  token: string;
  /** `/admin/welcome#<token>` — put the store's origin in front to hand it over. */
  path: string;
  purpose: PasswordLinkPurpose;
  expiresAt: number;
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** What is stored for a link: a hash of the token, under its own context (never the session hash of the same text). */
const linkHash = (token: string) => sha256Hex(`tamtam.password-link|${token}`);

async function newLink(purpose: PasswordLinkPurpose, now: number): Promise<{ link: PasswordLink; idHash: string }> {
  const token = randomToken();
  return { link: { token, path: `${PASSWORD_LINK_PATH}#${token}`, purpose, expiresAt: now + PASSWORD_LINK_MS }, idHash: await linkHash(token) };
}

const actorIdOf = (actor: Actor): string | null => (actor.kind === "employee" ? actor.id : null);

/**
 * Batch item: every unused link of the employee stops working — a new one is made, the account is closed
 * (disableEmployee) or opened again (enableEmployee). The auth core's own statement, shared with admin.server.ts.
 */
const revokeLinksStatement = revokePasswordLinksStatement;

/**
 * Batch guard: the actor holds every permission these roles grant (giving a role needs them all — SECURITY.md §7; the
 * owner's wildcard only an owner gives). Null when there is nothing to check (the system, an owner).
 */
function grantsNothingMore(db: Db, actor: Actor, roleIds: readonly string[]): BatchStatement | null {
  if (actor.kind === "system") return null;
  const held = new Set<string>(actor.kind === "employee" ? actor.permissions : []);
  if (held.has(WILDCARD_PERMISSION)) return null;
  const notHeld = [WILDCARD_PERMISSION, ...PERMISSIONS.filter((permission) => !held.has(permission))];
  return expectThat(
    db,
    sql`NOT EXISTS (SELECT 1 FROM role_permissions AS rp WHERE rp.role_id IN (SELECT value FROM json_each(${JSON.stringify(roleIds)}))
          AND rp.permission IN (SELECT value FROM json_each(${JSON.stringify(notHeld)})))`,
    { code: "GRANT_EXCEEDS_OWN" },
  );
}

const Reason = z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long");
const optionalLine = (max: number) =>
  z
    .string()
    .max(max * 2, "too_long")
    .optional()
    .nullable()
    .transform((value) => (value ? cleanLine(value).trim() : ""))
    .pipe(z.string().max(max, "too_long"))
    .transform((value) => value || null);

export const CreateEmployeeInput = z.object({
  email: z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(200, "email_invalid").pipe(z.email("email_invalid")),
  name: z
    .string({ error: "required" })
    .transform((value) => cleanLine(value).trim())
    .pipe(z.string().min(2, "too_short").max(80, "too_long")),
  phone: optionalLine(40),
  jobTitle: optionalLine(80),
  roleIds: z.array(z.string().trim().min(1).max(80), { error: "required" }).min(1, "required").max(10, "too_big"),
  branchId: z.string().trim().min(1).max(80).nullable().optional(),
  locale: z.enum(["ar", "en"]).optional(),
  reason: Reason,
});

/**
 * A new employee: the account (no password: nobody can sign in to it until the employee uses the link), its roles and
 * a welcome link — `staff.manage`, every permission the roles grant (`grant_exceeds_own`), the actor's own branch when
 * they are limited to one. One batch with its audit event (`staff.employee.create`, the roles by key, never the link).
 * The same email twice → `email_taken` (a double click creates one account; the second gets no link either).
 */
export async function createEmployee(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ employeeId: string; link: PasswordLink }> {
  assertCan(actor, "staff.manage");
  const input = CreateEmployeeInput.parse(raw);
  const roleIds = [...new Set(input.roleIds)];
  // a branch-limited employee hires for their own branch only (module 15's reach rule)
  const limit = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  if (limit && input.branchId && input.branchId !== limit) throw forbidden("branch");
  const branchId = limit ?? input.branchId ?? null;

  const found = await db.select({ id: roles.id, key: roles.key }).from(roles).where(sql`${roles.id} IN (SELECT value FROM json_each(${JSON.stringify(roleIds)}))`);
  if (found.length !== roleIds.length) throw new AppError("invalid", 400, { fields: { roleIds: "invalid" } });
  // a branch that does not exist is the form's mistake (a field error), never the database's foreign-key refusal
  const branchUnknown = () => new AppError("invalid", 400, { fields: { branchId: "invalid" } });
  if (branchId && !(await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).get())) throw branchUnknown();

  const employeeId = newId("emp");
  const { link, idHash } = await newLink("welcome", now);
  const hierarchy = grantsNothingMore(db, actor, roleIds);
  try {
    await runBatch(db, [
      ...(hierarchy ? [hierarchy] : []),
      // the roles still exist (none deleted since they were read), and so does the branch
      expectThat(db, sql`(SELECT count(*) FROM roles WHERE id IN (SELECT value FROM json_each(${JSON.stringify(roleIds)}))) = ${roleIds.length}`, { code: "ROLE_UNKNOWN" }),
      ...(branchId ? [expectThat(db, sql`EXISTS (SELECT 1 FROM branches WHERE id = ${branchId})`, { code: "BRANCH_UNKNOWN" })] : []),
      db.insert(employees).values({
        id: employeeId,
        email: input.email,
        name: input.name,
        phone: input.phone,
        jobTitle: input.jobTitle,
        passwordHash: null,
        status: "active",
        branchId,
        locale: input.locale ?? "ar",
        isDemo: options.demo === true,
        createdAt: now,
        updatedAt: now,
      }),
      ...roleIds.map((roleId) => db.insert(employeeRoles).values({ employeeId, roleId, grantedBy: actorIdOf(actor), grantedAt: now })),
      db.insert(employeePasswordLinks).values({ idHash, employeeId, purpose: "welcome", createdBy: actorIdOf(actor), createdAt: now, expiresAt: link.expiresAt }),
      auditStatement(db, {
        actor,
        action: "staff.employee.create",
        entityType: "employee",
        entityId: employeeId,
        after: { email: input.email, name: input.name, roles: found.map((role) => role.key).sort(), branchId, jobTitle: input.jobTitle, demo: options.demo === true, passwordLinkExpiresAt: link.expiresAt },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "GRANT_EXCEEDS_OWN")) throw new AppError("grant_exceeds_own", 403, { fields: { roleIds: "grant_exceeds_own" } });
    if (isDbError(error, "ROLE_UNKNOWN")) throw new AppError("invalid", 400, { fields: { roleIds: "invalid" } });
    if (isDbError(error, "BRANCH_UNKNOWN")) throw branchUnknown();
    if (isUniqueViolation(error, "employees.email")) throw new AppError("email_taken", 409, { fields: { email: "email_taken" } });
    throw error;
  }
  return { employeeId, link };
}

const TargetInput = z.object({ employeeId: z.string().trim().min(1).max(80), reason: Reason });

type Target = { id: string; status: "active" | "disabled"; branchId: string | null; hasPassword: boolean };

/** Someone else's account, within the actor's branch; 404 for an unknown id. */
async function targetOf(db: Db, actor: Actor, employeeId: string): Promise<Target> {
  if (actorIdOf(actor) === employeeId) throw conflict("own_account_here", employeeId);
  const row = await db.select({ id: employees.id, status: employees.status, branchId: employees.branchId, passwordHash: employees.passwordHash }).from(employees).where(eq(employees.id, employeeId)).get();
  if (!row) throw notFound("employee");
  if (!canAccessBranch(actor, row.branchId)) throw forbidden("branch");
  return { id: row.id, status: row.status, branchId: row.branchId, hasPassword: row.passwordHash !== null };
}

/**
 * A new password-set link for another active employee — `staff.manage` and every permission they hold
 * (`target_more_privileged`): whoever holds the link sets the password, so making one for a stronger account would be
 * taking it over. Their older unused links stop working; their sessions stay until the link is used. `welcome` while
 * they never had a password, `reset` after. Audited (`staff.employee.password_link`, never the token).
 */
export async function issuePasswordLink(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ link: PasswordLink }> {
  assertCan(actor, "staff.manage");
  const input = TargetInput.parse(raw);
  const target = await targetOf(db, actor, input.employeeId);
  if (target.status !== "active") throw conflict("employee_not_active", target.id);
  const { link, idHash } = await newLink(target.hasPassword ? "reset" : "welcome", now);
  const hierarchy = holdsEverythingOf(db, actor, target.id);
  try {
    await runBatch(db, [
      ...(hierarchy ? [hierarchy] : []),
      db.update(employees).set({ updatedAt: now }).where(and(eq(employees.id, target.id), eq(employees.status, "active"))),
      expectChanged(db, 1, { code: "EMPLOYEE_NOT_ACTIVE", detail: target.id }),
      revokeLinksStatement(db, target.id, now),
      db.insert(employeePasswordLinks).values({ idHash, employeeId: target.id, purpose: link.purpose, createdBy: actorIdOf(actor), createdAt: now, expiresAt: link.expiresAt }),
      auditStatement(db, { actor, action: "staff.employee.password_link", entityType: "employee", entityId: target.id, after: { purpose: link.purpose, expiresAt: link.expiresAt }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "TARGET_MORE_PRIVILEGED")) throw targetMorePrivileged(target.id);
    if (isDbError(error, "EMPLOYEE_NOT_ACTIVE")) throw conflict("employee_not_active", target.id);
    throw error;
  }
  return { link };
}

export type PasswordLinkView = { name: string; email: string; purpose: PasswordLinkPurpose; expiresAt: number };

async function liveLink(db: Db, token: string, now: number) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const idHash = await linkHash(token);
  const row = await db
    .select({ idHash: employeePasswordLinks.idHash, employeeId: employees.id, name: employees.name, email: employees.email, purpose: employeePasswordLinks.purpose, expiresAt: employeePasswordLinks.expiresAt })
    .from(employeePasswordLinks)
    .innerJoin(employees, eq(employees.id, employeePasswordLinks.employeeId))
    .where(and(eq(employeePasswordLinks.idHash, idHash), isNull(employeePasswordLinks.usedAt), isNull(employeePasswordLinks.revokedAt), gt(employeePasswordLinks.expiresAt, now), eq(employees.status, "active")))
    .get();
  return row ?? null;
}

/**
 * Who a link is for, while it works (unused, not revoked, not run out, the account active); null otherwise. With
 * `origin` — the /admin/welcome page, where nobody is signed in — each look-up counts per address against the sign-in
 * limits (RATE_LIMITS.adminSignInIp, a counter of its own): `rate_limited` (429) past it (review 2026-11-12).
 */
export async function checkPasswordLink(db: Db, token: string, now: number, origin?: LinkOrigin): Promise<PasswordLinkView | null> {
  if (origin) await enforceRateLimit(db, await limitKey("admin-password-link-check", "ip", origin.ip), RATE_LIMITS.adminSignInIp, now);
  const row = await liveLink(db, token, now);
  return row ? { name: row.name, email: row.email, purpose: row.purpose, expiresAt: row.expiresAt } : null;
}

export const SetPasswordWithLinkInput = z.object({ token: z.string({ error: "required" }).trim().min(1, "required").max(200, "invalid"), password: passwordField(EMPLOYEE_PASSWORD_MIN) });

export type LinkOrigin = { ip: string | null; userAgent: string | null; requestId?: string | null };

/**
 * The employee sets their password with a link (no session needed — the link is the proof). Limited per address like
 * sign-in (RATE_LIMITS.adminSignInIp, its own counter). In ONE batch: the link used (guarded: once, before it runs
 * out), the password stored, every session of the employee ended (a reset signs an attacker out too), the audit event
 * (`security.password.set_with_link`, the employee as the actor) and a security-log row. Does not sign anyone in.
 * Throws `password_link_invalid` (410) for a link that is unknown, used, replaced, run out or of a disabled account —
 * the same answer for each — and `invalid` (fields.password: password_too_short, …).
 */
export async function setPasswordWithLink(db: Db, raw: unknown, now: number, origin: LinkOrigin): Promise<{ employeeId: string; email: string }> {
  await enforceRateLimit(db, await limitKey("admin-password-link", "ip", origin.ip), RATE_LIMITS.adminSignInIp, now);
  const input = SetPasswordWithLinkInput.parse(raw);
  const link = await liveLink(db, input.token, now);
  if (!link) throw new AppError("password_link_invalid", 410);
  const password = await hashPassword(input.password);
  const self = { kind: "employee" as const, id: link.employeeId, permissions: [] as string[], label: link.name, ip: origin.ip, requestId: origin.requestId ?? null };
  try {
    await runBatch(db, [
      db
        .update(employeePasswordLinks)
        .set({ usedAt: now })
        .where(and(eq(employeePasswordLinks.idHash, link.idHash), isNull(employeePasswordLinks.usedAt), isNull(employeePasswordLinks.revokedAt), gt(employeePasswordLinks.expiresAt, now))),
      expectChanged(db, 1, { code: "PASSWORD_LINK_INVALID" }),
      db
        .update(employees)
        .set({ passwordHash: password.hash, passwordIters: password.iterations, passwordChangedAt: now, updatedAt: now })
        .where(and(eq(employees.id, link.employeeId), eq(employees.status, "active"))),
      expectChanged(db, 1, { code: "PASSWORD_LINK_INVALID" }),
      revokeEmployeeSessionsStatement(db, link.employeeId, now),
      auditStatement(db, { actor: self, action: "security.password.set_with_link", entityType: "employee", entityId: link.employeeId, after: { purpose: link.purpose }, at: now }),
      authEventStatement(db, { now, ip: origin.ip, userAgent: origin.userAgent ?? "" }, { subjectKind: "employee", subjectId: link.employeeId, identifier: link.email, kind: "password_change", success: true, details: { via: "link", purpose: link.purpose } }),
    ]);
  } catch (error) {
    if (isDbError(error, "PASSWORD_LINK_INVALID")) throw new AppError("password_link_invalid", 410);
    throw error;
  }
  return { employeeId: link.employeeId, email: link.email };
}

export const EnableEmployeeInput = TargetInput.extend({ newPasswordLink: z.boolean().optional() });

/**
 * A disabled account opens again — `staff.manage` and every permission the employee holds (`target_more_privileged`):
 * re-opening a stronger account is acting on it as much as closing it. Guarded on "still disabled"
 * (`employee_already_active`). A link made before the account was closed never works again (disableEmployee revokes
 * them; so does this batch, for an account closed before that rule). With `newPasswordLink`, a new link in the same
 * batch (`reset`, or `welcome` while the employee never set a password — a returning employee whose old password
 * nobody should trust, a new hire whose first link was handed to the wrong person); the old password works otherwise.
 * Audited (`staff.employee.enable`).
 */
export async function enableEmployee(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ enabled: true; link: PasswordLink | null }> {
  assertCan(actor, "staff.manage");
  const input = EnableEmployeeInput.parse(raw);
  const target = await targetOf(db, actor, input.employeeId);
  if (target.status === "active") throw conflict("employee_already_active", target.id);
  const fresh = input.newPasswordLink ? await newLink(target.hasPassword ? "reset" : "welcome", now) : null;
  const hierarchy = holdsEverythingOf(db, actor, target.id);
  try {
    await runBatch(db, [
      ...(hierarchy ? [hierarchy] : []),
      db.update(employees).set({ status: "active", disabledAt: null, updatedAt: now }).where(and(eq(employees.id, target.id), eq(employees.status, "disabled"))),
      expectChanged(db, 1, { code: "EMPLOYEE_ALREADY_ACTIVE", detail: target.id }),
      // whatever link was made before the account was closed stays dead (review 2026-11-12)
      revokeLinksStatement(db, target.id, now),
      ...(fresh
        ? [db.insert(employeePasswordLinks).values({ idHash: fresh.idHash, employeeId: target.id, purpose: fresh.link.purpose, createdBy: actorIdOf(actor), createdAt: now, expiresAt: fresh.link.expiresAt })]
        : []),
      auditStatement(db, { actor, action: "staff.employee.enable", entityType: "employee", entityId: target.id, before: { status: "disabled" }, after: { status: "active", passwordLink: fresh ? fresh.link.purpose : null }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "TARGET_MORE_PRIVILEGED")) throw targetMorePrivileged(target.id);
    if (isDbError(error, "EMPLOYEE_ALREADY_ACTIVE")) throw conflict("employee_already_active", target.id);
    throw error;
  }
  return { enabled: true, link: fresh ? fresh.link : null };
}

// ───────────────────────────────────────────────────────────────── two-step verification required per role

export type RoleTwoStep = { roleId: string; required: boolean; members: number; membersWithoutTwoStep: number };

/** A role's two-step requirement and who it concerns (active members; those still to enrol). For module 20's role page. */
export async function roleTwoStep(db: Db, roleId: string): Promise<RoleTwoStep | null> {
  const row = await db.get<{ required: number; members: number; without: number }>(sql`
    SELECT r.requires_mfa AS required,
           (SELECT count(*) FROM employee_roles AS er JOIN employees AS e ON e.id = er.employee_id WHERE er.role_id = r.id AND e.status = 'active') AS members,
           (SELECT count(*) FROM employee_roles AS er JOIN employees AS e ON e.id = er.employee_id WHERE er.role_id = r.id AND e.status = 'active' AND e.totp_enabled = 0) AS without
    FROM roles AS r WHERE r.id = ${roleId}`);
  if (!row) return null;
  return { roleId, required: Number(row.required) === 1, members: Number(row.members ?? 0), membersWithoutTwoStep: Number(row.without ?? 0) };
}

export const RoleTwoStepInput = z.object({ roleId: z.string().trim().min(1).max(80), required: z.boolean(), reason: Reason });

/**
 * Requires (or stops requiring) two-step verification for everyone holding a role — `security.mfa.manage` and every
 * permission the role grants (`target_more_privileged`: only an owner changes it for the owner role). Members without
 * two-step verification are asked to enrol at their next click (an enrolment-only session, admin.server.ts); nobody
 * is signed out. Unchanged → `{ changed: false }`, nothing written. Audited (`security.role.two_step`).
 */
export async function setRoleTwoStepRequired(db: Db, actor: Actor, raw: unknown, now: number): Promise<RoleTwoStep & { changed: boolean }> {
  assertCan(actor, "security.mfa.manage");
  const input = RoleTwoStepInput.parse(raw);
  const before = await roleTwoStep(db, input.roleId);
  if (!before) throw notFound("role");
  if (before.required === input.required) return { ...before, changed: false };
  const held = new Set<string>(actor.kind === "employee" ? actor.permissions : []);
  const notHeld = actor.kind === "system" || held.has(WILDCARD_PERMISSION) ? null : [WILDCARD_PERMISSION, ...PERMISSIONS.filter((permission) => !held.has(permission))];
  try {
    await runBatch(db, [
      ...(notHeld
        ? [
            expectThat(db, sql`NOT EXISTS (SELECT 1 FROM role_permissions AS rp WHERE rp.role_id = ${input.roleId} AND rp.permission IN (SELECT value FROM json_each(${JSON.stringify(notHeld)})))`, {
              code: "TARGET_MORE_PRIVILEGED",
              detail: input.roleId,
            }),
          ]
        : []),
      db.update(roles).set({ requiresMfa: input.required }).where(and(eq(roles.id, input.roleId), eq(roles.requiresMfa, !input.required))),
      expectChanged(db, 1, { code: "ROLE_TWO_STEP_UNCHANGED" }),
      auditStatement(db, {
        actor,
        action: "security.role.two_step",
        entityType: "role",
        entityId: input.roleId,
        before: { requiresMfa: before.required },
        after: { requiresMfa: input.required, membersWithoutTwoStep: before.membersWithoutTwoStep },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "TARGET_MORE_PRIVILEGED")) throw new AppError("target_more_privileged", 403, { detail: input.roleId });
    // someone switched it the same way a moment before
    if (isDbError(error, "ROLE_TWO_STEP_UNCHANGED")) return { ...(await roleTwoStep(db, input.roleId))!, changed: false };
    throw error;
  }
  return { ...(await roleTwoStep(db, input.roleId))!, changed: true };
}
