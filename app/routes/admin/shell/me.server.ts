/**
 * "My security" (/admin/me): the signed-in employee's own account — two-step verification (enrol with a QR code,
 * recovery codes shown once, turn off), password change and their live sessions with sign-out per device. Every
 * change goes through the server core (~/server/auth/admin.server), which audits it, signs other devices out where
 * the security model says so, and rate-limits code attempts.
 *
 * Kept apart from the route module so tests can call it with a hand-made request context.
 */
import { eq } from "drizzle-orm";
import { serverT } from "~/i18n/i18n.server";
import {
  beginTotpEnrollment,
  changeEmployeePassword,
  confirmTotpEnrollment,
  disableOwnTotp,
  listEmployeeSessions,
  revokeAllEmployeeSessions,
  revokeEmployeeSession,
  type AuthCtx,
  type AuthSecrets,
  type EmployeeSession,
} from "~/server/auth/admin.server";
import type { Db } from "~/server/db.server";
import { employees } from "~/server/db/schema";
import { actionError, type FieldErrors } from "~/server/errors";
import { qrPath, type QrPath } from "./qr.server";
import { summarizeUserAgent, type DeviceSummary } from "./ua";

export type MySession = { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string | null; device: DeviceSummary; pendingCode: boolean };

export type MySecurityData = {
  employee: { name: string; email: string; passwordChangedAt: number | null; totpEnabled: boolean };
  /** A role requires two-step verification and it is off: this session opens nothing else until it is on. */
  enrolmentRequired: boolean;
  recoveryCodesLeft: number | null;
  sessions: MySession[];
  now: number;
};

export async function loadMySecurity(ctx: AuthCtx, db: Db, session: EmployeeSession): Promise<MySecurityData> {
  const { employee } = session;
  const [sessions, row] = await Promise.all([
    listEmployeeSessions(db, employee.id, ctx.now, session.session.id),
    db.select({ recoveryCodes: employees.recoveryCodes }).from(employees).where(eq(employees.id, employee.id)).get(),
  ]);
  return {
    employee: { name: employee.name, email: employee.email, passwordChangedAt: employee.passwordChangedAt, totpEnabled: employee.totpEnabled },
    enrolmentRequired: session.restriction === "mfa_enrolment",
    recoveryCodesLeft: employee.totpEnabled ? (row?.recoveryCodes?.length ?? 0) : null,
    sessions: sessions.map((entry) => ({
      id: entry.id,
      current: entry.current,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      ip: entry.ip,
      device: summarizeUserAgent(entry.userAgent),
      pendingCode: employee.totpEnabled && !entry.mfaOk,
    })),
    now: ctx.now,
  };
}

export const ME_INTENTS = ["revoke", "revoke-others", "password", "totp-begin", "totp-confirm", "totp-disable"] as const;
export type MeIntent = (typeof ME_INTENTS)[number];

export type MeActionResult =
  | { ok: true; intent: "revoke"; ended: boolean }
  | { ok: true; intent: "revoke-others" | "password" | "totp-disable" }
  | { ok: true; intent: "totp-begin"; secret: string; qr: QrPath }
  | { ok: true; intent: "totp-confirm"; recoveryCodes: string[] }
  | { ok: false; intent: MeIntent | null; code: string; message?: string; fields?: FieldErrors; status: number };

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" (easier to type into an app). */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function mySecurityAction(ctx: AuthCtx, db: Db, session: EmployeeSession, secrets: Pick<AuthSecrets, "DATA_KEY">, form: FormData): Promise<MeActionResult> {
  const raw = text(form, "intent");
  const intent = (ME_INTENTS as readonly string[]).includes(raw) ? (raw as MeIntent) : null;
  const t = serverT(ctx.locale, "errors");
  try {
    switch (intent) {
      case "revoke": {
        const sessionId = text(form, "sessionId");
        if (!sessionId || sessionId === session.session.id) return { ok: false, intent, code: "invalid", status: 400 };
        const ended = await revokeEmployeeSession(db, session.actor, { employeeId: session.employee.id, sessionId }, ctx.now);
        return { ok: true, intent, ended };
      }
      case "revoke-others":
        await revokeAllEmployeeSessions(db, session.actor, { employeeId: session.employee.id, exceptSessionId: session.session.id }, ctx.now);
        return { ok: true, intent };
      case "password": {
        const newPassword = text(form, "newPassword");
        if (newPassword && newPassword !== text(form, "confirmPassword")) {
          return { ok: false, intent, code: "invalid", status: 400, fields: { confirmPassword: serverT(ctx.locale, "admin")("me.password.mismatch") } };
        }
        await changeEmployeePassword(ctx, db, { currentPassword: text(form, "currentPassword"), newPassword });
        return { ok: true, intent };
      }
      case "totp-begin": {
        // The password again: a copy of this session's cookie alone must not tie the account to another phone.
        const enrolment = await beginTotpEnrollment(ctx, db, secrets, { password: text(form, "password") });
        return { ok: true, intent, secret: groupSecret(enrolment.secret), qr: qrPath(enrolment.uri) };
      }
      case "totp-confirm": {
        const { recoveryCodes } = await confirmTotpEnrollment(ctx, db, { code: text(form, "code") }, secrets);
        return { ok: true, intent, recoveryCodes };
      }
      case "totp-disable":
        await disableOwnTotp(ctx, db, { password: text(form, "password"), code: text(form, "code") }, secrets);
        return { ok: true, intent };
      default:
        return { ok: false, intent: null, code: "invalid", status: 400 };
    }
  } catch (error) {
    const failure = actionError(error, t);
    return { ok: false, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status };
  }
}
