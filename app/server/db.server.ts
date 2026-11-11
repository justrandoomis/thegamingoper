/**
 * Database access for the Worker.
 *
 *   const db = getDb();                                  // in loaders / actions
 *   await placeOrder(db, ctx, input);                    // services take `db` as their first argument
 *
 * This is the ONLY database file that imports "cloudflare:workers". Services, the schema and the
 * helpers under ~/server/db never do, so tests can run them against a local D1
 * (`createTestDb()` in tests/helpers/db.ts).
 *
 * Related modules:
 *   ~/server/db/schema            tables, enums, row types and relations
 *   ~/server/db/tx.server         atomic batches: expectChanged / expectThat / runBatch, and mapDbError
 *   ~/server/db/journal.server    how to post a balanced journal entry
 *   ~/server/db/search.server     product full-text search (FTS5)
 *   ~/server/db/seed/reference    reference data every environment needs (seedReference)
 */
import { env } from "cloudflare:workers";
import { createDb, type Db } from "./db/drizzle.server";

export type { BatchStatement, Db } from "./db/drizzle.server";

let cached: { d1: D1Database; db: Db } | undefined;

/**
 * The Drizzle client bound to the `DB` D1 database (= drizzle(env.DB, { schema })).
 * Building the client walks the whole schema (about 15 ms), and it holds no request state, so one
 * instance per isolate is reused across requests.
 */
export function getDb(): Db {
  const d1 = env.DB;
  if (!cached || cached.d1 !== d1) cached = { d1, db: createDb(d1) };
  return cached.db;
}
