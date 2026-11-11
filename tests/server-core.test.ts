/**
 * Server core — errors, permissions, crypto, audit trail, settings, rate limits, uploads, storage,
 * outbox, customer and admin authentication, shell data. Everything that touches the database runs
 * against a real local D1 (tests/helpers/db.ts), with the real constraints and triggers.
 */
import { crc32 } from "node:zlib";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { maskPhone } from "~/lib/phone";
import { GUEST, actorRef, assertCan, can, canAccessBranch, permissionsOf, systemActor, type Actor, type EmployeeActor } from "~/server/actor";
import { audit, auditRow, auditStatement, maskPhonesIn, redactForAudit, sealAudit, verifyAuditChain } from "~/server/audit.server";
import {
  ADMIN_COOKIE,
  beginTotpEnrollment,
  changeEmployeePassword,
  confirmTotpEnrollment,
  createFirstOwner,
  disableEmployee,
  getEmployee,
  getPendingMfa,
  isSetupAvailable,
  listEmployeeSessions,
  requireEmployee,
  resetEmployeeMfa,
  revokeEmployeeSession,
  signInEmployee,
  signOutEmployee,
  verifyEmployeeMfa,
} from "~/server/auth/admin.server";
import { safeNextPath } from "~/server/auth/common.server";
import {
  CUSTOMER_COOKIE,
  changeCustomerPassword,
  confirmCustomerPhone,
  getCustomer,
  listCustomerSessions,
  requestOtp,
  requireCustomer,
  revokeAllCustomerSessions,
  revokeCustomerSession,
  signInCustomer,
  signOutCustomer,
  signUpCustomer,
  verifyOtp,
} from "~/server/auth/customer.server";
import { seedRoles } from "~/server/auth/seed-roles";
import type { RequestCtx } from "~/server/context.server";
import {
  PASSWORD_ITERATIONS,
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  findRecoveryCode,
  fromBase64,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  hmacSha256Hex,
  needsRehash,
  otpauthUri,
  randomDigits,
  signToken,
  toBase64Url,
  totpCode,
  verifyPassword,
  verifyToken,
  verifyTotp,
} from "~/server/crypto.server";
import {
  auditEvents,
  auditSeals,
  authEvents,
  cartItems,
  carts,
  customerSessions,
  customers,
  employeeRoles,
  employeeSessions,
  employees,
  files,
  fxRates,
  otpCodes,
  outbox,
  rateLimits,
  rolePermissions,
  roles,
  settings,
} from "~/server/db/schema";
import { SETTINGS_DEFAULTS } from "~/server/db/seed/reference";
import { TRIGGER_ERROR_CODES, mapDbError } from "~/server/db/tx.server";
import { AppError, CORE_ERROR_KEYS, actionError, conflict, forbidden, invalid, isAppError, notFound, rateLimited, throwAsResponse, toAppError, zodFieldErrors } from "~/server/errors";
import { deliverOutbox, enqueueMessage, outboxStatement, sendOrHold, type MessageProviders, type OutgoingMessage } from "~/server/outbox.server";
import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_KEYS,
  FIELD_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_DEFS,
  PERMISSION_GROUPS,
  WILDCARD_PERMISSION,
  defaultRolePermissions,
  expandPermissions,
  isPermission,
  permissionGroups,
  roleId,
  type Permission,
} from "~/server/permissions";
import { RATE_LIMITS, claimOnce, cleanupRateLimits, enforceRateLimit, limitKey, peekRateLimit, rateLimit, resetRateLimit } from "~/server/ratelimit.server";
import { PUBLIC_SETTING_KEYS, SETTINGS, SETTING_KEYS, getPublicSettings, getSetting, getSettings, listSettings, setSetting, settingDefault } from "~/server/settings.server";
import { loadShellData } from "~/server/shell.server";
import { deleteFile, fileHeaders, fileResponse, getFile, getPublicBlob, isPublicStorageKey, kvBlobStore, putFile, sanitizeFileName, setFileVisibility, type BlobStore } from "~/server/storage.server";
import { MAX_IMAGE_BYTES, detectImageFormat, processImageUpload, sanitizeImage, saveImageUpload } from "~/server/uploads.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let t: TestDb;
let make: Fixtures;
let store: BlobStore;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  store = kvBlobStore(t.kv);
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

const DATA_KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const SESSION_SECRET = randomToken(48);
const SETUP_TOKEN = randomToken(24);
const secrets = { DATA_KEY, SESSION_SECRET, SETUP_TOKEN };

type TestRequest = { ctx: RequestCtx; setCookies: string[] };
let requestCount = 0;

/** A request context as the root middleware would build it. Every call is a new request with its own IP. */
function request(options: { now?: number; ip?: string | null; cookies?: Record<string, string>; isDev?: boolean; isHttps?: boolean } = {}): TestRequest {
  const n = ++requestCount;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `req-${n}`,
    nonce: "test-nonce",
    origin: "http://localhost:5173",
    isHttps: options.isHttps ?? false,
    isDev: options.isDev ?? true,
    now: options.now ?? NOW,
    ip: options.ip === undefined ? `198.51.${Math.floor(n / 250)}.${n % 250}` : options.ip,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

type ParsedCookie = { name: string; value: string; attributes: Record<string, string | true> };

function parseSetCookie(serialized: string): ParsedCookie {
  const [pair, ...rest] = serialized.split("; ");
  const eqAt = pair.indexOf("=");
  const attributes: Record<string, string | true> = {};
  for (const part of rest) {
    const at = part.indexOf("=");
    if (at === -1) attributes[part.toLowerCase()] = true;
    else attributes[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
  }
  return { name: pair.slice(0, eqAt), value: decodeURIComponent(pair.slice(eqAt + 1)), attributes };
}

/** The cookies a browser would hold after a response (later Set-Cookie wins, Max-Age=0 deletes). */
function cookiesAfter(previous: TestRequest, base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of previous.setCookies) {
    const cookie = parseSetCookie(serialized);
    if (cookie.attributes["max-age"] === "0") delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
  }
  return jar;
}

/** Every error code and field key seen by failure(), checked against CORE_ERROR_KEYS at the end of this file. */
const seenErrorKeys = new Set<string>();

async function failure(run: () => Promise<unknown> | unknown): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);
    if (!appError) throw error;
    seenErrorKeys.add(appError.code);
    for (const key of Object.values(appError.fields ?? {})) seenErrorKeys.add(key);
    return appError;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}

async function thrown(run: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned");
}

const scalar = async (query: string, ...params: unknown[]) => {
  const row = await t.d1.prepare(query).bind(...params).first<Record<string, unknown>>();
  return row ? Object.values(row)[0] : null;
};

const employeeActor = (permissions: readonly string[], extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: newId("emp"), permissions, ...extra });
const roleActor = (key: (typeof DEFAULT_ROLE_KEYS)[number]): EmployeeActor => employeeActor([...(DEFAULT_ROLES.find((role) => role.key === key)?.permissions ?? [])]);

const text = (value: string) => [...new TextEncoder().encode(value)];
const includesText = (bytes: Uint8Array, value: string) => Buffer.from(bytes).includes(Buffer.from(value, "utf8"));

// ───────────────────────────────────────────────────────────────── errors

describe("errors", () => {
  test("AppError carries code, status, fields and detail; helpers pick the right status", () => {
    const error = new AppError("phone_taken", 409, { fields: { phone: "phone_taken" }, detail: "cus_1" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "AppError", code: "phone_taken", status: 409, fields: { phone: "phone_taken" }, detail: "cus_1" });
    expect(notFound("order")).toMatchObject({ code: "not_found", status: 404, detail: "order" });
    expect(forbidden("cost.read")).toMatchObject({ code: "forbidden", status: 403, detail: "cost.read" });
    expect(invalid({ phone: "phone_invalid" })).toMatchObject({ code: "invalid", status: 400, fields: { phone: "phone_invalid" } });
    expect(conflict("order_already_shipped")).toMatchObject({ code: "order_already_shipped", status: 409 });
    expect(rateLimited(41.2)).toMatchObject({ code: "rate_limited", status: 429, retryAfterSec: 42 });
    expect(isAppError(error)).toBe(true);
    expect(isAppError(error, "phone_taken")).toBe(true);
    expect(isAppError(error, "other")).toBe(false);
    expect(isAppError(new Error("x"))).toBe(false);
  });

  test("toAppError understands zod errors, database rules and nothing else", () => {
    const schema = z.object({ phone: z.string().min(1), password: z.string().min(8, "password_too_short"), qty: z.number().int().min(1), note: z.string().max(3), address: z.object({ governorateId: z.string() }) });
    const parsed = schema.safeParse({ phone: "", password: "abc", qty: 0, note: "too long", address: {} });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(zodFieldErrors(parsed.error)).toEqual({ phone: "required", password: "password_too_short", qty: "too_small", note: "too_long", "address.governorateId": "required" });
    expect(toAppError(parsed.error)).toMatchObject({ code: "invalid", status: 400, fields: { phone: "required" } });

    expect(toAppError(new Error("D1_ERROR: TT:INSUFFICIENT_STOCK:var_123: SQLITE_CONSTRAINT"))).toMatchObject({ code: "insufficient_stock", status: 409, detail: "var_123" });
    expect(toAppError(new Error("D1_ERROR: UNIQUE constraint failed: orders.idempotency_key: SQLITE_CONSTRAINT"))).toMatchObject({ code: "unique", status: 409, detail: "orders.idempotency_key" });
    expect(toAppError(new Error("D1_ERROR: CHECK constraint failed: orders_total_check: SQLITE_CONSTRAINT"))).toMatchObject({ code: "check", status: 422 });

    const original = notFound();
    expect(toAppError(original)).toBe(original);
    expect(toAppError(new Error("socket hang up"))).toBeNull();
    expect(toAppError("boom")).toBeNull();
    expect(toAppError(null)).toBeNull();
  });

  test("a real trigger failure from the database becomes an AppError", async () => {
    await t.db.insert(auditEvents).values({ id: newId("aud"), at: NOW, actorKind: "system", action: "test.errors.seed" });
    const error = await failure(() => t.db.update(auditEvents).set({ reason: "edited" }).where(eq(auditEvents.action, "test.errors.seed")));
    expect(error).toMatchObject({ code: "immutable", status: 409, detail: "audit_events" });
  });

  test("actionError shapes expected failures, translates when it can, and rethrows the rest", () => {
    const t9n = (key: string, vars?: Record<string, string | number>) =>
      ({ "errors.invalid": "تحقق من الحقول", "errors.phone_invalid": "رقم الهاتف غير صحيح", "errors.rate_limited": `حاول بعد ${vars?.seconds} ثانية` })[key] ?? key;

    expect(actionError(invalid({ phone: "phone_invalid", name: "too_short" }), t9n)).toEqual({
      ok: false,
      code: "invalid",
      status: 400,
      message: "تحقق من الحقول",
      fields: { phone: "رقم الهاتف غير صحيح", name: "too_short" },
    });
    expect(actionError(rateLimited(30), t9n)).toEqual({ ok: false, code: "rate_limited", status: 429, message: "حاول بعد 30 ثانية", retryAfterSec: 30 });
    // Without a translator the keys come back as they are.
    expect(actionError(invalid({ phone: "phone_invalid" }))).toEqual({ ok: false, code: "invalid", status: 400, fields: { phone: "phone_invalid" } });
    // `detail` never reaches the client.
    expect(JSON.stringify(actionError(new AppError("insufficient_stock", 409, { detail: "var_secret" })))).not.toContain("var_secret");

    const bug = new TypeError("undefined is not a function");
    expect(() => actionError(bug)).toThrow(bug);
  });

  test("throwAsResponse turns expected failures into responses with their status", async () => {
    const response = (await thrown(() => throwAsResponse(forbidden("cost.read")))) as { type?: string; data?: unknown; init?: { status?: number; headers?: Headers } };
    expect(response.init?.status).toBe(403);
    expect(response.data).toEqual({ error: "forbidden" });
    expect(JSON.stringify(response.data)).not.toContain("cost.read");

    const limited = (await thrown(() => throwAsResponse(rateLimited(12)))) as { init?: { status?: number; headers?: Headers } };
    expect(limited.init?.status).toBe(429);
    expect(new Headers(limited.init?.headers).get("Retry-After")).toBe("12");

    const bug = new RangeError("out of range");
    expect(await thrown(() => throwAsResponse(bug))).toBe(bug);
  });
});

// ───────────────────────────────────────────────────────────────── permissions and actors

describe("permissions", () => {
  const MODULES = ["dashboard", "catalog", "pricing", "inventory", "orders", "pos", "customers", "promotions", "purchasing", "finance", "shipping", "returns", "devices", "support", "staff", "marketing", "cms", "reports", "automation", "security", "channels", "settings", "ops"];

  test("the catalogue covers all 23 admin modules, in blueprint order, with Arabic and English labels", () => {
    const moduleGroups = PERMISSION_GROUPS.filter((group) => group.module !== null);
    expect(moduleGroups.map((group) => group.key)).toEqual(MODULES);
    expect(moduleGroups.map((group) => group.module)).toEqual(MODULES.map((_, index) => String(index + 1).padStart(2, "0")));

    const grouped = permissionGroups();
    expect(grouped).toHaveLength(24);
    for (const group of grouped) {
      expect(group.permissions.length, `group ${group.key} has no permissions`).toBeGreaterThan(0);
      expect(group.label.ar.trim()).not.toBe("");
      expect(group.label.en?.trim()).not.toBe("");
    }
    expect(grouped.flatMap((group) => group.permissions)).toHaveLength(PERMISSIONS.length);

    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const key of PERMISSIONS) {
      const def = PERMISSION_DEFS[key];
      expect(key, key).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/);
      expect(def.ar.trim().length, `${key} ar`).toBeGreaterThan(2);
      expect(def.en.trim().length, `${key} en`).toBeGreaterThan(2);
      expect(/[\u0600-\u06FF]/.test(def.ar), `${key} ar is Arabic`).toBe(true);
      expect(/[\u0600-\u06FF]/.test(def.en), `${key} en is not Arabic`).toBe(false);
    }
  });

  test("names follow <module>.<resource>.<action>, except the documented short and field-level ones", () => {
    const short = new Set(["settings.read", "settings.manage", "staff.manage", "audit.read", "cost.read", "profit.read", "payment_proof.read", "digital_code.reveal"]);
    for (const key of PERMISSIONS) {
      const parts = key.split(".");
      const group = PERMISSION_DEFS[key].group;
      if (short.has(key)) {
        expect(parts.length, key).toBe(2);
      } else if (group === "fields") {
        expect(key).toBe("customer.phone.read_full");
      } else {
        expect(parts.length, key).toBe(3);
        expect(parts[0], key).toBe(group);
      }
    }
    expect([...FIELD_PERMISSIONS].sort()).toEqual(PERMISSIONS.filter((key) => PERMISSION_DEFS[key].group === "fields").sort());
  });

  test("the permissions named by the contract exist", () => {
    const required = [
      "cost.read",
      "profit.read",
      "customer.phone.read_full",
      "payment_proof.read",
      "digital_code.reveal",
      "inventory.oversell.authorize",
      "inventory.stock.adjust",
      "orders.payment.verify",
      "orders.payment.override",
      "orders.refund.create",
      "orders.refund.approve",
      "pricing.discount.override",
      "catalog.product.publish",
      "settings.manage",
      "staff.manage",
      "audit.read",
    ];
    for (const key of required) expect(isPermission(key), key).toBe(true);
    expect(isPermission("orders.payment.verfy")).toBe(false);
    expect(isPermission(WILDCARD_PERMISSION)).toBe(false);
  });

  test("default roles: the eight roles, every permission known, only the owner holds the wildcard", () => {
    expect(DEFAULT_ROLES.map((role) => role.key)).toEqual(["owner", "manager", "finance", "inventory", "fulfillment", "support", "cashier", "content"]);
    for (const role of DEFAULT_ROLES) {
      expect(role.name.ar.trim()).not.toBe("");
      expect(role.name.en?.trim()).not.toBe("");
      expect(new Set(role.permissions).size, `${role.key} lists a permission twice`).toBe(role.permissions.length);
      for (const permission of role.permissions) {
        if (role.key === "owner") expect(permission).toBe(WILDCARD_PERMISSION);
        else expect(isPermission(permission), `${role.key}: ${permission}`).toBe(true);
      }
    }
    expect(defaultRolePermissions("owner").size).toBe(PERMISSIONS.length);
    expect(expandPermissions(["*"]).size).toBe(PERMISSIONS.length);
    expect([...expandPermissions(["cost.read", "not.a.permission"])]).toEqual(["cost.read"]);
  });

  test("cost privacy: only owner, manager and finance can read cost or profit", () => {
    const allowed = new Set(["owner", "manager", "finance"]);
    for (const key of DEFAULT_ROLE_KEYS) {
      const actor = roleActor(key);
      expect(can(actor, "cost.read"), `${key} cost.read`).toBe(allowed.has(key));
      expect(can(actor, "profit.read"), `${key} profit.read`).toBe(allowed.has(key));
      expect(defaultRolePermissions(key).has("cost.read")).toBe(allowed.has(key));
      // Nobody without cost.read may edit costs or see margin reports either.
      if (!allowed.has(key)) {
        for (const permission of ["pricing.cost.update", "reports.margin.read", "finance.report.read", "purchasing.landed_cost.allocate", "pricing.margin.manage"] as const) {
          expect(can(actor, permission), `${key} ${permission}`).toBe(false);
        }
      }
    }
    for (const key of ["cashier", "support", "content", "fulfillment"] as const) {
      expect(() => assertCan(roleActor(key), "cost.read")).toThrow(AppError);
      expect(() => assertCan(roleActor(key), "profit.read")).toThrow(AppError);
    }
  });

  test("least privilege: what each role can and cannot do", () => {
    const expectations: Record<(typeof DEFAULT_ROLE_KEYS)[number], { can: Permission[]; cannot: Permission[] }> = {
      owner: { can: ["staff.manage", "settings.payment.manage", "channels.api_key.manage", "digital_code.reveal", "finance.period.close"], cannot: [] },
      manager: {
        can: ["orders.payment.verify", "orders.payment.override", "orders.refund.approve", "inventory.oversell.authorize", "pricing.discount.override", "catalog.product.publish", "settings.manage", "audit.read", "payment_proof.read"],
        cannot: ["staff.manage", "settings.payment.manage", "channels.api_key.manage", "channels.integration.manage", "finance.period.close", "security.mfa.manage", "staff.payroll.approve"],
      },
      finance: {
        can: ["orders.payment.verify", "orders.refund.approve", "payment_proof.read", "finance.period.close", "finance.journal.post", "shipping.cod.settle", "audit.read"],
        // A transfer whose amount does not match goes to a manager or the owner: verifying and overriding stay with different people.
        cannot: ["orders.payment.override", "staff.manage", "settings.payment.manage", "settings.manage", "catalog.product.publish", "inventory.stock.adjust", "inventory.oversell.authorize", "digital_code.reveal", "customer.phone.read_full"],
      },
      inventory: {
        can: ["inventory.stock.adjust", "inventory.stock.receive", "inventory.count.perform", "purchasing.receipt.create", "devices.used.inspect"],
        cannot: ["inventory.oversell.authorize", "inventory.count.approve", "orders.payment.verify", "orders.refund.approve", "payment_proof.read", "pricing.price.update", "customer.phone.read_full", "settings.manage", "audit.read"],
      },
      fulfillment: {
        can: ["orders.fulfillment.pack", "orders.fulfillment.ship", "shipping.shipment.create", "customer.phone.read_full"],
        cannot: ["orders.payment.verify", "orders.refund.approve", "payment_proof.read", "inventory.stock.adjust", "orders.order.cancel", "settings.manage", "audit.read"],
      },
      support: {
        can: ["support.ticket.reply", "orders.refund.create", "returns.rma.create", "customer.phone.read_full"],
        cannot: ["orders.refund.approve", "orders.payment.verify", "orders.payment.override", "payment_proof.read", "customers.wallet.adjust", "digital_code.reveal", "support.knowledge.approve", "settings.manage", "audit.read"],
      },
      cashier: {
        can: ["pos.sale.create", "pos.shift.open", "pos.shift.close", "pos.discount.apply"],
        cannot: ["pos.shift.review", "pos.sale.refund", "pricing.discount.override", "orders.refund.approve", "inventory.stock.adjust", "customer.phone.read_full", "payment_proof.read", "settings.manage", "audit.read"],
      },
      content: {
        can: ["catalog.product.update", "catalog.media.manage", "cms.page.publish", "cms.banner.manage"],
        cannot: ["catalog.product.publish", "pricing.price.update", "orders.order.read", "customers.customer.read", "customer.phone.read_full", "payment_proof.read", "settings.manage", "audit.read"],
      },
    };
    for (const key of DEFAULT_ROLE_KEYS) {
      const actor = roleActor(key);
      for (const permission of expectations[key].can) expect(can(actor, permission), `${key} should have ${permission}`).toBe(true);
      for (const permission of expectations[key].cannot) expect(can(actor, permission), `${key} must not have ${permission}`).toBe(false);
      expect(can(actor, "dashboard.overview.read"), `${key} can open the admin`).toBe(true);
    }
    // Only the owner can change who may do what, or where transfers are sent.
    for (const key of DEFAULT_ROLE_KEYS.filter((role) => role !== "owner")) {
      expect(can(roleActor(key), "staff.manage"), key).toBe(false);
      expect(can(roleActor(key), "settings.payment.manage"), key).toBe(false);
    }
  });

  test("can / assertCan: guests and customers never pass, the system always does", () => {
    const customer: Actor = { kind: "customer", id: "cus_1" };
    for (const permission of PERMISSIONS) {
      expect(can(GUEST, permission)).toBe(false);
      expect(can(customer, permission)).toBe(false);
      expect(can(systemActor("reservations.expire"), permission)).toBe(true);
    }
    const asArray = employeeActor(["orders.order.read"]);
    const asSet: EmployeeActor = { kind: "employee", id: "emp_1", permissions: new Set(["orders.order.read"]) };
    for (const actor of [asArray, asSet]) {
      expect(can(actor, "orders.order.read")).toBe(true);
      expect(can(actor, "orders.order.cancel")).toBe(false);
      expect(() => assertCan(actor, "orders.order.read")).not.toThrow();
    }
    const refusal = (() => {
      try {
        assertCan(asArray, "orders.order.cancel");
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toMatchObject({ code: "forbidden", status: 403, detail: "orders.order.cancel" });
    expect(permissionsOf(asArray)).toEqual(["orders.order.read"]);
    expect(permissionsOf(employeeActor(["*"]))).toHaveLength(PERMISSIONS.length);
    expect(permissionsOf(GUEST)).toEqual([]);
  });

  test("branch limits and actor references", () => {
    expect(canAccessBranch(employeeActor([], { branchId: "br_1" }), "br_1")).toBe(true);
    expect(canAccessBranch(employeeActor([], { branchId: "br_1" }), "br_2")).toBe(false);
    expect(canAccessBranch(employeeActor([], { branchId: null }), "br_2")).toBe(true);
    expect(canAccessBranch(GUEST, "br_1")).toBe(false);
    expect(actorRef(GUEST)).toEqual({ actorKind: "guest", actorId: null });
    expect(actorRef({ kind: "customer", id: "cus_9" })).toEqual({ actorKind: "customer", actorId: "cus_9" });
    expect(actorRef(systemActor("audit.seal"))).toEqual({ actorKind: "system", actorId: "audit.seal" });
  });
});

// ───────────────────────────────────────────────────────────────── crypto

describe("crypto", () => {
  test("password hashing: PBKDF2-SHA256, random 16-byte salt, iterations stored with the hash", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first.iterations).toBe(100_000);
    expect(PASSWORD_ITERATIONS).toBe(100_000);
    const [scheme, iterations, salt, hash] = first.hash.split("$");
    expect(scheme).toBe("pbkdf2-sha256");
    expect(iterations).toBe("100000");
    expect(fromBase64(salt)).toHaveLength(16);
    expect(fromBase64(hash)).toHaveLength(32);
    // Same password, different salt, different hash — and the password is not in it.
    expect(first.hash).not.toBe(second.hash);
    expect(first.hash).not.toContain("correct");

    expect(await verifyPassword("correct horse battery staple", first.hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", first.hash)).toBe(false);
    expect(await verifyPassword("", first.hash)).toBe(false);
    expect(await verifyPassword("x".repeat(300), first.hash)).toBe(false);
  });

  test("verification of missing or malformed hashes is false, never an exception", async () => {
    for (const stored of [null, undefined, "", "plaintext", "pbkdf2-sha256$100000$onlythree", "bcrypt$10$abc$def", "pbkdf2-sha256$999999999$AAAA$AAAA", "pbkdf2-sha256$100000$!!!$???"]) {
      expect(await verifyPassword("whatever", stored)).toBe(false);
    }
  });

  test("Unicode passwords verify across normalization forms; rehash is needed for weaker settings", async () => {
    const composed = "كلمة-سرّ-é";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const stored = await hashPassword(composed, 1000);
    expect(await verifyPassword(decomposed, stored.hash)).toBe(true);

    expect(stored.iterations).toBe(1000);
    expect(needsRehash(stored.hash)).toBe(true);
    expect(needsRehash((await hashPassword("another password")).hash)).toBe(false);
    expect(needsRehash("garbage")).toBe(true);
    expect(needsRehash(null)).toBe(true);
    await expect(hashPassword("x", 100_001)).rejects.toThrow(/iterations/);
    await expect(hashPassword("x", 10)).rejects.toThrow(/iterations/);
    await expect(hashPassword("")).rejects.toThrow();
  });

  test("AES-256-GCM: round trip, random IV, bound to its context, tamper-evident", async () => {
    const secret = "JBSWY3DPEHPK3PXP — سرّ";
    const sealed = await encryptSecret(secret, DATA_KEY, "employee:emp_1:totp");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await encryptSecret(secret, DATA_KEY, "employee:emp_1:totp")).not.toBe(sealed);
    expect(await decryptSecret(sealed, DATA_KEY, "employee:emp_1:totp")).toBe(secret);

    await expect(decryptSecret(sealed, DATA_KEY, "employee:emp_2:totp")).rejects.toThrow(/could not be decrypted/);
    const otherKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await expect(decryptSecret(sealed, otherKey, "employee:emp_1:totp")).rejects.toThrow(/could not be decrypted/);
    const [version, iv, body] = sealed.split(".");
    const flipped = fromBase64(body);
    flipped[0] ^= 1;
    await expect(decryptSecret(`${version}.${iv}.${toBase64Url(flipped)}`, DATA_KEY, "employee:emp_1:totp")).rejects.toThrow(/could not be decrypted/);
    await expect(decryptSecret("v2.aaaa.bbbb", DATA_KEY)).rejects.toThrow(/Unreadable/);

    await expect(encryptSecret("x", undefined)).rejects.toThrow(/DATA_KEY is not configured/);
    await expect(encryptSecret("x", toBase64Url(new Uint8Array(16)))).rejects.toThrow(/32 bytes/);
    // The base64 (not base64url) form used in .dev.vars is accepted too.
    const standard = Buffer.from(fromBase64(DATA_KEY)).toString("base64");
    expect(await decryptSecret(sealed, standard, "employee:emp_1:totp")).toBe(secret);
  });

  test("signed tokens: purpose, expiry and tampering are all checked", async () => {
    const token = await signToken({ orderId: "ord_1", n: 3 }, SESSION_SECRET, { purpose: "upload", expiresAt: NOW + MINUTE });
    expect(await verifyToken(token, SESSION_SECRET, { purpose: "upload", now: NOW })).toEqual({ orderId: "ord_1", n: 3 });
    expect(await verifyToken(token, SESSION_SECRET, { purpose: "download", now: NOW })).toBeNull();
    expect(await verifyToken(token, SESSION_SECRET, { purpose: "upload", now: NOW + MINUTE })).toBeNull();
    expect(await verifyToken(token, randomToken(48), { purpose: "upload", now: NOW })).toBeNull();

    const [body, signature] = token.split(".");
    const forgedBody = toBase64Url(new TextEncoder().encode(JSON.stringify({ p: "upload", e: NOW + DAY, d: { orderId: "ord_2" } })));
    expect(await verifyToken(`${forgedBody}.${signature}`, SESSION_SECRET, { purpose: "upload", now: NOW })).toBeNull();
    expect(await verifyToken(`${body}.${signature.slice(0, -2)}AA`, SESSION_SECRET, { purpose: "upload", now: NOW })).toBeNull();
    for (const junk of [null, undefined, "", "abc", "a.b.c", ".", "x".repeat(5000)]) {
      expect(await verifyToken(junk, SESSION_SECRET, { purpose: "upload", now: NOW })).toBeNull();
    }
    await expect(signToken({}, "short", { purpose: "upload", expiresAt: NOW })).rejects.toThrow(/secret/);
    expect(await hmacSha256Hex(SESSION_SECRET, "a")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacSha256Hex(SESSION_SECRET, "a")).not.toBe(await hmacSha256Hex(SESSION_SECRET, "b"));
  });

  test("base32 matches RFC 4648", () => {
    const vectors: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
    }
    expect(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi======"))).toBe("foobar");
    expect(() => base32Decode("MZXW1")).toThrow(/base32/);
  });

  test("TOTP matches the RFC 6238 test vectors", async () => {
    const sha1 = base32Encode(new TextEncoder().encode("12345678901234567890"));
    const sha256 = base32Encode(new TextEncoder().encode("12345678901234567890123456789012"));
    const sha512 = base32Encode(new TextEncoder().encode("1234567890123456789012345678901234567890123456789012345678901234"));
    const vectors: [seconds: number, sha1: string, sha256: string, sha512: string][] = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ];
    for (const [seconds, expected1, expected256, expected512] of vectors) {
      expect(await totpCode(sha1, seconds * 1000, { digits: 8 }), `SHA-1 at ${seconds}`).toBe(expected1);
      expect(await totpCode(sha256, seconds * 1000, { digits: 8, algorithm: "SHA-256" }), `SHA-256 at ${seconds}`).toBe(expected256);
      expect(await totpCode(sha512, seconds * 1000, { digits: 8, algorithm: "SHA-512" }), `SHA-512 at ${seconds}`).toBe(expected512);
      // The six-digit code authenticator apps show is the last six digits of the eight-digit one.
      expect(await totpCode(sha1, seconds * 1000)).toBe(expected1.slice(2));
    }
  });

  test("TOTP verification: 30-second steps, ±1 step window, replay guard", async () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    const at = 1_800_000_000_000;
    const step = Math.floor(at / 30_000);
    const current = await totpCode(secret, at);
    const previous = await totpCode(secret, at - 30_000);
    const next = await totpCode(secret, at + 30_000);
    const tooOld = await totpCode(secret, at - 60_000);
    const tooNew = await totpCode(secret, at + 60_000);

    expect(await verifyTotp(secret, current, at)).toEqual({ ok: true, step });
    expect(await verifyTotp(secret, previous, at)).toEqual({ ok: true, step: step - 1 });
    expect(await verifyTotp(secret, next, at)).toEqual({ ok: true, step: step + 1 });
    if (tooOld !== current && tooOld !== previous && tooOld !== next) expect(await verifyTotp(secret, tooOld, at)).toEqual({ ok: false, reason: "invalid" });
    if (tooNew !== current && tooNew !== previous && tooNew !== next) expect(await verifyTotp(secret, tooNew, at)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyTotp(secret, current, at, { window: 0 })).toEqual({ ok: true, step });
    if (previous !== current) expect(await verifyTotp(secret, previous, at, { window: 0 })).toEqual({ ok: false, reason: "invalid" });

    // Typed with spaces or in Arabic-Indic digits, it is the same code.
    const arabic = [...current].map((digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]).join("");
    expect(await verifyTotp(secret, `${current.slice(0, 3)} ${current.slice(3)}`, at)).toEqual({ ok: true, step });
    expect(await verifyTotp(secret, arabic, at)).toEqual({ ok: true, step });

    // Replay guard: once a step was used, that code and older ones are refused inside the window.
    expect(await verifyTotp(secret, current, at, { lastUsedStep: step })).toEqual({ ok: false, reason: "replayed" });
    if (previous !== current) expect(await verifyTotp(secret, previous, at, { lastUsedStep: step })).toEqual({ ok: false, reason: "replayed" });
    if (next !== current && next !== previous) expect(await verifyTotp(secret, next, at, { lastUsedStep: step })).toEqual({ ok: true, step: step + 1 });
    expect(await verifyTotp(secret, current, at, { lastUsedStep: step - 1 })).toEqual({ ok: true, step });

    for (const junk of ["", "12345", "1234567", "abcdef", "12 34"]) expect(await verifyTotp(secret, junk, at)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyTotp("not base32 !!!", current, at)).toEqual({ ok: false, reason: "invalid" });
  });

  test("otpauth URI for authenticator apps", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "owner@tamtam.test" });
    expect(uri).toBe("otpauth://totp/TamTam%20Games:owner%40tamtam.test?secret=JBSWY3DPEHPK3PXP&issuer=TamTam%20Games&algorithm=SHA1&digits=6&period=30");
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.searchParams.get("issuer")).toBe("TamTam Games");
  });

  test("recovery codes: shown once, stored as hashes, each matches only itself", async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain(codes[0].replace("-", ""));

    expect(await findRecoveryCode(codes[3], hashes)).toBe(3);
    expect(await findRecoveryCode(codes[3].toLowerCase().replace("-", " "), hashes)).toBe(3);
    expect(await findRecoveryCode("AAAAA-AAAAA", hashes)).toBe(-1);
    expect(await findRecoveryCode("123456", hashes)).toBe(-1);
    expect(await findRecoveryCode(codes[3], [])).toBe(-1);
  });

  test("random digits are digits of the requested length", () => {
    const sample = Array.from({ length: 200 }, () => randomDigits(6));
    for (const code of sample) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(sample).size).toBeGreaterThan(190);
    expect(new Set(sample.join("")).size).toBe(10);
  });
});

// ───────────────────────────────────────────────────────────────── first owner (runs before any employee exists)

describe("first-owner bootstrap", () => {
  const owner = { email: "Owner@TamTam.Test ", name: "صاحب المتجر", password: "a-long-owner-password" };

  test("setup is available only while no employee exists, and only with the setup token", async () => {
    expect(await isSetupAvailable(t.db)).toBe(true);

    expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: SETUP_TOKEN }, NOW, {}))).toMatchObject({ code: "setup_disabled", status: 403 });
    expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: "" }, NOW, { SETUP_TOKEN: "" }))).toMatchObject({ code: "setup_disabled" });
    expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: "short" }, NOW, { SETUP_TOKEN: "short" }))).toMatchObject({ code: "setup_disabled" });
    expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: "fifteen-chars-x" }, NOW, { SETUP_TOKEN: "fifteen-chars-x" }))).toMatchObject({ code: "setup_disabled" });

    for (const wrong of ["", "wrong-token", SETUP_TOKEN.slice(0, -1), `${SETUP_TOKEN}x`, SETUP_TOKEN.toUpperCase()]) {
      const error = await failure(() => createFirstOwner(t.db, { ...owner, setupToken: wrong }, NOW, secrets));
      expect(error).toMatchObject({ code: "setup_token_invalid", status: 403, fields: { setupToken: "setup_token_invalid" } });
    }
    expect(await failure(() => createFirstOwner(t.db, { email: owner.email, name: owner.name, password: owner.password }, NOW, secrets))).toMatchObject({ code: "setup_token_invalid" });
    expect(await failure(() => createFirstOwner(t.db, null, NOW, secrets))).toMatchObject({ code: "setup_token_invalid" });
    expect(await scalar("SELECT count(*) FROM employees")).toBe(0);
    expect(await scalar("SELECT count(*) FROM roles")).toBe(0);
  });

  test("the right token still needs a valid email, name and a 12-character password", async () => {
    const error = await failure(() => createFirstOwner(t.db, { setupToken: SETUP_TOKEN, email: "not-an-email", name: "x", password: "short" }, NOW, secrets));
    expect(error).toMatchObject({ code: "invalid", status: 400, fields: { email: "email_invalid", name: "too_short", password: "password_too_short" } });
    expect(await scalar("SELECT count(*) FROM employees")).toBe(0);
  });

  test("attempts are rate-limited per address", async () => {
    const ip = "203.0.113.200";
    for (let i = 0; i < RATE_LIMITS.setup.limit; i++) {
      expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: "guess" }, NOW, secrets, { ip }))).toMatchObject({ code: "setup_token_invalid" });
    }
    expect(await failure(() => createFirstOwner(t.db, { ...owner, setupToken: SETUP_TOKEN }, NOW, secrets, { ip }))).toMatchObject({ code: "rate_limited", status: 429 });
    expect(await scalar("SELECT count(*) FROM employees")).toBe(0);
  });

  test("creates the owner once, with the built-in roles and an audit event", async () => {
    const { employeeId } = await createFirstOwner(t.db, { ...owner, setupToken: SETUP_TOKEN }, NOW, secrets, { ip: "203.0.113.9", requestId: "req-setup" });
    const row = await t.db.select().from(employees).where(eq(employees.id, employeeId)).get();
    expect(row).toMatchObject({ email: "owner@tamtam.test", name: "صاحب المتجر", status: "active", totpEnabled: false, passwordIters: 100_000 });
    expect(row?.passwordHash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row?.passwordHash).not.toContain(owner.password);
    expect(await verifyPassword(owner.password, row?.passwordHash)).toBe(true);

    expect(await scalar("SELECT count(*) FROM roles WHERE is_system = 1")).toBe(8);
    expect(await scalar("SELECT r.key FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ?", employeeId)).toBe("owner");
    expect(await scalar("SELECT permission FROM role_permissions WHERE role_id = ?", roleId("owner"))).toBe("*");

    const event = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "staff.employee.bootstrap")).get();
    expect(event).toMatchObject({ actorKind: "system", actorId: "admin.setup", entityType: "employee", entityId: employeeId, ip: "203.0.113.9", requestId: "req-setup" });
    expect(JSON.stringify(event)).not.toContain(owner.password);
    expect(JSON.stringify(event)).not.toContain(SETUP_TOKEN);

    expect(await isSetupAvailable(t.db)).toBe(false);
  });

  test("it never works a second time, even with the right token", async () => {
    const again = await failure(() => createFirstOwner(t.db, { setupToken: SETUP_TOKEN, email: "second@tamtam.test", name: "Second Owner", password: "another-long-password" }, NOW + MINUTE, secrets));
    expect(again).toMatchObject({ code: "setup_done", status: 409 });
    expect(await scalar("SELECT count(*) FROM employees")).toBe(1);
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'staff.employee.bootstrap'")).toBe(1);
  });
});

describe("first-owner bootstrap on an empty production database", () => {
  // Production gets its reference data from /admin/setup and from nowhere else: a database with the
  // migrations applied and NOTHING seeded is exactly what the first deploy has.
  let fresh: TestDb;
  beforeAll(async () => {
    fresh = await createTestDb({ seed: false });
  });
  afterAll(async () => {
    await fresh?.dispose();
  });

  const count = async (table: string) => Number((await fresh.d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1);
  const REFERENCE_TABLES = ["governorates", "districts", "settings", "inventory_locations", "channels", "accounts", "inspection_templates"];

  // Runs first, while the database is still empty: every page's root loader must work before setup.
  test("the shell loads before setup: empty cart, no customer, no rate, no write", async () => {
    for (const table of ["fx_rates", "carts", "customers", "customer_sessions", "settings"]) expect(await count(table), table).toBe(0);
    const production = { isDev: false } as const;
    expect(await loadShellData(request(production).ctx, fresh.db)).toEqual({ cart: { count: 0 }, customer: null, fx: null, fxIsDemo: false, introSeen: false, personalizationConsent: null });
    // Cookies that point at nothing (an old cart, an old session) are not an error either.
    const stale = request({ ...production, cookies: { tt_cart: randomToken(), tt_sid: randomToken(), tt_intro: "1" } });
    expect(await loadShellData(stale.ctx, fresh.db)).toMatchObject({ cart: { count: 0 }, customer: null, fx: null, introSeen: true });
    for (const table of ["carts", "customers", "customer_sessions", "audit_events"]) expect(await count(table), table).toBe(0);
  });

  test("installs the reference data and the roles, then the owner; a second run changes nothing", async () => {
    for (const table of [...REFERENCE_TABLES, "roles", "employees"]) expect(await count(table), table).toBe(0);

    // A refused attempt writes no reference data (only its rate-limit count).
    expect(await failure(() => createFirstOwner(fresh.db, { setupToken: "wrong-token", email: "owner@tamtam.test", name: "صاحب المتجر", password: "a-long-owner-password" }, NOW, secrets))).toMatchObject({ code: "setup_token_invalid" });
    for (const table of REFERENCE_TABLES) expect(await count(table), table).toBe(0);

    await createFirstOwner(fresh.db, { setupToken: SETUP_TOKEN, email: "owner@tamtam.test", name: "صاحب المتجر", password: "a-long-owner-password" }, NOW, secrets);
    const after: Record<string, number> = {};
    for (const table of REFERENCE_TABLES) {
      after[table] = await count(table);
      expect(after[table], table).toBeGreaterThan(0);
    }
    expect(after.governorates).toBe(19);
    expect(after.settings).toBe(Object.keys(SETTINGS_DEFAULTS).length);
    expect(await getSetting(fresh.db, "shipping.flat_fee_iqd")).toBe(5000);
    expect(await count("roles")).toBe(DEFAULT_ROLE_KEYS.length);
    expect(await count("employees")).toBe(1);

    // Setup is closed now: a second attempt is refused before anything is written.
    expect(await failure(() => createFirstOwner(fresh.db, { setupToken: SETUP_TOKEN, email: "second@tamtam.test", name: "Second Owner", password: "another-long-password" }, NOW + MINUTE, secrets))).toMatchObject({ code: "setup_done", status: 409 });
    for (const table of REFERENCE_TABLES) expect(await count(table), table).toBe(after[table]);
    expect(await count("employees")).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── roles

describe("seedRoles", () => {
  test("is idempotent and stores the catalogue defaults", async () => {
    const second = await seedRoles(t.db, NOW);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual([...DEFAULT_ROLE_KEYS]);
    expect(await scalar("SELECT count(*) FROM roles")).toBe(8);

    for (const role of DEFAULT_ROLES) {
      const stored = (await t.db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId(role.key)))).map((row) => row.permission);
      expect(stored.sort(), role.key).toEqual([...role.permissions].sort());
      const name = await t.db.select({ name: roles.name, isSystem: roles.isSystem }).from(roles).where(eq(roles.key, role.key)).get();
      expect(name).toEqual({ name: role.name, isSystem: true });
    }
    // What is stored for the roles that must not see cost really does not contain it.
    expect(await scalar("SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission IN ('cost.read', 'profit.read', '*') AND r.key IN ('cashier', 'support', 'content', 'fulfillment', 'inventory')")).toBe(0);
  });

  test("an edited role keeps its edits; the owner's wildcard comes back; reset restores defaults", async () => {
    const cashier = roleId("cashier");
    await t.db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, cashier), eq(rolePermissions.permission, "pos.cash.move")));
    await t.db.insert(rolePermissions).values({ roleId: cashier, permission: "pos.sale.refund" });
    await t.db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId("owner")));

    await seedRoles(t.db, NOW);
    const cashierNow = (await t.db.select().from(rolePermissions).where(eq(rolePermissions.roleId, cashier))).map((row) => row.permission);
    expect(cashierNow).not.toContain("pos.cash.move");
    expect(cashierNow).toContain("pos.sale.refund");
    expect(await scalar("SELECT permission FROM role_permissions WHERE role_id = ?", roleId("owner"))).toBe("*");

    await seedRoles(t.db, NOW, { reset: true });
    const restored = (await t.db.select().from(rolePermissions).where(eq(rolePermissions.roleId, cashier))).map((row) => row.permission);
    expect(restored.sort()).toEqual([...(DEFAULT_ROLES.find((role) => role.key === "cashier")?.permissions ?? [])].sort());
  });
});

// ───────────────────────────────────────────────────────────────── admin sessions

describe("admin authentication", () => {
  const OWNER = { email: "owner@tamtam.test", password: "a-long-owner-password" };
  let ownerId: string;

  async function employeeWithRole(role: (typeof DEFAULT_ROLE_KEYS)[number], password = "employee-password-1", iterations = 1000) {
    const hashed = await hashPassword(password, iterations);
    const email = `${make.next(role)}@tamtam.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    return { id, email, password };
  }

  async function signIn(email: string, password: string, options: Parameters<typeof request>[0] = {}) {
    const req = request(options);
    const result = await signInEmployee(req.ctx, t.db, { email, password });
    return { req, result, cookies: cookiesAfter(req) };
  }

  beforeAll(async () => {
    ownerId = String(await scalar("SELECT id FROM employees WHERE email = ?", OWNER.email));
  });

  test("sign-in sets an httpOnly, SameSite=Strict cookie scoped to /admin and stores only the token's hash", async () => {
    const { req, result } = await signIn(` ${OWNER.email.toUpperCase()} `, OWNER.password, { isHttps: true });
    expect(result.status).toBe("signed_in");
    if (result.status !== "signed_in") return;
    expect(result.session.employee).toMatchObject({ id: ownerId, email: OWNER.email, totpEnabled: false });
    expect(result.session.roles).toEqual(["owner"]);

    const cookies = req.setCookies.map(parseSetCookie);
    expect(cookies.map((cookie) => cookie.attributes.path)).toEqual(["/admin", "/admin.data"]);
    for (const cookie of cookies) {
      expect(cookie.name).toBe(ADMIN_COOKIE);
      expect(cookie.name).toBe("tt_adm");
      expect(cookie.attributes).toMatchObject({ httponly: true, samesite: "Strict", secure: true, "max-age": String(12 * 60 * 60) });
    }
    const token = cookies[0].value;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const session = await t.db.select().from(employeeSessions).where(eq(employeeSessions.idHash, await sha256Hex(token))).get();
    expect(session).toMatchObject({ employeeId: ownerId, revokedAt: null, createdAt: NOW, expiresAt: NOW + 12 * HOUR, ip: req.ctx.ip, userAgent: "vitest" });
    expect(await scalar("SELECT count(*) FROM employee_sessions WHERE id_hash = ?", token)).toBe(0);
    expect(JSON.stringify(await t.db.select().from(employeeSessions))).not.toContain(token);
    expect(await scalar("SELECT last_login_at FROM employees WHERE id = ?", ownerId)).toBe(NOW);
  });

  test("getEmployee / requireEmployee: the session's employee and an actor holding their permissions", async () => {
    const owner = await signIn(OWNER.email, OWNER.password);
    const later = request({ cookies: owner.cookies, now: NOW + MINUTE });
    const session = await getEmployee(later.ctx, t.db);
    expect(session?.employee.id).toBe(ownerId);
    expect(session?.actor).toMatchObject({ kind: "employee", id: ownerId, label: "صاحب المتجر", ip: later.ctx.ip, requestId: later.ctx.requestId });
    expect(can(session!.actor, "cost.read")).toBe(true);
    expect(can(session!.actor, "staff.manage")).toBe(true);
    // Asked twice in one request, the database is asked once: the same object comes back.
    expect(await getEmployee(later.ctx, t.db)).toBe(session);
    expect((await requireEmployee(later.ctx, t.db, "settings.payment.manage")).employee.id).toBe(ownerId);

    const cashier = await employeeWithRole("cashier");
    const cashierSignIn = await signIn(cashier.email, cashier.password);
    const cashierRequest = request({ cookies: cashierSignIn.cookies, now: NOW + MINUTE });
    const cashierSession = await requireEmployee(cashierRequest.ctx, t.db, "pos.sale.create");
    expect(cashierSession.roles).toEqual(["cashier"]);
    expect(can(cashierSession.actor, "cost.read")).toBe(false);
    expect(can(cashierSession.actor, "profit.read")).toBe(false);
    expect([...cashierSession.actor.permissions].sort()).toEqual([...(DEFAULT_ROLES.find((role) => role.key === "cashier")?.permissions ?? [])].sort());

    const refused = (await thrown(() => requireEmployee(cashierRequest.ctx, t.db, "cost.read"))) as { init?: { status?: number }; data?: unknown };
    expect(refused.init?.status).toBe(403);
    expect(refused.data).toEqual({ error: "forbidden", permission: "cost.read" });
  });

  test("an employee with several roles holds the union of their permissions", async () => {
    const both = await employeeWithRole("cashier");
    await t.db.insert(employeeRoles).values({ employeeId: both.id, roleId: roleId("content") });
    const signedIn = await signIn(both.email, both.password);
    const session = await getEmployee(request({ cookies: signedIn.cookies }).ctx, t.db);
    expect(session?.roles.sort()).toEqual(["cashier", "content"]);
    expect(can(session!.actor, "pos.sale.create")).toBe(true);
    expect(can(session!.actor, "cms.banner.manage")).toBe(true);
    expect(can(session!.actor, "cost.read")).toBe(false);
  });

  test("without a valid session requireEmployee redirects the document to /admin/login", async () => {
    const jars: Record<string, string>[] = [{}, { tt_adm: "not-a-token" }, { tt_adm: randomToken() }];
    for (const cookies of jars) {
      const req = request({ cookies });
      expect(await getEmployee(req.ctx, t.db)).toBeNull();
      const response = (await thrown(() => requireEmployee(req.ctx, t.db, undefined, { next: "/admin/orders?status=new" }))) as Response;
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/admin/login?next=%2Fadmin%2Forders%3Fstatus%3Dnew");
      expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    }
    // A well-formed token that opens nothing is removed from the browser.
    const stale = request({ cookies: { tt_adm: randomToken() } });
    await getEmployee(stale.ctx, t.db);
    expect(stale.setCookies.map(parseSetCookie).map((cookie) => [cookie.attributes.path, cookie.attributes["max-age"]])).toEqual([["/admin", "0"], ["/admin.data", "0"]]);
    // `next` cannot point outside the admin.
    const outside = (await thrown(() => requireEmployee(request().ctx, t.db, undefined, { next: "//evil.example/admin" }))) as Response;
    expect(outside.headers.get("Location")).toBe("/admin/login");
  });

  test("wrong password, unknown email and a missing password are the same failure", async () => {
    const noPassword = await make.employee({ email: "nopassword@tamtam.test" });
    expect(noPassword).toBeTruthy();
    for (const [email, password] of [[OWNER.email, "wrong-password"], ["nobody@tamtam.test", OWNER.password], ["nopassword@tamtam.test", ""], ["nopassword@tamtam.test", "anything-at-all"]] as const) {
      const req = request();
      const error = await failure(() => signInEmployee(req.ctx, t.db, { email, password }));
      if (password === "") expect(error).toMatchObject({ code: "invalid", fields: { password: "required" } });
      else expect(error).toMatchObject({ code: "invalid_credentials", status: 401, fields: { password: "invalid_credentials" } });
      expect(req.setCookies).toEqual([]);
    }
    const failed = await t.db.select().from(authEvents).where(and(eq(authEvents.kind, "login"), eq(authEvents.success, false), eq(authEvents.identifier, "nobody@tamtam.test"))).get();
    expect(failed).toMatchObject({ subjectKind: "employee", subjectId: null, details: { reason: "unknown_email" } });
    expect(JSON.stringify(await t.db.select().from(authEvents))).not.toContain(OWNER.password);
  });

  test("a weak stored hash is upgraded at the next successful sign-in", async () => {
    const weak = await employeeWithRole("support", "support-password-1", 1000);
    expect(await scalar("SELECT password_iters FROM employees WHERE id = ?", weak.id)).toBe(1000);
    await signIn(weak.email, weak.password);
    expect(await scalar("SELECT password_iters FROM employees WHERE id = ?", weak.id)).toBe(100_000);
    expect(String(await scalar("SELECT password_hash FROM employees WHERE id = ?", weak.id))).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect((await signIn(weak.email, weak.password, { now: NOW + MINUTE })).result.status).toBe("signed_in");
  });

  test("five failed passwords lock the email until the window ends — even for the right password", async () => {
    const victim = await employeeWithRole("inventory");
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await failure(() => signInEmployee(request({ now: NOW + attempt * 1000 }).ctx, t.db, { email: victim.email, password: `guess-${attempt}` }))).toMatchObject({ code: "invalid_credentials" });
    }
    const locked = await failure(() => signInEmployee(request({ now: NOW + 10_000 }).ctx, t.db, { email: victim.email, password: victim.password }));
    expect(locked).toMatchObject({ code: "locked_out", status: 429 });
    expect(locked.retryAfterSec).toBeGreaterThan(14 * 60);
    expect(locked.retryAfterSec).toBeLessThanOrEqual(15 * 60);
    expect(await scalar("SELECT count(*) FROM auth_events WHERE kind = 'lockout' AND identifier = ?", victim.email)).toBe(1);
    expect(await scalar("SELECT count(*) FROM employee_sessions WHERE employee_id = ?", victim.id)).toBe(0);
    // Other accounts are not affected, and the lock ends with the window.
    expect((await signIn(OWNER.email, OWNER.password, { now: NOW + 11_000 })).result.status).toBe("signed_in");
    expect((await signIn(victim.email, victim.password, { now: NOW + 16 * MINUTE })).result.status).toBe("signed_in");
  });

  test("a successful sign-in clears earlier failures", async () => {
    const careless = await employeeWithRole("content");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await failure(() => signInEmployee(request({ now: NOW + 30 * MINUTE }).ctx, t.db, { email: careless.email, password: "typo" }));
    }
    expect((await signIn(careless.email, careless.password, { now: NOW + 30 * MINUTE })).result.status).toBe("signed_in");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await failure(() => signInEmployee(request({ now: NOW + 31 * MINUTE }).ctx, t.db, { email: careless.email, password: "typo" }));
    }
    expect((await signIn(careless.email, careless.password, { now: NOW + 31 * MINUTE })).result.status).toBe("signed_in");
  });

  test("attempts from one address are limited across accounts", async () => {
    const ip = "203.0.113.50";
    for (let attempt = 0; attempt < RATE_LIMITS.adminSignInIp.limit; attempt++) {
      await failure(() => signInEmployee(request({ ip, now: NOW + 2 * HOUR }).ctx, t.db, { email: `spray-${attempt}@tamtam.test`, password: "guess" }));
    }
    expect(await failure(() => signInEmployee(request({ ip, now: NOW + 2 * HOUR }).ctx, t.db, { email: OWNER.email, password: OWNER.password }))).toMatchObject({ code: "rate_limited", status: 429 });
    expect((await signIn(OWNER.email, OWNER.password, { now: NOW + 2 * HOUR })).result.status).toBe("signed_in");
  });

  test("sessions expire after 12 hours, and after 2 hours without use", async () => {
    const start = NOW + 3 * HOUR;
    const active = await signIn(OWNER.email, OWNER.password, { now: start });
    // Used every 90 minutes it stays alive…
    for (const offset of [90 * MINUTE, 180 * MINUTE, 270 * MINUTE]) {
      expect(await getEmployee(request({ cookies: active.cookies, now: start + offset }).ctx, t.db), `at +${offset / MINUTE} min`).not.toBeNull();
    }
    // …but not past the 12-hour limit, however busy.
    for (let offset = 360 * MINUTE; offset < 12 * HOUR; offset += 90 * MINUTE) await getEmployee(request({ cookies: active.cookies, now: start + offset }).ctx, t.db);
    expect(await getEmployee(request({ cookies: active.cookies, now: start + 12 * HOUR - MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await getEmployee(request({ cookies: active.cookies, now: start + 12 * HOUR }).ctx, t.db)).toBeNull();

    const idle = await signIn(OWNER.email, OWNER.password, { now: start });
    expect(await getEmployee(request({ cookies: idle.cookies, now: start + 2 * HOUR + MINUTE }).ctx, t.db)).toBeNull();
  });

  test("sessions can be listed and revoked; sign-out ends the session", async () => {
    const start = NOW + 20 * HOUR;
    const laptop = await signIn(OWNER.email, OWNER.password, { now: start });
    const phone = await signIn(OWNER.email, OWNER.password, { now: start + MINUTE });
    const laptopSession = await getEmployee(request({ cookies: laptop.cookies, now: start + 2 * MINUTE }).ctx, t.db);
    const phoneSession = await getEmployee(request({ cookies: phone.cookies, now: start + 2 * MINUTE }).ctx, t.db);
    expect(laptopSession && phoneSession).toBeTruthy();

    const listed = await listEmployeeSessions(t.db, ownerId, start + 2 * MINUTE, laptopSession!.session.id);
    expect(listed.map((session) => session.id)).toEqual(expect.arrayContaining([laptopSession!.session.id, phoneSession!.session.id]));
    expect(listed.filter((session) => session.current).map((session) => session.id)).toEqual([laptopSession!.session.id]);
    expect(JSON.stringify(listed)).not.toContain(laptop.cookies.tt_adm);

    // Revoking takes effect on the very next request.
    expect(await revokeEmployeeSession(t.db, laptopSession!.actor, { employeeId: ownerId, sessionId: phoneSession!.session.id }, start + 3 * MINUTE)).toBe(true);
    expect(await getEmployee(request({ cookies: phone.cookies, now: start + 3 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: laptop.cookies, now: start + 3 * MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await revokeEmployeeSession(t.db, laptopSession!.actor, { employeeId: ownerId, sessionId: phoneSession!.session.id }, start + 3 * MINUTE)).toBe(false);
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'security.session.revoke' AND entity_id = ?", ownerId)).toBe(1);

    // Someone else's session needs the permission.
    const cashier = await employeeWithRole("cashier");
    const cashierSignIn = await signIn(cashier.email, cashier.password, { now: start });
    const cashierSession = await getEmployee(request({ cookies: cashierSignIn.cookies, now: start + MINUTE }).ctx, t.db);
    expect(await failure(() => revokeEmployeeSession(t.db, cashierSession!.actor, { employeeId: ownerId, sessionId: laptopSession!.session.id }, start + 4 * MINUTE))).toMatchObject({ code: "forbidden", detail: "security.session.revoke" });

    const signOut = request({ cookies: laptop.cookies, now: start + 5 * MINUTE });
    await signOutEmployee(signOut.ctx, t.db);
    expect(signOut.setCookies.map(parseSetCookie).every((cookie) => cookie.attributes["max-age"] === "0")).toBe(true);
    expect(await getEmployee(signOut.ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: laptop.cookies, now: start + 6 * MINUTE }).ctx, t.db)).toBeNull();
  });

  test("disabling an employee locks them out immediately and ends their sessions", async () => {
    const start = NOW + 40 * HOUR;
    const leaving = await employeeWithRole("fulfillment");
    const theirs = await signIn(leaving.email, leaving.password, { now: start });
    expect(await getEmployee(request({ cookies: theirs.cookies, now: start + MINUTE }).ctx, t.db)).not.toBeNull();

    const owner = await signIn(OWNER.email, OWNER.password, { now: start });
    const ownerSession = await getEmployee(request({ cookies: owner.cookies, now: start + MINUTE }).ctx, t.db);

    // Not without the permission, not without a reason, not yourself, not the last owner.
    const manager = roleActor("manager");
    expect(await failure(() => disableEmployee(t.db, manager, { employeeId: leaving.id, reason: "انتهت خدمته" }, start + MINUTE))).toMatchObject({ code: "forbidden", detail: "staff.manage" });
    expect(await failure(() => disableEmployee(t.db, ownerSession!.actor, { employeeId: leaving.id, reason: " " }, start + MINUTE))).toMatchObject({ code: "invalid", fields: { reason: "required" } });
    expect(await failure(() => disableEmployee(t.db, ownerSession!.actor, { employeeId: ownerId, reason: "اختبار" }, start + MINUTE))).toMatchObject({ code: "cannot_disable_self", status: 409 });
    expect(await failure(() => disableEmployee(t.db, systemActor("test"), { employeeId: ownerId, reason: "اختبار" }, start + MINUTE))).toMatchObject({ code: "last_owner", status: 409 });
    expect(await scalar("SELECT status FROM employees WHERE id = ?", ownerId)).toBe("active");

    // Even if a session row were left untouched, the status check alone locks the account.
    await t.db.update(employees).set({ status: "disabled" }).where(eq(employees.id, leaving.id));
    expect(await getEmployee(request({ cookies: theirs.cookies, now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    await t.db.update(employees).set({ status: "active" }).where(eq(employees.id, leaving.id));
    expect(await getEmployee(request({ cookies: theirs.cookies, now: start + 2 * MINUTE }).ctx, t.db)).not.toBeNull();

    await disableEmployee(t.db, ownerSession!.actor, { employeeId: leaving.id, reason: "انتهت خدمته" }, start + 3 * MINUTE);
    expect(await getEmployee(request({ cookies: theirs.cookies, now: start + 3 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await scalar("SELECT count(*) FROM employee_sessions WHERE employee_id = ? AND revoked_at IS NULL", leaving.id)).toBe(0);
    expect(await t.db.select().from(employees).where(eq(employees.id, leaving.id)).get()).toMatchObject({ status: "disabled", disabledAt: start + 3 * MINUTE });
    expect(await failure(() => signInEmployee(request({ now: start + 4 * MINUTE }).ctx, t.db, { email: leaving.email, password: leaving.password }))).toMatchObject({ code: "invalid_credentials" });

    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "staff.employee.disable"), eq(auditEvents.entityId, leaving.id))).get();
    expect(event).toMatchObject({ actorKind: "employee", actorId: ownerId, actorLabel: "صاحب المتجر", reason: "انتهت خدمته", before: { status: "active" }, after: { status: "disabled" } });
    expect(await failure(() => disableEmployee(t.db, ownerSession!.actor, { employeeId: leaving.id, reason: "مرة أخرى" }, start + 5 * MINUTE))).toMatchObject({ code: "employee_not_active" });
  });

  test("changing the password signs other devices out, moves this one to a new token and is audited", async () => {
    const start = NOW + 60 * HOUR;
    const person = await employeeWithRole("support", "first-password-123");
    const here = await signIn(person.email, person.password, { now: start });
    const elsewhere = await signIn(person.email, person.password, { now: start });

    const change = request({ cookies: here.cookies, now: start + MINUTE });
    expect(await failure(() => changeEmployeePassword(change.ctx, t.db, { currentPassword: "not-it", newPassword: "second-password-456" }))).toMatchObject({ code: "invalid", fields: { currentPassword: "invalid_credentials" } });
    expect(await failure(() => changeEmployeePassword(change.ctx, t.db, { currentPassword: person.password, newPassword: "short" }))).toMatchObject({ code: "invalid", fields: { newPassword: "password_too_short" } });
    expect(await failure(() => changeEmployeePassword(request().ctx, t.db, { currentPassword: "x", newPassword: "second-password-456" }))).toMatchObject({ code: "unauthorized", status: 401 });
    expect(change.setCookies).toEqual([]);

    await changeEmployeePassword(change.ctx, t.db, { currentPassword: person.password, newPassword: "second-password-456" });
    // This device carries on with the cookie the change set; the cookie it had before (and any copy of it) is dead.
    expect(await getEmployee(request({ cookies: cookiesAfter(change, here.cookies), now: start + 2 * MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await getEmployee(request({ cookies: here.cookies, now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: elsewhere.cookies, now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await failure(() => signInEmployee(request({ now: start + 3 * MINUTE }).ctx, t.db, { email: person.email, password: person.password }))).toMatchObject({ code: "invalid_credentials" });
    expect((await signIn(person.email, "second-password-456", { now: start + 3 * MINUTE })).result.status).toBe("signed_in");
    expect(await scalar("SELECT password_changed_at FROM employees WHERE id = ?", person.id)).toBe(start + MINUTE);
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "security.password.change"), eq(auditEvents.entityId, person.id))).get();
    expect(JSON.stringify(event)).not.toContain("second-password-456");
  });

  test("two-step verification: enrol, sign in with a code, replay refused, recovery codes work once", async () => {
    const start = NOW + 80 * HOUR;
    const person = await employeeWithRole("finance", "finance-password-123");
    const first = await signIn(person.email, person.password, { now: start });
    const enrolRequest = request({ cookies: first.cookies, now: start + MINUTE });

    // Enrolment: the secret is stored encrypted and is not active until a code proves the app has it.
    const enrolment = await beginTotpEnrollment(enrolRequest.ctx, t.db, secrets);
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);
    expect(enrolment.uri).toContain(encodeURIComponent(person.email));
    const pendingRow = await t.db.select().from(employees).where(eq(employees.id, person.id)).get();
    expect(pendingRow?.totpEnabled).toBe(false);
    expect(pendingRow?.totpSecretEnc).toMatch(/^v1\./);
    expect(pendingRow?.totpSecretEnc).not.toContain(enrolment.secret);
    expect(await decryptSecret(pendingRow!.totpSecretEnc!, DATA_KEY, `employee:${person.id}:totp`)).toBe(enrolment.secret);

    expect(await failure(() => confirmTotpEnrollment(enrolRequest.ctx, t.db, { code: "000000" }, secrets))).toMatchObject({ code: "mfa_invalid", status: 401, fields: { code: "mfa_invalid" } });
    const elsewhere = await signIn(person.email, person.password, { now: start + MINUTE });
    const confirmed = await confirmTotpEnrollment(enrolRequest.ctx, t.db, { code: await totpCode(enrolment.secret, start + MINUTE) }, secrets);
    expect(confirmed.recoveryCodes).toHaveLength(10);
    const enabledRow = await t.db.select().from(employees).where(eq(employees.id, person.id)).get();
    expect(enabledRow?.totpEnabled).toBe(true);
    expect(enabledRow?.recoveryCodes).toHaveLength(10);
    expect(JSON.stringify(enabledRow?.recoveryCodes)).not.toContain(confirmed.recoveryCodes[0]);
    // The enrolling device stays signed in — on the new token the confirmation set (its old cookie is dead); the other
    // device must prove the second factor.
    const enrolledCookies = cookiesAfter(enrolRequest, first.cookies);
    expect(enrolledCookies.tt_adm).not.toBe(first.cookies.tt_adm);
    expect(await getEmployee(request({ cookies: enrolledCookies, now: start + 2 * MINUTE }).ctx, t.db)).toMatchObject({ session: { mfaOk: true } });
    expect(await getEmployee(request({ cookies: first.cookies, now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: elsewhere.cookies, now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await failure(() => beginTotpEnrollment(request({ cookies: enrolledCookies, now: start + 2 * MINUTE }).ctx, t.db, secrets))).toMatchObject({ code: "mfa_already_enabled" });
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'security.mfa.enable' AND entity_id = ?", person.id)).toBe(1);

    // Sign-in now stops after the password.
    const second = await signIn(person.email, person.password, { now: start + 10 * MINUTE });
    expect(second.result).toEqual({ status: "mfa_required", expiresAt: start + 20 * MINUTE });
    const halfOpen = request({ cookies: second.cookies, now: start + 10 * MINUTE });
    expect(await getEmployee(halfOpen.ctx, t.db)).toBeNull();
    expect(await getPendingMfa(halfOpen.ctx, t.db)).toMatchObject({ employeeId: person.id, email: person.email });
    expect(((await thrown(() => requireEmployee(halfOpen.ctx, t.db))) as Response).status).toBe(302);
    expect(await scalar("SELECT last_login_at FROM employees WHERE id = ?", person.id)).toBe(start + MINUTE);

    expect(await failure(() => verifyEmployeeMfa(request({ cookies: second.cookies, now: start + 10 * MINUTE }).ctx, t.db, { code: "123 456" }, secrets))).toMatchObject({ code: "mfa_invalid" });
    expect(await failure(() => verifyEmployeeMfa(request({ now: start + 10 * MINUTE }).ctx, t.db, { code: "123456" }, secrets))).toMatchObject({ code: "unauthorized" });

    const goodCode = await totpCode(enrolment.secret, start + 10 * MINUTE);
    const verifyRequest = request({ cookies: second.cookies, now: start + 10 * MINUTE });
    const full = await verifyEmployeeMfa(verifyRequest.ctx, t.db, { code: goodCode }, secrets);
    expect(full.employee.id).toBe(person.id);
    expect(full.session.mfaOk).toBe(true);
    expect(can(full.actor, "finance.period.close")).toBe(true);
    // The token changes when the session becomes a full one, and the half-open one is dead.
    const fullCookies = cookiesAfter(verifyRequest, second.cookies);
    expect(fullCookies.tt_adm).not.toBe(second.cookies.tt_adm);
    expect(await getEmployee(request({ cookies: fullCookies, now: start + 11 * MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await getEmployee(request({ cookies: second.cookies, now: start + 11 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getPendingMfa(request({ cookies: second.cookies, now: start + 11 * MINUTE }).ctx, t.db)).toBeNull();

    // Replay: the same code, still inside its 30 seconds, does not open a second session.
    const third = await signIn(person.email, person.password, { now: start + 10 * MINUTE + 5000 });
    expect(await failure(() => verifyEmployeeMfa(request({ cookies: third.cookies, now: start + 10 * MINUTE + 5000 }).ctx, t.db, { code: goodCode }, secrets))).toMatchObject({ code: "mfa_invalid" });

    // A recovery code works, once.
    const recovery = confirmed.recoveryCodes[4];
    const viaRecovery = await verifyEmployeeMfa(request({ cookies: third.cookies, now: start + 10 * MINUTE + 6000 }).ctx, t.db, { code: recovery.toLowerCase() }, secrets);
    expect(viaRecovery.recoveryCodesLeft).toBe(9);
    const fourth = await signIn(person.email, person.password, { now: start + 12 * MINUTE });
    expect(await failure(() => verifyEmployeeMfa(request({ cookies: fourth.cookies, now: start + 12 * MINUTE }).ctx, t.db, { code: recovery }, secrets))).toMatchObject({ code: "mfa_invalid" });
    expect((await t.db.select().from(employees).where(eq(employees.id, person.id)).get())?.recoveryCodes).toHaveLength(9);

    // A half-open session lasts ten minutes.
    expect(await getPendingMfa(request({ cookies: fourth.cookies, now: start + 22 * MINUTE }).ctx, t.db)).toBeNull();

    // Too many wrong codes end the half-open session: the password is needed again.
    const fifth = await signIn(person.email, person.password, { now: start + 30 * MINUTE });
    let lastError: AppError | null = null;
    for (let attempt = 0; attempt < RATE_LIMITS.mfaVerify.limit + 1; attempt++) {
      lastError = await failure(() => verifyEmployeeMfa(request({ cookies: fifth.cookies, now: start + 30 * MINUTE }).ctx, t.db, { code: "000000" }, secrets));
    }
    expect(lastError).toMatchObject({ code: "rate_limited", status: 429 });
    expect(await getPendingMfa(request({ cookies: fifth.cookies, now: start + 30 * MINUTE }).ctx, t.db)).toBeNull();

    // An administrator with security.mfa.manage can reset it (lost phone); the employee is signed out.
    expect(await failure(() => resetEmployeeMfa(t.db, roleActor("manager"), { employeeId: person.id, reason: "فقد هاتفه" }, start + HOUR))).toMatchObject({ code: "forbidden", detail: "security.mfa.manage" });
    await resetEmployeeMfa(t.db, roleActor("owner"), { employeeId: person.id, reason: "فقد هاتفه" }, start + HOUR);
    expect(await t.db.select().from(employees).where(eq(employees.id, person.id)).get()).toMatchObject({ totpEnabled: false, totpSecretEnc: null, recoveryCodes: null });
    expect(await getEmployee(request({ cookies: fullCookies, now: start + HOUR }).ctx, t.db)).toBeNull();
    expect((await signIn(person.email, person.password, { now: start + HOUR + MINUTE })).result.status).toBe("signed_in");
    expect(await failure(() => resetEmployeeMfa(t.db, roleActor("owner"), { employeeId: "emp_missing", reason: "اختبار" }, start + HOUR))).toMatchObject({ code: "not_found" });
  });

  test("safe redirect targets", () => {
    expect(safeNextPath("/admin/orders?x=1#top", "/admin", "/admin")).toBe("/admin/orders?x=1#top");
    expect(safeNextPath("/admin", "/fallback", "/admin")).toBe("/admin");
    for (const bad of ["//evil.example", "https://evil.example/admin", "/\\evil.example", "javascript:alert(1)", "admin/orders", "", null, undefined, 42, "/account", "/administrator", "/admin/../account", `/admin/${"x".repeat(600)}`, "/admin\nSet-Cookie: x=1"]) {
      expect(safeNextPath(bad, "/admin", "/admin"), String(bad)).toBe("/admin");
    }
    expect(safeNextPath("/account/orders", "/")).toBe("/account/orders");
    expect(safeNextPath("//evil.example", "/")).toBe("/");
  });
});

// ───────────────────────────────────────────────────────────────── customer sessions

describe("customer authentication", () => {
  const PHONE = "+9647701000001";
  const PASSWORD = "customer-pass-1";

  test("sign-up creates the account, hashes the password and starts a session", async () => {
    const req = request({ isHttps: true });
    const session = await signUpCustomer(req.ctx, t.db, { phone: "٠٧٧٠ ١٠٠ ٠٠٠١", password: PASSWORD, name: " نور " });
    expect(session.customer).toMatchObject({ phoneE164: PHONE, phoneMasked: maskPhone(PHONE), phoneVerified: false, name: "نور", locale: "ar" });
    expect(session.actor).toMatchObject({ kind: "customer", id: session.customer.id, ip: req.ctx.ip, requestId: req.ctx.requestId });

    const cookie = parseSetCookie(req.setCookies[0]);
    expect(req.setCookies).toHaveLength(1);
    expect(cookie.name).toBe(CUSTOMER_COOKIE);
    expect(cookie.name).toBe("tt_sid");
    expect(cookie.attributes).toMatchObject({ httponly: true, samesite: "Lax", secure: true, path: "/", "max-age": String(30 * 24 * 60 * 60) });

    const row = await t.db.select().from(customers).where(eq(customers.phoneE164, PHONE)).get();
    expect(row?.passwordHash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row).toMatchObject({ passwordIters: 100_000, status: "active", phoneVerifiedAt: null, isDemo: false });
    const stored = await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, row!.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ idHash: await sha256Hex(cookie.value), expiresAt: NOW + 30 * DAY, revokedAt: null });
    expect(JSON.stringify(stored)).not.toContain(cookie.value);
    // Within the same request the new session is already the answer.
    expect((await getCustomer(req.ctx, t.db))?.customer.id).toBe(row!.id);
  });

  test("sign-up validation: phone, password, duplicate number", async () => {
    expect(await failure(() => signUpCustomer(request().ctx, t.db, { phone: "12345", password: PASSWORD }))).toMatchObject({ code: "invalid", fields: { phone: "phone_invalid" } });
    expect(await failure(() => signUpCustomer(request().ctx, t.db, { phone: "07701000002", password: "short" }))).toMatchObject({ code: "invalid", fields: { password: "password_too_short" } });
    expect(await failure(() => signUpCustomer(request().ctx, t.db, { password: PASSWORD }))).toMatchObject({ code: "invalid", fields: { phone: "required" } });
    const taken = request();
    expect(await failure(() => signUpCustomer(taken.ctx, t.db, { phone: "07701000001", password: "another-password" }))).toMatchObject({ code: "phone_taken", status: 409, fields: { phone: "phone_taken" } });
    expect(taken.setCookies).toEqual([]);
    expect(await scalar("SELECT count(*) FROM customers WHERE phone_e164 = ?", PHONE)).toBe(1);
    expect(await scalar("SELECT count(*) FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id WHERE c.phone_e164 = ?", PHONE)).toBe(1);
  });

  test("sign-in: wrong password and unknown number fail the same way; success starts a new session", async () => {
    const wrong = await failure(() => signInCustomer(request().ctx, t.db, { phone: "07701000001", password: "wrong-password" }));
    const unknown = await failure(() => signInCustomer(request().ctx, t.db, { phone: "07701999999", password: PASSWORD }));
    expect(wrong).toMatchObject({ code: "invalid_credentials", status: 401, fields: { password: "invalid_credentials" } });
    expect({ code: unknown.code, status: unknown.status, fields: unknown.fields }).toEqual({ code: wrong.code, status: wrong.status, fields: wrong.fields });
    expect(await failure(() => signInCustomer(request().ctx, t.db, { phone: "not a phone", password: PASSWORD }))).toMatchObject({ code: "invalid", fields: { phone: "phone_invalid" } });

    const req = request({ now: NOW + MINUTE });
    const session = await signInCustomer(req.ctx, t.db, { phone: "0770 100 0001", password: PASSWORD });
    expect(session.customer.phoneE164).toBe(PHONE);
    const next = request({ cookies: cookiesAfter(req), now: NOW + 2 * MINUTE });
    const found = await getCustomer(next.ctx, t.db);
    expect(found?.customer).toMatchObject({ id: session.customer.id, phoneMasked: "0770 ••• ••01" });
    expect(await getCustomer(next.ctx, t.db)).toBe(found);
    expect((await requireCustomer(next.ctx, t.db)).customer.id).toBe(session.customer.id);
    expect(next.setCookies).toEqual([]);
    expect(await scalar("SELECT last_login_at FROM customers WHERE phone_e164 = ?", PHONE)).toBe(NOW + MINUTE);
  });

  test("guests: getCustomer is null and requireCustomer redirects to the sign-in page in their language", async () => {
    const jars: Record<string, string>[] = [{}, { tt_sid: "garbage" }, { tt_sid: randomToken() }];
    for (const cookies of jars) {
      expect(await getCustomer(request({ cookies }).ctx, t.db)).toBeNull();
    }
    const arabic = (await thrown(() => requireCustomer(request().ctx, t.db, { next: "/account/orders" }))) as Response;
    expect(arabic).toBeInstanceOf(Response);
    expect(arabic.status).toBe(302);
    expect(arabic.headers.get("Location")).toBe("/account/login?next=%2Faccount%2Forders");
    const english = request();
    english.ctx.locale = "en";
    expect(((await thrown(() => requireCustomer(english.ctx, t.db))) as Response).headers.get("Location")).toBe("/en/account/login");
    expect(((await thrown(() => requireCustomer(request().ctx, t.db, { next: "https://evil.example" }))) as Response).headers.get("Location")).toBe("/account/login");
  });

  test("the 30-day expiry slides with use, at most once an hour, and ends without it", async () => {
    const start = NOW + DAY;
    const signIn = request({ now: start });
    await signInCustomer(signIn.ctx, t.db, { phone: PHONE, password: PASSWORD });
    const cookies = cookiesAfter(signIn);
    const idHash = await sha256Hex(cookies.tt_sid);
    const expiry = () => scalar("SELECT expires_at FROM customer_sessions WHERE id_hash = ?", idHash);

    // Within the hour: read-only.
    const soon = request({ cookies, now: start + 30 * MINUTE });
    expect(await getCustomer(soon.ctx, t.db)).not.toBeNull();
    expect(soon.setCookies).toEqual([]);
    expect(await expiry()).toBe(start + 30 * DAY);

    // After an hour: the expiry moves and the cookie is renewed.
    const later = request({ cookies, now: start + 2 * HOUR });
    expect((await getCustomer(later.ctx, t.db))?.session.expiresAt).toBe(start + 2 * HOUR + 30 * DAY);
    expect(await expiry()).toBe(start + 2 * HOUR + 30 * DAY);
    expect(parseSetCookie(later.setCookies[0])).toMatchObject({ name: "tt_sid", value: cookies.tt_sid, attributes: { "max-age": String(30 * 24 * 60 * 60) } });

    // Used on day 29, it lives on; left alone for 30 days after that, it is over and the cookie is cleared.
    expect(await getCustomer(request({ cookies, now: start + 29 * DAY }).ctx, t.db)).not.toBeNull();
    expect(await getCustomer(request({ cookies, now: start + 58 * DAY }).ctx, t.db)).not.toBeNull();
    const expired = request({ cookies, now: start + 58 * DAY + 30 * DAY });
    expect(await getCustomer(expired.ctx, t.db)).toBeNull();
    expect(parseSetCookie(expired.setCookies[0]).attributes["max-age"]).toBe("0");
  });

  test("sessions: list, revoke one, revoke all others, sign out", async () => {
    const start = NOW + 100 * DAY;
    const devices: { cookies: Record<string, string>; session: Awaited<ReturnType<typeof signInCustomer>> }[] = [];
    for (let i = 0; i < 3; i++) {
      const req = request({ now: start + i * MINUTE });
      const session = await signInCustomer(req.ctx, t.db, { phone: PHONE, password: PASSWORD });
      devices.push({ cookies: cookiesAfter(req), session });
    }
    const [laptop, phone, tablet] = devices;
    const customerId = laptop.session.customer.id;
    const at = start + 10 * MINUTE;
    const alive = async (device: (typeof devices)[number]) => (await getCustomer(request({ cookies: device.cookies, now: at }).ctx, t.db)) !== null;

    const listed = await listCustomerSessions(t.db, customerId, at, laptop.session.session.id);
    expect(listed.map((session) => session.id)).toEqual(expect.arrayContaining(devices.map((device) => device.session.session.id)));
    expect(listed.filter((session) => session.current)).toHaveLength(1);

    // Another customer cannot revoke it; the owner can, once.
    expect(await revokeCustomerSession(t.db, "cus_someone_else", phone.session.session.id, at)).toBe(false);
    expect(await alive(phone)).toBe(true);
    expect(await revokeCustomerSession(t.db, customerId, phone.session.session.id, at)).toBe(true);
    expect(await revokeCustomerSession(t.db, customerId, phone.session.session.id, at)).toBe(false);
    expect(await alive(phone)).toBe(false);
    expect(await alive(laptop)).toBe(true);

    expect(await revokeAllCustomerSessions(t.db, customerId, at, laptop.session.session.id)).toBeGreaterThanOrEqual(1);
    expect(await alive(tablet)).toBe(false);
    expect(await alive(laptop)).toBe(true);

    const signOut = request({ cookies: laptop.cookies, now: at });
    await signOutCustomer(signOut.ctx, t.db);
    expect(parseSetCookie(signOut.setCookies[0]).attributes["max-age"]).toBe("0");
    expect(await getCustomer(signOut.ctx, t.db)).toBeNull();
    expect(await alive(laptop)).toBe(false);
    expect(await scalar("SELECT count(*) FROM customer_sessions WHERE customer_id = ? AND revoked_at IS NULL AND expires_at > ?", customerId, at)).toBe(0);
    await signOutCustomer(request({ now: at }).ctx, t.db);
  });

  test("changing the password keeps this device (on a new token) and signs the others out", async () => {
    const start = NOW + 120 * DAY;
    const here = request({ now: start });
    await signInCustomer(here.ctx, t.db, { phone: PHONE, password: PASSWORD });
    const there = request({ now: start });
    await signInCustomer(there.ctx, t.db, { phone: PHONE, password: PASSWORD });

    const change = request({ cookies: cookiesAfter(here), now: start + MINUTE });
    expect(await failure(() => changeCustomerPassword(change.ctx, t.db, { currentPassword: "nope", newPassword: "new-customer-pass" }))).toMatchObject({ code: "invalid", fields: { currentPassword: "invalid_credentials" } });
    expect(await failure(() => changeCustomerPassword(request().ctx, t.db, { currentPassword: PASSWORD, newPassword: "new-customer-pass" }))).toMatchObject({ code: "unauthorized" });
    await changeCustomerPassword(change.ctx, t.db, { currentPassword: PASSWORD, newPassword: "new-customer-pass" });

    // This device carries on with the cookie the change set; the one it had before (and any copy of it) is dead.
    expect(await getCustomer(request({ cookies: cookiesAfter(change, cookiesAfter(here)), now: start + 2 * MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await getCustomer(request({ cookies: cookiesAfter(here), now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getCustomer(request({ cookies: cookiesAfter(there), now: start + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await failure(() => signInCustomer(request({ now: start + 3 * MINUTE }).ctx, t.db, { phone: PHONE, password: PASSWORD }))).toMatchObject({ code: "invalid_credentials" });
    await signInCustomer(request({ now: start + 3 * MINUTE }).ctx, t.db, { phone: PHONE, password: "new-customer-pass" });
  });

  test("a blocked account cannot sign in and its sessions stop working at once", async () => {
    const start = NOW + 140 * DAY;
    const phone = "+9647701000077";
    const signUp = request({ now: start });
    const session = await signUpCustomer(signUp.ctx, t.db, { phone, password: PASSWORD });
    const cookies = cookiesAfter(signUp);
    expect(await getCustomer(request({ cookies, now: start + MINUTE }).ctx, t.db)).not.toBeNull();

    await t.db.update(customers).set({ status: "blocked" }).where(eq(customers.id, session.customer.id));
    expect(await getCustomer(request({ cookies, now: start + MINUTE }).ctx, t.db)).toBeNull();
    expect(await failure(() => signInCustomer(request({ now: start + MINUTE }).ctx, t.db, { phone, password: PASSWORD }))).toMatchObject({ code: "account_blocked", status: 403 });
    // The wrong password still says nothing about the account.
    expect(await failure(() => signInCustomer(request({ now: start + MINUTE }).ctx, t.db, { phone, password: "wrong-password" }))).toMatchObject({ code: "invalid_credentials" });
  });

  test("sign-in attempts are limited per phone number", async () => {
    const start = NOW + 160 * DAY;
    const phone = "07701000088";
    for (let attempt = 0; attempt < RATE_LIMITS.signIn.limit; attempt++) {
      expect(await failure(() => signInCustomer(request({ now: start }).ctx, t.db, { phone, password: `guess-${attempt}` }))).toMatchObject({ code: "invalid_credentials" });
    }
    const limited = await failure(() => signInCustomer(request({ now: start }).ctx, t.db, { phone, password: "one more" }));
    expect(limited).toMatchObject({ code: "rate_limited", status: 429 });
    expect(limited.retryAfterSec).toBeGreaterThan(0);
    expect(limited.retryAfterSec).toBeLessThanOrEqual(RATE_LIMITS.signIn.windowSec);
    // The table holds a hash of the number, not the number.
    const keys = (await t.db.select({ key: rateLimits.key }).from(rateLimits)).map((row) => row.key).join("\n");
    expect(keys).not.toContain("7701000088");
  });

  describe("one-time codes", () => {
    const OTP_PHONE = "+9647702000001";
    const options = { secret: SESSION_SECRET };

    test("a requested code is stored hashed, held in the outbox, and shown only in development", async () => {
      const start = NOW + 200 * DAY;
      const dev = request({ now: start, isDev: true });
      const sent = await requestOtp(dev.ctx, t.db, { phone: "0770 200 0001", purpose: "verify_phone" }, options);
      expect(sent).toMatchObject({ phoneE164: OTP_PHONE, expiresAt: start + 5 * MINUTE, delivery: "held" });
      expect(sent.devCode).toMatch(/^\d{6}$/);

      const row = await t.db.select().from(otpCodes).where(eq(otpCodes.id, sent.id)).get();
      expect(row).toMatchObject({ phoneE164: OTP_PHONE, purpose: "verify_phone", attempts: 0, consumedAt: null, expiresAt: start + 5 * MINUTE });
      expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.codeHash).not.toContain(sent.devCode!);
      // Not a bare hash of the code: without the server secret the stored value cannot be brute-forced.
      expect(row?.codeHash).not.toBe(await sha256Hex(sent.devCode!));
      expect(row?.codeHash).not.toBe(await sha256Hex(`tamtam.otp.v1|${sent.id}|${OTP_PHONE}|verify_phone|${sent.devCode}`));

      const message = await t.db.select().from(outbox).where(eq(outbox.refId, sent.id)).get();
      expect(message).toMatchObject({ channel: "sms", recipient: OTP_PHONE, template: "otp", status: "held", sentAt: null, attempts: 0 });
      // The stored message says a code was requested — it does not contain the code.
      expect(message?.payload).toEqual({ purpose: "verify_phone", expiresAt: start + 5 * MINUTE });

      // Production: same behaviour, but the code never leaves the server.
      const production = request({ now: start + 20 * MINUTE, isDev: false });
      const live = await requestOtp(production.ctx, t.db, { phone: OTP_PHONE, purpose: "verify_phone" }, options);
      expect(live.delivery).toBe("held");
      expect("devCode" in live).toBe(false);
      expect(Object.keys(live).sort()).toEqual(["delivery", "expiresAt", "id", "phoneE164"]);
    });

    test("verification: the right code works once, for its phone and purpose only", async () => {
      const start = NOW + 201 * DAY;
      const phone = "+9647702000002";
      const sent = await requestOtp(request({ now: start }).ctx, t.db, { phone, purpose: "order_lookup", ref: "TT-7K4M2Q9X" }, options);
      const code = sent.devCode!;
      const wrongCode = code === "000000" ? "000001" : "000000";
      const check = (input: Partial<Parameters<typeof verifyOtp>[2]>, at = start + MINUTE, opts = options) => verifyOtp(request({ now: at }).ctx, t.db, { phone, purpose: "order_lookup", code, id: sent.id, ...input }, opts);

      expect(await failure(() => check({ code: wrongCode }))).toMatchObject({ code: "otp_invalid", status: 400, fields: { code: "otp_invalid" } });
      expect(await failure(() => check({ purpose: "login" }))).toMatchObject({ code: "otp_invalid" });
      expect(await failure(() => check({ phone: "+9647702000003" }))).toMatchObject({ code: "otp_invalid" });
      expect(await failure(() => check({ code: "12345" }))).toMatchObject({ code: "otp_invalid" });
      expect(await failure(() => check({}, start + MINUTE, { secret: randomToken(48) }))).toMatchObject({ code: "otp_invalid" });
      expect(await failure(() => check({ phone: "not a phone" }))).toMatchObject({ code: "invalid", fields: { phone: "phone_invalid" } });

      expect(await check({})).toEqual({ id: sent.id, phoneE164: phone, purpose: "order_lookup", ref: "TT-7K4M2Q9X" });
      expect(await failure(() => check({}))).toMatchObject({ code: "otp_invalid" });
      expect(await scalar("SELECT consumed_at FROM otp_codes WHERE id = ?", sent.id)).toBe(start + MINUTE);
    });

    test("codes expire after five minutes and lock after five wrong guesses", async () => {
      const start = NOW + 202 * DAY;
      const phone = "+9647702000004";
      const first = await requestOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login" }, options);
      expect(await failure(() => verifyOtp(request({ now: start + 5 * MINUTE }).ctx, t.db, { phone, purpose: "login", code: first.devCode!, id: first.id }, options))).toMatchObject({ code: "otp_invalid" });

      const second = await requestOtp(request({ now: start + 20 * MINUTE }).ctx, t.db, { phone, purpose: "login" }, options);
      const wrong = second.devCode === "111111" ? "222222" : "111111";
      for (let guess = 0; guess < 5; guess++) {
        expect(await failure(() => verifyOtp(request({ now: start + 21 * MINUTE }).ctx, t.db, { phone, purpose: "login", code: wrong }, options))).toMatchObject({ code: "otp_invalid" });
      }
      expect(await scalar("SELECT attempts FROM otp_codes WHERE id = ?", second.id)).toBe(5);
      // The right code no longer helps.
      expect(await failure(() => verifyOtp(request({ now: start + 21 * MINUTE }).ctx, t.db, { phone, purpose: "login", code: second.devCode! }, options))).toMatchObject({ code: "otp_invalid" });
      expect(await scalar("SELECT attempts FROM otp_codes WHERE id = ?", second.id)).toBe(5);
    });

    test("a new request cancels the previous code; requests are limited per phone", async () => {
      const start = NOW + 203 * DAY;
      const phone = "+9647702000005";
      const first = await requestOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login" }, options);
      const second = await requestOtp(request({ now: start + 1000 }).ctx, t.db, { phone, purpose: "login" }, options);
      expect(await failure(() => verifyOtp(request({ now: start + 2000 }).ctx, t.db, { phone, purpose: "login", code: first.devCode!, id: first.id }, options))).toMatchObject({ code: "otp_invalid" });
      // Without an id the newest code is the one that counts.
      expect((await verifyOtp(request({ now: start + 3000 }).ctx, t.db, { phone, purpose: "login", code: second.devCode! }, options)).id).toBe(second.id);

      await requestOtp(request({ now: start + 4000 }).ctx, t.db, { phone, purpose: "login" }, options);
      const limited = await failure(() => requestOtp(request({ now: start + 5000 }).ctx, t.db, { phone, purpose: "login" }, options));
      expect(limited).toMatchObject({ code: "rate_limited", status: 429 });
      expect(await scalar("SELECT count(*) FROM otp_codes WHERE phone_e164 = ?", phone)).toBe(3);
      expect(await failure(() => requestOtp(request().ctx, t.db, { phone: "123", purpose: "login" }, options))).toMatchObject({ code: "invalid", fields: { phone: "phone_invalid" } });
    });

    test("without SESSION_SECRET a code is neither stored nor checked, and costs no attempt", async () => {
      const start = NOW + 205 * DAY;
      const phone = "+9647702000007";
      for (const secret of [undefined, null, "", "too-short-for-a-key"]) {
        await expect(requestOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login" }, { secret })).rejects.toThrow(/secret/i);
      }
      expect(await scalar("SELECT count(*) FROM otp_codes WHERE phone_e164 = ?", phone)).toBe(0);
      expect(await scalar("SELECT count(*) FROM rate_limits WHERE key = ?", await limitKey("otp", "phone", phone))).toBe(0);

      const sent = await requestOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login" }, options);
      await expect(verifyOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login", code: sent.devCode!, id: sent.id }, { secret: undefined })).rejects.toThrow(/secret/i);
      expect(await scalar("SELECT attempts FROM otp_codes WHERE id = ?", sent.id)).toBe(0);
      expect((await verifyOtp(request({ now: start }).ctx, t.db, { phone, purpose: "login", code: sent.devCode!, id: sent.id }, options)).id).toBe(sent.id);
    });

    test("confirming a code marks the signed-in customer's phone as verified (this device moves to a new token)", async () => {
      const start = NOW + 204 * DAY;
      const phone = "+9647702000006";
      const signUp = request({ now: start });
      const session = await signUpCustomer(signUp.ctx, t.db, { phone, password: PASSWORD });
      expect(session.customer.phoneVerified).toBe(false);
      const cookies = cookiesAfter(signUp);

      const sent = await requestOtp(request({ cookies, now: start + MINUTE }).ctx, t.db, { phone, purpose: "verify_phone" }, options);
      const confirm = request({ cookies, now: start + 2 * MINUTE });
      expect(await failure(() => confirmCustomerPhone(request({ now: start + 2 * MINUTE }).ctx, t.db, { code: sent.devCode! }, options))).toMatchObject({ code: "unauthorized" });
      const verified = await confirmCustomerPhone(confirm.ctx, t.db, { code: sent.devCode!, id: sent.id }, options);
      expect(verified.customer.phoneVerified).toBe(true);
      expect((await getCustomer(confirm.ctx, t.db))?.customer.phoneVerified).toBe(true);
      expect((await getCustomer(request({ cookies: cookiesAfter(confirm, cookies), now: start + 3 * MINUTE }).ctx, t.db))?.customer.phoneVerified).toBe(true);
      expect(await getCustomer(request({ cookies, now: start + 3 * MINUTE }).ctx, t.db)).toBeNull();
      expect(await scalar("SELECT phone_verified_at FROM customers WHERE id = ?", session.customer.id)).toBe(start + 2 * MINUTE);
    });
  });
});

// ───────────────────────────────────────────────────────────────── audit trail

describe("audit trail", () => {
  const staff: EmployeeActor = { kind: "employee", id: "emp_audit", permissions: [], label: "موظفة التدقيق", ip: "203.0.113.77", requestId: "req-audit-1" };

  test("auditStatement is a batch item: stored with the change, or not at all", async () => {
    const variantId = newId("var");
    await t.db.batch([
      t.db.insert(settings).values({ key: `test.audit.${variantId}`, value: 1, updatedAt: NOW }),
      auditStatement(t.db, { actor: staff, action: "inventory.stock.adjust", entityType: "variant", entityId: variantId, reason: "جرد", before: { onHand: 3 }, after: { onHand: 5 }, at: NOW }),
    ]);
    const stored = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, variantId)).get();
    expect(stored).toMatchObject({
      actorKind: "employee",
      actorId: "emp_audit",
      actorLabel: "موظفة التدقيق",
      action: "inventory.stock.adjust",
      entityType: "variant",
      reason: "جرد",
      before: { onHand: 3 },
      after: { onHand: 5 },
      ip: "203.0.113.77",
      requestId: "req-audit-1",
      at: NOW,
    });
    expect(stored?.id).toMatch(/^aud_/);
    expect(stored?.seq).toBeGreaterThan(0);

    // A failing batch leaves no audit event behind.
    const rolledBack = newId("var");
    await expect(
      t.db.batch([
        auditStatement(t.db, { actor: staff, action: "inventory.stock.adjust", entityType: "variant", entityId: rolledBack, at: NOW }),
        t.db.insert(settings).values({ key: `test.audit.${variantId}`, value: 2, updatedAt: NOW }),
      ]),
    ).rejects.toThrow();
    expect(await scalar("SELECT count(*) FROM audit_events WHERE entity_id = ?", rolledBack)).toBe(0);

    const id = await audit(t.db, { actor: systemActor("audit.test"), action: "test.audit.alone", at: NOW, summary: "حدث مستقل" });
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.id, id)).get()).toMatchObject({ actorKind: "system", actorId: "audit.test", actorLabel: "audit.test", summary: "حدث مستقل", before: null, after: null });
    expect(() => auditRow({ actor: GUEST, action: "Not An Action", at: NOW })).toThrow(/module\.resource\.verb/);
  });

  test("secrets are redacted and phone numbers masked before a snapshot is stored", async () => {
    const snapshot = {
      name: "نور",
      phone: "+9647719061852",
      contact: { phoneE164: "07719061852", note: "اتصل على 0771 906 1852 أو ٠٧٧١٩٠٦١٨٥٢ بعد الظهر" },
      password: "hunter2-hunter2",
      passwordHash: "pbkdf2-sha256$100000$abc$def",
      totpSecretEnc: "v1.aaaa.bbbb",
      recoveryCodes: ["rc-hash-one", "rc-hash-two"],
      session: { token: "tok_live_abc", accessTokenHash: "deadbeef" },
      apiKey: "key_live_xyz",
      otp: "918273",
      devCode: "564738",
      card: { cvv: "123", cardNumber: "4111111111111111" },
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      serial: "07712345678",
      sku: "SKU-07701234567",
      totpEnabled: true,
      amountIqd: 749000,
      nothing: null,
      tags: ["vip", "+964 770 123 4567"],
    };
    const redacted = redactForAudit(snapshot) as typeof snapshot;
    const json = JSON.stringify(redacted);
    for (const secret of ["hunter2", "pbkdf2-sha256", "v1.aaaa", "tok_live_abc", "deadbeef", "key_live_xyz", "918273", "564738", "4111111111111111", "rc-hash-one"]) {
      expect(json, secret).not.toContain(secret);
    }
    for (const digits of ["9647719061852", "07719061852", "0771 906 1852", "٠٧٧١٩٠٦١٨٥٢", "770 123 4567"]) expect(json, digits).not.toContain(digits);
    expect(redacted.phone).toBe("0771 ••• ••52");
    expect(redacted.contact.note).toBe("اتصل على 0771 ••• ••52 أو 0771 ••• ••52 بعد الظهر");
    expect(redacted.tags).toEqual(["vip", "0770 ••• ••67"]);
    expect(redacted).toMatchObject({ name: "نور", password: "[redacted]", passwordHash: "[redacted]", totpSecretEnc: "[redacted]", recoveryCodes: "[redacted]", apiKey: "[redacted]", otp: "[redacted]", devCode: "[redacted]", totpEnabled: true, amountIqd: 749000, nothing: null });
    expect(redacted.session).toEqual({ token: "[redacted]", accessTokenHash: "[redacted]" });
    expect(redacted.card).toEqual({ cvv: "[redacted]", cardNumber: "[redacted]" });
    // Not secrets, not phones: file hashes, serials and SKUs stay readable.
    expect(redacted.sha256).toBe(snapshot.sha256);
    expect(redacted.serial).toBe("07712345678");
    expect(redacted.sku).toBe("SKU-07701234567");
    // Public business numbers can be kept on request; secrets cannot.
    expect(redactForAudit({ number: "07719061852", password: "x" }, { phones: false })).toEqual({ number: "07719061852", password: "[redacted]" });

    expect(maskPhonesIn("order 123456789012345 is not a phone")).toBe("order 123456789012345 is not a phone");
    expect(maskPhonesIn("7719061852")).toBe("7719061852");
    expect(redactForAudit(undefined)).toBeNull();
    expect(redactForAudit({ big: "x".repeat(5000) })).toMatchObject({ big: expect.stringMatching(/… \[\+1000 chars\]$/) });
    expect(redactForAudit({ list: Array.from({ length: 300 }, (_, i) => i) })).toMatchObject({ list: expect.arrayContaining(["[+100 more]"]) });
    expect(redactForAudit(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "y".repeat(3000)])))).toMatchObject({ _truncated: true });

    const id = await audit(t.db, { actor: staff, action: "customers.customer.update", entityType: "customer", entityId: "cus_1", before: snapshot, after: { phone: "07719061852" }, reason: "طلب العميل على 07719061852", at: NOW });
    const raw = JSON.stringify(await t.d1.prepare("SELECT before, after, reason FROM audit_events WHERE id = ?").bind(id).first());
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("7719061852");
    expect(raw).toContain("0771 ••• ••52");
  });

  test("the trail is append-only", async () => {
    const id = await audit(t.db, { actor: staff, action: "test.audit.immutable", at: NOW });
    expect(await failure(() => t.db.update(auditEvents).set({ reason: "rewritten" }).where(eq(auditEvents.id, id)))).toMatchObject({ code: "immutable", detail: "audit_events" });
    expect(await failure(() => t.db.delete(auditEvents).where(eq(auditEvents.id, id)))).toMatchObject({ code: "immutable", detail: "audit_events" });
    expect(await scalar("SELECT reason FROM audit_events WHERE id = ?", id)).toBeNull();
    const sealed = await sealAudit(t.db, NOW);
    expect(sealed.seals).toBeGreaterThan(0);
    expect(await failure(() => t.db.update(auditSeals).set({ hash: "0".repeat(64) }))).toMatchObject({ code: "immutable", detail: "audit_seals" });
    expect(await failure(() => t.db.delete(auditSeals))).toMatchObject({ code: "immutable", detail: "audit_seals" });
  });

  test("sealing chains every event; an untouched chain verifies", async () => {
    // Everything written by the tests above is sealed now. Add more events and seal in small steps.
    const before = await verifyAuditChain(t.db);
    expect(before).toMatchObject({ ok: true, problems: [], unsealedEvents: 0 });
    expect(before.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sealAudit(t.db, NOW)).toMatchObject({ seals: 0, events: 0, remaining: false, headHash: before.headHash });

    for (let i = 0; i < 7; i++) await audit(t.db, { actor: staff, action: "test.audit.chain", entityType: "test", entityId: `chain-${i}`, after: { i }, at: NOW + i });
    expect((await verifyAuditChain(t.db)).unsealedEvents).toBe(7);

    const partial = await sealAudit(t.db, NOW + MINUTE, { maxEvents: 3, maxSeals: 2 });
    expect(partial).toMatchObject({ seals: 2, events: 6, remaining: true });
    const rest = await sealAudit(t.db, NOW + MINUTE, { maxEvents: 3 });
    expect(rest).toMatchObject({ seals: 1, events: 1, remaining: false });

    const seals = await t.db.select().from(auditSeals).orderBy(auditSeals.fromSeq);
    expect(seals[0].fromSeq).toBe(1);
    expect(seals[0].prevHash).toBeNull();
    for (let i = 1; i < seals.length; i++) {
      expect(seals[i].fromSeq).toBe(seals[i - 1].toSeq + 1);
      expect(seals[i].prevHash).toBe(seals[i - 1].hash);
      expect(seals[i].hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(seals.at(-1)?.toSeq).toBe(await scalar("SELECT max(seq) FROM audit_events"));

    const report = await verifyAuditChain(t.db);
    expect(report).toMatchObject({ ok: true, problems: [], unsealedEvents: 0, sealsChecked: seals.length, lastSealedSeq: seals.at(-1)?.toSeq, headHash: rest.headHash, nextAfterToSeq: null });
    expect(report.eventsChecked).toBe(await scalar("SELECT count(*) FROM audit_events"));

    // The check can be done in slices.
    const slice = await verifyAuditChain(t.db, { maxSeals: 1 });
    expect(slice).toMatchObject({ ok: true, sealsChecked: 1, nextAfterToSeq: seals[0].toSeq });
    const remainder = await verifyAuditChain(t.db, { afterToSeq: slice.nextAfterToSeq! });
    expect(remainder).toMatchObject({ ok: true, sealsChecked: seals.length - 1, nextAfterToSeq: null });
  });

  test("tampering behind the triggers is detected, seal by seal", async () => {
    const triggers = (await t.d1.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('audit_events', 'audit_seals')").all<{ name: string; sql: string }>()).results;
    expect(triggers.map((trigger) => trigger.name).sort()).toEqual(["audit_events_no_delete", "audit_events_no_replace", "audit_events_no_update", "audit_seals_no_delete", "audit_seals_no_replace", "audit_seals_no_update"]);
    const seals = await t.db.select().from(auditSeals).orderBy(auditSeals.fromSeq);
    const last = seals.at(-1)!;
    const middle = seals.at(-2)!;
    const drop = (name: string) => t.d1.prepare(`DROP TRIGGER ${name}`).run();
    const restore = async (name: string) => {
      await t.d1.prepare(triggers.find((trigger) => trigger.name === name)!.sql).run();
    };

    try {
      // 1. Someone with direct database access edits one sealed event.
      await drop("audit_events_no_update");
      const original = await t.d1.prepare("SELECT after FROM audit_events WHERE seq = ?").bind(middle.fromSeq).first<{ after: string }>();
      await t.d1.prepare("UPDATE audit_events SET after = ? WHERE seq = ?").bind('{"i":999}', middle.fromSeq).run();
      const edited = await verifyAuditChain(t.db);
      expect(edited.ok).toBe(false);
      expect(edited.problems).toEqual([expect.objectContaining({ kind: "seal_hash", sealId: middle.id, fromSeq: middle.fromSeq, toSeq: middle.toSeq })]);

      // Put the exact bytes back: the chain is whole again (the hash covers content, nothing else).
      await t.d1.prepare("UPDATE audit_events SET after = ? WHERE seq = ?").bind(original!.after, middle.fromSeq).run();
      expect((await verifyAuditChain(t.db)).ok).toBe(true);

      // A change that only touches the actor is caught too.
      await t.d1.prepare("UPDATE audit_events SET actor_id = 'emp_someone_else' WHERE seq = ?").bind(last.toSeq).run();
      expect((await verifyAuditChain(t.db)).problems).toEqual([expect.objectContaining({ kind: "seal_hash", sealId: last.id })]);
      await t.d1.prepare("UPDATE audit_events SET actor_id = 'emp_audit' WHERE seq = ?").bind(last.toSeq).run();
      expect((await verifyAuditChain(t.db)).ok).toBe(true);
      await restore("audit_events_no_update");

      // 2. A sealed event is deleted.
      await drop("audit_events_no_delete");
      await t.d1.prepare("DELETE FROM audit_events WHERE seq = ?").bind(middle.toSeq).run();
      await restore("audit_events_no_delete");
      const deleted = await verifyAuditChain(t.db);
      expect(deleted.ok).toBe(false);
      expect(deleted.problems.map((problem) => [problem.kind, problem.sealId])).toEqual([["seal_hash", middle.id]]);

      // 3. A seal is removed to hide it: the chain no longer tiles and the next link is broken.
      await drop("audit_seals_no_delete");
      await t.d1.prepare("DELETE FROM audit_seals WHERE id = ?").bind(middle.id).run();
      await restore("audit_seals_no_delete");
      const hidden = await verifyAuditChain(t.db);
      expect(hidden.ok).toBe(false);
      expect(hidden.problems.map((problem) => [problem.kind, problem.sealId])).toEqual([
        ["seal_gap", last.id],
        ["seal_link", last.id],
      ]);
    } finally {
      for (const trigger of triggers) {
        const exists = await scalar("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?", trigger.name);
        if (exists === 0) await t.d1.prepare(trigger.sql).run();
      }
    }
    // The triggers are back in force.
    expect(await failure(() => t.db.update(auditEvents).set({ reason: "x" }))).toMatchObject({ code: "immutable" });
    expect(await failure(() => t.db.delete(auditSeals))).toMatchObject({ code: "immutable" });
  });
});

// ───────────────────────────────────────────────────────────────── settings

describe("settings", () => {
  const admin = employeeActor(["settings.read", "settings.manage", "settings.shipping.manage", "settings.payment.manage", "settings.locale.manage"], { id: "emp_settings", label: "مديرة الإعدادات" });

  test("the registry covers every key of ARCHITECTURE §10 with the seeded defaults", async () => {
    const seeded = Object.keys(SETTINGS_DEFAULTS) as (keyof typeof SETTINGS_DEFAULTS)[];
    for (const key of seeded) {
      expect(SETTING_KEYS, key).toContain(key);
      expect(settingDefault(key), key).toEqual(SETTINGS_DEFAULTS[key]);
      expect(await getSetting(t.db, key), key).toEqual(SETTINGS_DEFAULTS[key]);
    }
    // Keys beyond §10 are internal controls: never shown to shoppers, and they work without a seeded row.
    const extra = SETTING_KEYS.filter((key) => !seeded.includes(key as (typeof seeded)[number]));
    // + the limits the admin modules asked for (settings module 22, 2026-11-11): their defaults are the modules' constants
    expect(extra).toEqual(["refunds.approval_threshold_iqd", "pricing.drop_approval_bps", "purchasing.po_approval_limit_iqd", "finance.topup_second_approval_iqd", "finance.expense_second_approval_iqd", "returns.sla"]);
    expect([...PUBLIC_SETTING_KEYS].sort()).toEqual([...seeded].sort());
    for (const key of SETTING_KEYS) {
      expect(isPermission(SETTINGS[key].permission), key).toBe(true);
      expect(SETTINGS[key].label.ar.trim()).not.toBe("");
      expect(SETTINGS[key].label.en.trim()).not.toBe("");
      expect(SETTINGS[key].schema.safeParse(SETTINGS[key].default).success, `${key} default fits its schema`).toBe(true);
    }
    expect(await getSetting(t.db, "shipping.flat_fee_iqd")).toBe(5000);
    expect(await getSetting(t.db, "shipping.overrides_enabled")).toBe(false);
    expect(await getSetting(t.db, "payments.bank_transfer")).toEqual({ enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" });
    expect(await getSetting(t.db, "payments.zaincash")).toEqual({ enabled: true, number: "07719061852" });

    const several = await getSettings(t.db, ["payments.cod", "checkout.reservation_minutes", "returns.window_days"]);
    expect(several).toEqual({ "payments.cod": { enabled: true }, "checkout.reservation_minutes": 30, "returns.window_days": 7 });
    expect(await getSettings(t.db, [])).toEqual({});
    const shown = await getPublicSettings(t.db);
    expect(Object.keys(shown).sort()).toEqual([...seeded].sort());
    expect("refunds.approval_threshold_iqd" in shown).toBe(false);
  });

  test("a missing row falls back to the default; a row that breaks its schema is an error, not a guess", async () => {
    await t.db.delete(settings).where(eq(settings.key, "tradein.estimate_valid_days"));
    expect(await getSetting(t.db, "tradein.estimate_valid_days")).toBe(7);

    await t.db.insert(settings).values({ key: "tradein.estimate_valid_days", value: "seven", updatedAt: NOW });
    await expect(getSetting(t.db, "tradein.estimate_valid_days")).rejects.toThrow(/tradein\.estimate_valid_days/);
    await expect(getSettings(t.db, ["returns.window_days", "tradein.estimate_valid_days"])).rejects.toThrow(/does not match its schema/);
    await t.db.update(settings).set({ value: 7 }).where(eq(settings.key, "tradein.estimate_valid_days"));
    expect(await getSetting(t.db, "tradein.estimate_valid_days")).toBe(7);
  });

  test("setSetting needs the key's permission and a reason", async () => {
    const withoutShipping = employeeActor(["settings.manage"]);
    expect(await failure(() => setSetting(t.db, withoutShipping, "shipping.flat_fee_iqd", 6000, "تجربة", NOW))).toMatchObject({ code: "forbidden", status: 403, detail: "settings.shipping.manage" });
    expect(await failure(() => setSetting(t.db, roleActor("manager"), "payments.zaincash", { enabled: true, number: "07701234567" }, "تغيير الرقم", NOW))).toMatchObject({ code: "forbidden", detail: "settings.payment.manage" });
    expect(await failure(() => setSetting(t.db, GUEST, "returns.window_days", 3, "تجربة", NOW))).toMatchObject({ code: "forbidden" });
    for (const reason of ["", "  ", "ok"]) {
      expect(await failure(() => setSetting(t.db, admin, "shipping.flat_fee_iqd", 6000, reason, NOW))).toMatchObject({ code: "invalid", fields: { reason: "required" } });
    }
    expect(await failure(() => setSetting(t.db, admin, "not.a.setting" as "returns.window_days", 1, "تجربة", NOW))).toMatchObject({ code: "not_found" });
    expect(await getSetting(t.db, "shipping.flat_fee_iqd")).toBe(5000);
  });

  test("values are validated against the key's schema", async () => {
    const bad: [Parameters<typeof setSetting>[2], unknown, Record<string, string>][] = [
      ["shipping.flat_fee_iqd", -1, { value: "too_small" }],
      ["shipping.flat_fee_iqd", 5000.5, { value: "invalid" }],
      ["shipping.flat_fee_iqd", "5000", { value: "invalid" }],
      ["shipping.flat_fee_iqd", Number.NaN, { value: "invalid" }],
      ["shipping.overrides_enabled", "yes", { value: "invalid" }],
      ["payments.cod", { enabled: "true" }, { "value.enabled": "invalid" }],
      ["payments.cod", { enabled: true, extra: 1 }, { value: "invalid" }],
      ["payments.bank_transfer", { enabled: true, account_number: "12ab", recipient_name: "علي" }, { "value.account_number": "account_number_invalid" }],
      ["payments.bank_transfer", { enabled: true, account_number: "9269317427", recipient_name: "" }, { "value.recipient_name": "required" }],
      ["payments.zaincash", { enabled: true, number: "12345" }, { "value.number": "phone_invalid" }],
      ["checkout.reservation_minutes", 0, { value: "too_small" }],
      ["checkout.transfer_proof_hours", 1000, { value: "too_big" }],
      ["store.contact", { email: "not-an-email" }, { "value.email": "email_invalid" }],
      ["store.contact", { map_url: "http://insecure.example" }, { "value.map_url": "url_invalid" }],
      ["locale.numbering", { ar: "arab", en: "latn", ckb: "roman" }, { "value.ckb": "invalid" }],
    ];
    for (const [key, value, fields] of bad) {
      expect(await failure(() => setSetting(t.db, admin, key, value, "اختبار التحقق", NOW)), `${key} = ${JSON.stringify(value)}`).toMatchObject({ code: "invalid", status: 400, fields });
    }
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'settings.setting.update'")).toBe(0);
  });

  test("a change is stored with who, why, before and after — in one batch", async () => {
    expect(await setSetting(t.db, admin, "shipping.flat_fee_iqd", 6000, "اتفاق جديد مع شركة التوصيل", NOW + MINUTE)).toBe(6000);
    expect(await getSetting(t.db, "shipping.flat_fee_iqd")).toBe(6000);
    expect(await t.db.select().from(settings).where(eq(settings.key, "shipping.flat_fee_iqd")).get()).toMatchObject({ value: 6000, updatedAt: NOW + MINUTE, updatedBy: "emp_settings" });
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "settings.setting.update"), eq(auditEvents.entityId, "shipping.flat_fee_iqd"))).get();
    expect(event).toMatchObject({ actorKind: "employee", actorId: "emp_settings", actorLabel: "مديرة الإعدادات", entityType: "setting", before: { value: 5000 }, after: { value: 6000 }, reason: "اتفاق جديد مع شركة التوصيل", at: NOW + MINUTE });

    // Saving the same value again changes nothing and adds no event.
    expect(await setSetting(t.db, admin, "shipping.flat_fee_iqd", 6000, "نفس القيمة", NOW + 2 * MINUTE)).toBe(6000);
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'settings.setting.update' AND entity_id = 'shipping.flat_fee_iqd'")).toBe(1);
    expect(await scalar("SELECT updated_at FROM settings WHERE key = 'shipping.flat_fee_iqd'")).toBe(NOW + MINUTE);

    // Values are normalized; the store's own payment number stays readable in the trail.
    const zain = await setSetting(t.db, admin, "payments.zaincash", { enabled: false, number: "+964 770 123 4567" }, "رقم زين كاش الجديد", NOW + 3 * MINUTE);
    expect(zain).toEqual({ enabled: false, number: "07701234567" });
    const bank = await setSetting(t.db, admin, "payments.bank_transfer", { enabled: true, account_number: "9269 3174 27", recipient_name: " علي خليفة " }, "تنسيق الرقم", NOW + 3 * MINUTE);
    expect(bank).toEqual({ enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" });
    const zainEvent = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "settings.setting.update"), eq(auditEvents.entityId, "payments.zaincash"))).get();
    expect(zainEvent).toMatchObject({ before: { value: { enabled: true, number: "07719061852" } }, after: { value: { enabled: false, number: "07701234567" } } });

    const contact = await setSetting(t.db, admin, "store.contact", { phone: "0770 123 4567", email: "hello@tamtamgames.com", address: { ar: "بغداد، الكرادة" }, instagram: "https://instagram.com/tamtam" }, "بيانات التواصل", NOW + 4 * MINUTE);
    expect(contact).toEqual({ phone: "07701234567", email: "hello@tamtamgames.com", address: { ar: "بغداد، الكرادة" }, instagram: "https://instagram.com/tamtam" });

    await setSetting(t.db, systemActor("test.restore"), "shipping.flat_fee_iqd", 5000, "إعادة القيمة الأصلية", NOW + 5 * MINUTE);
    expect(await scalar("SELECT updated_by FROM settings WHERE key = 'shipping.flat_fee_iqd'")).toBeNull();
  });

  test("listSettings shows every key with its value and whether this actor may edit it", async () => {
    expect(await failure(() => listSettings(t.db, employeeActor([])))).toMatchObject({ code: "forbidden", detail: "settings.read" });
    const viewer = employeeActor(["settings.read", "settings.manage"]);
    const list = await listSettings(t.db, viewer);
    expect(list.map((item) => item.key)).toEqual(SETTING_KEYS);
    const byKey = Object.fromEntries(list.map((item) => [item.key, item]));
    expect(byKey["returns.window_days"]).toMatchObject({ value: 7, canEdit: true, isStored: true, group: "policies" });
    expect(byKey["payments.zaincash"]).toMatchObject({ canEdit: false, value: { enabled: false, number: "07701234567" }, updatedBy: "emp_settings" });
    expect(byKey["shipping.flat_fee_iqd"]).toMatchObject({ canEdit: false, value: 5000 });
    expect(byKey["refunds.approval_threshold_iqd"]).toMatchObject({ canEdit: false, value: 0, isStored: false, group: "controls" });
  });

  test("the refund approval threshold: every refund needs approval until the owner changes it", async () => {
    expect(await scalar("SELECT count(*) FROM settings WHERE key = 'refunds.approval_threshold_iqd'")).toBe(0);
    expect(await getSetting(t.db, "refunds.approval_threshold_iqd")).toBe(0);
    // Raising it weakens a money control: a store manager may not; the owner may.
    expect(await failure(() => setSetting(t.db, roleActor("manager"), "refunds.approval_threshold_iqd", 50_000, "مرتجعات صغيرة", NOW))).toMatchObject({ code: "forbidden", detail: "settings.payment.manage" });
    expect(await failure(() => setSetting(t.db, roleActor("owner"), "refunds.approval_threshold_iqd", -5, "خطأ في الإدخال", NOW))).toMatchObject({ code: "invalid", fields: { value: "too_small" } });
    expect(await setSetting(t.db, roleActor("owner"), "refunds.approval_threshold_iqd", 50_000, "مرتجعات صغيرة", NOW)).toBe(50_000);
    expect(await getSetting(t.db, "refunds.approval_threshold_iqd")).toBe(50_000);
    await setSetting(t.db, roleActor("owner"), "refunds.approval_threshold_iqd", 0, "إعادة القيمة الأصلية", NOW + MINUTE);
    expect(await getSetting(t.db, "refunds.approval_threshold_iqd")).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── rate limiting

describe("rate limiting", () => {
  const rule = { limit: 3, windowSec: 60 };
  const base = Math.floor((NOW + 500 * DAY) / 60_000) * 60_000;

  test("allows `limit` requests per window, then blocks until the window ends", async () => {
    const key = `test:${newId("rl")}`;
    expect(await rateLimit(t.db, key, rule, base)).toEqual({ ok: true, remaining: 2, retryAfterSec: 0 });
    expect(await rateLimit(t.db, key, rule, base + 1000)).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    expect(await rateLimit(t.db, key, rule, base + 2000)).toEqual({ ok: true, remaining: 0, retryAfterSec: 0 });
    expect(await rateLimit(t.db, key, rule, base + 3000)).toEqual({ ok: false, remaining: 0, retryAfterSec: 57 });
    expect(await rateLimit(t.db, key, rule, base + 59_999)).toEqual({ ok: false, remaining: 0, retryAfterSec: 1 });
    // A blocked caller does not move the counter (and costs no write).
    expect(await scalar("SELECT count FROM rate_limits WHERE key = ?", key)).toBe(3);

    // The next window starts fresh; the old row stays until cleanup.
    expect(await rateLimit(t.db, key, rule, base + 60_000)).toEqual({ ok: true, remaining: 2, retryAfterSec: 0 });
    expect(await scalar("SELECT count(*) FROM rate_limits WHERE key = ?", key)).toBe(2);
  });

  test("keys are independent; a missing identifier is not limited", async () => {
    const a = `test:${newId("rl")}`;
    const b = `test:${newId("rl")}`;
    for (let i = 0; i < 3; i++) await rateLimit(t.db, a, rule, base);
    expect((await rateLimit(t.db, a, rule, base)).ok).toBe(false);
    expect((await rateLimit(t.db, b, rule, base)).ok).toBe(true);

    for (let i = 0; i < 10; i++) expect(await rateLimit(t.db, null, rule, base)).toEqual({ ok: true, remaining: 3, retryAfterSec: 0 });
    expect(await limitKey("signin", "ip", null)).toBeNull();
    expect(await limitKey("signin", "ip", "")).toBeNull();
    const hashed = await limitKey("signin", "phone", "+9647719061852");
    expect(hashed).toMatch(/^signin:phone:[0-9a-f]{32}$/);
    expect(hashed).not.toContain("7719061852");
    expect(await limitKey("signin", "phone", "+9647719061852")).toBe(hashed);
    expect(await limitKey("otp", "phone", "+9647719061852")).not.toBe(hashed);
  });

  test("concurrent requests cannot exceed the limit", async () => {
    const key = `test:${newId("rl")}`;
    const verdicts = await Promise.all(Array.from({ length: 12 }, () => rateLimit(t.db, key, { limit: 5, windowSec: 60 }, base)));
    expect(verdicts.filter((verdict) => verdict.ok)).toHaveLength(5);
    expect(await scalar("SELECT count FROM rate_limits WHERE key = ?", key)).toBe(5);
  });

  test("peek does not count; reset forgets; enforce throws", async () => {
    const key = `test:${newId("rl")}`;
    expect(await peekRateLimit(t.db, key, rule, base)).toEqual({ ok: true, remaining: 3, retryAfterSec: 0 });
    await rateLimit(t.db, key, rule, base);
    await rateLimit(t.db, key, rule, base);
    expect(await peekRateLimit(t.db, key, rule, base)).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    expect(await peekRateLimit(t.db, key, rule, base)).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    await rateLimit(t.db, key, rule, base);
    expect(await peekRateLimit(t.db, key, rule, base + 10_000)).toEqual({ ok: false, remaining: 0, retryAfterSec: 50 });

    const refused = await failure(() => enforceRateLimit(t.db, key, rule, base + 10_000));
    expect(refused).toMatchObject({ code: "rate_limited", status: 429, retryAfterSec: 50 });
    await resetRateLimit(t.db, key);
    await expect(enforceRateLimit(t.db, key, rule, base + 10_000)).resolves.toBeUndefined();
    await expect(rateLimit(t.db, key, { limit: 0, windowSec: 60 }, base)).rejects.toThrow(/limit/);
    await expect(rateLimit(t.db, key, { limit: 1, windowSec: 0 }, base)).rejects.toThrow(/windowSec/);
  });

  test("claimOnce wins exactly once per slot", async () => {
    const key = `totp:${newId("emp")}`;
    expect(await claimOnce(t.db, key, 1000)).toBe(true);
    expect(await claimOnce(t.db, key, 1000)).toBe(false);
    expect(await claimOnce(t.db, key, 2000)).toBe(true);
    const race = await Promise.all(Array.from({ length: 8 }, () => claimOnce(t.db, key, 3000)));
    expect(race.filter(Boolean)).toHaveLength(1);
  });

  test("cleanup removes windows older than a day and nothing newer", async () => {
    const stale = `test:${newId("rl")}`;
    const fresh = `test:${newId("rl")}`;
    const now = base + 10 * DAY;
    await rateLimit(t.db, stale, rule, now - 2 * DAY);
    await rateLimit(t.db, stale, rule, now - 25 * HOUR);
    await rateLimit(t.db, fresh, rule, now - 23 * HOUR);
    await rateLimit(t.db, fresh, rule, now);
    const before = Number(await scalar("SELECT count(*) FROM rate_limits WHERE window_start < ?", now - DAY));
    expect(before).toBeGreaterThanOrEqual(2);
    expect(await cleanupRateLimits(t.db, now)).toBe(before);
    expect(await scalar("SELECT count(*) FROM rate_limits WHERE key = ?", stale)).toBe(0);
    expect(await scalar("SELECT count(*) FROM rate_limits WHERE key = ?", fresh)).toBe(2);
    expect(await cleanupRateLimits(t.db, now)).toBe(0);
  });

  test("presets exist for sign-in, OTP, order lookup, checkout and upload", () => {
    for (const name of ["signIn", "signInIp", "otpRequest", "otpRequestIp", "orderLookup", "checkout", "upload", "adminSignInFailures", "adminSignInIp", "mfaVerify", "setup"] as const) {
      expect(RATE_LIMITS[name].limit, name).toBeGreaterThan(0);
      expect(RATE_LIMITS[name].windowSec, name).toBeGreaterThanOrEqual(60);
    }
  });
});

// ───────────────────────────────────────────────────────────────── uploads

/** A JPEG segment: marker, two-byte length (including itself), payload. */
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const JFIF = segment(0xe0, [...text("JFIF"), 0, 1, 1, 0, 0, 72, 0, 72, 0, 0]);
/** Little-endian Exif with one directory entry (Orientation) followed by text that must not survive. */
const exifSegment = (orientation: number, extra: string) =>
  segment(0xe1, [...text("Exif"), 0, 0, 0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0, ...text(extra)]);
const MINIMAL_EXIF = (orientation: number) => [0xff, 0xe1, 0x00, 0x22, ...text("Exif"), 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
const DQT = segment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]);
const DHT = segment(0xc4, [0, ...Array.from({ length: 16 }, () => 0)]);
const startOfFrame = (width: number, height: number, marker = 0xc0) => segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);
/** Entropy-coded bytes with a stuffed FF00 and a restart marker inside — both must be kept, not read as segments. */
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78, 0xff, 0x00];
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

function pngChunk(type: string, data: number[]): number[] {
  const body = Uint8Array.from([...text(type), ...data]);
  const crc = crc32(body) >>> 0;
  const length = data.length;
  return [length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...body, crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const be32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const ihdr = (width: number, height: number) => pngChunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
const IDAT = pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
const IEND = pngChunk("IEND", []);

const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const webpChunk = (type: string, payload: number[]) => [...text(type), ...le32(payload.length), ...payload, ...(payload.length % 2 ? [0] : [])];
const riff = (chunks: number[][], trailing: number[] = []) => {
  const body = [...text("WEBP"), ...chunks.flat()];
  return Uint8Array.from([...text("RIFF"), ...le32(body.length), ...body, ...trailing]);
};
const vp8x = (flags: number, width: number, height: number) => webpChunk("VP8X", [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
const vp8 = (width: number, height: number) => webpChunk("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x07]);
const vp8l = (width: number, height: number) => {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webpChunk("VP8L", [0x2f, ...le32(bits), 0x00, 0x00]);
};

describe("image uploads", () => {
  test("JPEG: Exif, IPTC, comments, thumbnails and trailing bytes are removed; the picture data is untouched", () => {
    const original = Uint8Array.from([
      ...SOI,
      ...JFIF,
      ...exifSegment(6, "GPS 33.3152N 44.3661E iPhone 2026:11:10"),
      ...segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/"), 0, ...text("<x:xmpmeta>creator=Noor</x:xmpmeta>")]),
      ...segment(0xed, [...text("Photoshop 3.0"), 0, ...text("8BIM caption: home address")]),
      ...segment(0xe2, [...text("MPF"), 0, 1, 2, 3]),
      ...segment(0xe2, [...text("ICC_PROFILE"), 0, 1, 1, 9, 9, 9]),
      ...segment(0xee, [...text("Adobe"), 0, 100, 0, 0, 0, 0, 1]),
      ...segment(0xfe, text("secret comment")),
      ...DQT,
      ...startOfFrame(3, 2),
      ...DHT,
      ...SOS,
      ...SCAN,
      ...EOI,
      ...text("TRAILING-PAYLOAD<script>alert(1)</script>"),
    ]);
    const copy = original.slice();
    const image = sanitizeImage(original);
    expect(original).toEqual(copy);

    const expected = Uint8Array.from([
      ...SOI,
      ...JFIF,
      ...MINIMAL_EXIF(6),
      ...segment(0xe2, [...text("ICC_PROFILE"), 0, 1, 1, 9, 9, 9]),
      ...segment(0xee, [...text("Adobe"), 0, 100, 0, 0, 0, 0, 1]),
      ...DQT,
      ...startOfFrame(3, 2),
      ...DHT,
      ...SOS,
      ...SCAN,
      ...EOI,
    ]);
    expect(Buffer.from(image.bytes).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
    expect(image).toMatchObject({ format: "jpeg", mime: "image/jpeg" });
    // Orientation 6 = stored sideways: displayed size is swapped, and the orientation alone is kept.
    expect([image.width, image.height]).toEqual([2, 3]);
    expect(image.removed.sort()).toEqual(["app2", "comment", "exif", "iptc", "trailing data", "xmp"]);
    for (const leaked of ["GPS", "iPhone", "xmpmeta", "Noor", "home address", "secret comment", "TRAILING", "script", "MPF"]) {
      expect(includesText(image.bytes, leaked), leaked).toBe(false);
    }
    // Cleaning an already clean file changes nothing.
    expect(Buffer.from(sanitizeImage(image.bytes).bytes).equals(Buffer.from(image.bytes))).toBe(true);
  });

  test("JPEG variants: no metadata, upright Exif, embedded thumbnail, progressive, missing end marker", () => {
    const plain = Uint8Array.from([...SOI, ...JFIF, ...DQT, ...startOfFrame(640, 480), ...DHT, ...SOS, ...SCAN, ...EOI]);
    const clean = sanitizeImage(plain);
    expect(Buffer.from(clean.bytes).equals(Buffer.from(plain))).toBe(true);
    expect(clean).toMatchObject({ width: 640, height: 480, removed: [] });

    // Orientation 1 (upright): nothing needs to be written back.
    const upright = sanitizeImage(Uint8Array.from([...SOI, ...exifSegment(1, "Canon EOS"), ...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, ...SCAN, ...EOI]));
    expect(includesText(upright.bytes, "Exif")).toBe(false);
    expect([upright.width, upright.height]).toEqual([4, 3]);
    // Without a JFIF header the orientation block goes right after the start marker.
    const rotated = sanitizeImage(Uint8Array.from([...SOI, ...exifSegment(8, "Canon EOS"), ...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, ...SCAN, ...EOI]));
    expect([...rotated.bytes.subarray(0, 38)]).toEqual([...SOI, ...MINIMAL_EXIF(8)]);
    expect([rotated.width, rotated.height]).toEqual([3, 4]);
    expect(includesText(rotated.bytes, "Canon")).toBe(false);

    // A JFIF header with an embedded thumbnail keeps its density fields and loses the thumbnail.
    const withThumbnail = segment(0xe0, [...text("JFIF"), 0, 1, 1, 1, 0, 96, 0, 96, 1, 1, 0xaa, 0xbb, 0xcc]);
    const thumbless = sanitizeImage(Uint8Array.from([...SOI, ...withThumbnail, ...segment(0xe0, [...text("JFXX"), 0, 0x13, 1, 1, 9, 9, 9]), ...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, ...SCAN, ...EOI]));
    expect([...thumbless.bytes.subarray(2, 20)]).toEqual(segment(0xe0, [...text("JFIF"), 0, 1, 1, 1, 0, 96, 0, 96, 0, 0]));
    expect(thumbless.removed).toEqual(["thumbnail"]);
    expect(includesText(thumbless.bytes, "JFXX")).toBe(false);

    // Progressive: several scans with tables in between.
    const progressive = Uint8Array.from([...SOI, ...JFIF, ...DQT, ...startOfFrame(10, 20, 0xc2), ...DHT, ...SOS, ...SCAN, ...DHT, ...SOS, 0x01, 0x02, ...SOS, 0xff, 0xd7, 0x03, ...EOI]);
    const multi = sanitizeImage(progressive);
    expect(Buffer.from(multi.bytes).equals(Buffer.from(progressive))).toBe(true);
    expect([multi.width, multi.height]).toEqual([10, 20]);

    // Cut off before the end marker (some cameras do this): accepted, and the marker is written back.
    const truncated = sanitizeImage(Uint8Array.from([...SOI, ...JFIF, ...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, ...SCAN]));
    expect([...truncated.bytes.slice(-2)]).toEqual(EOI);
  });

  test("PNG: text, Exif and time chunks and trailing bytes are removed; image chunks are copied bit for bit", () => {
    const phys = pngChunk("pHYs", [...be32(2835), ...be32(2835), 1]);
    const original = Uint8Array.from([
      ...PNG_SIGNATURE,
      ...ihdr(7, 5),
      ...pngChunk("tEXt", [...text("Author"), 0, ...text("Noor Al-Tamimi")]),
      ...pngChunk("iTXt", [...text("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...text("<xmp>home address</xmp>")]),
      ...pngChunk("zTXt", [...text("Comment"), 0, 0, 1, 2, 3]),
      ...pngChunk("eXIf", [0x4d, 0x4d, 0, 0x2a, ...text("GPS-DATA")]),
      ...pngChunk("tIME", [0x07, 0xea, 11, 10, 9, 0, 0]),
      ...phys,
      ...pngChunk("prVt", text("private vendor data")),
      ...IDAT,
      ...IDAT,
      ...IEND,
      ...text("<?php echo 'trailing'; ?>"),
    ]);
    const image = sanitizeImage(original);
    const expected = Uint8Array.from([...PNG_SIGNATURE, ...ihdr(7, 5), ...phys, ...IDAT, ...IDAT, ...IEND]);
    expect(Buffer.from(image.bytes).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
    expect(image).toMatchObject({ format: "png", mime: "image/png", width: 7, height: 5 });
    expect(image.removed.sort()).toEqual(["exif", "prVt", "text", "time", "trailing data"]);
    for (const leaked of ["Author", "Noor", "home address", "GPS-DATA", "vendor", "php"]) expect(includesText(image.bytes, leaked), leaked).toBe(false);
    expect(Buffer.from(sanitizeImage(image.bytes).bytes).equals(Buffer.from(image.bytes))).toBe(true);
  });

  test("WebP: EXIF and XMP chunks are removed and the header flags and size are corrected", () => {
    const exifPayload = text("Exif-GPS-33.3152");
    // Odd length on purpose: the chunk is followed by a pad byte, which must go with it.
    const xmpPayload = text("<xmp>creator=Noor</xmp>");
    expect(xmpPayload.length % 2).toBe(1);
    const original = riff(
      [vp8x(0x08 | 0x04 | 0x20, 300, 200), webpChunk("ICCP", [1, 2, 3]), vp8(300, 200), webpChunk("EXIF", exifPayload), webpChunk("XMP ", xmpPayload), webpChunk("JUNK", [9, 9])],
      text("TRAILING-BYTES"),
    );
    const image = sanitizeImage(original);
    const expected = riff([vp8x(0x20, 300, 200), webpChunk("ICCP", [1, 2, 3]), vp8(300, 200)]);
    expect(Buffer.from(image.bytes).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
    expect(image).toMatchObject({ format: "webp", mime: "image/webp", width: 300, height: 200 });
    expect(image.removed.sort()).toEqual(["JUNK", "exif", "trailing data", "xmp"]);
    // RIFF size = file length − 8; VP8X flags no longer announce EXIF (0x08) or XMP (0x04), ICC (0x20) stays.
    expect(new DataView(image.bytes.buffer, image.bytes.byteOffset).getUint32(4, true)).toBe(image.bytes.length - 8);
    expect(image.bytes[20]).toBe(0x20);
    for (const leaked of ["GPS", "Noor", "TRAILING", "JUNK"]) expect(includesText(image.bytes, leaked), leaked).toBe(false);
    expect(Buffer.from(sanitizeImage(image.bytes).bytes).equals(Buffer.from(image.bytes))).toBe(true);

    // Simple lossy and lossless files have no metadata container: only the size is read.
    const lossy = riff([vp8(640, 360)]);
    expect(sanitizeImage(lossy)).toMatchObject({ width: 640, height: 360, removed: [] });
    expect(Buffer.from(sanitizeImage(lossy).bytes).equals(Buffer.from(lossy))).toBe(true);
    expect(sanitizeImage(riff([vp8l(1024, 768)]))).toMatchObject({ width: 1024, height: 768, removed: [] });
    // An EXIF chunk appended to a simple file is dropped as well.
    expect(includesText(sanitizeImage(riff([vp8(16, 16), webpChunk("EXIF", exifPayload)])).bytes, "GPS")).toBe(false);
  });

  test("the type is decided by content: disguised files are refused whatever their name or declared type", async () => {
    const disguised: [string, number[]][] = [
      ["html", text("<!doctype html><html><script>alert(document.cookie)</script></html>")],
      ["svg", text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
      ["pdf", text("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>")],
      ["gif", [...text("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0]],
      ["exe", [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]],
      ["zip", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]],
      ["bmp", [...text("BM"), 0x46, 0, 0, 0, 0, 0, 0, 0]],
      ["riff-wave", [...text("RIFF"), ...le32(4), ...text("WAVE")]],
      ["text", text("just some text")],
    ];
    for (const [label, bytes] of disguised) {
      expect(detectImageFormat(Uint8Array.from(bytes)), label).toBeNull();
      const file = new File([Uint8Array.from(bytes)], "transfer-proof.jpg", { type: "image/jpeg" });
      expect(await failure(() => processImageUpload(file)), label).toMatchObject({ code: "upload_type", status: 415, fields: { file: "upload_type" } });
    }
    // The reverse also holds: a real PNG is accepted whatever it is called.
    const png = Uint8Array.from([...PNG_SIGNATURE, ...ihdr(2, 2), ...IDAT, ...IEND]);
    const accepted = await processImageUpload(new File([png], "../../etc/passwd.exe", { type: "application/x-msdownload" }));
    expect(accepted).toMatchObject({ format: "png", mime: "image/png", width: 2, height: 2, originalName: "../../etc/passwd.exe", originalBytes: png.length });
    expect(accepted.sha256).toBe(await sha256Hex(accepted.bytes));
  });

  test("the right first bytes are not enough: broken containers are refused", () => {
    const corrupt: [string, number[]][] = [
      ["jpeg: marker then garbage", [...SOI, 0xff, 0xe0, 0x00]],
      ["jpeg: html after the signature", [...SOI, 0xff, ...text("<script>alert(1)</script>")]],
      ["jpeg: segment longer than the file", [...SOI, 0xff, 0xe0, 0xff, 0xff, 1, 2, 3]],
      ["jpeg: no frame, no scan", [...SOI, ...JFIF, ...EOI]],
      ["jpeg: frame but no scan", [...SOI, ...JFIF, ...startOfFrame(4, 3), ...EOI]],
      ["jpeg: zero size", [...SOI, ...JFIF, ...startOfFrame(0, 0), ...SOS, ...SCAN, ...EOI]],
      ["png: signature only", PNG_SIGNATURE],
      ["png: header is not first", [...PNG_SIGNATURE, ...IDAT, ...ihdr(2, 2), ...IEND]],
      ["png: no image data", [...PNG_SIGNATURE, ...ihdr(2, 2), ...IEND]],
      ["png: no end chunk", [...PNG_SIGNATURE, ...ihdr(2, 2), ...IDAT]],
      ["png: chunk longer than the file", [...PNG_SIGNATURE, ...ihdr(2, 2), ...be32(999_999), ...text("IDAT"), 1, 2, 3]],
      ["png: unknown critical chunk", [...PNG_SIGNATURE, ...ihdr(2, 2), ...pngChunk("EVIL", [1, 2, 3]), ...IDAT, ...IEND]],
      ["webp: size beyond the file", [...text("RIFF"), ...le32(5000), ...text("WEBP"), ...vp8(16, 16)]],
      ["webp: no image chunk", [...riff([vp8x(0, 16, 16)])]],
      ["webp: unknown first chunk", [...riff([webpChunk("EXIF", [1, 2]), vp8(16, 16)])]],
      ["webp: bad lossy start code", [...riff([webpChunk("VP8 ", [0x30, 0x01, 0x00, 0, 0, 0, 16, 0, 16, 0])])]],
    ];
    for (const [label, bytes] of corrupt) {
      const error = (() => {
        try {
          sanitizeImage(Uint8Array.from(bytes));
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, label).toMatchObject({ code: "upload_corrupt", status: 422, fields: { file: "upload_corrupt" } });
    }
  });

  test("size and dimension limits", async () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
    for (const empty of [null, undefined, "", "a text field", new File([], "empty.png"), new Uint8Array(0)]) {
      expect(await failure(() => processImageUpload(empty))).toMatchObject({ code: "upload_missing", status: 400, fields: { file: "upload_missing" } });
    }
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1);
    tooBig.set([...SOI, 0xff]);
    expect(await failure(() => processImageUpload(tooBig))).toMatchObject({ code: "upload_too_large", status: 413, fields: { file: "upload_too_large" } });
    expect(await failure(() => processImageUpload(new File([tooBig], "big.jpg")))).toMatchObject({ code: "upload_too_large" });
    const png = Uint8Array.from([...PNG_SIGNATURE, ...ihdr(2, 2), ...IDAT, ...IEND]);
    expect(await failure(() => processImageUpload(png, { maxBytes: png.length - 1 }))).toMatchObject({ code: "upload_too_large" });
    await expect(processImageUpload(png, { maxBytes: png.length })).resolves.toMatchObject({ width: 2 });

    for (const [width, height] of [[20_000, 10], [10, 20_000], [10_000, 10_000], [0, 10]]) {
      const error = (() => {
        try {
          sanitizeImage(Uint8Array.from([...PNG_SIGNATURE, ...ihdr(width, height), ...IDAT, ...IEND]));
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, `${width}x${height}`).toMatchObject({ code: width === 0 ? "upload_corrupt" : "upload_dimensions", status: 422 });
    }
    expect(sanitizeImage(Uint8Array.from([...PNG_SIGNATURE, ...ihdr(8000, 6000), ...IDAT, ...IEND]))).toMatchObject({ width: 8000, height: 6000 });
  });

  test("the hash is of the cleaned image: the same picture with different metadata is the same file", async () => {
    const picture = [...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, ...SCAN, ...EOI];
    const first = await processImageUpload(Uint8Array.from([...SOI, ...JFIF, ...exifSegment(1, "phone A, 10:00"), ...picture]));
    const second = await processImageUpload(Uint8Array.from([...SOI, ...JFIF, ...exifSegment(1, "phone B, 22:30"), ...segment(0xfe, text("edited")), ...picture, ...text("padding")]));
    expect(first.sha256).toBe(second.sha256);
    const other = await processImageUpload(Uint8Array.from([...SOI, ...JFIF, ...DQT, ...startOfFrame(4, 3), ...DHT, ...SOS, 0x99, ...EOI]));
    expect(other.sha256).not.toBe(first.sha256);
  });
});

// ───────────────────────────────────────────────────────────────── storage

describe("file storage", () => {
  const png = () => new File([Uint8Array.from([...PNG_SIGNATURE, ...ihdr(12, 9), ...pngChunk("tEXt", [...text("Author"), 0, ...text("Noor")]), ...IDAT, ...IEND])], "صورة الإثبات.png", { type: "image/png" });
  const actor: Actor = { kind: "customer", id: "cus_uploader" };

  test("a private upload is stored cleaned, recorded, readable by id — and never public", async () => {
    const { file, image } = await saveImageUpload(t.db, store, png(), { visibility: "private", kind: "payment_proof", ownerType: "payment", ownerId: "pay_1", createdBy: actor, now: NOW });
    expect(file).toMatchObject({ visibility: "private", kind: "payment_proof", mime: "image/png", width: 12, height: 9, bytes: image.bytes.length, sha256: image.sha256, ownerType: "payment", ownerId: "pay_1", createdBy: "cus_uploader", createdByKind: "customer", createdAt: NOW, originalName: "صورة الإثبات.png", deletedAt: null });
    expect(file.id).toMatch(/^fil_/);
    expect(file.storageKey).toMatch(/^prv_[A-Za-z0-9_-]{24}\.png$/);
    expect(image.removed).toEqual(["text"]);

    const stored = await getFile(t.db, store, file.id);
    expect(stored?.record.id).toBe(file.id);
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(image.bytes))).toBe(true);
    expect(includesText(new Uint8Array(stored!.bytes), "Noor")).toBe(false);

    // The public reader refuses private keys before and after looking.
    expect(isPublicStorageKey(file.storageKey)).toBe(false);
    expect(await getPublicBlob(store, file.storageKey)).toBeNull();
    expect(await getPublicBlob(store, file.storageKey.replace(/^prv_/, "pub_"))).toBeNull();
    for (const key of [null, undefined, "", "pub_", "../blob/x", "pub_short.png", `pub_${"a".repeat(24)}`, `pub_${"a".repeat(24)}.png/..`, "prv_aaaaaaaaaaaaaaaaaaaaaaaa.png"]) expect(await getPublicBlob(store, key)).toBeNull();
    expect(await getFile(t.db, store, "fil_missing")).toBeNull();
  });

  test("a public upload is served by its key with its stored type", async () => {
    const { file, image } = await saveImageUpload(t.db, store, png(), { visibility: "public", kind: "product_image", now: NOW });
    expect(file.storageKey).toMatch(/^pub_[A-Za-z0-9_-]{24}\.png$/);
    expect(isPublicStorageKey(file.storageKey)).toBe(true);
    const blob = await getPublicBlob(store, file.storageKey);
    expect(blob?.meta).toEqual({ mime: "image/png", visibility: "public", sha256: image.sha256, bytes: image.bytes.length });
    expect(Buffer.from(blob!.bytes).equals(Buffer.from(image.bytes))).toBe(true);
    // Metadata must agree with the key: a blob stored as private under a public-looking key is not served.
    const forged = `pub_${randomToken(18)}.png`;
    await store.put(forged, image.bytes, { mime: "image/png", visibility: "private", sha256: image.sha256, bytes: image.bytes.length });
    expect(await getPublicBlob(store, forged)).toBeNull();
  });

  test("response headers keep files inert: fixed type, nosniff, sandbox, and no caching for private files", () => {
    const publicImage = fileHeaders({ mime: "image/webp", sha256: "abc", visibility: "public" });
    expect(Object.fromEntries(publicImage)).toMatchObject({
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      etag: '"abc"',
    });
    const privateImage = fileHeaders({ mime: "image/jpeg", sha256: "abc", visibility: "private" });
    expect(Object.fromEntries(privateImage)).toMatchObject({ "content-type": "image/jpeg", "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff" });

    // Anything that is not one of the three image types downloads, and unknown types lose their type.
    const pdf = fileHeaders({ mime: "application/pdf", sha256: "abc", visibility: "private", originalName: 'فاتورة "2026".pdf' });
    expect(pdf.get("Content-Type")).toBe("application/pdf");
    expect(pdf.get("Content-Disposition")).toMatch(/^attachment; filename="[\x20-\x7e]+"$/);
    for (const active of ["text/html", "image/svg+xml", "application/javascript", "application/xhtml+xml"]) {
      const headers = fileHeaders({ mime: active, sha256: "abc", visibility: "public" });
      expect(headers.get("Content-Type"), active).toBe("application/octet-stream");
      expect(headers.get("Content-Disposition"), active).toMatch(/^attachment/);
    }

    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const ok = fileResponse({ mime: "image/png", sha256: "abc", visibility: "public" }, bytes);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Length")).toBe("3");
    const cached = fileResponse({ mime: "image/png", sha256: "abc", visibility: "public" }, bytes, new Request("http://localhost/media/x", { headers: { "If-None-Match": 'W/"zzz", "abc"' } }));
    expect(cached.status).toBe(304);

    expect(sanitizeFileName("C:\\Users\\noor\\..\\proof.png")).toBe("proof.png");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName('a"b<c>d\u0000e.png')).toBe("abcde.png");
    expect(sanitizeFileName("..")).toBeNull();
    expect(sanitizeFileName("")).toBeNull();
  });

  test("changing visibility moves the file to a new key; deleting removes the bytes", async () => {
    const { file } = await saveImageUpload(t.db, store, png(), { visibility: "private", kind: "used_photo", now: NOW });
    const published = await setFileVisibility(t.db, store, file.id, "public");
    expect(published?.visibility).toBe("public");
    expect(published?.storageKey).toMatch(/^pub_/);
    expect(published?.storageKey).not.toBe(file.storageKey);
    expect(await getPublicBlob(store, published!.storageKey)).not.toBeNull();
    expect(await store.get(file.storageKey)).toBeNull();
    expect((await setFileVisibility(t.db, store, file.id, "public"))?.storageKey).toBe(published!.storageKey);

    const hidden = await setFileVisibility(t.db, store, file.id, "private");
    expect(hidden?.storageKey).toMatch(/^prv_/);
    expect(await getPublicBlob(store, published!.storageKey)).toBeNull();
    expect(await getFile(t.db, store, file.id)).not.toBeNull();

    expect(await deleteFile(t.db, store, file.id, NOW + MINUTE)).toBe(true);
    expect(await getFile(t.db, store, file.id)).toBeNull();
    expect(await store.get(hidden!.storageKey)).toBeNull();
    expect(await t.db.select().from(files).where(eq(files.id, file.id)).get()).toMatchObject({ deletedAt: NOW + MINUTE });
    expect(await deleteFile(t.db, store, file.id, NOW + MINUTE)).toBe(false);
    expect(await setFileVisibility(t.db, store, file.id, "public")).toBeNull();
  });

  test("when the row cannot be written, no bytes are left behind", async () => {
    const written: string[] = [];
    const deleted: string[] = [];
    const spy: BlobStore = {
      put: async (key, bytes, meta) => {
        written.push(key);
        await store.put(key, bytes, meta);
      },
      get: (key) => store.get(key),
      delete: async (key) => {
        deleted.push(key);
        await store.delete(key);
      },
    };
    // `kind` is NOT NULL: the insert is refused after the bytes were stored.
    await expect(putFile(t.db, spy, { bytes: new Uint8Array([1, 2, 3]), mime: "image/png", visibility: "private", kind: null as unknown as string, now: NOW })).rejects.toThrow();
    expect(written).toHaveLength(1);
    expect(deleted).toEqual(written);
    expect(await store.get(written[0])).toBeNull();
    await expect(putFile(t.db, store, { bytes: new Uint8Array(0), mime: "image/png", visibility: "private", kind: "x", now: NOW })).rejects.toThrow(/empty/);
  });
});

// ───────────────────────────────────────────────────────────────── outbox

describe("outbox", () => {
  test("with no provider configured every message is held, never sent", async () => {
    const result = await enqueueMessage(t.db, { channel: "sms", recipient: "+9647701230001", template: "order_confirmed", payload: { ref: "TT-7K4M2Q9X" }, refType: "order", refId: "ord_1", now: NOW });
    expect(result).toMatchObject({ status: "held", duplicate: false });
    expect(await t.db.select().from(outbox).where(eq(outbox.id, result.id)).get()).toMatchObject({ status: "held", attempts: 0, sentAt: null, nextAttemptAt: null, payload: { ref: "TT-7K4M2Q9X" } });
    expect(await deliverOutbox(t.db, {}, NOW + HOUR)).toEqual({ sent: 0, failed: 0, retrying: 0, skipped: 0 });
    expect(await scalar("SELECT status FROM outbox WHERE id = ?", result.id)).toBe("held");

    // As a batch item, with a dedupe key: the second one is skipped.
    const dedupeKey = `order_confirmed:${newId("ord")}`;
    const message = { channel: "whatsapp" as const, recipient: "+9647701230001", template: "order_confirmed", dedupeKey, now: NOW };
    await t.db.batch([outboxStatement(t.db, message)]);
    await t.db.batch([outboxStatement(t.db, message)]);
    expect(await scalar("SELECT count(*) FROM outbox WHERE dedupe_key = ?", dedupeKey)).toBe(1);
    const again = await enqueueMessage(t.db, message);
    expect(again).toMatchObject({ status: "held", duplicate: true });
  });

  test("the provider boundary: queued messages are sent once, failures retry and then stop", async () => {
    const delivered: OutgoingMessage[] = [];
    let failures = 0;
    const providers: MessageProviders = {
      email: {
        send: async (message) => {
          delivered.push(message);
          return { providerMessageId: `provider-${delivered.length}` };
        },
      },
      push: {
        send: async () => {
          failures++;
          throw new Error("provider unavailable");
        },
      },
    };
    const email = await enqueueMessage(t.db, { channel: "email", recipient: "noor@example.com", template: "receipt", payload: { ref: "TT-1" }, now: NOW }, providers);
    const push = await enqueueMessage(t.db, { channel: "push", recipient: "device-1", template: "order_shipped", now: NOW }, providers);
    const sms = await enqueueMessage(t.db, { channel: "sms", recipient: "+9647701230002", template: "order_shipped", now: NOW }, providers);
    expect([email.status, push.status, sms.status]).toEqual(["queued", "queued", "held"]);

    const first = await deliverOutbox(t.db, providers, NOW + MINUTE);
    expect(first).toMatchObject({ sent: 1, retrying: 1, failed: 0 });
    expect(delivered).toEqual([{ id: email.id, channel: "email", recipient: "noor@example.com", template: "receipt", payload: { ref: "TT-1" }, locale: null }]);
    expect(await t.db.select().from(outbox).where(eq(outbox.id, email.id)).get()).toMatchObject({ status: "sent", sentAt: NOW + MINUTE, attempts: 1, providerMessageId: "provider-1", lastError: null });
    expect(await t.db.select().from(outbox).where(eq(outbox.id, push.id)).get()).toMatchObject({ status: "queued", attempts: 1, lastError: "provider unavailable", nextAttemptAt: NOW + 2 * MINUTE });

    // Not due yet: nothing happens. A sent message is never sent again.
    expect(await deliverOutbox(t.db, providers, NOW + MINUTE + 1000)).toMatchObject({ sent: 0, retrying: 0, failed: 0 });
    expect(delivered).toHaveLength(1);

    let at = NOW + MINUTE;
    for (let attempt = 2; attempt <= 5; attempt++) {
      at += DAY;
      await deliverOutbox(t.db, providers, at);
    }
    expect(failures).toBe(5);
    expect(await t.db.select().from(outbox).where(eq(outbox.id, push.id)).get()).toMatchObject({ status: "failed", attempts: 5, nextAttemptAt: null });
    expect(await deliverOutbox(t.db, providers, at + DAY)).toMatchObject({ sent: 0, retrying: 0, failed: 0 });
    expect(failures).toBe(5);
    expect(await scalar("SELECT status FROM outbox WHERE id = ?", sms.id)).toBe("held");
  });

  test("sendOrHold: a secret reaches the provider in memory and is never stored", async () => {
    const seen: OutgoingMessage[] = [];
    const providers: MessageProviders = { sms: { send: async (message) => (seen.push(message), {}) } };
    const input = { channel: "sms" as const, recipient: "+9647701230003", template: "otp", payload: { purpose: "login" }, now: NOW };

    const held = await sendOrHold(t.db, input, { code: "424242" });
    expect(held.status).toBe("held");
    const sent = await sendOrHold(t.db, input, { code: "535353" }, providers);
    expect(sent.status).toBe("sent");
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ purpose: "login", code: "535353" });
    const stored = JSON.stringify(await t.db.select().from(outbox).where(eq(outbox.recipient, "+9647701230003")));
    expect(stored).not.toContain("424242");
    expect(stored).not.toContain("535353");

    const failing: MessageProviders = { sms: { send: async () => Promise.reject(new Error("gateway down")) } };
    const failed = await sendOrHold(t.db, input, { code: "646464" }, failing);
    expect(failed.status).toBe("failed");
    // A failed one-time code is not retried later (its secret is gone).
    expect(await deliverOutbox(t.db, failing, NOW + DAY)).toMatchObject({ sent: 0, retrying: 0, failed: 0 });
  });
});

// ───────────────────────────────────────────────────────────────── shell

describe("shell data", () => {
  test("a guest with no cookies: empty cart, no customer, cookie flags read", async () => {
    await t.db.delete(fxRates);
    const guest = request();
    expect(await loadShellData(guest.ctx, t.db)).toEqual({ cart: { count: 0 }, customer: null, fx: null, fxIsDemo: false, introSeen: false, personalizationConsent: null });
    expect(guest.setCookies).toEqual([]);
    expect(await loadShellData(request({ cookies: { tt_intro: "1", tt_consent: "1" } }).ctx, t.db)).toMatchObject({ introSeen: true, personalizationConsent: true });
    expect(await loadShellData(request({ cookies: { tt_intro: "0", tt_consent: "0" } }).ctx, t.db)).toMatchObject({ introSeen: false, personalizationConsent: false });
  });

  test("the exchange rate is the latest one already in effect, flagged when it is demo data", async () => {
    await t.db.insert(fxRates).values([
      { id: newId("fx"), quote: "USD", iqdPerUnit: 1300, source: "DEMO rate", isDemo: true, effectiveAt: NOW - 2 * DAY, createdAt: NOW - 2 * DAY },
      { id: newId("fx"), quote: "USD", iqdPerUnit: 1310, source: "TamTam store rate", isDemo: false, effectiveAt: NOW + DAY, createdAt: NOW },
      { id: newId("fx"), quote: "EUR", iqdPerUnit: 1500, source: "other currency", isDemo: false, effectiveAt: NOW - HOUR, createdAt: NOW },
    ]);
    expect(await loadShellData(request().ctx, t.db)).toMatchObject({ fx: { iqdPerUnit: { USD: 1300 }, source: "DEMO rate", updatedAt: NOW - 2 * DAY }, fxIsDemo: true });
    // Once the store's own rate takes effect, it replaces the demo one.
    expect(await loadShellData(request({ now: NOW + DAY }).ctx, t.db)).toMatchObject({ fx: { iqdPerUnit: { USD: 1310 }, source: "TamTam store rate", updatedAt: NOW + DAY }, fxIsDemo: false });
  });

  test("the cart badge counts the items of the cart behind tt_cart", async () => {
    const token = randomToken();
    const cartId = newId("crt");
    const first = await make.product({ stock: 5 });
    const second = await make.product({ stock: 5 });
    await t.db.insert(carts).values({ id: cartId, tokenHash: await sha256Hex(token), createdAt: NOW, updatedAt: NOW });
    expect((await loadShellData(request({ cookies: { tt_cart: token } }).ctx, t.db)).cart).toEqual({ count: 0 });

    await t.db.insert(cartItems).values([
      { id: newId("cit"), cartId, variantId: first.variantId, qty: 2, addedAt: NOW },
      { id: newId("cit"), cartId, variantId: second.variantId, qty: 3, addedAt: NOW },
    ]);
    expect((await loadShellData(request({ cookies: { tt_cart: token } }).ctx, t.db)).cart).toEqual({ count: 5 });
    // Someone else's token, a malformed cookie, or no cookie: zero.
    expect((await loadShellData(request({ cookies: { tt_cart: randomToken() } }).ctx, t.db)).cart).toEqual({ count: 0 });
    expect((await loadShellData(request({ cookies: { tt_cart: "'; DROP TABLE carts; --" } }).ctx, t.db)).cart).toEqual({ count: 0 });
    // The stored value is the hash, so the token itself opens nothing if used as a hash.
    expect(await scalar("SELECT count(*) FROM carts WHERE token_hash = ?", token)).toBe(0);
    // A cart that became an order no longer counts.
    await t.db.update(carts).set({ convertedOrderId: "ord_done" }).where(eq(carts.id, cartId));
    expect((await loadShellData(request({ cookies: { tt_cart: token } }).ctx, t.db)).cart).toEqual({ count: 0 });
  });

  test("the signed-in customer appears with a masked phone, and the lookup is shared with getCustomer", async () => {
    const phone = "+9647703000001";
    const signUp = request();
    const session = await signUpCustomer(signUp.ctx, t.db, { phone, password: "shell-password-1", name: "زينب" });
    const cookies = cookiesAfter(signUp);

    const page = request({ cookies, now: NOW + MINUTE });
    const shellPromise = loadShellData(page.ctx, t.db);
    // A route loader asking in the same tick gets the shell's lookup, not a second query.
    const fromLoader = getCustomer(page.ctx, t.db);
    const shell = await shellPromise;
    expect(shell.customer).toEqual({ id: session.customer.id, name: "زينب", phoneMasked: "0770 ••• ••01" });
    expect(JSON.stringify(shell)).not.toContain("7703000001");
    expect((await fromLoader)?.customer.id).toBe(session.customer.id);
    expect(await getCustomer(page.ctx, t.db)).toBe(await fromLoader);

    // The other order — loader first, then the shell — works too.
    const other = request({ cookies, now: NOW + MINUTE });
    const loaderFirst = getCustomer(other.ctx, t.db);
    expect((await loadShellData(other.ctx, t.db)).customer?.id).toBe(session.customer.id);
    expect((await loaderFirst)?.customer.id).toBe(session.customer.id);

    // A revoked session: no customer, and the dead cookie is cleared.
    await revokeAllCustomerSessions(t.db, session.customer.id, NOW + 2 * MINUTE);
    const after = request({ cookies, now: NOW + 3 * MINUTE });
    expect((await loadShellData(after.ctx, t.db)).customer).toBeNull();
    expect(parseSetCookie(after.setCookies[0])).toMatchObject({ name: "tt_sid", attributes: { "max-age": "0" } });
  });
});

// ───────────────────────────────────────────────────────────────── cross-checks

describe("database error mapping stays in step with the data layer", () => {
  test("guards raised by this module are read back through mapDbError", async () => {
    // The employee does not exist: the conditional update changes no row and the guard aborts the batch.
    const error = await thrown(() => disableEmployee(t.db, systemActor("test"), { employeeId: "emp_nobody", reason: "اختبار" }, NOW));
    expect(error).toMatchObject({ code: "employee_not_active", status: 409, detail: "emp_nobody" });
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'staff.employee.disable' AND entity_id = 'emp_nobody'")).toBe(0);
    expect(mapDbError(new Error("D1_ERROR: TT:LAST_OWNER:emp_1: SQLITE_CONSTRAINT"))).toMatchObject({ code: "LAST_OWNER", detail: "emp_1", status: 409 });
    expect(toAppError(new Error("D1_ERROR: TT:LAST_OWNER:emp_1: SQLITE_CONSTRAINT"))).toMatchObject({ code: "last_owner", detail: "emp_1", status: 409 });
  });
});

// ───────────────────────────────────────────────────────────────── error keys (keep last: it reads what the tests above saw)

describe("error keys", () => {
  test("every code and field key the core produced in this file is listed in CORE_ERROR_KEYS", () => {
    // Database rules (TT:<CODE>) belong to the data layer and the domain services, not to this list.
    const databaseRules = new Set(Object.keys(TRIGGER_ERROR_CODES).map((code) => code.toLowerCase()));
    const unlisted = [...seenErrorKeys].filter((key) => !databaseRules.has(key) && !(CORE_ERROR_KEYS as readonly string[]).includes(key));
    expect(seenErrorKeys.size).toBeGreaterThan(30);
    expect(unlisted).toEqual([]);
    expect(new Set(CORE_ERROR_KEYS).size).toBe(CORE_ERROR_KEYS.length);
    for (const key of CORE_ERROR_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
