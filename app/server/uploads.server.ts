/**
 * Image uploads from people (payment proofs, used-device photos, product images, delivery proofs).
 *
 *   const form = await request.formData();
 *   const image = await processImageUpload(form.get("proof"));          // throws AppError with fields.file
 *   const file = await saveImageUpload(db, kvBlobStore(env.KV), form.get("proof"), { visibility: "private", kind: "payment_proof", createdBy: actor, now: ctx.now });
 *
 * What is enforced, in this order:
 *   1. size        at most 8 MB (MAX_IMAGE_BYTES)
 *   2. type        JPEG, PNG or WebP — decided by the file's first bytes. The file name and the type
 *                  the browser claims are ignored, so "invoice.jpg" that is really HTML, SVG, a PDF
 *                  or a program is refused.
 *   3. structure   the container is walked from start to end; anything that does not parse is refused
 *   4. dimensions  read from the image header; at most 16,384 px per side and 50 megapixels
 *   5. metadata    removed WITHOUT re-encoding the picture (pixels are untouched):
 *                    JPEG  every APPn segment except JFIF, ICC profile and Adobe colour data is dropped
 *                          (APP1 Exif/XMP with GPS position, device, dates and thumbnails; APP13 IPTC),
 *                          COM comments too. If Exif said the photo is rotated, a 34-byte Exif block
 *                          holding ONLY that orientation is written back so the picture still displays upright.
 *                    PNG   tEXt, zTXt, iTXt, eXIf, tIME and every other chunk a decoder does not need
 *                    WebP  EXIF and XMP chunks, unknown chunks; the VP8X flags are corrected
 *                  Bytes after the end of the image are cut off in all three formats.
 *   6. hash        SHA-256 of the cleaned bytes (the same picture with edited metadata hashes the same,
 *                  which is what duplicate-proof detection needs)
 *
 * NOT done: malware scanning. Cloudflare Workers has no antivirus engine and none is connected.
 * The defence is the narrow type list above plus the way files are served (~/server/storage.server:
 * fixed image type, nosniff, sandboxing CSP, never as active content).
 *
 * Pure byte work: no database, no environment. Must not import "cloudflare:workers".
 */
import { sha256Hex } from "~/lib/ids";
import type { Actor } from "./actor";
import type { Db } from "./db/drizzle.server";
import type { FileRecord, FileVisibility } from "./db/schema";
import { AppError } from "./errors";
import { putFile, type BlobStore } from "./storage.server";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 50_000_000;

export type ImageFormat = "jpeg" | "png" | "webp";
export const IMAGE_MIME: Record<ImageFormat, "image/jpeg" | "image/png" | "image/webp"> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Upload failures are AppErrors with `fields.file` set to the same code, so a form can show them under the file input. */
export type UploadErrorCode = "upload_missing" | "upload_too_large" | "upload_type" | "upload_corrupt" | "upload_dimensions";
const STATUS: Record<UploadErrorCode, number> = { upload_missing: 400, upload_too_large: 413, upload_type: 415, upload_corrupt: 422, upload_dimensions: 422 };

function uploadError(code: UploadErrorCode, detail?: string): AppError {
  return new AppError(code, STATUS[code], { fields: { file: code }, detail });
}

const corrupt = (detail: string) => uploadError("upload_corrupt", detail);

// ───────────────────────────────────────────────────────────────── helpers

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function startsWith(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image format the bytes really are, from their signature — or null. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "png";
  if (bytes.length >= 12 && startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "webp";
  return null;
}

export type SanitizedImage = {
  format: ImageFormat;
  mime: (typeof IMAGE_MIME)[ImageFormat];
  /** The image without metadata. A new array — the input is not modified. */
  bytes: Uint8Array;
  /** Size as displayed (already swapped for photos stored sideways). */
  width: number;
  height: number;
  /** What was taken out, e.g. ["exif", "comment", "trailing data"]. */
  removed: string[];
};

// ───────────────────────────────────────────────────────────────── JPEG

/** The Orientation tag (1–8) of an Exif block's first directory, or null. */
function exifOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 14) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const r16 = (o: number) => (little ? u16le(tiff, o) : u16be(tiff, o));
  const r32 = (o: number) => (little ? u32le(tiff, o) : u32be(tiff, o));
  if (r16(2) !== 42) return null;
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) return null;
  const entries = r16(ifd);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return r16(entry + 2) === 3 && value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A complete APP1 segment whose Exif data is nothing but the orientation. */
function orientationSegment(orientation: number): Uint8Array {
  // prettier-ignore
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22,                               // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                   // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,       // TIFF header, big-endian, first directory at 8
    0x00, 0x01,                                           // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,   // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00,                               // no further directory
  ]);
}

const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function sanitizeJpeg(bytes: Uint8Array): SanitizedImage {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed = new Set<string>();
  let pos = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let scans = 0;
  let ended = false;

  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw corrupt("jpeg: expected a marker");
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) throw corrupt("jpeg: truncated marker");
    const marker = bytes[pos++];

    if (marker === 0xd9) {
      ended = true;
      break;
    }
    if (marker === 0x00 || marker === 0xd8) throw corrupt("jpeg: unexpected marker");
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(new Uint8Array([0xff, marker]));
      continue;
    }

    if (pos + 2 > bytes.length) throw corrupt("jpeg: truncated segment");
    const length = u16be(bytes, pos);
    const end = pos + length;
    if (length < 2 || end > bytes.length) throw corrupt("jpeg: segment runs past the end of the file");
    const data = bytes.subarray(pos + 2, end);
    let keep = true;

    if (isStartOfFrame(marker)) {
      if (data.length < 6) throw corrupt("jpeg: short frame header");
      height = u16be(data, 1);
      width = u16be(data, 3);
    } else if (marker === 0xe0) {
      // JFIF header stays (pixel density); its optional embedded thumbnail and the JFXX extension do not.
      if (startsWith(data, "JFIF\0") && data.length >= 14) {
        if (data.length > 14) {
          const header = new Uint8Array(18);
          header.set([0xff, 0xe0, 0x00, 0x10]);
          header.set(data.subarray(0, 12), 4);
          parts.push(header);
          removed.add("thumbnail");
          keep = false;
        }
      } else {
        removed.add("thumbnail");
        keep = false;
      }
    } else if (marker === 0xe1) {
      if (startsWith(data, "Exif\0\0")) {
        orientation = exifOrientation(data.subarray(6)) ?? orientation;
        removed.add("exif");
      } else {
        removed.add("xmp");
      }
      keep = false;
    } else if (marker === 0xe2) {
      // The colour profile is part of how the picture looks. Other APP2 payloads (multi-picture data) are not.
      if (!startsWith(data, "ICC_PROFILE\0")) {
        removed.add("app2");
        keep = false;
      }
    } else if (marker === 0xed) {
      removed.add("iptc");
      keep = false;
    } else if (marker === 0xfe) {
      removed.add("comment");
      keep = false;
    } else if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) {
      // APP14 "Adobe" tells the decoder the colour transform and must stay; everything else goes.
      removed.add(`app${marker - 0xe0}`);
      keep = false;
    }

    if (keep) {
      const segment = new Uint8Array(2 + length);
      segment[0] = 0xff;
      segment[1] = marker;
      segment.set(bytes.subarray(pos, end), 2);
      parts.push(segment);
    }
    pos = end;

    if (marker === 0xda) {
      scans++;
      const scanStart = pos;
      // Entropy-coded data runs until the next real marker: FF00 is a stuffed byte, FFD0–FFD7 are restarts.
      for (;;) {
        const ff = bytes.indexOf(0xff, pos);
        if (ff === -1 || ff + 1 >= bytes.length) {
          pos = bytes.length;
          break;
        }
        const next = bytes[ff + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos = ff + 2;
        } else if (next === 0xff) {
          pos = ff + 1;
        } else {
          pos = ff;
          break;
        }
      }
      parts.push(bytes.subarray(scanStart, pos));
    }
  }

  if (width === 0 || height === 0 || scans === 0) throw corrupt("jpeg: no image data");
  // Some cameras cut the end-of-image marker; decoders accept that, so do we — and we write it back.
  parts.push(new Uint8Array([0xff, 0xd9]));
  if (ended && pos < bytes.length) removed.add("trailing data");
  if (orientation !== 1) {
    // Straight after the JFIF header when there is one, otherwise straight after the start-of-image marker.
    const afterJfif = parts.length > 1 && parts[1][0] === 0xff && parts[1][1] === 0xe0;
    parts.splice(afterJfif ? 2 : 1, 0, orientationSegment(orientation));
  }
  const sideways = orientation >= 5;
  return { format: "jpeg", mime: IMAGE_MIME.jpeg, bytes: concat(parts), width: sideways ? height : width, height: sideways ? width : height, removed: [...removed] };
}

// ───────────────────────────────────────────────────────────────── PNG

/** Chunks a decoder needs to show the picture as intended. Everything else is dropped. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs", "cICP", "mDCV", "cLLI", "acTL", "fcTL", "fdAT"]);
const PNG_METADATA: Record<string, string> = { tEXt: "text", zTXt: "text", iTXt: "text", eXIf: "exif", tIME: "time" };

function sanitizePng(bytes: Uint8Array): SanitizedImage {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed = new Set<string>();
  let pos = 8;
  let width = 0;
  let height = 0;
  let hasData = false;
  let ended = false;
  let first = true;

  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw corrupt("png: truncated chunk");
    const length = u32be(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    const end = pos + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) throw corrupt("png: bad chunk");

    if (first) {
      if (type !== "IHDR" || length !== 13) throw corrupt("png: missing header");
      width = u32be(bytes, pos + 8);
      height = u32be(bytes, pos + 12);
      first = false;
    } else if (type === "IHDR") {
      throw corrupt("png: second header");
    }

    if (PNG_KEEP.has(type)) {
      parts.push(bytes.subarray(pos, end));
      if (type === "IDAT") hasData = true;
    } else if (type[0] >= "A" && type[0] <= "Z") {
      // An unknown CRITICAL chunk means a decoder cannot show the picture without it — and we cannot vouch for it.
      throw corrupt(`png: unsupported critical chunk ${type}`);
    } else {
      removed.add(PNG_METADATA[type] ?? type);
    }
    pos = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }

  if (!ended || !hasData || width === 0 || height === 0) throw corrupt("png: incomplete image");
  if (pos < bytes.length) removed.add("trailing data");
  return { format: "png", mime: IMAGE_MIME.png, bytes: concat(parts), width, height, removed: [...removed] };
}

// ───────────────────────────────────────────────────────────────── WebP

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function sanitizeWebp(bytes: Uint8Array): SanitizedImage {
  const declaredEnd = 8 + u32le(bytes, 4);
  if (declaredEnd > bytes.length || declaredEnd < 20) throw corrupt("webp: bad container size");
  const chunks: Uint8Array[] = [];
  const removed = new Set<string>();
  let pos = 12;
  let width = 0;
  let height = 0;
  let hasImage = false;
  let first = true;

  while (pos < declaredEnd) {
    if (pos + 8 > declaredEnd) throw corrupt("webp: truncated chunk");
    const type = ascii(bytes, pos, 4);
    const size = u32le(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > declaredEnd) throw corrupt("webp: chunk runs past the end of the file");
    const data = bytes.subarray(dataStart, dataEnd);

    if (first && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") throw corrupt("webp: unknown first chunk");

    if (type === "VP8X") {
      if (!first || size < 10) throw corrupt("webp: bad extended header");
      width = 1 + u24le(data, 4);
      height = 1 + u24le(data, 7);
    } else if (type === "VP8 " && width === 0) {
      if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw corrupt("webp: bad lossy frame");
      width = u16le(data, 6) & 0x3fff;
      height = u16le(data, 8) & 0x3fff;
    } else if (type === "VP8L" && width === 0) {
      if (size < 5 || data[0] !== 0x2f) throw corrupt("webp: bad lossless frame");
      const bits = u32le(data, 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    if (type === "VP8 " || type === "VP8L" || type === "ANMF") hasImage = true;

    if (WEBP_KEEP.has(type)) {
      // Header + payload + the pad byte that keeps chunks on even offsets.
      const chunk = new Uint8Array(8 + size + (size & 1));
      chunk.set(bytes.subarray(pos, dataEnd));
      if (type === "VP8X") chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      chunks.push(chunk);
    } else {
      removed.add(type === "EXIF" ? "exif" : type === "XMP " ? "xmp" : type.trim() || "unknown chunk");
    }
    first = false;
    pos = dataEnd + (size & 1);
  }

  if (!hasImage || width === 0 || height === 0) throw corrupt("webp: no image data");
  if (declaredEnd < bytes.length) removed.add("trailing data");
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 4));
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(bytes.subarray(8, 12), 8);
  return { format: "webp", mime: IMAGE_MIME.webp, bytes: concat([header, body]), width, height, removed: [...removed] };
}

// ───────────────────────────────────────────────────────────────── public API

/**
 * Validates an image and returns it without metadata. Throws AppError:
 * `upload_type` (not JPEG / PNG / WebP by content), `upload_corrupt`, `upload_dimensions`.
 * Does not check the byte size — processImageUpload() does.
 */
export function sanitizeImage(bytes: Uint8Array): SanitizedImage {
  const format = detectImageFormat(bytes);
  if (!format) throw uploadError("upload_type");
  let image: SanitizedImage;
  try {
    image = format === "jpeg" ? sanitizeJpeg(bytes) : format === "png" ? sanitizePng(bytes) : sanitizeWebp(bytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Out-of-range reads on a malformed file: the file is the problem, not the server.
    throw corrupt(`${format}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  if (image.width < 1 || image.height < 1 || image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE || image.width * image.height > MAX_IMAGE_PIXELS) {
    throw uploadError("upload_dimensions", `${image.width}x${image.height}`);
  }
  return image;
}

export type UploadSource = Blob | ArrayBuffer | Uint8Array | FormDataEntryValue | null | undefined;

export type ProcessedImage = SanitizedImage & {
  /** SHA-256 of the cleaned bytes (hex). */
  sha256: string;
  /** Size of the file as it was received. */
  originalBytes: number;
  /** The uploaded file's name, for staff display only. Never used to decide anything. */
  originalName: string | null;
};

/**
 * The whole pipeline for one uploaded file: size → type by content → structure → dimensions →
 * metadata removed → hash. Accepts a `File` from `request.formData()`, or raw bytes.
 */
export async function processImageUpload(source: UploadSource, options: { maxBytes?: number } = {}): Promise<ProcessedImage> {
  const maxBytes = Math.min(options.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  if (source == null || typeof source === "string") throw uploadError("upload_missing");

  let bytes: Uint8Array;
  let originalName: string | null = null;
  if (source instanceof Uint8Array) {
    bytes = source;
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    // Check the declared size before reading the body into memory.
    if (source.size === 0) throw uploadError("upload_missing");
    if (source.size > maxBytes) throw uploadError("upload_too_large", String(source.size));
    bytes = new Uint8Array(await source.arrayBuffer());
    const name = (source as { name?: unknown }).name;
    if (typeof name === "string") originalName = name;
  }
  if (bytes.length === 0) throw uploadError("upload_missing");
  if (bytes.length > maxBytes) throw uploadError("upload_too_large", String(bytes.length));

  const image = sanitizeImage(bytes);
  return { ...image, sha256: await sha256Hex(image.bytes), originalBytes: bytes.length, originalName };
}

export type SaveImageOptions = {
  visibility: FileVisibility;
  /** "payment_proof", "used_photo", "product_image", "delivery_proof", "trade_in_photo"… */
  kind: string;
  ownerType?: string | null;
  ownerId?: string | null;
  createdBy?: Actor;
  now: number;
  maxBytes?: number;
};

/** processImageUpload() and then putFile(): the cleaned image is stored and recorded in `files`. */
export async function saveImageUpload(db: Db, store: BlobStore, source: UploadSource, options: SaveImageOptions): Promise<{ file: FileRecord; image: ProcessedImage }> {
  const image = await processImageUpload(source, { maxBytes: options.maxBytes });
  const file = await putFile(db, store, {
    bytes: image.bytes,
    mime: image.mime,
    visibility: options.visibility,
    kind: options.kind,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    ownerType: options.ownerType,
    ownerId: options.ownerId,
    createdBy: options.createdBy,
    originalName: image.originalName,
    now: options.now,
  });
  return { file, image };
}
