/**
 * Private photos the shopper chooses (a repair request, a message to staff, a trade-in), checked in the browser the way
 * the store checks them (~/server/uploads.server) before anything is sent:
 *
 *   acceptPhotos(current, incoming, found?)   the photos that may join a form, and the first problem with the rest
 *   checkPhotoFile(file)                       what the bytes really are: a problem code, or null
 *   photoFormat(bytes)                         "jpeg" | "png" | "webp" | null — the store's signature rule
 *
 * The type a browser claims comes from the file's name: a text file or a PDF renamed «photo.jpg» claims image/jpeg, and
 * used to join the form as a broken thumbnail, then be refused when the form was sent (QA 2026-11-12). Its first bytes
 * say what it is — the store's own rule —, a picture the browser cannot draw is unreadable, and one past the store's
 * dimensions (16,384 px a side, 50 megapixels) is too large. Each is said at once with the store's sentence (errors
 * namespace: upload_type, upload_corrupt, upload_dimensions) and never sent.
 *
 * Client-safe and pure apart from reading the file (no server code, no React).
 */
import { MAX_SUPPORT_PHOTOS } from "~/server/services/support/types";

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** The store's limits (~/server/uploads.server MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS). */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 50_000_000;

/** The store's upload codes (and "too_big": more photos than a form takes). */
export type PhotoProblem = "upload_type" | "upload_too_large" | "upload_corrupt" | "upload_dimensions" | "too_big";
/** What reading a file can find. */
export type PhotoFileProblem = "upload_type" | "upload_corrupt" | "upload_dimensions";

export type PhotoFormat = "jpeg" | "png" | "webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (bytes: Uint8Array, start: number, text: string) => bytes.length >= start + text.length && [...text].every((char, index) => bytes[start + index] === char.charCodeAt(0));

/** The format the bytes really are, from their first bytes — the store's rule (uploads.server detectImageFormat). Pure. */
export function photoFormat(bytes: Uint8Array): PhotoFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "png";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
  return null;
}

/**
 * What a chosen file really is: "upload_type" when its bytes are no JPEG, PNG or WebP; "upload_corrupt" when the
 * browser cannot draw it; "upload_dimensions" past the store's size in pixels; null when it is a picture the store can
 * take (the store still decides again). A file the browser cannot read at all, or a browser that cannot decode outside
 * a page (tests), is left to the store.
 */
export async function checkPhotoFile(file: Blob): Promise<PhotoFileProblem | null> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    return null;
  }
  if (photoFormat(head) === null) return "upload_type";
  const size = await pictureSize(file);
  if (size === "unreadable") return "upload_corrupt";
  if (size && (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS)) return "upload_dimensions";
  return null;
}

/**
 * The picture's size in pixels as the browser decodes it (an <img> the page never shows — the same decoding the
 * thumbnail does, so a picture that passes also previews); "unreadable" when it cannot; null when it cannot tell (no
 * DOM: tests, workers). Callers check one file at a time: a phone holds one decoded photo, not three.
 */
async function pictureSize(file: Blob): Promise<{ width: number; height: number } | "unreadable" | null> {
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return "unreadable";
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The files that may be added to `current`, and the first problem with the rest. `found`: what checkPhotoFile said
 * about a file (it is refused with that problem). A file's claimed type, its size and the form's limit count too. Pure.
 */
export function acceptPhotos(current: readonly File[], incoming: readonly File[], found: ReadonlyMap<File, PhotoProblem> = new Map()): { files: File[]; problem: PhotoProblem | null } {
  const files = [...current];
  let problem: PhotoProblem | null = null;
  for (const file of incoming) {
    const refused = found.get(file);
    if (refused) problem ??= refused;
    else if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) problem ??= "upload_type";
    else if (file.size > PHOTO_MAX_BYTES) problem ??= "upload_too_large";
    else if (files.length >= MAX_SUPPORT_PHOTOS) problem ??= "too_big";
    else files.push(file);
  }
  return { files, problem };
}

/** True when a file's claimed type and size pass (the bytes are read only for these). */
export function claimsPhoto(file: File): boolean {
  return (PHOTO_TYPES as readonly string[]).includes(file.type) && file.size <= PHOTO_MAX_BYTES;
}
