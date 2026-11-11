/**
 * The private blob store (KV) for the orders module's files — payment-proof images (read) and proof-of-delivery photos
 * (upload and read). Read from "cloudflare:workers" in this server-only module so route modules never import it.
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function ordersBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
