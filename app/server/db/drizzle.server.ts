/**
 * Builds the Drizzle client from a D1 binding. Runtime-neutral on purpose: no "cloudflare:workers"
 * import here, so tests and scripts can hand in a local D1 (`createDb(proxy.env.DB)`).
 * Application code gets its client from getDb() in ~/server/db.server.
 */
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * The Drizzle client every service receives as its first argument. Same type in the Worker and in
 * tests. `$client` is the underlying D1 binding.
 */
export type Db = DrizzleD1Database<typeof schema> & { $client: D1Database };

/** One statement of a `db.batch([...])` — what the helpers in tx.server, journal.server and search.server return. */
export type BatchStatement = BatchItem<"sqlite">;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

export { schema };
