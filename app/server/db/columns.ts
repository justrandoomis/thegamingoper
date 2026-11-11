/**
 * Column helpers shared by every schema file. They exist to keep the conventions of
 * docs/ARCHITECTURE.md §5.1 in one place:
 *
 *   ids         TEXT primary keys, values from newId("<prefix>") in ~/lib/ids
 *   timestamps  INTEGER epoch milliseconds, columns named *_at
 *   money       INTEGER Iraqi dinars, columns named *_iqd (never floats)
 *   flags       INTEGER 0/1, exposed to TypeScript as boolean
 *   L10n        JSON text `{ ar, en?, ckb? }`, read with pick(value, locale)
 *
 * This module must stay free of path-alias *value* imports: drizzle-kit loads the schema
 * with its own loader, which only understands relative imports (type-only imports are erased).
 */
import { sql } from "drizzle-orm";
import { integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { L10n } from "~/lib/locales";

/**
 * Return type for every `.references(() => …)` callback. Annotating it keeps TypeScript from
 * chasing circular inferences between tables that point at each other (orders ↔ payments, …).
 */
export type Ref = AnySQLiteColumn;

/** `id TEXT PRIMARY KEY`. */
export const id = () => text("id").primaryKey();

/** Epoch-milliseconds timestamp. */
export const at = (name: string) => integer(name);

/** Integer IQD amount. */
export const iqd = (name: string) => integer(name);

/** 0/1 column typed as boolean. */
export const flag = (name: string) => integer(name, { mode: "boolean" });

/** Localized text stored as JSON. */
export const l10n = (name: string) => text(name, { mode: "json" }).$type<L10n>();

/** Typed JSON column. */
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/**
 * SQL default "now, in epoch ms" for timestamp columns that exist as a safety net
 * (services still pass `ctx.now` so one request writes one timestamp).
 */
export const NOW_MS = sql`(unixepoch() * 1000)`;

/** Who did something. Mirrors `Actor["kind"]` in ~/server/actor. */
export const ACTOR_KINDS = ["guest", "customer", "employee", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/*
 * Enums used at module top level by more than one schema file live HERE, not in the schema files:
 * the schema files import each other in cycles (orders ↔ inventory ↔ used …), which is only safe
 * while cross-file imports are touched lazily, inside `.references(() => …)` callbacks.
 */

/** `products.kind`. Re-exported from schema/catalog. */
export const PRODUCT_KINDS = ["console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** A product kind, or "*" for "every kind" — used by rules that are scoped per kind. Re-exported from schema/catalog. */
export const PRODUCT_KIND_SCOPES = ["*", ...PRODUCT_KINDS] as const;
export type ProductKindScope = (typeof PRODUCT_KIND_SCOPES)[number];

/** What kind of hardware a device model is; selects the inspection template. Re-exported from schema/catalog. */
export const DEVICE_KINDS = ["console", "handheld_pc", "controller", "headset", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Compile-time proof that two unions are identical (used to keep schema enums and ~/lib/dto in step). */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Compile-time proof that `Sub` only contains members of `Super`. */
export type Subset<Sub, Super> = [Sub] extends [Super] ? true : never;

/**
 * Structured content block (see ARCHITECTURE §6): staff-authored content is stored as arrays of
 * blocks, never HTML or Markdown. The renderer (`<Blocks>`) owns the exact shape of each block;
 * the database only fixes the discriminator.
 */
export type StoredBlock = { type: "h2" | "p" | "ul" | "ol" | "steps" | "callout" | "table" | "art" } & Record<string, unknown>;
/** A localized block array: Arabic is always present. */
export type LocalizedBlocks = { ar: StoredBlock[]; en?: StoredBlock[]; ckb?: StoredBlock[] };
