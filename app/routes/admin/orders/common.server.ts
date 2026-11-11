/**
 * Route glue shared by the pages of module 05: the strings they send down, the URLs of private files, and how a
 * failed action becomes `{ ok: false, intent, code, message, fields }` in the employee's language.
 */
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { actionError } from "~/server/errors";
import { parseIqd } from "~/server/services/admin/orders/types";

export const ORDERS_NS = "admin-orders";

export function ordersI18n(locale: Locale) {
  return messagesFor(locale, ORDERS_NS, "errors");
}

export const urls = {
  proofImage: (proofId: string) => `/admin/orders/proofs/image/${encodeURIComponent(proofId)}`,
  deliveryProof: (fileId: string) => `/admin/orders/files/${encodeURIComponent(fileId)}`,
};

/** `t()` that knows this module's own error texts first, then the shared "errors" namespace. */
function errorT(locale: Locale) {
  const mine = getNamespace(ORDERS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type Failure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

/** An expected failure as data (status kept for the response); anything else is rethrown to the error boundary. */
export function failure(error: unknown, locale: Locale, intent: string | null): Failure {
  const result = actionError(error, errorT(locale));
  return { ok: false, intent, code: result.code, message: result.message, fields: result.fields, status: result.status };
}

export const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** A whole number of dinars typed by a person ("754,000", "754000", Arabic or Persian digits) or undefined (parseIqd). */
export function amountOf(form: FormData, name: string): number | undefined {
  return parseIqd(text(form, name));
}
