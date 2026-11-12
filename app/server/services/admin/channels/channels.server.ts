/**
 * 21.01 / 21.06 Sales channels (`channels`) and where each one takes its stock, prices and delivery from — an
 * overview of what the other modules already decide, never a second copy:
 *
 *   · stock     online store: every active sellable location (04; the core's getAvailability); POS: the store
 *               locations of the active registers (06); an added channel: nothing (no marketplace is connected)
 *   · prices    price lists scoped to the channel (03); only the POS applies them today (resolveListPrice, channel
 *               "pos") — the online checkout still sells at the variant price, which the overview says
 *   · delivery  online store: the governorate fee rule (11, getShippingPolicy); POS: at the counter
 *
 *   listChannels(db, actor, locale)                         channels.channel.manage | channels.report.read
 *   createChannel(db, actor, raw, now) → { channelId, replayed }   channels.channel.manage; marketplace / social only
 *   renameChannel(db, actor, raw, now) → { changed }        stale forms refused (fingerprint, every column guarded)
 *   setChannelActive(db, actor, raw, now) → { changed }     never the built-in web / pos (channel_system); switching
 *                                                           off is refused while active price lists target it
 *
 * The key is the reference other records keep (price_lists.channel, orders.channel): it never changes. Errors:
 * channel_changed, channel_system, channel_in_use, code_taken (field "key"), invalid, forbidden, not_found.
 * Must not import "cloudflare:workers".
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { channels } from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { getShippingPolicy } from "~/server/services/shipping/fees.server";
import { IdSchema, IdempotencyKey, OptionalReason, Reason, assertAny, fingerprintOf, guardError, keyedId } from "./shared.server";
import { CHANNEL_KEY_PATTERN, CHANNEL_KIND_LIST, NEW_CHANNEL_KINDS, SYSTEM_CHANNEL_KEYS, latinDigits, type ChannelKindName, type ChannelRow, type ChannelRules } from "./types";

const MANAGE = "channels.channel.manage";
export const CHANNEL_READERS = ["channels.channel.manage", "channels.report.read"] as const;
const GUARDS: Record<string, [string, number]> = { CHANNEL_CHANGED: ["channel_changed", 409], CHANNEL_IN_USE: ["channel_in_use", 409] };

type RawChannel = { id: string; key: string; nameRaw: string; kind: string; isActive: number; isSystem: number; configRaw: string | null; createdAt: number };

async function rawChannels(db: Db, where?: { id: string }): Promise<RawChannel[]> {
  return db.all<RawChannel>(sql`
    SELECT id, key, name AS nameRaw, kind, is_active AS isActive, is_system AS isSystem, config AS configRaw, created_at AS createdAt
    FROM channels ${where ? sql`WHERE id = ${where.id}` : sql``}
    ORDER BY is_system DESC, CASE key WHEN 'web' THEN 0 WHEN 'pos' THEN 1 ELSE 2 END, created_at, key`);
}

function nameOf(raw: string): L10n | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && typeof (value as L10n).ar === "string" ? (value as L10n) : null;
  } catch {
    return null;
  }
}

const fingerprint = (row: RawChannel) => fingerprintOf([row.key, row.nameRaw, row.kind, Number(row.isActive), Number(row.isSystem), row.configRaw]);

const isSystemKey = (key: string) => (SYSTEM_CHANNEL_KEYS as readonly string[]).includes(key);
const kindOf = (value: string): ChannelKindName => ((CHANNEL_KIND_LIST as readonly string[]).includes(value) ? (value as ChannelKindName) : "marketplace");

export async function listChannels(db: Db, actor: Actor, locale: Locale): Promise<ChannelRow[]> {
  assertAny(actor, CHANNEL_READERS);
  const [rows, policy, sellable, registers, lists] = await Promise.all([
    rawChannels(db),
    getShippingPolicy(db),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM inventory_locations WHERE is_active = 1 AND is_sellable = 1`),
    db.all<{ registers: number; stores: number }>(sql`SELECT count(*) AS registers, count(DISTINCT location_id) AS stores FROM pos_registers WHERE is_active = 1`),
    db.all<{ channel: string; n: number }>(sql`SELECT channel, count(*) AS n FROM price_lists WHERE is_active = 1 AND channel IS NOT NULL GROUP BY channel`),
  ]);
  const listsBy = new Map(lists.map((row) => [row.channel, Number(row.n)]));
  return Promise.all(
    rows.map(async (row): Promise<ChannelRow> => {
      const name = nameOf(row.nameRaw) ?? { ar: row.key };
      const system = Boolean(row.isSystem) && isSystemKey(row.key);
      let rules: ChannelRules;
      if (row.key === "web" && system) {
        rules = { stock: { kind: "sellable_locations", locations: Number(sellable[0]?.n ?? 0) }, prices: { activeLists: listsBy.get("web") ?? 0, applied: false }, delivery: { kind: "governorate_fee", ...policy } };
      } else if (row.key === "pos" && system) {
        rules = {
          stock: { kind: "register_stores", stores: Number(registers[0]?.stores ?? 0), registers: Number(registers[0]?.registers ?? 0) },
          prices: { activeLists: listsBy.get("pos") ?? 0, applied: true },
          delivery: { kind: "counter" },
        };
      } else {
        rules = { stock: { kind: "none" }, prices: { activeLists: listsBy.get(row.key) ?? 0, applied: false }, delivery: { kind: "not_connected" } };
      }
      return {
        id: row.id,
        key: row.key,
        name: pick(name, locale) || row.key,
        nameAr: name.ar,
        nameEn: name.en ?? "",
        kind: kindOf(row.kind),
        isSystem: system,
        isActive: Boolean(row.isActive),
        connected: system,
        rules,
        fingerprint: await fingerprint(row),
      };
    }),
  );
}

// ───────────────────────────────────────────────────────────────── changes

const CreateChannelInput = z.object({
  // digits typed with an Arabic keyboard (Arabic-Indic, Persian) are read as digits, as in a branch code
  key: z
    .string({ error: "required" })
    .trim()
    .transform((value) => latinDigits(value).toLowerCase())
    .pipe(
      z
        .string()
        .min(1, "required")
        .regex(CHANNEL_KEY_PATTERN, "key_invalid")
        .refine((value) => !isSystemKey(value), "key_reserved"),
    ),
  nameAr: z.string({ error: "required" }).trim().min(1, "required").max(60, "too_long"),
  nameEn: z.string().trim().max(60, "too_long").optional(),
  kind: z.enum(NEW_CHANNEL_KINDS, { error: "required" }),
  reason: OptionalReason,
  idempotencyKey: IdempotencyKey,
});
const RenameChannelInput = z.object({
  channelId: IdSchema,
  nameAr: z.string({ error: "required" }).trim().min(1, "required").max(60, "too_long"),
  nameEn: z.string().trim().max(60, "too_long").optional(),
  fingerprint: z.string().trim().min(1, "required").max(64),
  reason: Reason,
});
const SetActiveInput = z.object({ channelId: IdSchema, active: z.boolean(), reason: Reason });

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid(zodFieldErrors(result.error));
  return result.data;
}

function audit(db: Db, actor: Actor, action: string, channelId: string, now: number, values: { before?: unknown; after?: unknown; reason?: string | null }): BatchStatement {
  return auditStatement(db, { actor, action, entityType: "channel", entityId: channelId, before: values.before, after: values.after, reason: values.reason ?? null, at: now });
}

export async function createChannel(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ channelId: string; replayed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(CreateChannelInput, raw);
  const channelId = await keyedId("chn", actor, input.idempotencyKey);
  const existing = await db.select({ key: channels.key }).from(channels).where(eq(channels.id, channelId)).get();
  if (existing) {
    if (existing.key !== input.key) throw new AppError("idempotency_mismatch", 409);
    return { channelId, replayed: true };
  }
  const name: L10n = input.nameEn ? { ar: input.nameAr, en: input.nameEn } : { ar: input.nameAr };
  try {
    await runBatch(db, [
      db.insert(channels).values({ id: channelId, key: input.key, name, kind: input.kind, isActive: true, isSystem: false, config: null, createdAt: now }),
      audit(db, actor, "channels.channel.create", channelId, now, { after: { key: input.key, name, kind: input.kind }, reason: input.reason ?? null }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "channels.id")) return { channelId, replayed: true };
    if (isUniqueViolation(error, "channels.key")) throw invalid({ key: "code_taken" });
    throw error;
  }
  return { channelId, replayed: false };
}

export async function renameChannel(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(RenameChannelInput, raw);
  const [before] = await rawChannels(db, { id: input.channelId });
  if (!before) throw notFound("channel");
  if ((await fingerprint(before)) !== input.fingerprint) throw new AppError("channel_changed", 409);
  const name: L10n = input.nameEn ? { ar: input.nameAr, en: input.nameEn } : { ar: input.nameAr };
  const old = nameOf(before.nameRaw);
  if (JSON.stringify(old) === JSON.stringify(name)) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(channels)
        .set({ name })
        .where(and(eq(channels.id, before.id), sql`name = ${before.nameRaw}`, eq(channels.isActive, Boolean(before.isActive)))),
      expectChanged(db, 1, { code: "CHANNEL_CHANGED", detail: before.id }),
      audit(db, actor, "channels.channel.rename", before.id, now, { before: { name: old }, after: { name }, reason: input.reason }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

export async function setChannelActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(SetActiveInput, raw);
  const [before] = await rawChannels(db, { id: input.channelId });
  if (!before) throw notFound("channel");
  // the built-in channels are what the checkout and the till sell through; nothing here can switch them off
  if (Boolean(before.isSystem) || isSystemKey(before.key)) throw new AppError("channel_system", 409);
  if (Boolean(before.isActive) === input.active) return { changed: false };
  const statements: BatchStatement[] = [
    db
      .update(channels)
      .set({ isActive: input.active })
      .where(and(eq(channels.id, before.id), eq(channels.isActive, !input.active))),
    expectChanged(db, 1, { code: "CHANNEL_CHANGED", detail: before.id }),
  ];
  if (!input.active) statements.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM price_lists WHERE channel = ${before.key} AND is_active = 1)`, { code: "CHANNEL_IN_USE", detail: before.id }));
  statements.push(audit(db, actor, input.active ? "channels.channel.activate" : "channels.channel.deactivate", before.id, now, { before: { isActive: Boolean(before.isActive) }, after: { isActive: input.active }, reason: input.reason }));
  try {
    await runBatch(db, statements);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

/** Channel key → its name in the locale (the built-in ones and every added one). */
export async function channelNames(db: Db, locale: Locale): Promise<Map<string, { name: string; connected: boolean }>> {
  const rows = await rawChannels(db);
  return new Map(rows.map((row) => [row.key, { name: pick(nameOf(row.nameRaw) ?? { ar: row.key }, locale) || row.key, connected: Boolean(row.isSystem) && isSystemKey(row.key) }]));
}
