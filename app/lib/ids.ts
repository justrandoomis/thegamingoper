/**
 * Identifiers — works in Workers, browsers and Node (WebCrypto only).
 *
 *  newId("ord")  → "ord_01JD3M8Z6Q4V7T2K9R5X0BWCEA"   time-sortable ULID with a type prefix (primary keys)
 *  publicRef("TT") → "TT-7K4M2Q9X"                     short human reference (orders, RMAs, trade-ins); random, not guessable by counting
 *  randomToken()  → 256-bit URL-safe secret            (session ids, guest access tokens) — store only sha256Hex(token)
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Reference alphabet without look-alikes (no 0/O, 1/I/L, U). */
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function publicRef(prefix: string, length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = "";
  // Rejection sampling keeps the distribution uniform over the 30-character alphabet.
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    if (bytes[i] < 240) out += REF_ALPHABET[bytes[i] % 30];
  }
  while (out.length < length) out += REF_ALPHABET[crypto.getRandomValues(new Uint8Array(1))[0] % 30];
  return `${prefix}-${out}`;
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secrets of equal expected length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
