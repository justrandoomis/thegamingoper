/**
 * support — tickets, replies, routing and SLA rules, the knowledge base, troubleshooting trees and
 * the maintenance assistant's conversations (admin module 14, brief §7).
 *
 * Knowledge content is stored as localized block arrays (never HTML/Markdown) and only
 * `approved` articles and trees are shown to shoppers or used by the assistant.
 * Assistant conversations are only stored with the shopper's consent (`consents` kind "support_log").
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { L10n, Locale } from "~/lib/locales";
import { NOW_MS, at, flag, id, json, l10n, type LocalizedBlocks, type Ref } from "../columns";
import { repairTickets, returns, warranties } from "./aftersales";
import { deviceModels, platforms, products } from "./catalog";
import { orders } from "./commerce";
import { customers } from "./customers";

// ───────────────────────────────────────────────────────────────── tickets

export const TICKET_CHANNELS = ["web", "whatsapp", "phone", "email", "social", "store", "assistant"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const TICKET_CATEGORIES = ["order", "payment", "shipping", "return", "warranty", "repair", "product", "account", "complaint", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_STATUSES = ["open", "pending_customer", "pending_staff", "on_hold", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** A support conversation, linked to whatever it is about (14.02). */
export const supportTickets = sqliteTable(
  "support_tickets",
  {
    id: id(),
    ref: text("ref").notNull(),
    customerId: text("customer_id").references((): Ref => customers.id),
    contactName: text("contact_name"),
    phoneE164: text("phone_e164"),
    email: text("email"),
    channel: text("channel", { enum: TICKET_CHANNELS }).notNull().default("web"),
    subject: text("subject").notNull(),
    category: text("category", { enum: TICKET_CATEGORIES }).notNull().default("other"),
    priority: text("priority", { enum: TICKET_PRIORITIES }).notNull().default("normal"),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("open"),
    assignedTo: text("assigned_to"),
    /** Queue name used by routing rules, e.g. "payments", "repairs". */
    team: text("team"),
    orderId: text("order_id").references((): Ref => orders.id),
    productId: text("product_id").references((): Ref => products.id),
    warrantyId: text("warranty_id").references((): Ref => warranties.id),
    repairTicketId: text("repair_ticket_id").references((): Ref => repairTickets.id),
    returnId: text("return_id").references((): Ref => returns.id),
    /** Assistant conversation handed off to a person; its summary is the first internal note. */
    assistantSessionId: text("assistant_session_id").references((): Ref => assistantSessions.id),
    /** SLA clock (14.05). */
    firstResponseDueAt: at("first_response_due_at"),
    resolutionDueAt: at("resolution_due_at"),
    firstRespondedAt: at("first_responded_at"),
    resolvedAt: at("resolved_at"),
    closedAt: at("closed_at"),
    /** Escalation of financial and warranty complaints to an authorized person (14.07). */
    escalatedAt: at("escalated_at"),
    escalatedTo: text("escalated_to"),
    escalationReason: text("escalation_reason"),
    /** Customer satisfaction 1–5, asked after resolution. Null = not answered. */
    csatRating: integer("csat_rating"),
    csatComment: text("csat_comment"),
    tags: json<string[]>("tags"),
    /** Machine-written summary shown to staff as a draft aid, labelled as such (19.03). */
    aiSummary: text("ai_summary"),
    locale: text("locale").$type<Locale>(),
    /** sha256 of the guest access token for following the ticket without an account. */
    accessTokenHash: text("access_token_hash"),
    lastMessageAt: at("last_message_at"),
    isDemo: flag("is_demo").notNull().default(false),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("support_tickets_ref_uq").on(t.ref),
    index("support_tickets_customer_idx").on(t.customerId, t.createdAt),
    index("support_tickets_phone_idx").on(t.phoneE164),
    index("support_tickets_status_idx").on(t.status, t.priority, t.lastMessageAt),
    index("support_tickets_assigned_idx").on(t.assignedTo, t.status),
    index("support_tickets_order_idx").on(t.orderId),
    index("support_tickets_product_idx").on(t.productId),
    index("support_tickets_warranty_idx").on(t.warrantyId),
    index("support_tickets_repair_idx").on(t.repairTicketId),
    index("support_tickets_return_idx").on(t.returnId),
    index("support_tickets_assistant_idx").on(t.assistantSessionId),
    index("support_tickets_sla_idx").on(t.status, t.resolutionDueAt),
    index("support_tickets_created_at_idx").on(t.createdAt),
    check("support_tickets_csat_check", sql`${t.csatRating} IS NULL OR ${t.csatRating} BETWEEN 1 AND 5`),
  ],
);
export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;

export const TICKET_AUTHOR_KINDS = ["customer", "employee", "system", "assistant"] as const;
export type TicketAuthorKind = (typeof TICKET_AUTHOR_KINDS)[number];

export const ticketMessages = sqliteTable(
  "ticket_messages",
  {
    id: id(),
    ticketId: text("ticket_id")
      .notNull()
      .references((): Ref => supportTickets.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: TICKET_AUTHOR_KINDS }).notNull(),
    authorId: text("author_id"),
    body: text("body").notNull(),
    /** File ids (private). */
    attachments: json<string[]>("attachments"),
    /** Internal notes are never shown to the customer. */
    isInternal: flag("is_internal").notNull().default(false),
    /** Outbox row when the reply was also sent by SMS / WhatsApp / email. */
    outboxId: text("outbox_id"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId, t.createdAt)],
);
export type TicketMessage = typeof ticketMessages.$inferSelect;
export type NewTicketMessage = typeof ticketMessages.$inferInsert;

/** Saved replies with a fixed list of safe variables; staff review the text before sending (14.04). */
export const cannedReplies = sqliteTable(
  "canned_replies",
  {
    id: id(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    body: l10n("body").notNull(),
    category: text("category", { enum: TICKET_CATEGORIES }),
    /** Variables the body may use, e.g. ["order_ref", "customer_name"]. */
    variables: json<string[]>("variables"),
    isActive: flag("is_active").notNull().default(true),
    createdBy: text("created_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("canned_replies_key_uq").on(t.key)],
);
export type CannedReply = typeof cannedReplies.$inferSelect;
export type NewCannedReply = typeof cannedReplies.$inferInsert;

/** Routing by topic, priority and staff capacity (14.03). Rules are evaluated in `sort` order; first match wins. */
export const ticketRoutingRules = sqliteTable(
  "ticket_routing_rules",
  {
    id: id(),
    name: text("name").notNull(),
    /** e.g. `{ category: ["payment"], channel: ["whatsapp"], keywords: ["تحويل"] }`. */
    conditions: json<Record<string, unknown>>("conditions").notNull(),
    assignTo: text("assign_to"),
    team: text("team"),
    setPriority: text("set_priority", { enum: TICKET_PRIORITIES }),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [index("ticket_routing_rules_sort_idx").on(t.isActive, t.sort)],
);
export type TicketRoutingRule = typeof ticketRoutingRules.$inferSelect;
export type NewTicketRoutingRule = typeof ticketRoutingRules.$inferInsert;

/** Response and resolution targets per priority (and optionally category). */
export const slaPolicies = sqliteTable(
  "sla_policies",
  {
    id: id(),
    name: text("name").notNull(),
    priority: text("priority", { enum: TICKET_PRIORITIES }).notNull(),
    category: text("category", { enum: TICKET_CATEGORIES }),
    firstResponseMinutes: integer("first_response_minutes").notNull(),
    resolutionMinutes: integer("resolution_minutes").notNull(),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [index("sla_policies_priority_idx").on(t.priority, t.category)],
);
export type SlaPolicy = typeof slaPolicies.$inferSelect;
export type NewSlaPolicy = typeof slaPolicies.$inferInsert;

// ───────────────────────────────────────────────────────────────── knowledge

export const ARTICLE_KINDS = ["guide", "troubleshooting", "faq", "policy", "setup"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export const ARTICLE_AUDIENCES = ["public", "internal"] as const;
export type ArticleAudience = (typeof ARTICLE_AUDIENCES)[number];
export const CONTENT_STATUSES = ["draft", "review", "approved", "archived"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Help-centre and internal knowledge articles (14.06). `body` is a localized block array. */
export const knowledgeArticles = sqliteTable(
  "knowledge_articles",
  {
    id: id(),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: ARTICLE_KINDS }).notNull(),
    title: l10n("title").notNull(),
    body: json<LocalizedBlocks>("body").notNull(),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    platformId: text("platform_id").references((): Ref => platforms.id),
    tags: json<string[]>("tags"),
    audience: text("audience", { enum: ARTICLE_AUDIENCES }).notNull().default("public"),
    status: text("status", { enum: CONTENT_STATUSES }).notNull().default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: at("approved_at"),
    updatedAt: at("updated_at").notNull(),
    summary: l10n("summary"),
    sort: integer("sort").notNull().default(0),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("knowledge_articles_slug_uq").on(t.slug),
    index("knowledge_articles_device_idx").on(t.deviceModelId, t.status),
    index("knowledge_articles_platform_idx").on(t.platformId, t.status),
    index("knowledge_articles_kind_idx").on(t.kind, t.audience, t.status),
  ],
);
export type KnowledgeArticle = typeof knowledgeArticles.$inferSelect;
export type NewKnowledgeArticle = typeof knowledgeArticles.$inferInsert;

/**
 * A node of a guided-diagnosis tree. Every path ends in a safe outcome: a fix the shopper can do
 * without opening the device, a link to an article or a part, or an escalation to a technician.
 */
export type TroubleshootingNode = {
  id: string;
  kind: "question" | "step" | "outcome";
  text: L10n;
  /** Shown before any step that involves power, batteries or opening the device. */
  warning?: L10n;
  options?: Array<{ label: L10n; next: string }>;
  outcome?: { type: "resolved" | "article" | "part" | "repair" | "human"; articleSlug?: string; productSlug?: string };
};
export type TroubleshootingTree = { start: string; nodes: TroubleshootingNode[] };

export const troubleshootingTrees = sqliteTable(
  "troubleshooting_trees",
  {
    id: id(),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    /** e.g. "no_power", "stick_drift", "overheating", "no_wifi". */
    symptomKey: text("symptom_key").notNull(),
    title: l10n("title").notNull(),
    tree: json<TroubleshootingTree>("tree").notNull(),
    status: text("status", { enum: CONTENT_STATUSES }).notNull().default("draft"),
    approvedBy: text("approved_by"),
    /** Null model + platform = generic tree for that platform; both null = any device. */
    platformId: text("platform_id").references((): Ref => platforms.id),
    approvedAt: at("approved_at"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    index("troubleshooting_trees_device_idx").on(t.deviceModelId, t.symptomKey),
    index("troubleshooting_trees_platform_idx").on(t.platformId, t.symptomKey),
    index("troubleshooting_trees_status_idx").on(t.status),
  ],
);
export type TroubleshootingTreeRow = typeof troubleshootingTrees.$inferSelect;
export type NewTroubleshootingTreeRow = typeof troubleshootingTrees.$inferInsert;

// ───────────────────────────────────────────────────────────────── assistant

export const ASSISTANT_SESSION_KINDS = ["maintenance", "admin"] as const;
export type AssistantSessionKind = (typeof ASSISTANT_SESSION_KINDS)[number];
export const ASSISTANT_SESSION_STATUSES = ["active", "resolved", "escalated", "abandoned"] as const;
export type AssistantSessionStatus = (typeof ASSISTANT_SESSION_STATUSES)[number];

/**
 * A guided-help conversation. `maintenance` sessions belong to a shopper (customer or anonymous
 * session hash); `admin` sessions belong to an employee and answer only from data that employee
 * may read (19.06).
 */
export const assistantSessions = sqliteTable(
  "assistant_sessions",
  {
    id: id(),
    kind: text("kind", { enum: ASSISTANT_SESSION_KINDS }).notNull().default("maintenance"),
    customerId: text("customer_id").references((): Ref => customers.id),
    /** Hash of the anonymous browser session for guests. */
    sessionHash: text("session_hash"),
    employeeId: text("employee_id"),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    symptomKey: text("symptom_key"),
    status: text("status", { enum: ASSISTANT_SESSION_STATUSES }).notNull().default("active"),
    /** Summary handed to staff on escalation. */
    summary: text("summary"),
    /** The shopper agreed to the conversation being stored. Without it, messages are not persisted. */
    logConsent: flag("log_consent").notNull().default(false),
    locale: text("locale").$type<Locale>(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    /** Retention: sessions are purged after this time. */
    expiresAt: at("expires_at"),
  },
  (t) => [
    index("assistant_sessions_customer_idx").on(t.customerId, t.createdAt),
    index("assistant_sessions_session_idx").on(t.sessionHash),
    index("assistant_sessions_employee_idx").on(t.employeeId),
    index("assistant_sessions_device_idx").on(t.deviceModelId),
    index("assistant_sessions_status_idx").on(t.status, t.updatedAt),
    index("assistant_sessions_expires_idx").on(t.expiresAt),
  ],
);
export type AssistantSession = typeof assistantSessions.$inferSelect;
export type NewAssistantSession = typeof assistantSessions.$inferInsert;

export const ASSISTANT_ROLES = ["user", "assistant", "system"] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];
export const ASSISTANT_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type AssistantConfidence = (typeof ASSISTANT_CONFIDENCE_LEVELS)[number];

export const assistantMessages = sqliteTable(
  "assistant_messages",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references((): Ref => assistantSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ASSISTANT_ROLES }).notNull(),
    content: text("content").notNull(),
    /** File ids of photos the shopper attached (private). */
    attachments: json<string[]>("attachments"),
    /** Knowledge articles / tree nodes the answer is based on. An answer without sources says so. */
    sources: json<Array<{ type: "article" | "tree"; id: string; nodeId?: string }>>("sources"),
    /** How sure the answer is — text alone never yields a definitive hardware diagnosis. */
    confidence: text("confidence", { enum: ASSISTANT_CONFIDENCE_LEVELS }),
    /** e.g. ["battery_safety", "warranty_void", "escalation_suggested"]. */
    safetyFlags: json<string[]>("safety_flags"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("assistant_messages_session_idx").on(t.sessionId, t.createdAt)],
);
export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;
