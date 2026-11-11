/**
 * The customer profile page's action (/admin/customers/:customerId) — one POST endpoint, a few intents. Each intent
 * first checks the permission it needs at the route (403 before anything is read), then calls a service that checks
 * it again (assertCan) and validates its input (zod). Kept apart from the route module so tests can call it with a
 * hand-made session and form.
 *
 *   note     addCustomerNote     (append-only)                                   customers.customer.note
 *   vip      setVip              (label or none, with a reason)                  customers.customer.update
 *   flag     setFraudFlag        (raise / clear, with a reason)                  customers.customer.block
 *   block    setBlocked          (block / unblock, with a reason)                customers.customer.block
 */
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import { can } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { setBlocked, setFraudFlag, setVip } from "~/server/services/admin/customers/flags.server";
import { addCustomerNote } from "~/server/services/admin/customers/profile.server";
import { failure, text, type Failure } from "./customers.server";

export const PROFILE_INTENTS = ["note", "vip", "flag", "block"] as const;
export type ProfileIntent = (typeof PROFILE_INTENTS)[number];

const NEEDS: Record<ProfileIntent, Permission> = {
  note: "customers.customer.note",
  vip: "customers.customer.update",
  flag: "customers.customer.block",
  block: "customers.customer.block",
};

export type ProfileActionResult = { ok: true; intent: ProfileIntent; replayed?: boolean; value?: string | boolean | null } | Failure;

const yes = (value: string) => value === "1" || value === "true" || value === "on";

export async function profileAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, customerId: string, form: FormData): Promise<ProfileActionResult> {
  const raw = text(form, "intent");
  const intent = (PROFILE_INTENTS as readonly string[]).includes(raw) ? (raw as ProfileIntent) : null;
  const { actor } = session;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!can(actor, NEEDS[intent])) throw forbidden(NEEDS[intent]);
    switch (intent) {
      case "note":
        await addCustomerNote(db, actor, { customerId, text: text(form, "text") }, ctx.now);
        return { ok: true, intent };
      case "vip": {
        const result = await setVip(db, actor, { customerId, tier: text(form, "tier") || null, reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent, value: result.tier };
      }
      case "flag": {
        const result = await setFraudFlag(db, actor, { customerId, flagged: yes(text(form, "flagged")), reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent, value: result.flagged };
      }
      case "block": {
        const result = await setBlocked(db, actor, { customerId, blocked: yes(text(form, "blocked")), reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent, value: result.status };
      }
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
