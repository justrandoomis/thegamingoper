/**
 * A real, throw-away D1 database for tests.
 *
 *   import { afterAll, beforeAll, expect, test } from "vitest";
 *   import { createTestDb, type TestDb } from "./helpers/db";
 *   import { fixtures } from "./helpers/factories";
 *
 *   let t: TestDb;
 *   beforeAll(async () => { t = await createTestDb(); });
 *   afterAll(async () => { await t.dispose(); });
 *
 *   test("…", async () => {
 *     const make = fixtures(t.db);
 *     const { variantId } = await make.product({ stock: 3 });
 *     await placeOrder(t.db, ctx, input);          // services take `db` first
 *   });
 *
 * What you get: wrangler's local D1 and KV (the same workerd runtime as `npm run dev`, so SQL
 * semantics, triggers, FTS5 and batch transactions are the real thing) with NON-persistent state —
 * nothing is read from or written to .wrangler/, so the dev database is never touched. All
 * migrations in ./drizzle are applied and seedReference() has run (governorates, districts,
 * settings defaults, the main stock location, chart of accounts, inspection templates).
 *
 * Each call starts its own runtime (a few seconds). Create one per test file in beforeAll and use
 * unique ids per test. Databases that a test forgets to dispose are closed after the file
 * (tests/helpers/setup.ts).
 */
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { createDb, type Db } from "~/server/db/drizzle.server";
import { seedReference } from "~/server/db/seed/reference";
import { setTestEnv } from "./cloudflare-workers";
import { PROJECT_ROOT, applyMigrations } from "./migrations";

export type TestDb = {
  /** Drizzle client — pass it to services. */
  db: Db;
  /** The raw D1 binding, for SQL-level assertions. */
  d1: D1Database;
  /** The private KV namespace used by the storage service. */
  kv: KVNamespace;
  /** All local bindings and vars (DB, KV, APP_ENV, STORE_MODE, secrets from .dev.vars…). */
  env: Env;
  /** The timestamp passed to seedReference — a fixed "now" tests can reuse. */
  now: number;
  /** Stops the local runtime. Call it in afterAll. */
  dispose(): Promise<void>;
};

export type CreateTestDbOptions = {
  /** Run seedReference after migrating (default true). */
  seed?: boolean;
  /** Timestamp for seeded rows (default TEST_NOW). */
  now?: number;
};

/** 10 November 2026, 09:00 in Baghdad. */
export const TEST_NOW = Date.UTC(2026, 10, 10, 6, 0, 0);

type Registry = Set<() => Promise<void>>;
const globals = globalThis as typeof globalThis & { __tamtamTestDbs?: Registry };
/** Open test databases of this test file; tests/helpers/setup.ts closes what is left over. */
const open: Registry = (globals.__tamtamTestDbs ??= new Set());

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const now = options.now ?? TEST_NOW;
  const proxy = await getPlatformProxy<Env>({
    configPath: path.join(PROJECT_ROOT, "wrangler.jsonc"),
    // In-memory state: never the developer's .wrangler/state, never a remote resource.
    persist: false,
    remoteBindings: false,
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    open.delete(dispose);
    await proxy.dispose();
  };
  open.add(dispose);
  try {
    const d1 = proxy.env.DB;
    await applyMigrations(d1);
    const db = createDb(d1);
    if (options.seed !== false) await seedReference(db, now);
    setTestEnv(proxy.env as unknown as Record<string, unknown>);
    return { db, d1, kv: proxy.env.KV, env: proxy.env, now, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
