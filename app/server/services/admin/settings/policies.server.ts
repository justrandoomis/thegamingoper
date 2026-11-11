/**
 * Admin 22.02 — tax and shipping settings and the warranty and return policies, in one place.
 *
 *   · Shipping: the flat fee and the per-governorate switch are module 11's (/admin/shipping/zones shows the impact of
 *     a change before it is made); they are shown here with a link. Tax rates are module 10's (/admin/finance/tax):
 *     checkout adds no tax today (an owner decision). The return window and the trade-in validity are settings keys,
 *     changed on the settings pages. Return eligibility per category is module 12's (/admin/returns/policies).
 *   · Policy texts (returns, warranty): the storefront serves an APPROVED CMS row — a `pages` row of kind "policy",
 *     published, not demo, with Arabic blocks (docs/areas/content.md) — and until then the code's draft, marked as
 *     awaiting the owner. Here the owner starts a draft from the code's text (today's settings filled in), edits it as
 *     lines (policy-text.ts), and approves it, which publishes it (cms.page.manage to edit, cms.page.publish to approve
 *     or withdraw it). Withdrawing (archive) brings the code's draft back. Every step is guarded on the row's
 *     `updated_at` the editor saw and audited.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { POLICY_SLUGS, type PolicySlug } from "~/routes/storefront/content/content-model";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import type { LocalizedBlocks, StoredBlock } from "~/server/db/columns";
import { pages } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { getPolicyDraftL10n, listPolicies } from "~/server/services/content.server";
import { getShippingPolicy } from "~/server/services/shipping/fees.server";
import { getSettings } from "~/server/settings.server";
import { isEditablePolicy, type EditablePolicy } from "./catalog";
import { blocksToText, textToBlocks, type PolicyBlock } from "./policy-text";
import { taxSummary, type TaxSummary } from "./system.server";

type StoreMode = "demo" | "live";

export type PolicyRowState = { status: string; publishedAt: number | null; updatedAt: number; hasDraft: boolean; isDemo: boolean } | null;
export type PolicyListItem = { slug: PolicySlug; title: string; approved: boolean; editable: boolean; row: PolicyRowState };

export type PoliciesView = {
  shipping: { flatFeeIqd: number; overridesEnabled: boolean };
  values: { returnDays: number; tradeInDays: number; proofHours: number };
  tax: TaxSummary;
  /** Published hardware and accessories without a store warranty decided (products.warranty_months empty). */
  warrantyUndecided: number;
  policies: PolicyListItem[];
  can: { edit: boolean; publish: boolean };
};

async function pageOf(db: Db, slug: string) {
  return db.select().from(pages).where(and(eq(pages.kind, "policy"), eq(pages.slug, slug))).get();
}

export async function policiesView(db: Db, actor: Actor, locale: Locale, now: number): Promise<PoliciesView> {
  assertCan(actor, "settings.read");
  const [shipping, values, tax, warranty, summaries, rows] = await Promise.all([
    getShippingPolicy(db),
    getSettings(db, ["returns.window_days", "tradein.estimate_valid_days", "checkout.transfer_proof_hours"]),
    taxSummary(db, actor, locale),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM products WHERE status = 'published' AND kind IN ('console', 'controller', 'headset', 'storage', 'accessory', 'part') AND warranty_months IS NULL`),
    listPolicies(db, locale, { now }),
    db.select({ slug: pages.slug, status: pages.status, publishedAt: pages.publishedAt, updatedAt: pages.updatedAt, draft: pages.draft, isDemo: pages.isDemo }).from(pages).where(eq(pages.kind, "policy")),
  ]);
  return {
    shipping: { flatFeeIqd: shipping.flatFeeIqd, overridesEnabled: shipping.overridesEnabled },
    values: { returnDays: values["returns.window_days"], tradeInDays: values["tradein.estimate_valid_days"], proofHours: values["checkout.transfer_proof_hours"] },
    tax,
    warrantyUndecided: Number(warranty[0]?.n ?? 0),
    policies: POLICY_SLUGS.map((slug) => {
      const summary = summaries.find((entry) => entry.slug === slug);
      const row = rows.find((entry) => entry.slug === slug);
      return {
        slug,
        title: summary?.title ?? slug,
        approved: summary?.approved ?? false,
        editable: isEditablePolicy(slug),
        row: row ? { status: row.status, publishedAt: row.publishedAt, updatedAt: row.updatedAt, hasDraft: Boolean(row.draft), isDemo: row.isDemo } : null,
      };
    }),
    can: { edit: can(actor, "cms.page.manage"), publish: can(actor, "cms.page.publish") },
  };
}

export type PolicyEditor = {
  slug: EditablePolicy;
  title: string;
  row: PolicyRowState;
  /** What the editor shows: the stored draft, else the published text, else nothing (start from the code's draft). */
  source: "draft" | "published" | "none";
  text: Record<Locale, string>;
  /** The text in force on the storefront now, as blocks of the editor's language (CMS or the code's draft). */
  live: { approved: boolean; blocks: PolicyBlock[] };
  version: number | null;
  can: { edit: boolean; publish: boolean };
};

const blocksOf = (value: unknown): StoredBlock[] => (Array.isArray(value) ? (value as StoredBlock[]) : []);

export async function getPolicyEditor(db: Db, actor: Actor, slug: string, locale: Locale, now: number, storeMode: StoreMode): Promise<PolicyEditor> {
  assertCan(actor, "settings.read");
  if (!isEditablePolicy(slug)) throw notFound("policy");
  const [row, draft, summaries] = await Promise.all([pageOf(db, slug), getPolicyDraftL10n(db, slug, { storeMode }), listPolicies(db, locale, { now })]);
  const approved = summaries.find((entry) => entry.slug === slug)?.approved ?? false;
  const stored = (row?.draft ?? (row?.status === "published" ? row?.body : null)) as LocalizedBlocks | null;
  const text = { ar: "", en: "", ckb: "" } as Record<Locale, string>;
  for (const code of ["ar", "en", "ckb"] as const) text[code] = stored ? blocksToText(blocksOf(stored[code])) : "";
  const liveBlocks = approved && row?.body ? blocksOf((row.body as LocalizedBlocks)[locale] ?? (row.body as LocalizedBlocks).ar) : blocksOf(draft.body[locale]);
  return {
    slug,
    title: draft.title[locale] ?? draft.title.ar,
    row: row ? { status: row.status, publishedAt: row.publishedAt, updatedAt: row.updatedAt, hasDraft: Boolean(row.draft), isDemo: row.isDemo } : null,
    source: row?.draft ? "draft" : row?.status === "published" ? "published" : "none",
    text,
    live: { approved, blocks: liveBlocks as PolicyBlock[] },
    version: row?.updatedAt ?? null,
    can: { edit: can(actor, "cms.page.manage"), publish: can(actor, "cms.page.publish") },
  };
}

const Reason = z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long");
const Version = z.preprocess((value) => (value === "" || value === null || value === undefined ? null : Number(value)), z.number().int().nullable());

const StartInput = z.object({ slug: z.string(), reason: Reason, version: Version });

/** Copies the code's current draft (today's settings filled in, ar/en/ckb) into the CMS row's draft. */
export async function startPolicyDraft(db: Db, actor: Actor, raw: unknown, now: number, storeMode: StoreMode): Promise<{ created: boolean }> {
  assertCan(actor, "cms.page.manage");
  const input = StartInput.parse(raw);
  if (!isEditablePolicy(input.slug)) throw new AppError("policy_not_editable", 409);
  const row = await pageOf(db, input.slug);
  if ((row?.updatedAt ?? null) !== input.version) throw new AppError("policy_changed", 409);
  const draft = await getPolicyDraftL10n(db, input.slug, { storeMode });
  const body: LocalizedBlocks = { ar: draft.body.ar as StoredBlock[], en: draft.body.en as StoredBlock[], ckb: draft.body.ckb as StoredBlock[] };
  const updatedBy = actor.kind === "employee" ? actor.id : null;
  const audit = auditStatement(db, { actor, action: "settings.policy.start", entityType: "policy", entityId: input.slug, after: { blocks: body.ar.length, from: "code_draft" }, reason: input.reason, at: now });
  if (!row) {
    await runBatch(db, [db.insert(pages).values({ id: newId("pag"), slug: input.slug, kind: "policy", title: draft.title, draft: body, status: "draft", isDemo: false, updatedBy, createdAt: now, updatedAt: now }), audit]).catch((error) => {
      if (mapDbError(error)?.kind === "unique") throw new AppError("policy_changed", 409);
      throw error;
    });
    return { created: true };
  }
  await guardedUpdate(db, row.id, row.updatedAt, { draft: body, title: draft.title, updatedBy, updatedAt: now }, audit);
  return { created: false };
}

async function guardedUpdate(db: Db, id: string, version: number, set: Partial<typeof pages.$inferInsert>, audit: ReturnType<typeof auditStatement>): Promise<void> {
  try {
    await runBatch(db, [db.update(pages).set(set).where(and(eq(pages.id, id), eq(pages.updatedAt, version))), expectChanged(db, 1, { code: "POLICY_CHANGED", detail: id }), audit]);
  } catch (error) {
    if (mapDbError(error)?.code === "POLICY_CHANGED") throw new AppError("policy_changed", 409);
    throw error;
  }
}

const SaveInput = z.object({
  slug: z.string(),
  version: z.coerce.number().int(),
  textAr: z.string().max(20_000, "too_long"),
  textEn: z.string().max(20_000, "too_long").optional(),
  textCkb: z.string().max(20_000, "too_long").optional(),
});

/** Saves the edited text as the draft (the storefront keeps serving what is in force until it is approved). */
export async function savePolicyDraft(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ blocks: number }> {
  assertCan(actor, "cms.page.manage");
  const input = SaveInput.parse(raw);
  if (!isEditablePolicy(input.slug)) throw new AppError("policy_not_editable", 409);
  const row = await pageOf(db, input.slug);
  if (!row) throw new AppError("policy_no_draft", 409);
  if (row.updatedAt !== input.version) throw new AppError("policy_changed", 409);
  const ar = textToBlocks(input.textAr);
  if (ar.length === 0) throw invalid({ textAr: "policy_empty" });
  const en = textToBlocks(input.textEn ?? "");
  const ckb = textToBlocks(input.textCkb ?? "");
  const draft: LocalizedBlocks = { ar: ar as StoredBlock[], ...(en.length ? { en: en as StoredBlock[] } : {}), ...(ckb.length ? { ckb: ckb as StoredBlock[] } : {}) };
  const before = row.draft as LocalizedBlocks | null;
  await guardedUpdate(
    db,
    row.id,
    row.updatedAt,
    { draft, updatedBy: actor.kind === "employee" ? actor.id : null, updatedAt: now },
    auditStatement(db, { actor, action: "settings.policy.save", entityType: "policy", entityId: input.slug, before: { blocks: before?.ar?.length ?? 0 }, after: { blocks: ar.length, en: en.length, ckb: ckb.length }, at: now }),
  );
  return { blocks: ar.length };
}

const PublishInput = z.object({ slug: z.string(), version: z.coerce.number().int(), reason: Reason });

/** Approves the draft: it becomes the published text the storefront serves (source "cms", approved). */
export async function publishPolicy(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ published: true }> {
  assertCan(actor, "cms.page.publish");
  const input = PublishInput.parse(raw);
  if (!isEditablePolicy(input.slug)) throw new AppError("policy_not_editable", 409);
  const row = await pageOf(db, input.slug);
  if (!row?.draft) throw new AppError("policy_no_draft", 409);
  if (row.updatedAt !== input.version) throw new AppError("policy_changed", 409);
  const draft = row.draft as LocalizedBlocks;
  if (!Array.isArray(draft.ar) || draft.ar.length === 0) throw new AppError("policy_empty", 409);
  await guardedUpdate(
    db,
    row.id,
    row.updatedAt,
    { body: draft, draft: null, status: "published", publishedAt: now, startsAt: null, endsAt: null, isDemo: false, updatedBy: actor.kind === "employee" ? actor.id : null, updatedAt: now },
    auditStatement(db, { actor, action: "settings.policy.publish", entityType: "policy", entityId: input.slug, before: { status: row.status, blocks: (row.body as LocalizedBlocks | null)?.ar?.length ?? 0 }, after: { status: "published", blocks: draft.ar.length }, reason: input.reason, at: now }),
  );
  return { published: true };
}

/** Withdraws the approved text: the storefront serves the code's draft again (marked as awaiting the owner). */
export async function archivePolicy(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ archived: true }> {
  assertCan(actor, "cms.page.publish");
  const input = PublishInput.parse(raw);
  if (!isEditablePolicy(input.slug)) throw new AppError("policy_not_editable", 409);
  const row = await pageOf(db, input.slug);
  if (!row || row.status !== "published") throw new AppError("policy_changed", 409);
  if (row.updatedAt !== input.version) throw new AppError("policy_changed", 409);
  await guardedUpdate(
    db,
    row.id,
    row.updatedAt,
    { status: "archived", updatedBy: actor.kind === "employee" ? actor.id : null, updatedAt: now },
    auditStatement(db, { actor, action: "settings.policy.archive", entityType: "policy", entityId: input.slug, before: { status: "published" }, after: { status: "archived" }, reason: input.reason, at: now }),
  );
  return { archived: true };
}

