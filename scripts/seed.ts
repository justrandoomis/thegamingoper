/**
 * npm run db:seed — load reference data, roles and the DEMO catalogue.
 *
 *   npm run db:seed                       into the LOCAL development database (the one `npm run dev` uses)
 *   npm run db:seed -- --overwrite        also restore the seed's names, texts, pictures and rules on existing rows
 *   npm run db:seed -- --sql seed.sql     write the same statements to a plain SQL file instead — the
 *                                         development database is not touched — for
 *                                         npx wrangler d1 execute DB --remote --file seed.sql
 *
 * Steps, in this order (each is idempotent, so the command is safe to repeat):
 *   1. seedReference()   governorates, districts, settings defaults, stock location, chart of accounts, …
 *   2. the roles seed    app/server/auth/seed-roles.ts, when that file exists (skipped otherwise)
 *   3. seedDemo()        the DEMO catalogue — see app/server/db/seed/demo.ts
 *
 * It does not migrate: run `npm run db:migrate` (or `npm run db:reset`) first. It creates no
 * accounts, customers or orders.
 *
 * --sql: the three steps run against a throw-away in-memory database with the real migrations
 * applied, and every data-changing statement that succeeded there is written to the file with its
 * values inlined. Before the file is written, the statements are replayed on a second empty
 * database and the row counts of every table are compared — a file that would not reproduce the
 * seed is never produced. Local only: this script has no way to reach a remote database.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createDb, type Db } from "~/server/db/drizzle.server";
import { seedDemo, type SeedDemoResult } from "~/server/db/seed/demo";
import { recordWrites, statementToSql, toSqlScript, type RecordedStatement } from "~/server/db/seed/demo/sql";
import { seedReference } from "~/server/db/seed/reference";
import { mapDbError } from "~/server/db/tx.server";
import { PROJECT_ROOT, applyMigrations, dropEverything } from "../tests/helpers/migrations";

const USAGE = "Usage: npm run db:seed [-- --overwrite] [-- --sql <file>]";

// ───────────────────────────────────────────────────────────────── arguments

type Args = { overwrite: boolean; sqlFile: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { overwrite: false, sqlFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--sql") {
      const file = argv[++i];
      if (!file || file.startsWith("--")) fail(`--sql needs a file name. ${USAGE}`);
      args.sqlFile = file;
    } else if (arg.startsWith("--sql=")) {
      args.sqlFile = arg.slice("--sql=".length);
      if (!args.sqlFile) fail(`--sql needs a file name. ${USAGE}`);
    } else {
      fail(`Unknown option ${arg}. ${USAGE}`);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ───────────────────────────────────────────────────────────────── the three steps

const ROLES_SEED = path.join(PROJECT_ROOT, "app", "server", "auth", "seed-roles.ts");
const ROLES_SEED_LABEL = path.relative(PROJECT_ROOT, ROLES_SEED).replaceAll("\\", "/");

/**
 * seedRoles(db, now) from the auth owner. Called with two arguments only: its third parameter is
 * its own options object (`{ reset }`), which this script never sets — existing roles keep the
 * permissions the owner gave them.
 */
type RolesSeed = (db: Db, now: number) => unknown;

/** The roles seed belongs to the auth owner; accept the obvious export names. */
function findRolesSeed(module: Record<string, unknown>): RolesSeed | null {
  for (const name of ["seedRoles", "seedRolesAndPermissions", "seedSystemRoles", "seed", "default"]) {
    if (typeof module[name] === "function") return module[name] as RolesSeed;
  }
  return null;
}

const summary = (value: unknown) => (value === undefined ? "" : ` ${JSON.stringify(value)}`);

/** Runs reference → roles → demo. Returns the demo result, or null when a step failed (already reported). */
async function runSeeds(db: Db, now: number, overwrite: boolean): Promise<SeedDemoResult | null> {
  let step = "Reference data";
  try {
    const reference = await seedReference(db, now);
    console.log(
      `Reference data: ${reference.governorates} governorates, ${reference.districts} districts, ${reference.settings} settings, ${reference.accounts} accounts, ` +
        `${reference.inspectionTemplates} inspection templates, ${reference.locations} stock location, ${reference.channels} channels (existing rows are left as they are).`,
    );

    step = "Roles";
    if (!existsSync(ROLES_SEED)) {
      console.log(`Roles: ${ROLES_SEED_LABEL} does not exist yet — skipped.`);
    } else {
      const module = (await import(pathToFileURL(ROLES_SEED).href)) as Record<string, unknown>;
      const seedRoles = findRolesSeed(module);
      if (!seedRoles) {
        console.error(`Roles: ${ROLES_SEED_LABEL} exports no seed function (found: ${Object.keys(module).join(", ") || "nothing"}). Expected seedRoles(db, now).`);
        return null;
      }
      console.log(`Roles: seeded${summary(await seedRoles(db, now))}.`);
    }

    step = "Demo data";
    const demo = await seedDemo(db, now, { overwrite });
    const defined = Object.values(demo.rows).reduce((sum, count) => sum + count, 0);
    const changed = Object.values(demo.changed).reduce((sum, count) => sum + count, 0);
    console.log(`Demo data: ${defined} rows defined in ${Object.keys(demo.rows).length} tables, ${changed} written by this run (${demo.statements} statements, one transaction${overwrite ? ", overwrite" : ""}).`);
    return demo;
  } catch (error) {
    const rule = mapDbError(error);
    console.error(`${step}: FAILED — nothing from this step was written.`);
    if (rule) console.error(`  database rule: ${rule.code}${rule.detail ? ` (${rule.detail})` : ""} — ${rule.message}`);
    console.error(error);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────── row counts

const USER_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'search\\_index\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name";

/** Rows per application table (the FTS shadow tables and migration bookkeeping are left out). */
async function countRows(d1: D1Database, tables?: readonly string[]): Promise<Map<string, number>> {
  const names = tables ?? (await d1.prepare(USER_TABLES).all<{ name: string }>()).results.map((row) => row.name);
  const counts = new Map<string, number>();
  for (let start = 0; start < names.length; start += 50) {
    const part = names.slice(start, start + 50);
    const results = await d1.batch<{ n: number }>(part.map((name) => d1.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)));
    part.forEach((name, index) => counts.set(name, results[index].results[0]?.n ?? 0));
  }
  return counts;
}

function printCounts(title: string, counts: Map<string, number>, changed?: Record<string, number>): void {
  console.log(title);
  const width = Math.max(...[...counts.keys()].map((name) => name.length));
  for (const [name, count] of counts) {
    // "Written": inserted, or with --overwrite also refreshed in place (the row count then stays the same).
    const extra = changed && name in changed ? `   (${changed[name]} written this run)` : "";
    console.log(`  ${name.padEnd(width)}  ${String(count).padStart(5)}${extra}`);
  }
}

// ───────────────────────────────────────────────────────────────── modes

/** Seeds the local development database. */
async function seedLocal(args: Args): Promise<number> {
  const proxy = await getPlatformProxy<Env>({
    configPath: path.join(PROJECT_ROOT, "wrangler.jsonc"),
    // The same local state `npm run dev` and `wrangler d1 … --local` use.
    persist: { path: path.join(PROJECT_ROOT, ".wrangler", "state", "v3") },
    remoteBindings: false,
  });
  try {
    const d1 = proxy.env.DB;
    const migrated = await d1.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'search_index', '_tx_guard')").first<{ n: number }>();
    if ((migrated?.n ?? 0) < 3) {
      console.error("The local database has no schema yet. Run `npm run db:migrate` (or `npm run db:reset`) first.");
      return 1;
    }
    const demo = await runSeeds(createDb(d1), Date.now(), args.overwrite);
    if (!demo) return 1;
    printCounts("Rows in the local database (tables the demo seed writes):", await countRows(d1, Object.keys(demo.rows)), demo.changed);
    return 0;
  } finally {
    await proxy.dispose();
  }
}

/** Writes the seed as a SQL file, using a throw-away in-memory database to produce and to check it. */
async function writeSqlFile(args: Args & { sqlFile: string }): Promise<number> {
  const target = path.resolve(args.sqlFile);
  const proxy = await getPlatformProxy<Env>({
    configPath: path.join(PROJECT_ROOT, "wrangler.jsonc"),
    // In-memory state: never the developer's .wrangler/state, never a remote resource.
    persist: false,
    remoteBindings: false,
  });
  try {
    const d1 = proxy.env.DB;
    await applyMigrations(d1);

    const recorded: RecordedStatement[] = [];
    const now = Date.now();
    const demo = await runSeeds(createDb(recordWrites(d1, recorded)), now, args.overwrite);
    if (!demo) return 1;
    const expected = await countRows(d1);

    // Replay the inlined statements on an empty database and compare every table.
    const statements = recorded.map(statementToSql);
    await dropEverything(d1);
    await applyMigrations(d1);
    for (let start = 0; start < statements.length; start += 50) {
      await d1.batch(statements.slice(start, start + 50).map((statement) => d1.prepare(statement)));
    }
    const replayed = await countRows(d1);
    const differences = [...expected].filter(([name, count]) => replayed.get(name) !== count).map(([name, count]) => `${name}: seeded ${count}, replayed ${replayed.get(name) ?? "missing"}`);
    if (differences.length > 0) {
      console.error("The SQL statements do not reproduce the seed — no file was written:");
      for (const line of differences) console.error(`  ${line}`);
      return 1;
    }

    const relative = path.relative(process.cwd(), target).replaceAll("\\", "/") || target;
    const script = toSqlScript(recorded, [
      "TamTam Games — reference data, roles (when the roles seed exists) and the DEMO catalogue.",
      `Generated ${new Date(now).toISOString()} by: npm run db:seed -- --sql ${relative}${args.overwrite ? " --overwrite" : ""}`,
      `${statements.length} statements. ${args.overwrite ? "Existing rows are refreshed (descriptive content only; never prices, costs or stock)." : 'Each one is "insert if missing": rows that already exist are left as they are.'}`,
      "DEMO data: prices, stock and the USD rate are placeholders, flagged is_demo = 1. No accounts, customers or orders.",
      "Apply AFTER the migrations:",
      "  npx wrangler d1 migrations apply DB --remote",
      `  npx wrangler d1 execute DB --remote --file ${relative}`,
    ]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, script, "utf8");

    const longest = Math.max(...statements.map((statement) => Buffer.byteLength(statement, "utf8")));
    const filled = [...expected].filter(([, count]) => count > 0);
    console.log(`Wrote ${target}`);
    console.log(`  ${statements.length} statements, ${(Buffer.byteLength(script, "utf8") / 1024).toFixed(0)} KB; longest statement ${(longest / 1024).toFixed(1)} KB (D1 accepts up to 100 KB).`);
    console.log(`  Replayed on an empty migrated database: ${filled.length} tables, ${filled.reduce((sum, [, count]) => sum + count, 0)} rows — identical to the direct seed.`);
    console.log(`  The development database was not touched. To load the file: npx wrangler d1 execute DB --remote --file ${relative}`);
    if (longest > 100_000) {
      console.error("  A statement is longer than 100 KB and D1 will refuse it.");
      return 1;
    }
    return 0;
  } finally {
    await proxy.dispose();
  }
}

// ───────────────────────────────────────────────────────────────── main

const args = parseArgs(process.argv.slice(2));
const started = Date.now();

(args.sqlFile ? writeSqlFile({ ...args, sqlFile: args.sqlFile }) : seedLocal(args)).then(
  (code) => {
    console.log(`${code === 0 ? "Done" : "Failed"} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    process.exitCode = code;
  },
  (error) => {
    console.error("db:seed failed:");
    console.error(error);
    process.exitCode = 1;
  },
);
