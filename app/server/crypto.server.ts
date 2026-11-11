/**
 * Cryptography for the server core — WebCrypto only, so the same code runs in Workers, in tests
 * (Node) and in scripts. Nothing here reads the environment: keys and secrets are parameters.
 *
 *   passwords      hashPassword / verifyPassword / needsRehash     PBKDF2-SHA256, 16-byte random salt
 *   secrets at rest encryptSecret / decryptSecret                   AES-256-GCM with DATA_KEY
 *   small tokens   signToken / verifyToken, hmacSha256Hex           HMAC-SHA256 with SESSION_SECRET
 *   TOTP           generateTotpSecret / totpCode / verifyTotp       RFC 6238 (SHA-1, 30 s, 6 digits)
 *   recovery codes generateRecoveryCodes / hashRecoveryCode         shown once, stored as hashes
 *
 * Session ids, cart tokens and guest access tokens are NOT here: they are random tokens from
 * ~/lib/ids (`randomToken()`), stored only as `sha256Hex(token)`.
 */
import { sha256Hex, timingSafeEqual } from "~/lib/ids";
import { toLatinDigits } from "~/lib/phone";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// ───────────────────────────────────────────────────────────────── encoding

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64 or base64url, with or without padding. Throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  const normalized = text.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) throw new Error("Invalid base64 input");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (what authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces, dashes and "=" padding. Throws on characters outside the alphabet. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error("Invalid base32 input");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (buffer >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** `length` decimal digits, uniformly random (one-time codes). */
export function randomDigits(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 250 is the largest multiple of 10 below 256: rejecting the rest keeps every digit equally likely.
      if (byte < 250 && out.length < length) out += String(byte % 10);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── passwords

/** Cloudflare Workers refuse PBKDF2 above 100,000 iterations, so that is both the default and the ceiling. */
export const PASSWORD_ITERATIONS = 100_000;
export const MAX_PASSWORD_ITERATIONS = 100_000;
const MIN_PASSWORD_ITERATIONS = 1_000;
const PASSWORD_SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** Longer inputs are refused before hashing (a password field is not a file upload). */
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordHash = {
  /** `pbkdf2-sha256$<iterations>$<salt>$<hash>` — store in `password_hash`. Self-describing: verification needs nothing else. */
  hash: string;
  /** Store in `password_iters` (lets a query find accounts that still need a rehash). */
  iterations: number;
};

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  // NFKC: the same password typed on different keyboards must hash the same.
  const material = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

function parsePasswordHash(encoded: string | null | undefined): { iterations: number; salt: Uint8Array; hash: Uint8Array } | null {
  if (!encoded) return null;
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_SCHEME || !/^\d{1,7}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (iterations < 1 || iterations > MAX_PASSWORD_ITERATIONS) return null;
  try {
    const salt = fromBase64(parts[2]);
    const hash = fromBase64(parts[3]);
    return salt.length >= 8 && hash.length === HASH_BYTES ? { iterations, salt, hash } : null;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string, iterations: number = PASSWORD_ITERATIONS): Promise<PasswordHash> {
  if (!Number.isSafeInteger(iterations) || iterations < MIN_PASSWORD_ITERATIONS || iterations > MAX_PASSWORD_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be between ${MIN_PASSWORD_ITERATIONS} and ${MAX_PASSWORD_ITERATIONS}, got ${iterations}`);
  }
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) throw new Error("Password length is out of range");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, iterations);
  return { hash: `${PASSWORD_SCHEME}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`, iterations };
}

const DUMMY_SALT = new Uint8Array(SALT_BYTES);
/** Derived instead of an empty or over-long password: some runtimes refuse empty PBKDF2 key material, and the time spent must not differ. */
const UNUSABLE_PASSWORD = "\u0000unusable";

/**
 * Constant-time check of a password against a stored hash. A missing or malformed hash, an empty
 * password and an over-long one still cost one full derivation, so "no such account" and "wrong
 * password" take the same time.
 */
export async function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  const usable = typeof password === "string" && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  const candidate = usable ? password : UNUSABLE_PASSWORD;
  const parsed = parsePasswordHash(encoded);
  if (!parsed) {
    await pbkdf2(candidate, DUMMY_SALT, PASSWORD_ITERATIONS);
    return false;
  }
  const derived = await pbkdf2(candidate, parsed.salt, parsed.iterations);
  return equalBytes(derived, parsed.hash) && usable;
}

/** True when a stored hash should be replaced at the next successful sign-in (weaker than today's setting, or unreadable). */
export function needsRehash(encoded: string | null | undefined, iterations: number = PASSWORD_ITERATIONS): boolean {
  const parsed = parsePasswordHash(encoded);
  return !parsed || parsed.iterations < iterations || parsed.salt.length < SALT_BYTES;
}

// ───────────────────────────────────────────────────────────────── secrets at rest (AES-256-GCM)

const SEALED_VERSION = "v1";
const IV_BYTES = 12;
const aesKeys = new Map<string, Promise<CryptoKey>>();

function importDataKey(dataKey: string | null | undefined): Promise<CryptoKey> {
  if (!dataKey) throw new Error("DATA_KEY is not configured");
  let key = aesKeys.get(dataKey);
  if (!key) {
    let raw: Uint8Array;
    try {
      raw = fromBase64(dataKey);
    } catch {
      throw new Error("DATA_KEY must be base64");
    }
    if (raw.length !== 32) throw new Error("DATA_KEY must decode to exactly 32 bytes (AES-256)");
    key = crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    aesKeys.set(dataKey, key);
  }
  return key;
}

/**
 * Encrypts a secret for storage (TOTP secrets, digital codes, integration credentials).
 * `context` binds the ciphertext to where it lives — e.g. `employee:<id>:totp` — so a value copied
 * into another row or column fails to decrypt. Output: `v1.<iv>.<ciphertext+tag>` (base64url).
 */
export async function encryptSecret(plaintext: string, dataKey: string | null | undefined, context = ""): Promise<string> {
  const key = await importDataKey(dataKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(context) as BufferSource }, key, encoder.encode(plaintext) as BufferSource);
  return `${SEALED_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** Reverses encryptSecret. Throws when the value was altered, belongs to another context, or the key is wrong. */
export async function decryptSecret(sealed: string, dataKey: string | null | undefined, context = ""): Promise<string> {
  const key = await importDataKey(dataKey);
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== SEALED_VERSION) throw new Error("Unreadable encrypted value");
  try {
    const iv = fromBase64(parts[1]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(context) as BufferSource }, key, fromBase64(parts[2]) as BufferSource);
    return decoder.decode(plain);
  } catch {
    throw new Error("Encrypted value could not be decrypted (wrong key, wrong context, or altered data)");
  }
}

// ───────────────────────────────────────────────────────────────── HMAC and small signed tokens

const MIN_SECRET_LENGTH = 32;
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function importHmacKey(secret: string | null | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error(`Signing secret is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secret, key);
  }
  return key;
}

/** HMAC-SHA256 of a message, hex. A keyed hash: useless to someone who only has the database. */
export async function hmacSha256Hex(secret: string | null | undefined, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), encoder.encode(message) as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const TOKEN_DOMAIN = "tamtam.token.v1.";
const MAX_TOKEN_LENGTH = 2048;

export type SignTokenOptions = {
  /** What the token is for ("upload", "mfa_pending"…). A token is only accepted for the purpose it was signed for. */
  purpose: string;
  /** Epoch ms after which the token is refused. */
  expiresAt: number;
};

/**
 * A small, tamper-proof, expiring token: `<payload>.<signature>`. The payload is readable by whoever
 * holds the token (it is signed, not encrypted) — never put secrets in it.
 */
export async function signToken(payload: Record<string, unknown>, secret: string | null | undefined, options: SignTokenOptions): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ p: options.purpose, e: Math.floor(options.expiresAt), d: payload })));
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), encoder.encode(TOKEN_DOMAIN + body) as BufferSource);
  const token = `${body}.${toBase64Url(new Uint8Array(signature))}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error("Signed token payload is too large");
  return token;
}

/** The payload of a valid token, or null when it is forged, altered, expired or meant for another purpose. */
export async function verifyToken<T extends Record<string, unknown> = Record<string, unknown>>(
  token: string | null | undefined,
  secret: string | null | undefined,
  options: { purpose: string; now: number },
): Promise<T | null> {
  const key = await importHmacKey(secret);
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  try {
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64(token.slice(dot + 1)) as BufferSource, encoder.encode(TOKEN_DOMAIN + body) as BufferSource);
    if (!valid) return null;
    const parsed = JSON.parse(decoder.decode(fromBase64(body))) as { p?: unknown; e?: unknown; d?: unknown };
    if (parsed.p !== options.purpose || typeof parsed.e !== "number" || parsed.e <= options.now) return null;
    return typeof parsed.d === "object" && parsed.d !== null ? (parsed.d as T) : null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────── TOTP (RFC 6238)

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";
export type TotpOptions = {
  /** Default 6. */
  digits?: number;
  /** Seconds per step, default 30. */
  periodSec?: number;
  /** Default SHA-1 — the only algorithm every authenticator app implements. */
  algorithm?: TotpAlgorithm;
};

export const TOTP_DEFAULTS = { digits: 6, periodSec: 30, algorithm: "SHA-1" as TotpAlgorithm, window: 1 };

/** A new shared secret: 20 random bytes (the SHA-1 block the RFC recommends), base32. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message as BufferSource));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) * 0x100_0000 + (mac[offset + 1] << 16) + (mac[offset + 2] << 8) + mac[offset + 3]) >>> 0;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The step (time counter) a moment falls in. */
export function totpStep(timeMs: number, periodSec: number = TOTP_DEFAULTS.periodSec): number {
  return Math.floor(timeMs / 1000 / periodSec);
}

/** The code an authenticator shows at `timeMs`. */
export async function totpCode(secretBase32: string, timeMs: number, options: TotpOptions = {}): Promise<string> {
  const { digits = TOTP_DEFAULTS.digits, periodSec = TOTP_DEFAULTS.periodSec, algorithm = TOTP_DEFAULTS.algorithm } = options;
  return hotp(base32Decode(secretBase32), totpStep(timeMs, periodSec), digits, algorithm);
}

export type TotpVerification = { ok: true; step: number } | { ok: false; reason: "invalid" | "replayed" };

/**
 * Checks a code against the current step and `window` steps either side (default ±1, i.e. up to
 * 30 s of clock drift). REPLAY GUARD: pass the last step this account already used as
 * `lastUsedStep`; a code for that step or an earlier one is refused even though it is still inside
 * the window. On success, persist the returned `step` as the new last used step.
 */
export async function verifyTotp(
  secretBase32: string,
  input: string,
  timeMs: number,
  options: TotpOptions & { window?: number; lastUsedStep?: number | null } = {},
): Promise<TotpVerification> {
  const { digits = TOTP_DEFAULTS.digits, periodSec = TOTP_DEFAULTS.periodSec, algorithm = TOTP_DEFAULTS.algorithm, window = TOTP_DEFAULTS.window } = options;
  const code = toLatinDigits(String(input)).replace(/[\s-]/g, "");
  if (code.length !== digits || !/^\d+$/.test(code)) return { ok: false, reason: "invalid" };
  let key: Uint8Array;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (key.length === 0) return { ok: false, reason: "invalid" };

  const current = totpStep(timeMs, periodSec);
  let matched: number | null = null;
  // Every candidate is computed and compared, whether or not an earlier one matched.
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    const expected = await hotp(key, step, digits, algorithm);
    if (timingSafeEqual(expected, code)) matched = step;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (options.lastUsedStep != null && matched <= options.lastUsedStep) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

/** The `otpauth://` URI an authenticator app scans (render it as a QR code; also show the secret for manual entry). */
export function otpauthUri(input: { secret: string; account: string; issuer?: string } & TotpOptions): string {
  const issuer = input.issuer ?? "TamTam Games";
  const { digits = TOTP_DEFAULTS.digits, periodSec = TOTP_DEFAULTS.periodSec, algorithm = TOTP_DEFAULTS.algorithm } = input;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`;
  const query = `secret=${input.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=${algorithm.replace("-", "")}&digits=${digits}&period=${periodSec}`;
  return `otpauth://totp/${label}?${query}`;
}

// ───────────────────────────────────────────────────────────────── recovery codes

/** No look-alike characters (0/O, 1/I/L, U). */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_LENGTH = 10;

/** One-time codes for signing in when the authenticator is lost: "7K4M2-Q9XWB". Show them once, store hashRecoveryCode() of each. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    let code = "";
    while (code.length < RECOVERY_LENGTH) {
      for (const byte of crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH * 2))) {
        // 240 = 8 × 30: rejection sampling keeps the 30-character alphabet uniform.
        if (byte < 240 && code.length < RECOVERY_LENGTH) code += RECOVERY_ALPHABET[byte % 30];
      }
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The stored form of a recovery code (the codes are random, so a plain SHA-256 is enough). */
export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(`tamtam.recovery.v1:${normalizeRecoveryCode(code)}`);
}

/** Index of the stored hash a typed code matches, or -1. Compares against every hash. */
export async function findRecoveryCode(code: string, hashes: readonly string[]): Promise<number> {
  if (normalizeRecoveryCode(code).length !== RECOVERY_LENGTH) return -1;
  const candidate = await hashRecoveryCode(code);
  let found = -1;
  hashes.forEach((hash, index) => {
    if (timingSafeEqual(hash, candidate)) found = index;
  });
  return found;
}
