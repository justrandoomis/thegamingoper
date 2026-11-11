/**
 * npm run db:reset — rebuild the LOCAL development database from nothing.
 *
 *   1. drops every table, trigger and view in the local D1 the dev server uses
 *   2. re-applies all migrations in ./drizzle (recorded in d1_migrations, so wrangler agrees)
 *   3. runs seedReference() — governorates, settings defaults, chart of accounts, …
 *   4. runs the demo seed (app/server/db/seed/demo.ts) when that file exists
 *
 *   npm run db:reset                 everything above
 *   npm run db:reset -- --no-demo    skip step 4 (reference data only)
 *   npm run db:reset -- --kv         also delete every key in the local KV namespace (uploaded files)
 *   npm run db:reset -- --demo-seed=path/to/module.ts   run another seed module in step 4
 *
 * The demo seed module exports `seedDemo(db, now, { d1, kv, env })` (also accepted: `seedDemoData`,
 * `seed`, or a default export). It runs AFTER seedReference, against the real constraints and
 * triggers; if it throws, the script reports the database rule that refused it and exits with 1.
 *
 * Local only: it talks to wrangler's local state in .wrangler/state/v3 and has no way to reach a
 * remote database. No file is deleted, so a running dev server keeps working — it just sees the
 * new contents (anyone signed in locally is signed out, because sessions are rows too).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createDb, type Db } from "~/server/db/drizzle.server";
import { seedReference } from "~/server/db/seed/reference";
import { mapDbError } from "~/server/db/tx.server";
import { PROJECT_ROOT, applyMigrations, dropEverything } from "../tests/helpers/migrations";

const USAGE = "Usage: npm run db:reset [-- --no-demo] [-- --kv] [-- --demo-seed=<module>]";
const argv = process.argv.slice(2);
const args = new Set(argv.filter((arg) => !arg.startsWith("--demo-seed=")));
if (args.has("--help") || args.has("-h")) {
  console.log(USAGE);
  process.exit(0);
}
for (const arg of args) {
  if (!["--no-demo", "--kv"].includes(arg)) {
    console.error(`Unknown option ${arg}. ${USAGE}`);
    process.exit(2);
  }
}

/** The demo seed module; `--demo-seed=<path>` substitutes another one (for trying a seed out). */
const demoSeedOverride = argv.find((arg) => arg.startsWith("--demo-seed="))?.slice("--demo-seed=".length);
const DEMO_SEED = demoSeedOverride ? path.resolve(demoSeedOverride) : path.join(PROJECT_ROOT, "app", "server", "db", "seed", "demo.ts");
const DEMO_SEED_LABEL = path.relative(PROJECT_ROOT, DEMO_SEED).replaceAll("\\", "/");

type DemoSeed = (db: Db, now: number, context: { d1: D1Database; kv: KVNamespace; env: Env }) => unknown;

/** The demo seed is written by its own owner; accept the obvious export names. */
function findDemoSeed(module: Record<string, unknown>): DemoSeed | null {
  for (const name of ["seedDemo", "seedDemoData", "seed", "default"]) {
    if (typeof module[name] === "function") return module[name] as DemoSeed;
  }
  return null;
}

async function clearKv(kv: KVNamespace): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    deleted += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return deleted;
}

async function main(): Promise<number> {
  const started = Date.now();
  const proxy = await getPlatformProxy<Env>({
    configPath: path.join(PROJECT_ROOT, "wrangler.jsonc"),
    // The same local state `npm run dev` and `wrangler d1 … --local` use.
    persist: { path: path.join(PROJECT_ROOT, ".wrangler", "state", "v3") },
    remoteBindings: false,
  });

  let exitCode = 0;
  try {
    const d1 = proxy.env.DB;
    const dropped = await dropEverything(d1);
    console.log(`Dropped ${dropped.tables} tables, ${dropped.triggers} triggers, ${dropped.views} views.`);

    await applyMigrations(d1, { log: (message) => console.log(`Migrations: ${message}`) });

    const db = createDb(d1);
    const now = Date.now();
    const reference = await seedReference(db, now);
    console.log(
      `Reference data: ${reference.governorates} governorates, ${reference.districts} districts, ${reference.settings} settings, ` +
        `${reference.accounts} accounts, ${reference.inspectionTemplates} inspection templates, ${reference.locations} stock location, ${reference.channels} channels.`,
    );

    if (args.has("--kv")) console.log(`Local KV: deleted ${await clearKv(proxy.env.KV)} keys.`);

    if (args.has("--no-demo")) {
      console.log("Demo data: skipped (--no-demo).");
    } else if (!existsSync(DEMO_SEED)) {
      console.log(`Demo data: ${DEMO_SEED_LABEL} does not exist yet — the database has reference data only.`);
    } else {
      const module = (await import(pathToFileURL(DEMO_SEED).href)) as Record<string, unknown>;
      const seedDemo = findDemoSeed(module);
      if (!seedDemo) {
        console.error(`Demo data: ${DEMO_SEED_LABEL} exports no seed function (found: ${Object.keys(module).join(", ") || "nothing"}). Expected seedDemo(db, now).`);
        exitCode = 1;
      } else {
        try {
          const result = await seedDemo(db, now, { d1, kv: proxy.env.KV, env: proxy.env });
          console.log(`Demo data: seeded${result === undefined ? "" : ` ${JSON.stringify(result)}`}.`);
        } catch (error) {
          const rule = mapDbError(error);
          console.error("Demo data: the demo seed FAILED — the database has migrations and reference data, but no (or partial) demo data.");
          if (rule) console.error(`  database rule: ${rule.code}${rule.detail ? ` (${rule.detail})` : ""} — ${rule.message}`);
          console.error(error);
          exitCode = 1;
        }
      }
    }

    // Application tables only: no SQLite / D1 internals, no FTS shadow tables, no migration bookkeeping.
    const tables = await d1
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'search\\_index\\_%' ESCAPE '\\' AND name <> 'd1_migrations'",
      )
      .first<{ n: number }>();
    const triggers = await d1.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").first<{ n: number }>();
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s — ${tables?.n ?? "?"} tables and ${triggers?.n ?? "?"} triggers in the local database.`);
  } finally {
    await proxy.dispose();
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("db:reset failed:");
    console.error(error);
    process.exitCode = 1;
  },
);
