/**
 * Admin module 22 "settings" — client-safe catalogue: how each setting key is edited on the settings pages (or where
 * it is edited instead), the message templates the code sends and the variables each may use, the policies this
 * module approves, the URL state of the change log, and the error keys. The schemas, defaults and permissions of the
 * keys stay on the server (~/server/settings.server); the services send each page what it needs.
 */
export const SETTINGS_ERROR_KEYS = [
  "setting_changed",
  "setting_needs_approval",
  "change_pending",
  "change_not_pending",
  "approver_is_requester",
  "no_change",
  "not_editable",
  "key_taken",
  "key_locked",
  "field_changed",
  "type_locked",
  "option_in_use",
  "template_variable_unknown",
  "template_variable_missing",
  "template_changed",
  "policy_changed",
  "policy_no_draft",
  "policy_not_editable",
  "policy_empty",
  "reason_required",
] as const;

export type FieldUnit = "iqd" | "minutes" | "hours" | "days" | "percent";

export type FieldSpec =
  | { kind: "int"; unit: FieldUnit; min: number; max: number }
  /** A percentage typed by a person ("10", "12.5", "١٢٫٥"), stored as basis points. */
  | { kind: "bps"; min: number; max: number }
  | { kind: "bool" }
  | { kind: "text"; max: number; input?: "tel" | "email" | "url" | "text"; ltr?: boolean }
  | { kind: "l10n"; max: number }
  | { kind: "select"; options: readonly string[] };

export type ObjectField = { name: string; field: FieldSpec; optional?: boolean };

export type SettingEditor =
  | { kind: "value"; field: FieldSpec }
  | { kind: "object"; fields: readonly ObjectField[] }
  /** Changed in another module, which shows the change's impact before it is made. */
  | { kind: "linked"; href: string; module: string }
  /** Stored, but nothing in the store reads it yet: shown read-only with the reason. */
  | { kind: "unused" };

const iqd = (max: number, min = 0): FieldSpec => ({ kind: "int", unit: "iqd", min, max });
const toggle: ObjectField = { name: "enabled", field: { kind: "bool" } };

/** Every setting key and how it is edited. A key missing here is shown read-only. */
export const SETTING_EDITORS: Record<string, SettingEditor> = {
  "shipping.flat_fee_iqd": { kind: "linked", href: "/admin/shipping/zones", module: "shipping" },
  "shipping.overrides_enabled": { kind: "linked", href: "/admin/shipping/zones", module: "shipping" },
  "payments.cod": { kind: "object", fields: [toggle] },
  "payments.wallet": { kind: "object", fields: [toggle] },
  "payments.bank_transfer": { kind: "object", fields: [toggle, { name: "account_number", field: { kind: "text", max: 40, ltr: true, input: "text" } }, { name: "recipient_name", field: { kind: "text", max: 100 } }] },
  "payments.zaincash": { kind: "object", fields: [toggle, { name: "number", field: { kind: "text", max: 20, input: "tel", ltr: true } }] },
  "checkout.reservation_minutes": { kind: "unused" },
  "checkout.transfer_proof_hours": { kind: "value", field: { kind: "int", unit: "hours", min: 1, max: 168 } },
  "returns.window_days": { kind: "value", field: { kind: "int", unit: "days", min: 0, max: 365 } },
  "tradein.estimate_valid_days": { kind: "value", field: { kind: "int", unit: "days", min: 1, max: 90 } },
  "store.contact": {
    kind: "object",
    fields: [
      { name: "phone", field: { kind: "text", max: 20, input: "tel", ltr: true }, optional: true },
      { name: "whatsapp", field: { kind: "text", max: 20, input: "tel", ltr: true }, optional: true },
      { name: "email", field: { kind: "text", max: 200, input: "email", ltr: true }, optional: true },
      { name: "address", field: { kind: "l10n", max: 300 }, optional: true },
      { name: "hours", field: { kind: "l10n", max: 200 }, optional: true },
      { name: "map_url", field: { kind: "text", max: 300, input: "url", ltr: true }, optional: true },
      { name: "instagram", field: { kind: "text", max: 300, input: "url", ltr: true }, optional: true },
      { name: "facebook", field: { kind: "text", max: 300, input: "url", ltr: true }, optional: true },
      { name: "tiktok", field: { kind: "text", max: 300, input: "url", ltr: true }, optional: true },
      { name: "telegram", field: { kind: "text", max: 300, input: "url", ltr: true }, optional: true },
    ],
  },
  "locale.numbering": { kind: "unused" },
  "refunds.approval_threshold_iqd": { kind: "value", field: iqd(100_000_000) },
  "pricing.drop_approval_bps": { kind: "value", field: { kind: "bps", min: 0, max: 5_000 } },
  "purchasing.po_approval_limit_iqd": { kind: "value", field: iqd(1_000_000_000) },
  "finance.topup_second_approval_iqd": { kind: "value", field: iqd(10_000_000) },
  "finance.expense_second_approval_iqd": { kind: "value", field: iqd(1_000_000_000) },
  "returns.sla": {
    kind: "object",
    fields: [
      { name: "decision_hours", field: { kind: "int", unit: "hours", min: 1, max: 720 } },
      { name: "inspection_hours", field: { kind: "int", unit: "hours", min: 1, max: 720 } },
      { name: "repair_days", field: { kind: "int", unit: "days", min: 1, max: 180 } },
      { name: "quarantine_days", field: { kind: "int", unit: "days", min: 1, max: 365 } },
      { name: "warranty_ending_days", field: { kind: "int", unit: "days", min: 1, max: 365 } },
    ],
  },
};

/** How the keys that are not edited here read (their editor is "linked" or "unused"). */
export const SETTING_VIEWS: Record<string, SettingEditor> = {
  "shipping.flat_fee_iqd": { kind: "value", field: iqd(1_000_000) },
  "shipping.overrides_enabled": { kind: "value", field: { kind: "bool" } },
  "checkout.reservation_minutes": { kind: "value", field: { kind: "int", unit: "minutes", min: 5, max: 1440 } },
  "locale.numbering": { kind: "object", fields: ["ar", "en", "ckb"].map((name) => ({ name: `numbering_${name}`, field: { kind: "select", options: ["latn", "arab"] } as FieldSpec })) },
};

/** The spec a key's value is shown with. */
export const viewOf = (key: string, editor: SettingEditor): SettingEditor => SETTING_VIEWS[key] ?? editor;

/** Groups in the order the settings page lists them. */
export const SETTING_GROUP_ORDER = ["controls", "payments", "checkout", "policies", "service", "shipping", "store", "locale"] as const;

/** Arabic-Indic and Persian digits as 0–9. */
export function latinDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * A typed whole number ("1,000,000", "١٬٠٠٠٬٠٠٠", "1 000 000") → the number; NaN for anything else (a fraction, a stray
 * mark — never silently a different number); undefined when empty.
 */
export function parseWhole(value: string): number | undefined {
  const text = latinDigits(value).replace(/[\s,٬،']/g, "");
  if (text === "") return undefined;
  return /^\d{1,13}$/.test(text) ? Number(text) : Number.NaN;
}

/** A typed percentage with up to two decimals ("12.5", "١٢٫٥", "12,5") → basis points; NaN when not one. */
export function parsePercentBps(value: string): number | undefined {
  const text = latinDigits(value).replace(/[٫,،]/g, ".").replace(/[\s%٪]/g, "");
  if (text === "") return undefined;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// ───────────────────────────────────────────────────────────────── custom fields (22.03)

/** The product kinds a field may apply to ("*" = every kind) and its types — the schema's lists (a test keeps them equal), here so pages need no database import. */
export const FIELD_KINDS = ["*", "console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;
export const FIELD_TYPES = ["text", "l10n", "number", "boolean", "select", "multiselect", "date"] as const;

// ───────────────────────────────────────────────────────────────── message templates (22.04)

export const TEMPLATE_LOCALES = ["ar", "en", "ckb"] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/**
 * The messages the code queues today (outbox.template) and the variables each one carries in its payload — a
 * template may use these and nothing else. `required`: a message that cannot do its job without it.
 */
export const TEMPLATE_CATALOG = [
  { key: "order_confirmed", channel: "sms", variables: ["ref", "status"], required: ["ref"] },
  { key: "order_shipped", channel: "sms", variables: ["ref", "status", "trackingNo"], required: ["ref"] },
  { key: "order_delivered", channel: "sms", variables: ["ref", "status"], required: ["ref"] },
  { key: "order_cancelled", channel: "sms", variables: ["ref", "status"], required: ["ref"] },
  { key: "order_returned", channel: "sms", variables: ["ref", "status"], required: ["ref"] },
  { key: "order_edited", channel: "sms", variables: ["ref"], required: ["ref"] },
  { key: "payment_verified", channel: "sms", variables: ["ref"], required: ["ref"] },
  { key: "payment_rejected", channel: "sms", variables: ["ref", "reason"], required: ["ref"] },
  { key: "preorder_date_changed", channel: "sms", variables: ["ref", "expectedDay"], required: ["ref", "expectedDay"] },
  { key: "otp", channel: "sms", variables: ["code"], required: ["code"] },
] as const;
export type TemplateKey = (typeof TEMPLATE_CATALOG)[number]["key"];

export const TEMPLATE_MAX_LENGTH = 640;

/** Sample values for the preview (never real data). */
export const TEMPLATE_SAMPLES: Record<string, string> = { ref: "TT-7K4M2Q9X", status: "shipped", trackingNo: "123456789", reason: "…", expectedDay: "2026-12-01", code: "123456" };

/** The {variables} a template body uses. */
export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))];
}

export function renderTemplate(body: string, values: Record<string, string> = TEMPLATE_SAMPLES): string {
  return body.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

// ───────────────────────────────────────────────────────────────── policies (22.02)

/** The policies this module approves (blueprint 22.02: warranty and return policies). The others are module 17's. */
export const EDITABLE_POLICIES = ["returns", "warranty"] as const;
export type EditablePolicy = (typeof EDITABLE_POLICIES)[number];
export const isEditablePolicy = (slug: string): slug is EditablePolicy => (EDITABLE_POLICIES as readonly string[]).includes(slug);

// ───────────────────────────────────────────────────────────────── change log URL state (22.06)

export type ChangeFilters = { key: string | null; page: number };
export function parseChangeFilters(params: URLSearchParams): ChangeFilters {
  const key = params.get("key");
  const page = Number(latinDigits(params.get("page") ?? "1"));
  return { key: key && /^[a-z0-9_.]{3,64}$/.test(key) ? key : null, page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1 };
}
