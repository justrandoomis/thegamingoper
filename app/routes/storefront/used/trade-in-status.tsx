/**
 * /trade-in/:ref — a trade-in request's page (Design System v2 §6.14 "and status"; v2.1 «Clay & Glass», client note 12
 * "the new screens need better arrangement, looks, features and animations").
 *
 * Who may see it (~/server/services/tradein.server): the holder of the link from the confirmation (`?t=<token>`), the
 * signed-in customer who made it, or — without either — whoever gives the reference AND the phone number it was made
 * with (rate-limited; a wrong reference and a wrong phone get the same answer). Nothing is shown from the reference
 * alone: that is the "unauthorized" state, the lookup card (./components/TradeInLookup). The start page's track card
 * posts here too (intent=lookup).
 *
 * The page, in the order that matters (phones; from 1024 the offer column and a side column):
 *   - the reference (type-code), the status in words, «طلب تجريبي»; just after sending, «استلمنا طلبك» with the mark
 *     that draws itself and the copy-link key (no SMS provider: said plainly)
 *   - the FINAL OFFER on the wallet band (the reference's red card): «العرض النهائي», the amount counting up once
 *     (<CountUp>: a server-rendered first screen shows it final — no flash), the employee sentence, what the first
 *     estimate was, the validity date as a pill
 *   - WHAT THE INSPECTION FOUND, before the shopper answers (the latest `offered` event admin module 13 writes): the grade
 *     with its legend and hint, the result in one line, the checklist with an icon per line (problems first) arriving
 *     one after another (<Reveal stagger>), what was handed over
 *   - the ANSWER while the offer is open and the page was opened with the link or by its account: the payout choice as
 *     raised option cards with their icons (wallet · cash) and «اقبل العرض» (the view's one red primary) / «ارفض العرض»
 *     (confirmed first) — in the task bar below 1024 (the thumb's place; the tab bar gives way), under the cards from
 *     1024. Then «قبلت العرض» with the drawn check, or the declined / expired / "answer with your link" notes
 *   - without an offer: the estimate (a range, «بانتظار الفحص», its expiry) or "priced after the inspection"
 *   - the TIMELINE (one list instead of v2's two): the request's steps, when each happened and what it brought (the
 *     estimate, the inspection time the store set, the grade, the offer, the answer), the shopper's turn marked
 *   - the device and the shopper's description, the photo count (private); the inspection time the store set (its own
 *     fact) and the preferred time (a preference, never an appointment)
 * States: unauthorized (lookup) · not found (the same sentence) · each status · offer open / answered / expired (an
 * open offer past its date reads "expired" before the daily job closes it, with the way to ask for a new one) · answer
 * failures (a sentence above the keys; a payout not chosen is said at the cards, before anything is sent) · offline
 * (the answer and lookup keys go flat with the reason; nothing is sent into the error page) · demo request.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { data, Form, useActionData, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/trade-in-status";
import { Icon, type IconName } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { CURRENCIES } from "~/lib/money";
import { CountUp } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { answerStatus } from "~/routes/storefront/support/client";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { getTradeInByRef, lookupTradeIn, normalizeTradeInRef, questionsFor, respondToOffer, type TradeInView } from "~/server/services/tradein.server";
import { Band } from "~/ui/Band";
import { cx } from "~/ui/cx";
import { ConfirmDialog } from "~/ui/Dialog";
import { DemoNote } from "~/ui/DemoNote";
import { Disclosure } from "~/ui/Disclosure";
import { FieldGroup, OptionCard } from "~/ui/Field";
import { GradeBadge, gradeKey } from "~/ui/GradeBadge";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { iqdText } from "~/ui/PriceTag";
import { revealProps } from "~/ui/reveal";
import { SuccessMark } from "~/ui/SuccessMark";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { TradeInLookup } from "./components/TradeInLookup";
import { AnswerList, DeviceSummary, EstimatePanel, useAccessoryLabel, useGradeWords } from "./components/TradeInParts";
import { combinedErrorT, useErrorText, useUsedT } from "./i18n";
import "./used.css";

/**
 * The open offer's keys sit in the page's own task bar below 1024 (the tab bar gives way to it, and comes back on a
 * request with nothing to answer); the header becomes the task header once the page scrolls. The page is built around
 * its forms (the lookup, the answer): offline, the shell's banner says what was typed stays («ما كتبته باقٍ…»), not
 * the store's «سلتك محفوظة…» (review 2026-11-13).
 */
export const handle = { shell: { tabBar: false, offline: "form" } } satisfies ShellHandle;

/** The one "talk to a person" destination of the store (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";
/** The answer's form: the keys in the task bar submit it from outside (form="…"). */
const ANSWER_FORM = "ti-answer";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const customer = await getCustomer(ctx, db);
  const view = await getTradeInByRef(db, params.ref, { accessToken: token, customerId: customer?.customer.id ?? null }, ctx.locale, ctx.now);
  const ref = normalizeTradeInRef(params.ref) ?? params.ref.slice(0, 24);
  const t = serverT(ctx.locale, "used");
  return {
    ref,
    view: view ? withQuestions(view) : null,
    created: view !== null && url.searchParams.get("new") === "1",
    meta: { title: t("track.metaTitle", { ref }) },
    i18n: messagesFor(ctx.locale, "used", "errors"),
  };
}

/** The view plus the questions this device was asked (for the description list). */
function withQuestions(view: TradeInView) {
  return { ...view, questions: questionsFor(view.device) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, noindex: true });

export async function action({ params, request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = form.get("intent");
  const errorsT = combinedErrorT(serverT(ctx.locale, "used"), serverT(ctx.locale, "errors"));
  // The phone as the shopper typed it goes back with a lookup that found nothing: the lookup card keeps it when the
  // answer arrives on a page of its own (the start page's track card posts here; without script every answer does).
  const typed = form.get("phone");
  const phone = typeof typed === "string" ? typed.slice(0, 40) : "";
  try {
    if (intent === "lookup") {
      const view = await lookupTradeIn(db, { ref: params.ref, phone: typed }, { ip: ctx.ip }, ctx.locale, ctx.now);
      // "No match" is an answer, not a failure of the request: the same sentence for a wrong reference and a wrong phone.
      if (!view) return { intent: "lookup" as const, ok: false as const, code: "not_found", message: serverT(ctx.locale, "used")("track.lookup.notFound"), phone };
      return { intent: "lookup" as const, ok: true as const, view: withQuestions(view) };
    }
    if (intent === "respond") {
      const customer = await getCustomer(ctx, db);
      const token = new URL(request.url).searchParams.get("t");
      const result = await respondToOffer(db, { ref: params.ref, accessToken: token, customerId: customer?.customer.id ?? null }, { decision: form.get("decision"), payout: form.get("payout"), reason: form.get("reason") }, ctx.now);
      return { intent: "respond" as const, ok: true as const, status: result.status };
    }
    return data({ intent: null, ok: false as const, code: "invalid" }, { status: 400 });
  } catch (error) {
    const failure = actionError(error, errorsT);
    // a lookup without a usable phone, or an answer with a field to fix, is an answer (200 — answerStatus): the console
    // logs no failed request for an ordinary mistake; a limit, a closed offer or a refusal keeps its 4xx
    return data({ intent: intent === "lookup" || intent === "respond" ? intent : null, ...failure, ...(intent === "lookup" ? { phone } : {}) }, { status: answerStatus(failure) });
  }
}

type StatusView = ReturnType<typeof withQuestions>;
type ActionAnswer = { intent: "lookup" | "respond" | null; ok: boolean; view?: StatusView; status?: string; code?: string; message?: string; fields?: Record<string, string> };

const TONE: Record<string, StatusTone> = {
  submitted: "info",
  estimated: "warn",
  inspection_scheduled: "info",
  inspected: "info",
  offered: "warn",
  accepted: "ok",
  declined: "neutral",
  paid: "ok",
  cancelled: "neutral",
  expired: "neutral",
};

/** Left-to-right isolate and its end: references read left to right inside Arabic and Sorani. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
/**
 * First-strong isolate (U+2068) around an amount inside a sentence: «350,000 د.ع» keeps the figure first in Arabic and
 * Sorani (a left-to-right isolate would put the currency first there — docs/areas/used.md).
 */
const FSI = String.fromCharCode(0x2068);

export default function TradeInStatus({ loaderData }: Route.ComponentProps) {
  const answer = useActionData() as ActionAnswer | undefined;
  const view = loaderData.view ?? (answer?.intent === "lookup" && answer.ok ? (answer.view ?? null) : null);
  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-6 lg:pt-8">
      {view ? <Tracking view={view} created={loaderData.created} viaLink={loaderData.view !== null} /> : <TradeInLookup refText={loaderData.ref} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── the request

function Tracking({ view, created, viaLink }: { view: StatusView; created: boolean; viaLink: boolean }) {
  const t = useUsedT();
  const heading = useRef<HTMLHeadingElement>(null);
  // «بانتظار الفحص» only while it is true: once inspected, offered or closed the estimate is just the first estimate.
  const beforeInspection = view.status === "submitted" || view.status === "estimated" || view.status === "inspection_scheduled";
  // Opened from the lookup (not from the link): the answer replaced the card — read the request's heading first.
  useEffect(() => {
    if (!viaLink) heading.current?.focus();
  }, [viaLink]);
  return (
    <>
      <header className="grid gap-2">
        <h1 ref={heading} tabIndex={-1} className="type-h1 text-ink outline-none">
          {t("track.title")}
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2 type-sm text-ink-2">
            {t("track.refLabel")}
            <bdi className="type-code text-ink" dir="ltr">
              {view.ref}
            </bdi>
          </p>
          <Status tone={TONE[view.status] ?? "neutral"} size="lg">
            {t(`track.status.${view.status}`)}
          </Status>
          {/* a trade-in is a request, not an order: «طلب تجريبي» / "Demo request", as on the repair and ticket pages */}
          {view.isDemo ? (
            <DemoNote variant="tag" what="order">
              {t("track.demo")}
            </DemoNote>
          ) : null}
        </div>
      </header>

      {created ? <Created phoneMasked={view.phoneMasked} /> : null}

      {/* Phones: one column in the order that matters (the wrappers step aside: `contents` + `order`); from 1024 the
          decision's column (7: the offer or the estimate, what the inspection found) and the request's column (5: the
          answer to an open offer first — beside the offer band, on the first screen at 1024 and 1440 (round-1 fixes:
          «اقبل العرض» sat at y≈1276 under the inspection's lines) — then the timeline, the device, the inspection's
          time). The reading order stays: the offer, what the inspection found, the answer. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
        <div className="grid min-w-0 content-start gap-6 max-lg:order-1 lg:col-span-7">
          {view.offer ? <Offer view={view} viaLink={viaLink} /> : <EstimatePanel range={view.estimate} reason={view.inspectionReason} pending={beforeInspection} headingLevel={2} />}
        </div>

        <div className="grid min-w-0 content-start gap-6 max-lg:contents lg:col-span-5" data-column="request">
          {view.offer && answering(view, viaLink) ? <OfferAnswer view={view} className="max-lg:order-1" /> : null}
          <Timeline view={view} className="max-lg:order-2" />
          <DeviceCard view={view} className="max-lg:order-3" />
          <VisitCard view={view} className="max-lg:order-4" />
          <nav aria-label={t("track.more")} className="flex flex-wrap gap-x-6 max-lg:order-5">
            <TextLink as={LocaleLink} to="/trade-in">
              {t("track.newRequest")}
            </TextLink>
            <TextLink as={LocaleLink} to="/used">
              {t("track.browseUsed")}
            </TextLink>
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </TextLink>
          </nav>
        </div>
      </div>
    </>
  );
}

/** Just sent: it arrived (the check draws itself), where the inspection time will show, and the link is the receipt. */
function Created({ phoneMasked }: { phoneMasked: string }) {
  const t = useUsedT();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("new");
      await navigator.clipboard.writeText(url.toString());
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };
  const heading = useRef<HTMLHeadingElement>(null);
  // The page opened from the form: move focus to the confirmation so it is read first.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-labelledby="ti-created" className="panel used-done p-5 lg:p-6">
      <SuccessMark size={56} className="sm:row-span-2 sm:self-start" />
      <h2 id="ti-created" ref={heading} tabIndex={-1} className="type-h3 text-ink outline-none">
        {t("track.created.title")}
      </h2>
      <div className="grid gap-3 max-sm:col-span-2">
        <p className="used-read text-ink">{t("track.created.text", { phone: `${LRI}${phoneMasked}${PDI}` })}</p>
        <p className="used-read text-ink-2">{t("track.created.save")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Key size="sm" icon={copied === "done" ? "check" : "copy"} onClick={() => void copy()}>
            {t("track.created.copy")}
          </Key>
          <span className={cx("type-sm", copied === "failed" ? "text-danger" : "text-ink-2")} role="status">
            {copied === "done" ? t("track.created.copied") : copied === "failed" ? t("track.created.copyFailed") : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── the offer

/**
 * The final, human-approved offer on the wallet band, what the inspection found, and the answer. While it is open (and
 * the page was opened with the link or by its account), the shopper chooses the payout and answers here.
 */
function Offer({ view, viaLink }: { view: StatusView; viaLink: boolean }) {
  const t = useUsedT();
  const ui = useT("ui");
  const f = useFormat();
  const answer = useActionData() as ActionAnswer | undefined;
  const navigation = useNavigation();
  const offer = view.offer!;
  // Once the answer is recorded the keys are gone (the dialog's trigger with them): focus goes to the offer's heading,
  // so the outcome is read next instead of focus falling back to the top of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const answered = answer?.intent === "respond" && answer.ok;
  useEffect(() => {
    if (answered && navigation.state === "idle") heading.current?.focus();
  }, [answered, navigation.state]);
  const figure = f.number(offer.amountIqd);
  const showDate = offer.expiresAt !== null && (view.status === "offered" || view.status === "expired");

  return (
    <section aria-labelledby="ti-offer" className="grid gap-6" data-offer={view.status}>
      <Band kind="wallet" as="div" className="p-5 lg:p-7" contentClassName="grid gap-3">
        <div className="used-offer__head">
          <div className="grid min-w-0 gap-1">
            <h2 id="ti-offer" ref={heading} tabIndex={-1} className="wallet__label outline-none">
              {t("track.offer.title")}
            </h2>
            {/* the price's own classes around a figure that counts up once (Price has no count: see Requests) */}
            <p className="price price--xl">
              <span className="price__amount" aria-hidden="true">
                <span className="price__num">
                  <CountUp value={offer.amountIqd} format={f.number} />
                </span>
                <span className="price__cur">{CURRENCIES.IQD.symbol[f.locale]}</span>
              </span>
              <VisuallyHidden>{ui("price.aria", { amount: figure })}</VisuallyHidden>
            </p>
          </div>
          <span className="clay-disc used-disc used-disc--lg" aria-hidden="true">
            <Icon name="hand-coins" size={28} />
          </span>
        </div>
        <p className="used-read">{t("track.offer.text")}</p>
        {view.estimate ? <p className="used-read">{t("track.offer.firstEstimate", { range: rangeText(view.estimate, t, f) })}</p> : null}
        {showDate && offer.expiresAt !== null ? (
          <p className="used-date">
            <Icon name={offer.expired ? "hourglass" : "calendar"} size={18} />
            {offer.expired ? t("track.offer.expired", { date: f.date(offer.expiresAt, "short") }) : t("track.offer.validUntil", { date: f.date(offer.expiresAt, "short") })}
          </p>
        ) : null}
      </Band>

      {/* answered: the outcome first (the check draws itself), what the inspection found after it; still open: what
          the inspection found BEFORE the answer */}
      {view.status === "accepted" || view.status === "paid" ? (
        <div className="panel used-done p-5 lg:p-6" role="status">
          <SuccessMark size={56} className="sm:row-span-2 sm:self-start" />
          <p className="type-h3 text-ink">{t("track.offer.acceptedTitle")}</p>
          <div className="grid gap-1 max-sm:col-span-2">
            <p className="used-read text-ink">{t("track.offer.acceptedNext")}</p>
            {view.payoutMethod ? <p className="type-sm-strong text-ink">{t("track.offer.payoutChosen", { method: t(`track.payout.${view.payoutMethod}`) })}</p> : null}
          </div>
        </div>
      ) : view.status === "declined" ? (
        <Note icon="arrow-counter-clockwise">{t("track.offer.declined")}</Note>
      ) : null}

      {view.inspection ? <InspectionResult inspection={view.inspection} /> : null}

      {/* the answer itself heads the request's column (Tracking) */}
      {view.status === "accepted" || view.status === "paid" || view.status === "declined" || answering(view, viaLink) ? null : view.status === "offered" && !offer.expired ? (
        <Note
          icon="link"
          action={
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </TextLink>
          }
        >
          {t("track.offer.withLink")}
        </Note>
      ) : view.status === "expired" ? (
        // A declined or expired offer can be replaced by a new one (admin module 13): the way to ask, no promise.
        <Note
          icon="hourglass"
          title={t("track.timeline.expired")}
          action={
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </TextLink>
          }
        >
          {t("track.offer.expiredNext")}
        </Note>
      ) : null}
    </section>
  );
}

/** The shopper answers here: an open offer, and the page opened with the link or by its account. */
function answering(view: StatusView, viaLink: boolean): boolean {
  return view.status !== "accepted" && view.status !== "paid" && view.status !== "declined" && view.canRespond && viaLink;
}

/**
 * The answer: how to be paid (raised option cards, each with its icon) and «اقبل العرض» / «ارفض العرض». The keys are
 * ONE component drawn in two places — under the cards from 1024, in the task bar below it — never both on screen. From
 * 1024 the card heads the request's column, beside the offer band; on phones it follows what the inspection found.
 */
function OfferAnswer({ view, className }: { view: StatusView; className?: string }) {
  const t = useUsedT();
  const errorText = useErrorText();
  const submit = useSubmit();
  const navigation = useNavigation();
  const answer = useActionData() as ActionAnswer | undefined;
  const failed = answer?.intent === "respond" && !answer.ok ? answer : null;
  const pending = navigation.state !== "idle" && navigation.formData?.get("intent") === "respond";
  const [declining, setDeclining] = useState(false);
  const [missing, setMissing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const payoutError = missing ? errorText("payout_required") : (failed?.fields?.payout ?? undefined);

  // Accepting without a payout is said at the cards before anything is sent (the server says the same without script).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!navigator.onLine) {
      event.preventDefault();
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const chosen = new FormData(event.currentTarget).get("payout");
    if (submitter?.value === "accept" && !chosen) {
      event.preventDefault();
      setMissing(true);
      const first = event.currentTarget.querySelector<HTMLInputElement>('input[name="payout"]:not(:disabled)');
      first?.focus();
      first?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  const keys = (compact: boolean) => <OfferKeys compact={compact} accepting={pending && navigation.formData?.get("decision") === "accept"} onDecline={() => setDeclining(true)} />;
  return (
    <>
      <Form id={ANSWER_FORM} ref={form} method="post" className={cx("panel grid gap-5 p-5 lg:p-6", className)} onSubmit={onSubmit} onChange={() => setMissing(false)}>
        <input type="hidden" name="intent" value="respond" />
        <FieldGroup legend={t("track.offer.payout")} required error={payoutError}>
          <OptionCard
            className="surface"
            name="payout"
            value="store_credit"
            label={t("track.offer.credit")}
            hint={view.canChooseCredit ? t("track.offer.creditHint") : t("track.offer.creditNeedsAccount")}
            disabled={!view.canChooseCredit}
            end={<PayIcon icon="wallet" />}
          />
          <OptionCard className="surface" name="payout" value="cash" label={t("track.offer.cash")} hint={t("track.offer.cashHint")} defaultChecked={!view.canChooseCredit} end={<PayIcon icon="money" />} />
        </FieldGroup>
        {failed && !failed.fields ? (
          <div className="callout callout--danger" role="alert">
            <Icon name="warning-circle" size={20} />
            <span className="callout__text text-ink">{failed.message ?? errorText(failed.code)}</span>
          </div>
        ) : null}
        <div className="max-lg:hidden">{keys(false)}</div>
      </Form>
      <TaskBar aria-label={t("track.offer.title")} className="lg:hidden">
        {keys(true)}
      </TaskBar>
      <ConfirmDialog
        open={declining}
        onClose={() => setDeclining(false)}
        tone="destructive"
        title={t("track.offer.declineTitle")}
        consequence={t("track.offer.declineText")}
        confirmLabel={t("track.offer.decline")}
        pending={pending}
        onConfirm={() => {
          if (navigator.onLine) submit({ intent: "respond", decision: "decline" }, { method: "post" });
          setDeclining(false);
        }}
      />
    </>
  );
}

function PayIcon({ icon }: { icon: IconName }) {
  return (
    <span className="clay-disc used-pay__icon" aria-hidden="true">
      <Icon name={icon} size={20} />
    </span>
  );
}

/** «اقبل العرض» (the view's one primary, submits the answer's form from wherever it is) and «ارفض العرض». */
function OfferKeys({ compact, accepting, onDecline }: { compact: boolean; accepting: boolean; onDecline: () => void }) {
  const t = useUsedT();
  const online = useOnline();
  const reasonId = useId();
  // Offline the answer cannot leave the device (it would end on the error page): both keys go flat, with the reason.
  const offline = { disabled: !online, "aria-describedby": online ? undefined : reasonId };
  const decline = (
    <Key type="button" onClick={onDecline} className={compact ? "shrink-0" : "w-full"} {...offline}>
      {t(compact ? "track.offer.declineShort" : "track.offer.decline")}
    </Key>
  );
  const accept = (
    <Key type="submit" form={ANSWER_FORM} name="decision" value="accept" variant="primary" iconEnd="check" loading={accepting} className={compact ? "min-w-0 flex-1" : "w-full"} {...offline}>
      {t(compact ? "track.offer.acceptShort" : "track.offer.accept")}
    </Key>
  );
  return (
    // the column is the bar's width, never the keys' (at 320 in Sorani the accept key ran 43px off the screen — review
    // 2026-11-13; `.used-keys` in used.css tightens the keys there)
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {online ? null : (
        <p id={reasonId} className="flex items-start gap-1.5 type-xs text-ink-2" role="status">
          <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
          {t("track.offer.offline")}
        </p>
      )}
      {compact ? (
        <div className="used-keys flex items-center gap-2 min-[22.5rem]:gap-3">
          {decline}
          {accept}
        </div>
      ) : (
        // the request's column from 1024 (round-1 fixes): the primary on top, both whole-width — side by side the
        // column's 312px cut the primary's words to «اقبل العر…» at 1024
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {accept}
          {decline}
        </div>
      )}
    </div>
  );
}

/**
 * What the inspection found, as the offer was made on it: the grade (with its legend and hint), the result in one line,
 * the checklist — each line with its icon, the checks that found a problem first — arriving one after another, and what
 * was handed over with the device. Phones: the problems in sight, the whole list in a disclosure (review 2026-11-13).
 */
function InspectionResult({ inspection }: { inspection: NonNullable<StatusView["inspection"]> }) {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const accessory = useAccessoryLabel();
  const failedChecks = inspection.checks.filter((check) => !check.ok);
  const ordered = [...failedChecks, ...inspection.checks.filter((check) => check.ok)];
  const counted = inspection.passed !== null && inspection.failed !== null ? inspection.passed + inspection.failed : null;
  const allChecks = t("track.inspection.allChecks", { count: ordered.length, n: f.number(ordered.length) });
  // the lines at the reading size (G7: 16 / 1.75 — the kit's rows are 14px), used.css .used-checklist
  const checklist = (
    <ul className="inspect__rows used-checks used-checklist" aria-label={allChecks} {...revealProps({ stagger: true })}>
      {ordered.map((check) => (
        <CheckRow key={check.key} ok={check.ok} label={check.label} />
      ))}
    </ul>
  );
  return (
    <section aria-labelledby="ti-inspection" className="panel grid gap-4 p-5 lg:p-6" data-inspection-result="">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="ti-inspection" className="type-h3 text-ink">
          {t("track.inspection.title")}
        </h2>
        {inspection.grade ? <GradeBadge grade={inspection.grade} legend /> : null}
      </div>
      {inspection.grade ? (
        <p className="used-read text-ink-2">
          <span className="sr-only">{t("track.inspection.grade")} </span>
          {shop(`grade.hints.${gradeKey(inspection.grade)}`)}
        </p>
      ) : null}
      {counted !== null && counted > 0 ? (
        <p className="used-title flex items-start gap-2 text-ink">
          <Icon name={inspection.failed ? "warning" : "check-circle"} size={22} filled={!inspection.failed} className={cx("mt-0.5 shrink-0", inspection.failed ? "text-warn" : "text-ok")} />
          <span>
            {inspection.failed
              ? t("track.inspection.someFailed", { passed: f.number(inspection.passed ?? 0), total: f.number(counted), count: inspection.failed, n: f.number(inspection.failed) })
              : t("track.inspection.allPassed", { count: counted, n: f.number(counted) })}
          </span>
        </p>
      ) : null}
      {ordered.length > 0 ? (
        <>
          {/* Phones (review 2026-11-13): eleven lines, mostly green, stood ~950px between the offer and the answer — the
              lines that found a problem stay in sight under the sentence that announces them, and every line is one tap
              away (the kit's Disclosure: native, works before script, its height animates). From 768 the whole list,
              two columns. One of the two is display:none at any width, so assistive technology meets one list. */}
          <div className="grid md:hidden">
            {failedChecks.length > 0 ? (
              // the sentence above announces them («وجد الفحص ملاحظة على:»)
              <ul className="inspect__rows used-checklist">
                {failedChecks.map((check) => (
                  <CheckRow key={check.key} ok={false} label={check.label} />
                ))}
              </ul>
            ) : null}
            <Disclosure summary={allChecks} icon="clipboard-text" className="used-disclosure">
              {checklist}
            </Disclosure>
          </div>
          <div className="max-md:hidden">{checklist}</div>
        </>
      ) : null}
      {/* the checklist's last line already parts it from what was handed over (its own top line drew a second rule) */}
      <p className={cx("used-read flex items-start gap-2 text-ink", ordered.length === 0 && "border-t border-line pt-4")} data-included="">
        <Icon name="package" size={20} className="mt-1 shrink-0 text-ink-2" />
        <span>
          <b className="font-semibold">{t("track.inspection.included")}</b> {inspection.included.length > 0 ? inspection.included.map(accessory).join(t("tradein.listJoin")) : t("tradein.q.included.none")}
        </span>
      </p>
    </section>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  const shop = useT("ui-shop");
  return (
    <li className="inspect__row">
      <Icon name={ok ? "check-circle" : "warning"} size={20} filled={ok} className={ok ? "text-ok" : "text-warn"} />
      <span className="text-ink">
        {label}
        <span className="sr-only"> — {shop(ok ? "inspection.ok" : "inspection.issue")}</span>
      </span>
    </li>
  );
}

// ───────────────────────────────────────────────────────────────── the timeline

type TimelineRow = { key: string; state: "done" | "current" | "upcoming" | "ended"; icon: IconName; title: string; detail: string | null; at: number | null };

const STEP_ICON: Record<string, IconName> = { received: "paper-plane-tilt", schedule: "calendar", inspect: "clipboard-text", offer: "tag", decide: "hand-coins", payout: "wallet" };

/** «من 310,000 د.ع إلى 350,000 د.ع» — each amount kept figure-first inside the sentence. */
function rangeText(range: { minIqd: number; maxIqd: number }, t: TFunction, f: ReturnType<typeof useFormat>): string {
  return t("track.rangeInline", { min: `${FSI}${iqdText(f, range.minIqd)}${PDI}`, max: `${FSI}${iqdText(f, range.maxIqd)}${PDI}` });
}

/**
 * The request's steps as one timeline (pure but for the words): a step is done once its event is in the history (or a
 * later step happened — a walk-in inspection has no appointment), the first step not done is the current one while the
 * request is open, and a declined, expired or cancelled request ends where it ended. Each done step carries when it
 * happened and what it brought.
 */
function useTimeline(view: StatusView): TimelineRow[] {
  const t = useUsedT();
  const f = useFormat();
  const words = useGradeWords();
  const latest = (...kinds: string[]) => [...view.history].reverse().find((entry) => kinds.includes(entry.kind)) ?? null;
  const RANK: Record<string, number> = { submitted: 1, estimated: 1, inspection_scheduled: 2, inspected: 3, offered: 4, expired: 4, accepted: 5, declined: 5, paid: 6, cancelled: 0 };
  const rank = RANK[view.status] ?? 1;
  const reached = (index: number, ...kinds: string[]) => rank > index || latest(...kinds) !== null;

  const offered = latest("offered");
  const steps: TimelineRow[] = [
    {
      key: "received",
      state: "done",
      icon: STEP_ICON.received,
      title: t("track.next.steps.received"),
      detail: view.estimate ? t("track.timeline.estimate", { range: rangeText(view.estimate, t, f) }) : view.inspectionReason ? t("tradein.contact.noEstimate") : null,
      at: latest("submitted")?.at ?? view.createdAt,
    },
    {
      key: "schedule",
      state: reached(1, "inspection_scheduled") ? "done" : "upcoming",
      icon: STEP_ICON.schedule,
      title: t("track.next.steps.schedule"),
      detail: view.inspectionAt !== null ? t("track.timeline.scheduled", { date: f.dateTime(view.inspectionAt) }) : null,
      at: latest("inspection_scheduled")?.at ?? null,
    },
    {
      key: "inspect",
      state: reached(2, "inspected") ? "done" : "upcoming",
      icon: STEP_ICON.inspect,
      title: t("track.next.steps.inspect"),
      detail: view.inspection?.grade ? words(view.inspection.grade) : null,
      at: latest("inspected")?.at ?? null,
    },
    {
      key: "offer",
      state: reached(3, "offered") ? "done" : "upcoming",
      icon: STEP_ICON.offer,
      title: t("track.next.steps.offer"),
      detail: view.offer ? t("track.timeline.offer", { amount: `${FSI}${iqdText(f, offered?.amountIqd ?? view.offer.amountIqd)}${PDI}` }) : null,
      at: offered?.at ?? null,
    },
  ];

  if (view.status === "cancelled") {
    // what happened before the request was closed, then the close
    const done = steps.filter((step) => step.key === "received" || step.at !== null);
    return [...done, { key: "cancelled", state: "ended", icon: "x-circle", title: t("track.timeline.cancelled"), detail: null, at: latest("cancelled")?.at ?? null }];
  }
  if (view.status === "declined" || view.status === "expired") {
    const declined = view.status === "declined";
    return [
      ...steps,
      {
        key: "decide",
        state: "ended",
        icon: declined ? "arrow-counter-clockwise" : "hourglass",
        title: declined ? t("track.timeline.declined") : t("track.timeline.expired"),
        detail: null,
        at: (declined ? latest("declined")?.at : (latest("expired")?.at ?? view.offer?.expiresAt)) ?? null,
      },
    ];
  }
  const accepted = view.status === "accepted" || view.status === "paid";
  const rows: TimelineRow[] = [
    ...steps,
    {
      key: "decide",
      state: accepted ? "done" : "upcoming",
      icon: STEP_ICON.decide,
      title: t("track.next.steps.decide"),
      detail: accepted && view.payoutMethod ? t("track.timeline.acceptedVia", { method: t(`track.payout.${view.payoutMethod}`) }) : view.status === "offered" ? t("track.timeline.yourTurn") : null,
      at: accepted ? (latest("accepted")?.at ?? null) : null,
    },
    { key: "payout", state: view.status === "paid" ? "done" : "upcoming", icon: STEP_ICON.payout, title: t("track.next.steps.payout"), detail: null, at: latest("paid")?.at ?? null },
  ];
  // the first step not done is where the request is now
  const current = rows.findIndex((row) => row.state !== "done");
  if (current >= 0) rows[current] = { ...rows[current], state: "current" };
  return rows;
}

/** «مسار الطلب»: the steps, when each happened, what it brought — the staff steps honestly marked as still to come. */
function Timeline({ view, className }: { view: StatusView; className?: string }) {
  const t = useUsedT();
  const f = useFormat();
  const rows = useTimeline(view);
  const open = !["cancelled", "declined", "expired", "paid"].includes(view.status);
  return (
    <section aria-labelledby="ti-timeline" className={cx("panel grid gap-4 p-5 lg:p-6", className)}>
      <h2 id="ti-timeline" className="type-h3 text-ink">
        {t("track.timeline.title")}
      </h2>
      <ol className="used-timeline">
        {rows.map((row) => (
          <li key={row.key} className="used-timeline__row" data-state={row.state} aria-current={row.state === "current" ? "step" : undefined}>
            <span className="used-timeline__dot" aria-hidden="true">
              <Icon name={row.state === "done" ? "check" : row.icon} size={row.state === "done" ? 18 : 20} />
            </span>
            {/* the step's short bold title and what it brought at the reading size (G7); its time is the meta line */}
            <span className="used-timeline__body">
              <span className={cx("used-title", row.state === "upcoming" ? "text-ink-2" : "text-ink")}>{row.title}</span>
              {row.detail ? <span className="used-read text-ink">{row.detail}</span> : null}
              <span className="type-xs text-ink-2 nums">
                {row.at !== null && (row.state === "done" || row.state === "ended") ? (
                  <>
                    {/* the check says "done" to the eye; the words say it to a screen reader */}
                    {row.state === "done" ? <VisuallyHidden>{`${t("track.next.done")} · `}</VisuallyHidden> : null}
                    <time dateTime={new Date(row.at).toISOString()}>{f.dateTime(row.at)}</time>
                  </>
                ) : row.state === "current" ? (
                  t("track.next.current")
                ) : row.state === "upcoming" ? (
                  t("track.next.upcoming")
                ) : (
                  t("track.next.done")
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {open ? <p className="used-read border-t border-line pt-3 text-ink-2">{t("track.next.staff")}</p> : null}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── the device and the inspection's time

function DeviceCard({ view, className }: { view: StatusView; className?: string }) {
  const t = useUsedT();
  const f = useFormat();
  return (
    <section aria-labelledby="ti-device" className={cx("panel grid gap-4 p-5 lg:p-6", className)}>
      <h2 id="ti-device" className="type-h3 text-ink">
        {t("track.device")}
      </h2>
      <DeviceSummary name={view.device.name} image={view.device.image} />
      <div className="grid gap-1">
        <h3 className="used-title text-ink">{t("track.answers")}</h3>
        <AnswerList questions={view.questions} answers={view.answers} />
      </div>
      <p className="used-read flex items-start gap-2 border-t border-line pt-3 text-ink-2">
        <Icon name="camera" size={16} className="mt-1.5 shrink-0" />
        <span>
          {t("track.photos", { count: view.photoCount, n: f.number(view.photoCount) })} {view.photoCount > 0 ? t("track.photosPrivate") : null}
        </span>
      </p>
    </section>
  );
}

/** The time the store set is a fact of its own — never under the shopper's preference and its "not a confirmed time". */
function VisitCard({ view, className }: { view: StatusView; className?: string }) {
  const t = useUsedT();
  const f = useFormat();
  return (
    <section aria-labelledby="ti-visit" className={cx("panel grid gap-4 p-5 lg:p-6", className)}>
      <h2 id="ti-visit" className="type-h3 text-ink">
        {t("track.visit")}
      </h2>
      {view.inspectionAt !== null ? (
        <VisitRow icon="calendar" label={t("track.inspectionTitle")}>
          <p className="used-title text-ink">
            <time dateTime={new Date(view.inspectionAt).toISOString()}>{f.dateTime(view.inspectionAt)}</time>
          </p>
        </VisitRow>
      ) : null}
      <VisitRow icon="clock" label={t("track.preferred")}>
        <Preferred view={view} />
      </VisitRow>
    </section>
  );
}

function VisitRow({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="clay-disc used-disc" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      {/* what it is, then the fact — both at the reading size (G7), the fact in its weight */}
      <div className="grid min-w-0 gap-0.5 pt-0.5">
        <h3 className="used-read text-ink-2">{label}</h3>
        {children}
      </div>
    </div>
  );
}

function Preferred({ view }: { view: StatusView }) {
  const t = useUsedT();
  const f = useFormat();
  const preferred = view.preferred;
  if (!preferred || (!preferred.day && (!preferred.window || preferred.window === "any"))) return <p className="used-read text-ink-2">{t("track.noPreference")}</p>;
  const parts = [preferred.day ? f.date(Date.parse(`${preferred.day}T12:00:00Z`), "long") : null, preferred.window ? t(`tradein.contact.windows.${preferred.window}`) : null].filter(Boolean);
  return (
    <>
      <p className="used-title text-ink">{parts.join(" · ")}</p>
      <p className="used-read text-ink-2">{t("track.preferenceNote")}</p>
    </>
  );
}
