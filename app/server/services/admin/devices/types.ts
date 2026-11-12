/**
 * Admin module 13 "Devices, games & trade-in" — client-safe constants, URL state and view models shared by the
 * services in this folder and the route modules in app/routes/admin/devices. No database, no server-only imports.
 *
 * The trade-in pipeline follows the blueprint's workflow "used-device trade-in":
 *   valuation → inspection & ownership → price offer → approval → receipt & data wipe → cost entry → relisting
 * (docs/admin-blueprint.json, workflows[1]); `pipelineStep()` maps a trade-in onto those seven steps.
 */
import type { ChecklistResult, DigitalCodeStatus, InspectionKind, InspectionTemplateItem, LicenseType, MediaFormat, PayoutMethod, SerialSource, SerialStatus, TradeInStatus, UsedDefect, UsedGrade, UsedUnitSource, UsedUnitStatus } from "~/server/db/schema";

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

/** "0771 234 5678" with customer.phone.read_full, "0771 ••• ••78" without. */
export type PhoneView = { display: string; full: boolean; e164?: string };

// ───────────────────────────────────────────────────────────────── numbers typed by people

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → Latin digits (client-safe copy; ~/lib/phone has the same rule). */
export function latinDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const p = PERSIAN.indexOf(ch);
    out += p >= 0 ? String(p) : ch;
  }
  return out;
}

/**
 * A whole number typed by a person: Arabic-Indic / Persian digits and thousands separators (, ٬ ، spaces) accepted;
 * undefined when empty, NaN for anything else (a decimal, a sign, letters) — so "1310.5" is never read as 13105.
 */
export function parseWhole(raw: string | null | undefined): number | undefined {
  const text = latinDigits(String(raw ?? "")).replace(/[,\s٬،]/g, "");
  if (!text) return undefined;
  return /^\d{1,13}$/.test(text) ? Number(text) : Number.NaN;
}

/** A percentage 0–100 typed by a person (Arabic-Indic digits accepted); undefined when empty, NaN when not a whole 0–100. */
export function parsePercent(raw: string | null | undefined): number | undefined {
  const value = parseWhole(raw);
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : Number.NaN;
}

// ───────────────────────────────────────────────────────────────── trade-ins

export const TRADE_IN_STATUS_LIST = ["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "paid", "cancelled", "expired"] as const satisfies readonly TradeInStatus[];
export type TradeInStatusKey = (typeof TRADE_IN_STATUS_LIST)[number];

export const TRADE_IN_TONE: Record<TradeInStatusKey, Tone> = {
  submitted: "warn",
  estimated: "warn",
  inspection_scheduled: "info",
  inspected: "warn",
  offered: "info",
  accepted: "warn",
  declined: "neutral",
  paid: "ok",
  cancelled: "neutral",
  expired: "neutral",
};

/** Statuses a trade-in can still move from (paid and cancelled are final). */
export const TRADE_IN_OPEN: readonly TradeInStatusKey[] = ["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "expired"];
/** Statuses from which a device can be inspected (again, until an offer is out). */
export const INSPECTABLE: readonly TradeInStatusKey[] = ["submitted", "estimated", "inspection_scheduled", "inspected", "declined", "expired"];
/** Statuses from which a final offer can be made (a declined or expired offer can be replaced by a new one). */
export const OFFERABLE: readonly TradeInStatusKey[] = ["inspected", "declined", "expired"];
/** Statuses that can be cancelled by staff (with a reason). */
export const CANCELLABLE: readonly TradeInStatusKey[] = ["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "expired"];

export const PAYOUT_LIST = ["store_credit", "cash"] as const satisfies readonly PayoutMethod[];
export type Payout = (typeof PAYOUT_LIST)[number];

/** The largest final offer (the wallet's own ceiling for one credit is 100,000,000 IQD). */
export const MAX_OFFER_IQD = 100_000_000;
/** Offers are whole thousands of IQD (no coins). */
export const OFFER_STEP_IQD = 1_000;
/** How long a final offer stays open, in days (default: the setting tradein.estimate_valid_days). */
export const OFFER_VALID_DAYS = { min: 1, max: 30 } as const;
/** How far ahead an inspection can be booked, in days. */
export const SCHEDULE_DAYS_AHEAD = 60;
/** The Baghdad wall-clock day and time of an instant (Iraq keeps UTC+3 all year) — for date and time inputs; the same
 *  on the server and in the browser, whatever the browser's own time zone. */
export function baghdadParts(at: number): { day: string; time: string } {
  const iso = new Date(at + 3 * 3_600_000).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}
/** Inspection photos per trade-in, and photos per used unit. */
export const MAX_TRADE_IN_PHOTOS = 12;
export const MAX_UNIT_PHOTOS = 12;

export const TRADE_IN_VIEWS = ["all", "new", "scheduled", "inspected", "offered", "accepted", "to_pay", "done"] as const;
export type TradeInView = (typeof TRADE_IN_VIEWS)[number];
/**
 * The statuses of each saved view. "new" is every request still to inspect (booked or not); "inspected" also holds an
 * offer past its date that nothing recorded yet, and "offered" only offers still open — tradeins.server's `viewWhere`
 * adds that time rule, and the queue counts use the same function, so a card never counts what its list does not show.
 * "to_pay" is the accepted trade-ins THIS employee can move on (the wipe, then the payout — tradeins.server
 * payoutsWhere, the "to pay" card's count; review 2026-11-12: the card counted per person, its list was everyone's).
 */
export const TRADE_IN_VIEW_STATUSES: Record<Exclude<TradeInView, "all">, readonly TradeInStatusKey[]> = {
  new: ["submitted", "estimated", "inspection_scheduled"],
  scheduled: ["inspection_scheduled"],
  inspected: ["inspected", "declined", "expired"],
  offered: ["offered"],
  accepted: ["accepted"],
  to_pay: ["accepted"],
  done: ["paid", "cancelled"],
};

/** The seven steps of the blueprint's trade-in workflow. */
export const PIPELINE_STEPS = ["valuation", "inspection", "offer", "approval", "receipt", "cost", "relisting"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * Where a trade-in stands in the workflow (0-based index of the CURRENT step): valuation until it is inspected,
 * then the offer, the customer's approval, receipt and data wipe, the cost entry (payout) and the relisting of the
 * used unit it became. `listed` = the used unit is on sale (the last step is then done: index 7).
 */
export function pipelineStep(input: { status: TradeInStatusKey; inspected: boolean; dataWiped: boolean; unitListed: boolean }): number {
  switch (input.status) {
    case "submitted":
    case "estimated":
      return 0;
    case "inspection_scheduled":
      return 1;
    case "inspected":
    case "declined":
    case "expired":
      return 2;
    case "offered":
      return 3;
    case "accepted":
      return input.dataWiped ? 5 : 4;
    case "paid":
      return input.unitListed ? 7 : 6;
    case "cancelled":
      return input.inspected ? 2 : 0;
  }
}

export type TradeInFilters = { view: TradeInView; q: string; status: TradeInStatusKey | null; from: string | null; to: string | null; page: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const cleanQuery = (value: string | null) => (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
const pageOf = (value: string | null) => {
  const n = parseWhole(value);
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};
const dayOf = (value: string | null) => {
  const text = latinDigits(value ?? "").trim();
  if (!DAY.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text ? null : text;
};
const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : null);

export function parseTradeInFilters(params: URLSearchParams): TradeInFilters {
  return {
    view: oneOf(TRADE_IN_VIEWS, params.get("view")) ?? "all",
    q: cleanQuery(params.get("q")),
    status: oneOf(TRADE_IN_STATUS_LIST, params.get("status")),
    from: dayOf(params.get("from")),
    to: dayOf(params.get("to")),
    page: pageOf(params.get("page")),
  };
}

/** The query string of a list state ("" for the defaults), for links and pagination. */
export function tradeInSearch(filters: Partial<TradeInFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "all") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type TradeInListRow = {
  id: string;
  ref: string;
  status: TradeInStatusKey;
  /** An open offer past its validity reads "expired" before anything records it. */
  offerExpired: boolean;
  createdAt: number;
  device: string;
  contactName: string | null;
  phone: PhoneView | null;
  estimate: { minIqd: number; maxIqd: number } | null;
  offerIqd: number | null;
  offerExpiresAt: number | null;
  inspectionAt: number | null;
  /** Made at the counter by staff (not through the storefront wizard). */
  counter: boolean;
  isDemo: boolean;
};

export type TradeInPage = { rows: TradeInListRow[]; total: number; page: number; pageCount: number };

/** One line of a filled-in checklist, as a screen shows it. */
export type ChecklistLineView = {
  key: string;
  label: string;
  hint: string | null;
  input: InspectionTemplateItem["input"];
  required: boolean;
  critical: boolean;
  result: ChecklistResult | null;
  value: string | number | null;
  note: string | null;
};

export type ChecklistView = {
  templateId: string | null;
  templateName: string | null;
  kind: InspectionKind;
  lines: ChecklistLineView[];
  completedAt: number | null;
  completedBy: string | null;
  /** Required items without a result. */
  missing: string[];
  /** Critical items that did not pass. */
  criticalFailed: string[];
  passed: number;
  failed: number;
};

export type TemplateOption = { id: string; kind: InspectionKind; name: string; version: number; items: InspectionTemplateItem[] };

export type ValuationLine = { key: string; amountIqd: number };
/** What the price guide says a unit in this grade with these accessories is worth (13.03). Never an offer. */
export type Valuation = {
  guideId: string;
  guideUpdatedAt: number;
  baseIqd: number;
  grade: UsedGrade;
  multiplierBps: number | null;
  gradeValueIqd: number | null;
  deductions: ValuationLine[];
  suggestedIqd: number | null;
};

export type ReferencePrice = { kind: "new" | "used"; label: string; sku: string; priceIqd: number; href: string | null };

export type HistoryEntry = { id: string; kind: string; at: number; actorKind: string; actor: string | null; data: Record<string, unknown> };

export type TradeInPhoto = { id: string; url: string; kind: "customer" | "inspection"; width: number | null; height: number | null; createdAt: number };

export type VariantChoice = { id: string; sku: string; label: string; trackSerials: boolean; priceIqd: number };

export type TradeInDetail = {
  id: string;
  ref: string;
  status: TradeInStatusKey;
  /**
   * Whether this employee sees the money (seesTradeInMoney: cost.read, or the offer / payout permissions). When false:
   * offer.amountIqd is null, no valuation, references or difference, and history amounts are replaced by
   * data.amountHidden — a paid offer is the used unit's purchase cost (follow-up 2026-11-12).
   */
  money: boolean;
  /** The payer's open POS shift a cash payout can come out of (drawerOf; follow-up 2026-11-12), else null. */
  drawer: { shiftId: string; register: string } | null;
  offerExpired: boolean;
  isDemo: boolean;
  counter: boolean;
  createdAt: number;
  updatedAt: number;
  locale: string | null;
  customer: { id: string | null; name: string | null; phone: PhoneView | null; hasAccount: boolean };
  device: { modelId: string | null; modelName: string | null; kind: InspectionKind; text: string | null; variant: VariantChoice | null };
  answers: Record<string, string>;
  preferred: { day: string | null; window: string | null; notes: string | null } | null;
  estimate: { minIqd: number; maxIqd: number; expiresAt: number | null } | null;
  inspectionAt: number | null;
  inspection: {
    serial: string | null;
    grade: UsedGrade | null;
    notes: string | null;
    included: string[];
    batteryPct: number | null;
    inspectedAt: number | null;
    inspectedBy: string | null;
    checklist: ChecklistView;
  } | null;
  ownershipOk: boolean | null;
  accountLockOk: boolean | null;
  dataWiped: boolean;
  /** amountIqd null when `money` is false. */
  offer: { amountIqd: number | null; expiresAt: number | null; offeredAt: number | null; offeredBy: string | null } | null;
  payout: { method: Payout | null; paidAt: number | null; ref: string | null };
  acceptedAt: number | null;
  declinedAt: number | null;
  declineReason: string | null;
  /** The used unit this trade-in became (after the payout). */
  usedUnit: { id: string; slug: string; status: UsedUnitStatus } | null;
  /** Where the serial typed at the inspection already appears in the registry (a unit the store sold before). */
  serialOrigin: { status: SerialStatus; orderRef: string | null; warrantyEndsAt: number | null } | null;
  /** Accessories a complete unit comes with (from the guide's deductions). */
  accessories: string[];
  valuation: Valuation | null;
  references: ReferencePrice[];
  variants: VariantChoice[];
  templates: TemplateOption[];
  /** The checklist to fill now: the kind's active template, pre-filled with the last inspection's answers by item key. */
  checklistForm: ChecklistView;
  photos: TradeInPhoto[];
  history: HistoryEntry[];
  /** Locations the unit can be put at when it is paid out (this employee's branch). */
  locations: { id: string; code: string; name: string }[];
  /** What the price difference against a chosen product would be (13.04), when ?target= was given. */
  difference: PriceDifference | null;
  can: {
    schedule: boolean;
    inspect: boolean;
    offer: boolean;
    answer: boolean;
    wipe: boolean;
    payout: boolean;
    cancel: boolean;
    photo: boolean;
    /** May confirm ownership and the account lock at the inspection (devices.ownership.verify). */
    verify: boolean;
    /** The payout needs another employee (the offer is above the guide, there is no guide, or the offerer set the guide). */
    payoutNeedsSecond: boolean;
    /** This employee made the offer. */
    ownOffer: boolean;
    /** This employee last set the guide that values the device (their offer on it is paid out by someone else). */
    ownGuide: boolean;
  };
  /** Why the offer cannot be made yet (missing inspection facts), as message keys. */
  offerBlockers: string[];
  /** Why the payout cannot be made yet, as message keys. */
  payoutBlockers: string[];
};

export type PriceDifference = { target: { kind: "new" | "used"; label: string; sku: string; priceIqd: number }; offerIqd: number; differenceIqd: number; covered: boolean };

// ───────────────────────────────────────────────────────────────── used units

export const USED_STATUS_LIST = ["intake", "testing", "ready", "listed", "reserved", "sold", "returned"] as const satisfies readonly UsedUnitStatus[];
export type UsedStatusKey = (typeof USED_STATUS_LIST)[number];
export const USED_TONE: Record<UsedStatusKey, Tone> = { intake: "warn", testing: "warn", ready: "info", listed: "ok", reserved: "info", sold: "neutral", returned: "warn" };
/** A unit's evidence may be edited only while it is not on sale. */
export const USED_EDITABLE: readonly UsedStatusKey[] = ["intake", "testing", "ready", "returned"];
export const USED_SOURCE_LIST = ["trade_in", "purchase", "return"] as const satisfies readonly UsedUnitSource[];
export const GRADE_LIST = ["A+", "A", "B", "C"] as const satisfies readonly UsedGrade[];
export const CHECK_RESULT_LIST = ["pass", "fail", "na"] as const satisfies readonly ChecklistResult[];
export const DEFECT_SEVERITY_LIST = ["minor", "moderate", "major"] as const satisfies readonly UsedDefect["severity"][];
/** Store warranty a used unit may carry, in days. */
export const MAX_USED_WARRANTY_DAYS = 365;
export const MAX_DEFECTS = 12;
export const MAX_INCLUDED = 12;

export const USED_VIEWS = ["all", "todo", "ready", "listed", "sold"] as const;
export type UsedView = (typeof USED_VIEWS)[number];
export const USED_VIEW_STATUSES: Record<Exclude<UsedView, "all">, readonly UsedStatusKey[]> = {
  todo: ["intake", "testing", "returned"],
  ready: ["ready"],
  listed: ["listed", "reserved"],
  sold: ["sold"],
};

export type UsedFilters = { view: UsedView; q: string; status: UsedStatusKey | null; grade: UsedGrade | null; page: number };

export function parseUsedFilters(params: URLSearchParams): UsedFilters {
  return {
    view: oneOf(USED_VIEWS, params.get("view")) ?? "all",
    q: cleanQuery(params.get("q")),
    status: oneOf(USED_STATUS_LIST, params.get("status")),
    grade: oneOf(GRADE_LIST, params.get("grade")),
    page: pageOf(params.get("page")),
  };
}

export function usedSearch(filters: Partial<UsedFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "all") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type UsedListRow = {
  id: string;
  slug: string;
  name: string;
  sku: string;
  grade: UsedGrade;
  status: UsedStatusKey;
  priceIqd: number;
  /** [P] only with cost.read; absent otherwise. */
  acquisitionCostIqd?: number | null;
  serial: string | null;
  source: UsedUnitSource;
  tradeInRef: string | null;
  realPhotos: number;
  checklistComplete: boolean;
  ownershipChecked: boolean;
  dataWiped: boolean;
  location: string | null;
  updatedAt: number;
  isDemo: boolean;
};

export type UsedPage = { rows: UsedListRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<UsedStatusKey, number>>; withCost: boolean };

export type UnitPhoto = { mediaId: string; fileId: string | null; url: string | null; real: boolean; published: boolean; alt: string | null; width: number | null; height: number | null; artKey: string | null };

export type UsedDetail = {
  id: string;
  slug: string;
  status: UsedStatusKey;
  isDemo: boolean;
  source: UsedUnitSource;
  name: string;
  productId: string;
  productKind: string;
  productSlug: string;
  sku: string;
  variantId: string;
  serial: { id: string; serial: string; status: SerialStatus } | null;
  grade: UsedGrade;
  batteryHealthPct: number | null;
  cosmeticNotes: { ar: string; en: string; ckb: string };
  defects: { area: string; severity: UsedDefect["severity"]; note: { ar: string; en: string; ckb: string } }[];
  included: { key: string; label: { ar: string; en: string; ckb: string } }[];
  warrantyDays: number;
  priceIqd: number;
  /** [P] only with cost.read; absent otherwise. */
  acquisitionCostIqd?: number | null;
  /** [P] margin in basis points: only with cost.read AND profit.read. */
  marginBps?: number | null;
  newPriceIqd: number;
  location: { id: string; code: string; name: string } | null;
  tradeIn: { id: string; ref: string } | null;
  ownership: { at: number | null; by: string | null };
  wipe: { at: number | null; by: string | null };
  listedAt: number | null;
  soldAt: number | null;
  soldOrderRef: string | null;
  checklist: ChecklistView;
  templates: TemplateOption[];
  /** The checklist to fill now: the kind's active template, pre-filled with the unit's answers by item key. */
  checklistForm: ChecklistView;
  photos: UnitPhoto[];
  /** Region and platform facts of a game (13.05): from the catalogue. */
  game: { region: string | null; platform: string | null; mediaFormat: MediaFormat | null; compatibility: { target: string; status: string }[] } | null;
  pricing: { canEdit: boolean; pending: boolean };
  history: HistoryEntry[];
  /** What still keeps the unit from being listed, as message keys (empty = it can be listed). */
  listBlockers: string[];
  can: { inspect: boolean; grade: boolean; photo: boolean; verify: boolean; list: boolean; unlist: boolean; price: boolean; editable: boolean };
};

// ───────────────────────────────────────────────────────────────── registry (13.01)

export const SERIAL_STATUS_LIST = ["in_stock", "reserved", "sold", "returned", "in_repair", "scrapped", "intake"] as const satisfies readonly SerialStatus[];
export const SERIAL_TONE: Record<(typeof SERIAL_STATUS_LIST)[number], Tone> = { in_stock: "ok", reserved: "info", sold: "neutral", returned: "warn", in_repair: "warn", scrapped: "bad", intake: "warn" };
export const SERIAL_SOURCE_LIST = ["purchase", "trade_in"] as const satisfies readonly SerialSource[];
export const CONDITION_LIST = ["new", "used"] as const;
export type Condition = (typeof CONDITION_LIST)[number];

export type RegistryFilters = { q: string; status: SerialStatus | null; source: SerialSource | null; condition: Condition | null; page: number };

export function parseRegistryFilters(params: URLSearchParams): RegistryFilters {
  return {
    q: cleanQuery(params.get("q")),
    status: oneOf(SERIAL_STATUS_LIST, params.get("status")),
    source: oneOf(SERIAL_SOURCE_LIST, params.get("source")),
    condition: oneOf(CONDITION_LIST, params.get("condition")),
    page: pageOf(params.get("page")),
  };
}

export function registrySearch(filters: Partial<RegistryFilters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.condition) params.set("condition", filters.condition);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type RegistrySource =
  | { kind: "receipt"; receiptRef: string | null; poRef: string | null; supplier: string | null }
  | { kind: "trade_in"; tradeInRef: string | null }
  | { kind: "opening"; note: string | null }
  | { kind: "other"; ref: string | null };

export type RegistryRow = {
  id: string;
  serial: string;
  name: string;
  sku: string;
  status: SerialStatus;
  condition: Condition;
  grade: UsedGrade | null;
  usedUnitId: string | null;
  source: RegistrySource;
  location: string | null;
  orderRef: string | null;
  updatedAt: number;
  /** [P] only with cost.read; absent otherwise. */
  costIqd?: number | null;
};

export type RegistryPage = { rows: RegistryRow[]; total: number; page: number; pageCount: number; withCost: boolean; counts: { new: number; used: number } };

export type RegistryDetail = RegistryRow & {
  createdAt: number;
  notes: string | null;
  usedUnit: { id: string; slug: string; status: UsedStatusKey; grade: UsedGrade } | null;
  tradeIns: { ref: string; status: TradeInStatusKey; at: number }[];
  orders: { ref: string; attachedAt: number; releasedAt: number | null }[];
  warranties: { id: string; status: string; endsAt: number }[];
  /** Only with inventory.movement.read; cost per movement only with cost.read. */
  movements?: { id: string; kind: string; qtyDelta: number; refType: string | null; refId: string | null; at: number; location: string | null; unitCostIqd?: number | null }[];
};

// ───────────────────────────────────────────────────────────────── inspection templates, price guides

export const INSPECTION_KIND_LIST = ["console", "handheld_pc", "controller", "headset", "other", "game"] as const satisfies readonly InspectionKind[];
export const INPUT_LIST = ["pass_fail", "percent", "text"] as const satisfies readonly InspectionTemplateItem["input"][];
export const MAX_TEMPLATE_ITEMS = 30;
/** Blank rows a template form offers for new items (the form works without JavaScript). */
export const NEW_TEMPLATE_ROWS = 3;

export type TemplateSummary = { id: string; kind: InspectionKind; name: string; version: number; items: number; critical: number; updatedAt: number; updatedBy: string | null };
export type TemplateEditor = {
  kind: InspectionKind;
  current: { id: string; kind: InspectionKind; version: number; items: InspectionTemplateItem[]; name: { ar: string; en: string; ckb: string }; updatedAt: number } | null;
  versions: { id: string; version: number; isActive: boolean; updatedAt: number }[];
};

/** Grade multipliers are basis points of the base price (10,000 = 100 %). */
export const MAX_MULTIPLIER_BPS = 12_000;
export const MAX_GUIDE_BASE_IQD = 50_000_000;
export const MAX_DEDUCTIONS = 12;
export const NEW_DEDUCTION_ROWS = 3;

export type GuideRow = {
  id: string;
  modelId: string;
  model: string;
  modelSlug: string;
  variant: { id: string; sku: string } | null;
  baseIqd: number;
  multipliers: Partial<Record<UsedGrade, number>>;
  deductions: { key: string; amountIqd: number }[];
  isActive: boolean;
  updatedAt: number;
  updatedBy: string | null;
};

export type ModelOption = { id: string; slug: string; name: string; kind: string; platform: string };

// ───────────────────────────────────────────────────────────────── digital (13.06, 13.07)

export const LICENSE_TYPE_LIST = ["game_key", "subscription", "wallet_topup", "dlc", "account"] as const satisfies readonly LicenseType[];
export const MEDIA_FORMAT_LIST = ["physical", "digital"] as const satisfies readonly MediaFormat[];
export const CODE_STATUS_LIST = ["available", "reserved", "delivered", "revoked", "expired"] as const satisfies readonly DigitalCodeStatus[];
export const CODE_TONE: Record<(typeof CODE_STATUS_LIST)[number], Tone> = { available: "ok", reserved: "info", delivered: "neutral", revoked: "bad", expired: "neutral" };
/** Codes per import, and the longest code accepted. */
export const MAX_CODES_PER_IMPORT = 500;
export const MAX_CODE_LENGTH = 120;

/** How a product is delivered (13.06): what the catalogue says, read together. */
export const DELIVERY_CLASSES = ["disc", "cartridge", "code", "subscription", "wallet_topup", "dlc", "account", "unclassified"] as const;
export type DeliveryClass = (typeof DELIVERY_CLASSES)[number];

export type ClassRow = { cls: DeliveryClass; products: number; variants: number };
export type DigitalVariantRow = {
  variantId: string;
  productId: string;
  name: string;
  sku: string;
  cls: DeliveryClass;
  licenseType: LicenseType | null;
  isActive: boolean;
  codes: Partial<Record<(typeof CODE_STATUS_LIST)[number], number>>;
};
export type UnclassifiedRow = { productId: string; name: string; kind: string; problem: "digital_without_license" | "game_without_format" | "license_on_physical" };
export type DigitalOverview = { classes: ClassRow[]; variants: DigitalVariantRow[]; problems: UnclassifiedRow[]; canManage: boolean; canEditCatalog: boolean };

export type CodeRow = {
  id: string;
  status: (typeof CODE_STATUS_LIST)[number];
  createdAt: number;
  createdBy: string | null;
  expiresAt: number | null;
  orderRef: string | null;
  orderPaid: boolean;
  /** Delivered on a paid order line that was not refunded: the only codes staff may reveal (13.07). */
  revealable: boolean;
  deliveredAt: number | null;
  revealCount: number;
  isDemo: boolean;
  /** [P] only with cost.read; absent otherwise. */
  costIqd?: number | null;
};
export type CodePage = {
  variant: { id: string; sku: string; name: string; licenseType: LicenseType | null; mediaFormat: MediaFormat | null; isActive: boolean };
  rows: CodeRow[];
  counts: Partial<Record<(typeof CODE_STATUS_LIST)[number], number>>;
  total: number;
  page: number;
  pageCount: number;
  status: (typeof CODE_STATUS_LIST)[number] | null;
  withCost: boolean;
  canReveal: boolean;
};

// ───────────────────────────────────────────────────────────────── home

export type QueueCounts = {
  /** New requests to schedule or inspect (tradein.inspect). */
  toInspect: number | null;
  /** Inspected, waiting for a final offer (tradein.offer). */
  toOffer: number | null;
  /** Offers out and not answered. */
  awaitingAnswer: number | null;
  /** Accepted, waiting for the data wipe or the payout (tradein.payout / ownership.verify). */
  toPay: number | null;
  /** Used units to inspect or re-inspect (used.inspect). */
  unitsToInspect: number | null;
  /** Used units ready, not listed (used.list). */
  toList: number | null;
};
