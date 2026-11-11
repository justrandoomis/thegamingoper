/**
 * The private blob store (KV) for the finance module's files — wallet top-up proofs (read) and expense receipts
 * (upload and read). Read from "cloudflare:workers" in this server-only module so route modules never import it.
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function financeBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
