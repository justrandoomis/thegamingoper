#!/usr/bin/env node
/**
 * Validate catalogue research files (catalog/products/*.json) against catalog/README.md.
 *   node scripts/products/validate.mjs              all files
 *   node scripts/products/validate.mjs slug1 slug2  only these
 * Exit code 1 when any file has errors. Warnings do not fail.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const DIR = path.join(ROOT, "catalog", "products");

const KINDS = ["console", "handheld_pc", "game", "controller", "headset", "storage", "accessory", "vr", "digital"];
const PLATFORMS = ["nintendo", "playstation", "xbox", "pc_handheld", "multi"];
const STATUSES = ["available", "preorder", "upcoming", "discontinued", "limited"];
const COMPAT = ["verified", "partial", "incompatible", "unverified"];
const RELATED = ["setup", "accessory", "upsell", "alternative"];
const IMAGE_KINDS = ["hero", "angle", "detail", "in-box", "box-art", "screenshot"];
const ARABIC = ["voice+subtitles+interface", "subtitles+interface", "interface", "none", "unknown"];
const FORMATS = ["cartridge", "game-key-card", "disc", "code-in-box"];

const only = process.argv.slice(2);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
const all = new Map();
for (const f of files) {
  try {
    all.set(f.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(DIR, f), "utf8")));
  } catch (e) {
    all.set(f.replace(/\.json$/, ""), { __parseError: String(e.message) });
  }
}

let errorCount = 0;
let warnCount = 0;
const skus = new Map();
const imageKeys = new Map();

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-zÀ-ɏ]/;
/** The first letter that sets a line's direction: "latin", "arabic" or null (digits and signs only). */
function firstStrong(text) {
  for (const char of String(text)) {
    if (ARABIC_SCRIPT.test(char)) return "arabic";
    if (LATIN.test(char)) return "latin";
  }
  return null;
}

/**
 * Design v2 spec §4.11: a name that opens with Latin is a Latin title — an Arabic or Sorani qualifier inside it makes
 * the runs reorder in RTL rows («PlayStation 5 (الطراز» / «الأصلي 2020)»). Such words go to `qualifier` (printed on
 * the cards' meta line), or the name opens with them («قرص Samsung 990 PRO …»).
 */
function checkName(name, errs) {
  for (const lang of ["ar", "en", "ckb"]) {
    const text = name?.[lang];
    if (typeof text === "string" && firstStrong(text) === "latin" && ARABIC_SCRIPT.test(text)) {
      errs.push(`name.${lang} "${text}" opens with Latin and has Arabic-script words inside: keep the Latin title and move those words to "qualifier" (or open the name with them)`);
    }
  }
}

/**
 * Design v2 spec §4.18: a name's Latin tokens never break across lines. Carts, checkout and order lines print the stored
 * name and variant title as they are, so a hyphen inside a token («USB-C», «Joy-Con», «Z-A») is the non-breaking hyphen
 * U+2011 there (QA 2026-11-13: «…Battery + USB-» / «C Cable» on a 390 px cart line). Search folds it like "-".
 */
const TOKEN_HYPHEN = /(?<=[\p{Script=Latin}\d])-(?=[\p{Script=Latin}\d])/u;
function checkTokenHyphens(text, where, errs) {
  for (const lang of ["ar", "en", "ckb"]) {
    const value = text?.[lang];
    if (typeof value === "string" && TOKEN_HYPHEN.test(value)) {
      errs.push(`${where}.${lang} "${value}" has a plain hyphen inside a Latin token: write the non-breaking hyphen U+2011 («USB‑C») so the token never breaks across lines`);
    }
  }
}

/** `qualifier`: optional; the words a Latin title leaves out, per language ("" where the name already says it). */
function checkQualifier(qualifier, errs) {
  if (qualifier === undefined) return;
  if (!qualifier || typeof qualifier !== "object") return errs.push("qualifier: must be an object with ar, en and ckb");
  for (const lang of ["ar", "en", "ckb"]) if (typeof qualifier[lang] !== "string") errs.push(`qualifier.${lang}: missing (use "" when the name says it in that language)`);
  if (["ar", "en", "ckb"].every((lang) => !String(qualifier[lang] ?? "").trim())) errs.push("qualifier: empty in every language — leave it out");
}

/**
 * Design v2 spec §4.13: a variant's title is the option value only («لجهاز PS5», "International model") — carts and
 * order lines print it under the product's name, so it never opens with that name; an English value starts with a
 * capital. A product with one version may carry its own name as the title (no option line is printed then).
 */
function checkVariantTitle(product, variant, i, errs) {
  const title = variant.title ?? {};
  // the name, and its head before a separator ("EA SPORTS FC 27" of "EA SPORTS FC 27 · Nintendo Switch 2")
  const heads = (name) => {
    const text = String(name ?? "").trim();
    const head = text.split(/\s+[·–—-]\s+|\s+\(/)[0].trim();
    return [...new Set([text, head].filter((part) => part.length >= 4))].map((part) => part.toLowerCase());
  };
  for (const lang of ["ar", "en", "ckb"]) {
    const text = String(title[lang] ?? "").trim();
    const name = String(product.name?.[lang] ?? "").trim();
    if (!text || !name || text === name) continue;
    const lower = text.toLowerCase();
    const repeats = [...heads(name), ...heads(product.name?.en)].some((head) => lower === head || lower.startsWith(`${head} `) || lower.startsWith(`${head}:`) || lower.startsWith(`${head},`) || lower.startsWith(`${head}‏`));
    if (repeats) errs.push(`variants[${i}].title.${lang} "${text}" repeats the product name: write the option value only`);
  }
  const en = String(title.en ?? "").trim();
  if (en && /^[a-z]/.test(en) && en !== product.name?.en) errs.push(`variants[${i}].title.en "${en}" starts with a small letter`);
}

function l10n(v, where, errs) {
  if (!v || typeof v !== "object") return errs.push(`${where}: missing L10n object`);
  for (const lang of ["ar", "en", "ckb"]) {
    if (typeof v[lang] !== "string" || !v[lang].trim()) errs.push(`${where}.${lang}: empty`);
  }
  if (typeof v.ckb === "string" && /[a-z]{4,}/.test(v.ckb) && !/[؀-ۿ]/.test(v.ckb)) {
    // Kurdish Sorani text with no Arabic-script letters at all is suspicious (unless it is only a product name).
  }
}

for (const [slug, p] of all) {
  if (only.length && !only.includes(slug)) continue;
  const errs = [];
  const warns = [];
  if (p.__parseError) {
    errs.push(`invalid JSON: ${p.__parseError}`);
  } else {
    if (p.slug !== slug) errs.push(`slug "${p.slug}" does not match file name "${slug}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) errs.push("slug must be kebab-case");
    if (!p.group) errs.push("group missing");
    if (!KINDS.includes(p.kind)) errs.push(`kind must be one of ${KINDS.join("|")}`);
    if (!PLATFORMS.includes(p.platform)) errs.push(`platform must be one of ${PLATFORMS.join("|")}`);
    if (!STATUSES.includes(p.status)) errs.push(`status must be one of ${STATUSES.join("|")}`);
    if (p.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.releaseDate)) errs.push("releaseDate must be YYYY-MM-DD");
    if (!p.brand) errs.push("brand missing");
    l10n(p.name, "name", errs);
    checkName(p.name, errs);
    checkTokenHyphens(p.name, "name", errs);
    checkQualifier(p.qualifier, errs);
    l10n(p.short, "short", errs);
    l10n(p.description, "description", errs);
    if (!Array.isArray(p.highlights) || p.highlights.length < 2) warns.push("fewer than 2 highlights");
    (p.highlights || []).forEach((h, i) => l10n(h, `highlights[${i}]`, errs));
    (p.specs || []).forEach((s, i) => {
      if (!s.key) errs.push(`specs[${i}].key missing`);
      l10n(s.label, `specs[${i}].label`, errs);
      l10n(s.value, `specs[${i}].value`, errs);
    });
    (p.inTheBox || []).forEach((b, i) => l10n(b, `inTheBox[${i}]`, errs));
    if (!Array.isArray(p.variants) || !p.variants.length) errs.push("at least one variant required");
    let defaults = 0;
    (p.variants || []).forEach((v, i) => {
      if (!v.sku || !/^[A-Z0-9][A-Z0-9-]{2,40}$/.test(v.sku)) errs.push(`variants[${i}].sku must be uppercase letters/digits/dashes`);
      if (skus.has(v.sku)) errs.push(`variants[${i}].sku ${v.sku} duplicates ${skus.get(v.sku)}`);
      else skus.set(v.sku, slug);
      l10n(v.title, `variants[${i}].title`, errs);
      checkVariantTitle(p, v, i, errs);
      checkTokenHyphens(v.title, `variants[${i}].title`, errs);
      if (v.isDefault) defaults++;
      for (const k of v.images || []) if (!(p.images || []).some((im) => im.key === k)) errs.push(`variants[${i}].images references unknown image "${k}"`);
      if (v.priceIqd !== undefined && v.priceIqd !== null) warns.push(`variants[${i}].priceIqd is set — prices are not researched`);
    });
    if (p.variants?.length && defaults !== 1) errs.push(`exactly one default variant required (found ${defaults})`);
    if (p.kind === "game") {
      const g = p.game || {};
      if (!Array.isArray(g.platforms) || !g.platforms.length) errs.push("game.platforms required");
      if (g.arabic && !ARABIC.includes(g.arabic)) errs.push(`game.arabic must be one of ${ARABIC.join("|")}`);
      if (!g.arabic) warns.push("game.arabic not stated (use \"unknown\" if the official page does not say)");
      if (g.physicalFormat && !FORMATS.includes(g.physicalFormat)) errs.push(`game.physicalFormat must be one of ${FORMATS.join("|")}`);
      if (!g.ageRating) warns.push("game.ageRating missing");
    }
    (p.compatibility || []).forEach((c, i) => {
      if (!c.deviceModel) errs.push(`compatibility[${i}].deviceModel missing`);
      if (!COMPAT.includes(c.status)) errs.push(`compatibility[${i}].status must be one of ${COMPAT.join("|")}`);
      if (c.note) l10n(c.note, `compatibility[${i}].note`, errs);
      if (c.status !== "unverified" && !c.source) warns.push(`compatibility[${i}] has no source`);
    });
    (p.related || []).forEach((r, i) => {
      if (!RELATED.includes(r.kind)) errs.push(`related[${i}].kind must be one of ${RELATED.join("|")}`);
      if (r.slug && !all.has(r.slug)) warns.push(`related[${i}] points at "${r.slug}" which has no file (yet)`);
    });
    if (!Array.isArray(p.images) || !p.images.length) errs.push("at least one image required");
    (p.images || []).forEach((im, i) => {
      if (!new RegExp(`^${slug}--\\d+$`).test(im.key || "")) errs.push(`images[${i}].key must be "${slug}--<n>"`);
      if (imageKeys.has(im.key)) errs.push(`images[${i}].key duplicates one in ${imageKeys.get(im.key)}`);
      else imageKeys.set(im.key, slug);
      if (!im.file || !existsSync(path.join(ROOT, im.file))) errs.push(`images[${i}].file not found: ${im.file}`);
      if (!/^https?:\/\//.test(im.sourceUrl || "")) errs.push(`images[${i}].sourceUrl missing`);
      if (!IMAGE_KINDS.includes(im.kind)) errs.push(`images[${i}].kind must be one of ${IMAGE_KINDS.join("|")}`);
      // "view": "back" marks a picture of the object's back (ports, stand): never a tile or a lead picture
      if (im.view !== undefined && im.view !== "back") errs.push(`images[${i}].view must be "back" when given`);
      if (im.view === "back" && i === 0) errs.push(`images[${i}]: the first image cannot be a back view`);
      if (!im.credit) errs.push(`images[${i}].credit missing`);
      l10n(im.alt, `images[${i}].alt`, errs);
    });
    if (p.kind === "game" && p.images?.[0]?.kind !== "box-art") warns.push("first image of a game should be the box art");
    if (!Array.isArray(p.sources) || p.sources.length < 2) errs.push("at least two sources required (official + confirmation)");
    (p.sources || []).forEach((s, i) => {
      if (!/^https?:\/\//.test(s.url || "")) errs.push(`sources[${i}].url missing`);
      if (!s.supports) warns.push(`sources[${i}].supports missing`);
    });
    if (p.notes) l10n(p.notes, "notes", errs);
  }
  if (errs.length || warns.length) {
    console.log(`\n${slug}`);
    for (const e of errs) console.log(`  ERROR ${e}`);
    for (const w of warns) console.log(`  warn  ${w}`);
  }
  errorCount += errs.length;
  warnCount += warns.length;
}

const checked = only.length ? only.length : all.size;
console.log(`\n${checked} file(s) checked — ${errorCount} error(s), ${warnCount} warning(s)`);
process.exit(errorCount ? 1 : 0);
