/**
 * File storage — bytes in a blob store, facts in the `files` table.
 *
 *   const store = kvBlobStore(env.KV);                                   // routes: import { env } from "cloudflare:workers"
 *   const file = await putFile(db, store, { bytes, mime: "image/webp", visibility: "private", kind: "payment_proof", createdBy: actor, now });
 *   const stored = await getFile(db, store, file.id);                    // AFTER the caller has checked the actor may see it
 *   return fileResponse(stored.record, stored.bytes, request);           // safe headers for both visibilities
 *
 * Two visibilities, told apart by the storage key itself:
 *   public   `pub_<random>.<ext>`  served to anyone by GET /media/<key>, cached forever
 *   private  `prv_<random>.<ext>`  never served by /media; only through a route that authorizes the
 *                                  actor first (payment proofs need `payment_proof.read`; a shopper's own
 *                                  proofs go through GET /api/files/:fileId — shopperFilePath)
 * Keys are random and unguessable, and a file's key changes when its visibility changes
 * (setFileVisibility), so a once-private URL never becomes a public one.
 *
 * The blob store is an interface. Today it is the KV binding (values up to 25 MB, eventually
 * consistent: a new file can take up to a minute to appear in other regions). An R2 bucket can
 * replace it by implementing `BlobStore` — nothing else changes.
 *
 * Uploads from people go through ~/server/uploads.server first (type, size, metadata). This module
 * stores what it is given and must not import "cloudflare:workers".
 */
import { and, eq, isNull } from "drizzle-orm";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { actorRef, type Actor } from "./actor";
import type { Db } from "./db/drizzle.server";
import { files, type FileRecord, type FileVisibility, type NewFileRecord } from "./db/schema";
import { cleanLine } from "./text.server";

// ───────────────────────────────────────────────────────────────── blob store

/** Stored next to the bytes, so the public route needs no database query. */
export type BlobMeta = { mime: string; visibility: FileVisibility; sha256: string; bytes: number };

export interface BlobStore {
  put(key: string, bytes: ArrayBuffer | Uint8Array, meta: BlobMeta): Promise<void>;
  get(key: string): Promise<{ bytes: ArrayBuffer; meta: BlobMeta | null } | null>;
  delete(key: string): Promise<void>;
}

const KV_PREFIX = "blob/";

/** The KV-backed store (`env.KV`). */
export function kvBlobStore(kv: KVNamespace): BlobStore {
  return {
    async put(key, bytes, meta) {
      await kv.put(KV_PREFIX + key, bytes as ArrayBuffer, { metadata: meta });
    },
    async get(key) {
      const { value, metadata } = await kv.getWithMetadata<BlobMeta>(KV_PREFIX + key, "arrayBuffer");
      return value === null ? null : { bytes: value, meta: metadata };
    },
    async delete(key) {
      await kv.delete(KV_PREFIX + key);
    },
  };
}

// ───────────────────────────────────────────────────────────────── keys and types

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/json": "json",
  "text/plain": "txt",
};

/** Types a browser may display in place. Everything else is sent as a download. */
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const KEY_PATTERN = /^(pub|prv)_[A-Za-z0-9_-]{16,64}\.[a-z0-9]{1,8}$/;

export function newStorageKey(visibility: FileVisibility, mime: string): string {
  return `${visibility === "public" ? "pub" : "prv"}_${randomToken(18)}.${EXTENSIONS[mime] ?? "bin"}`;
}

/** True for a well-formed key of a PUBLIC file. The public route refuses everything else without looking it up. */
export function isPublicStorageKey(key: string | null | undefined): key is string {
  return typeof key === "string" && KEY_PATTERN.test(key) && key.startsWith("pub_");
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * A file name that is safe to show and to put in a header: no path, no control characters, short — and none of the
 * hidden characters ~/server/text.server removes from shopper text (bidi overrides and isolates, zero-width space,
 * C1 controls…), so "IMG<RLO>gnp.exe" cannot pose as "IMGexe.png" on the screens that list uploads (second pass).
 */
export function sanitizeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = cleanLine(base).replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, 120);
  return clean === "" || clean === "." || clean === ".." ? null : clean;
}

// ───────────────────────────────────────────────────────────────── writing

export type PutFileInput = {
  bytes: ArrayBuffer | Uint8Array;
  /** The real type of the bytes (for uploads: the type detected from the content, never the browser's claim). */
  mime: string;
  visibility: FileVisibility;
  /** What the file is: "payment_proof", "used_photo", "product_image", "delivery_proof", "export"… */
  kind: string;
  width?: number | null;
  height?: number | null;
  /** Hash of `bytes` when the caller already has it. */
  sha256?: string;
  ownerType?: string | null;
  ownerId?: string | null;
  createdBy?: Actor;
  originalName?: string | null;
  now: number;
};

/**
 * Stores the bytes and returns the `files` row to insert — for callers that want the row in their
 * own batch (`db.batch([db.insert(files).values(row), …])`). If that batch fails, call
 * `store.delete(row.storageKey)`.
 */
export async function storeBlob(store: BlobStore, input: PutFileInput): Promise<NewFileRecord & { id: string; storageKey: string }> {
  const bytes = toArrayBuffer(input.bytes);
  if (bytes.byteLength === 0) throw new Error("Refusing to store an empty file");
  const sha256 = input.sha256 ?? (await sha256Hex(bytes));
  const storageKey = newStorageKey(input.visibility, input.mime);
  await store.put(storageKey, bytes, { mime: input.mime, visibility: input.visibility, sha256, bytes: bytes.byteLength });
  const creator = input.createdBy ? actorRef(input.createdBy) : null;
  return {
    id: newId("fil"),
    storageKey,
    visibility: input.visibility,
    kind: input.kind,
    mime: input.mime,
    bytes: bytes.byteLength,
    sha256,
    width: input.width ?? null,
    height: input.height ?? null,
    ownerType: input.ownerType ?? null,
    ownerId: input.ownerId ?? null,
    createdBy: creator?.actorId ?? null,
    createdByKind: creator?.actorKind ?? null,
    createdAt: input.now,
    originalName: sanitizeFileName(input.originalName),
  };
}

/** Stores the bytes and records the file. Returns the `files` row. */
export async function putFile(db: Db, store: BlobStore, input: PutFileInput): Promise<FileRecord> {
  const row = await storeBlob(store, input);
  try {
    const [record] = await db.insert(files).values(row).returning();
    return record;
  } catch (error) {
    // No row, no file: do not leave bytes behind that nothing points at.
    await store.delete(row.storageKey).catch(() => {});
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── reading

/** The row of a file that still exists (not deleted), or null. */
export async function getFileRecord(db: Db, id: string): Promise<FileRecord | null> {
  const record = await db.select().from(files).where(and(eq(files.id, id), isNull(files.deletedAt))).get();
  return record ?? null;
}

export type StoredFile = { record: FileRecord; bytes: ArrayBuffer };

/**
 * The row and the bytes of a file. This does NOT authorize anything: the caller decides first
 * whether the actor may see this file (owner check or a field permission such as `payment_proof.read`).
 */
export async function getFile(db: Db, store: BlobStore, id: string): Promise<StoredFile | null> {
  const record = await getFileRecord(db, id);
  if (!record) return null;
  const blob = await store.get(record.storageKey);
  return blob ? { record, bytes: blob.bytes } : null;
}

/** Bytes of a PUBLIC file by key, with no database query. Null for private, malformed or unknown keys. */
export async function getPublicBlob(store: BlobStore, key: string | null | undefined): Promise<{ bytes: ArrayBuffer; meta: BlobMeta } | null> {
  if (!isPublicStorageKey(key)) return null;
  const blob = await store.get(key);
  // Both the key and the metadata written with the bytes must say "public".
  if (!blob || !blob.meta || blob.meta.visibility !== "public") return null;
  return { bytes: blob.bytes, meta: blob.meta };
}

// ───────────────────────────────────────────────────────────────── changing

/** Removes the bytes and marks the row deleted (the row stays: other records may reference it). */
export async function deleteFile(db: Db, store: BlobStore, id: string, now: number): Promise<boolean> {
  const record = await getFileRecord(db, id);
  if (!record) return false;
  await store.delete(record.storageKey);
  await db.update(files).set({ deletedAt: now }).where(eq(files.id, id));
  return true;
}

/**
 * Makes a private file public or the reverse (a used-device photo when its unit is listed). The
 * bytes move to a new key of the other kind and the old key stops existing.
 */
export async function setFileVisibility(db: Db, store: BlobStore, id: string, visibility: FileVisibility): Promise<FileRecord | null> {
  const record = await getFileRecord(db, id);
  if (!record) return null;
  if (record.visibility === visibility) return record;
  const blob = await store.get(record.storageKey);
  if (!blob) return null;
  const storageKey = newStorageKey(visibility, record.mime);
  await store.put(storageKey, blob.bytes, { mime: record.mime, visibility, sha256: record.sha256, bytes: record.bytes });
  const [updated] = await db.update(files).set({ storageKey, visibility }).where(eq(files.id, id)).returning();
  await store.delete(record.storageKey);
  return updated ?? null;
}

// ───────────────────────────────────────────────────────────────── serving

export type ServableFile = { mime: string; sha256: string; visibility: FileVisibility; originalName?: string | null };

/**
 * Headers that keep a stored file inert in the browser, whatever it contains:
 *   · the type recorded at upload, and `nosniff` so the browser does not guess another
 *   · images display in place; every other type downloads (`Content-Disposition: attachment`)
 *   · a sandboxing Content-Security-Policy: no scripts, no plugins, no navigation, even if opened directly
 *   · public files are immutable and cacheable for a year; private files are never cached
 */
export function fileHeaders(file: ServableFile): Headers {
  const headers = new Headers();
  const inline = INLINE_TYPES.has(file.mime);
  headers.set("Content-Type", inline || file.mime in EXTENSIONS ? file.mime : "application/octet-stream");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (inline) {
    headers.set("Content-Disposition", "inline");
  } else {
    const name = (sanitizeFileName(file.originalName) ?? `file.${EXTENSIONS[file.mime] ?? "bin"}`).replace(/[^\x20-\x7e]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
  }
  headers.set("ETag", `"${file.sha256}"`);
  if (file.visibility === "public") {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
  return headers;
}

/**
 * Where a shopper opens one of their OWN private files again — GET /api/files/:fileId (app/routes/api/files.ts), which
 * authorizes every request: a transfer proof for the order's signed-in owner or with the order's confirmation token
 * (`t`, as in /order/<ref>?t=…), a wallet top-up proof for the customer who uploaded it. Answered `private, no-store`;
 * anyone else gets 404. The token goes in the URL only for guests, the same token their order link already carries.
 */
export function shopperFilePath(fileId: string, accessToken?: string | null): string {
  const path = `/api/files/${encodeURIComponent(fileId)}`;
  return accessToken ? `${path}?t=${encodeURIComponent(accessToken)}` : path;
}

/** A complete response for a stored file (304 when the browser already has it). */
export function fileResponse(file: ServableFile, bytes: ArrayBuffer, request?: Request): Response {
  const headers = fileHeaders(file);
  const known = request?.headers.get("If-None-Match");
  if (known && known.split(",").some((tag) => tag.trim().replace(/^W\//, "") === headers.get("ETag"))) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { status: 200, headers });
}
