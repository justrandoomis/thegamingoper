/**
 * Store settings — a typed registry over the `settings` table (docs/ARCHITECTURE.md §10).
 *
 *   const fee = await getSetting(db, "shipping.flat_fee_iqd");                       // number
 *   const { "payments.cod": cod, "payments.zaincash": zain } = await getSettings(db, ["payments.cod", "payments.zaincash"]);
 *   await setSetting(db, actor, "shipping.flat_fee_iqd", 6000, "اتفاق جديد مع شركة التوصيل", ctx.now);
 *
 * Every key has a zod schema, a default and the permission needed to change it. Reads validate what
 * is stored: a missing row yields the default, a row that no longer fits its schema throws — a wrong
 * payment account must never be shown as if it were right. Writes check the permission, validate,
 * and store the value together with an audit event (who, why, before, after) in one batch.
 *
 * To add a setting: add it to SETTINGS below (and to SETTINGS_DEFAULTS in the reference seed if it
 * must exist as a row in every environment).
 *
 * Since 2026-11-11 (settings module 22, additive):
 *   · `approver` on a key: a change by someone who does not hold that permission is refused here
 *     (`setting_needs_approval`, 403) — the settings module turns it into a request that a second person decides.
 *   · `setSetting(…, { expected })`: the change applies only while the value in force is still `expected`; checked
 *     before the batch AND inside it, so two people changing the same key at once cannot overwrite each other
 *     silently (`setting_changed`, 409).
 *   · `settingChangeStatements(…)`: the same checks, returned as batch statements for a caller that must store the
 *     change together with its own rows (an approval decided in the same transaction).
 *   · `readSettingState(db, key)`: the value as the admin shows it, never throwing — a stored value that no longer
 *     fits is reported as broken (with the schema's complaint) so the settings screen can show it and replace it
 *     (`expected: null`); every other reader still refuses it (getSetting throws).
 */
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "./actor";
import { auditStatement } from "./audit.server";
import type { BatchStatement, Db } from "./db/drizzle.server";
import { settings } from "./db/schema";
import { SETTINGS_DEFAULTS, type SettingKey as SeededSettingKey } from "./db/seed/reference";
import { expectThat, mapDbError, runBatch } from "./db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "./errors";
import type { Permission } from "./permissions";

// ───────────────────────────────────────────────────────────────── building blocks

const toggle = z.strictObject({ enabled: z.boolean() });

/** An Iraqi mobile number, stored the way shoppers dial it: 07XXXXXXXXX. */
const localPhone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const e164 = normalizeIraqPhone(value);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "phone_invalid" });
      return z.NEVER;
    }
    return `0${e164.slice(4)}`;
  });

/** Digits of a card or account number; spaces and dashes typed for readability are dropped. */
const accountNumber = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^\d{6,34}$/, "account_number_invalid"));

const shortText = (max: number) => z.string().trim().min(1, "required").max(max, "too_long");
const localized = (max: number) => z.strictObject({ ar: shortText(max), en: shortText(max).optional(), ckb: shortText(max).optional() });
const httpsUrl = z
  .string()
  .trim()
  .max(300, "too_long")
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "url_invalid");
const numbering = z.enum(["latn", "arab"]);

type SettingDef<S extends z.ZodType = z.ZodType, Public extends boolean = boolean> = {
  schema: S;
  /** Used while no row exists. Must satisfy the schema. */
  default: z.input<S>;
  /** Permission needed to change the value. */
  permission: Permission;
  /**
   * When set: someone who holds `permission` but not this one may only REQUEST a change, which another employee who
   * holds both decides (admin settings module, 22.06). setSetting refuses them with `setting_needs_approval`.
   */
  approver?: Permission;
  /** True when the storefront may show the value to shoppers. */
  public: Public;
  group: "shipping" | "payments" | "checkout" | "policies" | "store" | "locale" | "controls" | "service";
  label: { ar: string; en: string };
};

/** Keeps the schema type and the literal `public` flag of each entry. */
const define = <S extends z.ZodType, Public extends boolean>(def: SettingDef<S, Public>): SettingDef<S, Public> => def;

// ───────────────────────────────────────────────────────────────── registry

export const SETTINGS = {
  "shipping.flat_fee_iqd": define({
    schema: z.number().int().min(0, "too_small").max(1_000_000, "too_big"),
    default: SETTINGS_DEFAULTS["shipping.flat_fee_iqd"],
    permission: "settings.shipping.manage",
    public: true,
    group: "shipping",
    label: { ar: "رسم التوصيل الموحّد (د.ع)", en: "Flat delivery fee (IQD)" },
  }),
  "shipping.overrides_enabled": define({
    schema: z.boolean(),
    default: SETTINGS_DEFAULTS["shipping.overrides_enabled"],
    permission: "settings.shipping.manage",
    public: true,
    group: "shipping",
    label: { ar: "تفعيل رسوم خاصة لبعض المحافظات", en: "Allow per-governorate fee overrides" },
  }),
  "payments.cod": define({
    schema: toggle,
    default: SETTINGS_DEFAULTS["payments.cod"],
    permission: "settings.payment.manage",
    public: true,
    group: "payments",
    label: { ar: "الدفع عند الاستلام", en: "Cash on delivery" },
  }),
  "payments.wallet": define({
    schema: toggle,
    default: SETTINGS_DEFAULTS["payments.wallet"],
    permission: "settings.payment.manage",
    public: true,
    group: "payments",
    label: { ar: "الدفع من المحفظة", en: "Wallet payment" },
  }),
  "payments.bank_transfer": define({
    schema: z.strictObject({ enabled: z.boolean(), account_number: accountNumber, recipient_name: shortText(100) }),
    default: SETTINGS_DEFAULTS["payments.bank_transfer"],
    permission: "settings.payment.manage",
    public: true,
    group: "payments",
    label: { ar: "التحويل إلى البطاقة", en: "Card transfer" },
  }),
  "payments.zaincash": define({
    schema: z.strictObject({ enabled: z.boolean(), number: localPhone }),
    default: SETTINGS_DEFAULTS["payments.zaincash"],
    permission: "settings.payment.manage",
    public: true,
    group: "payments",
    label: { ar: "زين كاش", en: "Zain Cash" },
  }),
  "checkout.reservation_minutes": define({
    schema: z.number().int().min(5, "too_small").max(24 * 60, "too_big"),
    default: SETTINGS_DEFAULTS["checkout.reservation_minutes"],
    permission: "settings.manage",
    public: true,
    group: "checkout",
    label: { ar: "مدة حجز المخزون للطلب (دقيقة)", en: "Stock reservation time (minutes)" },
  }),
  "checkout.transfer_proof_hours": define({
    schema: z.number().int().min(1, "too_small").max(7 * 24, "too_big"),
    default: SETTINGS_DEFAULTS["checkout.transfer_proof_hours"],
    permission: "settings.manage",
    public: true,
    group: "checkout",
    label: { ar: "مهلة رفع إثبات التحويل (ساعة)", en: "Time allowed to upload a transfer proof (hours)" },
  }),
  "returns.window_days": define({
    schema: z.number().int().min(0, "too_small").max(365, "too_big"),
    default: SETTINGS_DEFAULTS["returns.window_days"],
    permission: "settings.manage",
    public: true,
    group: "policies",
    label: { ar: "مدة الإرجاع (يوم)", en: "Return window (days)" },
  }),
  "tradein.estimate_valid_days": define({
    schema: z.number().int().min(1, "too_small").max(90, "too_big"),
    default: SETTINGS_DEFAULTS["tradein.estimate_valid_days"],
    permission: "settings.manage",
    public: true,
    group: "policies",
    label: { ar: "صلاحية تقدير المقايضة (يوم)", en: "Trade-in estimate validity (days)" },
  }),
  "store.contact": define({
    schema: z.strictObject({
      phone: localPhone.optional(),
      whatsapp: localPhone.optional(),
      email: z.email("email_invalid").max(200, "too_long").optional(),
      address: localized(300).optional(),
      hours: localized(200).optional(),
      map_url: httpsUrl.optional(),
      instagram: httpsUrl.optional(),
      facebook: httpsUrl.optional(),
      tiktok: httpsUrl.optional(),
      telegram: httpsUrl.optional(),
    }),
    default: SETTINGS_DEFAULTS["store.contact"],
    permission: "settings.manage",
    public: true,
    group: "store",
    label: { ar: "بيانات التواصل مع المتجر", en: "Store contact details" },
  }),
  "locale.numbering": define({
    schema: z.strictObject({ ar: numbering, en: numbering, ckb: numbering }),
    default: SETTINGS_DEFAULTS["locale.numbering"],
    permission: "settings.locale.manage",
    public: true,
    group: "locale",
    label: { ar: "نظام الأرقام لكل لغة", en: "Numeral system per language" },
  }),

  // ── internal controls (not in ARCHITECTURE §10, so not seeded as rows: the default applies until changed)

  /**
   * "the configured threshold" of CONTRACTS.md createRefund(): a refund larger than this needs
   * `orders.refund.approve` as well as `orders.refund.create`. The default 0 means EVERY refund needs
   * that approval — the conservative choice until the owner decides otherwise. Raising it weakens a
   * money control, so only holders of `settings.payment.manage` (the owner by default) may change it.
   */
  "refunds.approval_threshold_iqd": define({
    schema: z.number().int().min(0, "too_small").max(100_000_000, "too_big"),
    default: 0,
    permission: "settings.payment.manage",
    public: false,
    group: "controls",
    label: { ar: "الاسترداد الذي يتجاوز هذا المبلغ يحتاج موافقة ثانية (د.ع، صفر = كل استرداد)", en: "Refunds above this amount need a second approval (IQD; 0 = every refund)" },
  }),

  // ── limits the admin modules asked for (2026-11-11). Each default is the module's former constant, so nothing changes
  // until somebody changes the setting; raising one weakens a control, so a change by anyone who does not hold
  // settings.change.approve (the owner by default) waits for a second person.

  /** Admin 03 pricing (03.05): a cut deeper than this, from the highest price of the last 30 days, needs a second person. */
  "pricing.drop_approval_bps": define({
    schema: z.number().int().min(0, "too_small").max(5_000, "too_big"),
    default: 1_000,
    permission: "settings.manage",
    approver: "settings.change.approve",
    public: false,
    group: "controls",
    label: { ar: "تخفيض السعر الذي يتجاوز هذه النسبة يحتاج موافقة شخص ثانٍ", en: "Price cuts deeper than this need a second person" },
  }),
  /** Admin 09 purchasing (09.03): a purchase order above this total (IQD) needs a second approver. */
  "purchasing.po_approval_limit_iqd": define({
    schema: z.number().int().min(0, "too_small").max(1_000_000_000, "too_big"),
    default: 1_000_000,
    permission: "settings.manage",
    approver: "settings.change.approve",
    public: false,
    group: "controls",
    label: { ar: "أمر الشراء الذي يتجاوز هذا المبلغ يحتاج موافقة ثانية (د.ع)", en: "Purchase orders above this total need a second approval (IQD)" },
  }),
  /** Admin 10 finance (10.07): a wallet top-up above this amount (IQD) is decided by two people. */
  "finance.topup_second_approval_iqd": define({
    schema: z.number().int().min(0, "too_small").max(10_000_000, "too_big"),
    default: 500_000,
    permission: "settings.manage",
    approver: "settings.change.approve",
    public: false,
    group: "controls",
    label: { ar: "شحن المحفظة الذي يتجاوز هذا المبلغ يقرره شخصان (د.ع)", en: "Wallet top-ups above this amount are decided by two people (IQD)" },
  }),
  /** Admin 10 finance (10.05): above this amount (IQD) whoever recorded an expense cannot approve it. */
  "finance.expense_second_approval_iqd": define({
    schema: z.number().int().min(0, "too_small").max(1_000_000_000, "too_big"),
    default: 500_000,
    permission: "settings.manage",
    approver: "settings.change.approve",
    public: false,
    group: "controls",
    label: { ar: "المصروف الذي يتجاوز هذا المبلغ يعتمده غير من سجّله (د.ع)", en: "Expenses above this amount are approved by someone other than who recorded them (IQD)" },
  }),
  /** Admin 12 returns: the service targets every returns screen measures against (12.01, 12.03, 12.07, 12.06). */
  "returns.sla": define({
    schema: z.strictObject({
      decision_hours: z.number().int().min(1, "too_small").max(720, "too_big"),
      inspection_hours: z.number().int().min(1, "too_small").max(720, "too_big"),
      repair_days: z.number().int().min(1, "too_small").max(180, "too_big"),
      quarantine_days: z.number().int().min(1, "too_small").max(365, "too_big"),
      warranty_ending_days: z.number().int().min(1, "too_small").max(365, "too_big"),
    }),
    default: { decision_hours: 48, inspection_hours: 48, repair_days: 7, quarantine_days: 14, warranty_ending_days: 30 },
    permission: "settings.manage",
    public: false,
    group: "service",
    label: { ar: "أهداف خدمة المرتجعات والصيانة", en: "Returns and repair service targets" },
  }),
} satisfies Record<SeededSettingKey, SettingDef> & Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;
/** Keys whose values the storefront may show to shoppers. */
export type PublicSettingKey = { [K in SettingKey]: (typeof SETTINGS)[K]["public"] extends true ? K : never }[SettingKey];

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter((key): key is PublicSettingKey => (SETTINGS[key] as SettingDef).public);

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

// ───────────────────────────────────────────────────────────────── reading

/** The registry default of a key, validated (and normalized) by its schema. */
export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  const def: SettingDef = SETTINGS[key];
  return def.schema.parse(def.default) as SettingValue<K>;
}

function readStored<K extends SettingKey>(key: K, row: { value: unknown } | undefined): SettingValue<K> {
  if (row === undefined) return settingDefault(key);
  const def: SettingDef = SETTINGS[key];
  const parsed = def.schema.safeParse(row.value);
  // A stored value that does not fit its schema is a broken configuration, not something to guess around.
  if (!parsed.success) throw new Error(`Setting "${key}" holds a value that does not match its schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return readStored(key, row);
}

/** Several settings in one query: `const { "payments.cod": cod } = await getSettings(db, ["payments.cod", …])`. */
export async function getSettings<const K extends readonly SettingKey[]>(db: Db, keys: K): Promise<{ [P in K[number]]: SettingValue<P> }> {
  const rows = keys.length === 0 ? [] : await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [...keys]));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = readStored(key, byKey.get(key));
  return out as { [P in K[number]]: SettingValue<P> };
}

/** Every setting the storefront may show (payment destinations, fees, contact details) — and nothing else. */
export async function getPublicSettings(db: Db): Promise<{ [P in PublicSettingKey]: SettingValue<P> }> {
  return getSettings(db, PUBLIC_SETTING_KEYS);
}

export type SettingListItem = {
  key: SettingKey;
  group: SettingDef["group"];
  label: { ar: string; en: string };
  value: unknown;
  /** False while no row exists and the default applies. */
  isStored: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  /** Whether this actor may change it. */
  canEdit: boolean;
};

/** All settings with their current values, for the admin settings screen. Needs `settings.read`. */
export async function listSettings(db: Db, actor: Actor): Promise<SettingListItem[]> {
  assertCan(actor, "settings.read");
  const rows = await db.select().from(settings);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return SETTING_KEYS.map((key) => {
    const def: SettingDef = SETTINGS[key];
    const row = byKey.get(key);
    return {
      key,
      group: def.group,
      label: def.label,
      value: readStored(key, row),
      isStored: row !== undefined,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      canEdit: can(actor, def.permission),
    };
  });
}

// ───────────────────────────────────────────────────────────────── writing

/**
 * A value for `key` checked against its schema (and normalized by it, e.g. a phone written 07XXXXXXXXX), or AppError
 * `invalid` with `fields.value[.path]` — what setSetting does with a value before anything is read or written.
 */
export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  if (!isSettingKey(key)) throw notFound("setting");
  const def: SettingDef = SETTINGS[key];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const [path, message] of Object.entries(zodFieldErrors(parsed.error))) fields[path === "_" ? "value" : `value.${path}`] = message;
    throw new AppError("invalid", 400, { fields, detail: key });
  }
  return parsed.data as SettingValue<K>;
}

/** JSON with object keys sorted: two values that mean the same compare equal whatever order their keys were written in. */
function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((name) => [name, sort((input as Record<string, unknown>)[name])]));
    return input;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

export type SettingWriteOptions = {
  /**
   * The value the caller believes is in force (what the person saw on the screen, or what an approval request was
   * made against). The change is refused with `setting_changed` (409) when the value in force differs — read before
   * the batch and checked again inside it, so a change that lands in between is never overwritten silently.
   * `null` means "the stored value no longer fits its schema" (what readSettingState calls broken): it matches only a
   * broken stored value, which is how such a value gets replaced.
   */
  expected?: unknown;
};

/**
 * A key's value as the admin sees it, never throwing: the value in force (the default while nothing is stored), or —
 * for a stored value that no longer fits its schema — `value: null` with the schema's first complaint in `broken`.
 * Pass the row when it was already read (several keys at once); otherwise it is read here.
 */
export async function readSettingState<K extends SettingKey>(db: Db, key: K, row?: { value: unknown } | null): Promise<{ value: SettingValue<K> | null; isStored: boolean; broken: string | null }> {
  const stored = row === undefined ? await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get() : (row ?? undefined);
  if (!stored) return { value: settingDefault(key), isStored: false, broken: null };
  const parsed = (SETTINGS[key] as SettingDef).schema.safeParse(stored.value);
  return parsed.success ? { value: parsed.data as SettingValue<K>, isStored: true, broken: null } : { value: null, isStored: true, broken: parsed.error.issues[0]?.message ?? "invalid" };
}

export type SettingChange<K extends SettingKey> = {
  /** The value that will be in force (validated and normalized). */
  next: SettingValue<K>;
  /** False when `next` is already stored: `statements` is empty and nothing needs writing. */
  changed: boolean;
  /** Guard (with `expected`), the upsert and its audit event — for ONE batch, in this order. */
  statements: BatchStatement[];
};

/**
 * The checks and statements of a setting change, for a caller that stores it in its own batch (and must then turn a
 * `SETTING_CHANGED` guard failure into `setting_changed`, as setSetting does). Throws what setSetting throws.
 */
export async function settingChangeStatements<K extends SettingKey>(db: Db, actor: Actor, key: K, value: unknown, reason: string, now: number, options: SettingWriteOptions = {}): Promise<SettingChange<K>> {
  if (!isSettingKey(key)) throw notFound("setting");
  const def: SettingDef = SETTINGS[key];
  assertCan(actor, def.permission);
  // A control that a second person decides: the request goes through the settings module, never straight here.
  if (def.approver && !can(actor, def.approver)) throw new AppError("setting_needs_approval", 403, { detail: key });

  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw invalid({ reason: "required" });

  const next = parseSettingValue(key, value);

  // ONE read: the value compared with `expected` is exactly the text the in-batch guard checks (two reads would let a
  // change landing between them be compared against the old value and guarded on the new one — review 2026-11-11).
  const raw = (await db.all<{ value: string }>(sql`SELECT value FROM settings WHERE key = ${key}`))[0];
  const current = raw ? { value: JSON.parse(raw.value) as unknown } : undefined;
  const guards: BatchStatement[] = [];
  if (options.expected !== undefined) {
    const stored = current ? def.schema.safeParse(current.value) : null;
    if (stored && !stored.success) {
      // A stored value that no longer fits its schema is never compared: only `expected: null` ("I saw it broken") may replace it.
      if (options.expected !== null) throw new AppError("setting_changed", 409, { detail: key });
    } else {
      // What is in force: the stored value, or the default while no row exists.
      const inForce = stored ? stored.data : settingDefault(key);
      const expected = def.schema.safeParse(options.expected);
      if (!expected.success || stableJson(inForce) !== stableJson(expected.data)) throw new AppError("setting_changed", 409, { detail: key });
    }
    guards.push(
      expectThat(db, raw ? sql`EXISTS (SELECT 1 FROM settings WHERE key = ${key} AND value = ${raw.value})` : sql`NOT EXISTS (SELECT 1 FROM settings WHERE key = ${key})`, {
        code: "SETTING_CHANGED",
        detail: key,
      }),
    );
  }
  // Saving the value that is already stored changes nothing and leaves no audit noise.
  if (current && JSON.stringify(current.value) === JSON.stringify(next)) return { next, changed: false, statements: [] };

  const updatedBy = actor.kind === "employee" ? actor.id : null;
  return {
    next,
    changed: true,
    statements: [
      ...guards,
      db
        .insert(settings)
        .values({ key, value: next, updatedAt: now, updatedBy })
        .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now, updatedBy } }),
      auditStatement(db, {
        actor,
        action: "settings.setting.update",
        entityType: "setting",
        entityId: key,
        before: { value: current ? current.value : null },
        after: { value: next },
        reason: why,
        at: now,
        // The store's own payment and contact numbers are public business data: the trail must show them exactly.
        redact: { phones: false },
      }),
    ],
  };
}

/** True when `error` is the in-batch guard of `{ expected }` (map it to `setting_changed`). */
export function isSettingChangedError(error: unknown): boolean {
  return mapDbError(error)?.code === "SETTING_CHANGED";
}

/**
 * Changes a setting. Throws AppError: `forbidden` without the key's permission, `setting_needs_approval` (403) for a
 * key with an `approver` the actor does not hold, `invalid` with `fields.reason` when no reason is given or
 * `fields.value[.path]` when the value does not fit, `setting_changed` (409) when `options.expected` is no longer the
 * value in force. The new value and its audit event are stored in one batch.
 */
export async function setSetting<K extends SettingKey>(db: Db, actor: Actor, key: K, value: unknown, reason: string, now: number, options: SettingWriteOptions = {}): Promise<SettingValue<K>> {
  const change = await settingChangeStatements(db, actor, key, value, reason, now, options);
  if (!change.changed) return change.next;
  try {
    await runBatch(db, change.statements);
  } catch (error) {
    if (isSettingChangedError(error)) throw new AppError("setting_changed", 409, { detail: key });
    throw error;
  }
  return change.next;
}
