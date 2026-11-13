/**
 * The checkout form, client-safe and pure (no React, no server imports): the steps, the draft the shopper fills in,
 * the instant field checks that mirror the commerce core's own rules (CheckoutInput in
 * ~/server/services/orders/place.server — the server checks everything again), the mapping of server field errors to
 * steps, and the per-tab draft store (sessionStorage) that keeps the form through a reload, a language switch and Back.
 *
 * Field checks return an ISSUE — a message key under `fields.<field>.<code>` in the "checkout" namespace plus the
 * numbers it needs — never a sentence, so the page words it in the shopper's language.
 */
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import type { PreferredWindow } from "~/server/services/orders/types";

export const STEPS = ["address", "payment", "review"] as const;
export type Step = (typeof STEPS)[number];

/** The step in a `?step=` search string; anything unknown is the first step. */
export function stepOf(search: string | URLSearchParams): Step {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get("step");
  return (STEPS as readonly string[]).includes(value ?? "") ? (value as Step) : "address";
}

export const stepIndex = (step: Step): number => STEPS.indexOf(step);

/**
 * Where focus goes when the page shows `step`, having last shown `previous` (null: nothing yet): the new step's heading,
 * or the field a refused «تابع» sends the shopper to (`requested`) — and nowhere when the step did not change. The first
 * render leaves focus where the browser put it (the skip link and the checkout bar come first on Tab), and so does a
 * second run of the same effect (React StrictMode runs a mount effect twice; any re-run is not a step change). Pure.
 */
export function stepFocusTarget<F extends string>(previous: Step | null, step: Step, requested: F | "heading" | null): F | "heading" | null {
  if (previous === null || previous === step) return null;
  return requested ?? "heading";
}

/** The checkout methods, in the order the payment step lists them. */
export const PAYMENT_METHODS = ["cod", "wallet", "bank_transfer", "zaincash"] as const;
export type CheckoutMethod = (typeof PAYMENT_METHODS)[number];
export const isTransferMethod = (method: string | null | undefined): method is "bank_transfer" | "zaincash" => method === "bank_transfer" || method === "zaincash";

export const WINDOWS: readonly PreferredWindow[] = ["morning", "afternoon", "evening", "any"];

/** The district select's "my district is not in the list" choice. It is sent to the server as "" (no district). */
export const OTHER_DISTRICT = "other";

/** What the shopper types and picks. Strings exactly as in the fields; the server normalises. */
export type CheckoutDraft = {
  contactName: string;
  phone: string;
  governorateId: string;
  /** "" = not chosen yet, OTHER_DISTRICT = not in the list, else a district id. */
  districtId: string;
  areaText: string;
  addressText: string;
  notes: string;
  /** "" = no preference, else YYYY-MM-DD (one of the offered days). */
  preferredDay: string;
  /** "" = no preference. */
  preferredWindow: string;
  /** "" = not chosen yet. */
  paymentMethod: string;
  /** Never pre-checked. */
  marketingConsent: boolean;
  /** Signed-in customers: add this address to the address book once the order exists. Never pre-checked. */
  saveAddress: boolean;
  /** Signed-in customers: points to redeem, as typed ("" = none). The server prices what may be redeemed. */
  redeemPoints: string;
  /** A friend's referral code (optional). It changes no price. */
  referralCode: string;
  /** Signed-in customers whose balance is below the total: pay the balance from the wallet, the rest by the chosen method. */
  useWallet: boolean;
};

export type FieldName = keyof CheckoutDraft;

export const EMPTY_DRAFT: CheckoutDraft = {
  contactName: "",
  phone: "",
  governorateId: "",
  districtId: "",
  areaText: "",
  addressText: "",
  notes: "",
  preferredDay: "",
  preferredWindow: "",
  paymentMethod: "",
  marketingConsent: false,
  saveAddress: false,
  redeemPoints: "",
  referralCode: "",
  useWallet: false,
};

/** The draft's yes/no fields (a checkbox each). */
const FLAGS = new Set<FieldName>(["marketingConsent", "saveAddress", "useWallet"]);

/**
 * Fields in the order they appear (the first one with a problem takes the focus). The delivery step ends with the
 * marketing consent and, for signed-in customers, "save this address" (Design System v2 §6.10).
 */
export const ADDRESS_FIELDS = ["phone", "contactName", "governorateId", "districtId", "areaText", "addressText", "notes", "preferredDay", "preferredWindow", "marketingConsent", "saveAddress"] as const satisfies readonly FieldName[];
/** The payment step: the method, the wallet's part of a split payment, the points to redeem. */
export const PAYMENT_FIELDS = ["paymentMethod", "useWallet", "redeemPoints"] as const satisfies readonly FieldName[];
/** The review step: the referral code (next to the summary). */
export const REVIEW_FIELDS = ["referralCode"] as const satisfies readonly FieldName[];

export function stepOfField(field: string): Step {
  if ((ADDRESS_FIELDS as readonly string[]).includes(field)) return "address";
  if ((PAYMENT_FIELDS as readonly string[]).includes(field)) return "payment";
  return "review";
}

/** A problem with one field: `fields.<field>.<code>` in the checkout namespace, with `count` for plural messages. */
export type FieldIssue = { code: string; count?: number };
export type FieldIssues = Partial<Record<FieldName, FieldIssue>>;

/** Limits of CheckoutInput (place.server.ts) — the same numbers, so the page and the server agree. */
export const LIMITS = { contactName: 100, phone: 40, areaMin: 2, area: 200, addressMin: 5, address: 500, notes: 500 } as const;

/**
 * Why a phone number is not an Iraqi mobile number, as precisely as the digits allow — or null when it is one
 * (normalizeIraqPhone accepts it). DESIGN.md §11 #5: "ينقص الرقم 4 أرقام. اكتبه مثل 0770 123 4567."
 */
export function phoneIssue(raw: string): FieldIssue | null {
  const text = raw.trim();
  if (text === "") return { code: "required" };
  if (normalizeIraqPhone(text)) return null;
  const latin = toLatinDigits(text);
  if (/[^\d\s+()\-.]/.test(latin)) return { code: "chars" };
  let digits = latin.replace(/\D/g, "");
  const international = latin.trim().startsWith("+") || digits.startsWith("00964") || digits.startsWith("964");
  if (digits.startsWith("00964")) digits = digits.slice(5);
  else if (digits.startsWith("964")) digits = digits.slice(3);
  // The national number with its leading 0: 07XX XXX XXXX (11 digits).
  const national = international ? `0${digits.replace(/^0/, "")}` : digits.startsWith("0") ? digits : `0${digits}`;
  if (!national.startsWith("07")) return { code: "prefix" };
  if (national.length < 11) return { code: "short", count: 11 - national.length };
  if (national.length > 11) return { code: "long", count: national.length - 11 };
  // Eleven digits starting 07 but not a mobile range (073–079).
  return { code: "range" };
}

export type ValidationContext = {
  /** District ids of the chosen governorate (an empty list: the governorate has none, so none is asked for). */
  districtIds: readonly string[];
  /** The preferred days on offer. */
  days: readonly string[];
  /** Payment methods the shopper may choose right now. */
  methods: readonly string[];
  /** The wallet covers the total (signed-in customers only). */
  walletEnough: boolean;
  /** The most points this cart can redeem now (0 = none: a guest, no balance). Optional for older callers. */
  pointsMax?: number;
};

/** Points as typed: Latin or Arabic-Indic digits, separators allowed; "" is 0; anything else null. Pure. */
export function parsePoints(text: string): number | null {
  const latin = toLatinDigits(text.trim()).replace(/[\s,٬،']/g, "");
  if (latin === "") return 0;
  if (!/^\d{1,8}$/.test(latin)) return null;
  return Number(latin);
}

const length = (value: string) => value.trim().length;

/** One field's problem, or null. */
export function validateField(name: FieldName, draft: CheckoutDraft, context: ValidationContext): FieldIssue | null {
  switch (name) {
    case "phone":
      return draft.phone.length > LIMITS.phone ? { code: "long_text" } : phoneIssue(draft.phone);
    case "contactName":
      return length(draft.contactName) > LIMITS.contactName ? { code: "too_long", count: LIMITS.contactName } : null;
    case "governorateId":
      return draft.governorateId ? null : { code: "required" };
    case "districtId":
      if (context.districtIds.length === 0) return null;
      if (!draft.districtId) return { code: "required" };
      return draft.districtId === OTHER_DISTRICT || context.districtIds.includes(draft.districtId) ? null : { code: "invalid" };
    case "areaText":
      if (length(draft.areaText) === 0) return { code: "required" };
      if (length(draft.areaText) < LIMITS.areaMin) return { code: "too_short" };
      return length(draft.areaText) > LIMITS.area ? { code: "too_long", count: LIMITS.area } : null;
    case "addressText":
      if (length(draft.addressText) === 0) return { code: "required" };
      if (length(draft.addressText) < LIMITS.addressMin) return { code: "too_short" };
      return length(draft.addressText) > LIMITS.address ? { code: "too_long", count: LIMITS.address } : null;
    case "notes":
      return length(draft.notes) > LIMITS.notes ? { code: "too_long", count: LIMITS.notes } : null;
    case "preferredDay":
      return draft.preferredDay === "" || context.days.includes(draft.preferredDay) ? null : { code: "invalid" };
    case "preferredWindow":
      return draft.preferredWindow === "" || (WINDOWS as readonly string[]).includes(draft.preferredWindow) ? null : { code: "invalid" };
    case "paymentMethod":
      if (!draft.paymentMethod) return { code: "required" };
      if (!context.methods.includes(draft.paymentMethod)) return { code: "unavailable" };
      return draft.paymentMethod === "wallet" && !context.walletEnough ? { code: "wallet_insufficient" } : null;
    case "redeemPoints": {
      const points = parsePoints(draft.redeemPoints);
      if (points === null) return { code: "invalid" };
      const max = context.pointsMax ?? 0;
      return points > max ? { code: "too_many", count: max } : null;
    }
    case "referralCode":
      return draft.referralCode.trim().length > 40 ? { code: "too_long", count: 40 } : null;
    case "marketingConsent":
    case "saveAddress":
    case "useWallet":
      return null;
  }
}

const FIELDS_OF: Record<Step, readonly FieldName[]> = { address: ADDRESS_FIELDS, payment: PAYMENT_FIELDS, review: REVIEW_FIELDS };

/** Every problem of one step (and, for "review", of the whole form). */
export function validateStep(step: Step, draft: CheckoutDraft, context: ValidationContext): FieldIssues {
  const names = step === "review" ? [...ADDRESS_FIELDS, ...PAYMENT_FIELDS, ...REVIEW_FIELDS] : FIELDS_OF[step];
  const issues: FieldIssues = {};
  for (const name of names) {
    const issue = validateField(name, draft, context);
    if (issue) issues[name] = issue;
  }
  return issues;
}

/** The first field (in page order) that has a problem. */
export function firstIssue(issues: FieldIssues): FieldName | null {
  for (const name of [...ADDRESS_FIELDS, ...PAYMENT_FIELDS, ...REVIEW_FIELDS]) if (issues[name]) return name;
  return null;
}

/** The earliest step whose fields have a problem, or null. */
export function firstStepWithIssue(issues: FieldIssues): Step | null {
  const field = firstIssue(issues);
  return field ? stepOfField(field) : null;
}

/**
 * Server field errors (`{ phone: "phone_invalid", districtId: "district_invalid" }`, keys of the errors namespace)
 * as issues of this form. Unknown fields are dropped (they are reported as the form-level code).
 */
export function issuesFromServer(fields: Record<string, string> | undefined | null): FieldIssues {
  const issues: FieldIssues = {};
  if (!fields) return issues;
  for (const [raw, key] of Object.entries(fields)) {
    // the server's name for the wallet part of a split payment is this form's «use my wallet» box
    const field = raw === "walletIqd" ? "useWallet" : raw;
    if (!(field in EMPTY_DRAFT)) continue;
    issues[field as FieldName] = { code: `server.${key}` };
  }
  return issues;
}

/**
 * The fields placeOrder reads, as form values (what the page submits and what a no-script form posts). `walletIqd`:
 * the wallet's part of a split payment (the page sends the balance when «use my wallet» is ticked; the server checks
 * it again).
 */
export function draftToForm(draft: CheckoutDraft, extra: { idempotencyKey: string; expectedTotalIqd: number; walletIqd?: number }): Record<string, string> {
  const points = parsePoints(draft.redeemPoints) ?? 0;
  return {
    redeemPoints: points > 0 ? String(points) : "",
    referralCode: draft.referralCode.trim(),
    walletIqd: draft.useWallet && draft.paymentMethod !== "wallet" && (extra.walletIqd ?? 0) > 0 ? String(extra.walletIqd) : "",
    intent: "place",
    idempotencyKey: extra.idempotencyKey,
    expectedTotalIqd: String(extra.expectedTotalIqd),
    contactName: draft.contactName.trim(),
    phone: draft.phone.trim(),
    governorateId: draft.governorateId,
    districtId: draft.districtId === OTHER_DISTRICT ? "" : draft.districtId,
    areaText: draft.areaText.trim(),
    addressText: draft.addressText.trim(),
    notes: draft.notes.trim(),
    preferredDay: draft.preferredDay,
    preferredWindow: draft.preferredWindow,
    paymentMethod: draft.paymentMethod,
    marketingConsent: draft.marketingConsent ? "on" : "",
    saveAddress: draft.saveAddress ? "on" : "",
  };
}

/**
 * The option value of a cart or order line, without the product's name it repeats — Design System v2 §4.13 ("the
 * option value only"): the catalogue's variant titles read "<name> — <option>" («Nintendo Switch 2 — النسخة الدولية»,
 * «DualSense – أحمر Cosmic Red»). When the part before the first spaced dash is (part of) the product's name, only the
 * part after it is the option; anything else is shown whole. Pure.
 */
export function optionValue(name: string, label: string | null | undefined): string | null {
  const text = label?.trim();
  if (!text) return null;
  const match = /\s[—–-]\s/.exec(text);
  if (!match) return text === name.trim() ? null : text;
  const head = text.slice(0, match.index).trim().toLocaleLowerCase();
  const rest = text.slice(match.index + match[0].length).trim();
  const own = name.trim().toLocaleLowerCase();
  return head.length > 0 && rest.length > 0 && (own.includes(head) || head.includes(own)) ? rest : text;
}

/**
 * An order line's name as sold, split into the product's name and its option value (§4.13: summaries show the option
 * value only). The commerce core snapshots a variant's line as "<product name> — <option>" (orders/place.server
 * `lineName`; product names never contain " — "), so the text before the first spaced em dash is the name and the rest
 * is the option («Nintendo Switch 2 — النسخة الدولية» → «Nintendo Switch 2» + «النسخة الدولية»). A name without that
 * joint is the name alone. Pure.
 */
export function splitLineName(name: string): { name: string; option: string | null } {
  const at = name.indexOf(" — ");
  const head = at > 0 ? name.slice(0, at).trim() : "";
  const rest = at > 0 ? name.slice(at + 3).trim() : "";
  return head && rest ? { name: head, option: optionValue(head, rest) } : { name, option: null };
}

/**
 * The intent of the small read the cart and the checkout answer after /api/cart refused a code for its minimum — how
 * much more the cart needs (checkout.server answerCouponMinimum; client round 1, QA). Client-safe: the routes'
 * `shouldRevalidate` and the coupon field read it.
 */
export const COUPON_MINIMUM_INTENT = "coupon-minimum";

// ───────────────────────────────────────────────────────────────── stock: what the checkout can still do

/** Line problems that keep a line out of the money and out of an order (the cart service's blocking problems). */
export const BLOCKING_PROBLEMS: ReadonlySet<string> = new Set(["out_of_stock", "unavailable"]);

/** A cart line as the stock rules read it. */
export type StockLine = { id: string; name: string; qty: number; problem: string | null };

const blocking = (line: Pick<StockLine, "problem">) => line.problem !== null && BLOCKING_PROBLEMS.has(line.problem);

/**
 * What the checkout can do with the cart as priced now (client round 1, QA: after a lost stock race the page showed a
 * total of 0 with «تابع إلى الدفع» still active, and the server refuses an order of nothing):
 *   "ready"    every line can be bought — the steps go on;
 *   "blocked"  some lines cannot be bought (sold out, off sale): they leave the cart before any step goes on;
 *   "empty"    nothing in the cart can be bought — no step key at all, the way back to the store.
 * Pure.
 */
export function cartReadiness(lines: readonly Pick<StockLine, "qty" | "problem">[]): "ready" | "blocked" | "empty" {
  const buyable = lines.filter((line) => line.qty > 0 && !blocking(line));
  if (buyable.length === 0) return "empty";
  return buyable.length < lines.length ? "blocked" : "ready";
}

/** One line a stock change touched: sold out (or off sale) — it cannot be bought —, or its quantity came down. */
export type StockChange = { id: string; name: string; change: "sold_out" | "unavailable" | "reduced"; /** The quantity the shopper saw (null: not known). */ from: number | null; to: number };

/**
 * What the stock did to a cart, line by line: the lines that can no longer be bought and those whose quantity came down
 * to what is left (the cart service already shows the reduced quantity). `before` is the cart the shopper last saw —
 * the quantity they chose is then said; null when it is not known. A reduced line whose quantity the shopper already
 * saw is no news. Pure.
 */
export function stockChanges(before: readonly Pick<StockLine, "id" | "qty">[] | null, after: readonly StockLine[]): StockChange[] {
  const seen = new Map((before ?? []).map((line) => [line.id, line.qty]));
  const out: StockChange[] = [];
  for (const line of after) {
    const from = seen.get(line.id) ?? null;
    if (blocking(line)) out.push({ id: line.id, name: line.name, change: line.problem === "unavailable" ? "unavailable" : "sold_out", from, to: 0 });
    else if (line.problem === "qty_reduced" && (from === null || from > line.qty)) out.push({ id: line.id, name: line.name, change: "reduced", from, to: line.qty });
  }
  return out;
}

/**
 * The five real stages an order goes through (Design System v2 §6.11, "what happens next"): received · confirmed ·
 * preparing · on the way · delivered. The 0-based stage an order is at, or null when it left the path (cancelled,
 * returned). Waiting for a transfer or for its check is still "received": nothing is confirmed before a person has
 * checked the money. Pure.
 */
export const ORDER_STAGES = ["received", "confirmed", "preparing", "shipped", "delivered"] as const;
export function orderStage(status: string): number | null {
  switch (status) {
    case "new":
    case "awaiting_payment":
    case "payment_review":
      return 0;
    case "confirmed":
      return 1;
    case "preparing":
      return 2;
    case "shipped":
      return 3;
    case "delivered":
      return 4;
    default:
      return null;
  }
}

/**
 * A number to transfer to, grouped for reading aloud and copying by eye (§4.24: «9269 3174 27»): a card number in
 * fours; an Iraqi mobile number as it is written (0771 906 1852). Digits only in, digits and spaces out; anything that
 * is not all digits is returned as it is. The copy key always copies the plain digits. Pure.
 */
export function groupDigits(value: string, kind: "card" | "phone"): string {
  const digits = value.replace(/\s+/g, "");
  if (!/^\d+$/.test(digits)) return value;
  if (kind === "phone" && digits.length === 11) return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/**
 * An order reference as typed ("tt-7k4m2q9x ") in its stored form ("TT-7K4M2Q9X"), or null — the same shape
 * normalizeOrderRef (orders/manage.server) accepts, so the page can say "check the number" before asking the server.
 */
export function cleanOrderRef(value: string): string | null {
  const ref = toLatinDigits(value).trim().toUpperCase();
  return /^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(ref) ? ref : null;
}

/**
 * A whole number of dinars typed by a person: Latin or Arabic-Indic digits, thousands separators (comma, Arabic comma
 * and thousands sign, space) allowed. A decimal point is refused rather than guessed: "12.5" is not 125.
 */
export function parseAmountInput(text: string): number | null {
  const latin = toLatinDigits(text.trim()).replace(/[\s,٬،']/g, "");
  if (!/^\d{1,10}$/.test(latin)) return null;
  const value = Number(latin);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An idempotency key for one checkout attempt: 128 random bits, URL-safe (what placeOrder accepts: 22–128 chars). */
export function newAttemptKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isAttemptKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(value);

// ───────────────────────────────────────────────────────────────── the draft store (one browser tab)

/**
 * What the tab remembers: the fields, the attempt key, and — after "confirm" was pressed — that key again as
 * `submittedKey`, so a page that comes back after a lost answer can ask the server for the order that key placed
 * (placeOrder answers a repeat with the first order). The key belongs to one cart (`cartId`): a later checkout of
 * another cart gets a new key, so a key that already placed an order is never sent for different goods.
 * sessionStorage: one tab, gone when the tab closes; cleared by the order page once the order exists. Every access is
 * guarded (private windows and blocked storage throw).
 */
export type StoredCheckout = { v: 1; draft: CheckoutDraft; key: string; submittedKey: string | null; cartId: string | null; savedAt: number };

/**
 * The attempt key to use now: the stored one while it belongs to this cart (or the cart is gone — a lost answer is
 * being recovered), a fresh one when the stored key was made for another cart. Pure.
 */
export function attemptFor(stored: Pick<StoredCheckout, "key" | "submittedKey" | "cartId">, currentCartId: string | null, fresh: () => string): { key: string; submittedKey: string | null } {
  if (stored.cartId && currentCartId && stored.cartId !== currentCartId) return { key: fresh(), submittedKey: null };
  return { key: stored.key, submittedKey: stored.submittedKey };
}

export const DRAFT_STORAGE_KEY = "tt:checkout";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps only known fields of the right type (a stored draft is input like any other). */
export function cleanDraft(value: unknown): CheckoutDraft {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: CheckoutDraft = { ...EMPTY_DRAFT };
  for (const name of Object.keys(EMPTY_DRAFT) as FieldName[]) {
    const item = source[name];
    if (FLAGS.has(name)) (out as Record<string, unknown>)[name] = item === true;
    else if (typeof item === "string") (out as Record<string, unknown>)[name] = item.slice(0, 600);
  }
  return out;
}

const posted = (value: string | undefined) => value === "on" || value === "true";

/** The fields of a plain form post (a page rendered without script), as a draft. */
export function draftFromPosted(values: Record<string, string>): CheckoutDraft {
  return cleanDraft({ ...values, marketingConsent: posted(values.marketingConsent), saveAddress: posted(values.saveAddress), useWallet: posted(values.useWallet), preferredWindow: values.preferredWindow === "any" ? "" : values.preferredWindow });
}

/**
 * A draft whose preferred day is one of the days on offer now — else no day (a draft kept from a visit that offered
 * days, or days the owner switched off since). The preference is never a requirement, so nothing is asked again. Pure.
 */
export function withOfferedDay(draft: CheckoutDraft, days: readonly string[]): CheckoutDraft {
  return draft.preferredDay === "" || days.includes(draft.preferredDay) ? draft : { ...draft, preferredDay: "" };
}

export function readStoredCheckout(): StoredCheckout | null {
  try {
    const raw = storage()?.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCheckout>;
    if (parsed?.v !== 1 || !isAttemptKey(parsed.key)) return null;
    return {
      v: 1,
      draft: cleanDraft(parsed.draft),
      key: parsed.key,
      submittedKey: isAttemptKey(parsed.submittedKey) ? parsed.submittedKey : null,
      cartId: typeof parsed.cartId === "string" && parsed.cartId.length <= 128 ? parsed.cartId : null,
      savedAt: Number(parsed.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function writeStoredCheckout(value: Omit<StoredCheckout, "v" | "savedAt">): void {
  try {
    storage()?.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, ...value, savedAt: Date.now() }));
  } catch {
    // Full or blocked storage: the form still works, it is just not kept across a reload.
  }
}

export function clearStoredCheckout(): void {
  try {
    storage()?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}
