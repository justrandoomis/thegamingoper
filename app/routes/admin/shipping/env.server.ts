/**
 * The private blob store (KV) for the shipping module's files — packing photos, proofs of delivery and carriers'
 * statements (upload and read). Read from "cloudflare:workers" in this server-only module so route modules never
 * import it.
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function shippingBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
