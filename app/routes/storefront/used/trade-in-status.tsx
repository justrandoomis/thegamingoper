/**
 * /trade-in/:ref — a trade-in request's tracking page (brief §5, DESIGN.md §9.21 "tracking reuses the order timeline").
 *
 * Who may see it (~/server/services/tradein.server): the holder of the link from the confirmation (`?t=<token>`), the
 * signed-in customer who made it, or — without either — whoever gives the reference AND the phone number it was made
 * with (rate-limited; a wrong reference and a wrong phone get the same answer). Nothing is shown from the reference
 * alone: that is the "unauthorized" state, a phone field.
 *
 * Shown: the status in words, the estimate (a range, "بانتظار الفحص", its expiry) or "priced after the inspection",
 * the device and the shopper's description, the preferred time (a preference), how many photos were attached
 * (private), the history, and what happens next — the staff steps (inspection, ownership and account-lock checks,
 * a human-approved final offer, payout as store credit or cash, data wipe) are listed honestly as upcoming. When an
 * employee has issued a final offer, the shopper answers it here: "اقبل العرض" is the page's one commit key (§9.21).
 * The link is never sent by SMS (no provider is configured): the page says so and offers to copy it.
 */
import { useEffect, useRef, useState } from "react";
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
import { FieldGroup, Radio, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { iqdText } from "~/ui/PriceTag";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { AnswerList, DeviceSummary, EstimatePanel, RADIO_GROUP_FIX } from "./components/TradeInParts";
import { combinedErrorT, useErrorText, useUsedT } from "./i18n";

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
      if (!view) return data({ intent: "lookup" as const, ok: false as const, code: "not_found", message: serverT(ctx.locale, "used")("track.lookup.notFound") }, { status: 404 });
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

export default function TradeInStatus({ loaderData }: Route.ComponentProps) {
  const answer = useActionData() as ActionAnswer | undefined;
  const view = loaderData.view ?? (answer?.intent === "lookup" && answer.ok ? (answer.view ?? null) : null);
  return <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-12 lg:pt-8">{view ? <Tracking view={view} created={loaderData.created} viaLink={loaderData.view !== null} /> : <Lookup refText={loaderData.ref} />}</div>;
}

// ───────────────────────────────────────────────────────────────── without the link: reference + phone

function Lookup({ refText }: { refText: string }) {
  const t = useUsedT();
  const errorText = useErrorText();
  const answer = useActionData() as ActionAnswer | undefined;
  const navigation = useNavigation();
  const failed = answer?.intent === "lookup" && !answer.ok ? answer : null;
  const fieldError = failed?.fields?.phone;
  const notFound = failed && !failed.fields ? (failed.message ?? errorText(failed.code)) : null;
  return (
    <section aria-labelledby="ti-lookup" className="grid max-w-[34rem] gap-5">
      <div className="grid gap-2">
        <h1 id="ti-lookup" className="type-title text-ink">
          {t("track.lookup.title")}
        </h1>
        <p className="type-body text-ink-2">{t("track.lookup.text", { ref: `${LRI}${refText}${PDI}` })}</p>
        <p className="flex items-start gap-2 type-caption text-ink-2">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
          {t("track.lookup.why")}
        </p>
      </div>
      <Form method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="intent" value="lookup" />
        <TextField name="phone" type="tel" inputMode="tel" autoComplete="tel-national" label={t("track.lookup.phone")} required error={fieldError} />
        {notFound ? (
          <p className="flex items-start gap-2 rounded-md bg-niche p-3 type-label font-medium text-red-ink" role="alert">
            <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
            <span>{notFound}</span>
          </p>
        ) : null}
        <Key type="submit" variant="ink" loading={navigation.state === "submitting"} className="justify-self-start">
          {t("track.lookup.submit")}
        </Key>
      </Form>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4">
        <TextLink as={LocaleLink} to="/trade-in">
          {t("track.newRequest")}
        </TextLink>
        <TextLink as={LocaleLink} to="/used">
          {t("track.browseUsed")}
        </TextLink>
      </div>
    </section>
  );
}

const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

// ───────────────────────────────────────────────────────────────── the request

function Tracking({ view, created, viaLink }: { view: StatusView; created: boolean; viaLink: boolean }) {
  const t = useUsedT();
  const f = useFormat();
  const ended = view.status === "cancelled" || view.status === "declined" || view.status === "expired" || view.status === "paid";
  return (
    <>
      <header className="grid gap-2">
        <h1 className="type-title text-ink">{t("track.title")}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="type-label text-ink-2">{t("track.ref", { ref: `${LRI}${view.ref}${PDI}` })}</p>
          <Status tone={TONE[view.status] ?? "neutral"} className="font-semibold">
            {t(`track.status.${view.status}`)}
          </Status>
        </div>
      </header>

      {created ? <Created phoneMasked={view.phoneMasked} /> : null}

      <div className="grid gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
        <div className="grid gap-6 lg:col-span-7">
          {view.offer ? <Offer view={view} viaLink={viaLink} /> : null}
          {!view.offer || view.status === "offered" ? (
            <EstimatePanel range={view.estimate} reason={view.inspectionReason} headingLevel={2} />
          ) : null}

          <section aria-labelledby="ti-device" className="grid gap-3 rounded-lg bg-paper p-5">
            <h2 id="ti-device" className="type-label font-semibold text-ink-2">
              {t("track.device")}
            </h2>
            <DeviceSummary name={view.device.name} image={view.device.image} />
            <h3 className="pt-2 type-label font-semibold text-ink">{t("track.answers")}</h3>
            <AnswerList questions={view.questions} answers={view.answers} />
            <p className="flex items-start gap-2 border-t border-line pt-3 type-caption text-ink-2">
              <Icon name="camera" size={16} className="mt-0.5 shrink-0" />
              <span>
                {t("track.photos", { count: view.photoCount, n: f.number(view.photoCount) })} {view.photoCount > 0 ? t("track.photosPrivate") : null}
              </span>
            </p>
          </section>

          <section aria-labelledby="ti-time" className="grid gap-1 rounded-lg bg-paper p-5">
            <h2 id="ti-time" className="type-label font-semibold text-ink-2">
              {t("track.preferred")}
            </h2>
            {view.inspectionAt !== null ? <p className="type-body font-semibold text-ink">{t("track.inspectionAt", { date: f.dateTime(view.inspectionAt) })}</p> : null}
            <Preferred view={view} />
          </section>

          {view.isDemo ? <DemoNote /> : null}
        </div>

        <div className="grid gap-6 lg:col-span-5">
          {!ended ? <NextSteps status={view.status} /> : null}
          <History view={view} />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <TextLink as={LocaleLink} to="/trade-in">
              {t("track.newRequest")}
            </TextLink>
            <TextLink as={LocaleLink} to="/used">
              {t("track.browseUsed")}
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
  if (!view.preferred) return <p className="type-body text-ink-2">{t("track.noPreference")}</p>;
  const day = view.preferred.day ? f.date(Date.parse(`${view.preferred.day}T12:00:00Z`), "long") : t("tradein.contact.anyDay");
  const window = t(`tradein.contact.windows.${view.preferred.window ?? "any"}`);
  return (
    <>
      <p className="type-body text-ink">
        {day} · {window}
      </p>
      <p className="type-caption text-ink-2">{t("track.preferenceNote")}</p>
    </>
  );
}

/** Just created: say it arrived, who calls whom, and that the link is the receipt (no SMS provider yet). */
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
    <section aria-labelledby="ti-created" className="grid gap-3 rounded-lg bg-paper p-5">
      <h2 id="ti-created" ref={heading} tabIndex={-1} className="flex items-center gap-2 type-sub text-ink outline-none">
        <Icon name="check-circle" size={22} filled className="shrink-0 text-ok" />
        {t("track.created.title")}
      </h2>
      <p className="type-body text-ink">{t("track.created.text", { phone: `${LRI}${phoneMasked}${PDI}` })}</p>
      <p className="type-caption text-ink-2">{t("track.created.save")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Key size="sm" icon={copied === "done" ? "check" : "copy"} onClick={() => void copy()}>
          {t("track.created.copy")}
        </Key>
        <span className={cx("type-caption", copied === "failed" ? "text-red-ink" : "text-ink-2")} role="status">
          {copied === "done" ? t("track.created.copied") : copied === "failed" ? t("track.created.copyFailed") : ""}
        </span>
      </div>
    </section>
  );
}

/** The final, human-approved offer. While it is open, the shopper answers here (the one commit key). */
function Offer({ view, viaLink }: { view: StatusView; viaLink: boolean }) {
  const t = useUsedT();
  const f = useFormat();
  const errorText = useErrorText();
  const submit = useSubmit();
  const navigation = useNavigation();
  const answer = useActionData() as ActionAnswer | undefined;
  const [declining, setDeclining] = useState(false);
  const offer = view.offer!;
  const failed = answer?.intent === "respond" && !answer.ok ? answer : null;
  const pending = navigation.state === "submitting" && navigation.formData?.get("intent") === "respond";
  const canAnswer = view.canRespond && viaLink;

  return (
    <section aria-labelledby="ti-offer" className="grid gap-4 rounded-lg bg-paper p-5" data-offer={view.status}>
      <div className="grid gap-1">
        <h2 id="ti-offer" className="type-label font-semibold text-ink-2">
          {t("track.offer.title")}
        </h2>
        <Price amountIqd={offer.amountIqd} size="xl" approx="off" />
        <p className="type-caption text-ink-2">{t("track.offer.text")}</p>
        {offer.expiresAt !== null && view.status === "offered" ? (
          <p className={cx("type-caption", offer.expired ? "font-medium text-warn" : "text-ink-2")}>
            {offer.expired ? t("track.offer.expired", { date: f.date(offer.expiresAt) }) : t("track.offer.validUntil", { date: f.date(offer.expiresAt) })}
          </p>
        ) : null}
      </div>

      {view.status === "accepted" || view.status === "paid" ? (
        <p className="type-body text-ink">
          {t("track.offer.accepted")} {view.payoutMethod ? `(${t(`track.payout.${view.payoutMethod}`)})` : null}
        </p>
      ) : view.status === "declined" ? (
        <p className="type-body text-ink">{t("track.offer.declined")}</p>
      ) : canAnswer ? (
        <Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="respond" />
          <FieldGroup legend={t("track.offer.payout")} required error={failed?.fields?.payout} className={RADIO_GROUP_FIX}>
            <Radio
              row
              name="payout"
              value="store_credit"
              label={t("track.offer.credit")}
              hint={view.canChooseCredit ? t("track.offer.creditHint") : t("track.offer.creditNeedsAccount")}
              disabled={!view.canChooseCredit}
            />
            <Radio row name="payout" value="cash" label={t("track.offer.cash")} hint={t("track.offer.cashHint")} defaultChecked={!view.canChooseCredit} />
          </FieldGroup>
          {failed && !failed.fields ? (
            <p className="type-label font-medium text-red-ink" role="alert">
              {failed.message ?? errorText(failed.code)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Key type="submit" name="decision" value="accept" variant="commit" loading={pending && navigation.formData?.get("decision") === "accept"}>
              {t("track.offer.accept")}
            </Key>
            <Key type="button" onClick={() => setDeclining(true)}>
              {t("track.offer.decline")}
            </Key>
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
              submit({ intent: "respond", decision: "decline" }, { method: "post" });
              setDeclining(false);
            }}
          />
        </Form>
      ) : view.status === "offered" && !offer.expired ? (
        <p className="type-caption text-ink-2">{t("track.offer.withLink")}</p>
      ) : null}
    </section>
  );
}

/** What happens next: the request's steps, with the staff steps honestly marked as still to come. */
function NextSteps({ status }: { status: string }) {
  const t = useUsedT();
  const RANK: Record<string, number> = { submitted: 1, estimated: 1, inspection_scheduled: 2, inspected: 3, offered: 4, accepted: 5, paid: 6 };
  const reached = RANK[status] ?? 1;
  const steps = ["received", "schedule", "inspect", "offer", "decide", "payout"] as const;
  return (
    <section aria-labelledby="ti-next" className="grid gap-3 rounded-lg bg-paper p-5">
      <h2 id="ti-next" className="type-sub text-ink">
        {t("track.next.title")}
      </h2>
      <ol className="grid gap-0">
        {steps.map((step, index) => {
          const state = index < reached ? "done" : index === reached ? "current" : "upcoming";
          return (
            <li key={step} className="relative flex gap-3 pb-4 last:pb-0" aria-current={state === "current" ? "step" : undefined}>
              {index < steps.length - 1 ? <span className={cx("absolute start-[11px] top-7 bottom-0 w-px", state === "done" ? "bg-ink" : "bg-line-strong")} aria-hidden="true" /> : null}
              <span
                className={cx(
                  "relative grid size-6 shrink-0 place-items-center rounded-full",
                  state === "done" && "bg-ink text-paper",
                  state === "current" && "border-2 border-ink bg-paper",
                  state === "upcoming" && "border-[1.5px] border-line-strong bg-paper",
                )}
                aria-hidden="true"
              >
                {state === "done" ? <Icon name="check" size={14} /> : null}
              </span>
              <span className="grid min-w-0 gap-0.5 pt-0.5">
                <span className={cx("type-label", state === "upcoming" ? "text-ink-2" : "font-semibold text-ink")}>{t(`track.next.steps.${step}`)}</span>
                <span className="type-caption text-ink-2">{t(`track.next.${state}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line pt-3 type-caption text-ink-2">{t("track.next.staff")}</p>
    </section>
  );
}

/** The request's history (DESIGN.md §10 audit timeline, flat): oldest first, with the amounts where there are some. */
function History({ view }: { view: StatusView }) {
  const t = useUsedT();
  const f = useFormat();
  const KNOWN = new Set(["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "paid", "cancelled", "expired"]);
  return (
    <section aria-labelledby="ti-history" className="grid gap-3 rounded-lg bg-paper p-5">
      <h2 id="ti-history" className="type-sub text-ink">
        {t("track.history")}
      </h2>
      <ol className="grid">
        {view.history.map((entry, index) => (
          <li key={`${entry.kind}-${entry.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
            {index < view.history.length - 1 ? <span className="absolute start-[3px] top-3 bottom-0 w-px bg-line" aria-hidden="true" /> : null}
            <span className="relative mt-1.5 size-[7px] shrink-0 rounded-full bg-ink" aria-hidden="true" />
            <span className="grid min-w-0 gap-0.5">
              <span className="type-label text-ink">
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
              <time dateTime={new Date(entry.at).toISOString()} className="type-caption text-ink-2 nums">
                {f.dateTime(entry.at)}
              </time>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
