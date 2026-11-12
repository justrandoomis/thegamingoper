/**
 * Client-safe helpers of the /support pages: keeping a form on the page when the request fails, wording field errors,
 * and the instant phone check (DESIGN.md §9.9: specific, checked on blur, re-checked while an error shows).
 */
import { isRouteErrorResponse } from "react-router";
import type { TFunction } from "~/i18n/translate";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";

export type FormFailure = { ok: false; code: string; status: number; fields?: Record<string, string>; values?: Record<string, string>; retryAfterSec?: number };

/**
 * For a route's `clientAction`: a request that never reached the store (offline, dropped connection) or failed on the
 * server becomes a value the page can explain beside the form — instead of React Router's error boundary replacing
 * the page and everything typed in it. Redirects pass through unchanged.
 */
export async function keepFormOnFailure<T>(serverAction: () => Promise<T>): Promise<T | FormFailure> {
  try {
    return await serverAction();
  } catch (error) {
    if (error instanceof Response) throw error;
    if (isRouteErrorResponse(error)) {
      const code = error.status === 429 ? "rate_limited" : error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : "unexpected";
      return { ok: false, code, status: error.status };
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, code: "offline", status: 0 };
    return { ok: false, code: error instanceof TypeError ? "network" : "unexpected", status: 0 };
  }
}

export function isFailure(value: unknown): value is FormFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false && typeof (value as { code?: unknown }).code === "string";
}

/**
 * The named text fields of the form a `clientAction` is about to send — read from a copy of the request, before the
 * server action reads the request itself. Pages whose one route holds several forms (`intent`) need them to tell which
 * form a failure that never reached the store belongs to.
 */
export async function sentValues(request: Request, names: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const form = await request.clone().formData();
    for (const name of names) {
      const value = form.get(name);
      if (typeof value === "string") out[name] = value;
    }
  } catch {
    // not a form: nothing to keep
  }
  return out;
}

/** A failure that never reached the store (keepFormOnFailure) carries no values: it gets the ones the form sent. */
export function withSentValues<T>(result: T | FormFailure, values: Record<string, string>): T | FormFailure {
  return isFailure(result) && !result.values ? { ...result, values } : result;
}

/**
 * What the ticket page (/support/ticket) shows — one request card or the lookup form — and which of them says a
 * failure. `posted`: the card the last post answered with; `kept`: the last card a post answered with on this page
 * (the one a rating was sent from after a lookup by number + phone); `fromLink`: the private link's card.
 *
 * A rating that failed — the store refused it, or it never reached the store — keeps the card it was sent from, with
 * the failure in its rating part (the form and the words typed stay; review 2026-11-12: the card used to turn into the
 * lookup form). With no card left to show (a page sent without script after a lookup), the failure is said beside
 * the lookup form. Any other failure is the lookup's. Pure.
 */
export function ticketView<C>(input: { posted: C | null; kept: C | null; fromLink: C | null; failure: FormFailure | null }): { card: C | null; ratingFailure: FormFailure | null; lookupFailure: FormFailure | null } {
  const { posted, kept, fromLink, failure } = input;
  if (posted) return { card: posted, ratingFailure: null, lookupFailure: null };
  if (!failure) return { card: fromLink, ratingFailure: null, lookupFailure: null };
  if (failure.values?.intent === "rate") {
    const card = kept ?? fromLink;
    return card ? { card, ratingFailure: failure, lookupFailure: null } : { card: null, ratingFailure: null, lookupFailure: failure };
  }
  return { card: null, ratingFailure: null, lookupFailure: failure };
}

/**
 * For a route's `shouldRevalidate` after a submission: a request that never reached the store (offline, a dropped
 * connection — the failure `keepFormOnFailure` kept) reloads nothing, because the reload would fail the same way and
 * an error panel would replace the form and everything typed in it. Anything else follows React Router's default.
 */
export function revalidateAfter({ actionResult, defaultShouldRevalidate }: { actionResult?: unknown; defaultShouldRevalidate: boolean }): boolean {
  if (isFailure(actionResult) && (actionResult.code === "network" || actionResult.code === "offline")) return false;
  return defaultShouldRevalidate;
}

/**
 * A step flow's «رجوع» (the repair request): "history" when the step on screen was reached from the previous one —
 * the history state its push left, `{ from: <step> }` — so the key is the browser's own Back and Back / Forward keep
 * walking the steps in order; "push" otherwise (a step opened from a link or after a server error).
 */
export function stepBack(previous: string, historyState: unknown): "history" | "push" {
  const from = typeof historyState === "object" && historyState !== null ? (historyState as { from?: unknown }).from : undefined;
  return from === previous ? "history" : "push";
}

/** This area's sentence for a field's code, else the "errors" namespace's, else nothing. */
export function fieldMessage(field: string, code: string | undefined, t: TFunction, errors: TFunction): string | undefined {
  if (!code) return undefined;
  const own = `fieldErrors.${field}.${code}`;
  const mine = t(own);
  if (mine !== own) return mine;
  const shared = `errors.${code}`;
  const text = errors(shared);
  return text === shared ? errors("errors.invalid") : text;
}

/** The sentence for a whole-form failure (network, rate limit, conflict…). */
export function formMessage(failure: FormFailure, t: TFunction, errors: TFunction): string {
  if (failure.code === "network") return t("form.network");
  if (failure.code === "offline") return t("form.offline");
  if (failure.code === "invalid") return t("form.check");
  const key = `errors.${failure.code}`;
  const text = errors(key);
  return text === key ? errors("errors.unexpected") : text;
}

/**
 * What is wrong with a typed Iraqi mobile number, in words: "4 digits short", "too long", or the general rule.
 * Empty → `required` (only when the field is required).
 */
export function phoneProblem(value: string, t: TFunction, errors: TFunction, required = true): string | undefined {
  const text = value.trim();
  if (!text) return required ? t("fieldErrors.phone.required") : undefined;
  if (normalizeIraqPhone(text)) return undefined;
  const digits = toLatinDigits(text).replace(/\D/g, "").replace(/^00964|^964/, "0");
  const local = digits.startsWith("7") ? `0${digits}` : digits;
  if (/^07[3-9]\d*$/.test(local) || /^07?$/.test(local)) {
    if (local.length < 11) return t("phone.short", { count: 11 - local.length });
    if (local.length > 11) return t("phone.long");
  }
  return errors("errors.phone_invalid");
}
