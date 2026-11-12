/**
 * The private blob store (KV) for the support module's files — the photos customers attached to support tickets,
 * assistant hand-offs and repair requests (read only here). Read from "cloudflare:workers" in this server-only module
 * so route modules never import it.
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function supportBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
