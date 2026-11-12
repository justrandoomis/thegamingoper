/**
 * 21.05 Payment, shipping and messaging providers — the registry (`integrations`) with an honest state.
 *
 *   listProviders(db, actor, locale)                     channels.integration.read | channels.integration.manage
 *       the catalogue (types.ts PROVIDER_CATALOG: payment and messaging providers that operate in Iraq) plus the
 *       store's own third-party couriers (module 11) as shipping providers, each with what is saved: the non-secret
 *       settings, whether a secret is stored (never the secret), who saved it and when.
 *   saveProviderCredentials(db, actor, dataKey, raw, now) → { changed }      channels.integration.manage
 *       the settings of the provider's form and its secret, encrypted with DATA_KEY (AES-256-GCM, bound to
 *       "integration:<kind>:<provider>:secret"); a secret left empty keeps the stored one. Guarded on the row's
 *       updated_at as the form read it (integration_changed). An address setting (`url` fields: an endpoint the adapter
 *       to come would call) is kept only as https on 443 with a public host name — the webhook rule (checkWebhookUrl),
 *       so no stored setting points an adapter at a metadata, private or local address.
 *   clearProviderCredentials(db, actor, raw, now) → { changed }              the secret removed, settings kept
 *
 * NOT CONNECTED, ALWAYS: no adapter that talks to any provider is built, so `status` stays "disabled" whatever is
 * saved, nothing claims a test passed, and the outbox keeps holding messages (outbox.server.ts NO_PROVIDERS). The
 * secret is never returned, logged or put in an audit event (the event says "a secret was saved", its length never).
 * Errors: data_key_missing (503), provider_unknown (404), integration_changed (409), credentials_missing,
 * invalid (fields), forbidden. Must not import "cloudflare:workers".
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { encryptSecret } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { carriers, integrations } from "~/server/db/schema";
import { expectChanged, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, zodFieldErrors } from "~/server/errors";
import { Reason, assertAny, employeeNames, guardError } from "./shared.server";
import { CARRIER_FIELDS, CARRIER_PROVIDER_PREFIX, PROVIDER_CATALOG, type PersonRef, type ProviderField, type ProviderKind, type ProviderState } from "./types";
import { checkWebhookUrl } from "./webhooks.server";

const MANAGE = "channels.integration.manage";
export const PROVIDER_READERS = ["channels.integration.read", "channels.integration.manage"] as const;
const GUARDS: Record<string, [string, number]> = { INTEGRATION_CHANGED: ["integration_changed", 409] };
const SECRET_MAX = 2000;

export type ProviderView = {
  key: string;
  kind: ProviderKind;
  name: string;
  fields: readonly ProviderField[];
  carries: readonly string[];
  /** A courier of module 11 (its own name, written by the store). */
  carrier: { id: string; code: string; isActive: boolean; isDemo: boolean } | null;
  state: ProviderState;
  /** Always false: no adapter exists. Kept explicit so no screen can show "connected". */
  connected: false;
  config: Record<string, string>;
  hasSecret: boolean;
  savedBy: PersonRef;
  savedAt: number | null;
  /** The row's updated_at as read — a save must still match it (null: nothing saved yet). */
  expected: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
};

const secretContext = (kind: string, provider: string) => `integration:${kind}:${provider}:secret`;

type Definition = { key: string; kind: ProviderKind; name: string; fields: readonly ProviderField[]; carries: readonly string[]; carrier: ProviderView["carrier"] };

async function definitions(db: Db): Promise<Definition[]> {
  const couriers = await db
    .select({ id: carriers.id, code: carriers.code, name: carriers.name, kind: carriers.kind, isActive: carriers.isActive, isDemo: carriers.isDemo })
    .from(carriers)
    .where(eq(carriers.kind, "third_party"))
    .orderBy(carriers.name);
  return [
    ...PROVIDER_CATALOG.filter((def) => def.kind === "payment").map((def) => ({ key: def.key, kind: def.kind, name: def.name, fields: def.fields, carries: def.carries ?? [], carrier: null })),
    ...couriers.map((courier) => ({
      key: `${CARRIER_PROVIDER_PREFIX}${courier.id}`,
      kind: "shipping" as const,
      name: courier.name,
      fields: CARRIER_FIELDS,
      carries: [],
      carrier: { id: courier.id, code: courier.code, isActive: courier.isActive, isDemo: courier.isDemo },
    })),
    ...PROVIDER_CATALOG.filter((def) => def.kind === "messaging").map((def) => ({ key: def.key, kind: def.kind, name: def.name, fields: def.fields, carries: def.carries ?? [], carrier: null })),
  ];
}

export async function listProviders(db: Db, actor: Actor, _locale: Locale): Promise<ProviderView[]> {
  assertAny(actor, PROVIDER_READERS);
  const [defs, rows] = await Promise.all([
    definitions(db),
    db
      .select({ kind: integrations.kind, provider: integrations.provider, config: integrations.config, hasSecret: sql<number>`${integrations.secretEnc} IS NOT NULL`, updatedBy: integrations.updatedBy, updatedAt: integrations.updatedAt, lastError: integrations.lastError, lastErrorAt: integrations.lastErrorAt })
      .from(integrations),
  ]);
  const byKey = new Map(rows.map((row) => [`${row.kind}|${row.provider}`, row]));
  const names = await employeeNames(
    db,
    rows.map((row) => row.updatedBy),
  );
  return defs.map((def) => {
    const row = byKey.get(`${def.kind}|${def.key}`);
    const config: Record<string, string> = {};
    for (const field of def.fields) {
      const value = row?.config?.[field.key];
      if (typeof value === "string" && value) config[field.key] = value;
    }
    const hasSecret = Boolean(row?.hasSecret);
    return {
      ...def,
      state: hasSecret ? "credentials_saved" : "not_connected",
      connected: false as const,
      config,
      hasSecret,
      savedBy: row?.updatedBy ? { id: row.updatedBy, name: names.get(row.updatedBy) ?? row.updatedBy } : null,
      savedAt: row ? row.updatedAt : null,
      expected: row ? row.updatedAt : null,
      lastError: row?.lastError ?? null,
      lastErrorAt: row?.lastErrorAt ?? null,
    };
  });
}

const SaveInput = z.object({
  provider: z.string({ error: "required" }).trim().min(1, "required").max(120),
  config: z.record(z.string(), z.string()).default({}),
  secret: z.string().max(SECRET_MAX, "too_long").optional(),
  /** The row's updated_at the form was built from; empty = there was no row. */
  expected: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : Number(value)), z.number().int().nullable()),
  reason: Reason,
});

const ClearInput = z.object({ provider: z.string({ error: "required" }).trim().min(1, "required").max(120), reason: Reason });

async function definitionOf(db: Db, provider: string): Promise<Definition> {
  const def = (await definitions(db)).find((entry) => entry.key === provider);
  if (!def) throw new AppError("provider_unknown", 404);
  return def;
}

export async function saveProviderCredentials(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const parsed = SaveInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
  const input = parsed.data;
  const def = await definitionOf(db, input.provider);
  const fields: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const field of def.fields) {
    const value = (input.config[field.key] ?? "").trim();
    if (value.length > field.max) fields[`config.${field.key}`] = "too_long";
    else if (/[\u0000-\u001f]/.test(value)) fields[`config.${field.key}`] = "value_invalid";
    else if (value && field.url) {
      const checked = checkWebhookUrl(value);
      if ("error" in checked) fields[`config.${field.key}`] = checked.error;
      else config[field.key] = checked.url;
    } else if (value) config[field.key] = value;
  }
  const secret = (input.secret ?? "").trim();
  if (Object.keys(fields).length) throw invalid(fields);

  const row = await db.select({ id: integrations.id, updatedAt: integrations.updatedAt, hasSecret: sql<number>`${integrations.secretEnc} IS NOT NULL`, config: integrations.config }).from(integrations).where(and(eq(integrations.kind, def.kind), eq(integrations.provider, def.key))).get();
  if ((row?.updatedAt ?? null) !== input.expected) throw new AppError("integration_changed", 409);
  if (!secret && !row?.hasSecret) throw invalid({ secret: "secret_required" });
  const sameConfig = JSON.stringify(row?.config ?? {}) === JSON.stringify(config);
  if (row && !secret && sameConfig) return { changed: false };
  let secretEnc: string | undefined;
  if (secret) {
    if (!dataKey) throw new AppError("data_key_missing", 503);
    secretEnc = await encryptSecret(secret, dataKey, secretContext(def.kind, def.key));
  }
  const updatedBy = actor.kind === "employee" ? actor.id : null;
  const auditAfter = { provider: def.key, kind: def.kind, settings: Object.keys(config), secretSaved: Boolean(secret), status: "disabled" };
  try {
    if (row) {
      await runBatch(db, [
        db
          .update(integrations)
          .set({ config, ...(secretEnc ? { secretEnc } : {}), updatedBy, updatedAt: now })
          .where(and(eq(integrations.id, row.id), eq(integrations.updatedAt, row.updatedAt))),
        expectChanged(db, 1, { code: "INTEGRATION_CHANGED", detail: row.id }),
        auditStatement(db, { actor, action: "channels.integration.save", entityType: "integration", entityId: row.id, before: { settings: Object.keys(row.config ?? {}), secretSaved: Boolean(row.hasSecret) }, after: auditAfter, reason: input.reason, at: now }),
      ]);
    } else {
      const id = newId("int");
      await runBatch(db, [
        db.insert(integrations).values({ id, kind: def.kind, provider: def.key, name: def.name, status: "disabled", config, secretEnc: secretEnc ?? null, updatedBy, updatedAt: now }),
        auditStatement(db, { actor, action: "channels.integration.save", entityType: "integration", entityId: id, after: auditAfter, reason: input.reason, at: now }),
      ]);
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("integration_changed", 409);
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

export async function clearProviderCredentials(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const parsed = ClearInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
  const def = await definitionOf(db, parsed.data.provider);
  const row = await db.select({ id: integrations.id, updatedAt: integrations.updatedAt, hasSecret: sql<number>`${integrations.secretEnc} IS NOT NULL` }).from(integrations).where(and(eq(integrations.kind, def.kind), eq(integrations.provider, def.key))).get();
  if (!row || !row.hasSecret) throw new AppError("credentials_missing", 409);
  try {
    await runBatch(db, [
      db
        .update(integrations)
        .set({ secretEnc: null, status: "disabled", updatedBy: actor.kind === "employee" ? actor.id : null, updatedAt: now })
        .where(and(eq(integrations.id, row.id), sql`${integrations.secretEnc} IS NOT NULL`)),
      expectChanged(db, 1, { code: "INTEGRATION_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "channels.integration.clear", entityType: "integration", entityId: row.id, before: { secretSaved: true }, after: { secretSaved: false, status: "disabled" }, reason: parsed.data.reason, at: now }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

/** For the monitor and the home: how many providers have something saved (none is connected). */
export async function providerCounts(db: Db): Promise<{ withSecret: number; errors: { provider: string; kind: string; error: string; at: number | null }[] }> {
  const [saved, failing] = await Promise.all([
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM integrations WHERE secret_enc IS NOT NULL`),
    db.all<{ provider: string; kind: string; error: string; at: number | null }>(sql`SELECT provider, kind, last_error AS error, last_error_at AS at FROM integrations WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 10`),
  ]);
  return { withSecret: Number(saved[0]?.n ?? 0), errors: failing };
}
