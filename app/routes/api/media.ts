/**
 * GET /media/:key — PUBLIC uploaded files only (product photos, photos of listed used devices).
 *
 * A key is served when it is a well-formed public key (`pub_…`) AND the metadata stored with the
 * bytes says "public". Private files (payment proofs, unlisted device photos, documents) have
 * `prv_…` keys and are never served here, whoever asks: they go through routes that authorize the
 * actor first and answer with fileResponse() from ~/server/storage.server.
 *
 * Responses are immutable (a file never changes under its key) and cacheable for a year, carry the
 * type detected at upload with `nosniff`, and a sandboxing Content-Security-Policy.
 * No database query: the store's metadata is enough.
 */
import { env } from "cloudflare:workers";
import type { Route } from "./+types/media";
import { fileResponse, getPublicBlob, kvBlobStore } from "~/server/storage.server";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" },
  });

export async function loader({ params, request }: Route.LoaderArgs) {
  const blob = await getPublicBlob(kvBlobStore(env.KV), params.key);
  if (!blob) return notFound();
  return fileResponse({ mime: blob.meta.mime, sha256: blob.meta.sha256, visibility: "public" }, blob.bytes, request);
}
