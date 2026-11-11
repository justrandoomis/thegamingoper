import type { Route } from "./+types/privacy-export";
import { isAppError, throwAsResponse } from "~/server/errors";
import { buildPrivacyExport } from "~/server/services/admin/customers/privacy.server";
import { notFoundResponse, openCustomers } from "./customers.server";

/**
 * GET /admin/customers/privacy/:ref/export — the customer's own data as a JSON file for a VERIFIED export request
 * (07.04). Built at the moment of download — never stored — and every download is an audit event with the file's
 * SHA-256 and size. Needs customers.privacy.manage; an unknown, unverified or other-kind request is the same 404.
 * Sent as an attachment, `no-store`, nosniff, sandboxed.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.privacy.manage");
  try {
    const file = await buildPrivacyExport(db, actor, params.ref, now);
    return new Response(file.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${file.sha256}"`,
      },
    });
  } catch (error) {
    if (isAppError(error) && error.status !== 403) return notFoundResponse();
    throwAsResponse(error);
  }
}
