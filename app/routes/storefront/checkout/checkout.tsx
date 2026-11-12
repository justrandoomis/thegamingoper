import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { data, Form, redirect, useNavigate, useNavigation, useSearchParams, useSubmit, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/checkout";
import { Icon } from "~/art/Icon";
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
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { FormErrorSummary } from "~/ui/Field";
import { Key } from "~/ui/Key";
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
  draftFromPosted,
  draftToForm,
  EMPTY_DRAFT,
  firstIssue,
  issuesFromServer,
  newAttemptKey,
  readStoredCheckout,
  stepIndex,
  stepOf,
  stepOfField,
  STEPS,
  validateField,
  validateStep,
  withOfferedDay,
  writeStoredCheckout,
  type CheckoutDraft,
  type FieldIssues,
  type FieldName,
  type Step,
  type ValidationContext,
} from "./checkout-form";
import {
  addressPrefill,
  cartTokenOf,
  confirmationPath,
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
import { AddressStep, fieldId, NOJS_GOVERNORATE_ID, PaymentStep, ReviewStep, withOptionValue } from "./components/CheckoutSteps";
import { CommitKey } from "./components/CommitKey";
import { CouponForm, type CartWithIssue } from "./components/CouponForm";
import { SummaryBar } from "./components/SummaryBar";
import "./checkout.css";

/**
 * /checkout — guest checkout by default (Design System v2 §6.10; brief §4, §14). The checkout shell (§5.8): ONE bar —
 * back to the cart · the mascot · the step rail «1 التوصيل · 2 الدفع · 3 المراجعة» · «طلب تجريبي» · help — drawn by the
 * shell from this route's handle (`chrome: "checkout"`) and `?step=`; the page draws no rail of its own. Below 1024 a
 * 48px summary bar (the total, the items on demand) sits under it and the glass task bar holds «الإجمالي» and the
 * step's one primary; from 1024 the form takes 7 columns and the sticky summary 5, with the primary inside the card.
 *
 * Three steps on one route, the step in the URL (`?step=address|payment|review`) so Back walks the steps and a step can
 * be linked; moving between them is the sideways push of the motion grammar and needs no request. One heading per step
 * (the step's question is the page's h1). The form's state lives in the page (it survives a language switch) and in
 * this tab's sessionStorage (a reload, the cart and back); it is cleared once the order exists.
 *
 * Checks are instant and specific (on blur, again on every keystroke once a problem shows); «تابع» checks the step,
 * lists what to fix in one alert above the form and moves focus to the first field. The server checks everything
 * again — placeOrder prices the cart itself and refuses a total the shopper did not see (totals_changed, with the
 * fresh cart). The attempt key is made once per checkout and resent on a retry, so a double press, a reload or a lost
 * answer can never place two orders. The review edits the cart in place (quantities, removal with undo — the kit's cart
 * editor, priced for the chosen governorate); a line that sold out while confirming is taken out of the cart, said in
 * words, with its undo. Signing in is offered, never required; the wallet appears only for signed-in customers.
 * Without script all three steps show and one plain post places the order through the same action.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const [cart, page, address] = await Promise.all([
    getCartView(db, { cartToken: cartTokenOf(ctx), customerId, locale: ctx.locale }, ctx.now),
    loadCheckoutData(db, { locale: ctx.locale, now: ctx.now, customerId }),
    // the account area's address book: a signed-in customer starts from their default address (never forced)
    customerId ? getDefaultAddress(db, customerId, ctx.locale) : Promise.resolve(null),
  ]);
  return data(
    {
      cart,
      page,
      customer: session ? { name: session.customer.name ?? "", phone: nationalPhone(session.customer.phoneE164), phoneMasked: session.customer.phoneMasked } : null,
      savedAddress: addressPrefill(address, page),
      /** For a form posted without script; the page itself keeps one key per checkout in sessionStorage. */
      attemptKey: randomToken(),
      demo: ctx.storeMode === "demo",
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
  const result = await placeCheckout(db, { cartToken: cartTokenOf(ctx), customer: session ? { id: session.customer.id } : null, locale: ctx.locale, ip: ctx.ip, storeMode: ctx.storeMode, requestId: ctx.requestId }, form, ctx.now);
  if (result.ok) {
    // the purchase signal (devices area) — consent only, a new order only; a failure is logged and never touches the order
    await recordPurchase(db, ctx, session?.customer.id ?? null, result);
    // «احفظ هذا العنوان لطلباتك القادمة» (signed in, ticked, a new order): the account's address book, best effort
    const unsaved = session && !result.replayed && wantsAddressSaved(form) ? !(await saveCheckoutAddress(db, { id: session.customer.id, ip: ctx.ip }, form, ctx.now)) : false;
    const path = confirmationPath(result.ref, result.accessToken) + (unsaved ? "&address=0" : "");
    throw redirect(localePath(path, ctx.locale), { headers: NO_STORE });
  }
  return data(result, { status: result.status, headers: NO_STORE });
}

export function headers() {
  return NO_STORE;
}

/** Moving between steps changes only `?step=`: nothing to load. Other navigations and form posts: the default. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
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

/** Refusals about stock: the review shows the cart as it is now (sold-out lines are taken out, with their undo). */
const STOCK_CODES = new Set(["insufficient_stock", "used_unit_not_available", "cart_blocked", "cart_empty"]);
const BLOCKING = new Set(["out_of_stock", "unavailable"]);

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

  // ── the cart as priced for the chosen governorate (the server prices it: GET /api/cart) ──────────────
  const [priced, setPriced] = useState<{ source: unknown; cart: CartView; governorateId: string | null }>({ source: loaderData.cart, cart: loaderData.cart, governorateId: null });
  const [pricing, setPricing] = useState<"idle" | "pending" | "failed">("idle");
  if (priced.source !== loaderData.cart) setPriced({ source: loaderData.cart, cart: loaderData.cart, governorateId: null });
  const priceFor = useCallback(
    async (governorateId: string) => {
      setPricing("pending");
      try {
        const response = await fetch(`/api/cart?governorateId=${encodeURIComponent(governorateId)}&locale=${locale}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
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
    if (!restored || !draft.governorateId || pricedFor.current === `${draft.governorateId}|${String(loaderData.cart.id)}|${locale}`) return;
    pricedFor.current = `${draft.governorateId}|${String(loaderData.cart.id)}|${locale}`;
    void priceFor(draft.governorateId);
  }, [restored, draft.governorateId, loaderData.cart.id, locale, priceFor]);
  // The review edits the cart in place; every answer is priced for the governorate the totals are for.
  const editor = useCartEditor(priced.cart, { locale, governorateId: priced.governorateId });
  const cart = editor.view as CartWithIssue;

  // ── checks ───────────────────────────────────────────────────────────────────
  const context: ValidationContext = useMemo(
    () => ({
      districtIds: (page.districts[draft.governorateId] ?? []).map((d) => d.id),
      days: offeredDays,
      methods: [page.methods.cod ? "cod" : null, page.methods.wallet && signedIn ? "wallet" : null, page.methods.bankTransfer ? "bank_transfer" : null, page.methods.zaincash ? "zaincash" : null].filter((m): m is string => m !== null),
      walletEnough: page.walletBalanceIqd !== null && page.walletBalanceIqd >= cart.totalIqd,
    }),
    [page, draft.governorateId, signedIn, cart.totalIqd, offeredDays],
  );

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
  const firstStep = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    setAttempted(attemptNext.current);
    attemptNext.current = null;
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const target = focusNext.current ?? "heading";
    focusNext.current = null;
    if (target === "heading") headingRef.current?.focus();
    else document.getElementById(fieldId(target))?.focus();
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
  const [notice, setNotice] = useState<{ code: string; at: number } | null>(null);
  // Lines that sold out while confirming: taken out of the cart through the editor (each keeps its undo row).
  const [soldOut, setSoldOut] = useState<string[]>([]);
  useEffect(() => {
    if (soldOut.length === 0) return;
    for (const lineId of soldOut) editor.remove(lineId);
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
    if (result.cart) {
      const fresh = result.cart;
      setPriced((current) => ({ ...current, cart: fresh as CartView, governorateId: draft.governorateId || null }));
      if (STOCK_CODES.has(code)) {
        const gone = fresh.lines.filter((line) => line.problem !== null && BLOCKING.has(line.problem)).map((line) => line.id);
        if (gone.length > 0) {
          setSoldOut(gone);
          code = "soldOut";
        } else if (fresh.lines.some((line) => line.problem === "qty_reduced")) code = "qtyReduced";
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
    setNotice({ code, at: Date.now() });
    if (step !== "review") void navigate("?step=review");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a new answer only
  }, [actionData]);

  // ── submitting ───────────────────────────────────────────────────────────────────
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const blocked = cart.blocked;
  const reviewReason = !online
    ? t("reasons.offline")
    : cart.lines.length === 0
      ? t("reasons.empty")
      : blocked
        ? t("reasons.blocked")
        : context.methods.length === 0
          ? t("reasons.noMethod")
          : editor.pending
            ? t("reasons.editing")
            : pricing === "pending"
              ? t("reasons.pricing")
              : null;
  const formId = "checkout-form";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
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
    writeStoredCheckout({ draft, key: attemptKey, submittedKey: attemptKey, cartId: cartIdRef.current });
    void submit(draftToForm({ ...draft, saveAddress: draft.saveAddress && offerSave }, { idempotencyKey: attemptKey, expectedTotalIqd: cart.totalIqd }), { method: "post" });
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

  // ── an empty cart (nothing left to order, not even an undo row) ──────────────────────────────
  if (editor.rows.length === 0) {
    const lost = restored && submittedKey !== null && recovery !== "none";
    const failedRecovery = recovery === "none";
    return (
      <div className="page co-page co-narrow">
        <h1 className="sr-only">{t("checkout.title")}</h1>
        {lost ? (
          <div className="co-card grid gap-3" role="status">
            <h2 className="type-h3 text-ink">{t("recover.title")}</h2>
            <p className="type-body text-ink-2">{t("recover.text")}</p>
            <Key variant="primary" icon="receipt" loading={busy} onClick={recover} className="justify-self-start">
              {t("recover.action")}
            </Key>
          </div>
        ) : null}
        {failedRecovery ? <p className="co-card type-body text-ink">{t("recover.none")}</p> : null}
        <EmptyState
          layout="stack"
          headingLevel={2}
          title={t("empty.title")}
          text={t("empty.text")}
          action={
            <Key as={LocaleLink} to="/c/consoles" variant={lost ? "secondary" : "primary"} iconEnd="arrow-right">
              {t("empty.browse")}
            </Key>
          }
        />
      </div>
    );
  }

  // ── the page ─────────────────────────────────────────────────────────────────────
  const governorateChosen = Boolean(draft.governorateId) && priced.governorateId === draft.governorateId;
  const commitDisabled = step === "review" && reviewReason !== null;
  const reasonText = step === "review" ? reviewReason : null;
  const totalText = isIqd(cart.totalIqd) ? "⁨" + iqdText(f, cart.totalIqd) + "⁩" : "";
  const commit = (id: string, label: string = t(COMMIT_LABEL[step])) => (
    <CommitKey type="submit" form={formId} loading={busy} disabled={commitDisabled && !busy} aria-describedby={reasonText ? id : undefined}>
      {label}
    </CommitKey>
  );
  const reason = (id: string) =>
    reasonText ? (
      <p id={id} className="type-xs-strong text-ink-2">
        {reasonText}
      </p>
    ) : null;

  // The refusal to show: this visit's, or — on a page rendered after a plain form post — the server's.
  const shownNotice = notice ?? (prehydration && !prehydration.fields ? { code: prehydration.code, at: 0 } : null);
  const couponIssue = cart.couponIssue ?? null;
  const noticeNode: ReactNode = shownNotice ? (
    <div role="alert" ref={noticeRef} tabIndex={-1} className="callout callout--warn outline-none" key={shownNotice.at}>
      <Icon name="warning" size={20} />
      <div className="grid gap-2">
        {/* one block: the sentence may be several nodes (an amount inside it) */}
        <p className="type-sm-strong text-ink">{noticeText(shownNotice.code, cart, t, errorsT, f)}</p>
        {couponIssue ? (
          // Why the discount went: e.g. the code was already used with this phone number (checked at checkout).
          <p className="type-xs text-ink-2">
            {t("coupon.issue", { code: "⁦" + couponIssue.code + "⁩" })} {errorsT(`errors.coupon_${couponIssue.reason}`)}
          </p>
        ) : null}
        {["insufficient_stock", "used_unit_not_available", "cart_blocked", "cart_changed", "cart_empty"].includes(shownNotice.code) ? (
          <TextLink as={LocaleLink} to="/cart" className="justify-self-start">
            {t("review.editCart")}
          </TextLink>
        ) : null}
      </div>
    </div>
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
  const summaryLines = cart.lines.map((line) => withOptionValue({ id: line.id, name: line.name, optionsLabel: line.optionsLabel, lineTotalIqd: line.lineTotalIqd, image: line.image }));
  const shipping = governorateChosen ? (cart.shippingIqd === null ? "unserved" : "governorate") : page.shipping.overridesEnabled ? "pending" : undefined;
  const coupon = (
    <CouponForm cart={cart} locale={locale} governorateId={priced.governorateId} onCart={(fresh) => setPriced((current) => ({ ...current, cart: fresh }))} />
  );

  return (
    <>
      <SummaryBar cart={cart} className="lg:hidden">
        <OrderSummary {...cart} count={cart.count} title={null} lines={summaryLines} shipping={shipping} pending={pricing === "pending" || editor.pending || busy} couponField={coupon} approx="off" />
      </SummaryBar>

      <div className="page co-page co-split">
        <div className="co-form">
          {blocked && step !== "review" ? (
            <div role="alert" className="callout callout--danger">
              <Icon name="warning-circle" size={20} />
              <p className="callout__text text-ink">
                {t("reasons.blocked")}{" "}
                <TextLink as={LocaleLink} to="/cart" inline>
                  {t("review.editCart")}
                </TextLink>
              </p>
            </div>
          ) : null}
          {pricing === "failed" ? (
            <p className="flex items-start gap-2 type-xs text-ink-2" role="status">
              <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
              {t("reasons.pricingFailed")}
            </p>
          ) : null}

          <Form id={formId} method="post" noValidate onSubmit={onSubmit} className="grid gap-10">
            {STEPS.map((s) => {
              const current = s === step;
              // One heading per step: the step on screen is the page's h1 (without script all three show, the others are h2).
              const Title = current ? "h1" : "h2";
              return (
                <section key={s} aria-labelledby={`co-step-${s}`} className="co-step" data-current={current ? "" : undefined}>
                  <Title id={`co-step-${s}`} ref={current ? headingRef : undefined} tabIndex={-1} className="type-h1 text-ink outline-none">
                    {t(`steps.title.${s}`)}
                  </Title>
                  {s === "address" ? <GuestStrip signedIn={signedIn} phoneMasked={loaderData.customer?.phoneMasked ?? ""} /> : null}
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
                    />
                  ) : s === "payment" ? (
                    <PaymentStep draft={draft} issues={shown} onChange={update} onBlur={blur} data={page} cart={cart} signedIn={signedIn} />
                  ) : (
                    <ReviewStep
                      draft={draft}
                      issues={shown}
                      onChange={update}
                      onBlur={blur}
                      data={page}
                      cart={cart}
                      signedIn={signedIn}
                      notice={noticeNode}
                      editor={editor}
                      foot={
                        // below 1024 the totals sit here too (the summary bar is folded away), then the terms (without
                        // script the terms are said once, by the plain-post key at the end of the form)
                        <div className="grid gap-3 lg:hidden">
                          <OrderSummary {...cart} lines={null} count={cart.count} title={null} shipping={shipping} pending={pricing === "pending" || editor.pending || busy} approx="off" />
                          <div className="co-js">{terms}</div>
                          {demo ? <DemoNote variant="line">{shopT("demo.orderLine")}</DemoNote> : null}
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
              {commit("co-reason-plain", t("keys.place"))}
            </div>
          </Form>
        </div>

        <aside className="co-aside max-lg:hidden" aria-label={t("checkout.summaryLabel")}>
          <OrderSummary
            {...cart}
            count={cart.count}
            lines={summaryLines}
            shipping={shipping}
            pending={pricing === "pending" || editor.pending || busy}
            headingLevel={2}
            couponField={coupon}
            action={
              <div className="co-js grid gap-2">
                {step === "review" ? terms : null}
                {commit("co-reason", step === "review" && totalText ? t("checkout.placeTotal", { total: totalText }) : undefined)}
                {reason("co-reason")}
              </div>
            }
            trust={<TrustStrip variant="line" cod={page.methods.cod} returnsTo="/policies/returns" />}
            demo={demo}
          />
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

/** «أكمل الطلب بدون حساب.» — the guest strip of the delivery step (§6.10), or who is signed in. */
function GuestStrip({ signedIn, phoneMasked }: { signedIn: boolean; phoneMasked: string }) {
  const t = useT("checkout");
  if (signedIn) {
    return (
      <p className="co-guest">
        <Icon name="user" size={20} className="shrink-0" />
        <span>{fillNodes(t("guest.signedIn"), { phone: <bdi dir="ltr" className="nums">{phoneMasked}</bdi> })}</span>
      </p>
    );
  }
  return (
    <p className="co-guest">
      <Icon name="check-circle" size={20} className="shrink-0" />
      <span>
        <b className="font-semibold">{t("guest.title")}</b> {t("guest.text")}{" "}
        <TextLink as={LocaleLink} to="/account/login?next=%2Fcheckout" inline>
          {t("guest.signIn")}
        </TextLink>
      </span>
    </p>
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
