/**
 * /trade-in/:ref — a trade-in request's tracking page (Design System v2 §6.14 "and status", the order-status pattern of
 * §6.11).
 *
 * Who may see it (~/server/services/tradein.server): the holder of the link from the confirmation (`?t=<token>`), the
 * signed-in customer who made it, or — without either — whoever gives the reference AND the phone number it was made
 * with (rate-limited; a wrong reference and a wrong phone get the same answer). Nothing is shown from the reference
 * alone: that is the "unauthorized" state, the lookup card (./components/TradeInLookup).
 *
 * Shown: the reference (type-code) and the status in words; just after sending, «استلمنا طلبك» with the copy-link key
 * (no SMS provider: said plainly); the final offer when staff made one — with what the inspection found BEFORE the
 * shopper answers (the grade with its legend, the checklist result and lines, what was handed over: the latest
 * `offered` history event, written by admin module 13) — and, while it is open and the page was opened with the link or
 * by the account that made it, the payout choice and «اقبل العرض» (the view's one primary) / «ارفض العرض» (confirmed
 * first); the estimate (a range, «بانتظار الفحص», its expiry) or "priced after the inspection" — after the inspection
 * only «التقدير المبدئي» and its range, beside the offer; the device and the
 * shopper's description; the inspection time the store set (its own fact) and the preferred time (a preference); the
 * photo count (private); what happens next (staff steps as upcoming); the history.
 * States: unauthorized (lookup) · not found (the same sentence) · each status · offer open / answered / expired (an
 * open offer past its date reads "expired" before the daily job closes it, with the way to ask for a new one) · answer
 * failures (a sentence above the keys) · offline (the answer and lookup keys go flat with the reason; nothing is sent
 * into the error page) · demo request (the demo line).
 */
import { useEffect, useId, useRef, useState } from "react";
import { data, Form, useActionData, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/trade-in-status";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { getTradeInByRef, lookupTradeIn, normalizeTradeInRef, questionsFor, respondToOffer, type TradeInView } from "~/server/services/tradein.server";
import { cx } from "~/ui/cx";
import { ConfirmDialog } from "~/ui/Dialog";
import { DemoNote } from "~/ui/DemoNote";
import { Disclosure } from "~/ui/Disclosure";
import { FieldGroup, OptionCard } from "~/ui/Field";
import { GradeBadge, gradeKey } from "~/ui/GradeBadge";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { Price } from "~/ui/Price";
import { iqdText } from "~/ui/PriceTag";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { TradeInLookup } from "./components/TradeInLookup";
import { AnswerList, DeviceSummary, EstimatePanel, useAccessoryLabel } from "./components/TradeInParts";
import { combinedErrorT, useErrorText, useUsedT } from "./i18n";
import "./used.css";

/** The one "talk to a person" destination of the store (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";

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
  try {
    if (intent === "lookup") {
      const view = await lookupTradeIn(db, { ref: params.ref, phone: form.get("phone") }, { ip: ctx.ip }, ctx.locale, ctx.now);
      // "No match" is an answer, not a failure of the request: the same sentence for a wrong reference and a wrong phone.
      if (!view) return { intent: "lookup" as const, ok: false as const, code: "not_found", message: serverT(ctx.locale, "used")("track.lookup.notFound") };
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
    return data({ intent: intent === "lookup" || intent === "respond" ? intent : null, ...failure }, { status: failure.status });
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

/** Left-to-right isolate and its end: references and amounts read left to right inside Arabic and Sorani. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

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
  const f = useFormat();
  const heading = useRef<HTMLHeadingElement>(null);
  const ended = view.status === "cancelled" || view.status === "declined" || view.status === "expired" || view.status === "paid";
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
          {view.isDemo ? <DemoNote variant="tag" what="order" /> : null}
        </div>
      </header>

      {created ? <Created phoneMasked={view.phoneMasked} /> : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
        <div className="grid min-w-0 content-start gap-6 lg:col-span-7">
          {view.offer ? <Offer view={view} viaLink={viaLink} /> : null}
          {!view.offer || view.status === "offered" ? <EstimatePanel range={view.estimate} reason={view.inspectionReason} pending={beforeInspection} headingLevel={2} /> : null}

          <section aria-labelledby="ti-device" className="panel grid gap-4 p-5">
            <h2 id="ti-device" className="type-sm-strong text-ink-2">
              {t("track.device")}
            </h2>
            <DeviceSummary name={view.device.name} image={view.device.image} />
            <div className="grid gap-1">
              <h3 className="type-sm-strong text-ink">{t("track.answers")}</h3>
              <AnswerList questions={view.questions} answers={view.answers} />
            </div>
            <p className="flex items-start gap-2 border-t border-line pt-3 type-sm text-ink-2">
              <Icon name="camera" size={16} className="mt-0.5 shrink-0" />
              <span>
                {t("track.photos", { count: view.photoCount, n: f.number(view.photoCount) })} {view.photoCount > 0 ? t("track.photosPrivate") : null}
              </span>
            </p>
          </section>

          {/* The time the store set is a fact of its own — never under the shopper's preference and its "not a
              confirmed time" note. */}
          {view.inspectionAt !== null ? (
            <section aria-labelledby="ti-at" className="panel grid gap-1 p-5">
              <h2 id="ti-at" className="type-sm-strong text-ink-2">
                {t("track.inspectionTitle")}
              </h2>
              <p className="type-body font-semibold text-ink">
                <time dateTime={new Date(view.inspectionAt).toISOString()}>{f.dateTime(view.inspectionAt)}</time>
              </p>
            </section>
          ) : null}
          <section aria-labelledby="ti-time" className="panel grid gap-1 p-5">
            <h2 id="ti-time" className="type-sm-strong text-ink-2">
              {t("track.preferred")}
            </h2>
            <Preferred view={view} />
          </section>
        </div>

        <div className="grid min-w-0 content-start gap-6 lg:col-span-5">
          {!ended ? <NextSteps status={view.status} /> : null}
          <History view={view} />
          <div className="flex flex-wrap gap-x-6">
            <TextLink as={LocaleLink} to="/trade-in">
              {t("track.newRequest")}
            </TextLink>
            <TextLink as={LocaleLink} to="/used">
              {t("track.browseUsed")}
            </TextLink>
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </TextLink>
          </div>
        </div>
      </div>
    </>
  );
}

function Preferred({ view }: { view: StatusView }) {
  const t = useUsedT();
  const f = useFormat();
  const preferred = view.preferred;
  if (!preferred || (!preferred.day && (!preferred.window || preferred.window === "any"))) return <p className="type-body text-ink-2">{t("track.noPreference")}</p>;
  const parts = [preferred.day ? f.date(Date.parse(`${preferred.day}T12:00:00Z`), "long") : null, preferred.window ? t(`tradein.contact.windows.${preferred.window}`) : null].filter(Boolean);
  return (
    <>
      <p className="type-body text-ink">{parts.join(" · ")}</p>
      <p className="type-sm text-ink-2">{t("track.preferenceNote")}</p>
    </>
  );
}

/** Just sent: it arrived, where the inspection time will show, and that the link is the receipt (no SMS provider). */
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
    <section aria-labelledby="ti-created" className="panel grid gap-3 p-5">
      <h2 id="ti-created" ref={heading} tabIndex={-1} className="flex items-center gap-2 type-h3 text-ink outline-none">
        <Icon name="check-circle" size={24} filled className="shrink-0 text-ok" />
        {t("track.created.title")}
      </h2>
      <p className="type-body text-ink">{t("track.created.text", { phone: `${LRI}${phoneMasked}${PDI}` })}</p>
      <p className="type-sm text-ink-2">{t("track.created.save")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Key size="sm" icon={copied === "done" ? "check" : "copy"} onClick={() => void copy()}>
          {t("track.created.copy")}
        </Key>
        <span className={cx("type-sm", copied === "failed" ? "text-danger" : "text-ink-2")} role="status">
          {copied === "done" ? t("track.created.copied") : copied === "failed" ? t("track.created.copyFailed") : ""}
        </span>
      </div>
    </section>
  );
}

/**
 * The final, human-approved offer and what the inspection found. While it is open (and the page was opened with the
 * link or by its account), the shopper chooses the payout and answers here: «اقبل العرض» is the page's one primary.
 */
function Offer({ view, viaLink }: { view: StatusView; viaLink: boolean }) {
  const t = useUsedT();
  const f = useFormat();
  const errorText = useErrorText();
  const submit = useSubmit();
  const navigation = useNavigation();
  const answer = useActionData() as ActionAnswer | undefined;
  const [declining, setDeclining] = useState(false);
  const online = useOnline();
  const reasonId = useId();
  const offer = view.offer!;
  const failed = answer?.intent === "respond" && !answer.ok ? answer : null;
  const pending = navigation.state !== "idle" && navigation.formData?.get("intent") === "respond";
  const canAnswer = view.canRespond && viaLink;
  // Offline the answer cannot leave the device (it would end on the error page): both keys go flat, with the reason.
  const offline = { disabled: !online, "aria-describedby": online ? undefined : reasonId };
  // Once the answer is recorded the keys are gone (the dialog's trigger with them): focus goes to the offer's heading,
  // so the outcome is read next instead of focus falling back to the top of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const answered = answer?.intent === "respond" && answer.ok;
  useEffect(() => {
    if (answered && navigation.state === "idle") heading.current?.focus();
  }, [answered, navigation.state]);

  return (
    <section aria-labelledby="ti-offer" className="panel grid gap-5 p-5 lg:p-6" data-offer={view.status}>
      <div className="grid gap-1">
        <h2 id="ti-offer" ref={heading} tabIndex={-1} className="type-sm-strong text-ink-2 outline-none">
          {t("track.offer.title")}
        </h2>
        <Price amountIqd={offer.amountIqd} size="xl" approx="off" />
        <p className="type-sm text-ink-2">{t("track.offer.text")}</p>
        {offer.expiresAt !== null && (view.status === "offered" || view.status === "expired") ? (
          <p className={cx("type-sm", offer.expired ? "font-semibold text-warn" : "text-ink-2")}>
            {offer.expired ? t("track.offer.expired", { date: f.date(offer.expiresAt, "short") }) : t("track.offer.validUntil", { date: f.date(offer.expiresAt, "short") })}
          </p>
        ) : null}
      </div>

      {view.inspection ? <InspectionResult inspection={view.inspection} /> : null}

      {view.status === "accepted" || view.status === "paid" ? (
        <p className="callout callout--ok">
          <Icon name="check-circle" size={20} />
          <span className="callout__text text-ink">
            {t("track.offer.accepted")}
            {view.payoutMethod ? <span className="mt-1 block font-semibold">{t("track.offer.payoutChosen", { method: t(`track.payout.${view.payoutMethod}`) })}</span> : null}
          </span>
        </p>
      ) : view.status === "declined" ? (
        <p className="type-body text-ink">{t("track.offer.declined")}</p>
      ) : canAnswer ? (
        <Form method="post" className="grid gap-4 border-t border-line pt-5" onSubmit={(event) => (navigator.onLine ? undefined : event.preventDefault())}>
          <input type="hidden" name="intent" value="respond" />
          <FieldGroup legend={t("track.offer.payout")} required error={failed?.fields?.payout}>
            <OptionCard
              name="payout"
              value="store_credit"
              label={t("track.offer.credit")}
              hint={view.canChooseCredit ? t("track.offer.creditHint") : t("track.offer.creditNeedsAccount")}
              disabled={!view.canChooseCredit}
            />
            <OptionCard name="payout" value="cash" label={t("track.offer.cash")} hint={t("track.offer.cashHint")} defaultChecked={!view.canChooseCredit} />
          </FieldGroup>
          {failed && !failed.fields ? (
            <div className="callout callout--danger" role="alert">
              <Icon name="warning-circle" size={20} />
              <span className="callout__text text-ink">{failed.message ?? errorText(failed.code)}</span>
            </div>
          ) : null}
          <div className="grid gap-2">
            {online ? null : (
              <p id={reasonId} className="flex items-start gap-1.5 type-xs text-ink-2" role="status">
                <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
                {t("track.offer.offline")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Key type="submit" name="decision" value="accept" variant="primary" loading={pending && navigation.formData?.get("decision") === "accept"} {...offline}>
                {t("track.offer.accept")}
              </Key>
              <Key type="button" onClick={() => setDeclining(true)} {...offline}>
                {t("track.offer.decline")}
              </Key>
            </div>
          </div>
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
        </Form>
      ) : view.status === "offered" && !offer.expired ? (
        <p className="type-sm text-ink-2">
          {t("track.offer.withLink")}{" "}
          <TextLink as={LocaleLink} to={HANDOFF} inline>
            {t("tradein.device.support")}
          </TextLink>
        </p>
      ) : view.status === "expired" ? (
        // A declined or expired offer can be replaced by a new one (admin module 13): the way to ask, no promise.
        <p className="type-sm text-ink-2">
          {t("track.offer.expiredNext")}{" "}
          <TextLink as={LocaleLink} to={HANDOFF} inline>
            {t("tradein.device.support")}
          </TextLink>
        </p>
      ) : null}
    </section>
  );
}

/**
 * What the inspection found, as the offer was made on it: the grade (with its legend), the checklist result — the
 * checks that found a problem named first, every line one tap away — and what was handed over with the device.
 */
function InspectionResult({ inspection }: { inspection: NonNullable<StatusView["inspection"]> }) {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const accessory = useAccessoryLabel();
  const problems = inspection.checks.filter((check) => !check.ok);
  const counted = inspection.passed !== null && inspection.failed !== null ? inspection.passed + inspection.failed : null;
  return (
    <section aria-labelledby="ti-inspection" className="grid gap-3 border-t border-line pt-5" data-inspection-result="">
      <h3 id="ti-inspection" className="type-sm-strong text-ink">
        {t("track.inspection.title")}
      </h3>
      {inspection.grade ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-sm text-ink-2">{t("track.inspection.grade")}</span>
            <GradeBadge grade={inspection.grade} legend />
          </div>
          <p className="type-sm text-ink-2">{shop(`grade.hints.${gradeKey(inspection.grade)}`)}</p>
        </div>
      ) : null}
      {counted !== null && counted > 0 ? (
        <p className="flex items-start gap-2 type-sm text-ink">
          <Icon name={inspection.failed ? "warning" : "check-circle"} size={20} filled={!inspection.failed} className={cx("shrink-0", inspection.failed ? "text-warn" : "text-ok")} />
          <span>
            {inspection.failed
              ? t("track.inspection.someFailed", { passed: f.number(inspection.passed ?? 0), total: f.number(counted), count: inspection.failed, n: f.number(inspection.failed) })
              : t("track.inspection.allPassed", { count: counted, n: f.number(counted) })}
          </span>
        </p>
      ) : null}
      {problems.length > 0 ? (
        <ul className="inspect__rows" aria-label={t("track.inspection.problems")}>
          {problems.map((check) => (
            <CheckRow key={check.key} ok={false} label={check.label} />
          ))}
        </ul>
      ) : null}
      {inspection.checks.length > 0 ? (
        <Disclosure summary={t("track.inspection.allChecks", { count: inspection.checks.length, n: f.number(inspection.checks.length) })} icon="clipboard-text">
          <ul className="inspect__rows">
            {inspection.checks.map((check) => (
              <CheckRow key={check.key} ok={check.ok} label={check.label} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <p className="type-sm text-ink">
        <b className="font-semibold">{t("track.inspection.included")}</b> {inspection.included.length > 0 ? inspection.included.map(accessory).join(t("tradein.listJoin")) : t("tradein.q.included.none")}
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

/** What happens next: the request's steps, the staff steps honestly marked as still to come (current = an ink disc). */
function NextSteps({ status }: { status: string }) {
  const t = useUsedT();
  const RANK: Record<string, number> = { submitted: 1, estimated: 1, inspection_scheduled: 2, inspected: 3, offered: 4, accepted: 5, paid: 6 };
  const reached = RANK[status] ?? 1;
  const steps = ["received", "schedule", "inspect", "offer", "decide", "payout"] as const;
  return (
    <section aria-labelledby="ti-next" className="panel grid gap-4 p-5">
      <h2 id="ti-next" className="type-h3 text-ink">
        {t("track.next.title")}
      </h2>
      <ol className="grid">
        {steps.map((step, index) => {
          const state = index < reached ? "done" : index === reached ? "current" : "upcoming";
          return (
            <li key={step} className="relative flex gap-3 pb-4 last:pb-0" aria-current={state === "current" ? "step" : undefined}>
              {index < steps.length - 1 ? <span className={cx("absolute start-[11px] top-7 bottom-0 w-px", state === "done" ? "bg-ink" : "bg-line-2")} aria-hidden="true" /> : null}
              <span
                className={cx(
                  "relative grid size-6 shrink-0 place-items-center rounded-full",
                  state === "done" && "bg-ink text-paper",
                  state === "current" && "bg-ink",
                  state === "upcoming" && "border-[1.5px] border-line-strong bg-paper",
                )}
                aria-hidden="true"
              >
                {state === "done" ? <Icon name="check" size={16} /> : state === "current" ? <span className="size-2 rounded-full bg-paper" /> : null}
              </span>
              <span className="grid min-w-0 gap-0.5 pt-0.5">
                <span className={cx("type-sm", state === "upcoming" ? "text-ink-2" : "font-semibold text-ink")}>{t(`track.next.steps.${step}`)}</span>
                <span className="type-xs text-ink-2">{t(`track.next.${state}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line pt-3 type-sm text-ink-2">{t("track.next.staff")}</p>
    </section>
  );
}

/** The request's history: oldest first, with the amounts where there are some. */
function History({ view }: { view: StatusView }) {
  const t = useUsedT();
  const f = useFormat();
  const KNOWN = new Set(["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "paid", "cancelled", "expired"]);
  return (
    <section aria-labelledby="ti-history" className="panel grid gap-4 p-5">
      <h2 id="ti-history" className="type-h3 text-ink">
        {t("track.history")}
      </h2>
      <ol className="grid">
        {view.history.map((entry, index) => (
          <li key={`${entry.kind}-${entry.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
            {index < view.history.length - 1 ? <span className="absolute start-[3px] top-3 bottom-0 w-px bg-line" aria-hidden="true" /> : null}
            <span className="relative mt-1.5 size-2 shrink-0 rounded-full bg-ink" aria-hidden="true" />
            <span className="grid min-w-0 gap-0.5">
              <span className="type-sm text-ink">
                {t(`track.events.${KNOWN.has(entry.kind) ? entry.kind : "update"}`)}
                {entry.minIqd !== undefined && entry.maxIqd !== undefined ? (
                  <>
                    {" · "}
                    <bdi className="nums">{t("tradein.estimate.range", { min: iqdText(f, entry.minIqd), max: iqdText(f, entry.maxIqd) })}</bdi>
                  </>
                ) : null}
                {entry.amountIqd !== undefined ? (
                  <>
                    {" · "}
                    <bdi className="nums">{iqdText(f, entry.amountIqd)}</bdi>
                  </>
                ) : null}
                {entry.payout ? ` · ${t(`track.payout.${entry.payout}`)}` : null}
              </span>
              <time dateTime={new Date(entry.at).toISOString()} className="type-xs text-ink-2 nums">
                {f.dateTime(entry.at)}
              </time>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
