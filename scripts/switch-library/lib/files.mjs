/**
 * Deterministic files for the Switch library: stable key order, one map entry per line in the committed snapshots
 * (readable diffs), LF line endings, sha256 content hashes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SNAPSHOT_DIR = path.join(ROOT, "catalog", "switch-library");
export const WIKIDATA_SNAPSHOT = path.join(SNAPSHOT_DIR, "wikidata.json");
export const WIKIPEDIA_SNAPSHOT = path.join(SNAPSHOT_DIR, "wikipedia.json");
export const SELECTION_LOG = path.join(SNAPSHOT_DIR, "selection-log.json");
export const PUBLIC_DIR = path.join(ROOT, "public", "library", "switch");
export const CHUNK_DIR = path.join(PUBLIC_DIR, "d");
export const MANIFEST = path.join(ROOT, "app", "routes", "storefront", "builder", "library.manifest.ts");

/** First 8 hex digits of the sha256 of `text` (UTF-8). */
export const hash8 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

/** A stable unsigned 32-bit number for `text` (the first 4 bytes of its sha256). */
export const stableU32 = (text) => createHash("sha256").update(text, "utf8").digest().readUInt32BE(0);

/** Wikidata ids by number ("Q9" before "Q10"), everything else by code point. */
export function compareKeys(a, b) {
  const qa = /^Q(\d+)$/.exec(a);
  const qb = /^Q(\d+)$/.exec(b);
  if (qa && qb) return Number(qa[1]) - Number(qb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A snapshot file: the header fields first (one per line), then each section as a map with one entry per line,
 * keys sorted with compareKeys.
 */
export function formatSnapshot(header, sections) {
  const parts = Object.entries(header).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  for (const [name, map] of Object.entries(sections)) {
    const keys = Object.keys(map).sort(compareKeys);
    const body = keys.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(map[key])}`).join(",\n");
    parts.push(`  ${JSON.stringify(name)}: {${keys.length > 0 ? `\n${body}\n  ` : ""}}`);
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/** Today in UTC, YYYY-MM-DD. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);
