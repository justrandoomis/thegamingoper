/**
 * Admin 17.01 — the home page: which sections it shows and in what order, and the HERO PIN (a product and a headline
 * per platform stage for a period, Iraq time). Rows live in `home_sections`: one row per section kind (sort and
 * shown or hidden), and `kind = "hero_pin"` rows for pins (config = { platform, productId, headline, deck }).
 *
 *   getHomeLayoutEditor(db, actor) · saveHomeLayout(db, actor, { order, hidden, version, reason }, now)
 *   listHeroPins(db, actor, locale, now) · getHeroPinEditor(db, actor, pinId | "new", locale, now)
 *   searchPinProducts(db, actor, { platform, q }, locale, now)
 *   saveHeroPin(db, actor, raw, now, { demo? })          a new pin is a draft; changes to a published pin wait in
 *                                                         `draft_config` until they are published (preview first)
 *   publishHeroPin · discardPinChanges · unpublishHeroPin (with a reason, audited)
 *   getHomeHero(db, now) · getHomeLayout(db)             ← the storefront's reads
 *
 * A pin is published only when: its window is real (start before end, end ahead, at most HERO_PIN_MAX_DAYS long);
 * the product is one the catalogue shows when the pin starts (published, or scheduled by then, and complete —
 * assertProductReady; content never publishes a product); the product is for that platform (the catalogue's
 * researched-platform rule, as the home page and the menu use it); it has a photo (the hero stands on the stage as its
 * photo); and no other published pin of that platform overlaps its window (checked, and guarded inside the batch).
 * The "personal" section (what is remembered, stop and delete) cannot be hidden: it holds the shopper's privacy
 * controls. Permission: cms.home.manage.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { ProductCardData } from "~/lib/dto";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { homeSections, type HomeSection } from "~/server/db/schema";
import { searchProductIds } from "~/server/db/search.server";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { getCardsByIds, researchedPlatformSql } from "~/server/services/catalog/cards.server";
import { MAX_SCHEDULE_AHEAD_MS } from "../catalog/rules";
import {
  DAY_MS,
  HERO_PIN_KIND,
  HERO_PIN_MAX_DAYS,
  HERO_PLATFORMS,
  HERO_TEXT,
  HOME_SECTIONS,
  LOCKED_HOME_SECTIONS,
  arrangeHomeSections,
  isHomeSection,
  liveStateOf,
  parseBaghdadLocal,
  readPinConfig,
  windowsOverlap,
  type HeroPinConfig,
  type HeroPlatform,
  type HomeSectionKind,
  type LiveState,
} from "./rules";
import { actorIdOf, assertProductReady, cmsError, parseInput, productReadiness, zL10n, zL10nRequired, zReason } from "./shared.server";

function conflictOf(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  if (info?.code === "PIN_OVERLAP") throw cmsError("pin_overlap", 409, { fields: { startsAt: "pin_overlap" } });
  throw error;
}

// ───────────────────────────────────────────────────────────────── the layout

export type HomeLayoutEditor = {
  sections: { kind: HomeSectionKind; visible: boolean; locked: boolean }[];
  /** The newest `updated_at` of the layout rows (0 while the page runs in its own order): posted back as the guard. */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
};

async function layoutRows(db: Db): Promise<HomeSection[]> {
  return db
    .select()
    .from(homeSections)
    .where(inArray(homeSections.kind, [...HOME_SECTIONS]))
    .orderBy(asc(homeSections.sort), asc(homeSections.id));
}

export async function getHomeLayoutEditor(db: Db, actor: Actor): Promise<HomeLayoutEditor> {
  assertCan(actor, "cms.home.manage");
  const rows = await layoutRows(db);
  const placed = rows.map((row) => ({ kind: row.kind as HomeSectionKind, visible: row.isActive }));
  const seen = new Set(placed.map((row) => row.kind));
  const ordered = [...placed, ...HOME_SECTIONS.filter((kind) => !seen.has(kind)).map((kind) => ({ kind, visible: true }))].filter((row, index, all) => isHomeSection(row.kind) && all.findIndex((other) => other.kind === row.kind) === index);
  const latest = rows.reduce<HomeSection | null>((best, row) => (!best || row.updatedAt > best.updatedAt ? row : best), null);
  return {
    sections: ordered.map((row) => ({ kind: row.kind, visible: row.visible || LOCKED_HOME_SECTIONS.has(row.kind), locked: LOCKED_HOME_SECTIONS.has(row.kind) })),
    version: latest?.updatedAt ?? 0,
    updatedAt: latest?.updatedAt ?? null,
    updatedBy: latest?.updatedBy ?? null,
  };
}

const LayoutInput = z.object({
  order: z.array(z.string()).min(1, "required").max(HOME_SECTIONS.length * 2, "too_long"),
  hidden: z.array(z.string()).max(HOME_SECTIONS.length, "too_long").default([]),
  version: z.coerce.number().int().min(0),
  reason: zReason(true),
});

/** Saves the order and what is hidden (never a locked section) in one guarded batch. */
export async function saveHomeLayout(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ order: HomeSectionKind[]; hidden: HomeSectionKind[] }> {
  assertCan(actor, "cms.home.manage");
  const input = parseInput(LayoutInput, raw);
  const order: HomeSectionKind[] = [];
  for (const kind of input.order) if (isHomeSection(kind) && !order.includes(kind)) order.push(kind);
  for (const kind of HOME_SECTIONS) if (!order.includes(kind)) order.push(kind);
  if (input.hidden.some((kind) => !isHomeSection(kind))) throw invalid({ hidden: "invalid" });
  if (input.hidden.some((kind) => LOCKED_HOME_SECTIONS.has(kind as HomeSectionKind))) throw invalid({ hidden: "section_locked" });
  const hidden = new Set(input.hidden as HomeSectionKind[]);
  const rows = await layoutRows(db);
  const current = rows.reduce((max, row) => Math.max(max, row.updatedAt), 0);
  if (current !== input.version) throw cmsError("content_changed", 409);
  const before = arrangeHomeSections(rows.map((row) => ({ kind: row.kind, visible: row.isActive })));
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const by = actorIdOf(actor);
  const statements: BatchStatement[] = [
    expectThat(db, sql`(SELECT COALESCE(MAX(updated_at), 0) FROM home_sections WHERE kind IN (${sql.join(HOME_SECTIONS.map((kind) => sql`${kind}`), sql`, `)})) = ${current}`, { code: "CONTENT_CHANGED", detail: "home_layout" }),
  ];
  order.forEach((kind, index) => {
    const row = byKind.get(kind);
    const isActive = !hidden.has(kind);
    if (row) statements.push(db.update(homeSections).set({ sort: index, isActive, updatedBy: by, updatedAt: now }).where(eq(homeSections.id, row.id)));
    else statements.push(db.insert(homeSections).values({ id: newId("hs"), kind, sort: index, isActive, updatedBy: by, updatedAt: now }));
  });
  const after = order.filter((kind) => !hidden.has(kind));
  statements.push(auditStatement(db, { actor, action: "cms.home.layout", entityType: "home", entityId: "layout", before: { shown: before }, after: { shown: after, hidden: [...hidden] }, reason: input.reason, at: now }));
  await runBatch(db, statements).catch(conflictOf);
  return { order, hidden: [...hidden] };
}

/** The storefront's read: the home sections to draw below the hero, in order (the page's own order until staff arranged it). */
export async function getHomeLayout(db: Db): Promise<HomeSectionKind[]> {
  const rows = await layoutRows(db);
  return arrangeHomeSections(rows.map((row) => ({ kind: row.kind, visible: row.isActive })));
}

// ───────────────────────────────────────────────────────────────── hero pins

export type PinState = "draft" | LiveState;

export type HeroPinRow = {
  id: string;
  platform: HeroPlatform | null;
  productId: string | null;
  productName: string | null;
  headline: string;
  startsAt: number | null;
  endsAt: number | null;
  published: boolean;
  state: PinState;
  /** Changes to a published pin that wait to be published. */
  pending: boolean;
  isDemo: boolean;
  updatedAt: number;
};

function stateOf(row: HomeSection, now: number): PinState {
  if (!row.isActive) return "draft";
  return liveStateOf({ status: "published", startsAt: row.startsAt, endsAt: row.endsAt }, now);
}

async function productNames(db: Db, ids: readonly string[], locale: Locale): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM products WHERE id IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`);
  return new Map(
    rows.map((row) => {
      let name: L10n | null = null;
      try {
        name = JSON.parse(row.name) as L10n;
      } catch {
        name = null;
      }
      return [row.id, pick(name, locale)];
    }),
  );
}

export async function listHeroPins(db: Db, actor: Actor, locale: Locale, now: number): Promise<HeroPinRow[]> {
  assertCan(actor, "cms.home.manage");
  const rows = await db.select().from(homeSections).where(eq(homeSections.kind, HERO_PIN_KIND)).orderBy(desc(homeSections.isActive), asc(homeSections.startsAt), desc(homeSections.updatedAt));
  const configs = rows.map((row) => readPinConfig(row.draftConfig ?? row.config));
  const names = await productNames(db, configs.map((config) => config?.productId ?? ""), locale);
  return rows.map((row, index) => {
    const live = readPinConfig(row.config);
    const shown = configs[index];
    return {
      id: row.id,
      platform: (live ?? shown)?.platform ?? null,
      productId: (live ?? shown)?.productId ?? null,
      productName: names.get((live ?? shown)?.productId ?? "") ?? null,
      headline: pick((live ?? shown)?.headline ?? null, locale),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      published: row.isActive,
      state: stateOf(row, now),
      pending: row.draftConfig !== null,
      isDemo: row.isDemo,
      updatedAt: row.updatedAt,
    };
  });
}

export type PinProduct = { id: string; name: string; slug: string; card: ProductCardData | null; readiness: { ok: boolean; reason: string | null; missing: string[] } };

export type HeroPinEditor = {
  pin: { id: string; published: boolean; state: PinState; pending: boolean; isDemo: boolean; version: number } | null;
  /** What the form shows: the pending changes of a published pin, else its config. */
  values: (HeroPinConfig & { startsAt: number | null; endsAt: number | null }) | null;
  /** The published values while changes wait (to compare). */
  liveValues: (HeroPinConfig & { startsAt: number | null; endsAt: number | null }) | null;
  product: PinProduct | null;
  overlaps: { id: string; startsAt: number | null; endsAt: number | null; headline: string }[];
};

type StagedConfig = HeroPinConfig & { startsAt?: number | null; endsAt?: number | null };

async function pinProduct(db: Db, productId: string, locale: Locale, at: number, now: number): Promise<PinProduct | null> {
  const [readiness, cards, names] = await Promise.all([productReadiness(db, productId, at), getCardsByIds(db, locale, [productId], { now }), db.all<{ slug: string; name: string }>(sql`SELECT slug, name FROM products WHERE id = ${productId}`)]);
  const row = names[0];
  if (!row) return null;
  let name = row.slug;
  try {
    name = pick(JSON.parse(row.name) as L10n, locale) || row.slug;
  } catch {
    /* the slug */
  }
  return { id: productId, name, slug: row.slug, card: cards[0] ?? null, readiness: readiness.ok ? { ok: true, reason: null, missing: [] } : { ok: false, reason: readiness.reason, missing: readiness.missing } };
}

/** A product chosen in the pin editor: its card (price, photo, stock state) and whether the catalogue shows it at `at`. */
export async function pinProductOf(db: Db, actor: Actor, productId: string, locale: Locale, at: number, now: number): Promise<PinProduct | null> {
  assertCan(actor, "cms.home.manage");
  return pinProduct(db, productId, locale, at, now);
}

export async function getHeroPinEditor(db: Db, actor: Actor, pinId: string, locale: Locale, now: number): Promise<HeroPinEditor> {
  assertCan(actor, "cms.home.manage");
  if (pinId === "new") return { pin: null, values: null, liveValues: null, product: null, overlaps: [] };
  const row = await db.select().from(homeSections).where(and(eq(homeSections.id, pinId), eq(homeSections.kind, HERO_PIN_KIND))).get();
  if (!row) throw notFound("pin");
  const live = readPinConfig(row.config);
  const staged = row.draftConfig ? (readPinConfig(row.draftConfig) as StagedConfig | null) : null;
  const stagedWindow = (row.draftConfig ?? {}) as { startsAt?: number | null; endsAt?: number | null };
  const values = staged ? { ...staged, startsAt: stagedWindow.startsAt ?? row.startsAt, endsAt: stagedWindow.endsAt ?? row.endsAt } : live ? { ...live, startsAt: row.startsAt, endsAt: row.endsAt } : null;
  const product = values ? await pinProduct(db, values.productId, locale, Math.max(now, values.startsAt ?? now), now) : null;
  const others = values ? await overlapping(db, values.platform, values.startsAt, values.endsAt, row.id) : [];
  return {
    pin: { id: row.id, published: row.isActive, state: stateOf(row, now), pending: row.draftConfig !== null, isDemo: row.isDemo, version: row.updatedAt },
    values,
    liveValues: staged && live ? { ...live, startsAt: row.startsAt, endsAt: row.endsAt } : null,
    product,
    overlaps: others.map((other) => ({ id: other.id, startsAt: other.startsAt, endsAt: other.endsAt, headline: pick(readPinConfig(other.config)?.headline ?? null, locale) })),
  };
}

/** Published pins of a platform whose window overlaps [startsAt, endsAt) (excluding one pin). */
async function overlapping(db: Db, platform: HeroPlatform, startsAt: number | null, endsAt: number | null, exceptId: string | null): Promise<HomeSection[]> {
  const rows = await db
    .select()
    .from(homeSections)
    .where(and(eq(homeSections.kind, HERO_PIN_KIND), eq(homeSections.isActive, true), exceptId ? ne(homeSections.id, exceptId) : undefined));
  return rows.filter((row) => readPinConfig(row.config)?.platform === platform && windowsOverlap({ startsAt: row.startsAt, endsAt: row.endsAt }, { startsAt, endsAt }));
}

export type PinCandidate = { id: string; name: string; card: ProductCardData | null; ready: boolean; reason: string | null };

/** Products for one platform stage (the catalogue's researched-platform rule), found by name/SKU or the newest first. */
export async function searchPinProducts(db: Db, actor: Actor, input: { platform: string; q: string }, locale: Locale, now: number): Promise<PinCandidate[]> {
  assertCan(actor, "cms.home.manage");
  if (!(HERO_PLATFORMS as readonly string[]).includes(input.platform)) return [];
  const q = input.q.trim().slice(0, 80);
  const hits = q ? (await searchProductIds(db, q, { limit: 40 })).map((hit) => hit.productId) : null;
  const rows = await db.all<{ id: string; name: string }>(sql`
    SELECT p.id, p.name FROM products AS p JOIN platforms AS pl ON pl.slug = ${input.platform}
    WHERE p.status IN ('published', 'scheduled') AND ${researchedPlatformSql("p", "pl")}
      ${hits ? sql`AND p.id IN (SELECT value FROM json_each(${JSON.stringify(hits)}))` : sql``}
    ORDER BY CASE p.kind WHEN 'console' THEN 0 ELSE 1 END, COALESCE(p.published_at, p.publish_at, p.created_at) DESC, p.id
    LIMIT 12`);
  const cards = new Map((await getCardsByIds(db, locale, rows.map((row) => row.id), { now })).map((card) => [card.id, card]));
  const out: PinCandidate[] = [];
  for (const row of rows) {
    let name = row.id;
    try {
      name = pick(JSON.parse(row.name) as L10n, locale) || row.id;
    } catch {
      /* the id */
    }
    const readiness = await productReadiness(db, row.id, now);
    out.push({ id: row.id, name, card: cards.get(row.id) ?? null, ready: readiness.ok, reason: readiness.ok ? null : readiness.reason });
  }
  return out;
}

const zLocalRequired = z.string({ error: "required" }).trim().min(1, "required");

export const PinInput = z.object({
  pinId: z.string().trim().min(1).max(128).optional(),
  version: z.coerce.number().int().optional(),
  platform: z.enum(HERO_PLATFORMS, { error: "required" }),
  productId: z.string({ error: "required" }).trim().min(1, "required").max(128, "invalid"),
  headline: zL10nRequired(HERO_TEXT.headline),
  deck: zL10n(HERO_TEXT.deck, false),
  startsAt: zLocalRequired,
  endsAt: zLocalRequired,
});

/** The window of a pin from the form, checked (Iraq time). */
function windowOf(input: { startsAt: string; endsAt: string }, now: number, requireFuture: boolean): { startsAt: number; endsAt: number } {
  const startsAt = parseBaghdadLocal(input.startsAt);
  const endsAt = parseBaghdadLocal(input.endsAt);
  const fields: Record<string, string> = {};
  if (startsAt === null) fields.startsAt = "invalid";
  if (endsAt === null) fields.endsAt = "invalid";
  if (Object.keys(fields).length) throw invalid(fields);
  if (endsAt! <= startsAt!) throw invalid({ endsAt: "schedule_order" });
  if (endsAt! - startsAt! > HERO_PIN_MAX_DAYS * DAY_MS) throw cmsError("pin_window", 400, { fields: { endsAt: "pin_window" } });
  if (requireFuture && endsAt! <= now) throw invalid({ endsAt: "schedule_past" });
  if (startsAt! > now + MAX_SCHEDULE_AHEAD_MS) throw invalid({ startsAt: "schedule_far" });
  return { startsAt: startsAt!, endsAt: endsAt! };
}

/** Everything a pin must satisfy to be published (see the file header). */
async function assertPublishable(db: Db, config: HeroPinConfig, window: { startsAt: number; endsAt: number }, now: number, exceptId: string | null): Promise<void> {
  if (window.endsAt <= now) throw invalid({ endsAt: "schedule_past" });
  await assertProductReady(db, config.productId, Math.max(now, window.startsAt));
  const [platform, photo] = await Promise.all([
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM products AS p JOIN platforms AS pl ON pl.slug = ${config.platform} WHERE p.id = ${config.productId} AND ${researchedPlatformSql("p", "pl")}`),
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM media WHERE owner_type = 'product' AND owner_id = ${config.productId} AND kind IN ('image', 'render') AND art_key IS NOT NULL`),
  ]);
  if (Number(platform[0]?.n ?? 0) === 0) throw cmsError("pin_platform", 409, { fields: { productId: "pin_platform" } });
  if (Number(photo[0]?.n ?? 0) === 0) throw cmsError("pin_photo", 409, { fields: { productId: "pin_photo" } });
  const others = await overlapping(db, config.platform, window.startsAt, window.endsAt, exceptId);
  if (others.length > 0) throw cmsError("pin_overlap", 409, { fields: { startsAt: "pin_overlap" }, detail: others[0].id });
}

/** No other published pin of the platform overlaps — inside the batch, so two people publishing at once cannot both win. */
function noOverlapGuard(db: Db, platform: HeroPlatform, window: { startsAt: number; endsAt: number }, pinId: string): BatchStatement {
  return expectThat(
    db,
    sql`NOT EXISTS (SELECT 1 FROM home_sections WHERE kind = ${HERO_PIN_KIND} AND is_active = 1 AND id <> ${pinId} AND json_extract(config, '$.platform') = ${platform}
      AND COALESCE(starts_at, -1) < ${window.endsAt} AND COALESCE(ends_at, 9007199254740991) > ${window.startsAt})`,
    { code: "PIN_OVERLAP", detail: pinId },
  );
}

/**
 * Creates a pin (a draft) or saves one. A draft is saved as it is; a published pin keeps running as published and the
 * new values wait in `draft_config` (with their window) until publishHeroPin applies them.
 */
export async function saveHeroPin(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ pinId: string; created: boolean; staged: boolean }> {
  assertCan(actor, "cms.home.manage");
  const input = parseInput(PinInput, raw);
  const window = windowOf(input, now, false);
  const config: HeroPinConfig = { platform: input.platform, productId: input.productId, headline: input.headline, deck: input.deck };
  const known = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM products WHERE id = ${input.productId}`);
  if (Number(known[0]?.n ?? 0) === 0) throw cmsError("product_unknown", 404, { fields: { productId: "product_unknown" } });
  const by = actorIdOf(actor);
  if (!input.pinId) {
    const pinId = newId("pin");
    await runBatch(db, [
      db.insert(homeSections).values({ id: pinId, kind: HERO_PIN_KIND, config, sort: 0, isActive: false, startsAt: window.startsAt, endsAt: window.endsAt, isDemo: options.demo ?? false, updatedBy: by, updatedAt: now }),
      auditStatement(db, { actor, action: "cms.pin.create", entityType: "hero_pin", entityId: pinId, after: { ...config, ...window, demo: options.demo ?? false }, at: now }),
    ]);
    return { pinId, created: true, staged: false };
  }
  const row = await db.select().from(homeSections).where(and(eq(homeSections.id, input.pinId), eq(homeSections.kind, HERO_PIN_KIND))).get();
  if (!row) throw notFound("pin");
  if (input.version === undefined || row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  const set = row.isActive ? { draftConfig: { ...config, ...window } as Record<string, unknown> } : { config: config as Record<string, unknown>, startsAt: window.startsAt, endsAt: window.endsAt };
  await runBatch(db, [
    db.update(homeSections).set({ ...set, updatedBy: by, updatedAt: now }).where(and(eq(homeSections.id, row.id), eq(homeSections.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: row.isActive ? "cms.pin.stage" : "cms.pin.update", entityType: "hero_pin", entityId: row.id, before: { ...(readPinConfig(row.draftConfig ?? row.config) ?? {}), startsAt: row.startsAt, endsAt: row.endsAt }, after: { ...config, ...window }, at: now }),
  ]).catch(conflictOf);
  return { pinId: row.id, created: false, staged: row.isActive };
}

const DecideInput = z.object({ pinId: z.string().trim().min(1), version: z.coerce.number().int(), reason: zReason(true) });

/** Publishes a draft pin, or the waiting changes of a published one — after every check of the file header. */
export async function publishHeroPin(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ published: true }> {
  assertCan(actor, "cms.home.manage");
  const input = parseInput(DecideInput, raw);
  const row = await db.select().from(homeSections).where(and(eq(homeSections.id, input.pinId), eq(homeSections.kind, HERO_PIN_KIND))).get();
  if (!row) throw notFound("pin");
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (row.isActive && !row.draftConfig) throw cmsError("pin_no_changes", 409);
  const source = (row.isActive ? row.draftConfig : row.config) as StagedConfig | null;
  const config = readPinConfig(source);
  if (!config) throw cmsError("pin_not_found", 409);
  const window = { startsAt: (row.isActive ? source?.startsAt : row.startsAt) ?? row.startsAt ?? now, endsAt: (row.isActive ? source?.endsAt : row.endsAt) ?? row.endsAt ?? now };
  await assertPublishable(db, config, window, now, row.id);
  await runBatch(db, [
    noOverlapGuard(db, config.platform, window, row.id),
    db
      .update(homeSections)
      .set({ config: config as Record<string, unknown>, draftConfig: null, isActive: true, startsAt: window.startsAt, endsAt: window.endsAt, updatedBy: actorIdOf(actor), updatedAt: now })
      .where(and(eq(homeSections.id, row.id), eq(homeSections.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: row.isActive ? "cms.pin.apply" : "cms.pin.publish",
      entityType: "hero_pin",
      entityId: row.id,
      before: row.isActive ? { ...(readPinConfig(row.config) ?? {}), startsAt: row.startsAt, endsAt: row.endsAt } : { published: false },
      after: { ...config, ...window, published: true },
      reason: input.reason,
      at: now,
    }),
  ]).catch(conflictOf);
  return { published: true };
}

/** Drops the waiting changes of a published pin (it keeps running as published). */
export async function discardPinChanges(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ discarded: true }> {
  assertCan(actor, "cms.home.manage");
  const input = parseInput(DecideInput, raw);
  const row = await db.select().from(homeSections).where(and(eq(homeSections.id, input.pinId), eq(homeSections.kind, HERO_PIN_KIND))).get();
  if (!row) throw notFound("pin");
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (!row.draftConfig) throw cmsError("pin_no_changes", 409);
  await runBatch(db, [
    db.update(homeSections).set({ draftConfig: null, updatedBy: actorIdOf(actor), updatedAt: now }).where(and(eq(homeSections.id, row.id), eq(homeSections.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "cms.pin.discard", entityType: "hero_pin", entityId: row.id, reason: input.reason, at: now }),
  ]).catch(conflictOf);
  return { discarded: true };
}

/**
 * Takes a published pin off the home page (back to a draft): the platform's automatic hero returns at once. Changes
 * that were waiting become the draft's values — stopping a pin never throws away what someone wrote (review
 * 2026-11-12: they were dropped without a word).
 */
export async function unpublishHeroPin(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ unpublished: true }> {
  assertCan(actor, "cms.home.manage");
  const input = parseInput(DecideInput, raw);
  const row = await db.select().from(homeSections).where(and(eq(homeSections.id, input.pinId), eq(homeSections.kind, HERO_PIN_KIND))).get();
  if (!row) throw notFound("pin");
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (!row.isActive) throw cmsError("content_changed", 409);
  const staged = row.draftConfig as StagedConfig | null;
  const stagedConfig = staged ? readPinConfig(staged) : null;
  const kept = stagedConfig ? { config: stagedConfig as Record<string, unknown>, startsAt: staged?.startsAt ?? row.startsAt, endsAt: staged?.endsAt ?? row.endsAt } : {};
  await runBatch(db, [
    db.update(homeSections).set({ ...kept, isActive: false, draftConfig: null, updatedBy: actorIdOf(actor), updatedAt: now }).where(and(eq(homeSections.id, row.id), eq(homeSections.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: "cms.pin.unpublish",
      entityType: "hero_pin",
      entityId: row.id,
      before: { published: true, startsAt: row.startsAt, endsAt: row.endsAt },
      after: { published: false, ...(stagedConfig ? { keptChanges: true, startsAt: kept.startsAt ?? null, endsAt: kept.endsAt ?? null } : {}) },
      reason: input.reason,
      at: now,
    }),
  ]).catch(conflictOf);
  return { unpublished: true };
}

// ───────────────────────────────────────────────────────────────── the storefront's read

export type HeroPinView = { pinId: string; platform: HeroPlatform; productId: string; headline: L10n; deck: L10n | null; startsAt: number; endsAt: number };

/**
 * The pinned heroes running now, at most one per platform: published, inside their window, not demo (unless
 * `includeDemo`), and only while the catalogue shows the product (published, or scheduled and due). The home page
 * still checks that the product can be bought and has its photo, and falls back to its automatic hero otherwise.
 */
export async function getHomeHero(db: Db, now: number, options: { includeDemo?: boolean } = {}): Promise<HeroPinView[]> {
  const rows = await db.all<{ id: string; config: string | null; starts_at: number; ends_at: number; updated_at: number }>(sql`
    SELECT hs.id, hs.config, hs.starts_at, hs.ends_at, hs.updated_at FROM home_sections AS hs
    JOIN products AS p ON p.id = json_extract(hs.config, '$.productId')
    WHERE hs.kind = ${HERO_PIN_KIND} AND hs.is_active = 1 ${options.includeDemo ? sql`` : sql`AND hs.is_demo = 0`}
      AND hs.starts_at IS NOT NULL AND hs.starts_at <= ${now} AND hs.ends_at IS NOT NULL AND hs.ends_at > ${now}
      AND (p.status = 'published' OR (p.status = 'scheduled' AND p.publish_at <= ${now}))
    ORDER BY hs.updated_at DESC, hs.id`);
  const out = new Map<HeroPlatform, HeroPinView>();
  for (const row of rows) {
    let config: HeroPinConfig | null = null;
    try {
      config = readPinConfig(row.config ? JSON.parse(row.config) : null);
    } catch {
      config = null;
    }
    if (!config || out.has(config.platform)) continue;
    out.set(config.platform, { pinId: row.id, platform: config.platform, productId: config.productId, headline: config.headline, deck: config.deck, startsAt: row.starts_at, endsAt: row.ends_at });
  }
  return [...out.values()];
}

/** Pins whose window touches [from, to] (the schedule). */
export async function pinsInRange(db: Db, from: number, to: number): Promise<HomeSection[]> {
  const rows = await db.select().from(homeSections).where(eq(homeSections.kind, HERO_PIN_KIND));
  return rows.filter((row) => windowsOverlap({ startsAt: row.startsAt, endsAt: row.endsAt }, { startsAt: from, endsAt: to }));
}
