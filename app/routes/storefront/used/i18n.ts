/**
 * Strings of the used area (client-safe). The loaders hand down the "used" and "errors" namespaces.
 *
 *   const t = useUsedT();               // t("list.title")
 *   const errorText = useErrorText();   // errorText("trade_in_refused") → this area's sentence, else the "errors" one
 */
import { useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";

/** Codes whose sentence lives in this area's namespace (app/i18n/messages/used.ts, `errors.*`). */
const OWN_ERROR_KEYS = new Set([
  "trade_in_device_unavailable",
  "trade_in_refused",
  "trade_in_answers_incomplete",
  "idempotency_conflict",
  "trade_in_photo_limit",
  "trade_in_offer_closed",
  "payout_requires_account",
  "inspection_day_invalid",
  "ownership_required",
  "payout_required",
]);

/** True for a code whose sentence is in this area's namespace (not in "errors"). */
export function isOwnErrorKey(code: string): boolean {
  return OWN_ERROR_KEYS.has(code);
}

/**
 * One `t` for `actionError(error, t)` on the server: `errors.<code>` from this area's namespace for its own codes,
 * from "errors" for everything else. Pass the two namespaces' server `t`s (serverT(locale, "used"), …"errors").
 */
export function combinedErrorT(used: TFunction, errors: TFunction): TFunction {
  return (key, vars) => (key.startsWith("errors.") && OWN_ERROR_KEYS.has(key.slice("errors.".length)) ? used(key, vars) : errors(key, vars));
}

export function useUsedT(): TFunction {
  return useT("used");
}

/** The sentence for a service error code or field key: this area's own codes first, then the shared "errors" ones. */
export function useErrorText(): (code: string | null | undefined) => string {
  const used = useT("used");
  const errors = useT("errors");
  return (code) => {
    if (!code) return errors("errors.unexpected");
    if (OWN_ERROR_KEYS.has(code)) return used(`errors.${code}`);
    const key = `errors.${code}`;
    const text = errors(key);
    return text === key ? errors("errors.unexpected") : text;
  };
}
