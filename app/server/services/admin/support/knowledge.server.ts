/**
 * The knowledge base (14.06): internal articles for staff and the help centre's public guides, written by staff and
 * PUBLISHED THROUGH REVIEW — the storefront (services/support/kb.server.ts) only ever reads `approved` + `public`.
 *
 *   const list = await listArticles(db, actor, { view: "review", q: "" }, locale);
 *   const editor = await getArticleEditor(db, actor, articleId, locale);
 *   await saveArticle(db, actor, { slug, kind, audience, titleAr, bodyAr, …, expectedUpdatedAt }, now);
 *   await submitArticle(db, actor, { articleId, expectedUpdatedAt }, now);                 // draft → review
 *   await decideArticle(db, actor, { articleId, decision: "approve", expectedUpdatedAt }, now);
 *
 * WORKFLOW: draft → review → approved (→ archived → draft). A draft or an article in review is edited in place. An
 * APPROVED article is never changed by an edit: the edit becomes a pending revision (an `approvals` row, kind
 * "knowledge_article", the whole new content as its payload) and the help centre keeps showing the approved text until
 * a reviewer approves the revision — then it replaces the article in one batch, guarded on the version it was written
 * against. TWO PEOPLE: whoever wrote or edited a version (since its last approval) cannot approve it
 * (approver_is_editor); the editors are read from the audit trail (articles) or the revision's payload.
 * Bodies are block arrays in each language (article-text.ts: lines in, blocks out; photos are catalogue keys, checked);
 * the slug is fixed once an article was approved or a troubleshooting tree points at it (the storefront's links and
 * the trees keep the original reference). Every change is audited (support.knowledge.*).
 *
 * Who: reading approved articles — support.ticket.read too (internal ones are the agents' knowledge base); drafts,
 * review and archive — support.knowledge.manage or support.knowledge.approve; writing — support.knowledge.manage;
 * approving and rejecting — support.knowledge.approve.
 * Errors: forbidden (403), not_found (404), invalid (400: slug_taken, slug_locked, photo_unknown…), article_changed ·
 * approver_is_editor · revision_pending · no_revision · article_not_editable (409).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  ARTICLE_AUDIENCES,
  ARTICLE_KINDS,
  approvals,
  auditEvents,
  deviceModels,
  knowledgeArticles,
  platforms,
  troubleshootingTrees,
  type KnowledgeArticle,
  type LocalizedBlocks,
} from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { articleBlocksToText, photoKeysOf, textToArticleBlocks, type ArticleBlock } from "./article-text";
import { employeeNames, isId } from "./shared.server";
import { ARTICLE_LIMITS, ARTICLE_SLUG, type ArticleAudience, type ArticleKind, type ContentStatus, type KnowledgeFilters, type KnowledgeView, type PersonRef } from "./types";

const REVISION_KIND = "knowledge_article";
const EDIT_ACTIONS = ["support.knowledge.create", "support.knowledge.save"];
const APPROVE_ACTIONS = ["support.knowledge.approve", "support.knowledge.revision_approve"];

function readsAll(actor: Actor): boolean {
  return canAny(actor, ["support.knowledge.manage", "support.knowledge.approve"]);
}
function readable(actor: Actor): void {
  if (!canAny(actor, ["support.ticket.read", "support.knowledge.manage", "support.knowledge.approve"])) throw forbidden("support.knowledge.manage");
}

// ───────────────────────────────────────────────────────────────── list

export type ArticleRow = {
  id: string;
  slug: string;
  kind: ArticleKind;
  audience: ArticleAudience;
  status: ContentStatus;
  title: string;
  device: string | null;
  platform: string | null;
  updatedAt: number;
  approvedAt: number | null;
  revisionPending: boolean;
  isDemo: boolean;
};

export async function listArticles(db: Db, actor: Actor, filters: KnowledgeFilters, locale: Locale): Promise<{ rows: ArticleRow[]; counts: Record<KnowledgeView, number>; canEdit: boolean; canApprove: boolean; full: boolean }> {
  readable(actor);
  const full = readsAll(actor);
  const [rows, revisions] = await Promise.all([
    db
      .select({
        id: knowledgeArticles.id,
        slug: knowledgeArticles.slug,
        kind: knowledgeArticles.kind,
        audience: knowledgeArticles.audience,
        status: knowledgeArticles.status,
        title: knowledgeArticles.title,
        updatedAt: knowledgeArticles.updatedAt,
        approvedAt: knowledgeArticles.approvedAt,
        isDemo: knowledgeArticles.isDemo,
        sort: knowledgeArticles.sort,
        device: deviceModels.name,
        platform: platforms.name,
      })
      .from(knowledgeArticles)
      .leftJoin(deviceModels, eq(deviceModels.id, knowledgeArticles.deviceModelId))
      .leftJoin(platforms, eq(platforms.id, knowledgeArticles.platformId))
      .where(full ? undefined : eq(knowledgeArticles.status, "approved"))
      .orderBy(asc(knowledgeArticles.sort), asc(knowledgeArticles.slug)),
    db.select({ id: approvals.entityId }).from(approvals).where(and(eq(approvals.kind, REVISION_KIND), eq(approvals.status, "pending"))),
  ]);
  const pending = new Set(revisions.map((row) => row.id));
  const all: ArticleRow[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    audience: row.audience,
    status: row.status,
    title: pick(row.title, locale),
    device: row.device ? pick(row.device, locale) : null,
    platform: row.platform ? pick(row.platform, locale) : null,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt ?? null,
    revisionPending: pending.has(row.id),
    isDemo: row.isDemo,
  }));
  const inView = (row: ArticleRow, view: KnowledgeView) =>
    view === "all"
      ? row.status !== "archived"
      : view === "public"
        ? row.status === "approved" && row.audience === "public"
        : view === "internal"
          ? row.status === "approved" && row.audience === "internal"
          : view === "review"
            ? row.status === "review" || row.revisionPending
            : row.status === view;
  const text = filters.q.toLowerCase();
  const matches = (row: ArticleRow) => !text || row.title.toLowerCase().includes(text) || row.slug.includes(text) || (row.device ?? "").toLowerCase().includes(text);
  const counts = { all: 0, public: 0, internal: 0, review: 0, draft: 0, archived: 0 } as Record<KnowledgeView, number>;
  for (const row of all) for (const view of Object.keys(counts) as KnowledgeView[]) if (inView(row, view)) counts[view]++;
  return { rows: all.filter((row) => inView(row, filters.view) && matches(row)), counts, canEdit: can(actor, "support.knowledge.manage"), canApprove: can(actor, "support.knowledge.approve"), full };
}

// ───────────────────────────────────────────────────────────────── one article

type Content = {
  slug: string;
  kind: ArticleKind;
  audience: ArticleAudience;
  title: L10n;
  summary: L10n | null;
  body: LocalizedBlocks;
  deviceModelId: string | null;
  platformId: string | null;
  tags: string[];
  sort: number;
};

export type ArticleEditor = {
  id: string;
  status: ContentStatus;
  isDemo: boolean;
  slugLocked: boolean;
  updatedAt: number;
  approvedAt: number | null;
  approvedBy: string | null;
  createdBy: string | null;
  /** The approved (or current) content, as the editor's lines. */
  form: ArticleForm;
  /** The content as stored (blocks per language), for the preview. */
  body: LocalizedBlocks;
  title: L10n;
  summary: L10n | null;
  /** People who wrote this version since its last approval (they cannot approve it). */
  editors: PersonRef[];
  /** `savedAt`: the revision's version as this page shows it — sent back with an edit or a decision (a revision changed meanwhile is refused). */
  revision: { id: string; savedAt: number; by: string | null; at: number; form: ArticleForm; body: LocalizedBlocks; title: L10n; editors: PersonRef[] } | null;
  history: { id: string; at: number; action: string; actor: string | null; reason: string | null }[];
  can: { edit: boolean; submit: boolean; approve: boolean; archive: boolean; restore: boolean; decideRevision: boolean; withdrawRevision: boolean };
  /** Why this employee may not approve (shown beside the key). */
  approveBlocked: "editor" | null;
};

export type ArticleForm = {
  slug: string;
  kind: ArticleKind;
  audience: ArticleAudience;
  titleAr: string;
  titleEn: string;
  titleCkb: string;
  summaryAr: string;
  summaryEn: string;
  summaryCkb: string;
  bodyAr: string;
  bodyEn: string;
  bodyCkb: string;
  deviceModelId: string;
  platformId: string;
  tags: string;
  sort: number;
};

function formOf(content: Content): ArticleForm {
  return {
    slug: content.slug,
    kind: content.kind,
    audience: content.audience,
    titleAr: content.title.ar ?? "",
    titleEn: content.title.en ?? "",
    titleCkb: content.title.ckb ?? "",
    summaryAr: content.summary?.ar ?? "",
    summaryEn: content.summary?.en ?? "",
    summaryCkb: content.summary?.ckb ?? "",
    bodyAr: articleBlocksToText(content.body.ar ?? []),
    bodyEn: articleBlocksToText(content.body.en ?? []),
    bodyCkb: articleBlocksToText(content.body.ckb ?? []),
    deviceModelId: content.deviceModelId ?? "",
    platformId: content.platformId ?? "",
    tags: content.tags.join(", "),
    sort: content.sort,
  };
}

const contentOf = (row: KnowledgeArticle): Content => ({
  slug: row.slug,
  kind: row.kind,
  audience: row.audience,
  title: row.title,
  summary: row.summary ?? null,
  body: row.body ?? { ar: [] },
  deviceModelId: row.deviceModelId ?? null,
  platformId: row.platformId ?? null,
  tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
  sort: row.sort,
});

async function articleById(db: Db, id: unknown): Promise<KnowledgeArticle> {
  const row = isId(id) ? await db.select().from(knowledgeArticles).where(eq(knowledgeArticles.id, id)).get() : undefined;
  if (!row) throw notFound("article");
  return row;
}

async function pendingRevision(db: Db, articleId: string) {
  return (
    (await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.kind, REVISION_KIND), eq(approvals.entityType, "knowledge_article"), eq(approvals.entityId, articleId), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt))
      .get()) ?? null
  );
}

/** Employees who saved this article since it was last approved (the people who may not approve this version). */
async function editorsSinceApproval(db: Db, articleId: string): Promise<string[]> {
  const events = await db
    .select({ action: auditEvents.action, actorId: auditEvents.actorId, actorKind: auditEvents.actorKind })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "knowledge_article"), eq(auditEvents.entityId, articleId), inArray(auditEvents.action, [...EDIT_ACTIONS, ...APPROVE_ACTIONS])))
    .orderBy(asc(auditEvents.seq));
  let editors: string[] = [];
  for (const event of events) {
    if (APPROVE_ACTIONS.includes(event.action)) editors = [];
    else if (event.actorKind === "employee" && event.actorId && !editors.includes(event.actorId)) editors.push(event.actorId);
  }
  return editors;
}

async function slugReferenced(db: Db, slug: string): Promise<boolean> {
  const row = await db
    .select({ id: troubleshootingTrees.id })
    .from(troubleshootingTrees)
    .where(sql`instr(${troubleshootingTrees.tree}, ${`"articleSlug":"${slug}"`}) > 0`)
    .get();
  return row !== undefined;
}

/** A pending revision's payload; `savedAt` is when its content was last saved (its version). */
type RevisionPayload = { content: Content; basedOn: number; editors: string[]; savedAt?: number };

/** The revision with its version: `savedAt`, or the approvals row's creation for a payload written before it existed. */
const revisionOf = (row: { payload: unknown; createdAt: number } | null): (RevisionPayload & { savedAt: number }) | null => {
  const payload = row?.payload as RevisionPayload | undefined;
  if (!row || !payload || !payload.content || typeof payload.basedOn !== "number") return null;
  return { content: payload.content, basedOn: payload.basedOn, editors: Array.isArray(payload.editors) ? payload.editors : [], savedAt: typeof payload.savedAt === "number" ? payload.savedAt : row.createdAt };
};

/** SQL: "the pending revision is still the version that was read" (for the writes that replace or decide it). */
const sameRevision = (savedAt: number) => sql`COALESCE(json_extract(${approvals.payload}, '$.savedAt'), ${approvals.createdAt}) = ${savedAt}`;

export async function getArticleEditor(db: Db, actor: Actor, id: string): Promise<ArticleEditor> {
  readable(actor);
  const row = await articleById(db, id);
  if (row.status !== "approved" && !readsAll(actor)) throw notFound("article");
  const [revisionRow, editors, history, referenced] = await Promise.all([
    readsAll(actor) ? pendingRevision(db, row.id) : Promise.resolve(null),
    editorsSinceApproval(db, row.id),
    readsAll(actor)
      ? db
          .select({ id: auditEvents.id, at: auditEvents.at, action: auditEvents.action, actorId: auditEvents.actorId, actorKind: auditEvents.actorKind, actorLabel: auditEvents.actorLabel, reason: auditEvents.reason })
          .from(auditEvents)
          .where(and(eq(auditEvents.entityType, "knowledge_article"), eq(auditEvents.entityId, row.id)))
          .orderBy(desc(auditEvents.seq))
          .limit(40)
      : Promise.resolve([]),
    slugReferenced(db, row.slug),
  ]);
  const revision = revisionOf(revisionRow);
  const names = await employeeNames(db, [row.approvedBy, row.createdBy, revisionRow?.requestedBy, ...editors, ...(revision?.editors ?? []), ...history.map((event) => event.actorId)]);
  const me = actor.kind === "employee" ? actor.id : "";
  const manage = can(actor, "support.knowledge.manage");
  const approve = can(actor, "support.knowledge.approve");
  const isEditor = editors.includes(me);
  const isRevisionEditor = revision ? revision.editors.includes(me) : false;
  return {
    id: row.id,
    status: row.status,
    isDemo: row.isDemo,
    slugLocked: row.approvedAt !== null || referenced,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt ?? null,
    approvedBy: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
    createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    form: formOf(contentOf(row)),
    body: row.body ?? { ar: [] },
    title: row.title,
    summary: row.summary ?? null,
    editors: editors.map((editorId) => ({ id: editorId, name: names.get(editorId) ?? editorId })),
    revision:
      revisionRow && revision
        ? {
            id: revisionRow.id,
            savedAt: revision.savedAt,
            by: names.get(revisionRow.requestedBy) ?? null,
            at: revisionRow.createdAt,
            form: formOf(revision.content),
            body: revision.content.body,
            title: revision.content.title,
            editors: revision.editors.map((editorId) => ({ id: editorId, name: names.get(editorId) ?? editorId })),
          }
        : null,
    history: history.map((event) => ({ id: event.id, at: event.at, action: event.action.replace(/^support\.knowledge\./, ""), actor: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? event.actorLabel ?? null) : null, reason: event.reason })),
    can: {
      edit: manage && row.status !== "archived",
      submit: manage && row.status === "draft",
      approve: approve && row.status === "review" && !isEditor,
      archive: manage && row.status !== "archived",
      restore: manage && row.status === "archived",
      decideRevision: approve && revision !== null && !isRevisionEditor,
      withdrawRevision: revision !== null && (manage || revisionRow?.requestedBy === me),
    },
    approveBlocked: approve && ((row.status === "review" && isEditor) || (revision !== null && isRevisionEditor)) ? "editor" : null,
  };
}

/** Choices for the editor: published device models and active platforms. */
export async function knowledgeOptions(db: Db, locale: Locale): Promise<{ devices: { id: string; name: string; platformId: string }[]; platforms: { id: string; name: string }[] }> {
  const [devices, platformRows] = await Promise.all([
    db.select({ id: deviceModels.id, name: deviceModels.name, platformId: deviceModels.platformId, status: deviceModels.status }).from(deviceModels).orderBy(asc(deviceModels.sort), asc(deviceModels.slug)),
    db.select({ id: platforms.id, name: platforms.name, isActive: platforms.isActive }).from(platforms).orderBy(asc(platforms.sort)),
  ]);
  return {
    devices: devices.filter((row) => row.status === "published").map((row) => ({ id: row.id, name: pick(row.name, locale), platformId: row.platformId })),
    platforms: platformRows.filter((row) => row.isActive).map((row) => ({ id: row.id, name: pick(row.name, locale) })),
  };
}

// ───────────────────────────────────────────────────────────────── writing

const text = (max: number) => z.string().overwrite(cleanLine).trim().max(max, "too_long").default("");
const lines = z.string().max(40_000, "too_long").default("");

export const ArticleInput = z.object({
  articleId: z.string().trim().max(128).optional(),
  slug: z.string().trim().toLowerCase().min(ARTICLE_LIMITS.slugMin, "too_short").max(ARTICLE_LIMITS.slugMax, "too_long").regex(ARTICLE_SLUG, "invalid"),
  kind: z.enum(ARTICLE_KINDS, "invalid"),
  audience: z.enum(ARTICLE_AUDIENCES, "invalid"),
  titleAr: z.string().overwrite(cleanLine).trim().min(3, "required").max(ARTICLE_LIMITS.titleMax, "too_long"),
  titleEn: text(ARTICLE_LIMITS.titleMax),
  titleCkb: text(ARTICLE_LIMITS.titleMax),
  summaryAr: text(ARTICLE_LIMITS.summaryMax),
  summaryEn: text(ARTICLE_LIMITS.summaryMax),
  summaryCkb: text(ARTICLE_LIMITS.summaryMax),
  bodyAr: lines,
  bodyEn: lines,
  bodyCkb: lines,
  deviceModelId: z.string().trim().max(128).default(""),
  platformId: z.string().trim().max(128).default(""),
  tags: z.string().max(500, "too_long").default(""),
  sort: z.number().int("invalid").min(0, "too_small").max(100_000, "too_big").default(0),
  /** updated_at the form was built from — required for an existing article (a stale form is refused). */
  expectedUpdatedAt: z.number().int().optional(),
  /** For an approved article: the pending revision's version the form was built from (none = there was none). */
  revisionSavedAt: z.number().int().optional(),
  reason: z.string().overwrite(cleanLine).trim().max(500, "too_long").optional(),
});

const l10n = (ar: string, en: string, ckb: string): L10n => ({ ar, ...(en ? { en } : {}), ...(ckb ? { ckb } : {}) });

/** Validated content from the form: blocks per language, tags, the device's platform. */
async function contentFrom(db: Db, input: z.output<typeof ArticleInput>): Promise<Content> {
  const fields: Record<string, string> = {};
  const bodies: Record<"ar" | "en" | "ckb", ArticleBlock[]> = { ar: textToArticleBlocks(input.bodyAr), en: textToArticleBlocks(input.bodyEn), ckb: textToArticleBlocks(input.bodyCkb) };
  if (bodies.ar.length === 0) fields.bodyAr = "required";
  for (const [locale, blocks] of Object.entries(bodies) as ["ar" | "en" | "ckb", ArticleBlock[]][]) {
    const keys = photoKeysOf(blocks);
    if (keys.length === 0) continue;
    // the catalogue manifest is loaded only when an article names a photo (it is a Vite glob of every photo)
    const { hasArt } = await import("~/art");
    if (keys.some((key) => !hasArt(key))) fields[`body${locale === "ar" ? "Ar" : locale === "en" ? "En" : "Ckb"}`] = "photo_unknown";
  }
  let deviceModelId: string | null = null;
  let platformId: string | null = input.platformId || null;
  if (input.deviceModelId) {
    const device = isId(input.deviceModelId) ? await db.select({ id: deviceModels.id, platformId: deviceModels.platformId }).from(deviceModels).where(eq(deviceModels.id, input.deviceModelId)).get() : undefined;
    if (!device) fields.deviceModelId = "invalid";
    else {
      deviceModelId = device.id;
      platformId = device.platformId;
    }
  }
  if (platformId && !deviceModelId) {
    const platform = isId(platformId) ? await db.select({ id: platforms.id }).from(platforms).where(eq(platforms.id, platformId)).get() : undefined;
    if (!platform) fields.platformId = "invalid";
  }
  const tags = [...new Set(input.tags.split(/[,،\n]+/).map((tag) => cleanLine(tag).trim().toLowerCase().replace(/\s+/g, "-")).filter((tag) => tag !== ""))];
  if (tags.length > ARTICLE_LIMITS.tags || tags.some((tag) => tag.length > ARTICLE_LIMITS.tagMax)) fields.tags = "too_big";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const body: LocalizedBlocks = { ar: bodies.ar as LocalizedBlocks["ar"], ...(bodies.en.length ? { en: bodies.en as LocalizedBlocks["ar"] } : {}), ...(bodies.ckb.length ? { ckb: bodies.ckb as LocalizedBlocks["ar"] } : {}) };
  const summary = input.summaryAr || input.summaryEn || input.summaryCkb ? l10n(input.summaryAr, input.summaryEn, input.summaryCkb) : null;
  return { slug: input.slug, kind: input.kind, audience: input.audience, title: l10n(input.titleAr, input.titleEn, input.titleCkb), summary, body, deviceModelId, platformId, tags, sort: input.sort };
}

const audit = (db: Db, actor: Actor, action: string, articleId: string, slug: string, now: number, details: { before?: unknown; after?: unknown; reason?: string | null } = {}): BatchStatement =>
  auditStatement(db, { actor, action, entityType: "knowledge_article", entityId: articleId, summary: slug, before: details.before, after: details.after, reason: details.reason ?? null, at: now });

const summaryOf = (content: Content) => ({ slug: content.slug, kind: content.kind, audience: content.audience, title: content.title, deviceModelId: content.deviceModelId, platformId: content.platformId, tags: content.tags, blocks: { ar: content.body.ar.length, en: content.body.en?.length ?? 0, ckb: content.body.ckb?.length ?? 0 } });

/**
 * Creates a draft, edits a draft or an article in review in place, or — for an approved article — stores the edit as
 * its pending revision (one per article; the same or another editor may change it until it is decided).
 */
export async function saveArticle(db: Db, actor: Actor, raw: z.input<typeof ArticleInput>, now: number, storeMode: "demo" | "live" = "live"): Promise<{ articleId: string; created: boolean; revision: boolean }> {
  assertCan(actor, "support.knowledge.manage");
  const input = ArticleInput.parse(raw);
  const content = await contentFrom(db, input);
  const me = actor.kind === "employee" ? actor.id : null;

  if (!input.articleId) {
    const id = newId("kba");
    try {
      await runBatch(db, [
        db.insert(knowledgeArticles).values({ id, ...content, status: "draft", approvedBy: null, approvedAt: null, isDemo: storeMode === "demo", createdBy: me, createdAt: now, updatedAt: now }),
        audit(db, actor, "support.knowledge.create", id, content.slug, now, { after: summaryOf(content), reason: input.reason ?? null }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw invalid({ slug: "slug_taken" });
      throw error;
    }
    return { articleId: id, created: true, revision: false };
  }

  const row = await articleById(db, input.articleId);
  if (row.status === "archived") throw new AppError("article_not_editable", 409, { detail: row.id });
  if (input.expectedUpdatedAt === undefined || input.expectedUpdatedAt !== row.updatedAt) throw new AppError("article_changed", 409, { detail: row.id });
  if (content.slug !== row.slug && (row.approvedAt !== null || (await slugReferenced(db, row.slug)))) throw invalid({ slug: "slug_locked" });

  if (row.status === "approved") {
    const pending = await pendingRevision(db, row.id);
    const before = revisionOf(pending);
    // the revision the form was built from: another editor's newer revision (or one that appeared since) is not replaced unseen
    if ((input.revisionSavedAt ?? null) !== (before?.savedAt ?? null)) throw new AppError("article_changed", 409, { detail: row.id });
    const editors = [...new Set([...(before?.editors ?? []), ...(me ? [me] : [])])];
    const payload: RevisionPayload = { content, basedOn: row.updatedAt, editors, savedAt: Math.max(now, (before?.savedAt ?? 0) + 1) };
    const statements: BatchStatement[] = pending
      ? [db.update(approvals).set({ payload }).where(and(eq(approvals.id, pending.id), eq(approvals.status, "pending"), before ? sameRevision(before.savedAt) : undefined)), expectChanged(db, 1, "ARTICLE_CHANGED")]
      : [
          expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${REVISION_KIND} AND entity_id = ${row.id} AND status = 'pending')`, "REVISION_PENDING"),
          db.insert(approvals).values({ id: newId("apr"), kind: REVISION_KIND, entityType: "knowledge_article", entityId: row.id, requestedBy: me ?? "system", payload, status: "pending", reason: input.reason ?? null, requiredPermission: "support.knowledge.approve", createdAt: now }),
        ];
    statements.push(audit(db, actor, "support.knowledge.revision", row.id, row.slug, now, { after: summaryOf(content), reason: input.reason ?? null }));
    try {
      await runBatch(db, statements);
    } catch (error) {
      if (isDbError(error, "REVISION_PENDING")) throw new AppError("revision_pending", 409, { detail: row.id });
      if (isDbError(error, "ARTICLE_CHANGED")) throw new AppError("article_changed", 409, { detail: row.id });
      throw error;
    }
    return { articleId: row.id, created: false, revision: true };
  }

  try {
    await runBatch(db, [
      db
        .update(knowledgeArticles)
        .set({ ...content, updatedAt: now })
        .where(and(eq(knowledgeArticles.id, row.id), eq(knowledgeArticles.updatedAt, row.updatedAt), inArray(knowledgeArticles.status, ["draft", "review"]))),
      expectChanged(db, 1, "ARTICLE_CHANGED"),
      audit(db, actor, "support.knowledge.save", row.id, content.slug, now, { before: summaryOf(contentOf(row)), after: summaryOf(content), reason: input.reason ?? null }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid({ slug: "slug_taken" });
    if (isDbError(error, "ARTICLE_CHANGED")) throw new AppError("article_changed", 409, { detail: row.id });
    throw error;
  }
  return { articleId: row.id, created: false, revision: false };
}

const VersionInput = z.object({ articleId: z.string().trim().max(128), expectedUpdatedAt: z.number().int() });

/** draft → review: asks a second person to approve it. */
export async function submitArticle(db: Db, actor: Actor, raw: z.input<typeof VersionInput>, now: number): Promise<void> {
  assertCan(actor, "support.knowledge.manage");
  const input = VersionInput.parse(raw);
  const row = await articleById(db, input.articleId);
  await statusChange(db, actor, row, input.expectedUpdatedAt, "draft", "review", "support.knowledge.submit", now, null);
}

async function statusChange(
  db: Db,
  actor: Actor,
  row: KnowledgeArticle,
  expected: number,
  from: ContentStatus | readonly ContentStatus[],
  to: ContentStatus,
  action: string,
  now: number,
  reason: string | null,
  extra: Partial<typeof knowledgeArticles.$inferInsert> = {},
  more: BatchStatement[] = [],
): Promise<void> {
  const allowed: readonly ContentStatus[] = typeof from === "string" ? [from] : from;
  if (!allowed.includes(row.status) || row.updatedAt !== expected) throw new AppError("article_changed", 409, { detail: row.status });
  try {
    await runBatch(db, [
      db
        .update(knowledgeArticles)
        .set({ status: to, updatedAt: now, ...extra })
        .where(and(eq(knowledgeArticles.id, row.id), eq(knowledgeArticles.updatedAt, row.updatedAt), eq(knowledgeArticles.status, row.status))),
      expectChanged(db, 1, "ARTICLE_CHANGED"),
      ...more,
      audit(db, actor, action, row.id, row.slug, now, { before: { status: row.status }, after: { status: to }, reason }),
    ]);
  } catch (error) {
    if (isDbError(error, "ARTICLE_CHANGED")) throw new AppError("article_changed", 409, { detail: row.id });
    throw error;
  }
}

export const DecisionInput = z.object({
  articleId: z.string().trim().max(128),
  decision: z.enum(["approve", "reject"], "invalid"),
  note: z.string().overwrite(cleanLine).trim().max(1000, "too_long").default(""),
  expectedUpdatedAt: z.number().int(),
});

/** review → approved (shown in the help centre when public) or back to draft with the reason. Never by its editors. */
export async function decideArticle(db: Db, actor: Actor, raw: z.input<typeof DecisionInput>, now: number): Promise<{ status: ContentStatus }> {
  assertCan(actor, "support.knowledge.approve");
  const input = DecisionInput.parse(raw);
  const row = await articleById(db, input.articleId);
  const me = actor.kind === "employee" ? actor.id : null;
  if (me && (await editorsSinceApproval(db, row.id)).includes(me)) throw new AppError("approver_is_editor", 403, { detail: row.id });
  if (input.decision === "reject") {
    if (input.note.length < 3) throw invalid({ note: "reason_required" });
    await statusChange(db, actor, row, input.expectedUpdatedAt, "review", "draft", "support.knowledge.reject", now, input.note);
    return { status: "draft" };
  }
  await statusChange(db, actor, row, input.expectedUpdatedAt, "review", "approved", "support.knowledge.approve", now, input.note || null, { approvedBy: me, approvedAt: now });
  return { status: "approved" };
}

export const RevisionDecisionInput = z.object({
  articleId: z.string().trim().max(128),
  revisionId: z.string().trim().max(128),
  decision: z.enum(["approve", "reject", "withdraw"], "invalid"),
  /** The revision's version the decider saw (ArticleEditor.revision.savedAt) — required to approve or reject. */
  savedAt: z.number().int().optional(),
  note: z.string().overwrite(cleanLine).trim().max(1000, "too_long").default(""),
});

/**
 * The pending revision of an approved article: approved (it replaces the article, guarded on the version it was
 * written against), rejected (with the reason; the article stays as it is), or withdrawn by its author or an editor.
 * A decision is about the content the decider saw: an approval or a rejection names the revision's version, and a
 * revision saved again since (by its writers) is refused — never approved unseen (article_changed).
 */
export async function decideRevision(db: Db, actor: Actor, raw: z.input<typeof RevisionDecisionInput>, now: number): Promise<void> {
  const input = RevisionDecisionInput.parse(raw);
  assertCan(actor, input.decision === "withdraw" ? "support.knowledge.manage" : "support.knowledge.approve");
  const row = await articleById(db, input.articleId);
  const pending = await pendingRevision(db, row.id);
  const revision = revisionOf(pending);
  if (!pending || !revision || pending.id !== input.revisionId) throw new AppError("no_revision", 409, { detail: row.id });
  const me = actor.kind === "employee" ? actor.id : null;
  if (input.decision !== "withdraw" && me && revision.editors.includes(me)) throw new AppError("approver_is_editor", 403, { detail: row.id });
  if (input.decision !== "withdraw" && input.savedAt !== revision.savedAt) throw new AppError("article_changed", 409, { detail: row.id });
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_required" });
  // the revision as it was read (a save between the read and this write is not decided with it)
  const closeRevision = (status: "approved" | "rejected", note: string | null) =>
    db.update(approvals).set({ status, decidedBy: me, decidedAt: now, decisionNote: note }).where(and(eq(approvals.id, pending.id), eq(approvals.status, "pending"), sameRevision(revision.savedAt)));
  const statements: BatchStatement[] = [];
  if (input.decision === "approve") {
    if (row.status !== "approved" || row.updatedAt !== revision.basedOn) throw new AppError("article_changed", 409, { detail: row.id });
    statements.push(
      closeRevision("approved", input.note || null),
      expectChanged(db, 1, "ARTICLE_CHANGED"),
      db
        .update(knowledgeArticles)
        .set({ ...revision.content, slug: row.slug, approvedBy: me, approvedAt: now, updatedAt: now })
        .where(and(eq(knowledgeArticles.id, row.id), eq(knowledgeArticles.updatedAt, revision.basedOn), eq(knowledgeArticles.status, "approved"))),
      expectChanged(db, 1, "ARTICLE_CHANGED"),
      audit(db, actor, "support.knowledge.revision_approve", row.id, row.slug, now, { before: summaryOf(contentOf(row)), after: summaryOf(revision.content), reason: input.note || null }),
    );
  } else {
    statements.push(
      closeRevision("rejected", input.decision === "withdraw" ? `withdrawn${input.note ? `: ${input.note}` : ""}` : input.note),
      expectChanged(db, 1, "ARTICLE_CHANGED"),
      audit(db, actor, input.decision === "withdraw" ? "support.knowledge.revision_withdraw" : "support.knowledge.revision_reject", row.id, row.slug, now, { reason: input.note || null }),
    );
  }
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "ARTICLE_CHANGED")) throw new AppError("article_changed", 409, { detail: row.id });
    throw error;
  }
}

const ArchiveInput = z.object({ articleId: z.string().trim().max(128), expectedUpdatedAt: z.number().int(), reason: z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long") });

/** Takes an article out of the help centre and the agents' list (any status but archived); its revision, if any, is closed with it. */
export async function archiveArticle(db: Db, actor: Actor, raw: z.input<typeof ArchiveInput>, now: number): Promise<void> {
  assertCan(actor, "support.knowledge.manage");
  const input = ArchiveInput.parse(raw);
  const row = await articleById(db, input.articleId);
  const pending = await pendingRevision(db, row.id);
  const close = pending ? [db.update(approvals).set({ status: "rejected", decidedBy: actor.kind === "employee" ? actor.id : null, decidedAt: now, decisionNote: "article archived" }).where(and(eq(approvals.id, pending.id), eq(approvals.status, "pending")))] : [];
  await statusChange(db, actor, row, input.expectedUpdatedAt, ["draft", "review", "approved"], "archived", "support.knowledge.archive", now, input.reason, {}, close);
}

/** archived → draft (it goes through review again before anyone sees it). */
export async function restoreArticle(db: Db, actor: Actor, raw: z.input<typeof VersionInput>, now: number): Promise<void> {
  assertCan(actor, "support.knowledge.manage");
  const input = VersionInput.parse(raw);
  const row = await articleById(db, input.articleId);
  await statusChange(db, actor, row, input.expectedUpdatedAt, "archived", "draft", "support.knowledge.restore", now, null, { approvedBy: null });
}
