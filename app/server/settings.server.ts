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
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "./actor";
import { auditStatement } from "./audit.server";
import type { Db } from "./db/drizzle.server";
import { settings } from "./db/schema";
import { SETTINGS_DEFAULTS, type SettingKey as SeededSettingKey } from "./db/seed/reference";
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

type SettingDef<S extends z.ZodType = z.ZodType> = {
  schema: S;
  /** Used while no row exists. Must satisfy the schema. */
  default: z.input<S>;
  /** Permission needed to change the value. */
  permission: Permission;
  /** True when the storefront may show the value to shoppers. */
  public: boolean;
  group: "shipping" | "payments" | "checkout" | "policies" | "store" | "locale";
  label: { ar: string; en: string };
};

const define = <S extends z.ZodType>(def: SettingDef<S>): SettingDef<S> => def;

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
} satisfies Record<SeededSettingKey, SettingDef> & Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

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

/** Every setting the storefront may show (payment destinations, fees, contact details). */
export async function getPublicSettings(db: Db): Promise<{ [P in SettingKey]: SettingValue<P> }> {
  const keys = SETTING_KEYS.filter((key) => (SETTINGS[key] as SettingDef).public);
  return (await getSettings(db, keys)) as { [P in SettingKey]: SettingValue<P> };
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
 * Changes a setting. Throws AppError: `forbidden` without the key's permission, `invalid` with
 * `fields.reason` when no reason is given or `fields.value[.path]` when the value does not fit.
 * The new value and its audit event are stored in one batch.
 */
export async function setSetting<K extends SettingKey>(db: Db, actor: Actor, key: K, value: unknown, reason: string, now: number): Promise<SettingValue<K>> {
  if (!isSettingKey(key)) throw notFound("setting");
  const def: SettingDef = SETTINGS[key];
  assertCan(actor, def.permission);

  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw invalid({ reason: "required" });

  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const [path, message] of Object.entries(zodFieldErrors(parsed.error))) fields[path === "_" ? "value" : `value.${path}`] = message;
    throw new AppError("invalid", 400, { fields, detail: key });
  }
  const next = parsed.data as SettingValue<K>;

  const current = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  // Saving the value that is already stored changes nothing and leaves no audit noise.
  if (current && JSON.stringify(current.value) === JSON.stringify(next)) return next;

  const updatedBy = actor.kind === "employee" ? actor.id : null;
  await db.batch([
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
  ]);
  return next;
}
