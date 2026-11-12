/**
 * Support — view models shared by the support services and the /support pages (client-safe, types and constants
 * only: no database, no "cloudflare:workers"). Services return these already localized for the request's locale.
 *
 *   help centre        SupportDirectory (platforms → device models), ArticleSummary
 *   article page       ArticleDetail (blocks are the stored ones; <Blocks> checks each before rendering)
 *   assistant          AssistantView (the replayed conversation, built from the URL — see ./state.ts)
 *   repairs            RepairStatusView (what a shopper may see of a repair ticket: no serial, no internal notes)
 */

// ───────────────────────────────────────────────────────────────── devices

export type SupportPlatform = {
  id: string;
  slug: string;
  /** Catalogue name; the UI shows the design system's name for the four known platforms (ui:platform.*). */
  name: string;
  /** Design-token name of the platform light ("nintendo", "playstation", "xbox", "handheld"). */
  accent: string;
};

export type SupportDevice = {
  id: string;
  slug: string;
  name: string;
  /** Official photo key of the device ("<slug>--<n>") or null. */
  artKey: string | null;
  kind: string;
  platform: SupportPlatform;
};

export type SupportPlatformGroup = SupportPlatform & { devices: SupportDevice[] };

// ───────────────────────────────────────────────────────────────── knowledge

export type ArticleKind = "guide" | "troubleshooting" | "faq" | "policy" | "setup";

export type ArticleSummary = {
  id: string;
  slug: string;
  kind: ArticleKind;
  title: string;
  summary: string | null;
  /** The device model the article is written for (null = the whole platform, or general). */
  device: { slug: string; name: string } | null;
  platform: SupportPlatform | null;
  /**
   * Why it is listed for a device: "device" = written for that model, "platform" = written for every device of its
   * platform, "related" = written for another model of the same platform (the shopper must check it applies).
   */
  scope: "device" | "platform" | "related";
  updatedAt: number;
  /** Seeded sample content (ARCHITECTURE §11). */
  isDemo: boolean;
  /** A person of the store approved it (approved_by is set). Seeded articles are approved without a reviewer. */
  reviewed: boolean;
};

export type ArticleDetail = ArticleSummary & {
  /** The stored blocks for the locale (Arabic when a translation is missing). Rendered with <Blocks>. */
  blocks: unknown[];
  tags: string[];
  /** The first picture of the article (a product photo key), for the share card. */
  artKey: string | null;
  /** True when the text is the Arabic fallback because this locale has no translation. */
  fallback: boolean;
};

/**
 * The help centre's search (kb.server searchHelp): a danger sign first (no guides — stop and book a repair), an error
 * code with the guides that mention it (possibly none), or guides ranked by the shopper's words.
 */
export type HelpSearch = {
  /** The query as searched (cleaned, ≤ 300 characters). */
  query: string;
  kind: "danger" | "code" | "guides";
  code: string | null;
  articles: ArticleSummary[];
};

// ───────────────────────────────────────────────────────────────── assistant

/** Words, never a number: how sure an answer is (DESIGN.md §9.22). */
/** safe_step: a step that may not fix it · likely: words matched a guide · uncertain: a guide may help · needs_check: only a technician who has the device can tell. */
export type AssistantConfidence = "safe_step" | "likely" | "uncertain" | "needs_check";

export type AssistantSource = { type: "tree"; id: string; nodeId: string } | { type: "article"; id: string };

/**
 * Turns written by the page itself (their words are in the "support" messages, `assistant.turn.<kind>`) and turns
 * whose text comes from an approved tree ("question", "step", "outcome").
 */
export type AssistantTurnKind =
  | "ask_device"
  /** The shopper described a problem before naming a device: the device is needed to choose safe steps. */
  | "need_device"
  | "ask_model"
  | "ask_problem"
  | "matched"
  | "unmatched"
  | "code"
  | "code_found"
  | "topic"
  | "danger"
  | "question"
  | "step"
  | "outcome";

export type AssistantUserTurn = {
  id: string;
  role: "user";
  /** What the shopper chose or typed. */
  text: string;
  /** A message key to show instead of `text` (e.g. "my device is not in the list"). */
  i18n: string | null;
  /** The shopper typed it (any language and direction) rather than picking a reply written by us. */
  typed: boolean;
  /** The reply is a platform: its slug, so the page can show the design system's name for it (Latin brands stay Latin). */
  platform?: string;
};

export type AssistantBotTurn = {
  id: string;
  role: "assistant";
  kind: AssistantTurnKind;
  /** Approved text of a tree node; "" for the page's own turns (rendered from `assistant.turn.<kind>` with `params`). */
  text: string;
  params: Record<string, string>;
  /** A safety warning from the tree, shown before the text (battery, mains power, opening the device, warranty). */
  warning: string | null;
  /** …or the page's own safety warning (a message key). */
  warningKey: string | null;
  confidence: AssistantConfidence | null;
  /** 1, 2, 3 … for troubleshooting steps. */
  stepNumber: number | null;
  sources: AssistantSource[];
  /** Guides offered in this answer (topic and error-code answers, article outcomes). */
  articles: ArticleSummary[];
};

export type AssistantTurn = AssistantUserTurn | AssistantBotTurn;

/** A reply the shopper can pick: `href` is the next conversation state, a "?…" query on the same page. */
export type AssistantChoice = { label: string; href: string };

export type AssistantPrompt =
  | { kind: "platforms"; platforms: Array<SupportPlatform & { href: string }>; otherHref: string }
  | { kind: "models"; platform: SupportPlatform; devices: Array<SupportDevice & { href: string }>; otherHref: string; backHref: string }
  | { kind: "problems"; symptoms: AssistantChoice[]; guides: ArticleSummary[] }
  | { kind: "choices"; choices: AssistantChoice[] };

export type AssistantOutcomeType = "resolved" | "article" | "part" | "repair" | "human";

export type AssistantOutcome = {
  type: AssistantOutcomeType;
  article: ArticleSummary | null;
  /** A product page to link for "part" outcomes. */
  productSlug: string | null;
};

export type AssistantStage = "device" | "problem" | "steps" | "done";

export type AssistantView = {
  /** The model boundary: no AI model or provider is configured, every answer comes from approved guides. */
  ai: { configured: boolean; name: string | null };
  stage: AssistantStage;
  device: SupportDevice | null;
  /** The shopper said the device is not in our list. */
  deviceOther: boolean;
  platform: SupportPlatform | null;
  symptom: { key: string; title: string } | null;
  turns: AssistantTurn[];
  /** What the shopper can answer now; null when the conversation reached an outcome. */
  prompt: AssistantPrompt | null;
  outcome: AssistantOutcome | null;
  /** Approved guides for the device (or its platform). */
  guides: ArticleSummary[];
  /** The conversation as plain text in the view's locale — the preview of what staff receive. */
  summary: string;
  /** Normalised state as a query string ("?device=…&symptom=…&a=0") — hidden form fields carry it. */
  search: string;
  /** Any guide or tree used is seeded sample content. */
  isDemo: boolean;
  /** The handoff form was asked for (?handoff=1). */
  handoff: boolean;
};

// ───────────────────────────────────────────────────────────────── tickets and repairs

export const REPAIR_HANDOVERS = ["drop_off", "pickup"] as const;
export type RepairHandover = (typeof REPAIR_HANDOVERS)[number];

export const PREFERRED_WINDOWS = ["morning", "afternoon", "evening", "any"] as const;
export type PreferredWindow = (typeof PREFERRED_WINDOWS)[number];

/** Same list as app/server/db/schema/aftersales.ts REPAIR_STATUSES (kept here so components need no schema import). */
export const REPAIR_STATUS_LIST = ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing", "ready", "delivered", "unrepairable", "cancelled"] as const;
export type RepairStatusKey = (typeof REPAIR_STATUS_LIST)[number];

/** Photos a shopper may attach to one repair request or one message to staff. */
export const MAX_SUPPORT_PHOTOS = 3;

export type RepairStatusView = {
  ref: string;
  status: RepairStatusKey;
  createdAt: number;
  updatedAt: number;
  device: { slug: string; name: string; artKey: string | null } | null;
  /** The device as the shopper typed it when it is not in our list. */
  deviceText: string | null;
  issue: string;
  handover: RepairHandover | null;
  preferredDay: string | null;
  preferredWindow: PreferredWindow | null;
  photoCount: number;
  /** A quote the shopper has to approve before chargeable work starts. */
  quoteIqd: number | null;
  quoteApproved: boolean;
  /** What the shopper is charged (0 under warranty), once a person set it. */
  costIqd: number | null;
  isWarranty: boolean;
  /** Status changes, oldest first. Notes are internal and never included. */
  timeline: Array<{ status: RepairStatusKey; at: number }>;
  isDemo: boolean;
};

export type CreatedTicket = { ticketId: string; ref: string; accessToken: string; replayed: boolean };
