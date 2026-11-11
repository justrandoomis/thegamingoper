/**
 * /api/upload/tradein — the photos of a trade-in request that is being filled in (the wizard's photo step,
 * app/routes/storefront/used/trade-in.tsx). Owner: used area.
 *
 *   POST multipart  intent=add  file=<image>      → 200 { ok: true, photo: { id, name, previewUrl }, count, limit }
 *   POST form       intent=remove  fileId=fil_…   → 200 { ok: true, removed, count, limit }
 *   GET  ?file=fil_…                              → the photo itself — private, never cached, only for its own draft
 *   GET                                           → 200 { ok: true, photos: [{ id, name, previewUrl }], count, limit }
 *
 * The draft is the httpOnly cookie `tt_tradein` (created by the first upload, 2 days, SameSite=Lax). Photos are stored
 * privately by ~/server/services/tradein.server (type decided by the bytes: JPEG, PNG or WebP up to 8 MB, metadata
 * removed — ~/server/uploads.server), kind "trade_in_photo", and move to the request when it is submitted. Nobody but
 * the draft's own browser can read one here; after submission only staff can (admin). No malware scanning exists on
 * Workers (docs/STATUS.md open item 5).
 *
 * Failures: { ok: false, code } — upload_missing (400), upload_too_large (413), upload_type (415), upload_corrupt /
 * upload_dimensions (422), trade_in_photo_limit (409), rate_limited (429 + Retry-After), method_not_allowed (405).
 * POSTs must be same-origin (CSRF check in the root middleware) and are rate-limited per IP (RATE_LIMITS.upload).
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";
import type { Route } from "./+types/upload-tradein";
import { getCustomer } from "~/server/auth/customer.server";
import { readFormData } from "~/server/body.server";
import { getCtx, serializeCookie, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, AppError, isAppError } from "~/server/errors";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { fileResponse, kvBlobStore } from "~/server/storage.server";
import { MAX_IMAGE_BYTES } from "~/server/uploads.server";
import {
  TRADE_IN_DRAFT_COOKIE,
  TRADE_IN_DRAFT_MAX_AGE_SEC,
  TRADE_IN_PHOTO_LIMIT,
  addTradeInDraftPhoto,
  isDraftToken,
  listTradeInDraftPhotos,
  newDraftToken,
  readTradeInDraftPhoto,
  removeTradeInDraftPhoto,
  tradeInActor,
} from "~/server/services/tradein.server";

/** Where the wizard shows a draft photo from (this route, GET ?file=). The wizard's loader builds the same URL. */
const previewUrl = (fileId: string) => `/api/upload/tradein?file=${encodeURIComponent(fileId)}`;

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** The image limit plus room for the multipart envelope and the small fields. */
const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

function draftOf(ctx: RequestCtx): string | null {
  const value = ctx.cookie(TRADE_IN_DRAFT_COOKIE);
  return isDraftToken(value) ? value : null;
}

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const draft = draftOf(ctx);
  const file = new URL(request.url).searchParams.get("file");
  if (file !== null) {
    const stored = await readTradeInDraftPhoto(db, kvBlobStore(env.KV), draft, file);
    if (!stored) return notFound();
    return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
  }
  const photos = await listTradeInDraftPhotos(db, draft);
  return data(
    { ok: true as const, photos: photos.map((photo) => ({ id: photo.id, name: photo.name, previewUrl: previewUrl(photo.id) })), count: photos.length, limit: TRADE_IN_PHOTO_LIMIT },
    { headers: NO_STORE },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "GET, POST" } });
  const db = getDb();
  const store = kvBlobStore(env.KV);
  try {
    await enforceRateLimit(db, await limitKey("upload", "ip", ctx.ip), RATE_LIMITS.upload, ctx.now);
    // Counted while it is read (AppError upload_too_large past the limit), also without a Content-Length. A body that
    // is not form data is a 400, never an unexpected error.
    const form = await readFormData(request, MAX_BODY_BYTES).catch((error: unknown) => {
      if (isAppError(error)) throw error;
      throw new AppError("upload_missing", 400, { fields: { file: "upload_missing" } });
    });
    const intent = form.get("intent");

    if (intent === "remove") {
      const draft = draftOf(ctx);
      const removed = await removeTradeInDraftPhoto(db, store, draft, form.get("fileId"), ctx.now);
      const count = (await listTradeInDraftPhotos(db, draft)).length;
      return data({ ok: true as const, removed, count, limit: TRADE_IN_PHOTO_LIMIT }, { headers: NO_STORE });
    }
    if (intent !== "add" && intent !== null) return data({ ok: false as const, code: "invalid" }, { status: 400, headers: NO_STORE });

    let draft = draftOf(ctx);
    if (!draft) draft = newDraftToken();
    // (Re)set the cookie with every upload so the draft lives two days from the last photo.
    ctx.setCookie(serializeCookie(ctx, TRADE_IN_DRAFT_COOKIE, draft, { maxAge: TRADE_IN_DRAFT_MAX_AGE_SEC, httpOnly: true, sameSite: "Lax" }));
    const customer = await getCustomer(ctx, db);
    const photo = await addTradeInDraftPhoto(db, store, draft, form.get("file"), tradeInActor({ customerId: customer?.customer.id ?? null, ip: ctx.ip }), ctx.now);
    return data(
      { ok: true as const, photo: { id: photo.id, name: photo.name, previewUrl: previewUrl(photo.id) }, previewUrl: previewUrl(photo.id), count: photo.count, limit: TRADE_IN_PHOTO_LIMIT },
      { headers: NO_STORE },
    );
  } catch (error) {
    // Expected failures become { ok: false, code }; anything else is a bug and goes to the error handler.
    const { status, retryAfterSec, ...failure } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
