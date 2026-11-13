import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { data, Form, redirect, useNavigate, useNavigation, useSearchParams, useSubmit, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/checkout";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import { randomToken } from "~/lib/ids";
import { localePath } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getDefaultAddress } from "~/server/services/account/addresses.server";
import { getCartView } from "~/server/services/cart.server";
import { useCartEditor } from "~/ui/cart-client";
import { EmptyState } from "~/ui/EmptyState";
import { FormErrorSummary } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { OrderSummary } from "~/ui/OrderSummary";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText, isIqd } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { TrustStrip } from "~/ui/TrustStrip";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import {
  attemptFor,
  BLOCKING_PROBLEMS,
  cartReadiness,
  COUPON_MINIMUM_INTENT,
  draftFromPosted,
  draftToForm,
  EMPTY_DRAFT,
  firstIssue,
  issuesFromServer,
  newAttemptKey,
  parsePoints,
  readStoredCheckout,
  stepFocusTarget,
  stepIndex,
  stepOf,
  stepOfField,
  STEPS,
  stockChanges,
  validateField,
  validateStep,
  withOfferedDay,
  writeStoredCheckout,
  type CheckoutDraft,
  type FieldIssues,
  type FieldName,
  type Step,
  type StockChange,
  type ValidationContext,
} from "./checkout-form";
import {
  addressPrefill,
  answerCouponMinimum,
  cartTokenOf,
  confirmationPath,
  couponShortfall,
  loadCheckoutData,
  nationalPhone,
  NO_STORE,
  placeCheckout,
  recordPurchase,
  saveCheckoutAddress,
  wantsAddressSaved,
  type CheckoutFailure,
  type SavedAddressPrefill,
} from "./checkout.server";
import type { FlashPriceView } from "~/server/services/orders/types";
import { Adjustments, summaryCoupon, withFlash } from "./components/Adjustments";
import { AddressStep, fieldId, NOJS_GOVERNORATE_ID, PaymentStep, ReviewStep, withOptionValue } from "./components/CheckoutSteps";
import { CommitKey } from "./components/CommitKey";
import { CouponForm, couponIssueText, type CartWithIssue } from "./components/CouponForm";
import { StockNotice } from "./components/StockNotice";
import { SummaryBar } from "./components/SummaryBar";
import { useRemoveUnbuyable } from "./components/useRemoveUnbuyable";
import "./checkout.css";

/**
 * /checkout — guest checkout by default (Design System v2 §6.10; brief §4, §14; v2.1 «Clay & Glass», client note 8).
 * The checkout shell (§5.8): ONE bar — back to the cart · the mascot · the step rail «1 التوصيل · 2 الدفع · 3 المراجعة» ·
 * «طلب تجريبي» · help — drawn by the shell from this route's handle (`chrome: "checkout"`) and `?step=`; the page draws no
 * rail of its own. Below 1024 a 48px summary bar (the total, the items on demand) sits under it and the glass task bar
 * holds «الإجمالي» and the step's one glossy primary; from 1024 the form takes 7 columns and the sticky summary 5, with
 * the primary inside the card.
 *
 * The page (client note 8 — "more arrangement", the before's notes): the step's question is the h1; side information is
 * the kit's Note (the guest note «أكمل الطلب بدون حساب.» with «سجّل الدخول ←» on its own line, the delivery fee under
 * the governorate, the transfer rule, the demo-order line); each step's fields sit in soft section cards with an icon
 * head (CheckoutSteps); one spacing scale (checkout.css).
 *
 * Three steps on one route, the step in the URL (`?step=address|payment|review`) so Back walks the steps and a step can
 * be linked; moving between them is the sideways push of the motion grammar and needs no request. The form's state lives
 * in the page (it survives a language switch) and in this tab's sessionStorage (a reload, the cart and back); it is
 * cleared once the order exists.
 *
 * Checks are instant and specific (on blur, again on every keystroke once a problem shows); «تابع» checks the step,
 * lists what to fix in one alert above the form and moves focus to the first field. The server checks everything
 * again — placeOrder prices the cart itself and refuses a total the shopper did not see (totals_changed, with the
 * fresh cart). The attempt key is made once per checkout and resent on a retry, so a double press, a reload or a lost
 * answer can never place two orders. The review edits the cart in place (quantities, removal with undo — the kit's cart
 * editor, priced for the chosen governorate).
 *
 * Stock (client round 1, QA: after a lost race the page showed a total of 0 with «تابع إلى الدفع» still active): every
 * step's key works only while every line can be bought (`cartReadiness`). Lines that cannot are named in one warning
 * note with «أزل غير المتوفر»; a refusal at «أكّد الطلب» takes the sold-out lines out (no undo row: there is nothing to
 * put back) and says by name what sold out or came down, and the total now; nothing left to buy is the empty state with
 * the way back to the store — never a key that leads nowhere. Signing in is offered, never required; the wallet appears
 * only for signed-in customers. Without script all three steps show and one plain post places the order through the
 * same action.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const request = { cartToken: cartTokenOf(ctx), customerId, locale: ctx.locale };
  const [cart, page, address] = await Promise.all([
    getCartView(db, request, ctx.now),
    loadCheckoutData(db, { locale: ctx.locale, now: ctx.now, customerId }),
    // the account area's address book: a signed-in customer starts from their default address (never forced)
    customerId ? getDefaultAddress(db, customerId, ctx.locale) : Promise.resolve(null),
  ]);
  // a stored code under its minimum says how much more is needed (client round 1, QA)
  const shortfall = cart.couponIssue?.reason === "min_subtotal" ? await couponShortfall(db, request, cart.couponIssue.code, ctx.now, cart) : null;
  return data(
    {
      cart,
      page,
      customer: session ? { name: session.customer.name ?? "", phone: nationalPhone(session.customer.phoneE164), phoneMasked: session.customer.phoneMasked } : null,
      savedAddress: addressPrefill(address, page),
      /** For a form posted without script; the page itself keeps one key per checkout in sessionStorage. */
      attemptKey: randomToken(),
      demo: ctx.storeMode === "demo",
      couponShortfall: shortfall,
      i18n: messagesFor(ctx.locale, "checkout", "errors"),
    },
    { headers: NO_STORE },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const form = await request.formData();
  // how much more a coupon's minimum needs (a read the coupon field asks after /api/cart refused a code for it)
  if (form.get("intent") === COUPON_MINIMUM_INTENT) {
    const answer = await answerCouponMinimum(db, ctx, session?.customer.id ?? null, form);
    return data(answer, { status: answer.ok ? 200 : answer.status, headers: NO_STORE });
  }
  const result = await placeCheckout(db, { cartToken: cartTokenOf(ctx), customer: session ? { id: session.customer.id } : null, locale: ctx.locale, ip: ctx.ip, storeMode: ctx.storeMode, requestId: ctx.requestId }, form, ctx.now);
  if (result.ok) {
    // the purchase signal (devices area) — consent only, a new order only; a failure is logged and never touches the order
    await recordPurchase(db, ctx, session?.customer.id ?? null, result);
    // «احفظ هذا العنوان لطلباتك القادمة» (signed in, ticked, a new order): the account's address book, best effort
    const unsaved = session && !result.replayed && wantsAddressSaved(form) ? !(await saveCheckoutAddress(db, { id: session.customer.id, ip: ctx.ip }, form, ctx.now)) : false;
    // A guest lands on the order's link (CONTRACTS §1: the token is their only key). A signed-in shopper lands on their
    // own order page WITHOUT the token (security review 2026-11-12): the address stays in the browser's history, and on a
    // shared device the token would open the order — address, items, the transfer upload — after they sign out; their
    // account opens it.
    const base = session ? `/order/${encodeURIComponent(result.ref)}` : confirmationPath(result.ref, result.accessToken);
    const path = base + (unsaved ? `${base.includes("?") ? "&" : "?"}address=0` : "");
    throw redirect(localePath(path, ctx.locale), { headers: NO_STORE });
  }
  return data(result, { status: result.status, headers: NO_STORE });
}

export function headers() {
  return NO_STORE;
}

/** Moving between steps changes only `?step=`: nothing to load. The coupon-minimum read changes nothing either. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  if (formData?.get("intent") === COUPON_MINIMUM_INTENT) return false;
  return defaultShouldRevalidate;
}

export const handle = {
  shell: { chrome: "checkout" },
  nav: "push",
  order: ({ search }) => 1 + stepIndex(stepOf(search)),
  group: "checkout",
} satisfies ShellHandle & MotionHandle;

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.checkout as { meta?: { checkout?: string } } | undefined;
  return shellMeta(args, { title: tree?.meta?.checkout ?? null, noindex: true });
};

type ActionResult = CheckoutFailure;

const COMMIT_LABEL: Record<Step, string> = { address: "keys.toPayment", payment: "keys.toReview", review: "keys.place" };

const DELIVERY_FIELDS = ["governorateId", "districtId", "areaText", "addressText", "notes"] as const satisfies readonly FieldName[];

/** Refusals about stock: the review shows the cart as it is now (sold-out lines are taken out, by name). */
const STOCK_CODES = new Set(["insufficient_stock", "used_unit_not_available", "cart_blocked", "cart_empty"]);

/** A line that can no longer be bought (sold out, off sale). */
const isBlocking = (line: { problem: string | null }) => line.problem !== null && BLOCKING_PROBLEMS.has(line.problem);

/** The refusal on screen: its code, when it came, and — for a stock refusal — what changed, by name. */
type Notice = { code: string; at: number; changes?: StockChange[]; removed?: boolean };

/** The delivery part of the saved default address, as draft fields. */
function savedDelivery(saved: SavedAddressPrefill): Pick<CheckoutDraft, (typeof DELIVERY_FIELDS)[number]> {
  return { governorateId: saved.governorateId, districtId: saved.districtId, areaText: saved.areaText, addressText: saved.addressText, notes: saved.notes };
}

export default function CheckoutPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  /** The kit's words (loaded on every page): the one demo-order line, the same as under the summary card. */
  const shopT = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [params] = useSearchParams();
  const step = stepOf(params);
  const { page, demo } = loaderData;
  const signedIn = loaderData.customer !== null;
  const offeredDays = useMemo(() => page.days.map((d) => d.value), [page.days]);

  // ── the draft ────────────────────────────────────────────────────────────────
  // A signed-in customer starts from their default address (account area) — every field stays editable. Cash on
  // delivery is chosen when it is on and nothing was chosen before (§6.10).
  const saved = loaderData.savedAddress;
  const prefill = useMemo<CheckoutDraft>(() => {
    const own = { ...EMPTY_DRAFT, phone: loaderData.customer?.phone ?? "", contactName: loaderData.customer?.name ?? "", paymentMethod: page.methods.cod ? "cod" : "" };
    if (!saved) return own;
    return { ...own, ...savedDelivery(saved), phone: saved.phone || own.phone, contactName: saved.contactName || own.contactName };
  }, [loaderData.customer, saved, page.methods.cod]);
  // A page rendered after a plain form post (no script) starts from what was posted.
  const posted = (actionData as ActionResult | undefined)?.values;
  const [draft, setDraft] = useState<CheckoutDraft>(() => (posted ? draftFromPosted(posted) : prefill));
  /** The delivery fields came from the saved address (the page says so, with a way to start empty). */
  const [fromSaved, setFromSaved] = useState(() => !posted && saved !== null);
  const [attemptKey, setAttemptKey] = useState<string>(loaderData.attemptKey);
  const [submittedKey, setSubmittedKey] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(() => new Set());
  const [issues, setIssues] = useState<FieldIssues>({});
  /** «تابع» was pressed on this step with problems: the error summary shows (until the step changes). */
  const [attempted, setAttempted] = useState<Step | null>(null);

  // Restore this tab's draft before the first paint after hydration (a reload, or back from the cart).
  useLayoutEffect(() => {
    const stored = readStoredCheckout();
    if (stored) {
      // This tab's own draft wins; only a draft without any delivery details (begun before signing in) takes the
      // saved address's.
      const empty = !stored.draft.governorateId && !stored.draft.areaText.trim() && !stored.draft.addressText.trim();
      const delivery = empty && saved ? savedDelivery(saved) : {};
      // the note stays while the delivery fields are still the saved address's (a reload after the first visit)
      const same = saved !== null && stored.draft.governorateId === saved.governorateId && stored.draft.areaText === saved.areaText && stored.draft.addressText === saved.addressText;
      setFromSaved(saved !== null && (empty || same));
      const next = { ...stored.draft, ...delivery, phone: stored.draft.phone || prefill.phone, contactName: stored.draft.contactName || prefill.contactName, paymentMethod: stored.draft.paymentMethod || prefill.paymentMethod };
      // a day kept from a visit that offered days is dropped: only what is on offer now can be sent
      setDraft(withOfferedDay(next, offeredDays));
      // The stored key stays with its cart; another cart (an order was placed since) starts a new attempt.
      const attempt = attemptFor(stored, loaderData.cart.id, newAttemptKey);
      setAttemptKey(attempt.key);
      setSubmittedKey(attempt.submittedKey);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  // The cart this attempt is for: the open cart's id (null once it became an order — keep the one stored then).
  const cartIdRef = useRef<string | null>(loaderData.cart.id);
  if (loaderData.cart.id) cartIdRef.current = loaderData.cart.id;
  useEffect(() => {
    if (restored) writeStoredCheckout({ draft, key: attemptKey, submittedKey, cartId: cartIdRef.current ?? readStoredCheckout()?.cartId ?? null });
  }, [restored, draft, attemptKey, submittedKey]);

  // ── the cart as priced for the chosen governorate, the points to redeem and the referral code asked about (the
  //    server prices it: GET /api/cart?governorateId=&points= — or, with a referral code, POST intent=price, so the
  //    code travels in a body and never in a URL that logs keep; security review 2026-11-12) ──────────────
  const [priced, setPriced] = useState<{ source: unknown; cart: CartView; governorateId: string | null }>({ source: loaderData.cart, cart: loaderData.cart, governorateId: null });
  const [pricing, setPricing] = useState<"idle" | "pending" | "failed">("idle");
  if (priced.source !== loaderData.cart) setPriced({ source: loaderData.cart, cart: loaderData.cart, governorateId: null });
  /** The referral code the shopper asked about with «تحقق» (asked again while it stays the typed one). */
  const [referralAsked, setReferralAsked] = useState<string>("");
  const askedPoints = signedIn ? (parsePoints(draft.redeemPoints) ?? 0) : 0;
  const referral = referralAsked && referralAsked === draft.referralCode.trim() ? referralAsked : "";
  const priceFor = useCallback(
    async (governorateId: string | null, points: number, code: string) => {
      setPricing("pending");
      try {
        const query = new URLSearchParams({ locale });
        if (governorateId) query.set("governorateId", governorateId);
        if (points > 0) query.set("points", String(points));
        let response: Response;
        if (code) {
          const body = new URLSearchParams(query);
          body.set("intent", "price");
          body.set("referral", code);
          response = await fetch("/api/cart", { method: "POST", body, headers: { Accept: "application/json" }, credentials: "same-origin" });
        } else response = await fetch(`/api/cart?${query.toString()}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        const json = (await response.json()) as { ok?: boolean; cart?: CartView };
        if (!response.ok || !json.ok || !json.cart) throw new Error(`cart ${response.status}`);
        setPriced((current) => ({ ...current, cart: json.cart as CartView, governorateId }));
        setPricing("idle");
      } catch {
        setPricing("failed");
      }
    },
    [locale],
  );
  const pricedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!restored) return;
    const key = `${draft.governorateId}|${String(loaderData.cart.id)}|${locale}|${askedPoints}|${referral}`;
    if (pricedFor.current === key) return;
    // nothing chosen yet that changes the price: the loader's cart is the price
    if (!draft.governorateId && askedPoints === 0 && !referral && pricedFor.current === null) return;
    pricedFor.current = key;
    // points are typed digit by digit: ask once the typing pauses
    const timer = setTimeout(() => void priceFor(draft.governorateId || null, askedPoints, referral), askedPoints > 0 ? 350 : 0);
    return () => clearTimeout(timer);
  }, [restored, draft.governorateId, loaderData.cart.id, locale, askedPoints, referral, priceFor]);
  // The review edits the cart in place; every answer is priced for the governorate the totals are for.
  const editor = useCartEditor(priced.cart, { locale, governorateId: priced.governorateId });
  const cart = editor.view as CartWithIssue;
  // An edit's answer (POST /api/cart) is priced without the points and the referral code: ask again with them.
  useEffect(() => {
    if (editor.view === priced.cart || editor.pending || (askedPoints === 0 && !referral)) return;
    void priceFor(draft.governorateId || null, askedPoints, referral);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when an edit answered
  }, [editor.view, editor.pending]);
  /** Lines that can no longer be bought leave the cart without an undo row (a lost race, «أزل غير المتوفر»). */
  const unbuyable = useRemoveUnbuyable(editor);

  // ── checks ───────────────────────────────────────────────────────────────────
  const context: ValidationContext = useMemo(
    () => ({
      districtIds: (page.districts[draft.governorateId] ?? []).map((d) => d.id),
      days: offeredDays,
      // a transfer of nothing is never asked for (an order of 0 — points and free delivery — is placed paid)
      methods: [page.methods.cod ? "cod" : null, page.methods.wallet && signedIn ? "wallet" : null, page.methods.bankTransfer && cart.totalIqd > 0 ? "bank_transfer" : null, page.methods.zaincash && cart.totalIqd > 0 ? "zaincash" : null].filter((m): m is string => m !== null),
      walletEnough: page.walletBalanceIqd !== null && page.walletBalanceIqd >= cart.totalIqd,
      pointsMax: cart.points?.max ?? 0,
    }),
    [page, draft.governorateId, signedIn, cart.totalIqd, cart.points?.max, offeredDays],
  );
  // a split payment: the balance from the wallet, the rest by the method chosen (only while the balance is below the total)
  const walletBalance = page.walletBalanceIqd ?? 0;
  const splitting = signedIn && page.methods.wallet && draft.useWallet && draft.paymentMethod !== "wallet" && walletBalance > 0 && walletBalance < cart.totalIqd;
  const split = splitting ? { walletIqd: walletBalance, restIqd: cart.totalIqd - walletBalance } : null;

  const update = useCallback(
    <K extends FieldName>(name: K, value: CheckoutDraft[K]) => {
      setDraft((current) => {
        const next = { ...current, [name]: value };
        if (name === "governorateId" && value !== current.governorateId) next.districtId = "";
        return next;
      });
      // Re-check while a problem shows (and the district, whose list changes with the governorate).
      setIssues((current) => {
        if (!current[name] && !(name === "governorateId" && current.districtId)) return current;
        const next = { ...current };
        const nextDraft = { ...draft, [name]: value } as CheckoutDraft;
        const issue = validateField(name, nextDraft, context);
        if (issue) next[name] = issue;
        else delete next[name];
        if (name === "governorateId") delete next.districtId;
        return next;
      });
    },
    [draft, context],
  );
  const blur = useCallback(
    (name: FieldName) => {
      setTouched((current) => new Set(current).add(name));
      setIssues((current) => {
        const issue = validateField(name, draft, context);
        if (!issue && !current[name]) return current;
        const next = { ...current };
        if (issue) next[name] = issue;
        else delete next[name];
        return next;
      });
    },
    [draft, context],
  );
  /**
   * «احفظ هذا العنوان لطلباتك القادمة» is offered to a signed-in customer whose delivery fields are not their saved
   * address as it is (nothing saved yet, or changed) — and a tick is only sent while that holds (no duplicate entry).
   */
  const sameAsSaved = saved !== null && draft.governorateId === saved.governorateId && draft.districtId === saved.districtId && draft.areaText.trim() === saved.areaText.trim() && draft.addressText.trim() === saved.addressText.trim();
  const offerSave = signedIn && !sameAsSaved;
  /** "Start with an empty address": the saved one was a starting point, never a requirement. */
  const clearSaved = useCallback(() => {
    setDraft((current) => ({ ...current, governorateId: "", districtId: "", areaText: "", addressText: "", notes: "" }));
    setIssues((current) => {
      const next = { ...current };
      for (const name of DELIVERY_FIELDS) delete next[name];
      return next;
    });
    setFromSaved(false);
    document.getElementById(fieldId("governorateId"))?.focus();
  }, []);

  // ── step changes: focus, and no skipping ahead past an unfinished step ────────────────
  const focusNext = useRef<FieldName | "heading" | null>(null);
  /** The step a failed «تابع» sends the shopper back to: its error summary shows there. */
  const attemptNext = useRef<Step | null>(null);
  /**
   * The step this effect last acted on. Focus moves only when the step CHANGES — never on the first render, and never
   * when the effect runs again for the same step (React StrictMode runs a mount effect twice in development: a
   * once-only "first render" flag let the second run focus the h1, so the first Tab skipped the skip link and the
   * checkout bar; QA 2026-11-12).
   */
  const shownStep = useRef<Step | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const previous = shownStep.current;
    if (previous === step) return;
    shownStep.current = step;
    setAttempted(attemptNext.current);
    attemptNext.current = null;
    const target = stepFocusTarget(previous, step, focusNext.current);
    focusNext.current = null;
    if (target === "heading") headingRef.current?.focus();
    else if (target) document.getElementById(fieldId(target))?.focus();
  }, [step]);
  useEffect(() => {
    if (!restored || step === "address") return;
    const earlier = STEPS.slice(0, stepIndex(step)).find((s) => Object.keys(validateStep(s, draft, context)).length > 0);
    if (earlier) void navigate(`?step=${earlier}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the step changes (or the draft is restored)
  }, [restored, step]);
  /** A field has a problem: its step shows the error summary, and focus goes to the field (on that step). */
  const goToProblem = (field: FieldName) => {
    const target = stepOfField(field);
    if (target !== step) {
      attemptNext.current = target;
      focusNext.current = field;
      void navigate(`?step=${target}`);
      return;
    }
    setAttempted(target);
    document.getElementById(fieldId(field))?.focus();
  };

  // ── the server's answer to "confirm" ────────────────────────────────────────────────
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The cart the shopper saw when they pressed «أكّد الطلب»: a stock refusal says what changed since. */
  const submittedCart = useRef<CartView | null>(null);
  // Lines that sold out while confirming: taken out of the cart through the editor once it shows the fresh cart.
  const [soldOut, setSoldOut] = useState<string[]>([]);
  useEffect(() => {
    if (soldOut.length === 0) return;
    unbuyable.remove(soldOut);
    setSoldOut([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per refusal
  }, [soldOut]);
  // A refusal is shown where the review starts; bring it into view (the shopper pressed a key at the bottom edge).
  const noticeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!notice) return;
    noticeRef.current?.focus({ preventScroll: true });
    noticeRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [notice]);
  /** "Show my order" after a lost answer: asked, and — if the server had no order for that key — answered "none". */
  const [recovery, setRecovery] = useState<"idle" | "pending" | "none">("idle");
  const lastAction = useRef<unknown>(null);
  useEffect(() => {
    const result = actionData as ActionResult | undefined;
    if (!result || result.ok !== false || lastAction.current === result) return;
    lastAction.current = result;
    let code = result.code;
    let changes: StockChange[] | undefined;
    if (result.cart) {
      const fresh = result.cart;
      setPriced((current) => ({ ...current, cart: fresh as CartView, governorateId: draft.governorateId || null }));
      // a stock refusal — or a total that moved because a quantity came down to what is left (the core answers that
      // with totals_changed) — says by name what sold out (taken out of the cart below) and what came down, against what
      // the shopper confirmed
      if (STOCK_CODES.has(code) || code === "totals_changed") {
        changes = stockChanges(submittedCart.current?.lines ?? null, fresh.lines);
        const gone = fresh.lines.filter(isBlocking).map((line) => line.id);
        if (gone.length > 0) setSoldOut(gone);
      }
    }
    if (result.code === "idempotency_conflict") setAttemptKey(newAttemptKey());
    // An order found for the key would have redirected to it: a refusal here means none was placed with it.
    if (recovery === "pending") setRecovery("none");
    setSubmittedKey(null);
    const serverIssues = issuesFromServer(result.fields);
    const field = firstIssue(serverIssues);
    if (field) {
      setIssues((current) => ({ ...current, ...serverIssues }));
      setTouched((current) => new Set([...current, ...(Object.keys(serverIssues) as FieldName[])]));
      goToProblem(field);
      return;
    }
    if (changes && changes.length > 0) code = "stock";
    setNotice({ code, at: Date.now(), changes, removed: true });
    if (step !== "review") void navigate("?step=review");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a new answer only
  }, [actionData]);

  // ── what the cart allows (client round 1, QA) ─────────────────────────────────────────
  // "ready": every line can be bought · "blocked": some cannot (the steps wait until they are out) · "empty": nothing
  // left that can be bought (no step key at all)
  const readiness = cartReadiness(cart.lines);
  const blockedIds = cart.lines.filter(isBlocking).map((line) => line.id);
  const stockReason = cart.lines.length === 0 || readiness === "empty" ? t("reasons.empty") : readiness === "blocked" ? t("reasons.blocked") : null;

  // ── submitting ───────────────────────────────────────────────────────────────────
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const reviewReason = !online
    ? t("reasons.offline")
    : (stockReason ??
      (context.methods.length === 0 ? t("reasons.noMethod") : editor.pending ? t("reasons.editing") : pricing === "pending" ? t("reasons.pricing") : null));
  const formId = "checkout-form";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    // a step key never leads to a dead end: nothing moves while the cart cannot be ordered (the key is flat and says why)
    if (stockReason) return;
    const found = validateStep(step, draft, context);
    const field = firstIssue(found);
    if (field) {
      setIssues((current) => ({ ...current, ...found }));
      setTouched((current) => new Set([...current, ...(Object.keys(found) as FieldName[])]));
      goToProblem(field);
      return;
    }
    setAttempted(null);
    if (step === "address") return void navigate("?step=payment");
    if (step === "payment") return void navigate("?step=review");
    if (reviewReason) return;
    setNotice(null);
    setSubmittedKey(attemptKey);
    submittedCart.current = cart;
    writeStoredCheckout({ draft, key: attemptKey, submittedKey: attemptKey, cartId: cartIdRef.current });
    void submit(draftToForm({ ...draft, saveAddress: draft.saveAddress && offerSave, useWallet: splitting }, { idempotencyKey: attemptKey, expectedTotalIqd: cart.totalIqd, walletIqd: split?.walletIqd ?? 0 }), { method: "post" });
  };

  /** After a lost answer: ask again with the same key — the server answers with the order that key placed, if any. */
  const recover = () => {
    const stored = readStoredCheckout();
    if (!stored?.submittedKey || busy) return;
    setRecovery("pending");
    void submit(draftToForm(stored.draft, { idempotencyKey: stored.submittedKey, expectedTotalIqd: 0 }), { method: "post" });
  };

  // Only problems of fields the shopper has left (or that the server named) are shown. Before the page has started in
  // the browser (a plain form post rendered by the server), the server's answer is read directly.
  // The fields the server named are said in the page's own words where its checks (the same rules) agree — «اكتب رقم
  // موبايلك.», not the generic «هذا الحقل مطلوب.» — and in the server's words otherwise.
  const prehydration = !restored ? (actionData as ActionResult | undefined) : undefined;
  const shown: FieldIssues = {};
  if (prehydration?.fields) {
    const server = issuesFromServer(prehydration.fields);
    const own = validateStep("review", draft, context);
    for (const name of Object.keys(server) as FieldName[]) shown[name] = own[name] ?? server[name];
  }
  for (const name of Object.keys(issues) as FieldName[]) if (touched.has(name)) shown[name] = issues[name];

  // The refusal to show: this visit's, or — on a page rendered after a plain form post — the server's (its sold-out
  // lines are still in the cart then: without script nothing is taken out).
  const shownNotice: Notice | null =
    notice ??
    (prehydration && !prehydration.fields
      ? (() => {
          const changes = prehydration.cart && (STOCK_CODES.has(prehydration.code) || prehydration.code === "totals_changed") ? stockChanges(null, prehydration.cart.lines) : [];
          return changes.length > 0 ? { code: "stock", at: 0, changes, removed: false } : { code: prehydration.code, at: 0 };
        })()
      : null);

  // ── nothing left that can be ordered: the empty state, with what changed and the way back to the store ─────────
  // (an undo row the shopper left by hand keeps the review on screen, so a line removed by mistake can come back)
  const showEmpty = editor.rows.length === 0 || (readiness === "empty" && editor.rows.every((row) => !row.removed || unbuyable.isRemoving(row.line.id)));
  if (showEmpty) {
    const lost = restored && submittedKey !== null && recovery !== "none";
    const failedRecovery = recovery === "none";
    // what made it empty: this visit's refusal, or lines in the cart that cannot be bought
    const raceChanges = shownNotice?.code === "stock" ? (shownNotice.changes ?? []) : [];
    const leftChanges = raceChanges.length > 0 ? raceChanges : stockChanges(null, cart.lines);
    const browse = (
      <Key as={LocaleLink} to="/c/consoles" variant={lost ? "secondary" : "primary"} iconEnd="arrow-right">
        {t("empty.browse")}
      </Key>
    );
    return (
      <div className="page co-page co-narrow co-empty">
        <h1 className="type-h1 text-ink">{t("checkout.title")}</h1>
        {lost ? (
          <div className="co-card grid gap-3" role="status">
            <h2 className="type-h3 text-ink">{t("recover.title")}</h2>
            <p className="type-read text-ink-2">{t("recover.text")}</p>
            <Key variant="primary" icon="receipt" loading={busy} onClick={recover} className="justify-self-start">
              {t("recover.action")}
            </Key>
          </div>
        ) : null}
        {failedRecovery ? <Note icon="info">{t("recover.none")}</Note> : null}
        {leftChanges.length > 0 ? (
          <StockNotice
            title={raceChanges.length > 0 ? t("stock.titleRace") : t("stock.titleEmpty")}
            changes={leftChanges}
            removed={raceChanges.length > 0 && shownNotice?.removed === true}
            alert={raceChanges.length > 0}
            noticeRef={noticeRef}
            action={
              <span className="co-actions">
                {browse}
                {cart.lines.length > 0 ? (
                  <TextLink as={LocaleLink} to="/cart">
                    {t("review.editCart")}
                  </TextLink>
                ) : null}
              </span>
            }
          />
        ) : (
          <EmptyState layout="stack" panel headingLevel={2} title={t("empty.title")} text={t("empty.text")} action={browse} />
        )}
      </div>
    );
  }

  // ── the page ─────────────────────────────────────────────────────────────────────
  const governorateChosen = Boolean(draft.governorateId) && priced.governorateId === draft.governorateId;
  /** The step key's reason when it cannot work: the review's full list; on the first two steps, the cart's state. */
  const reasonText = step === "review" ? reviewReason : stockReason;
  const commitDisabled = reasonText !== null;
  const totalText = isIqd(cart.totalIqd) ? "⁨" + iqdText(f, cart.totalIqd) + "⁩" : "";
  /**
   * «أكّد الطلب · 1,594,000 د.ع» in the summary card: the action and the total each stay whole, so where the two do not
   * fit on one line (Sorani at 1024) the total takes the second line — never «…پشتڕاست / بکەرەوە · …» (QA 2026-11-12).
   */
  const placeTotal = (total: string): ReactNode => {
    const text = t("checkout.placeTotal", { total });
    const at = text.lastIndexOf(" · ");
    if (at <= 0) return text;
    return (
      <>
        {/* the dot stays with the action: the one break is before the total */}
        <span className="co-commit__part">{text.slice(0, at) + " ·"}</span>{" "}
        <span className="co-commit__part">{text.slice(at + 3)}</span>
      </>
    );
  };
  /** The step's glossy primary: forward with an arrow; «أكّد الطلب» with a check that turns into the spinner while busy. */
  const commit = (id: string, label: ReactNode = t(COMMIT_LABEL[step]), place = step === "review") => (
    <CommitKey
      type="submit"
      form={formId}
      loading={busy}
      busyLabel={t("keys.placing")}
      icon={place ? "check" : undefined}
      iconEnd={place ? undefined : "arrow-right"}
      disabled={commitDisabled && !busy}
      aria-describedby={reasonText ? id : undefined}
    >
      {label}
    </CommitKey>
  );
  const reason = (id: string) =>
    reasonText ? (
      <p id={id} className="type-xs-strong text-ink-2">
        {reasonText}
      </p>
    ) : null;

  const couponIssue = cart.couponIssue ?? null;
  const editCartLink = (
    <TextLink as={LocaleLink} to="/cart">
      {t("review.editCart")}
    </TextLink>
  );
  // a stock refusal: by name, what sold out (taken out of the cart) or came down, the total now — then confirm again
  const noticeNode: ReactNode = !shownNotice ? null : shownNotice.code === "stock" ? (
    <StockNotice
      key={shownNotice.at}
      alert
      noticeRef={noticeRef}
      title={t("stock.titleRace")}
      changes={shownNotice.changes ?? []}
      removed={shownNotice.removed === true}
      totalIqd={readiness === "empty" ? null : cart.totalIqd}
      after={readiness === "ready" ? t("stock.confirmAgain") : null}
      // without script the sold-out lines are still in the cart: the cart page takes them out
      action={shownNotice.removed ? undefined : editCartLink}
    />
  ) : (
    <div role="alert" ref={noticeRef} tabIndex={-1} className="co-alert" key={shownNotice.at}>
      <Note
        tone="warning"
        icon="warning"
        action={["insufficient_stock", "used_unit_not_available", "cart_blocked", "cart_changed", "cart_empty"].includes(shownNotice.code) ? editCartLink : undefined}
      >
        {/* one block: the sentence may be several nodes (an amount inside it) */}
        <p>{noticeText(shownNotice.code, cart, t, errorsT, f)}</p>
        {couponIssue ? (
          // Why the discount went: e.g. the code was already used with this phone number (checked at checkout).
          <p>{couponIssueText(couponIssue, t, errorsT)}</p>
        ) : null}
      </Note>
    </div>
  );
  // lines in the cart that cannot be bought (on load, or after an edit): named, with the one thing to do — every step
  // waits for it (a refusal's own notice says it instead, on the review)
  const blockedNotice =
    blockedIds.length > 0 && shownNotice?.code !== "stock" ? (
      <StockNotice
        title={t("stock.titleBlocked")}
        changes={stockChanges(null, cart.lines)}
        totalIqd={cart.totalIqd}
        action={
          <>
            <Key size="sm" icon="trash" className="co-js" loading={unbuyable.removing} disabled={!online} onClick={() => unbuyable.remove(blockedIds)}>
              {t("stock.remove")}
            </Key>
            <span className="co-nojs">{editCartLink}</span>
          </>
        }
      />
    ) : null;

  // The error summary of the step on screen («تحقّق من حقلين: …»), linked to the fields; only after «تابع» — or, on a page
  // rendered after a plain form post (no script: every step is on screen), every problem the server named.
  const stepErrors = prehydration?.fields ? (Object.keys(shown) as FieldName[]) : attempted === step ? (Object.keys(shown) as FieldName[]).filter((name) => stepOfField(name) === step || step === "review") : [];
  const errorSummary =
    stepErrors.length > 0 ? (
      <FormErrorSummary errors={stepErrors.map((name) => ({ id: !restored && name === "governorateId" ? NOJS_GOVERNORATE_ID : fieldId(name), label: t(`labels.${name}`) }))} />
    ) : null;

  const terms = (
    <p className="type-xs text-ink-2">
      {fillNodes(t("checkout.terms"), {
        terms: (
          <TextLink as={LocaleLink} to="/policies/terms" inline>
            {t("checkout.termsLink")}
          </TextLink>
        ),
        returns: (
          <TextLink as={LocaleLink} to="/policies/returns" inline>
            {t("checkout.returnsLink")}
          </TextLink>
        ),
      })}
    </p>
  );
  const demoNote = demo ? (
    <Note variant="line" tone="demo">
      {shopT("demo.orderLine")}
    </Note>
  ) : null;
  const summaryLines = cart.lines.map((line) => withFlash(withOptionValue({ id: line.id, name: line.name, optionsLabel: line.optionsLabel, lineTotalIqd: line.lineTotalIqd, image: line.image }), (line as { flash?: FlashPriceView | null }).flash, t, f));
  const shipping = governorateChosen ? (cart.shippingIqd === null ? "unserved" : "governorate") : page.shipping.overridesEnabled ? "pending" : undefined;
  const count = cart.payableCount ?? cart.count;
  // every discount as charged, the waived delivery, a split payment's parts — under each summary's rows
  const adjustments = <Adjustments discounts={cart.discounts ?? []} waiver={cart.shippingWaiver ?? null} split={split} />;
  const coupon = (
    <CouponForm
      cart={cart}
      locale={locale}
      governorateId={priced.governorateId}
      pricing={{ points: askedPoints, referral }}
      shortfall={loaderData.couponShortfall}
      onCart={(fresh) => setPriced((current) => ({ ...current, cart: fresh }))}
    />
  );

  return (
    <>
      <SummaryBar cart={{ count, totalIqd: cart.totalIqd }} className="lg:hidden">
        <OrderSummary {...cart} coupon={summaryCoupon(cart.discounts, cart.coupon)} count={count} title={null} lines={summaryLines} shipping={shipping} pending={pricing === "pending" || editor.pending || busy} couponField={coupon} approx="off">
          {adjustments}
        </OrderSummary>
      </SummaryBar>

      <div className="page co-page co-split">
        <div className="co-form">
          {blockedNotice}
          {pricing === "failed" ? (
            <div role="status">
              <Note variant="line" icon="wifi-slash">
                {t("reasons.pricingFailed")}
              </Note>
            </div>
          ) : null}

          <Form id={formId} method="post" noValidate onSubmit={onSubmit} className="co-steps">
            {STEPS.map((s) => {
              const current = s === step;
              // One heading per step: the step on screen is the page's h1 (without script all three show, the others are h2).
              const Title = current ? "h1" : "h2";
              // its section cards' heads one level under it
              const level = current ? 2 : 3;
              return (
                <section key={s} aria-labelledby={`co-step-${s}`} className="co-step" data-current={current ? "" : undefined}>
                  <Title id={`co-step-${s}`} ref={current ? headingRef : undefined} tabIndex={-1} className="type-h1 text-ink outline-none">
                    {t(`steps.title.${s}`)}
                  </Title>
                  {s === "address" ? <GuestNote signedIn={signedIn} phoneMasked={loaderData.customer?.phoneMasked ?? ""} /> : null}
                  {current ? errorSummary : null}
                  {s === "address" ? (
                    <AddressStep
                      draft={draft}
                      issues={shown}
                      onChange={update}
                      onBlur={blur}
                      data={page}
                      cart={cart}
                      signedIn={signedIn}
                      saved={fromSaved && saved ? { label: saved.label } : null}
                      onClearSaved={clearSaved}
                      offerSave={offerSave}
                      headingLevel={level}
                    />
                  ) : s === "payment" ? (
                    <PaymentStep draft={draft} issues={shown} onChange={update} onBlur={blur} data={page} cart={cart} signedIn={signedIn} headingLevel={level} />
                  ) : (
                    <ReviewStep
                      draft={draft}
                      issues={shown}
                      onChange={update}
                      onBlur={blur}
                      data={page}
                      cart={cart}
                      signedIn={signedIn}
                      headingLevel={level}
                      notice={noticeNode}
                      editor={editor}
                      onReferralCheck={() => setReferralAsked(draft.referralCode.trim())}
                      referralPending={pricing === "pending" && referral !== ""}
                      foot={
                        // below 1024 the totals sit here too (the summary bar is folded away), then the terms (without
                        // script the terms are said once, by the plain-post key at the end of the form)
                        <div className="grid gap-3 lg:hidden">
                          <OrderSummary {...cart} coupon={summaryCoupon(cart.discounts, cart.coupon)} lines={null} count={count} title={null} shipping={shipping} pending={pricing === "pending" || editor.pending || busy} approx="off">
                            {adjustments}
                          </OrderSummary>
                          <div className="co-js">{terms}</div>
                          {demoNote}
                        </div>
                      }
                    />
                  )}
                </section>
              );
            })}
            <input type="hidden" name="idempotencyKey" value={attemptKey} />
            <input type="hidden" name="expectedTotalIqd" value={cart.totalIqd} />
            {/* Only without script: the one key that posts the whole form (the step keys need the page running). */}
            <div className="co-nojs grid gap-2">
              {terms}
              <CommitKey type="submit" form={formId} icon="check" disabled={stockReason !== null} aria-describedby={stockReason ? "co-reason-plain" : undefined}>
                {t("keys.place")}
              </CommitKey>
              {stockReason ? (
                <p id="co-reason-plain" className="type-xs-strong text-ink-2">
                  {stockReason}
                </p>
              ) : null}
            </div>
          </Form>
        </div>

        <aside className="co-aside max-lg:hidden" aria-label={t("checkout.summaryLabel")}>
          <OrderSummary
            {...cart}
            coupon={summaryCoupon(cart.discounts, cart.coupon)}
            count={count}
            lines={summaryLines}
            shipping={shipping}
            pending={pricing === "pending" || editor.pending || busy}
            headingLevel={2}
            couponField={coupon}
            action={
              <div className="co-js grid gap-2">
                {step === "review" ? terms : null}
                {commit("co-reason", step === "review" && totalText ? placeTotal(totalText) : undefined)}
                {reason("co-reason")}
              </div>
            }
            trust={<TrustStrip variant="line" cod={page.methods.cod} returnsTo="/policies/returns" />}
          >
            {adjustments}
          </OrderSummary>
          {demoNote}
        </aside>
      </div>

      <TaskBar aria-label={t("checkout.barLabel")} className="lg:hidden">
        <div className="co-taskbar">
          <div className="co-taskbar__total">
            <span className="type-xs text-ink-2">{t("checkout.total")}</span>
            {isIqd(cart.totalIqd) ? <Price amountIqd={cart.totalIqd} size="lg" tone="total" approx="off" as="span" /> : null}
          </div>
          <div className="co-js min-w-0 flex-1">{commit("co-reason-bar")}</div>
        </div>
        {reason("co-reason-bar")}
      </TaskBar>
    </>
  );
}

/**
 * «أكمل الطلب بدون حساب.» — the guest note of the delivery step (client note 8: the before's note — the kit's Note, a
 * neutral soft card, the bag in its circle, the muted line and «سجّل الدخول ←» on its own line), or who is signed in.
 */
function GuestNote({ signedIn, phoneMasked }: { signedIn: boolean; phoneMasked: string }) {
  const t = useT("checkout");
  if (signedIn) {
    return <Note icon="user">{fillNodes(t("guest.signedIn"), { phone: <bdi dir="ltr" className="nums">{phoneMasked}</bdi> })}</Note>;
  }
  return (
    <Note
      icon="shopping-bag"
      title={t("guest.title")}
      action={
        <TextLink as={LocaleLink} to="/account/login?next=%2Fcheckout">
          {t("guest.signIn")}
        </TextLink>
      }
    >
      {t("guest.text")}
    </Note>
  );
}

/** The sentence for a refused confirmation that is not about one field. */
function noticeText(code: string, cart: CartView, t: (key: string, vars?: Record<string, string | number>) => string, errorsT: (key: string) => string, f: ReturnType<typeof useFormat>): ReactNode {
  const total = <bdi className="nums">{f.iqd(cart.totalIqd)}</bdi>;
  switch (code) {
    case "totals_changed":
      return fillNodes(t("notices.totals_changed"), { total });
    case "soldOut":
    case "qtyReduced":
    case "insufficient_stock":
      return t(`notices.${code}`);
    case "cart_empty":
    case "cart_blocked":
      // The core says "cart_empty" when every line sold out: the cart still shows those lines, so say what happened.
      return cart.lines.length > 0 && cart.blocked ? t("notices.insufficient_stock") : errorsT(`errors.${code}`);
    case "network":
      return t("notices.network");
    case "idempotency_conflict":
      // The page has already made a new attempt key: confirming again places the order.
      return t("notices.idempotency_conflict");
    default:
      return errorsT(`errors.${code}`);
  }
}
