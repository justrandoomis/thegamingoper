/**
 * Switch game library (admin) — the planner's STORAGE FIGURES, the setting `builder.switch.capacity`
 * (docs/switch-builder.md §3): what staff type for them, pure and client-safe. The form at the foot of
 * /admin/catalog/switch-library (switch-library-capacity-form.tsx) checks with these rules while staff type and shows
 * the space the figures give per card size (capacityOf, ~/lib/switch-builder/storage); the service
 * (saveCapacityFigures, app/server/services/admin/switch-library.server.ts) reads the posted text with the very same
 * functions and saves through the settings service, whose schema has the last word on the bounds — a test keeps
 * CAPACITY_FIELDS equal to it.
 *
 *   capacityDraft(DEFAULT_CAPACITY)   → { oled: "54.0", switch: "25.9", lite: "25.9", reserve: "2.0", margin: "98.5", … }
 *   readCapacityDraft(draft, saved)   → { value: CapacityConfig, errors: { margin: "too_small", … } }
 *   capacityPreview(value)            → per card size: what the empty card shows free, what is kept free on it for
 *                                       updates, the space for games on it, and the total for games with each model
 *
 * Units as Data Management shows them: GB (1024³ bytes) with one decimal for console memory, its reserve and the
 * bounds of the card's headroom; the usable share of a card and the headroom's share typed as percentages
 * (98.5 → 0.985). Arabic-Indic digits, «٫» and a decimal comma are read («٢٥٫٩», «25,9»).
 */
import { capacityOf } from "~/lib/switch-builder/storage";
import type { CapacityConfig, CardSize, SwitchModel } from "~/lib/switch-builder/types";
import { CARD_SIZES, SWITCH_MODELS } from "~/lib/switch-builder/types";
import { latinNumber } from "./switch-library-input";

/** The settings key these figures are stored under (settings.server.ts). */
export const CAPACITY_SETTING_KEY = "builder.switch.capacity";

export type CapacityFieldKey = "oled" | "switch" | "lite" | "reserve" | "margin" | "fraction" | "minGiB" | "maxGiB";

export type CapacityField = {
  key: CapacityFieldKey;
  /** The form input's name — the settings service's error path for the figure ("value.<path>"). */
  name: string;
  /** "gb": GB as the console shows them, one decimal · "percent": a share typed as a percentage, stored as a fraction. */
  unit: "gb" | "percent";
  /** The bounds as stored (a share's as a fraction): the setting's schema in settings.server.ts. */
  min: number;
  max: number;
};

/** Every figure of the setting, in the form's order. */
export const CAPACITY_FIELDS: readonly CapacityField[] = [
  { key: "oled", name: "value.internalUsableGiB.switch-oled", unit: "gb", min: 1, max: 64 },
  { key: "switch", name: "value.internalUsableGiB.switch", unit: "gb", min: 1, max: 32 },
  { key: "lite", name: "value.internalUsableGiB.switch-lite", unit: "gb", min: 1, max: 32 },
  { key: "reserve", name: "value.internalReserveGiB", unit: "gb", min: 0, max: 16 },
  { key: "margin", name: "value.cardMargin", unit: "percent", min: 0.9, max: 1 },
  { key: "fraction", name: "value.cardHeadroom.fraction", unit: "percent", min: 0, max: 0.5 },
  { key: "minGiB", name: "value.cardHeadroom.minGiB", unit: "gb", min: 0, max: 100 },
  { key: "maxGiB", name: "value.cardHeadroom.maxGiB", unit: "gb", min: 0, max: 200 },
];

export const CAPACITY_FIELD: Readonly<Record<CapacityFieldKey, CapacityField>> = Object.fromEntries(CAPACITY_FIELDS.map((field) => [field.key, field])) as Record<CapacityFieldKey, CapacityField>;

/** A figure's key from its input name (a server's field error) — undefined for any other name. */
export const capacityKeyOfName = (name: string): CapacityFieldKey | undefined => CAPACITY_FIELDS.find((field) => field.name === name)?.key;

/** Error keys the figures can answer (sentences: `storage.errors.<key>` in admin-switch-library). */
export const CAPACITY_ERROR_KEYS = ["required", "gb_format", "percent_format", "too_small", "too_big", "below_paired", "reason_required"] as const;

/** The longest text read for one figure (a longer one is a format error, never parsed). */
const MAX_FIGURE_TEXT = 24;

/** The reason a change is saved with (audit): at least this long, trimmed — setSetting's own rule. */
export const CAPACITY_REASON_MIN = 3;
export const CAPACITY_REASON_MAX = 300;

/** What the admin page knows about the figures (the service's getCapacityFigures). */
export type CapacityFigures = {
  /** The figures the builder page plans with: sanitizeCapacity of what is stored (the defaults while nothing is). */
  inUse: CapacityConfig;
  /** The value in force for the save's guard (the form sends it back as `expected`); null = the stored value no longer fits the setting's rules. */
  expected: CapacityConfig | null;
  /** The research figures (DEFAULT_CAPACITY). */
  defaults: CapacityConfig;
  isStored: boolean;
  /** The figures in use are the defaults. */
  isDefault: boolean;
  /** The setting's complaint about a stored value that no longer fits it (a key such as "too_big"), or null. */
  broken: string | null;
  updatedAt: number | null;
  updatedByName: string | null;
  /** May change them: the setting's own permission (settings.manage). */
  canEdit: boolean;
  /** May open the setting's page and its change history in Settings (settings.read). */
  canSeeHistory: boolean;
};

// ───────────────────────────────────────────────────────────────── numbers ↔ config

type Figures = Record<CapacityFieldKey, number>;

function figuresOf(cfg: CapacityConfig): Figures {
  return {
    oled: cfg.internalUsableGiB["switch-oled"],
    switch: cfg.internalUsableGiB.switch,
    lite: cfg.internalUsableGiB["switch-lite"],
    reserve: cfg.internalReserveGiB,
    margin: cfg.cardMargin,
    fraction: cfg.cardHeadroom.fraction,
    minGiB: cfg.cardHeadroom.minGiB,
    maxGiB: cfg.cardHeadroom.maxGiB,
  };
}

/** The setting's value, keys in the schema's order. */
function configOf(figures: Figures): CapacityConfig {
  return {
    internalUsableGiB: { "switch-oled": figures.oled, switch: figures.switch, "switch-lite": figures.lite },
    internalReserveGiB: figures.reserve,
    cardMargin: figures.margin,
    cardHeadroom: { fraction: figures.fraction, minGiB: figures.minGiB, maxGiB: figures.maxGiB },
  };
}

/** Two values with the same eight figures. */
export function sameCapacity(a: CapacityConfig, b: CapacityConfig): boolean {
  const left = figuresOf(a);
  const right = figuresOf(b);
  return CAPACITY_FIELDS.every((field) => left[field.key] === right[field.key]);
}

// ───────────────────────────────────────────────────────────────── text ↔ figure

export type CapacityDraft = Record<CapacityFieldKey, string>;

type Parsed = { ok: true; value: number } | { ok: false; error: string };

/** A percentage with up to two decimals as basis points ("98.5" → 9850); null when it is not one. */
function basisPoints(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** "54.0", "2.0", "25.9" (a stored figure with more decimals as it is). */
function gbText(value: number): string {
  const tenths = Math.round(value * 10);
  return Math.abs(value * 10 - tenths) < 1e-9 ? (tenths / 10).toFixed(1) : String(value);
}

/** "98.5", "5", "98.25" (basis points; a stored share finer than that is rounded for reading). */
function percentText(value: number): string {
  const bps = Math.round(value * 10_000);
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

/** The text a figure shows in the form. */
export function capacityText(field: CapacityField, value: number): string {
  return field.unit === "percent" ? percentText(value) : gbText(value);
}

/** The form's texts for a value. */
export function capacityDraft(cfg: CapacityConfig): CapacityDraft {
  const figures = figuresOf(cfg);
  return Object.fromEntries(CAPACITY_FIELDS.map((field) => [field.key, capacityText(field, figures[field.key])])) as CapacityDraft;
}

const GB_WORD = /\s*(?:gib|gb|جيجا(?:بايت)?|غيغا(?:بايت)?|گێگا(?:بایت)?|گیگابایت)$/i;

/**
 * One figure as typed: GB with one decimal at most ("25.9", "٢٥٫٩", "25,9", "25.9 GB"), a share as a percentage with
 * two decimals at most ("98.5", "98.5 %"); then within the setting's bounds.
 */
export function parseCapacityFigure(field: CapacityField, raw: string): Parsed {
  const typed = raw.trim();
  if (typed === "") return { ok: false, error: "required" };
  if (typed.length > MAX_FIGURE_TEXT) return { ok: false, error: field.unit === "gb" ? "gb_format" : "percent_format" };
  let value: number;
  if (field.unit === "gb") {
    const text = latinNumber(typed.replace(GB_WORD, ""));
    if (!/^\d{1,3}(?:\.\d)?$/.test(text)) return { ok: false, error: "gb_format" };
    value = Number(text);
  } else {
    const bps = basisPoints(latinNumber(typed.replace(/\s*[%٪]$/, "")));
    if (bps === null) return { ok: false, error: "percent_format" };
    value = bps / 10_000;
  }
  if (value < field.min) return { ok: false, error: "too_small" };
  if (value > field.max) return { ok: false, error: "too_big" };
  return { ok: true, value };
}

/**
 * The value a draft makes, with each figure's error. A figure whose text is still what `saved` shows keeps the saved
 * number exactly (a stored figure finer than the form's decimals is never rewritten by an untouched field); a figure
 * that cannot be read counts at its saved value in `value` — what the preview shows — and is listed in `errors`.
 * The largest headroom below the smallest is `below_paired` on the largest (the setting's own rule).
 */
export function readCapacityDraft(draft: Partial<CapacityDraft>, saved: CapacityConfig): { value: CapacityConfig; errors: Partial<Record<CapacityFieldKey, string>> } {
  const base = figuresOf(saved);
  const figures: Figures = { ...base };
  const errors: Partial<Record<CapacityFieldKey, string>> = {};
  for (const field of CAPACITY_FIELDS) {
    const text = (draft[field.key] ?? "").trim();
    if (text === capacityText(field, base[field.key])) continue;
    const parsed = parseCapacityFigure(field, text);
    if (parsed.ok) figures[field.key] = parsed.value;
    else errors[field.key] = parsed.error;
  }
  if (!errors.minGiB && !errors.maxGiB && figures.maxGiB < figures.minGiB) {
    errors.maxGiB = "below_paired";
    figures.maxGiB = Math.max(base.maxGiB, figures.minGiB);
  }
  return { value: configOf(figures), errors };
}

/** The figures' texts from a posted form (formObject: "value.cardHeadroom.fraction" → { value: { cardHeadroom: { fraction } } }). */
export function capacityDraftFromForm(form: unknown): CapacityDraft {
  const at = (name: string): string => {
    let node: unknown = form;
    for (const part of name.split(".")) node = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined;
    return typeof node === "string" ? node : "";
  };
  return Object.fromEntries(CAPACITY_FIELDS.map((field) => [field.key, at(field.name)])) as CapacityDraft;
}

/** A bound as staff read it in an error sentence: "64 GB", "90%". */
export function capacityBoundText(field: CapacityField, bound: number): string {
  return field.unit === "percent" ? `${percentText(bound)}%` : `${String(bound)} GB`;
}

// ───────────────────────────────────────────────────────────────── preview

export type CapacityPreviewRow = {
  /** The card's label size in decimal GB (1000 = 1TB); 0 = no card. */
  sizeGB: CardSize;
  /** What the console shows free on this card while it is empty (bytes): its label × the usable share. */
  cardBytes: number;
  /** Kept free on the card for updates and DLC. */
  headroomBytes: number;
  /** What the builder plans games into on the card. */
  gamesOnCardBytes: number;
  /** All the builder plans games into with each model: (console memory − its reserve) + (card − headroom). */
  totals: Record<SwitchModel, number>;
};

/** The space a value gives, per card size (capacityOf for each model). */
export function capacityPreview(cfg: CapacityConfig): CapacityPreviewRow[] {
  return CARD_SIZES.map((sizeGB) => {
    const plans = SWITCH_MODELS.map((model) => capacityOf(model, sizeGB, cfg));
    const card = plans[0];
    return {
      sizeGB,
      cardBytes: card.cardBytes,
      headroomBytes: card.cardHeadroomBytes,
      gamesOnCardBytes: Math.max(0, card.cardBytes - card.cardHeadroomBytes),
      totals: Object.fromEntries(SWITCH_MODELS.map((model, index) => [model, plans[index].plannableBytes])) as Record<SwitchModel, number>,
    };
  });
}

/** A card size as it is printed on the card: "64GB", "1TB". */
export const cardLabel = (sizeGB: CardSize): string => (sizeGB >= 1000 ? `${sizeGB / 1000}TB` : `${sizeGB}GB`);
