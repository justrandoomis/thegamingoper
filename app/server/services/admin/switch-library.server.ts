/**
 * Admin — the Switch game library of the bundle builder: TamTam's OWN data per game (docs/switch-builder.md §1, §4.2,
 * §7), stored in D1 `switch_library_entries` and served to the builder by getLibraryExtras (the data owner's read path).
 *
 *   const rows  = await listLibraryRows(db, actor);                              // the list (merged with the open list on the client)
 *   const entry = await getLibraryEntry(db, actor, gameId, now);                 // the edit page
 *   await saveLibraryEntry(db, actor, form, now);                                 // sizes, price, trailer, texts, licensed score, hidden
 *   await uploadLibraryImage(db, store, actor, { gameId }, file, now);           // a public picture (/media/<key>)
 *   await removeLibraryImage(db, store, actor, { gameId }, now);
 *   const plan = await previewLibraryCsv(db, actor, file, now);                  // writes nothing
 *   await applyLibraryCsv(db, actor, file, { fingerprint: plan.fingerprint }, now);
 *   const { csv } = await exportLibraryCsv(db, actor, now);
 *
 * PERMISSIONS: reading needs catalog.product.read; every change, import and export needs
 * catalog.switch_library.manage (app/server/permissions.ts; manager and content roles).
 *
 * WHAT STAFF ENTER (rules in ~/routes/admin/catalog/switch-library-input, shared with the edit page):
 *   · sizes in GB as the console shows them (binary, two decimals at most; MB for small games) → bytes. The digital
 *     size is the full installed size after the latest update; the cartridge figure is what a cartridge copy needs on
 *     the console (0 allowed; empty = counted at full size until measured).
 *   · the Nintendo eShop (US) price in US dollars → cents; a Metacritic score, its review count (at least 4) and date
 *     only while TamTam holds the Metacritic licence; the official trailer as a YouTube link or id → the 11-character id.
 *   · every figure carries its "as of" day: today (Baghdad) when it changes without one.
 * Nothing is fetched from Nintendo's or Metacritic's sites, here or anywhere else in the library (contract §1).
 *
 * WRITES: one db.batch per save (guarded by the row's updated_at: a second tab or a colleague's save in between fails
 * with `entry_changed` instead of overwriting) and per import chunk; every change writes an audit event with the
 * changed fields before and after; timestamps are the request's `now`.
 *
 * CSV IMPORT: preview → apply, stateless — the preview writes nothing and returns a fingerprint of the file, the day
 * and the rows it read; apply re-reads the same file, refuses when the fingerprint no longer matches
 * (`import_stale`), and writes the changed games in chunks of CHUNK (one batch each: a guard that the chunk's rows
 * are still as the preview saw them, the upserts, one audit event per game). Lookups pass the ids as ONE bound
 * parameter (json_each), so D1's limit of 100 parameters per statement never applies to the file's size; every
 * write statement binds about 30.
 */
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import {
  LIBRARY_CSV_CLEAR,
  LIBRARY_CSV_COLUMNS,
  LIBRARY_CSV_MAX_BYTES,
  LIBRARY_CSV_MAX_CHANGES,
  LIBRARY_CSV_MAX_ROWS,
  LIBRARY_CSV_READ_ONLY,
  LIBRARY_ID_MAX,
  LIBRARY_ID_PATTERN,
  MAX_DESCRIPTION,
  MAX_METACRITIC_REVIEWS,
  MIN_METACRITIC_REVIEWS,
  baghdadDay,
  formatSizeInput,
  formatUsdInput,
  isLibraryGameId,
  normalizeGameId,
  parseAsOfDate,
  parseSizeInput,
  parseUsdInput,
  parseWholeNumber,
  parseYesNo,
  parseYouTubeId,
  sameSize,
  sizeLabel,
  usdLabel,
  type LibraryCsvColumn,
} from "~/routes/admin/catalog/switch-library-input";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { employees, files, switchLibraryEntries, type SwitchLibraryDescription, type SwitchLibraryEntry } from "~/server/db/schema";
import { expectChanged, expectThat, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError, type FieldErrors } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { deleteFile, putFile, type BlobStore } from "~/server/storage.server";
import { cleanBlock } from "~/server/text.server";
import { processImageUpload, type UploadSource } from "~/server/uploads.server";
import { CsvError, parseCsv, toCsv, type ParsedCsv } from "./catalog/csv";

export const SWITCH_LIBRARY_MANAGE: Permission = "catalog.switch_library.manage";
const READ: Permission = "catalog.product.read";

/** Audit entity of a game's row, and the `files` kind / owner of its uploaded picture. */
export const LIBRARY_ENTITY = "switch_library_entry";
export const LIBRARY_IMAGE_KIND = "switch_library_image";
/** Games written per import batch: 1 guard + CHUNK upserts + CHUNK audit events. */
export const LIBRARY_CSV_CHUNK = 40;
/** The preview lists at most this many rows in detail (the counts cover every row). */
const PREVIEW_ROWS_SHOWN = 1000;

/** Error keys of this service (translated as `errors.<key>` in the admin-switch-library namespace). */
export const LIBRARY_ERROR_KEYS = [
  "id_invalid",
  "id_repeated",
  "size_format",
  "size_zero",
  "size_too_big",
  "price_format",
  "price_too_big",
  "trailer_invalid",
  "date_invalid",
  "date_ambiguous",
  "date_too_early",
  "date_future",
  "score_range",
  "reviews_range",
  "metacritic_incomplete",
  "hidden_invalid",
  "entry_changed",
  "csv_game_id_column",
  "csv_rows_limit",
  "csv_not_text",
  "csv_encoding",
  "description_script",
  "import_stale",
  "import_nothing",
  "import_too_many",
] as const;

const LANGS = ["ar", "en", "ckb"] as const;
type Lang = (typeof LANGS)[number];

// ───────────────────────────────────────────────────────────────── values

/** TamTam's values for one game as stored (the picture has its own actions). */
export type EntryValues = {
  sizeBytes: number | null;
  cartridgeBytes: number | null;
  sizeAsOf: string | null;
  priceUsdCents: number | null;
  priceAsOf: string | null;
  trailerYoutubeId: string | null;
  description: SwitchLibraryDescription | null;
  metacriticScore: number | null;
  metacriticReviews: number | null;
  metacriticAsOf: string | null;
  isHidden: boolean;
};
type ValueKey = keyof EntryValues;

const EMPTY_VALUES: EntryValues = {
  sizeBytes: null,
  cartridgeBytes: null,
  sizeAsOf: null,
  priceUsdCents: null,
  priceAsOf: null,
  trailerYoutubeId: null,
  description: null,
  metacriticScore: null,
  metacriticReviews: null,
  metacriticAsOf: null,
  isHidden: false,
};
const VALUE_KEYS = Object.keys(EMPTY_VALUES) as ValueKey[];

function valuesOf(row: SwitchLibraryEntry | null | undefined): EntryValues {
  if (!row) return { ...EMPTY_VALUES };
  return {
    sizeBytes: row.sizeBytes,
    cartridgeBytes: row.cartridgeBytes,
    sizeAsOf: row.sizeAsOf,
    priceUsdCents: row.priceUsdCents,
    priceAsOf: row.priceAsOf,
    trailerYoutubeId: row.trailerYoutubeId,
    description: row.description && Object.keys(row.description).length > 0 ? row.description : null,
    metacriticScore: row.metacriticScore,
    metacriticReviews: row.metacriticReviews,
    metacriticAsOf: row.metacriticAsOf,
    isHidden: row.isHidden,
  };
}

const sameDescription = (a: SwitchLibraryDescription | null, b: SwitchLibraryDescription | null) => LANGS.every((lang) => (a?.[lang] ?? null) === (b?.[lang] ?? null));

/** The fields whose stored value would change. */
function changedKeys(before: EntryValues, after: EntryValues): ValueKey[] {
  return VALUE_KEYS.filter((key) => {
    if (key === "description") return !sameDescription(before.description, after.description);
    if (key === "sizeBytes" || key === "cartridgeBytes") return !sameSize(before[key], after[key]);
    return before[key] !== after[key];
  });
}

const pick = (values: EntryValues, keys: readonly ValueKey[]) => Object.fromEntries(keys.map((key) => [key, values[key]]));

// ───────────────────────────────────────────────────────────────── one input, two sources

/** What an input says about a field: leave it (a CSV's empty cell or missing column), clear it, or set it from text. */
type Cell = { kind: "keep" } | { kind: "clear" } | { kind: "set"; text: string };
const KEEP: Cell = { kind: "keep" };
const CLEAR: Cell = { kind: "clear" };

type PatchKey = "size" | "cartridge" | "sizeAsOf" | "price" | "priceAsOf" | "trailer" | "description.ar" | "description.en" | "description.ckb" | "score" | "reviews" | "scoreAsOf" | "hidden";
type Patch = Record<PatchKey, Cell>;
/** Where an error is reported: the form's field name or the CSV's column. */
type FieldNames = Record<PatchKey, string>;

const FORM_FIELDS: FieldNames = {
  size: "size",
  cartridge: "cartridge",
  sizeAsOf: "sizeAsOf",
  price: "price",
  priceAsOf: "priceAsOf",
  trailer: "trailer",
  "description.ar": "description.ar",
  "description.en": "description.en",
  "description.ckb": "description.ckb",
  score: "metacritic.score",
  reviews: "metacritic.reviews",
  scoreAsOf: "metacritic.asOf",
  hidden: "hidden",
};

const CSV_FIELDS: Record<PatchKey, LibraryCsvColumn> = {
  size: "size_gb",
  cartridge: "cartridge_gb",
  sizeAsOf: "size_as_of",
  price: "price_usd",
  priceAsOf: "price_as_of",
  trailer: "trailer",
  "description.ar": "description_ar",
  "description.en": "description_en",
  "description.ckb": "description_ckb",
  score: "metacritic_score",
  reviews: "metacritic_reviews",
  scoreAsOf: "metacritic_as_of",
  hidden: "hidden",
};

/** A description as stored: cleaned (no control or bidi-override characters), at most one blank line in a row. */
const cleanDescription = (text: string) => cleanBlock(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** A letter of the Arabic script (Arabic and Sorani): the ar and ckb descriptions of a sheet must hold one. */
const ARABIC_LETTER = /(?=\p{Script=Arabic})\p{L}/u;

/**
 * The values after an input, with its field errors (the rules of docs/switch-builder.md §7):
 *   · sizes, price, trailer, texts, score and reviews parse from what staff typed; an untouched size is kept as stored
 *   · an as-of day goes with its value: none without one, today when the value changes and the day is left as it was
 *     (or is missing), else the day given — never in the future, never before the Switch came out
 *   · a sheet ("csv") never moves a day BACK for a value it does not change: a file exported earlier still carries the
 *     older day, and importing it twice must change nothing the second time (the form says what it means: "form")
 *   · a Metacritic score needs its review count and the reverse
 */
function resolve(existing: EntryValues, patch: Patch, today: string, names: FieldNames, source: "form" | "csv"): { values: EntryValues; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const fault = (key: PatchKey, message: string) => {
    if (!(names[key] in errors)) errors[names[key]] = message;
  };
  const next: EntryValues = { ...existing };

  const size = (key: "size" | "cartridge", current: number | null, allowZero: boolean): number | null => {
    const cell = patch[key];
    if (cell.kind === "keep") return current;
    if (cell.kind === "clear") return null;
    const parsed = parseSizeInput(cell.text, { allowZero });
    if (!parsed.ok) {
      fault(key, parsed.error);
      return current;
    }
    return sameSize(current, parsed.value) ? current : parsed.value;
  };
  next.sizeBytes = size("size", existing.sizeBytes, false);
  next.cartridgeBytes = size("cartridge", existing.cartridgeBytes, true);

  const price = patch.price;
  if (price.kind === "clear") next.priceUsdCents = null;
  else if (price.kind === "set") {
    const parsed = parseUsdInput(price.text);
    if (parsed.ok) next.priceUsdCents = parsed.value;
    else fault("price", parsed.error);
  }

  const trailer = patch.trailer;
  if (trailer.kind === "clear") next.trailerYoutubeId = null;
  else if (trailer.kind === "set") {
    const id = parseYouTubeId(trailer.text);
    if (id) next.trailerYoutubeId = id;
    else fault("trailer", "trailer_invalid");
  }

  const description: SwitchLibraryDescription = { ...(existing.description ?? {}) };
  for (const lang of LANGS) {
    const key = `description.${lang}` as const;
    const cell = patch[key];
    if (cell.kind === "keep") continue;
    const text = cell.kind === "set" ? cleanDescription(cell.text) : "";
    if (text.length > MAX_DESCRIPTION) fault(key, "too_long");
    // A sheet saved by Excel as plain "CSV" on a Western Windows turns Arabic and Sorani letters into "?": refuse
    // the row rather than store the question marks over the real text (a text that is already saved passes as it is).
    else if (source === "csv" && lang !== "en" && text !== "" && text !== existing.description?.[lang] && !ARABIC_LETTER.test(text)) fault(key, "description_script");
    else if (text === "") delete description[lang];
    else description[lang] = text;
  }
  next.description = Object.keys(description).length > 0 ? description : null;

  const whole = (key: "score" | "reviews", current: number | null, min: number, max: number, error: string): number | null => {
    const cell = patch[key];
    if (cell.kind === "keep") return current;
    if (cell.kind === "clear") return null;
    const parsed = parseWholeNumber(cell.text, min, max, error);
    if (parsed.ok) return parsed.value;
    fault(key, parsed.error);
    return current;
  };
  next.metacriticScore = whole("score", existing.metacriticScore, 0, 100, "score_range");
  next.metacriticReviews = whole("reviews", existing.metacriticReviews, MIN_METACRITIC_REVIEWS, MAX_METACRITIC_REVIEWS, "reviews_range");
  if (next.metacriticScore !== null && next.metacriticReviews === null) fault("reviews", "metacritic_incomplete");
  if (next.metacriticScore === null && next.metacriticReviews !== null) fault("score", "metacritic_incomplete");

  const hidden = patch.hidden;
  if (hidden.kind === "clear") next.isHidden = false;
  else if (hidden.kind === "set") {
    const value = parseYesNo(hidden.text);
    if (value === null) fault("hidden", "hidden_invalid");
    else next.isHidden = value;
  }

  const asOf = (key: "sizeAsOf" | "priceAsOf" | "scoreAsOf", current: string | null, hasValue: boolean, valueChanged: boolean): string | null => {
    if (!hasValue) return null;
    const cell = patch[key];
    if (cell.kind === "set") {
      // The saved day settles a day/month a spreadsheet made ambiguous (an untouched date after Excel's rewrite).
      const parsed = parseAsOfDate(cell.text, today, current);
      if (!parsed.ok) {
        fault(key, parsed.error);
        return current;
      }
      // The value changed but the day is still the old one (a sheet exported earlier, a form left as it was): today.
      if (valueChanged && parsed.value === current) return today;
      // An unchanged value under an older day in a sheet: the sheet is older than what is saved.
      if (source === "csv" && !valueChanged && current !== null && parsed.value < current) return current;
      return parsed.value;
    }
    if (cell.kind === "clear") return today;
    return valueChanged || current === null ? today : current;
  };
  const sizesChanged = !sameSize(existing.sizeBytes, next.sizeBytes) || !sameSize(existing.cartridgeBytes, next.cartridgeBytes);
  next.sizeAsOf = asOf("sizeAsOf", existing.sizeAsOf, next.sizeBytes !== null || next.cartridgeBytes !== null, sizesChanged);
  next.priceAsOf = asOf("priceAsOf", existing.priceAsOf, next.priceUsdCents !== null, existing.priceUsdCents !== next.priceUsdCents);
  next.metacriticAsOf = asOf(
    "scoreAsOf",
    existing.metacriticAsOf,
    next.metacriticScore !== null || next.metacriticReviews !== null,
    existing.metacriticScore !== next.metacriticScore || existing.metacriticReviews !== next.metacriticReviews,
  );
  return { values: next, errors };
}

// ───────────────────────────────────────────────────────────────── input helpers

const blankToUndefined = (value: unknown) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value);
/** A form field as text ("" when it was not sent). */
const zFormText = (max: number) => z.preprocess((value) => (value === undefined || value === null ? "" : value), z.string({ error: "invalid" }).max(max, "too_long"));
const zBool = z.preprocess((value) => value === true || value === "true" || value === "on" || value === "1", z.boolean());
export const zGameId = z
  .string({ error: "required" })
  .overwrite((value) => normalizeGameId(value))
  .min(1, "required")
  .max(LIBRARY_ID_MAX, "id_invalid")
  .regex(LIBRARY_ID_PATTERN, "id_invalid");

function parseInput<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw toAppError(result.error) ?? invalid({ _: "invalid" });
}

/** A guard failure inside a batch (TT:ENTRY_CHANGED / TT:IMPORT_STALE) as its 409. */
function rethrowLibrary(error: unknown): never {
  const appError = toAppError(error);
  if (appError && (appError.code === "entry_changed" || appError.code === "import_stale")) throw new AppError(appError.code, 409, { detail: appError.detail, cause: error });
  if (appError?.code === "unique") throw new AppError("entry_changed", 409, { cause: error });
  throw error;
}

const entryChanged = (gameId: string) => new AppError("entry_changed", 409, { detail: gameId });

async function loadRow(db: Db, gameId: string): Promise<SwitchLibraryEntry | null> {
  return (await db.select().from(switchLibraryEntries).where(eq(switchLibraryEntries.gameId, gameId)).get()) ?? null;
}

// ───────────────────────────────────────────────────────────────── list and edit page

export type LibraryImage = { key: string; width: number | null; height: number | null };

/** One game's TamTam data as the admin list shows it (no long texts). */
export type LibraryListRow = {
  gameId: string;
  sizeBytes: number | null;
  cartridgeBytes: number | null;
  sizeAsOf: string | null;
  priceUsdCents: number | null;
  priceAsOf: string | null;
  hasTrailer: boolean;
  image: LibraryImage | null;
  descriptionLangs: Lang[];
  hasMetacritic: boolean;
  hidden: boolean;
  updatedAt: number;
};

const servable = (row: { storageKey: string | null; visibility: string | null; deletedAt: number | null }) => row.storageKey !== null && row.visibility === "public" && row.deletedAt === null;

export async function listLibraryRows(db: Db, actor: Actor): Promise<LibraryListRow[]> {
  assertCan(actor, READ);
  const rows = await db
    .select({ entry: switchLibraryEntries, storageKey: files.storageKey, visibility: files.visibility, deletedAt: files.deletedAt, width: files.width, height: files.height })
    .from(switchLibraryEntries)
    .leftJoin(files, eq(files.id, switchLibraryEntries.imageFileId))
    .orderBy(asc(switchLibraryEntries.gameId));
  return rows.map(({ entry, ...file }) => ({
    gameId: entry.gameId,
    sizeBytes: entry.sizeBytes,
    cartridgeBytes: entry.cartridgeBytes,
    sizeAsOf: entry.sizeAsOf,
    priceUsdCents: entry.priceUsdCents,
    priceAsOf: entry.priceAsOf,
    hasTrailer: entry.trailerYoutubeId !== null,
    image: entry.imageFileId && servable(file) ? { key: file.storageKey!, width: file.width, height: file.height } : null,
    descriptionLangs: LANGS.filter((lang) => Boolean(entry.description?.[lang])),
    hasMetacritic: entry.metacriticScore !== null,
    hidden: entry.isHidden,
    updatedAt: entry.updatedAt,
  }));
}

/** The edit form's fields as text (as-of days default to today). */
export type LibraryForm = {
  size: string;
  cartridge: string;
  sizeAsOf: string;
  price: string;
  priceAsOf: string;
  trailer: string;
  description: Record<Lang, string>;
  metacritic: { score: string; reviews: string; asOf: string };
  hidden: boolean;
};

export type LibraryEntryView = {
  gameId: string;
  /** False: TamTam has no data for this game yet (the first save creates the row). */
  exists: boolean;
  /** The row's version for the save's guard (null: no row yet). */
  updatedAt: number | null;
  updatedByName: string | null;
  createdAt: number | null;
  form: LibraryForm;
  values: EntryValues;
  image: LibraryImage | null;
  /** A picture is recorded but its file is gone or not public (it cannot be shown in the store). */
  imageBroken: boolean;
  today: string;
};

function formOf(values: EntryValues, today: string): LibraryForm {
  return {
    size: values.sizeBytes !== null ? formatSizeInput(values.sizeBytes) : "",
    cartridge: values.cartridgeBytes !== null ? formatSizeInput(values.cartridgeBytes) : "",
    sizeAsOf: values.sizeAsOf ?? today,
    price: values.priceUsdCents !== null ? formatUsdInput(values.priceUsdCents) : "",
    priceAsOf: values.priceAsOf ?? today,
    trailer: values.trailerYoutubeId ?? "",
    description: { ar: values.description?.ar ?? "", en: values.description?.en ?? "", ckb: values.description?.ckb ?? "" },
    metacritic: { score: values.metacriticScore?.toString() ?? "", reviews: values.metacriticReviews?.toString() ?? "", asOf: values.metacriticAsOf ?? today },
    hidden: values.isHidden,
  };
}

export async function getLibraryEntry(db: Db, actor: Actor, rawId: unknown, now: number): Promise<LibraryEntryView> {
  assertCan(actor, READ);
  const gameId = typeof rawId === "string" ? normalizeGameId(rawId) : "";
  if (!isLibraryGameId(gameId)) throw notFound(LIBRARY_ENTITY);
  const today = baghdadDay(now);
  const found = await db
    .select({ entry: switchLibraryEntries, storageKey: files.storageKey, visibility: files.visibility, deletedAt: files.deletedAt, width: files.width, height: files.height, editor: employees.name })
    .from(switchLibraryEntries)
    .leftJoin(files, eq(files.id, switchLibraryEntries.imageFileId))
    .leftJoin(employees, eq(employees.id, switchLibraryEntries.updatedBy))
    .where(eq(switchLibraryEntries.gameId, gameId))
    .get();
  const values = valuesOf(found?.entry);
  const image = found?.entry.imageFileId && servable(found) ? { key: found.storageKey!, width: found.width, height: found.height } : null;
  return {
    gameId,
    exists: Boolean(found),
    updatedAt: found?.entry.updatedAt ?? null,
    updatedByName: found?.editor ?? null,
    createdAt: found?.entry.createdAt ?? null,
    form: formOf(values, today),
    values,
    image,
    imageBroken: Boolean(found?.entry.imageFileId) && image === null,
    today,
  };
}

// ───────────────────────────────────────────────────────────────── save (the edit form)

export const SaveEntryInput = z.object({
  gameId: zGameId,
  /** The row's updated_at when the form was opened; empty when the game had no row. */
  updatedAt: z.preprocess(blankToUndefined, z.coerce.number({ error: "invalid" }).int("invalid").nonnegative("invalid").optional()),
  size: zFormText(40),
  cartridge: zFormText(40),
  sizeAsOf: zFormText(40),
  price: zFormText(40),
  priceAsOf: zFormText(40),
  trailer: zFormText(500),
  description: z.object({ ar: zFormText(6000), en: zFormText(6000), ckb: zFormText(6000) }).partial().optional(),
  metacritic: z.object({ score: zFormText(20), reviews: zFormText(20), asOf: zFormText(40) }).partial().optional(),
  hidden: zBool,
});

/** The form sends every field: an empty one clears its value. */
function formPatch(input: z.output<typeof SaveEntryInput>): Patch {
  const cell = (text: string | undefined): Cell => (text === undefined || text.trim() === "" ? CLEAR : { kind: "set", text });
  return {
    size: cell(input.size),
    cartridge: cell(input.cartridge),
    sizeAsOf: cell(input.sizeAsOf),
    price: cell(input.price),
    priceAsOf: cell(input.priceAsOf),
    trailer: cell(input.trailer),
    "description.ar": cell(input.description?.ar),
    "description.en": cell(input.description?.en),
    "description.ckb": cell(input.description?.ckb),
    score: cell(input.metacritic?.score),
    reviews: cell(input.metacritic?.reviews),
    scoreAsOf: cell(input.metacritic?.asOf),
    hidden: { kind: "set", text: input.hidden ? "yes" : "no" },
  };
}

export type SaveEntryResult = { changed: boolean; created: boolean; updatedAt: number | null; fields: ValueKey[] };

export async function saveLibraryEntry(db: Db, actor: Actor, raw: unknown, now: number): Promise<SaveEntryResult> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const input = parseInput(SaveEntryInput, raw);
  const row = await loadRow(db, input.gameId);
  // Opened before a colleague (or another tab) saved: refuse instead of overwriting what they saved.
  if (row ? row.updatedAt !== input.updatedAt : input.updatedAt !== undefined) throw entryChanged(input.gameId);
  const before = valuesOf(row);
  const { values, errors } = resolve(before, formPatch(input), baghdadDay(now), FORM_FIELDS, "form");
  if (Object.keys(errors).length > 0) throw invalid(errors);
  const fields = changedKeys(before, values);
  if (fields.length === 0) return { changed: false, created: false, updatedAt: row?.updatedAt ?? null, fields };
  const by = actorRef(actor).actorId;
  const write = { ...values, updatedAt: now, updatedBy: by };
  const statements: BatchStatement[] = row
    ? [db.update(switchLibraryEntries).set(write).where(sql`${switchLibraryEntries.gameId} = ${input.gameId} AND ${switchLibraryEntries.updatedAt} = ${row.updatedAt}`)]
    : [db.insert(switchLibraryEntries).values({ gameId: input.gameId, ...write, createdAt: now }).onConflictDoNothing()];
  statements.push(
    expectChanged(db, 1, { code: "ENTRY_CHANGED", detail: input.gameId }),
    auditStatement(db, { actor, action: "catalog.switch_library.save", entityType: LIBRARY_ENTITY, entityId: input.gameId, summary: fields.join(", "), before: row ? pick(before, fields) : null, after: pick(values, fields), at: now }),
  );
  await runBatch(db, statements).catch(rethrowLibrary);
  return { changed: true, created: !row, updatedAt: now, fields };
}

// ───────────────────────────────────────────────────────────────── the picture

const GameIdInput = z.object({ gameId: zGameId });

/** Removes a replaced or removed picture's file when no game shows it any more. */
async function releaseFile(db: Db, store: BlobStore, fileId: string, now: number): Promise<void> {
  const other = await db.select({ gameId: switchLibraryEntries.gameId }).from(switchLibraryEntries).where(eq(switchLibraryEntries.imageFileId, fileId)).get();
  if (!other) await deleteFile(db, store, fileId, now).catch(() => {});
}

/**
 * A picture for the game, through the server core's upload pipeline (JPEG, PNG or WebP by content, at most 8 MB,
 * metadata removed) and stored PUBLIC: the builder shows it from /media/<key>. It replaces the game's picture; the
 * same picture again changes nothing. Creates the game's row when it has none.
 */
export async function uploadLibraryImage(db: Db, store: BlobStore, actor: Actor, raw: unknown, file: UploadSource, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const { gameId } = parseInput(GameIdInput, raw);
  const image = await processImageUpload(file);
  const row = await loadRow(db, gameId);
  const previous = row?.imageFileId ?? null;
  if (previous) {
    const current = await db.select({ sha256: files.sha256, deletedAt: files.deletedAt, visibility: files.visibility }).from(files).where(eq(files.id, previous)).get();
    if (current && current.sha256 === image.sha256 && current.deletedAt === null && current.visibility === "public") return { replayed: true };
  }
  const stored = await putFile(db, store, {
    bytes: image.bytes,
    mime: image.mime,
    visibility: "public",
    kind: LIBRARY_IMAGE_KIND,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    ownerType: LIBRARY_ENTITY,
    ownerId: gameId,
    createdBy: actor,
    originalName: image.originalName,
    now,
  });
  const by = actorRef(actor).actorId;
  try {
    await runBatch(db, [
      row
        ? db
            .update(switchLibraryEntries)
            .set({ imageFileId: stored.id, updatedAt: now, updatedBy: by })
            .where(sql`${switchLibraryEntries.gameId} = ${gameId} AND ${switchLibraryEntries.imageFileId} IS ${previous}`)
        : db.insert(switchLibraryEntries).values({ gameId, imageFileId: stored.id, isHidden: false, createdAt: now, updatedAt: now, updatedBy: by }).onConflictDoNothing(),
      expectChanged(db, 1, { code: "ENTRY_CHANGED", detail: gameId }),
      auditStatement(db, {
        actor,
        action: "catalog.switch_library.image_upload",
        entityType: LIBRARY_ENTITY,
        entityId: gameId,
        summary: `${image.width}×${image.height}`,
        before: { imageFileId: previous },
        after: { imageFileId: stored.id, width: image.width, height: image.height, bytes: stored.bytes },
        at: now,
      }),
    ]).catch(rethrowLibrary);
  } catch (error) {
    // No row points at the new file: do not leave its bytes behind.
    await deleteFile(db, store, stored.id, now).catch(() => {});
    throw error;
  }
  if (previous) await releaseFile(db, store, previous, now);
  return { replayed: false };
}

export async function removeLibraryImage(db: Db, store: BlobStore, actor: Actor, raw: unknown, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const { gameId } = parseInput(GameIdInput, raw);
  const row = await loadRow(db, gameId);
  const previous = row?.imageFileId ?? null;
  if (!previous) return { removed: false }; // already gone (a double submit)
  await runBatch(db, [
    db.update(switchLibraryEntries).set({ imageFileId: null, updatedAt: now, updatedBy: actorRef(actor).actorId }).where(sql`${switchLibraryEntries.gameId} = ${gameId} AND ${switchLibraryEntries.imageFileId} = ${previous}`),
    expectChanged(db, 1, { code: "ENTRY_CHANGED", detail: gameId }),
    auditStatement(db, { actor, action: "catalog.switch_library.image_remove", entityType: LIBRARY_ENTITY, entityId: gameId, before: { imageFileId: previous }, after: { imageFileId: null }, at: now }),
  ]).catch(rethrowLibrary);
  await releaseFile(db, store, previous, now);
  return { removed: true };
}

// ───────────────────────────────────────────────────────────────── CSV import

export type LibraryCsvProblem = { field?: string; message: string };
/** One field's change, as staff read it ("16.5 GB", "$59.99", "yes"); null = empty. */
export type LibraryCsvChange = { field: LibraryCsvColumn; from: string | null; to: string | null };
export type LibraryCsvRow = {
  /** The row's line in the file (1 = the header). */
  line: number;
  gameId: string;
  action: "create" | "update" | "error";
  changes: LibraryCsvChange[];
  errors: LibraryCsvProblem[];
};
export type LibraryCsvPlan = {
  /** Ties an apply to this preview: the file, the day and every game row it read. */
  fingerprint: string;
  fileErrors: Array<LibraryCsvProblem & { line?: number }>;
  /** Columns the import does not know (ignored). */
  unknownColumns: string[];
  totals: { rows: number; create: number; update: number; unchanged: number; error: number };
  /** The rows that would change or have errors (unchanged rows are only counted), at most PREVIEW_ROWS_SHOWN. */
  rows: LibraryCsvRow[];
  /** More changing or failing rows than `rows` lists. */
  moreRows: number;
  /** The changes exceed what one import writes (LIBRARY_CSV_MAX_CHANGES): the file must be split. */
  tooManyChanges: boolean;
};

type PlannedWrite = { line: number; gameId: string; seen: SwitchLibraryEntry | null; values: EntryValues; fields: ValueKey[] };

/** The uploaded file as text: CSV only (no binary), within the size limit. */
async function readCsvText(source: unknown): Promise<string> {
  if (source && typeof source === "object" && "arrayBuffer" in source && typeof (source as Blob).arrayBuffer === "function") {
    const blob = source as Blob;
    if (blob.size === 0) throw invalid({ file: "upload_missing" });
    if (blob.size > LIBRARY_CSV_MAX_BYTES) throw new AppError("upload_too_large", 413, { fields: { file: "upload_too_large" } });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // A NUL byte means a binary file (a spreadsheet saved as .xlsx, a picture…).
    if (bytes.includes(0)) throw invalid({ file: "csv_not_text" });
    // Not UTF-8 (Excel's plain "CSV" is saved in the computer's code page, e.g. Windows-1256): refused, never decoded
    // with replacement characters that would then be saved over the Arabic and Sorani texts.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid({ file: "csv_encoding" });
    }
  }
  if (typeof source === "string" && source !== "") {
    if (new TextEncoder().encode(source).length > LIBRARY_CSV_MAX_BYTES) throw new AppError("upload_too_large", 413, { fields: { file: "upload_too_large" } });
    return source;
  }
  throw invalid({ file: "upload_missing" });
}

/** A field's value as staff read it, for the preview. */
function shown(key: ValueKey, values: EntryValues): string | null {
  const value = values[key];
  if (value === null || value === undefined) return null;
  if (key === "sizeBytes" || key === "cartridgeBytes") return sizeLabel(value as number);
  if (key === "priceUsdCents") return usdLabel(value as number);
  if (key === "isHidden") return value ? "yes" : "no";
  return String(value);
}

const short = (text: string | undefined | null) => (text ? (text.length > 120 ? `${text.slice(0, 117)}…` : text) : null);

/** The preview's lines for the changed fields: CSV column names, readable values. */
function changesOf(before: EntryValues, after: EntryValues, fields: readonly ValueKey[]): LibraryCsvChange[] {
  const out: LibraryCsvChange[] = [];
  const column: Partial<Record<ValueKey, LibraryCsvColumn>> = {
    sizeBytes: "size_gb",
    cartridgeBytes: "cartridge_gb",
    sizeAsOf: "size_as_of",
    priceUsdCents: "price_usd",
    priceAsOf: "price_as_of",
    trailerYoutubeId: "trailer",
    metacriticScore: "metacritic_score",
    metacriticReviews: "metacritic_reviews",
    metacriticAsOf: "metacritic_as_of",
    isHidden: "hidden",
  };
  for (const key of fields) {
    if (key === "description") {
      for (const lang of LANGS) {
        const from = before.description?.[lang] ?? null;
        const to = after.description?.[lang] ?? null;
        if (from !== to) out.push({ field: `description_${lang}`, from: short(from), to: short(to) });
      }
      continue;
    }
    out.push({ field: column[key]!, from: shown(key, before), to: shown(key, after) });
  }
  return out;
}

/** A CSV row as a patch: no column or an empty cell leaves the field, "-" clears it. */
function csvPatch(cells: Record<string, string>, header: ReadonlySet<string>): Patch {
  const cell = (column: LibraryCsvColumn): Cell => {
    if (!header.has(column)) return KEEP;
    const value = (cells[column] ?? "").trim();
    if (value === "") return KEEP;
    if (value === LIBRARY_CSV_CLEAR) return CLEAR;
    return { kind: "set", text: value };
  };
  return Object.fromEntries((Object.keys(CSV_FIELDS) as PatchKey[]).map((key) => [key, cell(CSV_FIELDS[key])])) as Patch;
}

/** What the file would do to the library now (the same answer for the preview and for the apply that follows it). */
async function planCsv(db: Db, text: string, now: number): Promise<{ plan: LibraryCsvPlan; writes: PlannedWrite[] }> {
  const today = baghdadDay(now);
  const totals = { rows: 0, create: 0, update: 0, unchanged: 0, error: 0 };
  const empty = async (fileErrors: LibraryCsvPlan["fileErrors"], unknownColumns: string[] = []) => ({
    plan: { fingerprint: await sha256Hex(`${today}\n${text}`), fileErrors, unknownColumns, totals, rows: [], moreRows: 0, tooManyChanges: false },
    writes: [],
  });

  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return empty([{ message: error.code, line: error.line }]);
    throw error;
  }
  const header = new Set(parsed.header);
  const known = new Set<string>([...LIBRARY_CSV_COLUMNS, ...LIBRARY_CSV_READ_ONLY]);
  const unknownColumns = parsed.header.filter((name) => !known.has(name));
  if (!header.has("game_id")) return empty([{ message: "csv_game_id_column" }], unknownColumns);
  if (parsed.rows.length > LIBRARY_CSV_MAX_ROWS) return empty([{ message: "csv_rows_limit" }], unknownColumns);

  // Every game of the file in ONE query: the ids travel as a single JSON parameter.
  const ids = [...new Set(parsed.rows.map((row) => normalizeGameId(row.cells.game_id ?? "")).filter(isLibraryGameId))];
  const existing = ids.length > 0 ? await db.select().from(switchLibraryEntries).where(sql`${switchLibraryEntries.gameId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`) : [];
  const byId = new Map(existing.map((row) => [row.gameId, row]));

  const rows: LibraryCsvRow[] = [];
  const writes: PlannedWrite[] = [];
  const seen = new Set<string>();
  for (const record of parsed.rows) {
    totals.rows++;
    const gameId = normalizeGameId(record.cells.game_id ?? "");
    const idError = gameId === "" ? "required" : !isLibraryGameId(gameId) ? "id_invalid" : seen.has(gameId) ? "id_repeated" : null;
    seen.add(gameId);
    if (idError) {
      totals.error++;
      rows.push({ line: record.line, gameId, action: "error", changes: [], errors: [{ field: "game_id", message: idError }] });
      continue;
    }
    const row = byId.get(gameId) ?? null;
    const before = valuesOf(row);
    const { values, errors } = resolve(before, csvPatch(record.cells, header), today, CSV_FIELDS, "csv");
    if (Object.keys(errors).length > 0) {
      totals.error++;
      rows.push({ line: record.line, gameId, action: "error", changes: [], errors: Object.entries(errors).map(([field, message]) => ({ field, message })) });
      continue;
    }
    const fields = changedKeys(before, values);
    if (fields.length === 0) {
      totals.unchanged++;
      continue;
    }
    const action = row ? "update" : "create";
    totals[action]++;
    rows.push({ line: record.line, gameId, action, changes: changesOf(before, values, fields), errors: [] });
    writes.push({ line: record.line, gameId, seen: row, values, fields });
  }
  // The preview and the apply must have read the same file, on the same day, with the same rows in the database.
  const state = ids.map((id) => [id, byId.get(id)?.updatedAt ?? null]);
  const fingerprint = await sha256Hex(`${today}\n${text}\n${JSON.stringify(state)}`);
  return {
    plan: {
      fingerprint,
      fileErrors: [],
      unknownColumns,
      totals,
      rows: rows.slice(0, PREVIEW_ROWS_SHOWN),
      moreRows: Math.max(0, rows.length - PREVIEW_ROWS_SHOWN),
      tooManyChanges: writes.length > LIBRARY_CSV_MAX_CHANGES,
    },
    writes,
  };
}

/** Reads and checks the file; writes nothing. */
export async function previewLibraryCsv(db: Db, actor: Actor, source: unknown, now: number): Promise<LibraryCsvPlan> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const text = await readCsvText(source);
  return (await planCsv(db, text, now)).plan;
}

/**
 * Batch guard for one import chunk, placed FIRST in its batch: each game's row is still exactly as the preview read it
 * (`seenAt` = its updated_at then), or still absent (`seenAt` null). Otherwise the batch fails with TT:IMPORT_STALE and
 * writes nothing. Exported for tests.
 */
export function libraryChunkGuard(db: Db, chunk: ReadonlyArray<{ gameId: string; seenAt: number | null }>): BatchStatement {
  const expected = JSON.stringify(chunk.map((write) => ({ id: write.gameId, at: write.seenAt })));
  return expectThat(
    db,
    sql`NOT EXISTS (SELECT 1 FROM json_each(${expected}) AS j LEFT JOIN switch_library_entries AS e ON e.game_id = json_extract(j.value, '$.id')
      WHERE CASE WHEN json_extract(j.value, '$.at') IS NULL THEN e.game_id IS NOT NULL
                 ELSE e.game_id IS NULL OR e.updated_at <> json_extract(j.value, '$.at') END)`,
    { code: "IMPORT_STALE" },
  );
}

export const ApplyCsvInput = z.object({
  fingerprint: z.string({ error: "import_stale" }).regex(/^[0-9a-f]{64}$/, "import_stale"),
  fileName: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
});

export type ApplyCsvResult = {
  created: number;
  updated: number;
  unchanged: number;
  /** Rows with errors, left out. */
  skipped: number;
  /** A colleague changed a game while the file was being applied: the chunks before it are saved, the rest is not. */
  interrupted: boolean;
};

/**
 * Applies a previewed file: the same file must give the same fingerprint (else `import_stale`, preview again).
 * Rows with errors are left out; at most LIBRARY_CSV_MAX_CHANGES games per import.
 */
export async function applyLibraryCsv(db: Db, actor: Actor, source: unknown, raw: unknown, now: number): Promise<ApplyCsvResult> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const input = parseInput(ApplyCsvInput, raw);
  const text = await readCsvText(source);
  const { plan, writes } = await planCsv(db, text, now);
  if (plan.fingerprint !== input.fingerprint) throw new AppError("import_stale", 409);
  if (writes.length === 0) throw new AppError("import_nothing", 409);
  if (writes.length > LIBRARY_CSV_MAX_CHANGES) throw new AppError("import_too_many", 409, { detail: String(writes.length) });

  const by = actorRef(actor).actorId;
  const result: ApplyCsvResult = { created: 0, updated: 0, unchanged: plan.totals.unchanged, skipped: plan.totals.error, interrupted: false };
  for (let start = 0; start < writes.length; start += LIBRARY_CSV_CHUNK) {
    const chunk = writes.slice(start, start + LIBRARY_CSV_CHUNK);
    const statements: BatchStatement[] = [libraryChunkGuard(db, chunk.map((write) => ({ gameId: write.gameId, seenAt: write.seen?.updatedAt ?? null })))];
    for (const write of chunk) {
      const values = { ...write.values, updatedAt: now, updatedBy: by };
      statements.push(
        write.seen
          ? db.update(switchLibraryEntries).set(values).where(eq(switchLibraryEntries.gameId, write.gameId))
          : db
              .insert(switchLibraryEntries)
              .values({ gameId: write.gameId, ...values, createdAt: now })
              .onConflictDoUpdate({ target: switchLibraryEntries.gameId, set: values }),
        auditStatement(db, {
          actor,
          action: "catalog.switch_library.import",
          entityType: LIBRARY_ENTITY,
          entityId: write.gameId,
          summary: `${input.fileName ?? "csv"} line ${write.line}: ${write.fields.join(", ")}`,
          before: write.seen ? pick(valuesOf(write.seen), write.fields) : null,
          after: pick(write.values, write.fields),
          at: now,
        }),
      );
    }
    const created = chunk.filter((write) => !write.seen).length;
    const last = start + LIBRARY_CSV_CHUNK >= writes.length;
    if (last) {
      statements.push(
        auditStatement(db, {
          actor,
          action: "catalog.switch_library.import_apply",
          entityType: "switch_library_import",
          entityId: input.fileName ?? null,
          summary: `${writes.length} games: ${result.created + created} new, ${result.updated + chunk.length - created} updated, ${plan.totals.unchanged} unchanged, ${plan.totals.error} rows with errors left out`,
          after: { rows: plan.totals.rows, created: result.created + created, updated: result.updated + chunk.length - created, unchanged: plan.totals.unchanged, skipped: plan.totals.error },
          at: now,
        }),
      );
    }
    try {
      await runBatch(db, statements).catch(rethrowLibrary);
    } catch (error) {
      // A later chunk that meets a colleague's change stops the import; what was saved stays saved (and audited).
      if (start > 0 && error instanceof AppError && error.code === "import_stale") return { ...result, interrupted: true };
      throw error;
    }
    result.created += created;
    result.updated += chunk.length - created;
  }
  return result;
}

// ───────────────────────────────────────────────────────────────── CSV export

/** Every game TamTam has data for, in the import's columns (export → edit → import changes only what was edited). */
export async function exportLibraryCsv(db: Db, actor: Actor, now: number): Promise<{ csv: string; rows: number }> {
  assertCan(actor, SWITCH_LIBRARY_MANAGE);
  const rows = await db
    .select({ entry: switchLibraryEntries, storageKey: files.storageKey, visibility: files.visibility, deletedAt: files.deletedAt })
    .from(switchLibraryEntries)
    .leftJoin(files, eq(files.id, switchLibraryEntries.imageFileId))
    .orderBy(asc(switchLibraryEntries.gameId));
  const records = rows.map(({ entry, ...file }) => ({
    game_id: entry.gameId,
    size_gb: entry.sizeBytes !== null ? formatSizeInput(entry.sizeBytes) : "",
    cartridge_gb: entry.cartridgeBytes !== null ? formatSizeInput(entry.cartridgeBytes) : "",
    size_as_of: entry.sizeAsOf ?? "",
    price_usd: entry.priceUsdCents !== null ? formatUsdInput(entry.priceUsdCents) : "",
    price_as_of: entry.priceAsOf ?? "",
    trailer: entry.trailerYoutubeId ?? "",
    description_ar: entry.description?.ar ?? "",
    description_en: entry.description?.en ?? "",
    description_ckb: entry.description?.ckb ?? "",
    metacritic_score: entry.metacriticScore ?? "",
    metacritic_reviews: entry.metacriticReviews ?? "",
    metacritic_as_of: entry.metacriticAsOf ?? "",
    hidden: entry.isHidden ? "yes" : "no",
    picture: entry.imageFileId && servable(file) ? `/media/${file.storageKey}` : "",
    updated_at: new Date(entry.updatedAt).toISOString(),
  }));
  await runBatch(db, [auditStatement(db, { actor, action: "catalog.switch_library.export", entityType: "switch_library_export", summary: `${records.length} games`, after: { rows: records.length }, at: now })]);
  return { csv: toCsv([...LIBRARY_CSV_COLUMNS, "picture", "updated_at"], records), rows: records.length };
}
