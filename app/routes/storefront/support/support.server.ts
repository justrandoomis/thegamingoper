/**
 * Server helpers shared by the /support route modules (thin: who is asking, the private blob store, form fields, the
 * failure shape). Services stay free of "cloudflare:workers"; this file is where the binding is read.
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";
import { randomToken } from "~/lib/ids";
import { formatIraqPhone } from "~/lib/phone";
import { getCustomer } from "~/server/auth/customer.server";
import type { RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db.server";
import { actionError } from "~/server/errors";
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
