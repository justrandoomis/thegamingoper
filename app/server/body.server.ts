/**
 * Request bodies — how much a request may send, checked BEFORE the body is read (security review 2026-11).
 *
 *   // root middleware (context.server.ts): a declared Content-Length above the path's limit → 413 before any action runs
 *   if (declaredTooLarge(request, url)) throw data({ error: "payload_too_large" }, { status: 413 });
 *
 *   // an upload endpoint: the body read with a running count, cut off at the limit (also when the client sent no
 *   // Content-Length — a chunked body would otherwise be read to its end, up to the platform's 100 MB, before any check)
 *   const form = await readFormData(request, MAX_UPLOAD_BODY_BYTES);      // throws AppError("upload_too_large", 413)
 *
 * The limits follow what the storefront really sends: a page form is a handful of fields; an upload is one image of at
 * most MAX_IMAGE_BYTES plus its multipart framing; the repair and "talk to staff" forms carry up to MAX_SUPPORT_PHOTOS
 * images. The admin keeps a generous ceiling (its own endpoints check their files: images 8 MB, CSV 1 MB).
 *
 * Must not import "cloudflare:workers".
 */
import { splitLocale } from "~/lib/locales";
import { AppError } from "./errors";
import { pagePathname } from "./security.server";
import { MAX_SUPPORT_PHOTOS } from "./services/support/types";
import { MAX_IMAGE_BYTES } from "./uploads.server";

const KB = 1024;
/** Multipart framing and the small text fields that travel with a file. */
const FRAMING_BYTES = 64 * KB;

/** One image and its fields: /api/upload/proof, /api/upload/tradein, /account/wallet/proof. */
export const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + FRAMING_BYTES;
/** The repair request and the assistant's hand-off: up to MAX_SUPPORT_PHOTOS images and the form. */
export const MAX_PHOTO_FORM_BODY_BYTES = MAX_SUPPORT_PHOTOS * MAX_IMAGE_BYTES + FRAMING_BYTES;
/** Every other storefront write (sign-in, checkout, cart, favourites, signals…): fields only. */
export const MAX_FORM_BODY_BYTES = 256 * KB;
/** The admin: its endpoints check their own files; this only stops absurd declared sizes. */
export const MAX_ADMIN_BODY_BYTES = 32 * 1024 * KB;

const UPLOAD_PATHS = /^\/(?:api\/upload\/[a-z-]+|account\/wallet\/proof)\/?$/;
const PHOTO_FORM_PATHS = /^\/support\/(?:repair|assistant)\/?$/;

/** The most a request to this URL may send (by the page path: "/en/support/repair.data" is "/support/repair"). */
export function bodyLimitFor(url: URL): number {
  const page = pagePathname(url.pathname);
  if (page === "/admin" || page.startsWith("/admin/")) return MAX_ADMIN_BODY_BYTES;
  const path = splitLocale(page).path;
  if (UPLOAD_PATHS.test(path)) return MAX_UPLOAD_BODY_BYTES;
  if (PHOTO_FORM_PATHS.test(path)) return MAX_PHOTO_FORM_BODY_BYTES;
  return MAX_FORM_BODY_BYTES;
}

/** The Content-Length the client declared, or null (none, or not a number). */
export function declaredLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** True when the request says it sends more than its path allows. */
export function declaredTooLarge(request: Request, url: URL): boolean {
  const declared = declaredLength(request);
  return declared !== null && declared > bodyLimitFor(url);
}

const tooLarge = (maxBytes: number) => new AppError("upload_too_large", 413, { fields: { file: "upload_too_large" }, detail: `> ${maxBytes} bytes` });

/**
 * The body as bytes, read with a running count: past `maxBytes` the stream is cancelled and AppError("upload_too_large",
 * 413) is thrown — whether or not a Content-Length was declared, and whatever it said.
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * request.formData(), but never reading more than `maxBytes`: AppError("upload_too_large", 413) past it. A body that
 * is not form data throws the platform's own TypeError, as request.formData() does.
 */
export async function readFormData(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBodyBytes(request, maxBytes);
  const type = request.headers.get("Content-Type") ?? "";
  return new Response(bytes, { headers: { "Content-Type": type } }).formData();
}
