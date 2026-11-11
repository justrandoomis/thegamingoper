/**
 * The actions of module 07's pages (besides the profile's, customer.server.ts) — each one POST endpoint with a few
 * intents. Every intent checks the permission it needs at the route first (403 before anything is read), then calls a
 * service that checks it again (assertCan) and validates the raw input (zod). Ids in the form are scoped to the page's
 * customer or request. Kept apart from the route modules so tests can call them with a hand-made session and form.
 *
 *   contactAction          details · address-save · address-delete · address-default · channels   customers.customer.update
 *   customerPrivacyAction  withdraw (customers.privacy.manage) · request (customers.privacy.manage)
 *   messagesAction         log (customers.customer.note)
 *   mergeAction            merge (customers.customer.merge)
 *   segmentsAction         recompute (customers.segment.manage)
 *   privacyQueueAction     request (customers.privacy.manage)
 *   privacyRequestAction   verify · reject · complete · unsubscribe · erase (customers.privacy.manage)
 */
import { can } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { logContact } from "~/server/services/admin/customers/communication.server";
import { deleteCustomerAddress, saveCustomerAddress, setCustomerChannels, setCustomerDefaultAddress, updateCustomerDetails } from "~/server/services/admin/customers/contact.server";
import { mergeCustomers } from "~/server/services/admin/customers/merge.server";
import { completePrivacyRequest, createPrivacyRequest, executeErasure, executeUnsubscribe, recordWithdrawal, rejectPrivacyRequest, verifyPrivacyRequest } from "~/server/services/admin/customers/privacy.server";
import { recomputeSegments } from "~/server/services/admin/customers/rfm.server";
import { checked, failure, optional, text, type Failure } from "./customers.server";

type Ctx = Pick<AuthCtx, "locale" | "now">;
export type ActionOk = { ok: true; intent: string; replayed?: boolean; [key: string]: unknown };
export type PageActionResult = ActionOk | Failure;

function intentOf<T extends string>(form: FormData, intents: Record<T, Permission>): T | null {
  const raw = text(form, "intent");
  return Object.prototype.hasOwnProperty.call(intents, raw) ? (raw as T) : null;
}

async function run<T extends string>(ctx: Ctx, session: EmployeeSession, form: FormData, intents: Record<T, Permission>, handle: (intent: T) => Promise<ActionOk>): Promise<PageActionResult> {
  const intent = intentOf(form, intents);
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!can(session.actor, intents[intent])) throw forbidden(intents[intent]);
    return await handle(intent);
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

const CONTACT = { details: "customers.customer.update", "address-save": "customers.customer.update", "address-delete": "customers.customer.update", "address-default": "customers.customer.update", channels: "customers.customer.update" } as const satisfies Record<string, Permission>;

export function contactAction(ctx: Ctx, db: Db, session: EmployeeSession, customerId: string, form: FormData): Promise<PageActionResult> {
  const { actor } = session;
  return run(ctx, session, form, CONTACT, async (intent) => {
    switch (intent) {
      case "details": {
        const result = await updateCustomerDetails(db, actor, { customerId, name: text(form, "name"), email: text(form, "email"), locale: text(form, "locale") as never, reason: text(form, "reason"), expectedUpdatedAt: Number(text(form, "expectedUpdatedAt")) }, ctx.now);
        return { ok: true, intent, changed: result.changed };
      }
      case "address-save": {
        const result = await saveCustomerAddress(
          db,
          actor,
          {
            customerId,
            id: optional(form, "id"),
            label: text(form, "label"),
            recipientName: text(form, "recipientName"),
            phone: text(form, "phone"),
            governorateId: text(form, "governorateId"),
            districtId: text(form, "districtId"),
            areaText: text(form, "areaText"),
            addressText: text(form, "addressText"),
            notes: text(form, "notes"),
            makeDefault: checked(form, "makeDefault"),
            reason: text(form, "reason"),
            expectedUpdatedAt: optional(form, "expectedUpdatedAt"),
          },
          ctx.now,
        );
        return { ok: true, intent, created: result.created };
      }
      case "address-delete":
        await deleteCustomerAddress(db, actor, { customerId, addressId: text(form, "addressId"), reason: text(form, "reason"), expectedUpdatedAt: optional(form, "expectedUpdatedAt") }, ctx.now);
        return { ok: true, intent };
      case "address-default":
        await setCustomerDefaultAddress(db, actor, { customerId, addressId: text(form, "addressId"), reason: text(form, "reason"), expectedUpdatedAt: optional(form, "expectedUpdatedAt") }, ctx.now);
        return { ok: true, intent };
      case "channels": {
        const result = await setCustomerChannels(db, actor, { customerId, sms: checked(form, "sms"), whatsapp: checked(form, "whatsapp"), email: checked(form, "email"), reason: text(form, "reason"), expectedUpdatedAt: optional(form, "expectedUpdatedAt") }, ctx.now);
        return { ok: true, intent, channels: result };
      }
    }
  });
}

const CUSTOMER_PRIVACY = { withdraw: "customers.privacy.manage", request: "customers.privacy.manage" } as const satisfies Record<string, Permission>;

export function customerPrivacyAction(ctx: Ctx, db: Db, session: EmployeeSession, customerId: string, form: FormData): Promise<PageActionResult> {
  const { actor } = session;
  return run(ctx, session, form, CUSTOMER_PRIVACY, async (intent) => {
    switch (intent) {
      case "withdraw":
        await recordWithdrawal(db, actor, { customerId, kind: text(form, "kind") as never, reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent };
      case "request": {
        const result = await createPrivacyRequest(db, actor, { customerId, kind: text(form, "kind") as never, details: text(form, "details"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now);
        return { ok: true, intent, replayed: result.replayed, ref: result.ref };
      }
    }
  });
}

const MESSAGES = { log: "customers.customer.note" } as const satisfies Record<string, Permission>;

export function messagesAction(ctx: Ctx, db: Db, session: EmployeeSession, customerId: string, form: FormData): Promise<PageActionResult> {
  return run(ctx, session, form, MESSAGES, async (intent) => {
    await logContact(db, session.actor, { customerId, channel: text(form, "channel") as never, direction: text(form, "direction") as never, orderRef: text(form, "orderRef"), summary: text(form, "summary") }, ctx.now);
    return { ok: true, intent };
  });
}

const MERGE = { merge: "customers.customer.merge" } as const satisfies Record<string, Permission>;

/** The kept account is the page's customer; the duplicate comes from the form. */
export function mergeAction(ctx: Ctx, db: Db, session: EmployeeSession, keepId: string, form: FormData): Promise<PageActionResult> {
  return run(ctx, session, form, MERGE, async (intent) => {
    const result = await mergeCustomers(db, session.actor, { keepId, mergeId: text(form, "mergeId"), method: text(form, "method") as never, verification: text(form, "verification"), reason: text(form, "reason"), fingerprint: text(form, "fingerprint") }, ctx.now);
    return { ok: true, intent, replayed: result.replayed };
  });
}

const SEGMENTS = { recompute: "customers.segment.manage" } as const satisfies Record<string, Permission>;

export function segmentsAction(ctx: Ctx, db: Db, session: EmployeeSession, form: FormData): Promise<PageActionResult> {
  return run(ctx, session, form, SEGMENTS, async (intent) => {
    const result = await recomputeSegments(db, session.actor, ctx.now);
    return { ok: true, intent, total: result.total };
  });
}

const PRIVACY_QUEUE = { request: "customers.privacy.manage" } as const satisfies Record<string, Permission>;

export function privacyQueueAction(ctx: Ctx, db: Db, session: EmployeeSession, form: FormData): Promise<PageActionResult> {
  return run(ctx, session, form, PRIVACY_QUEUE, async (intent) => {
    const result = await createPrivacyRequest(db, session.actor, { customerId: optional(form, "customerId"), phone: text(form, "phone"), kind: text(form, "kind") as never, details: text(form, "details"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now);
    return { ok: true, intent, replayed: result.replayed, ref: result.ref };
  });
}

const PRIVACY_REQUEST = { verify: "customers.privacy.manage", reject: "customers.privacy.manage", complete: "customers.privacy.manage", unsubscribe: "customers.privacy.manage", erase: "customers.privacy.manage" } as const satisfies Record<string, Permission>;

export function privacyRequestAction(ctx: Ctx, db: Db, session: EmployeeSession, ref: string, form: FormData): Promise<PageActionResult> {
  const { actor } = session;
  return run(ctx, session, form, PRIVACY_REQUEST, async (intent) => {
    switch (intent) {
      case "verify":
        await verifyPrivacyRequest(db, actor, { ref, method: text(form, "method") as never, note: text(form, "note") }, ctx.now);
        return { ok: true, intent };
      case "reject":
        await rejectPrivacyRequest(db, actor, { ref, note: text(form, "note") }, ctx.now);
        return { ok: true, intent };
      case "complete":
        await completePrivacyRequest(db, actor, { ref, note: text(form, "note") }, ctx.now);
        return { ok: true, intent };
      case "unsubscribe": {
        const result = await executeUnsubscribe(db, actor, { ref, kinds: form.getAll("kind").map(String) as never, note: text(form, "note") }, ctx.now);
        return { ok: true, intent, withdrawn: result.withdrawn };
      }
      case "erase":
        await executeErasure(db, actor, { ref, reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent };
    }
  });
}
