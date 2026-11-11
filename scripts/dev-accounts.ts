/**
 * Local demo accounts (ARCHITECTURE.md §11): one demo OWNER for the admin and one demo CUSTOMER for the storefront, in
 * the LOCAL development database only. Idempotent — run it again after every `npm run db:reset`:
 *
 *   npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts              (npm script requested from the lead)
 *   npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts --reset-mfa  (also turn the owner's two-step
 *                                                                                    verification off again)
 *   npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts --credentials-only
 *                                     (only write the credentials file — e.g. to create the owner through /admin/setup)
 *
 * The credentials live ONLY in `.dev.seed-credentials` (git-ignored), as KEY=VALUE lines. The file is created on the
 * first run and reused afterwards, so the same email, phone and passwords survive database resets. Nothing secret is
 * ever printed — not the passwords, not the email or the phone.
 *
 * Refuses to run when APP_ENV is "production" (in the shell or in the local Worker vars) or when any other argument is
 * passed (--remote, --env, …): it opens the same local state `npm run dev` uses (.wrangler/state/v3) with remote
 * bindings off, and has no way to reach a remote database. Both accounts are flagged is_demo; the owner gets the owner
 * role (the built-in roles are installed first if they are missing, without touching edited ones).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";
import { newId, randomToken } from "~/lib/ids";
import { normalizeIraqPhone } from "~/lib/phone";
import { existingDefaultRoles, seedRoles } from "~/server/auth/seed-roles";
import { hashPassword, verifyPassword } from "~/server/crypto.server";
import { createDb, type Db } from "~/server/db/drizzle.server";
import { customers, employeeRoles, employees } from "~/server/db/schema";
import { roleId } from "~/server/permissions";
import { PROJECT_ROOT } from "../tests/helpers/migrations";

const CREDENTIALS_FILE = path.join(PROJECT_ROOT, ".dev.seed-credentials");
const USAGE = "Usage: npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts [--reset-mfa] [--credentials-only]";

type Credentials = { ADMIN_EMAIL: string; ADMIN_PASSWORD: string; ADMIN_NAME: string; CUSTOMER_PHONE: string; CUSTOMER_PASSWORD: string; CUSTOMER_NAME: string };

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

/** APP_ENV says production, however it is spelled or padded (" Production " counts). */
export function isProductionEnv(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "production";
}

/**
 * An error message that is safe to print: database errors quote the statement and its parameters (Drizzle: "Failed
 * query: … params: …"), which would put the demo email and password hash on the terminal — everything from "params:"
 * on is dropped, and every known credential value is masked.
 */
export function redactSecrets(message: string, secrets: readonly (string | null | undefined)[]): string {
  let out = message.replace(/params:[\s\S]*$/i, "params: [redacted]");
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out.replace(/pbkdf2-sha256\$[^\s"',]*/g, "[redacted]");
}

function parseArgs(argv: string[]): { resetMfa: boolean; credentialsOnly: boolean } {
  let resetMfa = false;
  let credentialsOnly = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--reset-mfa") resetMfa = true;
    else if (arg === "--credentials-only") credentialsOnly = true;
    else refuse(`Refusing to run: unknown argument "${arg}". This script only ever touches the LOCAL development database.\n${USAGE}`);
  }
  return { resetMfa, credentialsOnly };
}

function readCredentials(): Partial<Credentials> {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(CREDENTIALS_FILE, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out as Partial<Credentials>;
}

function completeCredentials(found: Partial<Credentials>): Credentials {
  return {
    ADMIN_EMAIL: found.ADMIN_EMAIL || "demo.owner@tamtam.local",
    ADMIN_PASSWORD: found.ADMIN_PASSWORD && found.ADMIN_PASSWORD.length >= 12 ? found.ADMIN_PASSWORD : randomToken(18),
    ADMIN_NAME: found.ADMIN_NAME || "مالك تجريبي",
    CUSTOMER_PHONE: found.CUSTOMER_PHONE && normalizeIraqPhone(found.CUSTOMER_PHONE) ? found.CUSTOMER_PHONE : "+9647700000001",
    CUSTOMER_PASSWORD: found.CUSTOMER_PASSWORD && found.CUSTOMER_PASSWORD.length >= 8 ? found.CUSTOMER_PASSWORD : randomToken(12),
    CUSTOMER_NAME: found.CUSTOMER_NAME || "عميل تجريبي",
  };
}

function writeCredentials(credentials: Credentials): void {
  const lines = [
    "# Local demo accounts — written by scripts/dev-accounts.ts. LOCAL DEVELOPMENT ONLY.",
    "# Git-ignored. Never commit, paste or print these values. Re-run the script after `npm run db:reset`.",
    "# Admin: /admin/login with ADMIN_EMAIL + ADMIN_PASSWORD (owner role). Storefront: CUSTOMER_PHONE + CUSTOMER_PASSWORD.",
    ...Object.entries(credentials).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  writeFileSync(CREDENTIALS_FILE, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

/** The demo owner: created, or brought back to the stored password, active, owner role, is_demo. */
async function ensureOwner(db: Db, credentials: Credentials, now: number, resetMfa: boolean): Promise<"created" | "updated" | "unchanged"> {
  const email = credentials.ADMIN_EMAIL.trim().toLowerCase();
  const existing = await db.select().from(employees).where(eq(employees.email, email)).get();
  let state: "created" | "updated" | "unchanged" = "unchanged";
  let id = existing?.id;
  if (!existing) {
    const password = await hashPassword(credentials.ADMIN_PASSWORD);
    id = newId("emp");
    await db.insert(employees).values({
      id,
      email,
      name: credentials.ADMIN_NAME,
      passwordHash: password.hash,
      passwordIters: password.iterations,
      passwordChangedAt: now,
      status: "active",
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    });
    state = "created";
  } else {
    const changes: Partial<typeof employees.$inferInsert> = {};
    if (!(await verifyPassword(credentials.ADMIN_PASSWORD, existing.passwordHash))) {
      const password = await hashPassword(credentials.ADMIN_PASSWORD);
      Object.assign(changes, { passwordHash: password.hash, passwordIters: password.iterations, passwordChangedAt: now });
    }
    if (existing.status !== "active") Object.assign(changes, { status: "active", disabledAt: null });
    if (!existing.isDemo) changes.isDemo = true;
    if (resetMfa && (existing.totpEnabled || existing.totpSecretEnc)) Object.assign(changes, { totpEnabled: false, totpSecretEnc: null, recoveryCodes: null });
    if (Object.keys(changes).length > 0) {
      await db.update(employees).set({ ...changes, updatedAt: now }).where(eq(employees.id, existing.id));
      state = "updated";
    }
  }
  const ownerRoleId = (await existingDefaultRoles(db)).get("owner") ?? roleId("owner");
  const inserted = await db.insert(employeeRoles).values({ employeeId: id!, roleId: ownerRoleId, grantedAt: now }).onConflictDoNothing().returning();
  if (inserted.length > 0 && state === "unchanged") state = "updated";
  return state;
}

/** The demo customer: created, or brought back to the stored password, active, is_demo. */
async function ensureCustomer(db: Db, credentials: Credentials, now: number): Promise<"created" | "updated" | "unchanged"> {
  const phoneE164 = normalizeIraqPhone(credentials.CUSTOMER_PHONE);
  if (!phoneE164) refuse("CUSTOMER_PHONE in .dev.seed-credentials is not an Iraqi mobile number.");
  const existing = await db.select().from(customers).where(eq(customers.phoneE164, phoneE164)).get();
  if (!existing) {
    const password = await hashPassword(credentials.CUSTOMER_PASSWORD);
    await db.insert(customers).values({ id: newId("cus"), phoneE164, name: credentials.CUSTOMER_NAME, passwordHash: password.hash, passwordIters: password.iterations, status: "active", isDemo: true, createdAt: now, updatedAt: now });
    return "created";
  }
  const changes: Partial<typeof customers.$inferInsert> = {};
  if (!(await verifyPassword(credentials.CUSTOMER_PASSWORD, existing.passwordHash))) {
    const password = await hashPassword(credentials.CUSTOMER_PASSWORD);
    Object.assign(changes, { passwordHash: password.hash, passwordIters: password.iterations });
  }
  if (existing.status !== "active") changes.status = "active";
  if (!existing.isDemo) changes.isDemo = true;
  if (Object.keys(changes).length === 0) return "unchanged";
  await db.update(customers).set({ ...changes, updatedAt: now }).where(eq(customers.id, existing.id));
  return "updated";
}

async function main(): Promise<number> {
  const { resetMfa, credentialsOnly } = parseArgs(process.argv.slice(2));
  if (isProductionEnv(process.env.APP_ENV)) refuse("Refusing to run: APP_ENV is production. Demo accounts exist only in local development.");
  if (credentialsOnly) {
    writeCredentials(completeCredentials(readCredentials()));
    console.log(`Credentials written to ${path.relative(process.cwd(), CREDENTIALS_FILE) || CREDENTIALS_FILE} (git-ignored; not printed). The database was not touched.`);
    return 0;
  }

  const proxy = await getPlatformProxy<Env>({
    configPath: path.join(PROJECT_ROOT, "wrangler.jsonc"),
    // The same local state `npm run dev` uses; never a remote resource.
    persist: { path: path.join(PROJECT_ROOT, ".wrangler", "state", "v3") },
    remoteBindings: false,
  });
  try {
    // wrangler.jsonc says production; .dev.vars overrides it for local work. If it does not, stop.
    if (isProductionEnv(proxy.env.APP_ENV)) refuse("Refusing to run: the local Worker vars say APP_ENV=production (set APP_ENV in .dev.vars).");
    const d1 = proxy.env.DB;
    const migrated = await d1.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('employees', 'customers', 'roles')").first<{ n: number }>();
    if ((migrated?.n ?? 0) < 3) {
      console.error("The local database has no schema yet. Run `npm run db:reset` (or `npm run db:migrate`) first.");
      return 1;
    }
    const db = createDb(d1);
    const now = Date.now();
    const credentials = completeCredentials(readCredentials());
    writeCredentials(credentials);
    await seedRoles(db, now);
    const owner = await ensureOwner(db, credentials, now, resetMfa);
    const customer = await ensureCustomer(db, credentials, now);
    console.log(`Demo owner (admin): ${owner}. Demo customer (storefront): ${customer}. Credentials: ${path.relative(process.cwd(), CREDENTIALS_FILE) || CREDENTIALS_FILE} (git-ignored; not printed).`);
    return 0;
  } finally {
    await proxy.dispose();
  }
}

// Runs only as a script (`tsx scripts/dev-accounts.ts`), so tests can import the helpers above without touching anything.
const sameFile = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && sameFile(pathToFileURL(path.resolve(process.argv[1])).href, import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const known = readCredentials();
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("dev-accounts failed:", redactSecrets(message, Object.values(known)));
      process.exitCode = 1;
    },
  );
}
