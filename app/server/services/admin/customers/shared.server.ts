/**
 * Admin module 07 — helpers shared by the customer services: what this employee may see and do here, phones as they
 * may see them, the customer row a mutation acts on, and employee names for the screens.
 *
 * Authorization lives in the services (assertCan); the access flags below only decide what a screen offers and which
 * sections a loader fills — a section the employee may not read is ABSENT from the loader data (null), never sent and
 * hidden (CONTRACTS §4, SECURITY §7).
 */
import { eq, inArray } from "drizzle-orm";
import { formatIraqPhone, maskPhone, toLatinDigits } from "~/lib/phone";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { customers, employees, type Customer } from "~/server/db/schema";
import { AppError, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import type { CustomerAccess, PhoneView } from "./types";

/** Error keys of this module (texts: admin-customers → errors.*). */
export const CUSTOMER_ERROR_KEYS = [
  "customer_unavailable",
  "customer_changed",
  "address_limit",
  "district_invalid",
  "note_has_card_number",
  "consent_not_granted",
  "privacy_not_verified",
  "privacy_not_exported",
  "privacy_not_open",
  "privacy_wrong_kind",
  "privacy_already_verified",
  "privacy_customer_required",
  "privacy_open_exists",
  "erasure_blocked",
  "merge_same_account",
  "merge_blocked",
  "merge_plan_changed",
  "merge_already_done",
  "segments_changed",
  "vip_unchanged",
  "flag_unchanged",
  "status_unchanged",
] as const;
export type CustomerErrorKey = (typeof CUSTOMER_ERROR_KEYS)[number];

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** What this employee may see and do in module 07 (and the neighbouring modules the profile links to). */
export function customersAccess(actor: Actor): CustomerAccess {
  return {
    read: can(actor, "customers.customer.read"),
    update: can(actor, "customers.customer.update"),
    note: can(actor, "customers.customer.note"),
    merge: can(actor, "customers.customer.merge"),
    block: can(actor, "customers.customer.block"),
    export: can(actor, "customers.customer.export"),
    segments: can(actor, "customers.segment.manage"),
    consents: can(actor, "customers.consent.read"),
    privacy: can(actor, "customers.privacy.manage"),
    wallet: can(actor, "customers.wallet.read"),
    communication: can(actor, "customers.communication.read"),
    fullPhone: can(actor, "customer.phone.read_full"),
    orders: can(actor, "orders.order.read"),
    returns: can(actor, "returns.rma.read"),
    warranties: can(actor, "returns.warranty.read"),
    repairs: canAny(actor, ["returns.repair.manage", "returns.rma.read"]),
    tickets: can(actor, "support.ticket.read"),
    financeWallet: can(actor, "finance.wallet.read"),
    walletAdjust: can(actor, "customers.wallet.adjust"),
  };
}

/** The employee's id for audit and "who did it" columns. */
export function actorId(actor: Actor): string {
  return actor.kind === "employee" || actor.kind === "customer" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : "guest";
}

/** A phone as this employee may see it: the full number with customer.phone.read_full, otherwise "0771 ••• ••52". */
export function phoneView(e164: string | null | undefined, full: boolean): PhoneView | null {
  if (!e164 || !e164.startsWith("+964")) return null;
  return full ? { display: formatIraqPhone(e164), full: true } : { display: maskPhone(e164), full: false };
}

export type CustomerRow = Pick<Customer, "id" | "name" | "phoneE164" | "email" | "status" | "locale" | "vipTier" | "fraudFlag" | "fraudReason" | "notes" | "createdAt" | "updatedAt" | "mergedIntoId" | "anonymizedAt" | "isDemo" | "notificationPrefs" | "lastLoginAt" | "phoneVerifiedAt">;

const CUSTOMER_COLUMNS = {
  id: customers.id,
  name: customers.name,
  phoneE164: customers.phoneE164,
  email: customers.email,
  status: customers.status,
  locale: customers.locale,
  vipTier: customers.vipTier,
  fraudFlag: customers.fraudFlag,
  fraudReason: customers.fraudReason,
  notes: customers.notes,
  createdAt: customers.createdAt,
  updatedAt: customers.updatedAt,
  mergedIntoId: customers.mergedIntoId,
  anonymizedAt: customers.anonymizedAt,
  isDemo: customers.isDemo,
  notificationPrefs: customers.notificationPrefs,
  lastLoginAt: customers.lastLoginAt,
  phoneVerifiedAt: customers.phoneVerifiedAt,
} as const;

/** The customer row, or 404 (also for a malformed id). */
export async function customerById(db: Db, customerId: string): Promise<CustomerRow> {
  if (typeof customerId !== "string" || !ID.test(customerId)) throw notFound("customer");
  const row = await db.select(CUSTOMER_COLUMNS).from(customers).where(eq(customers.id, customerId)).get();
  if (!row) throw notFound("customer");
  return row;
}

/** A customer that may still change: merged and erased accounts are read-only history (customer_unavailable, 409). */
export async function changeableCustomer(db: Db, customerId: string): Promise<CustomerRow> {
  const row = await customerById(db, customerId);
  if (row.status === "merged" || row.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: row.status });
  return row;
}

/** assertCan for a list of permissions where any one is enough. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) assertCan(actor, permissions[0]);
}

/** Employee id → name (ids that are not employees are left out). */
export async function employeeNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(":")))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

/**
 * Free text that must not carry a card or account number: 12 or more digits in a row (spaces and dashes allowed),
 * once Iraqi mobile numbers are taken out (those are masked by the audit trail anyway).
 */
export function hasLongDigitRun(text: string): boolean {
  return /(?:\d[\s-]?){12,}/.test(toLatinDigits(maskPhonesIn(text)));
}

export const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
