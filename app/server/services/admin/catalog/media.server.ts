/**
 * Admin catalogue — the media gallery of a product and its variants (02.04, catalog.media.manage).
 *
 *   const gallery = await getGallery(db, actor, productId, locale);
 *   await addUploadedImage(db, store, actor, { productId, variantId?, file, alt, isIllustration }, now);
 *   await addCatalogPhoto(db, actor, { productId, variantId?, artKey, alt }, now);    // keys of ~/art stay selectable
 *   await updateMedia(db, actor, { id, alt, isIllustration, variantId? }, now);
 *   await moveMedia(db, actor, { id, direction }, now);
 *   await removeMedia(db, store, actor, { id, reason }, now);
 *
 * Uploads go through the server core's upload service (uploads.server.ts: type decided by the bytes — JPEG, PNG or
 * WebP only —, size ≤ 8 MB, dimensions, metadata stripped, SHA-256) and are stored PUBLIC (kind "product_image"),
 * because the storefront serves them through /media. The same picture uploaded twice to one gallery is recognised by
 * its hash and not added again (a double submit is harmless).
 *
 * What the schema cannot hold yet: video files (the upload service accepts images only and `media` has no URL column)
 * and crop or focal-point hints (no columns) — module status "partial", requested from the data owner.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getPhoto, productPhotos } from "~/art";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { files, media, variants } from "~/server/db/schema";
import { expectThat, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { deleteFile, putFile, type BlobStore } from "~/server/storage.server";
import { processImageUpload, type UploadSource } from "~/server/uploads.server";
import { assertNoRegression, completenessWith, parseInput, productCompleteness, requireProductState, rethrowCatalog, zBool, zId, zL10n, zOptionalId, zReason } from "./common.server";

export type GalleryItem = {
  id: string;
  ownerType: "product" | "variant";
  variantId: string | null;
  variantSku: string | null;
  kind: string;
  artKey: string | null;
  /** Public storage key of an uploaded file (served by /media). */
  mediaKey: string | null;
  width: number | null;
  height: number | null;
  alt: L10n | null;
  altText: string;
  isIllustration: boolean;
  sort: number;
  /** The file is missing or private (it cannot be shown on the storefront). */
  broken: boolean;
};

export type Gallery = {
  productId: string;
  slug: string;
  items: GalleryItem[];
  variants: { id: string; sku: string; title: string }[];
  /** Catalogue photo keys of this product (scripts/products/images.mjs) not yet in its gallery. */
  suggestedKeys: string[];
  live: boolean;
};

export async function getGallery(db: Db, actor: Actor, productId: string, locale: Locale): Promise<Gallery> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const variantIds = state.variants.map((variant) => variant.id);
  const rows = await db
    .select({
      id: media.id,
      ownerType: media.ownerType,
      ownerId: media.ownerId,
      kind: media.kind,
      artKey: media.artKey,
      alt: media.alt,
      isIllustration: media.isIllustration,
      sort: media.sort,
      storageKey: files.storageKey,
      visibility: files.visibility,
      deletedAt: files.deletedAt,
      width: files.width,
      height: files.height,
      fileId: media.fileId,
    })
    .from(media)
    .leftJoin(files, eq(files.id, media.fileId))
    .where(
      variantIds.length > 0
        ? sql`(${media.ownerType} = 'product' AND ${media.ownerId} = ${productId}) OR (${media.ownerType} = 'variant' AND ${inArray(media.ownerId, variantIds)})`
        : and(eq(media.ownerType, "product"), eq(media.ownerId, productId)),
    )
    .orderBy(asc(media.ownerType), asc(media.sort), asc(media.id));
  const skuOf = new Map(state.variants.map((variant) => [variant.id, variant.sku]));
  const items: GalleryItem[] = rows.map((row) => {
    const uploaded = row.fileId !== null;
    const servable = uploaded && row.storageKey !== null && row.visibility === "public" && row.deletedAt === null;
    return {
      id: row.id,
      ownerType: row.ownerType === "variant" ? "variant" : "product",
      variantId: row.ownerType === "variant" ? row.ownerId : null,
      variantSku: row.ownerType === "variant" ? (skuOf.get(row.ownerId) ?? null) : null,
      kind: row.kind,
      artKey: uploaded ? null : row.artKey,
      mediaKey: servable ? row.storageKey : null,
      width: row.width,
      height: row.height,
      alt: row.alt,
      altText: pick(row.alt, locale),
      isIllustration: row.isIllustration,
      sort: row.sort,
      broken: uploaded ? !servable : !row.artKey || !getPhoto(row.artKey),
    };
  });
  const used = new Set(items.map((item) => item.artKey).filter(Boolean));
  return {
    productId,
    slug: state.product.slug,
    items,
    variants: state.variants.map((variant) => ({ id: variant.id, sku: variant.sku, title: pick(variant.title, locale) })),
    suggestedKeys: productPhotos(state.product.slug)
      .map((photo) => photo.key)
      .filter((key) => !used.has(key)),
    live: state.product.status === "published" || state.product.status === "scheduled",
  };
}

/** Where a new picture goes: the product's gallery, or one variant's. */
async function ownerOf(db: Db, productId: string, variantId: string | undefined): Promise<{ ownerType: "product" | "variant"; ownerId: string }> {
  if (!variantId) return { ownerType: "product", ownerId: productId };
  const variant = await db.select({ id: variants.id }).from(variants).where(and(eq(variants.id, variantId), eq(variants.productId, productId))).get();
  if (!variant) throw invalid({ variantId: "invalid" });
  return { ownerType: "variant", ownerId: variant.id };
}

async function nextSort(db: Db, ownerType: string, ownerId: string): Promise<number> {
  const row = await db.get<{ n: number | null }>(sql`SELECT MAX(sort) AS n FROM media WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}`);
  return row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
}

export const UploadMediaInput = z.object({ productId: zId, variantId: zOptionalId, alt: zL10n(300, false), isIllustration: zBool });

export async function addUploadedImage(db: Db, store: BlobStore, actor: Actor, raw: unknown, file: UploadSource, now: number): Promise<{ mediaId: string; replayed: boolean }> {
  assertCan(actor, "catalog.media.manage");
  const input = parseInput(UploadMediaInput, raw);
  await requireProductState(db, input.productId);
  const owner = await ownerOf(db, input.productId, input.variantId);
  // Checked and cleaned before anything is stored (throws upload_* errors).
  const image = await processImageUpload(file);
  const duplicate = await db
    .select({ id: media.id })
    .from(media)
    .innerJoin(files, eq(files.id, media.fileId))
    .where(and(eq(media.ownerType, owner.ownerType), eq(media.ownerId, owner.ownerId), eq(files.sha256, image.sha256)))
    .get();
  if (duplicate) return { mediaId: duplicate.id, replayed: true };

  const stored = await putFile(db, store, {
    bytes: image.bytes,
    mime: image.mime,
    visibility: "public",
    kind: "product_image",
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    createdBy: actor,
    originalName: image.originalName,
    now,
  });
  const mediaId = newId("med");
  try {
    await runBatch(db, [
      db.insert(media).values({ id: mediaId, ...owner, fileId: stored.id, artKey: null, kind: "image", alt: input.alt, isIllustration: input.isIllustration, sort: await nextSort(db, owner.ownerType, owner.ownerId), createdAt: now }),
      auditStatement(db, { actor, action: "catalog.media.upload", entityType: "product", entityId: input.productId, summary: `${owner.ownerType}:${owner.ownerId}`, after: { mediaId, fileId: stored.id, bytes: stored.bytes, width: stored.width, height: stored.height, alt: input.alt }, at: now }),
    ]);
  } catch (error) {
    // No media row, no file: the bytes would otherwise sit in storage with nothing pointing at them.
    await deleteFile(db, store, stored.id, now).catch(() => {});
    throw error;
  }
  return { mediaId, replayed: false };
}

export const PhotoMediaInput = z.object({ productId: zId, variantId: zOptionalId, artKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*--\d+$/, "photo_unknown"), alt: zL10n(300, false) });

/** Adds an official catalogue photo (a key of ~/art, built by the image pipeline) to the gallery. */
export async function addCatalogPhoto(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ mediaId: string; replayed: boolean }> {
  assertCan(actor, "catalog.media.manage");
  const input = parseInput(PhotoMediaInput, raw);
  if (!getPhoto(input.artKey)) throw invalid({ artKey: "photo_unknown" });
  await requireProductState(db, input.productId);
  const owner = await ownerOf(db, input.productId, input.variantId);
  const existing = await db.select({ id: media.id }).from(media).where(and(eq(media.ownerType, owner.ownerType), eq(media.ownerId, owner.ownerId), eq(media.artKey, input.artKey))).get();
  if (existing) return { mediaId: existing.id, replayed: true };
  const mediaId = newId("med");
  await runBatch(db, [
    db.insert(media).values({ id: mediaId, ...owner, fileId: null, artKey: input.artKey, kind: "image", alt: input.alt, isIllustration: false, sort: await nextSort(db, owner.ownerType, owner.ownerId), createdAt: now }),
    auditStatement(db, { actor, action: "catalog.media.add_photo", entityType: "product", entityId: input.productId, summary: input.artKey, after: { mediaId, artKey: input.artKey, alt: input.alt }, at: now }),
  ]);
  return { mediaId, replayed: false };
}

/** The media row with the product it belongs to (directly, or through its variant). */
async function mediaWithProduct(db: Db, id: string) {
  const row = await db.select().from(media).where(eq(media.id, id)).get();
  if (!row) throw notFound("media");
  let productId: string | null = null;
  if (row.ownerType === "product") productId = row.ownerId;
  else if (row.ownerType === "variant") productId = (await db.select({ productId: variants.productId }).from(variants).where(eq(variants.id, row.ownerId)).get())?.productId ?? null;
  if (!productId) throw notFound("media");
  return { row, productId };
}

export const UpdateMediaInput = z.object({ id: zId, productId: zId, alt: zL10n(300, false), isIllustration: zBool, variantId: zOptionalId });

export async function updateMedia(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "catalog.media.manage");
  const input = parseInput(UpdateMediaInput, raw);
  const { row, productId } = await mediaWithProduct(db, input.id);
  if (productId !== input.productId) throw notFound("media");
  const owner = await ownerOf(db, productId, input.variantId);
  const moving = owner.ownerType !== row.ownerType || owner.ownerId !== row.ownerId;
  const { guard } = moving && row.ownerType === "product" ? await keepsAnImage(db, productId, row.kind) : { guard: null };
  await runBatch(db, [
    db
      .update(media)
      .set({ alt: input.alt, isIllustration: input.isIllustration, ...(moving ? { ...owner, sort: await nextSort(db, owner.ownerType, owner.ownerId) } : {}) })
      .where(eq(media.id, row.id)),
    ...(guard ? [guard] : []),
    auditStatement(db, {
      actor,
      action: "catalog.media.update",
      entityType: "product",
      entityId: productId,
      summary: row.id,
      before: { alt: row.alt, isIllustration: row.isIllustration, owner: `${row.ownerType}:${row.ownerId}` },
      after: { alt: input.alt, isIllustration: input.isIllustration, owner: `${owner.ownerType}:${owner.ownerId}` },
      at: now,
    }),
  ]).catch(rethrowCatalog);
}

export const MoveMediaInput = z.object({ id: zId, productId: zId, direction: z.enum(["up", "down", "first"], { error: "invalid" }) });

/** Moves a picture within its gallery (the first one is the product's main picture). */
export async function moveMedia(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "catalog.media.manage");
  const input = parseInput(MoveMediaInput, raw);
  const { row, productId } = await mediaWithProduct(db, input.id);
  if (productId !== input.productId) throw notFound("media");
  const siblings = await db.select({ id: media.id }).from(media).where(and(eq(media.ownerType, row.ownerType), eq(media.ownerId, row.ownerId))).orderBy(asc(media.sort), asc(media.id));
  const order = siblings.map((entry) => entry.id);
  const index = order.indexOf(row.id);
  const target = input.direction === "first" ? 0 : input.direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length || target === index) return;
  order.splice(index, 1);
  order.splice(target, 0, row.id);
  await runBatch(db, [
    ...order.map((id, position) => db.update(media).set({ sort: position }).where(eq(media.id, id))),
    auditStatement(db, { actor, action: "catalog.media.reorder", entityType: "product", entityId: productId, summary: `${row.id} → ${target + 1}`, at: now }),
  ]);
}

/**
 * A live product keeps at least one picture of its own (02.03: pictures are required). Checked now, and — when the
 * product is live and has a picture — again INSIDE the batch by the returned guard (place it after the change): two
 * tabs removing the last two pictures at once each see two, and only the guard sees what the other one did.
 * (The guard comes back wrapped: a query builder is a thenable, so an async function returning it bare would run it.)
 */
async function keepsAnImage(db: Db, productId: string, kind: string): Promise<{ guard: BatchStatement | null }> {
  if (kind !== "image" && kind !== "render") return { guard: null };
  const state = await productCompleteness(db, productId);
  if (!state) return { guard: null };
  const product = await requireProductState(db, productId);
  assertNoRegression(product.product.status, state.completeness, completenessWith(state.facts, { images: Math.max(0, state.facts.images - 1) }));
  const live = product.product.status === "published" || product.product.status === "scheduled";
  if (!live || state.facts.images === 0) return { guard: null };
  const guard = expectThat(
    db,
    sql`EXISTS (SELECT 1 FROM media m LEFT JOIN files f ON f.id = m.file_id
      WHERE m.owner_type = 'product' AND m.owner_id = ${productId} AND m.kind IN ('image', 'render')
        AND (m.art_key IS NOT NULL OR (f.id IS NOT NULL AND f.visibility = 'public' AND f.deleted_at IS NULL)))`,
    { code: "REGRESSION", detail: "images" },
  );
  return { guard };
}

export const RemoveMediaInput = z.object({ id: zId, productId: zId, reason: zReason(true) });

export async function removeMedia(db: Db, store: BlobStore, actor: Actor, raw: unknown, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, "catalog.media.manage");
  const input = parseInput(RemoveMediaInput, raw);
  const found = await db.select().from(media).where(eq(media.id, input.id)).get();
  if (!found) return { removed: false }; // already removed (a double submit)
  const { row, productId } = await mediaWithProduct(db, input.id);
  if (productId !== input.productId) throw notFound("media");
  const { guard } = row.ownerType === "product" ? await keepsAnImage(db, productId, row.kind) : { guard: null };
  await runBatch(db, [
    db.delete(media).where(eq(media.id, row.id)),
    ...(guard ? [guard] : []),
    auditStatement(db, {
      actor,
      action: "catalog.media.remove",
      entityType: "product",
      entityId: productId,
      summary: row.artKey ?? row.fileId ?? row.id,
      before: { mediaId: row.id, artKey: row.artKey, fileId: row.fileId, alt: row.alt, owner: `${row.ownerType}:${row.ownerId}` },
      reason: input.reason,
      at: now,
    }),
  ]).catch(rethrowCatalog);
  // The uploaded bytes go too when nothing else shows them (catalogue photos are build assets, never deleted here).
  if (row.fileId) {
    const other = await db.select({ id: media.id }).from(media).where(eq(media.fileId, row.fileId)).get();
    if (!other) await deleteFile(db, store, row.fileId, now).catch(() => {});
  }
  return { removed: true };
}

