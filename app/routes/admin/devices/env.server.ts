/**
 * What module 13 needs from the Worker: the private blob store (KV) for trade-in and used-unit photos, and DATA_KEY,
 * which encrypts digital codes. Read from "cloudflare:workers" in this server-only module so route modules never
 * import it; the services take both as parameters (tests pass their own).
 */
import { env } from "cloudflare:workers";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export function devicesBlobStore(): BlobStore {
  return kvBlobStore(env.KV);
}

export function devicesDataKey(): string | undefined {
  return env.DATA_KEY;
}

export function devicesStoreMode(): "demo" | "live" {
  return env.STORE_MODE === "live" ? "live" : "demo";
}
