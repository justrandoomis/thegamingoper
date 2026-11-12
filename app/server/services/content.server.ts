/**
 * Content service — the store's own pages (docs/CONTRACTS.md §3, area "content"):
 *
 *   const policy = await getPolicy(db, ctx.locale, "returns", { now: ctx.now, storeMode: ctx.storeMode });
 *   const list = await listPolicies(db, ctx.locale, { now: ctx.now });
 *   const contact = await getContactDetails(db, ctx.locale);          // only what the owner filled in
 *   const facts = await getStoreFacts(db, ctx.locale);                 // fee, payment switches (about page)
 *   const entries = await getSitemapEntries(db, ctx.now);              // /sitemap.xml
 *   buildSitemapXml(entries, origin) · buildRobotsTxt({ indexable, origin })
 *
 * POLICIES ARE CMS CONTENT. The store owner writes and approves them in the admin (module 17, `pages` with
 * kind "policy"; docs/areas/content.md says how). A policy is APPROVED when its `pages` row is published (or
 * scheduled and due), inside its starts_at/ends_at window, not demo data, and has readable Arabic blocks. Until
 * then the service falls back to a DRAFT written in code: the strings live in app/i18n/messages/content.ts
 * (`drafts.*`, ar/en/ckb) and are filled with the store's LIVE settings and rules on every read — the flat fee and
 * the governorates delivered to (or the per-governorate fees once overrides are on), the return window, the transfer
 * proof window, the payment methods that are switched on with their card / Zain Cash numbers, the trade-in estimate
 * validity, the cookies the code really sets and the retention windows the daily job really applies. Whatever the
 * owner has not decided (return conditions, the store's own warranty, legal clauses, order-record retention) is
 * said to be not decided yet, never guessed. The `approved` flag on the result is what the page's status line reads
 * («نسخة أولى — قد تتغيّر قبل الإطلاق.» for a draft, Design System v2 §6.15); drafts are also noindex and left out of
 * the sitemap. A draft's «آخر تحديث» is the later of POLICY_DRAFTS_REVISED_AT and the last change to a setting it quotes.
 *
 * Reads only. Services take `db` first and never import "cloudflare:workers" (the routes pass origin and mode).
 */
import { inArray, sql } from "drizzle-orm";
import { messagesFor, serverT, type I18nPayload } from "~/i18n/i18n.server";
import type { MessageTree, TFunction } from "~/i18n/translate";
import { DEFAULT_LOCALE, LOCALE_CODES, LOCALES, localePath, pick, type L10n, type Locale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import { formatIraqPhone, normalizeIraqPhone } from "~/lib/phone";
import { PREFS_COOKIE } from "~/lib/prefs";
import { POLICY_ICONS, POLICY_SLUGS, isPolicySlug, type ContactChannel, type ContactView, type CmsText, type PaymentMethodKey, type PolicyFact, type PolicySlug, type PolicySummary, type PolicyView, type StoreFactsView } from "~/routes/storefront/content/content-model";
import { CUSTOMER_COOKIE, CUSTOMER_SESSION_DAYS } from "~/server/auth/customer.server";
import type { Db } from "~/server/db/drizzle.server";
import { settings as settingsTable, type PageKind } from "~/server/db/schema";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { RETENTION_DAYS } from "~/server/jobs.server";
import { getSetting, getSettings, type SettingKey, type SettingValue } from "~/server/settings.server";
import { CART_COOKIE_MAX_AGE_SEC } from "~/server/services/cart.server";
import { getShippingFee, listGovernorates } from "~/server/services/shipping/fees.server";
import { CART_COOKIE } from "~/server/shell.server";
import { parseBlocks, type Block } from "~/ui/Blocks";

export { POLICY_SLUGS, isPolicySlug, type PolicySlug, type PolicyView, type PolicySummary, type ContactView } from "~/routes/storefront/content/content-model";

type StoreMode = "demo" | "live";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Lifetime of the `tt_prefs` cookie: ONE_YEAR in app/lib/prefs.tsx (not exported there). */
const PREFS_COOKIE_DAYS = 365;

/**
 * When the drafts' wording (`drafts.*` in app/i18n/messages/content.ts) or a constant they quote (cookies, retention
 * windows) last changed: a draft's «آخر تحديث» is never earlier. Move it forward whenever a draft's text changes.
 */
export const POLICY_DRAFTS_REVISED_AT = Date.UTC(2026, 10, 12);

/** The settings each draft quotes: a change to one of them is a change to that policy's text. */
const DRAFT_SETTINGS: Record<PolicySlug, readonly SettingKey[]> = {
  shipping: ["shipping.flat_fee_iqd", "shipping.overrides_enabled", "payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash"],
  returns: ["returns.window_days", "payments.bank_transfer", "payments.zaincash", "checkout.transfer_proof_hours"],
  warranty: [],
  payment: ["payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash", "checkout.transfer_proof_hours"],
  privacy: [],
  terms: ["shipping.flat_fee_iqd", "shipping.overrides_enabled", "payments.wallet", "payments.bank_transfer", "payments.zaincash", "checkout.transfer_proof_hours", "tradein.estimate_valid_days"],
};

// ───────────────────────────────────────────────────────────────── strings

/**
 * The "content" namespace for the browser: everything but `drafts` (the policy drafts are built into blocks on the
 * server, so their dictionary never travels). Use it in loaders instead of messagesFor(locale, "content").
 */
export function contentMessages(locale: Locale): I18nPayload {
  const tree = messagesFor(locale, "content").content as MessageTree;
  const pageCopy: MessageTree = {};
  for (const [key, value] of Object.entries(tree)) if (key !== "drafts") pageCopy[key] = value;
  return { content: pageCopy };
}

/** U+2068 … U+2069: a value inside Arabic or Kurdish text keeps its own direction (DESIGN.md §13). */
const isolate = (text: string) => `⁨${text}⁩`;
/** U+2066 … U+2069: numbers, codes and names that must read left to right (phone and card numbers, cookie names). */
const ltr = (text: string) => `⁦${text}⁩`;

// ───────────────────────────────────────────────────────────────── store facts (settings)

const FACT_SETTINGS = [
  "shipping.flat_fee_iqd",
  "shipping.overrides_enabled",
  "payments.cod",
  "payments.wallet",
  "payments.bank_transfer",
  "payments.zaincash",
  "checkout.transfer_proof_hours",
  "returns.window_days",
  "tradein.estimate_valid_days",
] as const;

type StoreFacts = {
  feeIqd: number;
  overridesEnabled: boolean;
  methods: PaymentMethodKey[];
  card: { number: string; name: string } | null;
  /** Zain Cash number as shoppers dial it, formatted "0771 906 1852". */
  zaincash: string | null;
  proofHours: number;
  returnDays: number;
  estimateDays: number;
};

async function readStoreFacts(db: Db): Promise<StoreFacts> {
  const s = await getSettings(db, FACT_SETTINGS);
  const card = s["payments.bank_transfer"];
  const zain = s["payments.zaincash"];
  const zainE164 = zain.enabled ? normalizeIraqPhone(zain.number) : null;
  const methods: PaymentMethodKey[] = [];
  if (s["payments.cod"].enabled) methods.push("cod");
  if (s["payments.wallet"].enabled) methods.push("wallet");
  if (card.enabled) methods.push("card");
  if (zainE164) methods.push("zaincash");
  return {
    feeIqd: s["shipping.flat_fee_iqd"],
    overridesEnabled: s["shipping.overrides_enabled"],
    methods,
    card: card.enabled ? { number: card.account_number, name: card.recipient_name } : null,
    zaincash: zainE164 ? formatIraqPhone(zainE164) : null,
    proofHours: s["checkout.transfer_proof_hours"],
    returnDays: s["returns.window_days"],
    estimateDays: s["tradein.estimate_valid_days"],
  };
}

const hasTransfers = (facts: Pick<StoreFacts, "methods">) => facts.methods.includes("card") || facts.methods.includes("zaincash");

/** `total`: every governorate the store knows (active or paused), so a pause can be said without a count. */
type Coverage = { rows: { name: string; feeIqd: number }[]; varies: boolean; total: number };

/**
 * The governorates delivered to and what each pays — from the commerce core (listGovernorates / getShippingFee), so
 * the policy can never disagree with checkout. Per-governorate fees are only looked up while an admin has switched
 * overrides on; otherwise every active governorate pays the flat fee.
 */
async function readCoverage(db: Db, locale: Locale, facts: StoreFacts): Promise<Coverage> {
  const [governorates, counted] = await Promise.all([listGovernorates(db, locale), db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM governorates`)]);
  const total = Math.max(Number(counted[0]?.n ?? 0), governorates.length);
  if (!facts.overridesEnabled) return { rows: governorates.map((g) => ({ name: g.name, feeIqd: facts.feeIqd })), varies: false, total };
  const fees = await Promise.all(governorates.map((g) => getShippingFee(db, g.id)));
  const rows = governorates.map((g, i) => ({ name: g.name, feeIqd: fees[i] }));
  return { rows, varies: rows.some((row) => row.feeIqd !== facts.feeIqd), total };
}

/**
 * «آخر تحديث» of a draft: the drafts' last revision in code, or the last change to a setting that draft quotes (and,
 * for the delivery policy and the terms while per-governorate fees are on, to an override fee) — whichever is later.
 * Governorates carry no change time, so pausing one does not move the date (the text still changes at once).
 */
async function draftUpdatedAt(db: Db, slug: PolicySlug, facts: StoreFacts): Promise<number> {
  const keys = DRAFT_SETTINGS[slug];
  const overrides = facts.overridesEnabled && (slug === "shipping" || slug === "terms");
  const [settingRows, rateRows] = await Promise.all([
    keys.length > 0 ? db.select({ at: sql<number | null>`MAX(${settingsTable.updatedAt})` }).from(settingsTable).where(inArray(settingsTable.key, [...keys])) : Promise.resolve([]),
    overrides ? db.all<{ at: number | null }>(sql`SELECT MAX(updated_at) AS at FROM shipping_rates WHERE is_override = 1`) : Promise.resolve([]),
  ]);
  const times = [POLICY_DRAFTS_REVISED_AT, Number(settingRows[0]?.at ?? 0), Number(rateRows[0]?.at ?? 0)].filter((at) => Number.isFinite(at));
  return Math.max(...times);
}

/** What the about page states about how the store works, from its settings. */
export async function getStoreFacts(db: Db, locale: Locale): Promise<StoreFactsView> {
  const facts = await readStoreFacts(db);
  const coverage = facts.overridesEnabled ? await readCoverage(db, locale, facts) : null;
  return { deliveryFeeIqd: facts.feeIqd, deliveryVaries: coverage?.varies ?? false, payments: facts.methods, transfersChecked: hasTransfers(facts) };
}

// ───────────────────────────────────────────────────────────────── CMS pages

type PageRow = {
  slug: string;
  title: string | null;
  body: string | null;
  seo: string | null;
  status: string;
  starts_at: number | null;
  ends_at: number | null;
  published_at: number | null;
  updated_at: number;
};

const PAGE_COLUMNS = sql`slug, title, body, seo, status, starts_at, ends_at, published_at, updated_at`;

function parseJson<T>(text: string | null | undefined): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Published (or scheduled and due) and inside its window. Demo rows are never selected (see the queries). */
function isLive(row: Pick<PageRow, "status" | "starts_at" | "ends_at">, now: number): boolean {
  const due = row.status === "published" || (row.status === "scheduled" && row.starts_at !== null && row.starts_at <= now);
  return due && (row.starts_at === null || row.starts_at <= now) && (row.ends_at === null || row.ends_at > now);
}

type ResolvedPage = { title: string; summary: string; blocks: Block[]; textLocale: Locale; updatedAt: number; noindex: boolean };

/**
 * The text of a live CMS page in `locale`, falling back to Arabic (the source language) when that locale has no
 * readable blocks. Null when the Arabic blocks are missing or malformed: Arabic is the source every page must have,
 * and whether a policy counts as approved must not depend on the visitor's language.
 */
function resolvePage(row: PageRow, locale: Locale, now: number): ResolvedPage | null {
  if (!isLive(row, now)) return null;
  const body = parseJson<Partial<Record<Locale, unknown>>>(row.body);
  const source = parseBlocks(body?.[DEFAULT_LOCALE]);
  if (source.length === 0) return null;
  const own = locale === DEFAULT_LOCALE ? source : parseBlocks(body?.[locale]);
  const textLocale: Locale = own.length > 0 ? locale : DEFAULT_LOCALE;
  const blocks = own.length > 0 ? own : source;
  const title = parseJson<L10n>(row.title);
  const seo = parseJson<{ description?: L10n; noindex?: boolean }>(row.seo);
  const titleText = title ? pick(title, textLocale).trim() : "";
  if (titleText === "") return null;
  return {
    title: titleText,
    summary: seo?.description ? pick(seo.description, locale).trim() : "",
    blocks,
    textLocale,
    updatedAt: row.published_at ?? row.updated_at,
    noindex: seo?.noindex === true,
  };
}

async function readLivePage(db: Db, kind: PageKind, slug: string, locale: Locale, now: number): Promise<ResolvedPage | null> {
  const rows = await db.all<PageRow>(
    sql`SELECT ${PAGE_COLUMNS} FROM pages WHERE kind = ${kind} AND slug = ${slug} AND is_demo = 0 AND status IN ('published', 'scheduled') LIMIT 1`,
  );
  return rows[0] ? resolvePage(rows[0], locale, now) : null;
}

/**
 * Text of a published CMS page of kind "about" or "contact" (slug "about" / "contact"), or null while there is none.
 * The about page shows it in place of its own description; the contact page above the contact details.
 */
export async function getCmsText(db: Db, locale: Locale, kind: "about" | "contact", options: { now?: number } = {}): Promise<CmsText | null> {
  const page = await readLivePage(db, kind, kind, locale, options.now ?? Date.now());
  return page ? { title: page.title, blocks: page.blocks, textLocale: page.textLocale, updatedAt: page.updatedAt } : null;
}

// ───────────────────────────────────────────────────────────────── policies

export type PolicyOptions = { now?: number; storeMode?: StoreMode };

/**
 * One policy in `locale`: the approved CMS page when there is one, else (for the six known slugs) the code draft
 * filled with the store's live settings. Null for a slug that is neither — the route answers 404.
 */
export async function getPolicy(db: Db, locale: Locale, slug: string, options: PolicyOptions = {}): Promise<PolicyView | null> {
  if (typeof slug !== "string" || slug.length > 80 || !SLUG_RE.test(slug)) return null;
  const now = options.now ?? Date.now();
  const known = isPolicySlug(slug);
  const [cms, facts] = await Promise.all([readLivePage(db, "policy", slug, locale, now), known ? readStoreFacts(db) : Promise.resolve(null)]);
  if (!cms && !known) return null;

  // Coverage (governorates and their fees) is read for the delivery policy, and for the terms only when per-governorate
  // fees could change their wording.
  const coverage = known && facts && (slug === "shipping" || (slug === "terms" && facts.overridesEnabled)) ? await readCoverage(db, locale, facts) : null;
  const factsList = known && facts ? policyFacts(slug, facts, coverage) : [];
  const t = serverT(locale, "content");

  if (cms) {
    return {
      slug,
      title: cms.title,
      summary: cms.summary || (known ? t(`drafts.${slug}.summary`) : ""),
      blocks: cms.blocks,
      source: "cms",
      approved: true,
      textLocale: cms.textLocale,
      updatedAt: cms.updatedAt,
      facts: factsList,
      noindex: cms.noindex,
    };
  }
  const draftSlug = slug as PolicySlug;
  return {
    slug,
    title: t(`drafts.${draftSlug}.title`),
    summary: t(`drafts.${draftSlug}.summary`),
    blocks: buildPolicyDraft(draftSlug, { t, locale, facts: facts!, coverage, storeMode: options.storeMode ?? "demo" }),
    source: "draft",
    approved: false,
    textLocale: locale,
    updatedAt: await draftUpdatedAt(db, draftSlug, facts!),
    facts: factsList,
    noindex: true,
  };
}

/**
 * Every policy for the index and the "other policies" list: the six known ones in POLICY_SLUGS order (approved
 * CMS title, else the draft's), then any other published CMS policy the owner added, by slug.
 */
export async function listPolicies(db: Db, locale: Locale, options: { now?: number } = {}): Promise<PolicySummary[]> {
  const now = options.now ?? Date.now();
  const rows = await db.all<PageRow>(sql`SELECT ${PAGE_COLUMNS} FROM pages WHERE kind = 'policy' AND is_demo = 0 AND status IN ('published', 'scheduled') ORDER BY slug`);
  const live = new Map<string, ResolvedPage>();
  for (const row of rows) {
    if (!SLUG_RE.test(row.slug)) continue;
    const page = resolvePage(row, locale, now);
    if (page) live.set(row.slug, page);
  }
  const t = serverT(locale, "content");
  const known: PolicySummary[] = POLICY_SLUGS.map((slug) => {
    const page = live.get(slug);
    return {
      slug,
      title: page?.title ?? t(`drafts.${slug}.title`),
      summary: page?.summary || t(`drafts.${slug}.summary`),
      approved: Boolean(page),
      icon: POLICY_ICONS[slug],
    };
  });
  const extra: PolicySummary[] = [...live.entries()]
    .filter(([slug]) => !isPolicySlug(slug))
    .map(([slug, page]) => ({ slug, title: page.title, summary: page.summary, approved: true, icon: "file-text" as const }));
  return [...known, ...extra];
}

function policyFacts(slug: PolicySlug, facts: StoreFacts, coverage: Coverage | null): PolicyFact[] {
  const transfers = hasTransfers(facts);
  switch (slug) {
    case "shipping": {
      const served = coverage?.rows.length ?? 0;
      const total = coverage?.total ?? 0;
      return [
        { kind: "delivery_fee", amountIqd: facts.feeIqd, varies: coverage?.varies ?? false },
        ...(served < total || served === 0 ? [{ kind: "coverage_paused", all: served === 0 } as const] : []),
        { kind: "track" },
      ];
    }
    case "returns":
      return [{ kind: "return_window", days: facts.returnDays }];
    case "warranty":
      // facts or a question, never an invented term (v2 §9.6, §13 #4): where the maker's warranty is written when it is
      // known, where a used unit's is, then «اسألنا» for the store's own (its terms are the owner's to set)
      return [{ kind: "maker_warranty" }, { kind: "used_warranty" }, { kind: "store_warranty_pending" }];
    case "payment":
      return [
        { kind: "payment_methods", methods: facts.methods },
        ...(transfers ? ([{ kind: "proof_window", hours: facts.proofHours }, { kind: "transfers_checked" }] as const) : []),
      ];
    case "privacy":
      return [{ kind: "no_tracking" }, { kind: "proofs_private" }];
    case "terms":
      return [{ kind: "guest_checkout" }, { kind: "estimate_valid", days: facts.estimateDays }];
  }
}

// ───────────────────────────────────────────────────────────────── the drafts

type DraftEnv = { t: TFunction; locale: Locale; facts: StoreFacts; coverage: Coverage | null; storeMode: StoreMode };

const h2 = (text: string): Block => ({ type: "h2", text });
const p = (text: string): Block => ({ type: "p", text });
const ul = (items: string[]): Block => ({ type: "ul", items });
const steps = (items: Array<{ title: string; text?: string }>): Block => ({ type: "steps", items });
const callout = (tone: "info" | "warning" | "danger", title: string, text: string): Block => ({ type: "callout", tone, title, text });
const table = (head: string[], rows: string[][]): Block => ({ type: "table", head, rows });

/**
 * A policy draft as blocks, in one language. The same code path builds every language, so the three drafts always
 * have the same structure (tests/content.test.ts checks it); what changes a draft is the store's settings.
 */
export function buildPolicyDraft(slug: PolicySlug, env: DraftEnv): Block[] {
  const { t, locale, facts } = env;
  const k = (key: string, vars?: Record<string, string | number>) => t(`drafts.${slug}.${key}`, vars);
  const money = (iqd: number) => isolate(formatMoney(iqd, "IQD", locale, "latn"));
  const days = (count: number) => isolate(t("units.days", { count }));
  const hours = (count: number) => isolate(t("units.hours", { count }));
  const transfers = hasTransfers(facts);
  const out: Block[] = [];

  switch (slug) {
    case "shipping": {
      const rows = env.coverage?.rows ?? [];
      const varies = env.coverage?.varies ?? false;
      out.push(h2(k("feeTitle")), p(varies ? k("feeVaries") : k("feeFlat", { fee: money(facts.feeIqd) })));
      out.push(h2(k("areaTitle")));
      if (rows.length === 0) {
        out.push(p(k("areaNone")));
      } else {
        // the governorates by name, without a count: how many there are is the owner's to say (v2 §13 #6)
        out.push(p(k("areaText")));
        // One fee everywhere: the names as one line of text (19 short names read better than a 19-row list on a
        // phone). Different fees: a table, so every governorate's fee is next to its name.
        out.push(varies ? table([k("tableGovernorate"), k("tableFee")], rows.map((row) => [row.name, money(row.feeIqd)])) : p(rows.map((row) => row.name).join(t("common.listSeparator"))));
        out.push(p(k("areaPause")));
      }
      out.push(h2(k("needsTitle")), ul([k("needsPhone"), k("needsArea"), k("needsAddress"), k("needsOptional")]), p(k("needsGuest")));
      out.push(h2(k("timeTitle")), p(k("timeText")));
      const confirm = [
        ...(facts.methods.includes("cod") ? [k("confirmCod")] : []),
        ...(transfers ? [k("confirmTransfer")] : []),
        ...(facts.methods.includes("wallet") ? [k("confirmWallet")] : []),
      ];
      if (confirm.length > 0) out.push(h2(k("confirmTitle")), ul(confirm));
      out.push(h2(k("trackTitle")), p(k("trackText")), p(k("trackNoSms")));
      out.push(h2(k("failTitle")), p(k("failText")));
      break;
    }
    case "returns": {
      out.push(h2(k("windowTitle")), p(facts.returnDays > 0 ? k("windowText", { days: days(facts.returnDays) }) : k("windowNone")));
      out.push(
        h2(k("howTitle")),
        steps([
          { title: k("how1Title"), text: k("how1Text") },
          { title: k("how2Title"), text: k("how2Text") },
          { title: k("how3Title"), text: k("how3Text") },
          { title: k("how4Title"), text: k("how4Text") },
        ]),
      );
      out.push(callout("info", k("pendingTitle"), k("pendingText")));
      // How each payment comes back applies to orders paid earlier too, so every way is listed whatever is switched on now.
      out.push(h2(k("refundTitle")), ul([k("refundCap"), k("refundTransfer"), k("refundCod"), k("refundWallet"), k("refundReview")]));
      out.push(h2(k("cancelTitle")), p(k("cancelText")));
      if (transfers) out.push(p(k("cancelAuto", { hours: hours(facts.proofHours) })));
      break;
    }
    case "warranty": {
      out.push(callout("info", k("pendingTitle"), k("pendingText")));
      out.push(h2(k("makerTitle")), p(k("makerText")), p(k("makerSpecs")));
      out.push(h2(k("storeTitle")), p(k("storeText")));
      out.push(h2(k("usedTitle")), p(k("usedText")));
      out.push(h2(k("faultTitle")), p(k("faultText")));
      out.push(callout("warning", k("safetyTitle"), k("safetyText")));
      break;
    }
    case "payment": {
      const methods = facts.methods.map((method) => {
        if (method === "card" && facts.card) return k("card", { number: ltr(facts.card.number), name: isolate(facts.card.name) });
        if (method === "zaincash" && facts.zaincash) return k("zaincash", { number: ltr(facts.zaincash) });
        return k(method);
      });
      out.push(h2(k("methodsTitle")), methods.length > 0 ? ul(methods) : p(k("none")), p(k("iqd")));
      if (transfers) {
        out.push(
          h2(k("transferTitle")),
          steps([
            { title: k("step1Title"), text: k("step1Text") },
            { title: k("step2Title"), text: k("step2Text", { hours: hours(facts.proofHours) }) },
            { title: k("step3Title"), text: k("step3Text") },
            { title: k("step4Title"), text: k("step4Text") },
          ]),
        );
      }
      out.push(h2(k("fraudTitle")), ul([k("fraudCard"), k("fraudNumbers"), k("fraudCodes"), k("fraudProofs")]));
      out.push(h2(k("refundTitle")), p(k("refundText")));
      break;
    }
    case "privacy": {
      out.push(p(k("intro")));
      out.push(h2(k("orderTitle")), ul([k("orderPhone"), k("orderAddress"), k("orderDetails"), k("orderMarketing"), k("orderProof")]));
      out.push(h2(k("accountTitle")), ul([k("accountData"), k("accountPassword"), k("accountExtras")]));
      out.push(
        h2(k("securityTitle")),
        ul([
          k("securitySignIn", { days: days(RETENTION_DAYS.authEvents) }),
          k("securitySessions", { days: days(RETENTION_DAYS.sessions) }),
          k("securityCodes", { days: days(RETENTION_DAYS.otpCodes) }),
          // "deleted after one day": cleanupRateLimits() in app/server/ratelimit.server.ts (daily job, default one day)
          k("securityRate"),
          k("securityAudit"),
        ]),
      );
      out.push(h2(k("supportTitle")), ul([k("supportMessages"), k("supportAssistant"), k("supportDevices")]));
      out.push(
        h2(k("cookiesTitle")),
        p(k("cookiesIntro")),
        table(
          [k("cookieName"), k("cookiePurpose"), k("cookieLifetime")],
          PRIVACY_COOKIES.map((cookie) => [ltr(cookie.name), k(cookie.purposeKey), cookieLifetime(t, cookie)]),
        ),
        p(k("storageIntro")),
        ul([
          k("storageNav"),
          k("storageMotion"),
          k("storageCompare"),
          k("storageRecent", { days: days(PRIVACY_STORAGE_DAYS.recentlyViewed) }),
          k("storageSearch", { days: days(PRIVACY_STORAGE_DAYS.recentSearches) }),
        ]),
        p(k("hostText")),
      );
      out.push(h2(k("trackingTitle")), p(k("trackingText", { days: days(PRIVACY_STORAGE_DAYS.recommendationSignals) })));
      out.push(h2(k("shareTitle")), p(k("shareText")));
      out.push(h2(k("rightsTitle")), p(k("rightsText")));
      out.push(callout("info", k("pendingTitle"), k("pendingText")));
      break;
    }
    case "terms": {
      if (env.storeMode !== "live") out.push(callout("warning", k("demoTitle"), k("demoText")));
      const varies = env.coverage?.varies ?? false;
      out.push(h2(k("pricesTitle")), ul([k("pricesIqd"), k("pricesChange"), varies ? k("pricesDeliveryVaries") : k("pricesDelivery", { fee: money(facts.feeIqd) })]));
      out.push(
        h2(k("ordersTitle")),
        ul([
          k("ordersGuest"),
          k("ordersHold"),
          ...(transfers ? [k("ordersTransfer", { hours: hours(facts.proofHours) })] : []),
          k("ordersStock"),
          k("ordersCancel"),
        ]),
      );
      out.push(h2(k("accountTitle")), ul([k("accountOptional"), ...(facts.methods.includes("wallet") ? [k("accountWallet")] : [])]));
      out.push(h2(k("tradeTitle")), ul([k("tradeEstimate"), k("tradeValid", { days: days(facts.estimateDays) }), k("tradeChecks")]));
      out.push(h2(k("infoTitle")), ul([k("infoSpecs"), k("infoCompat"), k("infoPhotos")]));
      out.push(h2(k("changesTitle")), p(k("changesText")));
      out.push(callout("info", k("legalTitle"), k("legalText")));
      break;
    }
  }
  return out;
}

export type PrivacyCookie = { name: string; purposeKey: string; days: number; sliding: boolean };

/**
 * Every cookie the storefront sets for shoppers, in the privacy draft's table. The first three come from the
 * constants of the code that sets them (core). The others are set by areas built alongside this one; their names and
 * lifetimes are mirrored here and tests/content.test.ts checks each against its owner's constant (wishlist, trade-in,
 * home onboarding, account preferences, recommendations), so a change there fails a test instead of leaving the
 * policy wrong. Staff cookies (`tt_adm`, `tt_admin_locale`, the admin rail) live on /admin only and are not listed.
 * A new shopper cookie must be added here with its purpose string (`drafts.privacy.cookie*`).
 */
export const PRIVACY_COOKIES: readonly PrivacyCookie[] = [
  { name: PREFS_COOKIE, purposeKey: "cookiePrefs", days: PREFS_COOKIE_DAYS, sliding: false },
  { name: CART_COOKIE, purposeKey: "cookieCart", days: Math.round(CART_COOKIE_MAX_AGE_SEC / 86_400), sliding: false },
  { name: CUSTOMER_COOKIE, purposeKey: "cookieSession", days: CUSTOMER_SESSION_DAYS, sliding: true },
  { name: "tt_wish", purposeKey: "cookieWish", days: 60, sliding: false }, // WISH_COOKIE(_MAX_AGE_SEC), services/wishlist.server
  { name: "tt_tradein", purposeKey: "cookieTradeIn", days: 2, sliding: false }, // TRADE_IN_DRAFT_COOKIE(_MAX_AGE_SEC), services/tradein.server
  { name: "tt_intro", purposeKey: "cookieIntro", days: 365, sliding: false }, // INTRO_COOKIE, PREF_MAX_AGE_SEC, routes/storefront/home/personal
  { name: "tt_consent", purposeKey: "cookieConsent", days: 365, sliding: false }, // CONSENT_COOKIE(_MAX_AGE_SEC), services/account/preferences.server
  { name: "tt_platforms", purposeKey: "cookiePlatforms", days: 365, sliding: false }, // PLATFORMS_COOKIE, routes/storefront/home/personal
  { name: "tt_rs", purposeKey: "cookieRecSession", days: 90, sliding: false }, // REC_SESSION_COOKIE(_MAX_AGE_SEC), services/recommendations.server
];

/**
 * How long consent-gated data lives (mirrored like the cookies above, checked by the tests): the recently viewed list
 * and recent searches in the browser, and how old a recommendation signal may be before it is deleted.
 */
export const PRIVACY_STORAGE_DAYS = {
  /** RECENT_DAYS, routes/storefront/home/personal (localStorage "tt:recent" — a guest's list; signed in, the account's). */
  recentlyViewed: 90,
  /** RECENT_DAYS, routes/storefront/catalog/components/recent-searches (localStorage "tt:search:recent"). */
  recentSearches: 30,
  /**
   * RECOMMENDATION_EVENT_RETENTION_DAYS, services/recommendations.server: older signals are ignored, and deleted by the
   * daily retention job (purgeRecommendationEvents, jobs.server, scheduled since 2026-11-11) — the policy says "deleted".
   */
  recommendationSignals: 90,
} as const;

function cookieLifetime(t: TFunction, cookie: PrivacyCookie): string {
  const span = cookie.days % 365 === 0 ? t("units.years", { count: cookie.days / 365 }) : t("units.days", { count: cookie.days });
  return cookie.sliding ? t("units.sliding", { span: isolate(span) }) : span;
}

/**
 * A policy's draft in all three languages, as the CMS stores pages (`title` L10n + `body` LocalizedBlocks) — for the
 * admin content module's "start from the current draft" action. The numbers in it are today's settings: once saved
 * in the CMS they no longer follow the settings, which is why the owner reviews the text before publishing.
 */
export async function getPolicyDraftL10n(db: Db, slug: PolicySlug, options: { storeMode?: StoreMode } = {}): Promise<{ title: L10n; body: Record<Locale, Block[]> }> {
  const facts = await readStoreFacts(db);
  const title = {} as Record<Locale, string>;
  const body = {} as Record<Locale, Block[]>;
  for (const locale of LOCALE_CODES) {
    const t = serverT(locale, "content");
    const coverage = await readCoverage(db, locale, facts);
    title[locale] = t(`drafts.${slug}.title`);
    body[locale] = buildPolicyDraft(slug, { t, locale, facts, coverage, storeMode: options.storeMode ?? "demo" });
  }
  return { title, body };
}

// ───────────────────────────────────────────────────────────────── contact

/** The store's contact details (`store.contact`), only what the owner filled in. Nothing is invented. */
export async function getContactDetails(db: Db, locale: Locale): Promise<ContactView> {
  return contactView(await getSetting(db, "store.contact"), locale);
}

export function contactView(contact: SettingValue<"store.contact">, locale: Locale): ContactView {
  const channels: ContactChannel[] = [];
  const phone = contact.phone ? normalizeIraqPhone(contact.phone) : null;
  if (phone) channels.push({ kind: "phone", value: formatIraqPhone(phone), href: `tel:${phone}`, external: false });
  const whatsapp = contact.whatsapp ? normalizeIraqPhone(contact.whatsapp) : null;
  if (whatsapp) channels.push({ kind: "whatsapp", value: formatIraqPhone(whatsapp), href: `https://wa.me/${whatsapp.slice(1)}`, external: true });
  if (contact.email) channels.push({ kind: "email", value: contact.email, href: `mailto:${contact.email}`, external: false });
  for (const kind of ["instagram", "facebook", "tiktok", "telegram"] as const) {
    const url = contact[kind];
    if (url) channels.push({ kind, value: hostLabel(url), href: url, external: true });
  }
  if (contact.map_url) channels.push({ kind: "map", value: hostLabel(contact.map_url), href: contact.map_url, external: true });
  const address = contact.address ? pick(contact.address, locale).trim() || null : null;
  const hours = contact.hours ? pick(contact.hours, locale).trim() || null : null;
  // the kit's <ContactCard>: WhatsApp as international digits, the phone in E.164, the hours in the owner's words (the
  // setting stores no schedule, so the card computes no open / closed state) — the same mapping as the shell's footer
  const card =
    phone || whatsapp || address
      ? { whatsapp: whatsapp ? whatsapp.slice(1) : null, phone, address, mapsUrl: contact.map_url ?? null, hours: null, hoursText: hours, replyTime: null }
      : null;
  return { channels, address, hours, card, isEmpty: channels.length === 0 && !address && !hours };
}

/** "https://www.instagram.com/tamtam.games/" → "instagram.com/tamtam.games" */
function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

// ───────────────────────────────────────────────────────────────── sitemap and robots

export type SitemapEntry = {
  /** Locale-less path ("/p/ps5-pro"); every entry is listed in ar, en and ckb. */
  path: string;
  /** Last real change (epoch ms), when the data has one. */
  lastmod: number | null;
};

/** Public pages that exist whatever the catalogue holds. */
const STATIC_PATHS = ["/", "/used", "/trade-in", "/support", "/policies", "/about", "/contact", "/accessibility"] as const;

/** sitemaps.org: at most 50,000 URLs per file. Every entry is three URLs (ar, en, ckb). */
export const SITEMAP_MAX_URLS = 50_000;

type SlugRow = { slug: string; updated_at: number | null };
type ProductRow = SlugRow & { seo: string | null; category_id: string | null; platform_id: string | null };
type CategoryRow = { id: string; parent_id: string | null; slug: string; is_active: number; seo: string | null };
type PlatformRow = { id: string; slug: string; is_active: number };
type DeviceRow = SlugRow & { platform_id: string };

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];
const noindexOf = (seo: string | null) => parseJson<{ noindex?: unknown }>(seo)?.noindex === true;

/**
 * Every public page worth listing, as locale-less paths — one read (a single batch):
 *   products   published with at least one active variant (exactly what the catalogue lists), not seo.noindex
 *   categories active, under active parents, with a listed product in their subtree, not seo.noindex
 *   platforms  active, with a listed product or a published device on them
 *   devices    published device models on an active platform (/device/:model)
 *   used units listed (/used/:slug) · articles approved and public (/support/article/:slug)
 *   policies   approved CMS policies only — drafts are noindex
 *   static     home, used, trade-in, support, the policy index, about, contact, accessibility
 */
export async function getSitemapEntries(db: Db, now: number): Promise<SitemapEntry[]> {
  const [products, categories, platforms, devices, used, articles, pages] = await runBatch(db, [
    batchSql(
      db,
      sql`SELECT p.slug, p.updated_at, p.seo, p.category_id, p.platform_id FROM products AS p
          WHERE p.status = 'published' AND EXISTS (SELECT 1 FROM variants AS v WHERE v.product_id = p.id AND v.is_active = 1)
          ORDER BY p.slug`,
    ),
    batchSql(db, sql`SELECT id, parent_id, slug, is_active, seo FROM categories ORDER BY sort, slug`),
    batchSql(db, sql`SELECT id, slug, is_active FROM platforms ORDER BY sort, slug`),
    batchSql(db, sql`SELECT slug, updated_at, platform_id FROM device_models WHERE status = 'published' ORDER BY sort, slug`),
    batchSql(db, sql`SELECT slug, updated_at FROM used_units WHERE status = 'listed' ORDER BY slug`),
    batchSql(db, sql`SELECT slug, updated_at FROM knowledge_articles WHERE status = 'approved' AND audience = 'public' ORDER BY slug`),
    batchSql(db, sql`SELECT ${PAGE_COLUMNS} FROM pages WHERE kind = 'policy' AND is_demo = 0 AND status IN ('published', 'scheduled') ORDER BY slug`),
  ]);
  const productRows = rowsOf<ProductRow>(products);
  const categoryRows = rowsOf<CategoryRow>(categories);
  const platformRows = rowsOf<PlatformRow>(platforms);
  const deviceRows = rowsOf<DeviceRow>(devices);

  const entries: SitemapEntry[] = STATIC_PATHS.map((path) => ({ path, lastmod: null }));
  const add = (path: string, lastmod: number | null) => entries.push({ path, lastmod: lastmod && lastmod > 0 ? lastmod : null });

  // categories: active chain + a listed product somewhere below
  const byId = new Map(categoryRows.map((row) => [row.id, row]));
  const activeChain = (row: CategoryRow): boolean => {
    let current: CategoryRow | undefined = row;
    for (let guard = 0; current && guard < 16; guard++) {
      if (current.is_active !== 1) return false;
      if (current.parent_id === null) return true;
      current = byId.get(current.parent_id);
    }
    return false;
  };
  const filled = new Set<string>();
  for (const product of productRows) {
    let current = product.category_id ? byId.get(product.category_id) : undefined;
    for (let guard = 0; current && guard < 16; guard++) {
      filled.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  }

  const activePlatforms = new Map(platformRows.filter((row) => row.is_active === 1).map((row) => [row.id, row]));
  const platformsInUse = new Set<string>();
  for (const product of productRows) if (product.platform_id) platformsInUse.add(product.platform_id);
  for (const device of deviceRows) platformsInUse.add(device.platform_id);

  for (const platform of activePlatforms.values()) if (platformsInUse.has(platform.id)) add(`/platform/${platform.slug}`, null);
  for (const category of categoryRows) if (filled.has(category.id) && activeChain(category) && !noindexOf(category.seo)) add(`/c/${category.slug}`, null);
  for (const device of deviceRows) if (activePlatforms.has(device.platform_id)) add(`/device/${device.slug}`, device.updated_at);
  for (const product of productRows) if (!noindexOf(product.seo)) add(`/p/${product.slug}`, product.updated_at);
  for (const unit of rowsOf<SlugRow>(used)) add(`/used/${unit.slug}`, unit.updated_at);
  for (const article of rowsOf<SlugRow>(articles)) add(`/support/article/${article.slug}`, article.updated_at);
  for (const row of rowsOf<PageRow>(pages)) {
    if (!SLUG_RE.test(row.slug)) continue;
    const page = resolvePage(row, DEFAULT_LOCALE, now);
    if (page && !page.noindex) add(`/policies/${row.slug}`, page.updatedAt);
  }

  // one entry per path (a slug could in theory repeat across kinds of rows only through a bug elsewhere)
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.path) ? false : (seen.add(entry.path), true)));
}

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The sitemap XML: every entry in ar, en and ckb, each URL with its hreflang alternates (and x-default = Arabic,
 * the source language) — the same URLs shellMeta() puts in each page's <link rel="alternate">.
 */
export function buildSitemapXml(entries: readonly SitemapEntry[], origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const urlFor = (path: string, locale: Locale) => xmlEscape(`${base}${encodeURI(localePath(path, locale))}`);
  const limit = Math.floor(SITEMAP_MAX_URLS / LOCALE_CODES.length);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'];
  for (const entry of entries.slice(0, limit)) {
    const alternates = [
      ...LOCALE_CODES.map((code) => `    <xhtml:link rel="alternate" hreflang="${LOCALES[code].bcp47}" href="${urlFor(entry.path, code)}"/>`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor(entry.path, DEFAULT_LOCALE)}"/>`,
    ];
    const lastmod = entry.lastmod ? `    <lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>` : null;
    for (const code of LOCALE_CODES) {
      lines.push("  <url>", `    <loc>${urlFor(entry.path, code)}</loc>`);
      if (lastmod) lines.push(lastmod);
      lines.push(...alternates, "  </url>");
    }
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

/**
 * Pages crawlers never need even when the store is live: the admin and the API (always), the shopper's private
 * pages (cart, checkout, order and trade-in follow-up pages, account, favourites, tracking), on-site search and
 * compare (endless query combinations), and the builders' reference pages (/design-system, /motion).
 */
const PRIVATE_PATHS = ["/cart", "/checkout", "/order/", "/account", "/wishlist", "/track", "/trade-in/", "/search", "/compare", "/design-system", "/motion"] as const;

/**
 * PUBLIC_ORIGIN as configured (wrangler vars / .dev.vars), else the request's own origin — the same rule as the
 * shell's canonical URLs. The routes pass `env.PUBLIC_ORIGIN` in, so this module stays free of "cloudflare:workers".
 */
export function resolvePublicOrigin(configured: unknown, requestOrigin: string): string {
  if (typeof configured === "string") {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // not a URL: fall through
    }
  }
  return requestOrigin;
}

/**
 * Whether search engines may crawl: only a LIVE store on its canonical host. Demo mode (placeholder prices and
 * stock), preview hosts (*.workers.dev) and any other host than PUBLIC_ORIGIN's are closed entirely.
 */
export function robotsIndexable(input: { storeMode: StoreMode; requestOrigin: string; publicOrigin: string }): boolean {
  if (input.storeMode !== "live") return false;
  try {
    const request = new URL(input.requestOrigin);
    const canonical = new URL(input.publicOrigin);
    if (request.hostname.endsWith(".workers.dev")) return false;
    return request.host === canonical.host;
  } catch {
    return false;
  }
}

/** robots.txt: everything closed unless indexable; /admin and /api closed in every case; the sitemap when open. */
export function buildRobotsTxt(input: { indexable: boolean; origin: string }): string {
  const base = input.origin.replace(/\/+$/, "");
  const lines = ["User-agent: *"];
  if (!input.indexable) {
    lines.push("# Demo mode, a preview host or not the canonical domain: nothing here is for search engines yet.", "Disallow: /");
  } else {
    lines.push("Allow: /");
  }
  lines.push("Disallow: /admin", "Disallow: /api/");
  if (input.indexable) {
    for (const code of LOCALE_CODES) for (const path of PRIVATE_PATHS) lines.push(`Disallow: ${LOCALES[code].prefix}${path}`);
    lines.push("", `Sitemap: ${base}/sitemap.xml`);
  }
  lines.push("");
  return lines.join("\n");
}
