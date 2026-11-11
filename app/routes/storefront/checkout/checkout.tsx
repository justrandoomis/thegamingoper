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
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { OrderSummary } from "~/ui/OrderSummary";
import { Price } from "~/ui/Price";
import { fillNodes } from "~/ui/PriceTag";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { TextLink } from "~/ui/TextLink";
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
  writeStoredCheckout,
  type CheckoutDraft,
  type FieldIssues,
  type FieldName,
  type Step,
  type ValidationContext,
} from "./checkout-form";
import { addressPrefill, cartTokenOf, confirmationPath, loadCheckoutData, nationalPhone, NO_STORE, placeCheckout, recordPurchase, type CheckoutFailure, type SavedAddressPrefill } from "./checkout.server";
import { AddressStep, fieldId, PaymentStep, ReviewStep } from "./components/CheckoutSteps";
import { CommitKey } from "./components/CommitKey";

/**
 * /checkout — guest checkout by default (brief §4, §14; DESIGN.md §8.6, §9.17). Three steps on one route, the step in
 * the URL (`?step=address|payment|review`) so Back walks the steps and a step can be linked; moving between them is
 * the sideways push of the motion grammar (route handle order) and needs no request. The form's state lives in the
 * page (it survives a language switch, which keeps the route mounted) and in this tab's sessionStorage (it survives a
 * reload and leaving for the cart and coming back); it is cleared once the order exists.
 *
 * Checks are instant and specific (on blur, again on every keystroke once a problem shows); the server checks
 * everything again — placeOrder prices the cart itself and refuses a total the shopper did not see (totals_changed,
 * with the fresh cart, which the review step then shows). The attempt key is made once per checkout and resent on a
 * retry, so a double press, a reload or a lost answer can never place two orders. Signing in is offered, never
 * required; the wallet appears only for signed-in customers. The task bar (phones) and the summary column (≥1024px)
 * carry the total and the one commit key of each step.
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
    throw redirect(localePath(confirmationPath(result.ref, result.accessToken), ctx.locale), { headers: NO_STORE });
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
  shell: { tabBar: false },
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

/** The delivery part of the saved default address, as draft fields. */
function savedDelivery(saved: SavedAddressPrefill): Pick<CheckoutDraft, (typeof DELIVERY_FIELDS)[number]> {
  return { governorateId: saved.governorateId, districtId: saved.districtId, areaText: saved.areaText, addressText: saved.addressText, notes: saved.notes };
}

export default function CheckoutPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [params] = useSearchParams();
  const step = stepOf(params);
  const { page } = loaderData;
  const signedIn = loaderData.customer !== null;

  // ── the draft ────────────────────────────────────────────────────────────────
  // A signed-in customer starts from their default address (account area) — every field stays editable.
  const saved = loaderData.savedAddress;
  const prefill = useMemo<CheckoutDraft>(() => {
    const own = { ...EMPTY_DRAFT, phone: loaderData.customer?.phone ?? "", contactName: loaderData.customer?.name ?? "" };
    if (!saved) return own;
    return { ...own, ...savedDelivery(saved), phone: saved.phone || own.phone, contactName: saved.contactName || own.contactName };
  }, [loaderData.customer, saved]);
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
      setDraft({ ...stored.draft, ...delivery, phone: stored.draft.phone || prefill.phone, contactName: stored.draft.contactName || prefill.contactName });
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
  const cart = priced.cart;
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

  // ── checks ───────────────────────────────────────────────────────────────────
  const context: ValidationContext = useMemo(
    () => ({
      districtIds: (page.districts[draft.governorateId] ?? []).map((d) => d.id),
      days: page.days.map((d) => d.value),
      methods: [page.methods.cod ? "cod" : null, page.methods.wallet && signedIn ? "wallet" : null, page.methods.bankTransfer ? "bank_transfer" : null, page.methods.zaincash ? "zaincash" : null].filter((m): m is string => m !== null),
      walletEnough: page.walletBalanceIqd !== null && page.walletBalanceIqd >= cart.totalIqd,
    }),
    [page, draft.governorateId, signedIn, cart.totalIqd],
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
  const firstStep = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
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

  // ── the server's answer to "confirm" ────────────────────────────────────────────────
  const [notice, setNotice] = useState<{ code: string; at: number } | null>(null);
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
    if (result.cart) setPriced((current) => ({ ...current, cart: result.cart as CartView, governorateId: draft.governorateId || null }));
    if (result.code === "idempotency_conflict") setAttemptKey(newAttemptKey());
    // An order found for the key would have redirected to it: a refusal here means none was placed with it.
    if (recovery === "pending") setRecovery("none");
    setSubmittedKey(null);
    const serverIssues = issuesFromServer(result.fields);
    const field = firstIssue(serverIssues);
    if (field) {
      setIssues((current) => ({ ...current, ...serverIssues }));
      setTouched((current) => new Set([...current, ...(Object.keys(serverIssues) as FieldName[])]));
      const target = stepOfField(field);
      if (target !== step) {
        focusNext.current = field;
        void navigate(`?step=${target}`);
      } else document.getElementById(fieldId(field))?.focus();
      return;
    }
    setNotice({ code: result.code, at: Date.now() });
    if (step !== "review") void navigate("?step=review");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a new answer only
  }, [actionData]);

  // ── submitting ───────────────────────────────────────────────────────────────────
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const blocked = cart.blocked;
  const reviewReason = !online ? t("reasons.offline") : blocked ? t("reasons.blocked") : context.methods.length === 0 ? t("reasons.noMethod") : null;
  const formId = "checkout-form";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const found = validateStep(step, draft, context);
    const field = firstIssue(found);
    if (field) {
      setIssues((current) => ({ ...current, ...found }));
      setTouched((current) => new Set([...current, ...(Object.keys(found) as FieldName[])]));
      const target = stepOfField(field);
      if (target !== step) {
        focusNext.current = field;
        void navigate(`?step=${target}`);
      } else document.getElementById(fieldId(field))?.focus();
      return;
    }
    if (step === "address") return void navigate("?step=payment");
    if (step === "payment") return void navigate("?step=review");
    if (reviewReason || pricing === "pending") return;
    setNotice(null);
    setSubmittedKey(attemptKey);
    writeStoredCheckout({ draft, key: attemptKey, submittedKey: attemptKey, cartId: cartIdRef.current });
    void submit(draftToForm(draft, { idempotencyKey: attemptKey, expectedTotalIqd: cart.totalIqd }), { method: "post" });
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
  const prehydration = !restored ? (actionData as ActionResult | undefined) : undefined;
  const shown: FieldIssues = prehydration?.fields ? issuesFromServer(prehydration.fields) : {};
  for (const name of Object.keys(issues) as FieldName[]) if (touched.has(name)) shown[name] = issues[name];

  // ── an empty cart ────────────────────────────────────────────────────────────────
  if (cart.lines.length === 0) {
    const lost = restored && submittedKey !== null && recovery !== "none";
    const failedRecovery = recovery === "none";
    return (
      <div className="gutter mx-auto grid w-full max-w-[calc(640px+2*var(--gutter))] gap-6 pb-10 pt-6">
        <h1 className="type-title text-ink">{t("checkout.title")}</h1>
        {lost ? (
          <div className="grid gap-3 rounded-lg bg-paper p-4" role="status">
            <h2 className="type-sub text-ink">{t("recover.title")}</h2>
            <p className="type-body text-ink-2">{t("recover.text")}</p>
            <Key variant="ink" icon="receipt" loading={busy} onClick={recover} className="justify-self-start">
              {t("recover.action")}
            </Key>
          </div>
        ) : null}
        {failedRecovery ? <p className="rounded-lg bg-paper p-4 type-body text-ink">{t("recover.none")}</p> : null}
        <EmptyState layout="stack" headingLevel={2} title={t("empty.title")} text={t("empty.text")} action={<Key as={LocaleLink} to="/" iconEnd="arrow-right">{t("empty.browse")}</Key>} />
      </div>
    );
  }

  // ── the page ─────────────────────────────────────────────────────────────────────
  const current = stepIndex(step);
  const steps = STEPS.map((s, index) => ({ label: t(`steps.${s}`), href: index < current ? `/checkout?step=${s}` : undefined }));
  const governorateChosen = Boolean(draft.governorateId) && priced.governorateId === draft.governorateId;
  const commitDisabled = step === "review" && (reviewReason !== null || pricing === "pending");
  const reasonText = step === "review" ? (reviewReason ?? (pricing === "pending" ? t("reasons.pricing") : null)) : null;
  const commit = (id: string, label = COMMIT_LABEL[step]) => (
    <CommitKey type="submit" form={formId} loading={busy} disabled={commitDisabled && !busy} aria-describedby={reasonText ? id : undefined}>
      {t(label)}
    </CommitKey>
  );

  // The refusal to show: this visit's, or — on a page rendered after a plain form post — the server's.
  const shownNotice = notice ?? (prehydration && !prehydration.fields ? { code: prehydration.code, at: 0 } : null);
  const couponIssue = (cart as CartView & { couponIssue?: { code: string; reason: string } | null }).couponIssue ?? null;
  const noticeNode: ReactNode = shownNotice ? (
    <div role="alert" ref={noticeRef} tabIndex={-1} className="grid gap-2 rounded-lg bg-paper p-4 outline-none" key={shownNotice.at}>
      <p className="flex items-start gap-2 type-label font-semibold text-ink">
        <Icon name="warning" size={18} className="mt-0.5 shrink-0 text-warn" />
        {/* one flex item: the sentence may be several nodes (an amount inside it) */}
        <span className="min-w-0">{noticeText(shownNotice.code, cart, t, errorsT, f)}</span>
      </p>
      {couponIssue ? (
        // Why the discount went: e.g. the code was already used with this phone number (checked at checkout).
        <p className="type-caption text-ink-2">
          {t("coupon.issue", { code: "⁦" + couponIssue.code + "⁩" })} {errorsT(`errors.coupon_${couponIssue.reason}`)}
        </p>
      ) : null}
      {["insufficient_stock", "used_unit_not_available", "cart_blocked", "cart_changed", "cart_empty"].includes(shownNotice.code) ? (
        <TextLink as={LocaleLink} to="/cart" className="justify-self-start">
          {t("review.editCart")}
        </TextLink>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="page grid gap-6 pb-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start lg:gap-x-10">
      <div className="grid min-w-0 max-w-[640px] gap-5">
        <h1 className="type-title text-ink">{t("checkout.title")}</h1>
        <ProgressSteps steps={steps} current={current} aria-label={t("steps.label")} />
        {step === "address" ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg bg-paper p-4">
            <Icon name={signedIn ? "user" : "shopping-bag"} size={22} className="mt-0.5 shrink-0 text-ink-2" />
            <div className="grid min-w-0 flex-1 gap-1">
              {signedIn ? (
                <p className="type-label text-ink">{fillNodes(t("guest.signedIn"), { phone: <bdi dir="ltr" className="nums">{loaderData.customer?.phoneMasked}</bdi> })}</p>
              ) : (
                <>
                  <p className="type-label font-semibold text-ink">{t("guest.title")}</p>
                  <p className="type-caption text-ink-2">{t("guest.text")}</p>
                  <TextLink as={LocaleLink} to="/account/login?next=%2Fcheckout" className="justify-self-start">
                    {t("guest.signIn")}
                  </TextLink>
                </>
              )}
            </div>
          </div>
        ) : null}
        {blocked && step !== "review" ? (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-paper px-3 py-2.5 type-label font-medium text-red-ink">
            <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
            <span>
              {t("reasons.blocked")}{" "}
              <LocaleLink to="/cart" className="underline underline-offset-4">
                {t("review.editCart")}
              </LocaleLink>
            </span>
          </p>
        ) : null}

        <Form id={formId} method="post" noValidate onSubmit={onSubmit} className="grid gap-8">
          {STEPS.map((s) => (
            // One step at a time in the browser. A page without script (html has no data-motion: the head script did
            // not run) shows all three, and a plain post of this form places the order through the same action.
            <section key={s} aria-labelledby={`co-step-${s}`} className={cx("grid gap-5", s !== step && "[html[data-motion]_&]:hidden")}>
              <h2 id={`co-step-${s}`} ref={s === step ? headingRef : undefined} tabIndex={-1} className="type-section text-ink outline-none">
                {t(`steps.title.${s}`)}
              </h2>
              {s === "address" ? (
                <AddressStep draft={draft} issues={shown} onChange={update} onBlur={blur} data={page} cart={cart} signedIn={signedIn} saved={fromSaved && saved ? { label: saved.label } : null} onClearSaved={clearSaved} />
              ) : s === "payment" ? (
                <PaymentStep draft={draft} issues={shown} onChange={update} onBlur={blur} data={page} cart={cart} signedIn={signedIn} />
              ) : (
                <ReviewStep draft={draft} issues={shown} onChange={update} onBlur={blur} data={page} cart={cart} signedIn={signedIn} notice={noticeNode} />
              )}
            </section>
          ))}
          <input type="hidden" name="idempotencyKey" value={attemptKey} />
          <input type="hidden" name="expectedTotalIqd" value={cart.totalIqd} />
          {/* Only without script: the one key that posts the whole form (the step keys below need the page running). */}
          <div className="hidden [html:not([data-motion])_&]:grid">{commit("co-reason-plain", "keys.place")}</div>
        </Form>
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--safe-top)+var(--s-4))]" aria-label={t("checkout.summaryLabel")}>
        <OrderSummary
          {...cart}
          count={cart.count}
          shipping={governorateChosen ? (cart.shippingIqd === null ? "unserved" : "governorate") : undefined}
          pending={pricing === "pending" || busy}
          headingLevel={2}
        />
        {pricing === "failed" ? (
          <p className="flex items-start gap-2 type-caption text-ink-2" role="status">
            <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
            {t("reasons.pricingFailed")}
          </p>
        ) : null}
        <div className="hidden gap-2 lg:grid [html:not([data-motion])_&]:hidden">
          {commit("co-reason")}
          {reasonText ? (
            <p id="co-reason" className="type-caption font-medium text-ink-2">
              {reasonText}
            </p>
          ) : null}
        </div>
      </aside>

      <TaskBar aria-label={t("checkout.barLabel")} className="lg:hidden">
        <div className="flex items-center gap-3">
          <div className="grid shrink-0 gap-0.5">
            <span className="type-caption text-ink-2">{t("checkout.total")}</span>
            <Price amountIqd={cart.totalIqd} size="md" approx="off" as="span" />
          </div>
          <div className="min-w-0 flex-1 [html:not([data-motion])_&]:hidden">{commit("co-reason-bar")}</div>
        </div>
        {reasonText ? (
          <p id="co-reason-bar" className="mt-1.5 type-caption font-medium text-ink-2">
            {reasonText}
          </p>
        ) : null}
      </TaskBar>
    </div>
  );
}

/** The sentence for a refused confirmation that is not about one field. */
function noticeText(code: string, cart: CartView, t: (key: string, vars?: Record<string, string | number>) => string, errorsT: (key: string) => string, f: ReturnType<typeof useFormat>): ReactNode {
  const total = <bdi className="nums">{f.iqd(cart.totalIqd)}</bdi>;
  switch (code) {
    case "totals_changed":
      return fillNodes(t("notices.totals_changed"), { total });
    case "insufficient_stock":
      return t("notices.insufficient_stock");
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
