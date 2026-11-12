/**
 * Server helpers shared by the /support route modules (thin: who is asking, the private blob store, form fields, the
 * failure shape). Services stay free of "cloudflare:workers"; this file is where the binding is read.
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";
import { randomToken } from "~/lib/ids";
import { formatIraqPhone } from "~/lib/phone";
import { getCustomer } from "~/server/auth/customer.server";
import { MAX_PHOTO_FORM_BODY_BYTES, readFormData } from "~/server/body.server";
import type { RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db.server";
import { actionError, AppError, isAppError } from "~/server/errors";
import type { SupportWho } from "~/server/services/support/common.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import type { UploadSource } from "~/server/uploads.server";

/** The person behind the request, and what may prefill their contact fields (never sent for guests). */
export async function supportWho(ctx: RequestCtx, db: Db): Promise<{ who: SupportWho; contact: { name: string; phone: string } | null }> {
  const session = await getCustomer(ctx, db);
  return {
    who: { customerId: session?.customer.id ?? null, ip: ctx.ip, requestId: ctx.requestId, storeMode: ctx.storeMode },
    contact: session ? { name: session.customer.name ?? "", phone: formatIraqPhone(session.customer.phoneE164) } : null,
  };
}

/**
 * Headers of a page whose address carries a private token and that holds no form (a hand-off receipt, a repair's status
 * card): never cached, and the address is sent nowhere — not even as the referrer of the page's own files.
 */
export const PRIVATE_PAGE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } as const;

/**
 * Headers of a page that shows the repair lookup FORM: never cached, the address kept from other sites. Not
 * `no-referrer`: under it a browser posts the form with `Origin: null`, which the store (and React Router's own guard)
 * refuses as cross-site — the lookup failed without script (400).
 */
export const LOOKUP_PAGE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "same-origin" } as const;

/** The repair status page: the found request's card (a private link, no form) or the lookup form. */
export function repairStatusHeaders(showsRequest: boolean) {
  return showsRequest ? PRIVATE_PAGE_HEADERS : LOOKUP_PAGE_HEADERS;
}

/**
 * The ticket page (/support/ticket): the card behind the private link sends its address nowhere — unless the card holds
 * the rating form (staff solved the request, the shopper has not answered): under `no-referrer` a browser posts that
 * form with `Origin: null` and the store refuses it, so the rating failed without script (review 2026-11-12). That
 * card, like the lookup form (no card), keeps its address to the store's own origin.
 */
export function ticketPageHeaders(card: { canRate: boolean } | null) {
  return card && !card.canRate ? PRIVATE_PAGE_HEADERS : LOOKUP_PAGE_HEADERS;
}

/** Private uploads (repair and support photos) live in the KV-backed blob store. */
export function photoStore(): BlobStore {
  return kvBlobStore(env.KV);
}

/** A fresh idempotency key for one view of a form (the loader writes it into a hidden field). */
export function formKey(): string {
  return randomToken();
}

/** The named text fields of a submitted form (files and other names are left out). */
export function textFields<const N extends string>(form: FormData, names: readonly N[]): Record<N, string> {
  const out = {} as Record<N, string>;
  for (const name of names) {
    const value = form.get(name);
    out[name] = typeof value === "string" ? value : "";
  }
  return out;
}

/** The uploaded files of a field. */
export function formFiles(form: FormData, name: string): UploadSource[] {
  return form.getAll(name).filter((value): value is File => typeof value !== "string");
}

/**
 * The response of a failed action: the error CODE (the page words it — this area's sentence first, then the
 * "errors" namespace), field codes, and the values typed (so a page sent without JavaScript keeps them).
 * Unexpected errors are rethrown to the error boundary.
 */
export function failed(error: unknown, values: Record<string, string>) {
  const failure = actionError(error);
  return data({ ...failure, values }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The form of a repair request or a hand-off to staff (fields and up to MAX_SUPPORT_PHOTOS photos), read with a running
 * count: a body past MAX_PHOTO_FORM_BODY_BYTES — declared or not — is cut off with `upload_too_large` (413) instead of
 * being read to its end, and a body that is not form data is `invalid` (400), never an unexpected error (security
 * review 2026-11). Returns the failure answer in place of the form.
 */
export async function readSupportForm(request: Request): Promise<FormData | ReturnType<typeof failed>> {
  try {
    return await readFormData(request, MAX_PHOTO_FORM_BODY_BYTES);
  } catch (error) {
    return failed(isAppError(error) ? error : new AppError("invalid", 400), {});
  }
}
