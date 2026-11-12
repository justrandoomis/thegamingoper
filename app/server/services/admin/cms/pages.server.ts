/**
 * Admin 17.01 / 17.04 / 17.06 — the store's own pages: four policies (delivery, payment, privacy, terms; returns and
 * warranty are module 22's — /admin/settings/policies/:slug), the about and contact texts, and landing pages.
 *
 * How the storefront reads them (docs/areas/content.md): a policy is APPROVED when a `pages` row of kind "policy"
 * is published (or scheduled and due), inside its window, not demo, with Arabic blocks — then it replaces the code's
 * draft that is marked as awaiting the owner. About and contact texts work the same way (`getCmsText`). Landing pages
 * are served by `getLandingPage` below once the storefront has a route for them (LANDING_PATH_PREFIX).
 *
 *   listPages(db, actor, locale, now)                        the six policies, about, contact and landing pages
 *   getPageEditor(db, actor, slug, locale, now, storeMode)   what the editor shows (draft, what is live, can)
 *   createLandingPage · startPageDraft · savePageDraft · discardPageDraft          cms.page.manage
 *   publishPage (approve now) · schedulePage · archivePage (withdraw)               cms.page.publish
 *   getLandingPage(db, locale, slug, now)                    ← the storefront's read
 *
 * The unpublished side lives in `pages.draft`: the blocks per language plus the draft's title and SEO description
 * (extra keys of the JSON — the readers only ever read `body`), so nothing a person types reaches the store before
 * it is approved. Text is edited as lines (module 22's policy-text syntax: headings, paragraphs, lists, steps,
 * notes, tables — never HTML). Every write is guarded by the row's `updated_at` (`content_changed`) and audited.
 * Scheduling replaces the text only when it starts, so it is refused while the page is live (`page_live_schedule`):
 * publish the change instead.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { PolicySlug } from "~/routes/storefront/content/content-model";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { LocalizedBlocks, StoredBlock } from "~/server/db/columns";
import type { Db } from "~/server/db/drizzle.server";
import { pages, type Page, type SeoMeta } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { forbidden, invalid, notFound } from "~/server/errors";
import { getPolicyDraftL10n, listPolicies } from "~/server/services/content.server";
import { parseBlocks, type Block } from "~/ui/Blocks";
import { MAX_SCHEDULE_AHEAD_MS } from "../catalog/rules";
import { blocksToText, textToBlocks } from "../settings/policy-text";
import { FIXED_PAGES, LANDING_SLUG_MAX, LANDING_SLUG_RE, PAGE_TEXT, POLICIES_HERE, POLICIES_IN_SETTINGS, RESERVED_PAGE_SLUGS, inWindow, latinDigits, liveStateOf, pageRefOf, parseBaghdadLocal, storePathOfPage, type EditablePageKind, type LiveState } from "./rules";
import { actorIdOf, cmsError, parseInput, parseJsonText, zL10n, zReason } from "./shared.server";

type StoreMode = "demo" | "live";

/** The starting titles of the about and contact texts (the owner edits them in the draft). */
const FIXED_TITLES: Record<"about" | "contact", L10n> = {
  about: { ar: "من نحن", en: "About us", ckb: "دەربارەی ئێمە" },
  contact: { ar: "تواصل معنا", en: "Contact us", ckb: "پەیوەندیمان پێوە بکە" },
};
const LOCALES: readonly Locale[] = ["ar", "en", "ckb"];

/** The unpublished side of a page: its blocks per language and the draft's title and SEO words. */
export type PageDraft = LocalizedBlocks & { title?: L10n; seo?: { description?: L10n | null; noindex?: boolean } };

const blocksOf = (value: unknown): StoredBlock[] => (Array.isArray(value) ? (value as StoredBlock[]) : []);
const draftOf = (row: Pick<Page, "draft"> | null | undefined): PageDraft | null => (row?.draft ? (row.draft as PageDraft) : null);

async function rowOf(db: Db, slug: string): Promise<Page | undefined> {
  return db.select().from(pages).where(eq(pages.slug, slug)).get();
}

function conflictOf(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  if (info?.kind === "unique") throw cmsError("page_slug_taken", 409, { fields: { slug: "page_slug_taken" } });
  throw error;
}

async function guardedUpdate(db: Db, row: Page, set: Partial<typeof pages.$inferInsert>, audit: ReturnType<typeof auditStatement>): Promise<void> {
  await runBatch(db, [db.update(pages).set(set).where(and(eq(pages.id, row.id), eq(pages.updatedAt, row.updatedAt))), expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }), audit]).catch(conflictOf);
}

/** The editor's slug → which page; refuses the two policies module 22 owns for every write. */
function refFor(slug: string, write: boolean) {
  const ref = pageRefOf(slug);
  if (!ref) throw notFound("page");
  if (write && ref.inSettings) throw cmsError("page_in_settings", 409);
  return ref;
}

// ───────────────────────────────────────────────────────────────── list

export type PageListItem = {
  slug: string;
  kind: EditablePageKind;
  title: string;
  /** The stored row's state (null: no row yet — a policy then serves the code's draft). */
  status: Page["status"] | null;
  state: LiveState | null;
  /** On the storefront now as the approved CMS text. */
  live: boolean;
  hasDraft: boolean;
  inSettings: boolean;
  isDemo: boolean;
  updatedAt: number | null;
  publishedAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  storePath: string;
};

export type PageList = { policies: PageListItem[]; fixed: PageListItem[]; landing: PageListItem[]; can: { edit: boolean; publish: boolean } };

function canOpenPages(actor: Actor): void {
  if (!can(actor, "cms.page.manage") && !can(actor, "cms.page.publish")) throw forbidden("cms.page.manage");
}

export async function listPages(db: Db, actor: Actor, locale: Locale, now: number): Promise<PageList> {
  canOpenPages(actor);
  const [rows, summaries] = await Promise.all([db.select().from(pages).orderBy(asc(pages.kind), asc(pages.slug)), listPolicies(db, locale, { now })]);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const itemOf = (kind: EditablePageKind, slug: string, fallbackTitle: string, live: boolean): PageListItem => {
    const row = bySlug.get(slug);
    const draft = draftOf(row);
    return {
      slug,
      kind,
      title: pick(draft?.title ?? row?.title ?? null, locale) || fallbackTitle,
      status: row?.status ?? null,
      state: row ? liveStateOf(row, now) : null,
      live,
      hasDraft: Boolean(row?.draft),
      inSettings: (POLICIES_IN_SETTINGS as readonly string[]).includes(slug),
      isDemo: row?.isDemo ?? false,
      updatedAt: row?.updatedAt ?? null,
      publishedAt: row?.publishedAt ?? null,
      startsAt: row?.startsAt ?? null,
      endsAt: row?.endsAt ?? null,
      storePath: storePathOfPage(kind, slug),
    };
  };
  const servedLive = (row: Page | undefined) => Boolean(row && !row.isDemo && (row.status === "published" || (row.status === "scheduled" && row.startsAt !== null)) && inWindow(row, now) && blocksOf((row.body as LocalizedBlocks | null)?.ar).length > 0);
  const policies = summaries.filter((summary) => [...POLICIES_HERE, ...POLICIES_IN_SETTINGS].includes(summary.slug as never)).map((summary) => itemOf("policy", summary.slug, summary.title, summary.approved));
  const fixed = FIXED_PAGES.map((slug) => itemOf(slug, slug, slug, servedLive(bySlug.get(slug))));
  const landing = rows.filter((row) => row.kind === "landing").map((row) => itemOf("landing", row.slug, row.slug, servedLive(row)));
  return { policies, fixed, landing, can: { edit: can(actor, "cms.page.manage"), publish: can(actor, "cms.page.publish") } };
}

// ───────────────────────────────────────────────────────────────── one page

export type PageEditor = {
  slug: string;
  kind: EditablePageKind;
  inSettings: boolean;
  storePath: string;
  row: { status: Page["status"]; state: LiveState; publishedAt: number | null; updatedAt: number; startsAt: number | null; endsAt: number | null; hasDraft: boolean; isDemo: boolean } | null;
  /** What the editor starts from: the stored draft, else the published text, else nothing yet. */
  source: "draft" | "published" | "none";
  title: L10n;
  text: Record<Locale, string>;
  description: L10n | null;
  noindex: boolean;
  /** What the storefront serves now, in the editor's language (the approved text, or the code's draft for a policy). */
  live: { approved: boolean; title: string; blocks: Block[] };
  /** The row's `updated_at` (null while there is no row): every write posts it back. */
  version: number | null;
  /** A policy can start from the code's draft (today's settings filled in). */
  fromCode: boolean;
  /** A draft can start from the text approved last — published, scheduled or withdrawn (startPageDraft `from: "approved"`). */
  fromApproved: boolean;
  can: { edit: boolean; publish: boolean };
};

/** The text approved last: a published or scheduled body, or a withdrawn one (an archived row keeps its body). */
function approvedBody(row: Page | undefined): LocalizedBlocks | null {
  if (!row || (row.status !== "published" && row.status !== "scheduled" && row.status !== "archived")) return null;
  const body = row.body as LocalizedBlocks | null;
  return blocksOf(body?.ar).length > 0 ? body : null;
}

export async function getPageEditor(db: Db, actor: Actor, slug: string, locale: Locale, now: number, storeMode: StoreMode): Promise<PageEditor> {
  canOpenPages(actor);
  const ref = refFor(slug, false);
  const row = await rowOf(db, slug);
  if (row && row.kind !== ref.kind && !(ref.kind === "landing" && row.kind === "custom")) throw notFound("page");
  if (!row && ref.kind === "landing") throw notFound("page");
  const draft = draftOf(row);
  const published = row?.status === "published" || row?.status === "scheduled" ? (row.body as LocalizedBlocks | null) : null;
  const stored = draft ?? published;
  const text = { ar: "", en: "", ckb: "" } as Record<Locale, string>;
  for (const code of LOCALES) text[code] = stored ? blocksToText(blocksOf(stored[code as keyof LocalizedBlocks])) : "";
  const seo = (row?.seo ?? null) as SeoMeta | null;
  const codeDraft = ref.kind === "policy" ? await getPolicyDraftL10n(db, slug as PolicySlug, { storeMode }) : null;
  const liveRow = row && !row.isDemo && (row.status === "published" || (row.status === "scheduled" && row.startsAt !== null)) && inWindow(row, now) && blocksOf((row.body as LocalizedBlocks | null)?.ar).length > 0;
  const liveBody = liveRow ? (row.body as LocalizedBlocks) : null;
  const live = liveBody
    ? { approved: true, title: pick(row!.title, locale), blocks: parseBlocks(blocksOf(liveBody[locale as keyof LocalizedBlocks]).length ? liveBody[locale as keyof LocalizedBlocks] : liveBody.ar) }
    : codeDraft
      ? { approved: false, title: pick(codeDraft.title, locale), blocks: parseBlocks(codeDraft.body[locale]) }
      : { approved: false, title: "", blocks: [] };
  return {
    slug,
    kind: ref.kind,
    inSettings: ref.inSettings,
    storePath: storePathOfPage(ref.kind, slug),
    row: row
      ? { status: row.status, state: liveStateOf(row, now), publishedAt: row.publishedAt, updatedAt: row.updatedAt, startsAt: row.startsAt, endsAt: row.endsAt, hasDraft: Boolean(row.draft), isDemo: row.isDemo }
      : null,
    source: draft ? "draft" : published ? "published" : "none",
    title: draft?.title ?? row?.title ?? codeDraft?.title ?? (ref.kind === "about" || ref.kind === "contact" ? FIXED_TITLES[ref.kind] : { ar: "" }),
    text,
    description: draft?.seo?.description ?? seo?.description ?? null,
    noindex: draft?.seo?.noindex ?? seo?.noindex ?? false,
    live,
    version: row?.updatedAt ?? null,
    fromCode: ref.kind === "policy",
    fromApproved: approvedBody(row) !== null,
    can: { edit: can(actor, "cms.page.manage") && !ref.inSettings, publish: can(actor, "cms.page.publish") && !ref.inSettings },
  };
}

const zVersion = z.preprocess((value) => (value === "" || value === null || value === undefined ? null : Number(value)), z.number().int().nullable());

// ───────────────────────────────────────────────────────────────── create a landing page

const CreateInput = z.object({
  // Arabic-Indic and Persian digits typed on an Arabic keyboard become 0–9 ("ramadan-٢٠٢٧" → "ramadan-2027")
  slug: z.preprocess((value) => (typeof value === "string" ? latinDigits(value) : value), z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(LANDING_SLUG_MAX, "too_long")),
  titleAr: z.string({ error: "required" }).trim().min(1, "required").max(PAGE_TEXT.title, "too_long"),
});

/** A new landing page: a draft row with its title and an empty body (nothing on the store until it is approved). */
export async function createLandingPage(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ slug: string }> {
  assertCan(actor, "cms.page.manage");
  const input = parseInput(CreateInput, raw);
  if (!LANDING_SLUG_RE.test(input.slug)) throw invalid({ slug: "invalid" });
  if (RESERVED_PAGE_SLUGS.has(input.slug)) throw cmsError("page_slug_reserved", 409, { fields: { slug: "page_slug_reserved" } });
  const title: L10n = { ar: input.titleAr };
  const draft: PageDraft = { ar: [], title };
  const id = newId("pag");
  await runBatch(db, [
    db.insert(pages).values({ id, slug: input.slug, kind: "landing", title, draft, status: "draft", isDemo: options.demo ?? false, updatedBy: actorIdOf(actor), createdAt: now, updatedAt: now }),
    auditStatement(db, { actor, action: "cms.page.create", entityType: "page", entityId: input.slug, after: { kind: "landing", title: input.titleAr, demo: options.demo ?? false }, at: now }),
  ]).catch(conflictOf);
  return { slug: input.slug };
}

// ───────────────────────────────────────────────────────────────── drafts

const StartInput = z.object({ slug: z.string(), version: zVersion, reason: zReason(true), from: z.enum(["code", "approved"], { error: "invalid" }).optional() });

/**
 * Starts (or restarts) the draft. A policy starts from the code's current draft (today's settings filled in,
 * ar/en/ckb — once saved, its numbers no longer follow the settings, so the owner reviews them), or with
 * `from: "approved"` from its approved text, so a small change to an approved policy never means redoing every edit
 * (review 2026-11-12: the editor promised that start, the service had none); about, contact and landing pages always
 * start from their approved text — published, scheduled, or the one last withdrawn — or empty.
 */
export async function startPageDraft(db: Db, actor: Actor, raw: unknown, now: number, storeMode: StoreMode): Promise<{ created: boolean }> {
  assertCan(actor, "cms.page.manage");
  const input = parseInput(StartInput, raw);
  const ref = refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if ((row?.updatedAt ?? null) !== input.version) throw cmsError("content_changed", 409);
  if (row && row.kind !== ref.kind && !(ref.kind === "landing" && row.kind === "custom")) throw notFound("page");
  let draft: PageDraft;
  let title: L10n;
  const fromCode = ref.kind === "policy" && input.from !== "approved";
  if (fromCode) {
    const code = await getPolicyDraftL10n(db, input.slug as PolicySlug, { storeMode });
    title = code.title;
    draft = { ar: code.body.ar as StoredBlock[], en: code.body.en as StoredBlock[], ckb: code.body.ckb as StoredBlock[], title };
  } else {
    if (!row && ref.kind === "landing") throw notFound("page");
    // the text last approved — also after it was withdrawn (archived keeps its body): restarting never loses it
    const body = approvedBody(row);
    if (!body && ref.kind === "policy") throw cmsError("page_not_live", 409);
    title = row?.title ?? (ref.kind === "about" || ref.kind === "contact" ? FIXED_TITLES[ref.kind] : { ar: ref.slug });
    draft = { ar: blocksOf(body?.ar), ...(body?.en ? { en: blocksOf(body.en) } : {}), ...(body?.ckb ? { ckb: blocksOf(body.ckb) } : {}), title };
  }
  const audit = auditStatement(db, { actor, action: "cms.page.start", entityType: "page", entityId: input.slug, after: { blocks: draft.ar.length, from: fromCode ? "code_draft" : row?.status === "archived" ? "withdrawn" : "approved" }, reason: input.reason, at: now });
  if (!row) {
    await runBatch(db, [
      db.insert(pages).values({ id: newId("pag"), slug: input.slug, kind: ref.kind, title, draft, status: "draft", isDemo: false, updatedBy: actorIdOf(actor), createdAt: now, updatedAt: now }),
      audit,
    ]).catch((error) => {
      if (mapDbError(error)?.kind === "unique") throw cmsError("content_changed", 409);
      throw error;
    });
    return { created: true };
  }
  await guardedUpdate(db, row, { draft, updatedBy: actorIdOf(actor), updatedAt: now }, audit);
  return { created: false };
}

const zLine = (max: number) => z.string().max(max, "too_long").optional().default("");

const SaveInput = z.object({
  slug: z.string(),
  version: z.coerce.number().int(),
  title: zL10n(PAGE_TEXT.title, true),
  description: zL10n(PAGE_TEXT.description, false),
  noindex: z.preprocess((value) => value === true || value === "on" || value === "true" || value === "1", z.boolean()),
  textAr: zLine(PAGE_TEXT.body),
  textEn: zLine(PAGE_TEXT.body),
  textCkb: zLine(PAGE_TEXT.body),
});

/** Saves the edited title, text and SEO words as the draft — the store keeps what is approved until the next approval. */
export async function savePageDraft(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ blocks: number }> {
  assertCan(actor, "cms.page.manage");
  const input = parseInput(SaveInput, raw);
  refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if (!row) throw cmsError("page_no_draft", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (!input.title) throw invalid({ "title.ar": "required" });
  const ar = textToBlocks(input.textAr);
  if (ar.length === 0) throw invalid({ textAr: "page_empty" });
  const en = textToBlocks(input.textEn);
  const ckb = textToBlocks(input.textCkb);
  const draft: PageDraft = {
    ar: ar as StoredBlock[],
    ...(en.length ? { en: en as StoredBlock[] } : {}),
    ...(ckb.length ? { ckb: ckb as StoredBlock[] } : {}),
    title: input.title,
    seo: { description: input.description, noindex: input.noindex },
  };
  const before = draftOf(row);
  await guardedUpdate(
    db,
    row,
    { draft, updatedBy: actorIdOf(actor), updatedAt: now },
    auditStatement(db, {
      actor,
      action: "cms.page.save",
      entityType: "page",
      entityId: input.slug,
      before: { blocks: before?.ar?.length ?? 0, title: before?.title?.ar ?? row.title.ar },
      after: { blocks: ar.length, en: en.length, ckb: ckb.length, title: input.title.ar, noindex: input.noindex },
      at: now,
    }),
  );
  return { blocks: ar.length };
}

const ReasonInput = z.object({ slug: z.string(), version: z.coerce.number().int(), reason: zReason(true) });

/** Throws the draft away: the editor starts again from what is approved (or the code's draft). */
export async function discardPageDraft(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ discarded: true }> {
  assertCan(actor, "cms.page.manage");
  const input = parseInput(ReasonInput, raw);
  refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if (!row?.draft) throw cmsError("page_no_draft", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  await guardedUpdate(db, row, { draft: null, updatedBy: actorIdOf(actor), updatedAt: now }, auditStatement(db, { actor, action: "cms.page.discard", entityType: "page", entityId: input.slug, before: { blocks: draftOf(row)?.ar?.length ?? 0 }, reason: input.reason, at: now }));
  return { discarded: true };
}

// ───────────────────────────────────────────────────────────────── approve, schedule, withdraw

/** What the draft publishes: its blocks as the body, its title, its SEO words over the row's other SEO fields. */
function publishedFrom(row: Page): { body: LocalizedBlocks; title: L10n; seo: SeoMeta | null } {
  const draft = draftOf(row);
  if (!draft) throw cmsError("page_no_draft", 409);
  const ar = blocksOf(draft.ar);
  if (ar.length === 0) throw cmsError("page_empty", 409);
  const title = draft.title ?? row.title;
  if (!title?.ar?.trim()) throw invalid({ "title.ar": "required" });
  const body: LocalizedBlocks = { ar, ...(draft.en?.length ? { en: blocksOf(draft.en) } : {}), ...(draft.ckb?.length ? { ckb: blocksOf(draft.ckb) } : {}) };
  const previous = (row.seo ?? {}) as SeoMeta;
  const seo: SeoMeta = { ...previous };
  if (draft.seo) {
    if (draft.seo.description) seo.description = draft.seo.description;
    else delete seo.description;
    if (draft.seo.noindex) seo.noindex = true;
    else delete seo.noindex;
  }
  return { body, title, seo: Object.keys(seo).length > 0 ? seo : null };
}

const zLocal = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().optional());
const PublishInput = z.object({ slug: z.string(), version: z.coerce.number().int(), reason: zReason(true), endsAt: zLocal });

/**
 * Approves the draft: it becomes the text the storefront serves (a policy: `source: "cms"`, approved; the «awaiting
 * the owner» draft is no longer shown). A landing page may get an end (a campaign). Not demo from here on — except a
 * demo landing page, which stays demo and is never served.
 */
export async function publishPage(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ published: true }> {
  assertCan(actor, "cms.page.publish");
  const input = parseInput(PublishInput, raw);
  const ref = refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if (!row) throw cmsError("page_no_draft", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  const next = publishedFrom(row);
  const endsAt = input.endsAt === undefined ? null : parseBaghdadLocal(input.endsAt);
  if (input.endsAt !== undefined && endsAt === null) throw invalid({ endsAt: "invalid" });
  if (endsAt !== null && ref.kind !== "landing") throw invalid({ endsAt: "invalid" });
  if (endsAt !== null && endsAt <= now) throw invalid({ endsAt: "schedule_past" });
  await guardedUpdate(
    db,
    row,
    { ...next, draft: null, status: "published", publishedAt: now, startsAt: null, endsAt, isDemo: ref.kind === "landing" ? row.isDemo : false, updatedBy: actorIdOf(actor), updatedAt: now },
    auditStatement(db, {
      actor,
      action: "cms.page.publish",
      entityType: "page",
      entityId: input.slug,
      before: { status: row.status, blocks: blocksOf((row.body as LocalizedBlocks | null)?.ar).length, title: row.title.ar },
      after: { status: "published", blocks: next.body.ar.length, title: next.title.ar, endsAt },
      reason: input.reason,
      at: now,
    }),
  );
  return { published: true };
}

const ScheduleInput = z.object({ slug: z.string(), version: z.coerce.number().int(), reason: zReason(true), startsAt: z.string({ error: "required" }), endsAt: zLocal });

/** Approves the draft to go live at `startsAt` (Iraq time), optionally until `endsAt`. Only for a page that is not live. */
export async function schedulePage(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ scheduled: true; startsAt: number }> {
  assertCan(actor, "cms.page.publish");
  const input = parseInput(ScheduleInput, raw);
  const ref = refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if (!row) throw cmsError("page_no_draft", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (liveStateOf(row, now) === "live") throw cmsError("page_live_schedule", 409);
  const startsAt = parseBaghdadLocal(input.startsAt);
  if (startsAt === null) throw invalid({ startsAt: "invalid" });
  if (startsAt <= now) throw invalid({ startsAt: "schedule_past" });
  if (startsAt > now + MAX_SCHEDULE_AHEAD_MS) throw invalid({ startsAt: "schedule_far" });
  const endsAt = input.endsAt === undefined ? null : parseBaghdadLocal(input.endsAt);
  if (input.endsAt !== undefined && endsAt === null) throw invalid({ endsAt: "invalid" });
  // only a landing page (a campaign) ends on its own — a policy or the about/contact text never lapses silently back to
  // the code's draft (approving refuses an end too; review 2026-11-12)
  if (endsAt !== null && ref.kind !== "landing") throw invalid({ endsAt: "invalid" });
  if (endsAt !== null && endsAt <= startsAt) throw invalid({ endsAt: "schedule_order" });
  const next = publishedFrom(row);
  await guardedUpdate(
    db,
    row,
    { ...next, draft: null, status: "scheduled", publishedAt: startsAt, startsAt, endsAt, isDemo: ref.kind === "landing" ? row.isDemo : false, updatedBy: actorIdOf(actor), updatedAt: now },
    auditStatement(db, { actor, action: "cms.page.schedule", entityType: "page", entityId: input.slug, before: { status: row.status }, after: { status: "scheduled", startsAt, endsAt, blocks: next.body.ar.length }, reason: input.reason, at: now }),
  );
  return { scheduled: true, startsAt };
}

/** Withdraws the page: a policy falls back to the code's draft (marked as awaiting the owner); a landing page is gone. */
export async function archivePage(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ archived: true }> {
  assertCan(actor, "cms.page.publish");
  const input = parseInput(ReasonInput, raw);
  refFor(input.slug, true);
  const row = await rowOf(db, input.slug);
  if (!row || (row.status !== "published" && row.status !== "scheduled")) throw cmsError("page_not_live", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  await guardedUpdate(
    db,
    row,
    { status: "archived", updatedBy: actorIdOf(actor), updatedAt: now },
    auditStatement(db, { actor, action: "cms.page.archive", entityType: "page", entityId: input.slug, before: { status: row.status }, after: { status: "archived" }, reason: input.reason, at: now }),
  );
  return { archived: true };
}

// ───────────────────────────────────────────────────────────────── the storefront's read

export type LandingPageView = { slug: string; title: string; description: string | null; blocks: Block[]; textLocale: Locale; noindex: boolean; updatedAt: number; endsAt: number | null };

/**
 * A landing page as the storefront serves it: published (or scheduled and due), inside its window, not demo, with
 * Arabic blocks; the visitor's language when the page has it, else Arabic (`textLocale`). Null otherwise → 404.
 */
export async function getLandingPage(db: Db, locale: Locale, slug: string, now: number): Promise<LandingPageView | null> {
  if (typeof slug !== "string" || slug.length > LANDING_SLUG_MAX || !LANDING_SLUG_RE.test(slug)) return null;
  const rows = await db.all<{ slug: string; title: string; body: string | null; seo: string | null; status: string; starts_at: number | null; ends_at: number | null; published_at: number | null; updated_at: number }>(
    sql`SELECT slug, title, body, seo, status, starts_at, ends_at, published_at, updated_at FROM pages WHERE kind IN ('landing', 'custom') AND slug = ${slug} AND is_demo = 0 AND status IN ('published', 'scheduled') LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const due = row.status === "published" || (row.starts_at !== null && row.starts_at <= now);
  if (!due || !inWindow({ startsAt: row.starts_at, endsAt: row.ends_at }, now)) return null;
  const body = parseJsonText<Partial<Record<Locale, unknown>>>(row.body);
  const source = parseBlocks(body?.ar);
  if (source.length === 0) return null;
  const own = locale === "ar" ? source : parseBlocks(body?.[locale]);
  const textLocale: Locale = own.length > 0 ? locale : "ar";
  const title = parseJsonText<L10n>(row.title);
  const seo = parseJsonText<SeoMeta>(row.seo);
  const titleText = title ? pick(title, textLocale).trim() : "";
  if (!titleText) return null;
  return {
    slug: row.slug,
    title: titleText,
    description: seo?.description ? pick(seo.description, locale) || null : null,
    blocks: own.length > 0 ? own : source,
    textLocale,
    noindex: seo?.noindex === true,
    updatedAt: row.published_at ?? row.updated_at,
    endsAt: row.ends_at,
  };
}
