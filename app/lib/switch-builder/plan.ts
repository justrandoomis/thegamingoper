/**
 * Switch bundle builder — the shopper's plan (pure, client-safe). Contract: docs/switch-builder.md §3, §6.1, §6.4.
 *
 * The plan (`BuilderPlan`) lives in the browser (localStorage `tt.sb.plan.v1`, restored after hydration: the server
 * always renders the default plan) and is sent to the server only to quote it and to fill the cart.
 *
 *   defaultPlan(catalog)                          the plan a first visit starts from (the same on server and client)
 *   encodePlan(plan) / decodePlan(text)           localStorage text ↔ a checked plan (null for anything else)
 *   reconcilePlan(plan, catalog)                  a restored plan against what the store sells now
 *   planUsage(plan, extras, capacity)             the space bar: capacity, used, left, over
 *   toggleGame / addGame / setGameFormat          choosing games — refused when the game has no size or does not fit
 *   removeGame / setDevice / setCard               the other changes (a smaller card never removes games: the page says
 *                                                 how far over the plan is and the shopper decides)
 *
 * Fit checks are on exact bytes (./storage fits): a game joins only when its whole need fits in what is left.
 */
import { capacityOf, DEFAULT_CAPACITY, fits, isCardSize, isSwitchModel, spaceNeeded, usageOf, type CapacityPlan, type Usage } from "./storage";
import type { BuilderCatalog, BuilderPlan, CapacityConfig, CardSize, CatalogOption, GameFormat, LibraryExtras, LibraryGameId, SwitchModel } from "./types";
import { CARD_SIZES, PLAN_LIMITS, SWITCH_MODELS } from "./types";

/** localStorage key of the plan (listed in the privacy policy). */
export const PLAN_STORAGE_KEY = "tt.sb.plan.v1";

type Devices = BuilderCatalog["devices"];
type Cartridges = BuilderCatalog["cartridges"];

/** A variant to suggest for a model TamTam sells: the first orderable one, else the first one. */
export function suggestedVariant(devices: Devices, model: SwitchModel): CatalogOption | null {
  const device = devices[model];
  if (!device || device.variants.length === 0) return null;
  return device.variants.find((variant) => variant.orderable) ?? device.variants[0];
}

/**
 * The plan a first visit starts from: the first model TamTam sells (OLED first) with its first orderable colour, to buy;
 * when TamTam sells no Switch, the shopper's own OLED. No card, no games. Depends only on the catalogue, so the server
 * and the browser render the same first frame.
 */
export function defaultPlan(catalog?: Pick<BuilderCatalog, "devices"> | null): BuilderPlan {
  if (catalog) {
    for (const model of SWITCH_MODELS) {
      const variant = suggestedVariant(catalog.devices, model);
      if (variant) return { v: 1, device: { model, owned: false, variantId: variant.variantId }, card: { sizeGB: 0, owned: false }, games: [] };
    }
  }
  return { v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [] };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A catalogue variant id, and a library game id (a store slug) — the shapes the server's parsePlan accepts. */
const VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isId = (value: unknown): value is string => typeof value === "string" && VARIANT_ID.test(value);
/** True for an id a plan may hold (a game of another shape could never be quoted, so it is never offered). */
export const isGameId = (value: unknown): value is string => typeof value === "string" && value.length <= 160 && GAME_ID.test(value);
const isFormat = (value: unknown): value is GameFormat => value === "digital" || value === "cartridge";

/** A plan read back from storage or a request, checked field by field; null when it is not a plan of this version. */
export function readPlan(value: unknown): BuilderPlan | null {
  if (!isObject(value) || value.v !== 1) return null;
  const device = value.device;
  const card = value.card;
  if (!isObject(device) || !isSwitchModel(device.model) || typeof device.owned !== "boolean") return null;
  if (!isObject(card) || !isCardSize(card.sizeGB) || typeof card.owned !== "boolean") return null;
  if (!Array.isArray(value.games)) return null;
  const games: BuilderPlan["games"] = [];
  const seen = new Set<string>();
  for (const entry of value.games) {
    if (!isObject(entry) || !isGameId(entry.id) || !isFormat(entry.format) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    games.push({ id: entry.id, format: entry.format });
    if (games.length >= PLAN_LIMITS.maxGames) break;
  }
  const sizeGB = card.sizeGB as CardSize;
  return {
    v: 1,
    device: { model: device.model, owned: device.owned, ...(!device.owned && isId(device.variantId) ? { variantId: device.variantId } : {}) },
    card: sizeGB === 0 ? { sizeGB: 0, owned: false } : { sizeGB, owned: card.owned, ...(!card.owned && isId(card.variantId) ? { variantId: card.variantId } : {}) },
    games,
  };
}

/** The plan as the text kept in localStorage (and sent to the server). */
export function encodePlan(plan: BuilderPlan): string {
  return JSON.stringify(plan);
}

/** localStorage text → a checked plan; null when it is missing, broken or of another version. */
export function decodePlan(text: string | null | undefined): BuilderPlan | null {
  if (!text) return null;
  try {
    return readPlan(JSON.parse(text));
  } catch {
    return null;
  }
}

/** How a game is chosen by default: TamTam's cartridge when it sells one that can be ordered now, else digital. */
export function defaultFormat(id: LibraryGameId, cartridges: Cartridges): GameFormat {
  return cartridges[id]?.orderable ? "cartridge" : "digital";
}

/**
 * A restored plan against what the store sells now: a colour no longer sold gives way to the model's suggested one
 * (or none — the review then says the console cannot be bought now); the card's variant follows the catalogue's card
 * of that size; a cartridge TamTam no longer sells becomes a digital copy.
 */
export function reconcilePlan(plan: BuilderPlan, catalog: Pick<BuilderCatalog, "devices" | "cards" | "cartridges">): BuilderPlan {
  let device = plan.device;
  if (!device.owned) {
    const variants = catalog.devices[device.model]?.variants ?? [];
    if (!variants.some((variant) => variant.variantId === device.variantId)) {
      const suggested = suggestedVariant(catalog.devices, device.model);
      device = { model: device.model, owned: false, ...(suggested ? { variantId: suggested.variantId } : {}) };
    }
  }
  let card = plan.card;
  if (card.sizeGB !== 0 && !card.owned) {
    const sold = catalog.cards[card.sizeGB];
    if (sold?.variantId !== card.variantId) card = { sizeGB: card.sizeGB, owned: false, ...(sold ? { variantId: sold.variantId } : {}) };
  }
  const games = plan.games.map((game) => (game.format === "cartridge" && !catalog.cartridges[game.id] ? { id: game.id, format: "digital" as const } : game));
  const changed = device !== plan.device || card !== plan.card || games.some((game, index) => game !== plan.games[index]);
  return changed ? { ...plan, device, card, games } : plan;
}

/** The plan without the games `keep` refuses (no longer in the list, hidden, or without a size). */
export function prunePlan(plan: BuilderPlan, keep: (game: BuilderPlan["games"][number]) => boolean): BuilderPlan {
  const games = plan.games.filter(keep);
  return games.length === plan.games.length ? plan : { ...plan, games };
}

export type PlanUsage = { capacity: CapacityPlan; usage: Usage };

/** The space bar: the console's and the card's space for games, and what the chosen games use of it. */
export function planUsage(plan: BuilderPlan, extras: Readonly<Record<LibraryGameId, LibraryExtras>>, cfg: CapacityConfig = DEFAULT_CAPACITY): PlanUsage {
  const capacity = capacityOf(plan.device.model, plan.card.sizeGB, cfg);
  return { capacity, usage: usageOf(plan.games.map((game) => spaceNeeded(extras[game.id], game.format)), capacity) };
}

/** Bytes left in the plan with this game NOT counted (what the details sheet tells the shopper about). */
export function remainingWithout(plan: BuilderPlan, id: LibraryGameId, extras: Readonly<Record<LibraryGameId, LibraryExtras>>, cfg: CapacityConfig = DEFAULT_CAPACITY): number {
  return planUsage({ ...plan, games: plan.games.filter((game) => game.id !== id) }, extras, cfg).usage.remainingBytes;
}

export function chosenGame(plan: BuilderPlan, id: LibraryGameId): BuilderPlan["games"][number] | null {
  return plan.games.find((game) => game.id === id) ?? null;
}

export type FitRefusal =
  /** TamTam has not measured this game yet: it cannot join the space bar. */
  | { ok: false; reason: "no_size" }
  /** It needs more than what is left (exact bytes). */
  | { ok: false; reason: "no_room"; needBytes: number; leftBytes: number }
  /** The plan already holds PLAN_LIMITS.maxGames games. */
  | { ok: false; reason: "limit" };

export type FitResult = { ok: true; plan: BuilderPlan } | FitRefusal;

type Extras = Readonly<Record<LibraryGameId, LibraryExtras>>;

/** Choose a game in this format (or move a chosen game to this format), when it has a size and fits. */
export function addGame(plan: BuilderPlan, id: LibraryGameId, format: GameFormat, extras: Extras, cfg: CapacityConfig = DEFAULT_CAPACITY): FitResult {
  const current = chosenGame(plan, id);
  if (current?.format === format) return { ok: true, plan };
  const need = spaceNeeded(extras[id], format);
  if (need === null) return { ok: false, reason: "no_size" };
  if (!current && plan.games.length >= PLAN_LIMITS.maxGames) return { ok: false, reason: "limit" };
  const left = remainingWithout(plan, id, extras, cfg);
  if (!fits(need, left)) return { ok: false, reason: "no_room", needBytes: need, leftBytes: left };
  const games = current ? plan.games.map((game) => (game.id === id ? { id, format } : game)) : [...plan.games, { id, format }];
  return { ok: true, plan: { ...plan, games } };
}

/** Change how a chosen game is bought (a cartridge needs less space than the download, so going digital may not fit). */
export function setGameFormat(plan: BuilderPlan, id: LibraryGameId, format: GameFormat, extras: Extras, cfg: CapacityConfig = DEFAULT_CAPACITY): FitResult {
  if (!chosenGame(plan, id)) return { ok: true, plan };
  return addGame(plan, id, format, extras, cfg);
}

export function removeGame(plan: BuilderPlan, id: LibraryGameId): BuilderPlan {
  return chosenGame(plan, id) ? { ...plan, games: plan.games.filter((game) => game.id !== id) } : plan;
}

export type ToggleResult = { ok: true; plan: BuilderPlan; change: "added" | "removed" } | FitRefusal;

/** A tap on a game card: a chosen game is removed; another one is added in `format` when it has a size and fits. */
export function toggleGame(plan: BuilderPlan, id: LibraryGameId, format: GameFormat, extras: Extras, cfg: CapacityConfig = DEFAULT_CAPACITY): ToggleResult {
  if (chosenGame(plan, id)) return { ok: true, plan: removeGame(plan, id), change: "removed" };
  const result = addGame(plan, id, format, extras, cfg);
  return result.ok ? { ok: true, plan: result.plan, change: "added" } : result;
}

/** A console: the shopper's own (no console line in the cart) or one to buy in a colour. */
export function setDevice(plan: BuilderPlan, device: BuilderPlan["device"]): BuilderPlan {
  const next: BuilderPlan["device"] = device.owned ? { model: device.model, owned: true } : { model: device.model, owned: false, ...(device.variantId ? { variantId: device.variantId } : {}) };
  return { ...plan, device: next };
}

/** A memory card: none, the shopper's own, or TamTam's of that size. Games are kept even when they no longer fit. */
export function setCard(plan: BuilderPlan, card: BuilderPlan["card"]): BuilderPlan {
  const next: BuilderPlan["card"] =
    card.sizeGB === 0 ? { sizeGB: 0, owned: false } : card.owned ? { sizeGB: card.sizeGB, owned: true } : { sizeGB: card.sizeGB, owned: false, ...(card.variantId ? { variantId: card.variantId } : {}) };
  return { ...plan, card: next };
}

/**
 * The smallest card bigger than the plan's that would make room for `extraBytes` more (a game that does not fit now):
 * what «بطاقة أكبر» offers. Null when even the largest card is not enough, or the plan already has the largest.
 */
export function cardThatFits(plan: BuilderPlan, extraBytes: number, extras: Extras, cfg: CapacityConfig = DEFAULT_CAPACITY): CardSize | null {
  const { usage } = planUsage(plan, extras, cfg);
  for (const size of CARD_SIZES) {
    if (size <= plan.card.sizeGB) continue;
    const capacity = capacityOf(plan.device.model, size, cfg);
    if (usage.usedBytes + Math.max(0, extraBytes) <= capacity.plannableBytes) return size;
  }
  return null;
}

/** Card sizes bigger than the plan's (for «بطاقة أكبر» when the plan is over its space). */
export function biggerCardExists(plan: BuilderPlan): boolean {
  return CARD_SIZES.some((size) => size > plan.card.sizeGB);
}
