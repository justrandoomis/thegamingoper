/**
 * Switch bundle builder — storage maths (pure, client-safe). Contract: docs/switch-builder.md §3.
 *
 * Units: everything is kept in BYTES. The console and Nintendo's store both show binary "GB" (GiB, 1024³ bytes) with
 * one decimal, so the builder shows bytes / 1024³ labelled «GB». Memory-card labels are DECIMAL (1 GB = 10⁹ bytes):
 * a "256GB" card shows about 238 GB on the console, so the planner never plans with the label.
 *
 * Space a game needs: the DIGITAL game's full installed size (base game + latest update, measured by TamTam staff);
 * a CARTRIDGE copy needs only its update + DLC data (cartridgeBytes), or the full size until staff have measured it.
 * Save data never counts against the card: on Switch 1 saves always live in system memory, covered by the reserve.
 */
import type { CapacityConfig, CardSize, GameFormat, LibraryExtras, SwitchModel } from "./types";
import { CARD_SIZES, SWITCH_MODELS } from "./types";

export const GIB = 1024 ** 3;

/**
 * Defaults, from the 2026-11-21 storage research (D:/tt-tmp/switch-lib/reports/storage-facts.md §2):
 * internal usable 25.9 GB on the 32 GB models (Nintendo screenshot + outlets), OLED 54.0 (low end of the cited
 * 54–57 GB, not published by Nintendo); cards lose ~1.5 % to formatting and small cards; keep 5 % (2–8 GB) free on the
 * card for updates. Staff replace these with readings from a real console through the setting `builder.switch.capacity`.
 */
export const DEFAULT_CAPACITY: CapacityConfig = {
  internalUsableGiB: { "switch-oled": 54.0, switch: 25.9, "switch-lite": 25.9 },
  internalReserveGiB: 2.0,
  cardMargin: 0.985,
  cardHeadroom: { fraction: 0.05, minGiB: 2, maxGiB: 8 },
};

export function isSwitchModel(value: unknown): value is SwitchModel {
  return typeof value === "string" && (SWITCH_MODELS as readonly string[]).includes(value);
}

export function isCardSize(value: unknown): value is CardSize {
  return typeof value === "number" && (CARD_SIZES as readonly number[]).includes(value);
}

const finite = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;

/** A stored `builder.switch.capacity` value, checked field by field; anything missing or out of range keeps its default. */
export function sanitizeCapacity(raw: unknown): CapacityConfig {
  const base = DEFAULT_CAPACITY;
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<Record<keyof CapacityConfig, unknown>>;
  const internal = (value.internalUsableGiB ?? {}) as Partial<Record<SwitchModel, unknown>>;
  const headroom = (value.cardHeadroom ?? {}) as Partial<Record<keyof CapacityConfig["cardHeadroom"], unknown>>;
  const minGiB = finite(headroom.minGiB, 0, 100) ?? base.cardHeadroom.minGiB;
  const maxGiB = finite(headroom.maxGiB, 0, 200) ?? base.cardHeadroom.maxGiB;
  return {
    internalUsableGiB: {
      "switch-oled": finite(internal["switch-oled"], 1, 64) ?? base.internalUsableGiB["switch-oled"],
      switch: finite(internal.switch, 1, 32) ?? base.internalUsableGiB.switch,
      "switch-lite": finite(internal["switch-lite"], 1, 32) ?? base.internalUsableGiB["switch-lite"],
    },
    internalReserveGiB: finite(value.internalReserveGiB, 0, 16) ?? base.internalReserveGiB,
    cardMargin: finite(value.cardMargin, 0.9, 1) ?? base.cardMargin,
    cardHeadroom: {
      fraction: finite(headroom.fraction, 0, 0.5) ?? base.cardHeadroom.fraction,
      minGiB: Math.min(minGiB, maxGiB),
      maxGiB: Math.max(minGiB, maxGiB),
    },
  };
}

/** Bytes a card of this label can hold for games, before the headroom (0 for "no card"). */
export function cardUsableBytes(sizeGB: CardSize, cfg: CapacityConfig = DEFAULT_CAPACITY): number {
  if (sizeGB === 0) return 0;
  return Math.floor(sizeGB * 1e9 * cfg.cardMargin);
}

/** Bytes kept free on the card for future updates and DLC. */
export function cardHeadroomBytes(sizeGB: CardSize, cfg: CapacityConfig = DEFAULT_CAPACITY): number {
  const usable = cardUsableBytes(sizeGB, cfg);
  if (usable === 0) return 0;
  const { fraction, minGiB, maxGiB } = cfg.cardHeadroom;
  return Math.min(usable, Math.round(Math.min(maxGiB * GIB, Math.max(minGiB * GIB, usable * fraction))));
}

export interface CapacityPlan {
  /** System memory the console shows as usable. */
  internalBytes: number;
  /** Part of it kept for saves, screenshots and system updates. */
  internalReserveBytes: number;
  /** Card space usable for games (before the headroom). */
  cardBytes: number;
  /** Part of the card kept free for updates. */
  cardHeadroomBytes: number;
  /** What games may use: (internal − reserve) + (card − headroom). */
  plannableBytes: number;
}

export function capacityOf(model: SwitchModel, sizeGB: CardSize, cfg: CapacityConfig = DEFAULT_CAPACITY): CapacityPlan {
  const internalBytes = Math.round(cfg.internalUsableGiB[model] * GIB);
  const internalReserveBytes = Math.min(internalBytes, Math.round(cfg.internalReserveGiB * GIB));
  const cardBytes = cardUsableBytes(sizeGB, cfg);
  const headroom = cardHeadroomBytes(sizeGB, cfg);
  return {
    internalBytes,
    internalReserveBytes,
    cardBytes,
    cardHeadroomBytes: headroom,
    plannableBytes: Math.max(0, internalBytes - internalReserveBytes) + Math.max(0, cardBytes - headroom),
  };
}

/** Space a game needs on the console in this format, in bytes; null = not measured yet (it cannot be planned). */
export function spaceNeeded(extras: LibraryExtras | undefined, format: GameFormat): number | null {
  const digital = extras?.sizeBytes && extras.sizeBytes > 0 ? extras.sizeBytes : null;
  if (format === "cartridge") {
    const cartridge = extras?.cartridgeBytes && extras.cartridgeBytes > 0 ? extras.cartridgeBytes : null;
    return cartridge ?? digital;
  }
  return digital;
}

/** True when the cartridge figure is the full digital size standing in for an unmeasured cartridge (say so in the UI). */
export function cartridgeUsesFullSize(extras: LibraryExtras | undefined): boolean {
  return !(extras?.cartridgeBytes && extras.cartridgeBytes > 0) && Boolean(extras?.sizeBytes && extras.sizeBytes > 0);
}

export interface Usage {
  usedBytes: number;
  plannableBytes: number;
  /** Never negative. */
  remainingBytes: number;
  /** How far over the plannable space the plan is (0 when it fits) — after a card was made smaller. */
  overBytes: number;
}

export function usageOf(needs: ReadonlyArray<number | null>, capacity: CapacityPlan): Usage {
  let used = 0;
  for (const need of needs) if (need !== null && need > 0) used += need;
  const left = capacity.plannableBytes - used;
  return { usedBytes: used, plannableBytes: capacity.plannableBytes, remainingBytes: Math.max(0, left), overBytes: Math.max(0, -left) };
}

/** Can a game that needs `need` bytes join a plan with `remainingBytes` left? Unknown sizes never fit. */
export function fits(need: number | null, remainingBytes: number): boolean {
  return need !== null && need > 0 && need <= remainingBytes;
}

/** GiB with `digits` decimals, rounded half up — what the console would show. */
export function toGiB(bytes: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round((bytes / GIB) * factor) / factor;
}

/**
 * Decimals to show two sizes with so they never look equal when they are not (e.g. "6.04 GB needed, 6.01 GB left"):
 * one decimal normally, two when one decimal would print the same figure for different byte counts.
 */
export function digitsToTell(a: number, b: number): 1 | 2 {
  return a !== b && toGiB(a, 1) === toGiB(b, 1) ? 2 : 1;
}

/** GB (as the console shows them) to bytes, for admin input such as "16.5". */
export function bytesFromGiB(value: number): number {
  return Math.round(value * GIB);
}
