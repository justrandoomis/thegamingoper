/**
 * Saved devices — the device models a customer says they own (brief §3.10, §6). The recommendation service uses them
 * later ("compatible with your device"); here the customer picks and removes them.
 *
 *   const options = await listDeviceOptions(db, locale);           // published models of active platforms
 *   const saved = await listSavedDevices(db, customerId, locale);
 *   await setSavedDevice(db, actor, deviceModelId, true, ctx.now);  // idempotent; false removes
 *   const ids = await listSavedDeviceIds(db, customerId);           // for recommendations (integration pass)
 *
 * Errors (AppError): device_unknown (404: not a published model), device_limit (409), unauthorized (401).
 * Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import type { CustomerActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, platforms, savedDevices } from "~/server/db/schema";
import { AppError, unauthorized } from "~/server/errors";
import type { DeviceOption } from "./types";

export const MAX_SAVED_DEVICES = 30;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const optionColumns = {
  id: deviceModels.id,
  slug: deviceModels.slug,
  name: deviceModels.name,
  artKey: deviceModels.artKey,
  kind: deviceModels.deviceKind,
  platformSlug: platforms.slug,
  platformName: platforms.name,
};

type OptionRow = { id: string; slug: string; name: Parameters<typeof pick>[0]; artKey: string | null; kind: string; platformSlug: string; platformName: Parameters<typeof pick>[0] };

const toOption = (row: OptionRow, locale: Locale): DeviceOption => ({
  id: row.id,
  slug: row.slug,
  name: pick(row.name, locale),
  platformSlug: row.platformSlug,
  platformName: pick(row.platformName, locale),
  artKey: row.artKey,
  kind: row.kind,
});

/** Every device model a customer can pick: published models of active platforms, by platform then model order. */
export async function listDeviceOptions(db: Db, locale: Locale): Promise<DeviceOption[]> {
  const rows = await db
    .select(optionColumns)
    .from(deviceModels)
    .innerJoin(platforms, eq(platforms.id, deviceModels.platformId))
    .where(and(eq(deviceModels.status, "published"), eq(platforms.isActive, true)))
    .orderBy(asc(platforms.sort), asc(deviceModels.sort), asc(deviceModels.slug));
  return rows.map((row) => toOption(row, locale));
}

/** The customer's saved devices, most recently added first (models that were unpublished since are left out). */
export async function listSavedDevices(db: Db, customerId: string, locale: Locale): Promise<DeviceOption[]> {
  const rows = await db
    .select(optionColumns)
    .from(savedDevices)
    .innerJoin(deviceModels, eq(deviceModels.id, savedDevices.deviceModelId))
    .innerJoin(platforms, eq(platforms.id, deviceModels.platformId))
    .where(and(eq(savedDevices.customerId, customerId), eq(deviceModels.status, "published")))
    .orderBy(desc(savedDevices.createdAt), asc(deviceModels.slug));
  return rows.map((row) => toOption(row, locale));
}

/** Ids of the customer's saved device models — what `getRecommendations` can take as signals. */
export async function listSavedDeviceIds(db: Db, customerId: string): Promise<string[]> {
  const rows = await db.select({ id: savedDevices.deviceModelId }).from(savedDevices).where(eq(savedDevices.customerId, customerId)).orderBy(desc(savedDevices.createdAt));
  return rows.map((row) => row.id);
}

/** Adds (`saved: true`) or removes a device model. Idempotent. */
export async function setSavedDevice(db: Db, actor: CustomerActor, deviceModelId: string, saved: boolean, now: number): Promise<{ saved: boolean }> {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  const customerId = actor.id;
  if (typeof deviceModelId !== "string" || !ID.test(deviceModelId)) throw new AppError("device_unknown", 404, { fields: { deviceModelId: "device_unknown" } });
  const mine = and(eq(savedDevices.customerId, customerId), eq(savedDevices.deviceModelId, deviceModelId));
  if (!saved) {
    await db.delete(savedDevices).where(mine);
    return { saved: false };
  }
  const model = await db.select({ status: deviceModels.status }).from(deviceModels).where(eq(deviceModels.id, deviceModelId)).get();
  if (!model || model.status !== "published") throw new AppError("device_unknown", 404, { fields: { deviceModelId: "device_unknown" } });
  if (await db.select({ id: savedDevices.deviceModelId }).from(savedDevices).where(mine).get()) return { saved: true };
  const count = Number((await db.select({ n: sql<number>`count(*)` }).from(savedDevices).where(eq(savedDevices.customerId, customerId)).get())?.n ?? 0);
  if (count >= MAX_SAVED_DEVICES) throw new AppError("device_limit", 409, { detail: String(MAX_SAVED_DEVICES) });
  await db.insert(savedDevices).values({ customerId, deviceModelId, createdAt: now }).onConflictDoNothing();
  return { saved: true };
}
