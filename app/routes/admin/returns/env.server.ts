/**
 * The private blob store (KV) for the returns module's files — RMA photos (upload and read) and the photos customers
 * attached to repair requests (read). Read from "cloudflare:workers" in this server-only module so route modules never
 * import it.
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function returnsBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
