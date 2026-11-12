/**
 * The address book's field checks — client-safe and pure (no React, no server imports at runtime). The same rules as
 * the address service (AddressInput in ~/server/services/account/addresses.server, with the limits it shares through
 * ADDRESS_LIMITS) and the same words as the checkout's delivery fields: a problem is an ISSUE — a message key under
 * `addresses.fields.<field>.<code>` in the "account" namespace (the checkout's own sentences, app/i18n/messages/
 * account.ts takes them from checkout.ts) plus the number it needs — never a sentence.
 *
 *   addressFieldIssue("areaText", "")          → { code: "required" }         «اكتب المنطقة أو الحي.»
 *   addressFieldIssue("phone", "0770 123")     → { code: "short", count: 4 }  the checkout's phone rule (phoneIssue)
 *   addressIssues(values)                      → every problem of the form, for the error summary before sending
 *
 * The page checks a field when it is left, again on every keystroke once a problem shows, and every field before the
 * form is sent (an empty required field never costs a request). The service checks everything again.
 */
import { ADDRESS_LIMITS as L } from "~/server/services/account/types";
import { phoneIssue, type FieldIssue } from "~/routes/storefront/checkout/checkout-form";

/** The form's checked fields, in the order they appear (the first one with a problem takes the focus). */
export const ADDRESS_FIELDS = ["label", "recipientName", "phone", "governorateId", "districtId", "areaText", "addressText", "notes"] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];
export type AddressIssues = Partial<Record<AddressField, FieldIssue>>;
export type { FieldIssue };

/** The element each field's problem points at (the error summary's links, the focus after a refused send). */
export const ADDRESS_FIELD_IDS: Record<AddressField, string> = {
  label: "address-label",
  recipientName: "address-recipient",
  phone: "address-phone",
  governorateId: "address-governorate",
  districtId: "address-district",
  areaText: "address-area",
  addressText: "address-text",
  notes: "address-notes",
};

const length = (value: string) => value.trim().length;
const tooLong = (value: string, max: number): FieldIssue | null => (length(value) > max ? { code: "too_long", count: max } : null);

/** One field's problem, or null. */
export function addressFieldIssue(name: AddressField, raw: string | null | undefined): FieldIssue | null {
  const value = raw ?? "";
  switch (name) {
    case "label":
      return tooLong(value, L.label);
    case "recipientName":
      if (length(value) === 0) return null;
      return length(value) < L.recipientMin ? { code: "too_short" } : tooLong(value, L.recipient);
    case "phone":
      // the recipient's number is optional; one that is typed is checked as the checkout checks the shopper's
      if (length(value) === 0) return null;
      return length(value) > L.phone ? { code: "long_text" } : phoneIssue(value);
    case "governorateId":
      return value ? null : { code: "required" };
    case "districtId":
      // optional; with script the list holds only the chosen governorate's districts (the service checks the pair)
      return null;
    case "areaText":
      if (length(value) === 0) return { code: "required" };
      return length(value) < L.areaMin ? { code: "too_short" } : tooLong(value, L.area);
    case "addressText":
      if (length(value) === 0) return { code: "required" };
      return length(value) < L.addressMin ? { code: "too_short" } : tooLong(value, L.address);
    case "notes":
      return tooLong(value, L.notes);
  }
}

/** Every problem of the form's values (a missing value counts as empty). */
export function addressIssues(values: Partial<Record<string, string | null | undefined>>): AddressIssues {
  const issues: AddressIssues = {};
  for (const name of ADDRESS_FIELDS) {
    const issue = addressFieldIssue(name, values[name]);
    if (issue) issues[name] = issue;
  }
  return issues;
}

/** The first field (in page order) with a problem, or null. */
export function firstAddressIssue(issues: AddressIssues): AddressField | null {
  return ADDRESS_FIELDS.find((name) => issues[name] !== undefined) ?? null;
}
