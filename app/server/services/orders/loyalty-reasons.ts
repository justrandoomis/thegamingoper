/**
 * The reasons on `loyalty_ledger` rows that the store writes itself — not a person — in ONE format, so the admin's points
 * ledger can say them in its own language (client round 1, wave C: «TT-5TQZ9GXP · cancelled» stood in the Arabic
 * ledger, an English word the admin showed as it was stored).
 *
 * The stored text is a CODE, not a sentence; it is the format the ledger has held since 2026-11-12, so rows already
 * written read exactly like new ones (nothing is rewritten):
 *
 *   "<order ref>"                        order      points redeemed at checkout (core) · points earned after delivery (module 08)
 *   "<order ref> · cancelled"            cancelled  redeemed points given back: the order was cancelled (core)
 *   "<order ref> · returned"             returned   … the parcel came back undelivered (core)
 *   "<order ref> · refund <refund id>"   refund     a refund's share: redeemed points given back (core, ref_type "redeem"),
 *                                                   or earned points taken back (module 08, ref_type "order")
 *   "expired by <YYYY-MM-DD>"            expired    points that expired, by that day (UTC) (module 08)
 *   "referral <CODE>"                    referral   a referral's reward (module 08)
 *
 * Anything else is a person's words (a manual adjustment, its approval) and is shown as typed.
 *
 *   readLoyaltyReason("TT-5TQZ9GXP · cancelled")      // { code: "cancelled", ref: "TT-5TQZ9GXP" }
 *   readLoyaltyReason("منحة نقاط")                     // null — a person's words
 *   loyaltyReasonText({ code: "refund", ref, refundId })   // what a writer stores
 *
 * A screen translates the code (the admin: `points.reason.<code>` with `ref`, `date`, `referralCode`), formats the date
 * itself, and shows the references isolated left-to-right. The refund id is for the machine (the row's `ref_id` says it
 * too), not for a sentence. Pure: no database, no "cloudflare:workers".
 */

export const LOYALTY_REASON_CODES = ["order", "cancelled", "returned", "refund", "expired", "referral"] as const;
export type LoyaltyReasonCode = (typeof LOYALTY_REASON_CODES)[number];

/** A reason the store writes itself, as a code and its values. */
export type LoyaltyReason =
  | { code: "order"; ref: string }
  | { code: "cancelled"; ref: string }
  | { code: "returned"; ref: string }
  | { code: "refund"; ref: string; refundId: string }
  | { code: "expired"; date: string }
  | { code: "referral"; referralCode: string };

/** Between an order's reference and what happened to it. */
const SEPARATOR = " · ";

/** A human order reference (publicRef: "TT-7K4M2Q9X"); the till and the tests use the same shape. */
const REF = "[A-Z]{2,5}-[0-9A-Z]{4,16}";
/** A row id (newId: "rfd_01JD…"). */
const ID = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";

const PATTERNS: readonly { pattern: RegExp; read: (match: RegExpExecArray) => LoyaltyReason }[] = [
  { pattern: new RegExp(`^(${REF})$`), read: (m) => ({ code: "order", ref: m[1]! }) },
  { pattern: new RegExp(`^(${REF}) · (cancelled|returned)$`), read: (m) => ({ code: m[2] as "cancelled" | "returned", ref: m[1]! }) },
  { pattern: new RegExp(`^(${REF}) · refund (${ID})$`), read: (m) => ({ code: "refund", ref: m[1]!, refundId: m[2]! }) },
  { pattern: /^expired by (\d{4}-\d{2}-\d{2})$/, read: (m) => ({ code: "expired", date: m[1]! }) },
  { pattern: /^referral ([A-Z0-9][A-Z0-9-]{2,19})$/, read: (m) => ({ code: "referral", referralCode: m[1]! }) },
];

/** The text a writer stores for a reason of its own (the format above). */
export function loyaltyReasonText(reason: LoyaltyReason): string {
  switch (reason.code) {
    case "order":
      return reason.ref;
    case "cancelled":
    case "returned":
      return `${reason.ref}${SEPARATOR}${reason.code}`;
    case "refund":
      return `${reason.ref}${SEPARATOR}refund ${reason.refundId}`;
    case "expired":
      return `expired by ${reason.date}`;
    case "referral":
      return `referral ${reason.referralCode}`;
  }
}

/** A stored reason read back: one the store wrote itself (any row since 2026-11-12), or null for a person's words. */
export function readLoyaltyReason(text: string | null | undefined): LoyaltyReason | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 200) return null;
  for (const { pattern, read } of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return read(match);
  }
  return null;
}
