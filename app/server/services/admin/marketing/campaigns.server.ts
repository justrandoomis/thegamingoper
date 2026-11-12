/**
 * Admin 16.01 (and the campaign side of 16.03, 16.04, 16.07) — campaigns: prepare, approve by a second person,
 * release to the outbox, record their spend.
 *
 *   listCampaigns(db, actor, filters, now)                       campaign.manage | campaign.send
 *   getCampaign(db, actor, campaignId, locale, now, origin)      the page: facts, request, audience now, recipients, links, spend, history
 *   saveCampaign(db, actor, raw, now, { demo })                  campaign.manage — a draft (create: idempotency key; edit: guarded on updated_at)
 *   submitCampaign / withdrawCampaign(db, actor, raw, now)       campaign.manage — the request for a second person
 *   decideCampaign(db, actor, raw, now)                          campaign.send — never the requester, never someone who wrote the campaign
 *   releaseCampaign(db, actor, raw, now, origin)                 campaign.send — approved and due: the messages are HELD in the outbox
 *   cancelCampaign / closeCampaign(db, actor, raw, now)          campaign.manage
 *   recordSpend(db, actor, raw, now)                             campaign.manage — what was really spent, per month (16.07)
 *   countDecidableCampaigns(db, actor)                           for the bell: requests this employee may decide
 *
 * THE BOUNDARY, said on every screen: no SMS / WhatsApp / e-mail provider is configured, so releasing writes one
 * `outbox` row per recipient with status "held" (template "marketing_campaign", the text in the recipient's language
 * in `payload.text`) and a `campaign_recipients` row "held". Nothing is sent and nothing is reported as sent; the
 * campaign's stored status "sending" is shown as "released — held in the outbox".
 *
 * Every rule of audience.server.ts holds at release: the audience is resolved again then, and the same consent,
 * account and limit checks run inside the INSERT (`recipientGuard`) — a "no" that lands between the count and the
 * write keeps the message out. A release is idempotent (outbox dedupe key `campaign:<id>:<recipient>`, UNIQUE
 * campaign + recipient): a repeat or a resumed release writes nothing twice.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, campaigns } from "~/server/db/schema";
import { batchSql, expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { initialStatus } from "~/server/outbox.server";
import { phoneView } from "~/server/services/admin/customers/shared.server";
import { renderTemplate, templateVariables } from "~/server/services/admin/settings/catalog";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { platformOptions, previewOf, recipientGuard, resolveAudience, segmentOptions, maskEmail, type PlatformOption, type SegmentOption } from "./audience.server";
import { campaignLink, campaignLinks } from "./links.server";
import { actorId, assertAny, employeeNames, historyOf, ID, num, SECTION_READ } from "./shared.server";
import {
  BODY_MAX,
  CAMPAIGN_APPROVAL_KIND,
  CAMPAIGN_CHANNEL_LIST,
  CAMPAIGN_TEMPLATE,
  CAMPAIGN_VARIABLES,
  DAY_MS,
  EMPTY_AUDIENCE,
  MAX_AUDIENCE,
  MESSAGE_CHANNELS,
  MESSAGE_LOCALES,
  RELEASE_CHUNK,
  SUBJECT_MAX,
  UTM_VALUE,
  emptyExclusions,
  fromLocalInput,
  isMessageChannel,
  normalizeDay,
  normalizeMonth,
  parseWhole,
  baghdadMonth,
  type AudiencePreview,
  type AudienceSpec,
  type CampaignChannelKey,
  type CampaignContent,
  type CampaignDetail,
  type CampaignFilters,
  type CampaignRow,
  type CampaignState,
  type CampaignView,
  type MessageChannel,
  type MessageLocale,
  type RecipientRow,
  type ReleaseStats,
  type SpendEntry,
} from "./types";

const PAGE_SIZE = 25;
const STORE_NAME: Record<MessageLocale, string> = { ar: "طمطم", en: "TamTam", ckb: "طمطم" };
const SAVE_ACTIONS = ["marketing.campaign.create", "marketing.campaign.save"] as const;

// ───────────────────────────────────────────────────────────────── reading

type CampaignDbRow = {
  id: string;
  name: string;
  channel: CampaignChannelKey;
  status: string;
  segment_id: string | null;
  template_key: string | null;
  content: string | null;
  scheduled_at: number | null;
  sent_at: number | null;
  budget_iqd: number | null;
  spend_iqd: number;
  utm_campaign: string | null;
  is_demo: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  pending: number;
  held: number | null;
};

function parseContent(text: string | null): CampaignContent {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as CampaignContent) : {};
  } catch {
    return {};
  }
}

/** A campaign as staff see it: the stored status, the waiting request and the schedule together. */
export function stateOf(row: { status: string; channel: string; scheduledAt: number | null }, pending: boolean, now: number): CampaignState {
  switch (row.status) {
    case "draft":
      return pending ? "pending" : "draft";
    case "scheduled":
      if (!isMessageChannel(row.channel)) return "tracking";
      return row.scheduledAt === null || row.scheduledAt <= now ? "due" : "scheduled";
    case "sending":
    case "sent":
    case "paused":
      return "released";
    case "completed":
      return "completed";
    default:
      return "cancelled";
  }
}

const PENDING_SQL = sql`EXISTS (SELECT 1 FROM approvals a WHERE a.kind = ${CAMPAIGN_APPROVAL_KIND} AND a.entity_type = 'campaign' AND a.entity_id = c.id AND a.status = 'pending')`;

/** A waiting request this employee may decide: not theirs, and they never created or edited the campaign. */
function decidableBy(me: string) {
  const actions = JSON.stringify(SAVE_ACTIONS);
  return sql`EXISTS (SELECT 1 FROM approvals a WHERE a.kind = ${CAMPAIGN_APPROVAL_KIND} AND a.entity_type = 'campaign' AND a.entity_id = c.id AND a.status = 'pending' AND a.requested_by <> ${me})
    AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_type = 'campaign' AND e.entity_id = c.id AND e.actor_kind = 'employee' AND e.actor_id = ${me} AND e.action IN (SELECT value FROM json_each(${actions})))`;
}

/** An approved MESSAGE campaign whose time has come (state "due"): what may be released now. */
const dueSql = (now: number) =>
  sql`c.status = 'scheduled' AND c.channel IN (SELECT value FROM json_each(${JSON.stringify(MESSAGE_CHANNELS)})) AND (c.scheduled_at IS NULL OR c.scheduled_at <= ${now})`;

function viewWhere(view: CampaignView, me: string, now: number) {
  switch (view) {
    case "decide":
      return me ? sql`c.status = 'draft' AND ${decidableBy(me)}` : sql`1 = 0`;
    case "draft":
      return sql`c.status = 'draft' AND NOT ${PENDING_SQL}`;
    case "pending":
      return sql`c.status = 'draft' AND ${PENDING_SQL}`;
    case "scheduled":
      return sql`c.status = 'scheduled'`;
    case "due":
      return dueSql(now);
    case "released":
      return sql`c.status IN ('sending', 'sent', 'paused')`;
    case "closed":
      return sql`c.status IN ('completed', 'cancelled')`;
    default:
      return sql`1 = 1`;
  }
}

function toRow(row: CampaignDbRow, now: number): CampaignRow {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    state: stateOf({ status: row.status, channel: row.channel, scheduledAt: row.scheduled_at }, num(row.pending) === 1, now),
    isDemo: num(row.is_demo) === 1,
    scheduledAt: row.scheduled_at === null ? null : num(row.scheduled_at),
    budgetIqd: row.budget_iqd === null ? null : num(row.budget_iqd),
    spendIqd: num(row.spend_iqd),
    utmCampaign: row.utm_campaign,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    createdBy: row.created_by,
    held: row.held === null ? null : num(row.held),
  };
}

export type CampaignListPage = { rows: CampaignRow[]; total: number; page: number; pageCount: number; counts: Record<CampaignView, number> };

export async function listCampaigns(db: Db, actor: Actor, filters: CampaignFilters, now: number): Promise<CampaignListPage> {
  assertAny(actor, SECTION_READ.campaigns);
  const demo = filters.demo ? sql`1 = 1` : sql`c.is_demo = 0`;
  const search = filters.q ? sql`(c.name LIKE ${`%${filters.q}%`} OR c.utm_campaign LIKE ${`%${filters.q.toLowerCase()}%`})` : sql`1 = 1`;
  const channel = filters.channel ? sql`c.channel = ${filters.channel}` : sql`1 = 1`;
  const base = sql`${demo} AND ${search} AND ${channel}`;
  const me = can(actor, "marketing.campaign.send") ? (actorId(actor) ?? "") : "";
  const [countRow] = await db.all<Record<string, number>>(sql`
    SELECT COUNT(*) AS all_n,
      SUM(CASE WHEN ${viewWhere("decide", me, now)} THEN 1 ELSE 0 END) AS decide,
      SUM(CASE WHEN ${viewWhere("draft", me, now)} THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN ${viewWhere("pending", me, now)} THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ${viewWhere("scheduled", me, now)} THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN ${viewWhere("due", me, now)} THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN ${viewWhere("released", me, now)} THEN 1 ELSE 0 END) AS released,
      SUM(CASE WHEN ${viewWhere("closed", me, now)} THEN 1 ELSE 0 END) AS closed
    FROM campaigns c WHERE ${base}`);
  const counts: Record<CampaignView, number> = {
    all: num(countRow?.all_n),
    decide: num(countRow?.decide),
    draft: num(countRow?.draft),
    pending: num(countRow?.pending),
    scheduled: num(countRow?.scheduled),
    due: num(countRow?.due),
    released: num(countRow?.released),
    closed: num(countRow?.closed),
  };
  const total = counts[filters.view];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<CampaignDbRow>(sql`
    SELECT c.*, CASE WHEN ${PENDING_SQL} THEN 1 ELSE 0 END AS pending,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('held', 'pending', 'sent')) AS held
    FROM campaigns c WHERE ${base} AND ${viewWhere(filters.view, me, now)}
    ORDER BY c.updated_at DESC, c.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  return { rows: rows.map((row) => toRow(row, now)), total, page, pageCount, counts };
}

async function campaignRow(db: Db, campaignId: string): Promise<CampaignDbRow> {
  if (!ID.test(campaignId)) throw notFound("campaign");
  const row = (
    await db.all<CampaignDbRow>(sql`
      SELECT c.*, CASE WHEN ${PENDING_SQL} THEN 1 ELSE 0 END AS pending,
        (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('held', 'pending', 'sent')) AS held
      FROM campaigns c WHERE c.id = ${campaignId}`)
  )[0];
  if (!row) throw notFound("campaign");
  return row;
}

/** What the approver binds to: everything that decides who gets what, and when. */
export async function campaignFingerprint(row: Pick<CampaignDbRow, "name" | "channel" | "segment_id" | "scheduled_at" | "budget_iqd" | "utm_campaign"> & { content: CampaignContent }): Promise<string> {
  const c = row.content;
  return sha256Hex(
    JSON.stringify([row.name, row.channel, row.segment_id, row.scheduled_at, row.budget_iqd, row.utm_campaign, c.audience ?? null, c.body ?? null, c.subject ?? null, c.linkId ?? null, c.startsOn ?? null, c.endsOn ?? null]),
  );
}

const audienceOf = (row: CampaignDbRow, content: CampaignContent): AudienceSpec => ({ ...EMPTY_AUDIENCE, ...(content.audience ?? {}), segmentId: row.segment_id });

type PendingApproval = { id: string; requested_by: string; reason: string | null; created_at: number; payload: string | null };

async function pendingApproval(db: Db, campaignId: string): Promise<PendingApproval | null> {
  return (
    (
      await db.all<PendingApproval>(
        sql`SELECT id, requested_by, reason, created_at, payload FROM approvals WHERE kind = ${CAMPAIGN_APPROVAL_KIND} AND entity_type = 'campaign' AND entity_id = ${campaignId} AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      )
    )[0] ?? null
  );
}

/** Employees who created or edited the campaign (from the audit trail, which nobody can change). */
async function editorsOf(db: Db, campaignId: string): Promise<Set<string>> {
  const actions = JSON.stringify(SAVE_ACTIONS);
  const rows = await db.all<{ actor_id: string | null }>(
    sql`SELECT DISTINCT actor_id FROM audit_events WHERE entity_type = 'campaign' AND entity_id = ${campaignId} AND action IN (SELECT value FROM json_each(${actions})) AND actor_kind = 'employee'`,
  );
  return new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)));
}

const fingerprintOf = (payload: string | null): string => {
  try {
    const value = payload ? (JSON.parse(payload) as { fingerprint?: unknown }) : null;
    return typeof value?.fingerprint === "string" ? value.fingerprint : "";
  } catch {
    return "";
  }
};

export type CampaignPage = {
  campaign: CampaignDetail;
  preview: AudiencePreview | null;
  /** The text a recipient in each language would get (with a sample first name). */
  rendered: Partial<Record<MessageLocale, { body: string; subject: string | null }>>;
  options: { segments: SegmentOption[]; platforms: PlatformOption[] };
};

export async function getCampaign(db: Db, actor: Actor, campaignId: string, locale: Locale, now: number, origin: string): Promise<CampaignPage> {
  assertAny(actor, SECTION_READ.campaigns);
  const row = await campaignRow(db, campaignId);
  const content = parseContent(row.content);
  const pending = await pendingApproval(db, campaignId);
  const [editors, names, history, recipientCounts, links, segments, platforms, lastDecisionRows] = await Promise.all([
    editorsOf(db, campaignId),
    employeeNames(db, [row.created_by, pending?.requested_by]),
    historyOf(db, "campaign", campaignId),
    db.all<{ status: string; n: number }>(sql`SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ${campaignId} GROUP BY status`),
    campaignLinks(db, campaignId, origin, content.linkId ?? null),
    segmentOptions(db, locale),
    platformOptions(db, locale),
    db.all<{ status: "approved" | "rejected"; decided_by: string | null; decision_note: string | null; decided_at: number | null }>(
      sql`SELECT status, decided_by, decision_note, decided_at FROM approvals WHERE kind = ${CAMPAIGN_APPROVAL_KIND} AND entity_type = 'campaign' AND entity_id = ${campaignId} AND status <> 'pending' ORDER BY decided_at DESC LIMIT 1`,
    ),
  ]);
  const base = toRow(row, now);
  const fingerprint = await campaignFingerprint({ ...row, content });
  const me = actorId(actor);
  const send = can(actor, "marketing.campaign.send");
  const manage = can(actor, "marketing.campaign.manage");
  const blockedBy = pending && me ? (pending.requested_by === me ? "requester" : editors.has(me) ? "editor" : null) : null;
  const count = (status: string) => num(recipientCounts.find((entry) => entry.status === status)?.n);
  const lastDecision = lastDecisionRows[0];
  const deciderNames = lastDecision?.decided_by ? await employeeNames(db, [lastDecision.decided_by]) : new Map<string, string>();
  const state = base.state;
  const message = isMessageChannel(row.channel);
  const campaign: CampaignDetail = {
    ...base,
    content,
    segmentId: row.segment_id,
    fingerprint,
    approval: pending
      ? {
          id: pending.id,
          requestedBy: pending.requested_by,
          requestedByName: names.get(pending.requested_by) ?? null,
          reason: pending.reason,
          createdAt: num(pending.created_at),
          fingerprint: fingerprintOf(pending.payload),
          mine: pending.requested_by === me,
          canDecide: send && blockedBy === null,
          blockedBy: send ? blockedBy : null,
        }
      : null,
    lastDecision: lastDecision ? { status: lastDecision.status, by: lastDecision.decided_by ? (deciderNames.get(lastDecision.decided_by) ?? null) : null, note: lastDecision.decision_note, at: lastDecision.decided_at } : null,
    recipients: { held: count("held"), pending: count("pending"), sent: count("sent"), failed: count("failed"), skipped: count("skipped_no_consent") },
    links,
    history,
    can: {
      edit: manage && state === "draft",
      submit: manage && state === "draft",
      withdraw: manage && state === "pending" && pending?.requested_by === me,
      release: send && message && (state === "due" || (state === "released" && row.status === "sending" && content.release?.complete !== true)),
      cancel: manage && (state === "draft" || state === "pending" || state === "scheduled" || state === "due" || state === "tracking"),
      close: manage && (state === "released" || state === "tracking"),
      spend: manage,
    },
  };
  // who it would reach now (a released campaign keeps what it reached)
  let preview: AudiencePreview | null = null;
  if (message && state !== "released" && state !== "completed" && state !== "cancelled") {
    const spec = audienceOf(row, content);
    const segment = spec.segmentId ? (segments.find((entry) => entry.id === spec.segmentId) ?? null) : null;
    preview = previewOf(actor, await resolveAudience(db, { spec, channel: row.channel as MessageChannel, isDemo: base.isDemo, now }), segment);
  }
  const rendered: CampaignPage["rendered"] = {};
  if (message) {
    const link = content.linkId ? (links.find((entry) => entry.id === content.linkId)?.url ?? null) : null;
    for (const lang of MESSAGE_LOCALES) {
      const body = content.body?.[lang];
      if (!body) continue;
      const subject = content.subject?.[lang] ?? null;
      const sample = lang === "en" ? "Sara" : "سارة";
      rendered[lang] = { body: renderTemplate(body, { name: sample, link: link ?? "{link}", store: STORE_NAME[lang] }), subject: subject ? renderTemplate(subject, { name: sample, link: link ?? "{link}", store: STORE_NAME[lang] }) : null };
    }
  }
  return { campaign, preview, rendered, options: { segments, platforms } };
}

export async function campaignFormOptions(db: Db, actor: Actor, locale: Locale): Promise<{ segments: SegmentOption[]; platforms: PlatformOption[] }> {
  assertAny(actor, SECTION_READ.campaigns);
  const [segments, platforms] = await Promise.all([segmentOptions(db, locale), platformOptions(db, locale)]);
  return { segments, platforms };
}

export async function listRecipients(db: Db, actor: Actor, campaignId: string, page: number): Promise<{ rows: RecipientRow[]; total: number; page: number; pageCount: number }> {
  assertAny(actor, SECTION_READ.campaigns);
  await campaignRow(db, campaignId);
  const [totalRow] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ${campaignId}`);
  const total = num(totalRow?.n);
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const current = Math.min(Math.max(1, page), pageCount);
  const rows = await db.all<{ id: string; recipient: string; status: string; customer_id: string | null; name: string | null }>(sql`
    SELECT r.id, r.recipient, r.status, r.customer_id, cu.name FROM campaign_recipients r LEFT JOIN customers cu ON cu.id = r.customer_id
    WHERE r.campaign_id = ${campaignId} ORDER BY CASE r.status WHEN 'skipped_no_consent' THEN 1 ELSE 0 END, r.id LIMIT 50 OFFSET ${(current - 1) * 50}`);
  const full = can(actor, "customer.phone.read_full");
  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.recipient.startsWith("+") ? phoneView(row.recipient, full) : null,
      email: row.recipient.includes("@") ? maskEmail(row.recipient, full) : null,
      status: row.status,
      profileId: customerProfileId(actor, row.customer_id),
    })),
    total,
    page: current,
    pageCount,
  };
}

// ───────────────────────────────────────────────────────────────── saving a draft

const text = (max: number) => z.preprocess((value) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : value), z.string().max(max, "too_long"));
const optionalId = z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().regex(ID, "invalid").optional());
const flag = z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean());

const SaveInput = z.object({
  campaignId: optionalId,
  expectedUpdatedAt: z.preprocess((value) => (value === "" || value === undefined || value === null ? undefined : Number(value)), z.number().int().optional()),
  idempotencyKey: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().min(16, "invalid").max(128, "invalid").regex(/^[A-Za-z0-9_-]+$/, "invalid").optional()),
  // checked with the other fields below, so one submit shows every problem at once
  name: text(200),
  channel: z.enum(CAMPAIGN_CHANNEL_LIST, { error: "required" }),
  segmentId: optionalId,
  platformIds: z.preprocess((value) => (Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []), z.array(z.string().regex(ID, "invalid")).max(10, "too_big")),
  boughtFrom: text(20),
  boughtTo: text(20),
  guests: flag,
  bodyAr: text(5000),
  bodyEn: text(5000),
  bodyCkb: text(5000),
  subjectAr: text(SUBJECT_MAX),
  subjectEn: text(SUBJECT_MAX),
  subjectCkb: text(SUBJECT_MAX),
  linkId: optionalId,
  scheduledAt: text(20),
  budgetIqd: text(30),
  utmCampaign: text(80),
  notes: text(500),
  startsOn: text(20),
  endsOn: text(20),
});
export type SaveCampaignInput = z.input<typeof SaveInput>;

const LOCALE_FIELD: Record<MessageLocale, { body: "bodyAr" | "bodyEn" | "bodyCkb"; subject: "subjectAr" | "subjectEn" | "subjectCkb" }> = {
  ar: { body: "bodyAr", subject: "subjectAr" },
  en: { body: "bodyEn", subject: "subjectEn" },
  ckb: { body: "bodyCkb", subject: "subjectCkb" },
};

async function newUtmCampaign(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const value = `cmp-${newId("x").slice(-6).toLowerCase()}`;
    const taken = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM campaigns WHERE utm_campaign = ${value}`);
    if (num(taken[0]?.n) === 0) return value;
  }
  return `cmp-${newId("x").slice(-10).toLowerCase()}`;
}

/** Creates a draft or saves the draft the form showed. Messages are checked against CAMPAIGN_VARIABLES and the channel's length. */
export async function saveCampaign(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ campaignId: string; created: boolean; replayed: boolean }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const parsed = SaveInput.safeParse(raw ?? {});
  if (!parsed.success) throw parsed.error;
  const input = parsed.data;
  const fields: Record<string, string> = {};
  const message = isMessageChannel(input.channel);
  if (input.name.length < 3) fields.name = input.name.length === 0 ? "required" : "too_short";
  else if (input.name.length > 120) fields.name = "too_long";

  let existing: CampaignDbRow | null = null;
  if (input.campaignId) {
    existing = await campaignRow(db, input.campaignId);
    if (existing.status !== "draft") throw new AppError("campaign_not_draft", 409);
    if (num(existing.pending) === 1) throw new AppError("change_pending", 409);
    if (input.expectedUpdatedAt === undefined || input.expectedUpdatedAt !== num(existing.updated_at)) throw new AppError("campaign_changed", 409);
    if (existing.channel !== input.channel && isMessageChannel(existing.channel) !== message) fields.channel = "channel_locked";
  } else if (!input.idempotencyKey) {
    throw invalid({ idempotencyKey: "required" });
  }

  // audience (message campaigns)
  let segmentId: string | null = null;
  const audience: AudienceSpec = { ...EMPTY_AUDIENCE };
  if (message) {
    if (input.segmentId) {
      const found = await db.all<{ id: string }>(sql`SELECT id FROM customer_segments WHERE id = ${input.segmentId}`);
      if (found.length === 0) fields.segmentId = "segment_unknown";
      else segmentId = input.segmentId;
    }
    if (input.platformIds.length > 0) {
      const known = await db.all<{ id: string }>(sql`SELECT id FROM platforms WHERE id IN (SELECT value FROM json_each(${JSON.stringify(input.platformIds)}))`);
      audience.platformIds = known.map((row) => row.id);
    }
    const from = input.boughtFrom ? normalizeDay(input.boughtFrom) : null;
    const to = input.boughtTo ? normalizeDay(input.boughtTo) : null;
    if (input.boughtFrom && !from) fields.boughtFrom = "date_invalid";
    if (input.boughtTo && !to) fields.boughtTo = "date_invalid";
    if (from && to && from > to) fields.boughtTo = "range_order";
    audience.boughtFrom = from;
    audience.boughtTo = to;
    audience.guests = input.guests;
    audience.segmentId = segmentId;
  }

  // message texts
  const body: Partial<Record<MessageLocale, string>> = {};
  const subject: Partial<Record<MessageLocale, string>> = {};
  if (message) {
    const channel = input.channel as MessageChannel;
    for (const lang of MESSAGE_LOCALES) {
      const value = input[LOCALE_FIELD[lang].body];
      if (value) {
        if (value.length > BODY_MAX[channel]) fields[LOCALE_FIELD[lang].body] = "too_long";
        const unknown = templateVariables(value).filter((name) => !(CAMPAIGN_VARIABLES as readonly string[]).includes(name));
        if (unknown.length > 0) fields[LOCALE_FIELD[lang].body] = "template_variable_unknown";
        body[lang] = value;
      }
      const title = input[LOCALE_FIELD[lang].subject];
      if (channel === "email" && title) {
        const unknown = templateVariables(title).filter((name) => !(CAMPAIGN_VARIABLES as readonly string[]).includes(name));
        if (unknown.length > 0) fields[LOCALE_FIELD[lang].subject] = "template_variable_unknown";
        subject[lang] = title;
      }
    }
    if (!body.ar) fields.bodyAr = "required";
    if (channel === "email" && !subject.ar) fields.subjectAr = "required";
    const usesLink = Object.values(body).some((value) => value?.includes("{link}")) || Object.values(subject).some((value) => value?.includes("{link}"));
    if (input.linkId) {
      const own = existing ? await db.all<{ id: string }>(sql`SELECT id FROM utm_links WHERE id = ${input.linkId} AND campaign_id = ${existing.id}`) : [];
      if (own.length === 0) fields.linkId = "link_not_campaign";
    } else if (usesLink) {
      fields.linkId = "link_required";
    }
  }

  // schedule, budget, link value, dates
  let scheduledAt: number | null = null;
  if (input.scheduledAt) {
    scheduledAt = fromLocalInput(input.scheduledAt);
    if (scheduledAt === null) fields.scheduledAt = "date_invalid";
    else if (scheduledAt > now + 90 * DAY_MS) fields.scheduledAt = "too_far";
  }
  const budget = parseWhole(input.budgetIqd);
  if (budget !== undefined && (Number.isNaN(budget) || budget < 0 || budget > 1_000_000_000)) fields.budgetIqd = "number_invalid";
  let utm = input.utmCampaign ? input.utmCampaign.toLowerCase() : "";
  if (utm && !UTM_VALUE.test(utm)) fields.utmCampaign = "utm_invalid";
  if (utm && UTM_VALUE.test(utm)) {
    const taken = await db.all<{ id: string }>(sql`SELECT id FROM campaigns WHERE utm_campaign = ${utm} AND id <> ${existing?.id ?? ""}`);
    if (taken.length > 0) fields.utmCampaign = "utm_taken";
  }
  const startsOn = input.startsOn ? normalizeDay(input.startsOn) : null;
  const endsOn = input.endsOn ? normalizeDay(input.endsOn) : null;
  if (!message) {
    if (input.startsOn && !startsOn) fields.startsOn = "date_invalid";
    if (input.endsOn && !endsOn) fields.endsOn = "date_invalid";
    if (startsOn && endsOn && startsOn > endsOn) fields.endsOn = "range_order";
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const previous = existing ? parseContent(existing.content) : {};
  const content: CampaignContent = {
    ...previous,
    audience: message ? audience : undefined,
    body: message ? body : undefined,
    subject: message && input.channel === "email" ? subject : undefined,
    linkId: message ? (input.linkId ?? null) : null,
    notes: input.notes || null,
    startsOn: message ? null : startsOn,
    endsOn: message ? null : endsOn,
  };
  const me = actorId(actor);
  const after = { name: input.name, channel: input.channel, segmentId, audience: content.audience ?? null, body: content.body ?? null, subject: content.subject ?? null, linkId: content.linkId, scheduledAt, budgetIqd: budget ?? null, notes: content.notes };

  if (!existing) {
    const key = input.idempotencyKey as string;
    const campaignId = `cmp_${(await sha256Hex(`tamtam.marketing.campaign|${key}`)).slice(0, 26)}`;
    const replay = await db.all<{ created_by: string | null; name: string }>(sql`SELECT created_by, name FROM campaigns WHERE id = ${campaignId}`);
    if (replay[0]) {
      if (replay[0].created_by !== me || replay[0].name !== input.name) throw new AppError("idempotency_mismatch", 409);
      return { campaignId, created: false, replayed: true };
    }
    if (!utm) utm = await newUtmCampaign(db);
    try {
      await runBatch(db, [
        utmFree(db, campaignId, utm),
        db.insert(campaigns).values({
          id: campaignId,
          name: input.name,
          channel: input.channel,
          status: "draft",
          segmentId,
          templateKey: message ? CAMPAIGN_TEMPLATE : null,
          content,
          scheduledAt,
          budgetIqd: budget ?? null,
          spendIqd: 0,
          utmCampaign: utm,
          isDemo: options.demo === true,
          createdBy: me,
          createdAt: now,
          updatedAt: now,
        }),
        auditStatement(db, { actor, action: "marketing.campaign.create", entityType: "campaign", entityId: campaignId, after: { ...after, utmCampaign: utm, isDemo: options.demo === true }, at: now }),
      ]);
    } catch (error) {
      const info = mapDbError(error);
      // another campaign took the same utm_campaign just before this write (the check above ran before it)
      if (info?.code === "UTM_TAKEN") throw invalid({ utmCampaign: "utm_taken" });
      if (info?.kind === "unique") return { campaignId, created: false, replayed: true };
      throw error;
    }
    return { campaignId, created: true, replayed: false };
  }

  const updatedAt = Math.max(now, num(existing.updated_at) + 1);
  await runBatch(db, [
    utmFree(db, existing.id, utm || existing.utm_campaign),
    db
      .update(campaigns)
      .set({ name: input.name, channel: input.channel, segmentId, content, scheduledAt, budgetIqd: budget ?? null, utmCampaign: utm || existing.utm_campaign, templateKey: message ? CAMPAIGN_TEMPLATE : null, updatedAt })
      .where(sql`${campaigns.id} = ${existing.id} AND ${campaigns.status} = 'draft' AND ${campaigns.updatedAt} = ${num(existing.updated_at)}`),
    expectChanged(db, 1, "CAMPAIGN_CHANGED"),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${CAMPAIGN_APPROVAL_KIND} AND entity_type = 'campaign' AND entity_id = ${existing.id} AND status = 'pending')`, "CHANGE_PENDING"),
    auditStatement(db, {
      actor,
      action: "marketing.campaign.save",
      entityType: "campaign",
      entityId: existing.id,
      before: { name: existing.name, channel: existing.channel, segmentId: existing.segment_id, audience: previous.audience ?? null, body: previous.body ?? null, subject: previous.subject ?? null, linkId: previous.linkId ?? null, scheduledAt: existing.scheduled_at, budgetIqd: existing.budget_iqd },
      after,
      at: now,
    }),
  ]).catch((error) => rethrowGuard(error));
  return { campaignId: existing.id, created: false, replayed: false };
}

/**
 * Inside the write: no OTHER campaign holds this utm_campaign (it attributes orders to exactly one campaign — two
 * drafts saved at once must not share one; the read before the batch cannot see the other request).
 */
function utmFree(db: Db, campaignId: string, value: string | null): BatchStatement {
  return expectThat(db, sql`NOT EXISTS (SELECT 1 FROM campaigns WHERE utm_campaign = ${value} AND id <> ${campaignId})`, "UTM_TAKEN");
}

function rethrowGuard(error: unknown): never {
  const info = mapDbError(error);
  const code = info?.code;
  if (code === "UTM_TAKEN") throw invalid({ utmCampaign: "utm_taken" });
  if (code === "CAMPAIGN_CHANGED") throw new AppError("campaign_changed", 409);
  if (code === "CHANGE_PENDING") throw new AppError("change_pending", 409);
  if (code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  if (code === "APPROVER_EDITED") throw new AppError("approver_edited", 403);
  if (code === "CAMPAIGN_NOT_DUE") throw new AppError("campaign_not_due", 409);
  if (code === "CAMPAIGN_CLOSED") throw new AppError("campaign_closed", 409);
  throw error;
}

// ───────────────────────────────────────────────────────────────── the second person

const reason = (min: number) => z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().max(500, "too_long").refine((value) => value.length === 0 || value.length >= min, "too_short"));
const SubmitInput = z.object({ campaignId: z.string().regex(ID, "invalid"), expectedUpdatedAt: z.preprocess((value) => Number(value), z.number().int()), note: reason(3) });

/** Asks a second person to approve the draft as it is now. The audience must reach someone and stay within MAX_AUDIENCE. */
export async function submitCampaign(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ approvalId: string; eligible: number | null }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const input = SubmitInput.parse(raw ?? {});
  const row = await campaignRow(db, input.campaignId);
  if (row.status !== "draft") throw new AppError("campaign_not_draft", 409);
  if (num(row.pending) === 1) throw new AppError("change_pending", 409);
  if (num(row.updated_at) !== input.expectedUpdatedAt) throw new AppError("campaign_changed", 409);
  const content = parseContent(row.content);
  let eligible: number | null = null;
  if (isMessageChannel(row.channel)) {
    if (!content.body?.ar) throw invalid({ bodyAr: "required" });
    const result = await resolveAudience(db, { spec: audienceOf(row, content), channel: row.channel, isDemo: num(row.is_demo) === 1, now });
    if (result.truncated || result.recipients.length > MAX_AUDIENCE) throw new AppError("audience_too_large", 409);
    if (result.recipients.length === 0) throw new AppError("audience_empty", 409);
    eligible = result.recipients.length;
  }
  const fingerprint = await campaignFingerprint({ ...row, content });
  const approvalId = newId("apr");
  await runBatch(db, [
    expectThat(db, sql`EXISTS (SELECT 1 FROM campaigns WHERE id = ${row.id} AND status = 'draft' AND updated_at = ${num(row.updated_at)})`, "CAMPAIGN_CHANGED"),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${CAMPAIGN_APPROVAL_KIND} AND entity_type = 'campaign' AND entity_id = ${row.id} AND status = 'pending')`, "CHANGE_PENDING"),
    db.insert(approvals).values({
      id: approvalId,
      kind: CAMPAIGN_APPROVAL_KIND,
      entityType: "campaign",
      entityId: row.id,
      requestedBy: actorId(actor) ?? "system",
      payload: { fingerprint, eligible },
      status: "pending",
      reason: input.note || null,
      requiredPermission: "marketing.campaign.send",
      createdAt: now,
    }),
    auditStatement(db, { actor, action: "marketing.campaign.submit", entityType: "campaign", entityId: row.id, after: { approvalId, eligible }, reason: input.note || null, at: now }),
  ]).catch((error) => rethrowGuard(error));
  return { approvalId, eligible };
}

const DecideInput = z.object({
  campaignId: z.string().regex(ID, "invalid"),
  approvalId: z.string().regex(ID, "invalid"),
  decision: z.enum(["approve", "reject"], { error: "required" }),
  fingerprint: z.string().min(16, "invalid").max(128, "invalid"),
  note: reason(3),
});

/**
 * A second person's decision. Approving binds to the campaign the decider saw (its fingerprint) and moves it to
 * "scheduled"; rejecting (with a note) sends it back to draft. Never the requester, never anyone who wrote it —
 * both checked again inside the batch.
 */
export async function decideCampaign(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "scheduled" | "draft" }> {
  assertAny(actor, ["marketing.campaign.send"]);
  const input = DecideInput.parse(raw ?? {});
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_required" });
  const row = await campaignRow(db, input.campaignId);
  const pending = await pendingApproval(db, row.id);
  if (!pending || pending.id !== input.approvalId) throw new AppError("change_not_pending", 409);
  const me = actorId(actor);
  if (!me || pending.requested_by === me) throw new AppError("approver_is_requester", 403);
  if ((await editorsOf(db, row.id)).has(me)) throw new AppError("approver_edited", 403);
  const content = parseContent(row.content);
  const current = await campaignFingerprint({ ...row, content });
  if (input.fingerprint !== current || fingerprintOf(pending.payload) !== current) throw new AppError("campaign_changed", 409);
  const actions = JSON.stringify(SAVE_ACTIONS);
  const approve = input.decision === "approve";
  const statements: BatchStatement[] = [
    db
      .update(approvals)
      .set({ status: approve ? "approved" : "rejected", decidedBy: me, decidedAt: now, decisionNote: input.note || null })
      .where(sql`${approvals.id} = ${pending.id} AND ${approvals.status} = 'pending' AND ${approvals.requestedBy} <> ${me}`),
    expectChanged(db, 1, "CHANGE_NOT_PENDING"),
    expectThat(
      db,
      sql`NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'campaign' AND entity_id = ${row.id} AND actor_kind = 'employee' AND actor_id = ${me} AND action IN (SELECT value FROM json_each(${actions})))`,
      "APPROVER_EDITED",
    ),
  ];
  if (approve) {
    statements.push(
      db.update(campaigns).set({ status: "scheduled", updatedAt: Math.max(now, num(row.updated_at) + 1) }).where(sql`${campaigns.id} = ${row.id} AND ${campaigns.status} = 'draft' AND ${campaigns.updatedAt} = ${num(row.updated_at)}`),
      expectChanged(db, 1, "CAMPAIGN_CHANGED"),
    );
  }
  statements.push(auditStatement(db, { actor, action: approve ? "marketing.campaign.approve" : "marketing.campaign.reject", entityType: "campaign", entityId: row.id, after: { approvalId: pending.id, fingerprint: current }, reason: input.note || null, at: now }));
  await runBatch(db, statements).catch((error) => rethrowGuard(error));
  return { status: approve ? "scheduled" : "draft" };
}

const WithdrawInput = z.object({ campaignId: z.string().regex(ID, "invalid"), approvalId: z.string().regex(ID, "invalid") });

/** The requester takes the request back (the campaign stays a draft). */
export async function withdrawCampaign(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ withdrawn: true }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const input = WithdrawInput.parse(raw ?? {});
  const row = await campaignRow(db, input.campaignId);
  const pending = await pendingApproval(db, row.id);
  const me = actorId(actor);
  if (!pending || pending.id !== input.approvalId) throw new AppError("change_not_pending", 409);
  if (pending.requested_by !== me) throw new AppError("forbidden", 403);
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: me, decidedAt: now, decisionNote: "withdrawn" }).where(sql`${approvals.id} = ${pending.id} AND ${approvals.status} = 'pending' AND ${approvals.requestedBy} = ${me}`),
    expectChanged(db, 1, "CHANGE_NOT_PENDING"),
    auditStatement(db, { actor, action: "marketing.campaign.withdraw", entityType: "campaign", entityId: row.id, after: { approvalId: pending.id }, at: now }),
  ]).catch((error) => rethrowGuard(error));
  return { withdrawn: true };
}

// ───────────────────────────────────────────────────────────────── release (the boundary)

const ReleaseInput = z.object({ campaignId: z.string().regex(ID, "invalid") });

/** Each language's text with {link} and {store} filled; {name} stays for the database to fill per recipient. */
export function bodiesFor(content: CampaignContent, link: string | null): { body: Record<MessageLocale, string>; subject: Record<MessageLocale, string> | null } {
  // renderTemplate leaves a variable it has no value for as it is, so "{name}" survives for the per-recipient fill
  const fill = (value: string, lang: MessageLocale) => renderTemplate(value, { link: link ?? "", store: STORE_NAME[lang] });
  const ar = content.body?.ar ?? "";
  const body = { ar: fill(ar, "ar"), en: fill(content.body?.en || ar, "en"), ckb: fill(content.body?.ckb || ar, "ckb") };
  const subjectAr = content.subject?.ar;
  const subject = subjectAr ? { ar: fill(subjectAr, "ar"), en: fill(content.subject?.en || subjectAr, "en"), ckb: fill(content.subject?.ckb || subjectAr, "ckb") } : null;
  return { body, subject };
}

const NAME_FALLBACK: Record<MessageLocale, string> = { ar: "صديقنا", en: "there", ckb: "هاوڕێ" };

/**
 * Releases an approved campaign whose time has come: the audience is resolved again, and each recipient that still
 * passes every rule INSIDE the write gets one HELD outbox message and a "held" recipient row; people without consent
 * are documented as "skipped_no_consent". Idempotent and resumable.
 */
export async function releaseCampaign(db: Db, actor: Actor, raw: unknown, now: number, origin: string): Promise<{ held: number; skipped: number; excluded: ReleaseStats["excluded"]; replayed: boolean }> {
  assertAny(actor, ["marketing.campaign.send"]);
  const input = ReleaseInput.parse(raw ?? {});
  const row = await campaignRow(db, input.campaignId);
  if (!isMessageChannel(row.channel)) throw new AppError("campaign_not_message", 409);
  const content = parseContent(row.content);
  const resuming = row.status === "sending";
  if (resuming && content.release?.complete) return { ...(await recipientTotals(db, row.id)), excluded: { ...emptyExclusions(), ...content.release.excluded }, replayed: true };
  if (!resuming) {
    if (row.status !== "scheduled") throw new AppError(row.status === "draft" ? "campaign_not_draft" : "campaign_closed", 409);
    if (row.scheduled_at !== null && num(row.scheduled_at) > now) throw new AppError("campaign_not_due", 409);
  }
  const channel = row.channel as MessageChannel;
  const isDemo = num(row.is_demo) === 1;
  const result = await resolveAudience(db, { spec: audienceOf(row, content), channel, isDemo, now, excludeCampaignId: row.id });
  if (result.truncated || result.recipients.length > MAX_AUDIENCE) throw new AppError("audience_too_large", 409);
  // the link its text uses, by id (never "the newest 50 links", which loses it once more were made)
  const link = content.linkId ? ((await campaignLink(db, row.id, content.linkId, origin))?.url ?? null) : null;
  if (content.linkId && !link) throw new AppError("link_not_campaign", 409);
  const { body, subject } = bodiesFor(content, link);
  const status = initialStatus(channel);
  const nextAttempt = status === "queued" ? now : null;
  const me = actorId(actor);

  const specs = result.recipients.map((entry) => ({
    oid: newId("msg"),
    rid: newId("crc"),
    dedupe: `campaign:${row.id}:${entry.recipient}`,
    recipient: entry.recipient,
    phone: entry.person.phone,
    customerId: entry.person.customerId,
    guestIds: entry.person.guestIds,
    locale: entry.person.locale,
    name: entry.firstName ?? NAME_FALLBACK[entry.person.locale],
  }));
  const skipped = result.noConsent.map((entry) => ({ rid: newId("crc"), recipient: entry.recipient, customerId: entry.person.customerId }));
  const guard = recipientGuard(now, row.id);
  const textExpr = (field: "body" | "subject") => {
    const source = field === "body" ? body : subject;
    if (!source) return sql`NULL`;
    return sql`replace(CASE json_extract(r.value, '$.locale') WHEN 'en' THEN ${source.en} WHEN 'ckb' THEN ${source.ckb} ELSE ${source.ar} END, '{name}', json_extract(r.value, '$.name'))`;
  };

  const chunks: (typeof specs)[] = [];
  for (let i = 0; i < specs.length; i += RELEASE_CHUNK) chunks.push(specs.slice(i, i + RELEASE_CHUNK));
  if (chunks.length === 0) chunks.push([]);
  try {
    for (let index = 0; index < chunks.length; index++) {
      const json = JSON.stringify(chunks[index]);
      const statements: BatchStatement[] = [];
      if (index === 0 && !resuming) {
        statements.push(
          db.update(campaigns).set({ status: "sending", updatedAt: Math.max(now, num(row.updated_at) + 1) }).where(sql`${campaigns.id} = ${row.id} AND ${campaigns.status} = 'scheduled' AND (${campaigns.scheduledAt} IS NULL OR ${campaigns.scheduledAt} <= ${now})`),
          expectChanged(db, 1, "CAMPAIGN_NOT_DUE"),
        );
      } else {
        statements.push(expectThat(db, sql`EXISTS (SELECT 1 FROM campaigns WHERE id = ${row.id} AND status = 'sending')`, "CAMPAIGN_CLOSED"));
      }
      if (chunks[index].length > 0) {
        statements.push(
          batchSql(
            db,
            sql`INSERT INTO outbox (id, channel, recipient, template, payload, status, attempts, created_at, locale, customer_id, ref_type, ref_id, dedupe_key, next_attempt_at)
              SELECT json_extract(r.value, '$.oid'), ${channel}, json_extract(r.value, '$.recipient'), ${CAMPAIGN_TEMPLATE},
                json_object('campaignId', ${row.id}, 'text', ${textExpr("body")}, 'subject', ${textExpr("subject")}),
                ${status}, 0, ${now}, json_extract(r.value, '$.locale'), json_extract(r.value, '$.customerId'), 'campaign', ${row.id}, json_extract(r.value, '$.dedupe'), ${nextAttempt}
              FROM json_each(${json}) AS r
              WHERE ${guard}
              ON CONFLICT DO NOTHING`,
          ),
          batchSql(
            db,
            sql`INSERT INTO campaign_recipients (id, campaign_id, customer_id, recipient, status, outbox_id)
              SELECT json_extract(r.value, '$.rid'), ${row.id}, json_extract(r.value, '$.customerId'), json_extract(r.value, '$.recipient'),
                CASE o.status WHEN 'queued' THEN 'pending' WHEN 'sent' THEN 'sent' ELSE 'held' END, o.id
              FROM json_each(${json}) AS r JOIN outbox o ON o.dedupe_key = json_extract(r.value, '$.dedupe')
              WHERE 1 = 1
              ON CONFLICT DO NOTHING`,
          ),
        );
      }
      if (index === chunks.length - 1 && skipped.length > 0) {
        for (let i = 0; i < skipped.length; i += RELEASE_CHUNK) {
          statements.push(
            batchSql(
              db,
              sql`INSERT INTO campaign_recipients (id, campaign_id, customer_id, recipient, status, outbox_id)
                SELECT json_extract(r.value, '$.rid'), ${row.id}, json_extract(r.value, '$.customerId'), json_extract(r.value, '$.recipient'), 'skipped_no_consent', NULL
                FROM json_each(${JSON.stringify(skipped.slice(i, i + RELEASE_CHUNK))}) AS r WHERE 1 = 1
                ON CONFLICT DO NOTHING`,
            ),
          );
        }
      }
      await runBatch(db, statements);
    }
  } catch (error) {
    if (!resuming && mapDbError(error)?.code === "CAMPAIGN_NOT_DUE") {
      // released by another request just before this write (a double click, the scheduled job): answer what it did
      const fresh = await campaignRow(db, row.id);
      if (fresh.status === "sending" || fresh.status === "sent" || fresh.status === "paused" || fresh.status === "completed") {
        return { ...(await recipientTotals(db, row.id)), excluded: { ...emptyExclusions(), ...(parseContent(fresh.content).release?.excluded ?? {}) }, replayed: true };
      }
      if (fresh.status === "cancelled") throw new AppError("campaign_closed", 409);
    }
    rethrowGuard(error);
  }
  const { held, skipped: skippedCount } = await recipientTotals(db, row.id);
  // who passed the count but was refused INSIDE the write (a "no", a closed account or the limit landed in between):
  // counted as "changed", so held + every reason = the people considered
  const written = specs.length === 0 ? 0 : num((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ${row.id} AND status <> 'skipped_no_consent' AND recipient IN (SELECT value FROM json_each(${JSON.stringify(specs.map((spec) => spec.recipient))}))`))[0]?.n);
  const excluded: ReleaseStats["excluded"] = { ...result.excluded, changed: Math.max(0, specs.length - written) };
  const stats: ReleaseStats = { at: now, by: me, held, skipped: skippedCount, excluded, candidates: result.candidates, complete: true };
  await runBatch(db, [
    // updated_at moves too: a form read before the release (a spend entry) must not write its copy of the content over the record
    db
      .update(campaigns)
      .set({ content: sql`json_set(COALESCE(${campaigns.content}, '{}'), '$.release', json(${JSON.stringify(stats)}))` as unknown as CampaignContent, updatedAt: sql`MAX(${now}, ${campaigns.updatedAt} + 1)` as unknown as number })
      .where(sql`${campaigns.id} = ${row.id}`),
    auditStatement(db, { actor, action: resuming ? "marketing.campaign.release_resume" : "marketing.campaign.release", entityType: "campaign", entityId: row.id, after: { held, skipped: skippedCount, excluded, outbox: status }, at: now }),
  ]);
  return { held, skipped: skippedCount, excluded, replayed: false };
}

/** What a campaign's recipient rows say now: messages held (or queued / sent), and people documented without consent. */
async function recipientTotals(db: Db, campaignId: string): Promise<{ held: number; skipped: number }> {
  const counts = await db.all<{ status: string; n: number }>(sql`SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ${campaignId} GROUP BY status`);
  return { held: counts.filter((entry) => entry.status !== "skipped_no_consent").reduce((sum, entry) => sum + num(entry.n), 0), skipped: num(counts.find((entry) => entry.status === "skipped_no_consent")?.n) };
}

// ───────────────────────────────────────────────────────────────── cancel, close

const CancelInput = z.object({ campaignId: z.string().regex(ID, "invalid"), reason: reason(3).refine((value) => value.length >= 3, "reason_required") });

/** Stops a campaign before it reached anyone (draft, waiting, approved). A waiting request is closed with it. */
export async function cancelCampaign(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ cancelled: true }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const input = CancelInput.parse(raw ?? {});
  const row = await campaignRow(db, input.campaignId);
  if (row.status !== "draft" && row.status !== "scheduled") throw new AppError("campaign_closed", 409);
  const me = actorId(actor);
  await runBatch(db, [
    db.update(campaigns).set({ status: "cancelled", updatedAt: Math.max(now, num(row.updated_at) + 1) }).where(sql`${campaigns.id} = ${row.id} AND ${campaigns.status} IN ('draft', 'scheduled')`),
    expectChanged(db, 1, "CAMPAIGN_CLOSED"),
    db.update(approvals).set({ status: "rejected", decidedBy: me, decidedAt: now, decisionNote: "cancelled" }).where(sql`${approvals.kind} = ${CAMPAIGN_APPROVAL_KIND} AND ${approvals.entityType} = 'campaign' AND ${approvals.entityId} = ${row.id} AND ${approvals.status} = 'pending'`),
    auditStatement(db, { actor, action: "marketing.campaign.cancel", entityType: "campaign", entityId: row.id, before: { status: row.status }, after: { status: "cancelled" }, reason: input.reason, at: now }),
  ]).catch((error) => rethrowGuard(error));
  return { cancelled: true };
}

const CloseInput = z.object({ campaignId: z.string().regex(ID, "invalid"), reason: reason(3) });

/** Ends a released or tracked campaign: its held messages stay in the outbox as the record (nothing is unsent). */
export async function closeCampaign(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ closed: true }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const input = CloseInput.parse(raw ?? {});
  const row = await campaignRow(db, input.campaignId);
  const allowed = row.status === "sending" || row.status === "sent" || row.status === "paused" || (row.status === "scheduled" && !isMessageChannel(row.channel));
  if (!allowed) throw new AppError("campaign_closed", 409);
  await runBatch(db, [
    db
      .update(campaigns)
      .set({ status: "completed", updatedAt: Math.max(now, num(row.updated_at) + 1), content: sql`json_set(COALESCE(${campaigns.content}, '{}'), '$.closedAt', ${now})` as unknown as CampaignContent })
      .where(sql`${campaigns.id} = ${row.id} AND ${campaigns.status} = ${row.status}`),
    expectChanged(db, 1, "CAMPAIGN_CLOSED"),
    auditStatement(db, { actor, action: "marketing.campaign.close", entityType: "campaign", entityId: row.id, before: { status: row.status }, after: { status: "completed" }, reason: input.reason || null, at: now }),
  ]).catch((error) => rethrowGuard(error));
  return { closed: true };
}

// ───────────────────────────────────────────────────────────────── spend (16.07)

const SpendInput = z.object({
  campaignId: z.string().regex(ID, "invalid"),
  period: z.preprocess((value) => normalizeMonth(value) ?? "", z.string().min(1, "period_invalid")),
  amountIqd: z.preprocess((value) => parseWhole(value, { negative: true }), z.number({ error: "number_invalid" }).int("number_invalid").refine((value) => value !== 0, "number_invalid").refine((value) => Math.abs(value) <= 1_000_000_000, "number_invalid")),
  reference: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().max(80, "too_long")),
  note: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, "reason_required").min(3, "too_short").max(300, "too_long")),
  idempotencyKey: z.string().min(16, "invalid").max(128, "invalid").regex(/^[A-Za-z0-9_-]+$/, "invalid"),
  expectedUpdatedAt: z.preprocess((value) => Number(value), z.number().int()),
});

/**
 * Records money really spent on a campaign in one month (an invoice, an ad account's bill). Entries are never edited:
 * a correction is a negative entry with its note, and a month's total never goes below zero. One key = one entry.
 */
export async function recordSpend(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ entryId: string; replayed: boolean; spendIqd: number }> {
  assertAny(actor, ["marketing.campaign.manage"]);
  const input = SpendInput.parse(raw ?? {});
  if (input.period > baghdadMonth(now)) throw invalid({ period: "period_future" });
  const row = await campaignRow(db, input.campaignId);
  const content = parseContent(row.content);
  const entryId = `spd_${(await sha256Hex(`tamtam.marketing.spend|${input.idempotencyKey}`)).slice(0, 24)}`;
  const entries = content.spend ?? [];
  /** The entry this key already made (a double click, a retry): the first result, or a mismatch. */
  const replayOf = (found: SpendEntry, spendIqd: number) => {
    if (found.amountIqd !== input.amountIqd || found.period !== input.period) throw new AppError("idempotency_mismatch", 409);
    return { entryId, replayed: true, spendIqd };
  };
  const existing = entries.find((entry) => entry.id === entryId);
  if (existing) return replayOf(existing, num(row.spend_iqd));
  if (num(row.updated_at) !== input.expectedUpdatedAt) throw new AppError("campaign_changed", 409);
  const monthTotal = entries.filter((entry) => entry.period === input.period).reduce((sum, entry) => sum + entry.amountIqd, 0);
  if (monthTotal + input.amountIqd < 0) throw invalid({ amountIqd: "spend_below_zero" });
  const entry: SpendEntry = { id: entryId, period: input.period, amountIqd: input.amountIqd, reference: input.reference || null, note: input.note, by: actorId(actor), at: now };
  const next: CampaignContent = { ...content, spend: [...entries, entry] };
  const spend = num(row.spend_iqd) + input.amountIqd;
  try {
    await runBatch(db, [
      db.update(campaigns).set({ content: next, spendIqd: spend, updatedAt: Math.max(now, num(row.updated_at) + 1) }).where(sql`${campaigns.id} = ${row.id} AND ${campaigns.updatedAt} = ${num(row.updated_at)}`),
      expectChanged(db, 1, "CAMPAIGN_CHANGED"),
      auditStatement(db, { actor, action: "marketing.spend.record", entityType: "campaign", entityId: row.id, after: { entryId, period: input.period, amountIqd: input.amountIqd, reference: entry.reference }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code === "CAMPAIGN_CHANGED") {
      // the same form sent twice at once: the other request wrote this very entry just before this write
      const fresh = await campaignRow(db, row.id);
      const done = parseContent(fresh.content).spend?.find((item) => item.id === entryId);
      if (done) return replayOf(done, num(fresh.spend_iqd));
    }
    rethrowGuard(error);
  }
  return { entryId, replayed: false, spendIqd: spend };
}

// ───────────────────────────────────────────────────────────────── queues

/** Campaign requests this employee may decide (marketing.campaign.send; never their own, never one they wrote); null without the permission. */
export async function countDecidableCampaigns(db: Db, actor: Actor): Promise<number | null> {
  if (!can(actor, "marketing.campaign.send")) return null;
  const me = actorId(actor) ?? "";
  const actions = JSON.stringify(SAVE_ACTIONS);
  const [row] = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM approvals a JOIN campaigns c ON c.id = a.entity_id
    WHERE a.kind = ${CAMPAIGN_APPROVAL_KIND} AND a.entity_type = 'campaign' AND a.status = 'pending' AND c.status = 'draft' AND c.is_demo = 0 AND a.requested_by <> ${me}
      AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_type = 'campaign' AND e.entity_id = c.id AND e.actor_kind = 'employee' AND e.actor_id = ${me} AND e.action IN (SELECT value FROM json_each(${actions})))`);
  return num(row?.n);
}

/** Approved campaigns whose time has come (for the release and the scheduled job). */
export async function dueCampaigns(db: Db, now: number): Promise<{ id: string; name: string; isDemo: boolean }[]> {
  const rows = await db.all<{ id: string; name: string; is_demo: number }>(sql`SELECT c.id, c.name, c.is_demo FROM campaigns c WHERE ${dueSql(now)} ORDER BY c.scheduled_at LIMIT 50`);
  return rows.map((row) => ({ id: row.id, name: row.name, isDemo: num(row.is_demo) === 1 }));
}

/** How many REAL campaigns are due now — the same rows as the list's "due" view (the front page's figure). */
export async function countDueCampaigns(db: Db, now: number): Promise<number> {
  const [row] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM campaigns c WHERE ${dueSql(now)} AND c.is_demo = 0`);
  return num(row?.n);
}

/**
 * For the scheduled job (requested of the jobs owner): releases every approved campaign whose time has come, as the
 * system. Each campaign on its own — one that fails does not stop the others.
 */
export async function releaseDueCampaigns(db: Db, actor: Actor, now: number, origin: string): Promise<{ released: number; failed: number }> {
  assertAny(actor, ["marketing.campaign.send"]);
  let released = 0;
  let failed = 0;
  for (const campaign of await dueCampaigns(db, now)) {
    try {
      await releaseCampaign(db, actor, { campaignId: campaign.id }, now, origin);
      released++;
    } catch {
      failed++;
    }
  }
  return { released, failed };
}
