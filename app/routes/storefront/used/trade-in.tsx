/**
 * /trade-in — «استبدل جهازك», the trade-in wizard (Design System v2 §6.14): الجهاز → الحالة → الصور → التقدير → الفحص.
 *
 * The task-flow shell (`chrome: "task"`): the store header, no tab bar — the step's keys in a <TaskBar> below 1024
 * (secondary «رجوع» | primary «تابع», which grows) and at the end of the column from 1024 — and the one-line footer.
 * One centred 720px column; from 1280 a 340px sticky aside beside it (steps: the device, the answers so far, the
 * estimate, what happens next, how to reach a person · the start: the track card).
 *
 * The rail is the before's labelled rail (client note 10, v2.1): five numbered discs, each step's word under its disc
 * on every width (`.used-rail`, used.css — see docs/areas/used.md "Requests").
 *
 * Every step is a URL (./trade-in.server.ts): Back, reload and a shared link work, the question forms are GET forms that
 * submit without script, and steps push sideways in reading order (handle below). Step 1 is the start page in the
 * before's order (client note 10): «استبدل جهازك» and its line, the labelled rail, «أي جهاز تريد استبداله؟» with v2's
 * device search, the device tiles three to a row on phones under each platform's colour line («حتى 350,000 د.ع
 * تقديرياً» — the best case of the wizard's own rules), then what v2.1 adds: a «تحدّث مع موظف» note for a device not on
 * the list, how trading in works (a three-step icon strip), what changes the price (the rules the estimate uses), an
 * FAQ, and the track card (request number + phone → the request's page; also reached from the line under the intro).
 * Then one question per screen as option cards with a line
 * of explanation («السؤال 1 من 5»). Photos are private uploads (POST /api/upload/tradein). The estimate is a RANGE from
 * the model's price guide with «بانتظار الفحص» and its expiry — or, honestly, "priced after the inspection"; a locked
 * device is refused. The last step POSTs the contact details and a preferred time (a preference, never an appointment,
 * and no call promise) and creates the request (~/server/services/tradein.server createTradeIn: rate-limited,
 * idempotent), then goes to /trade-in/<ref>?t=<token>.
 *
 * States: each step · an unknown device · a search without a match · a question sent without an answer (with script:
 * the message and focus on the first option, nothing sent) · a refused device · photo failures (per photo) · field
 * errors (client and server, with the error summary) · rate limits and other failures (a sentence above the keys) ·
 * pending steps (the key spins, the shell's progress bar runs) · sending · offline (the keys go flat with the reason;
 * what was chosen and typed stays) · demo mode (the request is recorded as a demo). The browser's Back from a question
 * shows the previous question with its answer chosen (the history entry is rewritten before moving on).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { data, Form, redirect, useActionData, useLocation, useNavigation, useRouteLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/trade-in";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import type { MotionHandle } from "~/motion";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import { answerStatus, revalidateAfter } from "~/routes/storefront/support/client";
import type { ShellContact, ShellHandle } from "~/routes/storefront/shell/types";
import { getCustomer } from "~/server/auth/customer.server";
import { clearCookie, getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { createTradeIn, getTradeInDevice, readTradeInAnswers, TRADE_IN_DRAFT_COOKIE, type TradeInDevice, type TradeInEstimate } from "~/server/services/tradein.server";
import { getSetting } from "~/server/settings.server";
import { Accordion } from "~/ui/Accordion";
import { ContactCard } from "~/ui/ContactCard";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { FactList } from "~/ui/FactList";
import { Checkbox, FieldGroup, FormErrorSummary, OptionCard, TextArea, TextField, type FormError } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { PreferencePicker, type Period } from "~/ui/PreferencePicker";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { revealProps } from "~/ui/reveal";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { AnswerList, DeviceSummary, EstimatePanel, useAccessoryLabel, WhatNext } from "./components/TradeInParts";
import { TradeInPhotos } from "./components/TradeInPhotos";
import { TradeInTrack } from "./components/TradeInTrack";
import { combinedErrorT, useErrorText, useUsedT } from "./i18n";
import { bindDashes, bindNameTokens, splitQualifier } from "./names";
import { loadWizard, type WizardView } from "./trade-in.server";
import { answeredQuestionSearch, filterGroups, TRADE_IN_PATH, tradeInRefFromInput, WIZARD_STEPS, wizardOrder } from "./wizard";
import "./used.css";

// The task-flow shell; steps push sideways in their own sibling group (other areas' ordered routes never push against them).
export const handle = { shell: { chrome: "task" }, nav: "push", group: "trade-in", order: ({ search }) => wizardOrder(search) } satisfies ShellHandle & MotionHandle;

/** The one "talk to a person" destination of the store (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";
const FORM_ID = "ti-form";
/** Each step's h1: where focus goes after a move between steps (TradeIn). */
const STEP_HEADING = { tabIndex: -1, "data-step-heading": "" } as const;
/** A no-break space: «350,000 د.ع» never splits (the tile's amount, a first-strong isolate: <bdi> keeps the figure first). */
const NBSP = String.fromCharCode(0xa0);
/** The start page's track card (the line under the intro links to it). */
const TRACK_ID = "ti-track";

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const wizard = await loadWizard(db, ctx.locale, new URL(request.url), ctx.cookie(TRADE_IN_DRAFT_COOKIE), ctx.now);
  const t = serverT(ctx.locale, "used");
  // the FAQ's "how long is an estimate valid" is the store's own setting, never a number written into the copy
  const validDays = wizard.view.step === "device" ? await getSetting(db, "tradein.estimate_valid_days") : null;
  return { ...wizard, validDays, meta: { title: t("tradein.title"), description: t("tradein.metaDescription") }, i18n: messagesFor(ctx.locale, "used", "errors") };
}

export const meta: Route.MetaFunction = (args) =>
  // Steps after the first carry the shopper's answers in the query: only the first step is a page for search engines.
  shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: args.location.search !== "" });

/** A request the store refused (fields to fix) changed nothing: nothing is reloaded after it. Steps load as usual. */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return args.formMethod?.toUpperCase() === "POST" ? revalidateAfter(args) : args.defaultShouldRevalidate;
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  // The start page's track card without script (with script it posts to /trade-in/<ref> itself): a number that can be
  // a request number sends the browser on to the request's page with a 307, so the form — the phone — goes along and
  // that page's action looks the request up; anything else is the card's field error.
  if (text("intent") === "lookup") {
    const ref = tradeInRefFromInput(text("ref"));
    // the numbers as typed go back with the refusal, so the card keeps them (review 2026-11-13)
    const typed = { ref: text("ref").slice(0, 24), phone: text("phone").slice(0, 40) };
    if (!ref) return data({ intent: "lookup" as const, ok: false as const, code: "invalid", fields: { ref: serverT(ctx.locale, "used")("tradein.start.track.refInvalid") }, values: typed });
    return redirect(localePath(`/trade-in/${ref}`, ctx.locale), 307);
  }
  const deviceSlug = text("device");
  const device = await getTradeInDevice(db, ctx.locale, deviceSlug);
  const answers = device ? readTradeInAnswers(form, device) : {};
  const window = text("preferredWindow");
  const values = { contactName: text("contactName"), phone: text("phone"), preferredWindow: window, notes: text("notes"), ownership: text("ownership") === "1" };
  try {
    const customer = await getCustomer(ctx, db);
    const made = await createTradeIn(
      db,
      { customerId: customer?.customer.id ?? null, ip: ctx.ip, locale: ctx.locale, storeMode: ctx.storeMode, draftToken: ctx.cookie(TRADE_IN_DRAFT_COOKIE) },
      {
        idempotencyKey: text("idempotencyKey"),
        device: deviceSlug,
        answers,
        contactName: values.contactName,
        phone: values.phone,
        // The preference is the period alone (v2 §4.9 PreferencePicker: no day cells until the owner sets days).
        preferredWindow: window === "any" ? "" : window,
        notes: values.notes,
        ownershipConfirmed: values.ownership,
      },
      ctx.now,
    );
    // The photos now belong to the request: the draft is over.
    ctx.setCookie(clearCookie(ctx, TRADE_IN_DRAFT_COOKIE));
    return redirect(localePath(`/trade-in/${made.ref}?t=${encodeURIComponent(made.accessToken)}&new=1`, ctx.locale));
  } catch (error) {
    const failure = actionError(error, combinedErrorT(serverT(ctx.locale, "used"), serverT(ctx.locale, "errors")));
    // fields the shopper can fix are an answer (200, no "failed request" in the console); a limit or a conflict keeps
    // its 4xx (answerStatus)
    return data({ ...failure, values }, { status: answerStatus(failure) });
  }
}

type LayoutData = { shell?: { contact?: ShellContact } };

export default function TradeIn({ loaderData }: Route.ComponentProps) {
  const t = useUsedT();
  const { view, stepIndex, rail } = loaderData;
  const steps = WIZARD_STEPS.map((step, index) => ({ label: t(`tradein.steps.${step}`), href: rail[index] ?? undefined }));
  const keys = stepKeys(view);
  const location = useLocation();
  const main = useRef<HTMLDivElement>(null);
  // After a move to another step or question (not the page's first view — Back and Forward included), the new step's
  // heading takes focus: a screen reader reads the new question, and the keyboard goes on from it (QA 2026-11-12: focus
  // stayed on «تابع», and nothing said the question had changed — the repair form does the same with its step heading).
  const shown = useRef(location.search);
  useEffect(() => {
    if (shown.current === location.search) return;
    shown.current = location.search;
    main.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
  }, [location.search]);
  // the before's labelled rail: every step's word under its disc (used.css `.used-rail`)
  const railNode = <ProgressSteps steps={steps} current={stepIndex} aria-label={t("tradein.steps.label")} className="used-rail" />;
  const aside = view.step !== "device" || view.groups.length > 0;
  return (
    <div className="page pt-4 pb-6 lg:pt-8">
      <div className={cx("used-wizard", aside && "used-wizard--aside")}>
        <div ref={main} className="used-wizard__main">
          {/* the start page puts the rail under its title and line, as before; the steps keep it on top */}
          {view.step === "device" ? <DeviceStep view={view} rail={railNode} validDays={loaderData.validDays} /> : (
            <>
              {railNode}
              <Step view={view} />
            </>
          )}
          {keys ? <StepKeys keys={keys} className="max-lg:hidden" /> : null}
        </div>
        {view.step !== "device" ? (
          <WizardAside view={view} />
        ) : view.groups.length > 0 ? (
          // below 1280 the card follows the page's sections; from 1280 it stays beside them
          <div className="used-start__aside">
            <TradeInTrack id={TRACK_ID} className="panel" />
          </div>
        ) : null}
      </div>
      {keys ? (
        <TaskBar aria-label={t("tradein.steps.label")} className="lg:hidden">
          <StepKeys keys={keys} compact />
        </TaskBar>
      ) : null}
    </div>
  );
}

function Step({ view }: { view: Exclude<WizardView, { step: "device" }> }) {
  switch (view.step) {
    case "condition":
      return <ConditionStep view={view} />;
    case "photos":
      return <PhotosStep view={view} />;
    case "estimate":
      return <EstimateStep view={view} />;
    case "inspection":
      return <InspectionStep view={view} />;
  }
}

type ViewOf<S extends WizardView["step"]> = Extract<WizardView, { step: S }>;

// ───────────────────────────────────────────────────────────────── the step's keys

type Keys = { back: string | null; next: { href: string } | { form: string } | null; label: "continue" | "toEstimate" | "toInspection" | "submit" };

/** Back and the step's one primary: a link to the next step, or the submit of this step's form. */
function stepKeys(view: WizardView): Keys | null {
  switch (view.step) {
    case "device":
      return null;
    case "condition":
      return { back: view.back, next: { form: FORM_ID }, label: "continue" };
    case "photos":
      return { back: view.back, next: { href: view.next }, label: "toEstimate" };
    case "estimate":
      return { back: view.back, next: view.next ? { href: view.next } : null, label: "toInspection" };
    case "inspection":
      return { back: view.back, next: { form: FORM_ID }, label: "submit" };
  }
}

const LABEL = { continue: "tradein.continue", toEstimate: "tradein.photos.continue", toInspection: "tradein.estimate.continue", submit: "tradein.contact.submit" } as const;
/**
 * The task bar's words (v2 §5.7: «رجوع» | «تابع»): the longer step names did not fit a phone — "Continue to book the
 * inspection" ran 28px off a 390 screen in English, and the Sorani ones off 320–390 — so the bar says «تابع» and, on the
 * last step, «أرسل الطلب»; the keys under the column (from 1024) keep the full names.
 */
const SHORT = { continue: "tradein.continue", toEstimate: "tradein.continue", toInspection: "tradein.continue", submit: "tradein.contact.submitShort" } as const;

/**
 * «رجوع» | «تابع» — the same pair in the task bar (<1024) and under the column (≥1024). While the next step loads (a GET
 * step or the request being sent) the primary keeps its width and spins, so a slow network never gets a double tap.
 * Offline (v2 §6.17 "form kept"): both keys go flat with the reason above them — a step or a request that cannot
 * leave the device would end on the error page and lose what was chosen and typed.
 */
function StepKeys({ keys, compact = false, className }: { keys: Keys; compact?: boolean; className?: string }) {
  const t = useUsedT();
  const navigation = useNavigation();
  const location = useLocation();
  const online = useOnline();
  const reasonId = useId();
  const pending = navigation.state !== "idle" && navigation.location?.pathname === location.pathname;
  const next = keys.next;
  const target: Record<string, unknown> = next === null ? {} : "href" in next ? { as: LocaleLink, to: next.href } : { type: "submit", form: next.form };
  const offline = { disabled: !online, "aria-describedby": online ? undefined : reasonId };
  return (
    // the column is the bar's width, never the keys' (an auto grid track grew to the keys' widths and pushed the primary
    // 7px off a 320 screen in Sorani — review 2026-11-13; `.used-keys` in used.css tightens them there)
    <div className={cx("grid grid-cols-[minmax(0,1fr)] gap-2", className)}>
      {online ? null : (
        <p id={reasonId} className="flex items-start gap-1.5 type-xs text-ink-2" role="status">
          <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
          {t("tradein.offline")}
        </p>
      )}
      <div className="used-keys flex items-center gap-2 min-[22.5rem]:gap-3">
        {keys.back ? (
          <Key as={LocaleLink} to={keys.back} className="shrink-0" {...offline}>
            {t("tradein.back")}
          </Key>
        ) : null}
        {next ? (
          <Key variant="primary" iconEnd={keys.label === "submit" ? "paper-plane-tilt" : "arrow-right"} loading={pending} className="min-w-0 flex-1" {...target} {...offline}>
            {t((compact ? SHORT : LABEL)[keys.label])}
          </Key>
        ) : null}
      </div>
    </div>
  );
}

/** A form that would leave the device while it is offline stays where it is (the keys say why). */
const stayOffline = (event: FormEvent<HTMLFormElement>): boolean => {
  if (typeof navigator === "undefined" || navigator.onLine) return false;
  event.preventDefault();
  return true;
};

/**
 * Rewrites the current history entry (same page, no navigation, the router's own state kept) to the question with the
 * answer being sent (./wizard answeredQuestionSearch). The question's form then moves on as usual.
 */
function rememberAnswerHere(data: FormData, question: string) {
  if (typeof window === "undefined") return;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${answeredQuestionSearch(data, question)}`);
  } catch {
    // a browser that refuses (sandboxed frames): Back shows the question without the answer, as before
  }
}

// ───────────────────────────────────────────────────────────────── 1. device

/**
 * The start page, in the before's order (client note 10): the title and its line (+ the way to the track card), the
 * labelled rail, «أي جهاز تريد استبداله؟» with the device search and the tiles; then the v2.1 sections below the tiles.
 */
function DeviceStep({ view, rail, validDays }: { view: ViewOf<"device">; rail: ReactNode; validDays: number | null }) {
  const t = useUsedT();
  const ui = useT("ui");
  const localePath = useLocalePath();
  const f = useFormat();
  const [query, setQuery] = useState(view.query);
  const groups = filterGroups(view.groups, query);
  const found = groups.reduce((sum, group) => sum + group.devices.length, 0);
  // «امسح البحث» lives in the no-match state, which clearing removes: focus goes back to the field (it fell to the
  // page's body — review 2026-11-13)
  const searchInput = useRef<HTMLInputElement>(null);
  const clearSearch = () => {
    setQuery("");
    searchInput.current?.focus();
  };
  const title = (
    <h1 id="ti-title" {...STEP_HEADING} className="type-h1 text-ink outline-none">
      {t("tradein.title")}
    </h1>
  );

  if (view.groups.length === 0) {
    return (
      <section aria-labelledby="ti-title" className="grid gap-2">
        {title}
        <EmptyState
          layout="stack"
          headingLevel={2}
          title={t("tradein.device.none")}
          text={t("tradein.device.noneText")}
          action={
            <Key as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </Key>
          }
        />
      </section>
    );
  }
  return (
    <div className="used-start">
      <header className="grid gap-2">
        {title}
        <p className="used-lead max-w-[62ch] text-ink-2">{t("tradein.intro")}</p>
        <p className="type-sm text-ink-2">
          {t("tradein.start.trackAsk")}{" "}
          <TextLink as="a" href={`#${TRACK_ID}`} inline>
            {t("tradein.start.trackLink")}
          </TextLink>
        </p>
      </header>
      {rail}
      {view.unknown ? (
        <div className="callout callout--warn" role="alert">
          <Icon name="warning" size={20} />
          <span className="callout__text text-ink">{t("tradein.device.unknown")}</span>
        </div>
      ) : null}
      <section aria-labelledby="ti-device" className="grid gap-5">
        <div className="grid gap-1">
          <h2 id="ti-device" className="type-h2 text-ink">
            {t("tradein.device.title")}
          </h2>
          <p className="used-read text-ink-2">{t("tradein.device.text")}</p>
          {/* the tiles' «حتى …» are estimates: said once, here (round-1 fixes) */}
          {view.groups.some((group) => group.devices.some((device) => device.upToIqd !== null)) ? <p className="used-read text-ink-2">{t("tradein.device.upToNote")}</p> : null}
        </div>
        <Form method="get" action={localePath(TRADE_IN_PATH)} role="search" onSubmit={(event) => event.preventDefault()}>
          <TextField
            ref={searchInput}
            label={t("tradein.device.search")}
            hideLabel
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("tradein.device.searchHint")}
            autoComplete="off"
            enterKeyHint="search"
            end={<Icon name="magnifying-glass" size={20} />}
          />
        </Form>
        <p className="sr-only" role="status">
          {query.trim() ? t("tradein.device.found", { count: found, n: f.number(found) }) : ""}
        </p>
        {groups.length === 0 ? (
          <EmptyState
            icon="magnifying-glass"
            title={t("tradein.device.noMatch", { query })}
            text={t("tradein.device.noMatchText")}
            action={
              // a link to the unfiltered page, so it also clears a search sent without script (`?q=`); with script it
              // clears in place and gives the field back its focus
              <Key
                as={LocaleLink}
                to={TRADE_IN_PATH}
                size="sm"
                onClick={(event: MouseEvent) => {
                  event.preventDefault();
                  clearSearch();
                }}
              >
                {t("tradein.device.clearSearch")}
              </Key>
            }
          />
        ) : (
          groups.map((group) => (
            <section key={group.platformSlug} aria-labelledby={`ti-platform-${group.platformSlug}`} className="grid gap-3">
              {/* the before's colour line beside the platform's name */}
              <h3 id={`ti-platform-${group.platformSlug}`} className="used-group">
                {isPlatform(group.platformSlug) ? <PlatformLabel platform={group.platformSlug} label={ui(`platform.${group.platformSlug}`)} bar /> : group.platformName}
              </h3>
              <ul className="used-devices">
                {group.devices.map((device) => (
                  <li key={device.slug} className="min-w-0">
                    <DeviceTile device={device} current={view.current === device.slug} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        <Note
          icon="question"
          title={t("tradein.device.missing")}
          action={
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("tradein.device.support")}
            </TextLink>
          }
        >
          {t("tradein.device.missingText")}
        </Note>
      </section>
      <HowItWorks />
      <PriceFactors />
      <TradeInFaq validDays={validDays} />
    </div>
  );
}

/** «كيف يعمل الاستبدال» — three steps as an icon strip: clay discs with red line icons, joined by a line (v2.1). */
function HowItWorks() {
  const t = useUsedT();
  const f = useFormat();
  const steps = [
    { icon: "tag", title: t("tradein.journey.estimate"), text: t("tradein.journey.estimateText") },
    { icon: "clipboard-text", title: t("tradein.journey.inspect"), text: t("tradein.journey.inspectText") },
    { icon: "hand-coins", title: t("tradein.journey.payout"), text: t("tradein.journey.payoutText") },
  ] as const;
  return (
    <section aria-labelledby="ti-how" className="grid gap-5">
      <h2 id="ti-how" className="type-h2 text-ink">
        {t("tradein.journey.label")}
      </h2>
      <ol className="used-how" {...revealProps({ stagger: true })}>
        {steps.map((step, index) => (
          <li key={step.icon} className="used-how__step">
            <span className="used-how__mark" aria-hidden="true">
              <span className="clay-disc used-disc used-disc--lg">
                <Icon name={step.icon} size={26} />
              </span>
              <span className="used-how__n">{f.number(index + 1)}</span>
            </span>
            <span className="used-how__title">{step.title}</span>
            <span className="used-how__text">{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * «ما الذي يغيّر السعر؟» — the rules the estimate really uses (tradein.server computeEstimate): whether it works, the
 * body and screen (the grade span), the accessories (a guide deduction each), the account lock (refused) — and the box,
 * which the estimate does not ask about. Words only: the guide's own figures never leave the server.
 */
function PriceFactors() {
  const t = useUsedT();
  return (
    <section aria-labelledby="ti-price" className="grid gap-4" {...revealProps()}>
      <div className="grid gap-1">
        <h2 id="ti-price" className="type-h2 text-ink">
          {t("tradein.start.price.title")}
        </h2>
        <p className="used-read max-w-[62ch] text-ink-2">{t("tradein.start.price.text")}</p>
      </div>
      <FactList
        className="used-factors"
        facts={[
          { id: "power", icon: "lightning", title: t("tradein.start.price.power"), text: t("tradein.start.price.powerText") },
          { id: "body", icon: "seal-check", title: t("tradein.start.price.body"), text: t("tradein.start.price.bodyText") },
          { id: "accessories", icon: "game-controller", title: t("tradein.start.price.accessories"), text: t("tradein.start.price.accessoriesText") },
          { id: "account", icon: "lock", title: t("tradein.start.price.account"), text: t("tradein.start.price.accountText") },
          { id: "box", icon: "package", title: t("tradein.start.price.box"), text: t("tradein.start.price.boxText") },
        ]}
      />
    </section>
  );
}

const FAQ = ["estimate", "inspection", "payout", "decline", "data", "photos", "broken"] as const;

/** The questions people ask before they start — answered with the wizard's own rules (one open at a time). */
function TradeInFaq({ validDays }: { validDays: number | null }) {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const days = typeof validDays === "number" && validDays > 0 ? shop("days", { count: validDays, n: f.number(validDays) }) : null;
  const items = FAQ.filter((key) => key !== "estimate" || days !== null).map((key) => ({
    id: key,
    summary: t(`tradein.start.faq.${key}.q`),
    content: <p className="used-read max-w-[62ch] text-ink-2">{t(`tradein.start.faq.${key}.a`, { days: days ?? "" })}</p>,
  }));
  return (
    <section aria-labelledby="ti-faq" className="grid gap-3" {...revealProps()}>
      <h2 id="ti-faq" className="type-h2 text-ink">
        {t("tradein.start.faq.title")}
      </h2>
      {/* the questions at 16px (used.css .used-faq), the answers at the reading size */}
      <Accordion exclusive items={items} className="used-faq" />
    </section>
  );
}

/**
 * A device the store buys, the before's picture tile (three to a row on phones from 375): its photo on the product
 * ground, the name (balanced, two lines), the qualifier that tells two models apart on a meta line of its own
 * («الطراز الأصلي 2020» — v2 §4.11), and «حتى 350,000 د.ع» on one line at the tile's foot: the amount one isolated run
 * that never splits (figure first in Arabic and Sorani), in its weight. That the amounts are estimates is said once,
 * in the section's line (round-1 fixes: «تقديرياً» on every tile made them ragged), and to screen readers on each tile.
 */
function DeviceTile({ device, current }: { device: TradeInDevice; current: boolean }) {
  const t = useUsedT();
  const f = useFormat();
  const name = splitQualifier(device.name);
  const amount = device.upToIqd !== null ? iqdText(f, device.upToIqd).replace(/ /g, NBSP) : null;
  return (
    <LocaleLink
      to={`${TRADE_IN_PATH}?step=condition&device=${encodeURIComponent(device.slug)}`}
      aria-current={current ? "true" : undefined}
      className="used-device group"
      data-press="soft"
    >
      <Niche as="span">{device.image ? <ProductImage image={device.image} alt="" sizes="(min-width: 768px) 160px, 30vw" /> : null}</Niche>
      <span className="used-device__name">
        <BidiText text={bindNameTokens(bindDashes(name.base))} />
      </span>
      {name.qualifier ? (
        <span className="used-device__meta">
          <BidiText text={name.qualifier} />
        </span>
      ) : null}
      <span className="used-device__up">
        {amount !== null ? (
          <>
            {fillNodes(t("tradein.device.upTo"), { price: <bdi className="used-device__iqd">{amount}</bdi> })}
            <VisuallyHidden> {t("tradein.device.estimated")}</VisuallyHidden>
          </>
        ) : (
          t("tradein.device.afterInspection")
        )}
      </span>
    </LocaleLink>
  );
}

// ───────────────────────────────────────────────────────────────── 2. condition (one question per screen)

function ConditionStep({ view }: { view: ViewOf<"condition"> }) {
  const t = useUsedT();
  const f = useFormat();
  const localePath = useLocalePath();
  const accessory = useAccessoryLabel();
  const question = view.question;
  // Sent without an answer (v2 §4.9): with script the form stays, says why and puts focus on the first option; without
  // script the server answers the same (`view.missing`). Choosing an option clears the message.
  const [checked, setChecked] = useState<{ question: string; missing: boolean } | null>(null);
  const missing = checked?.question === question ? checked.missing : view.missing;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (stayOffline(event)) return;
    const data = new FormData(event.currentTarget);
    if (question !== "included" && !data.get(question)) {
      event.preventDefault();
      setChecked({ question, missing: true });
      event.currentTarget.querySelector<HTMLInputElement>(`input[name="${question}"]`)?.focus();
      return;
    }
    // The answer travels in the NEXT step's URL only: before leaving, this history entry becomes "this question, with
    // this answer", so the browser's Back shows the choice made instead of an empty question.
    rememberAnswerHere(data, question);
  };
  // The legend is the screen's heading: «السؤال 1 من 5», the question (h1) and its one-line explanation.
  const legend = (
    <>
      <span className="block pb-1 type-xs text-ink-2">{t("tradein.question.counter", { n: f.number(view.index), total: f.number(view.total) })}</span>
      <h1 {...STEP_HEADING} className="type-h1 text-ink outline-none">
        {t(`tradein.q.${question}.title`)}
      </h1>
      <span className="used-read block pt-2 pb-2 text-ink-2">{t(`tradein.q.${question}.hint`)}</span>
    </>
  );
  return (
    <section className="grid gap-6">
      <DeviceSummary name={view.device.name} image={view.device.image} action={{ href: `${TRADE_IN_PATH}?device=${encodeURIComponent(view.device.slug)}`, label: t("tradein.changeDevice") }} className="2xl:hidden" />
      <Form method="get" action={localePath(TRADE_IN_PATH)} id={FORM_ID} className="grid gap-5" key={question} onSubmit={onSubmit} onChange={() => setChecked({ question, missing: false })}>
        {view.hidden.map(([name, value], index) => (
          <input key={`${name}:${value}:${index}`} type="hidden" name={name} value={value} />
        ))}
        {question === "included" ? (
          <FieldGroup legend={legend}>
            <input type="hidden" name="inc" value="1" />
            {view.options.map((key) => (
              // a card like the other questions' option cards (the plain rows looked like a different form — review
              // 2026-11-13; the kit's checkbox has no option-row form, see docs/areas/used.md "Requests")
              <Checkbox key={key} className="surface used-check" name="included" value={key} label={accessory(key)} defaultChecked={view.answers.included?.includes(key) ?? false} />
            ))}
          </FieldGroup>
        ) : (
          <FieldGroup legend={legend} error={missing ? t("tradein.question.required") : undefined}>
            {view.options.map((option) => (
              <OptionCard
                key={option}
                // the soft raised card (v2.1; until the kit's option card is clay itself — docs/areas/used.md "Requests")
                className="surface"
                name={question}
                value={option}
                label={t(`tradein.q.${question}.options.${option}.label`)}
                hint={t(`tradein.q.${question}.options.${option}.hint`)}
                defaultChecked={(view.answers as Record<string, unknown>)[question] === option}
              />
            ))}
          </FieldGroup>
        )}
        {/* Without script the form still needs its own key (the task bar's key points here with form="ti-form"). */}
        <Key type="submit" className="used-nojs justify-self-start">
          {t("tradein.continue")}
        </Key>
      </Form>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 3. photos

function PhotosStep({ view }: { view: ViewOf<"photos"> }) {
  const t = useUsedT();
  return (
    <section aria-labelledby="ti-photos" className="grid gap-6">
      <DeviceSummary name={view.device.name} image={view.device.image} className="2xl:hidden" />
      <header className="grid gap-2">
        <h1 id="ti-photos" {...STEP_HEADING} className="type-h1 text-ink outline-none">
          {t("tradein.photos.title")} <span className="type-body text-ink-2">{t("tradein.photos.optional")}</span>
        </h1>
        <p className="type-body text-ink-2">{t("tradein.photos.text")}</p>
        <p className="used-read flex items-start gap-1.5 text-ink-2">
          <Icon name="lock" size={16} className="mt-1.5 shrink-0" />
          {t("tradein.photos.private")}
        </p>
      </header>
      <TradeInPhotos initial={view.photos} limit={view.limit} maxBytes={view.maxBytes} />
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 4. estimate

function EstimateStep({ view }: { view: ViewOf<"estimate"> }) {
  const t = useUsedT();
  const estimate = view.estimate;
  return (
    <section aria-labelledby="ti-estimate" className="grid gap-6">
      <DeviceSummary name={view.device.name} image={view.device.image} className="2xl:hidden" />
      <h1 id="ti-estimate" {...STEP_HEADING} className="type-h1 text-ink outline-none">
        {t("tradein.estimate.title")}
      </h1>
      {estimate.kind === "refused" ? (
        <div className="callout callout--warn" role="alert">
          <Icon name="warning" size={20} />
          <span className="grid gap-1">
            <span className="callout__title">{t("tradein.estimate.refused.title")}</span>
            <span className="callout__text">{t("tradein.estimate.refused.text")}</span>
            {view.edit.account ? (
              <TextLink as={LocaleLink} to={view.edit.account} className="justify-self-start">
                {t("tradein.estimate.refused.change")}
              </TextLink>
            ) : null}
          </span>
        </div>
      ) : estimate.kind === "range" ? (
        <EstimatePanel
          range={{ minIqd: estimate.minIqd, maxIqd: estimate.maxIqd, expiresAt: estimate.expiresAt }}
          low={estimate.low}
          high={estimate.high}
          missing={estimate.missing}
          deductionsIqd={estimate.deductionsIqd}
          payout
          headingLevel={2}
        />
      ) : (
        <EstimatePanel range={null} reason={estimate.reason} payout headingLevel={2} />
      )}
      <section aria-labelledby="ti-summary" className="panel grid gap-2 p-5 2xl:hidden">
        <h2 id="ti-summary" className="used-title text-ink">
          {t("tradein.estimate.summary")}
        </h2>
        <AnswerList questions={view.questions} answers={view.answers} edit={view.edit} />
      </section>
      {estimate.kind === "refused" ? null : <WhatNext className="panel p-5 2xl:hidden" />}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 5. inspection: contact and a preferred time

type ActionFailure = { ok: false; code: string; message?: string; fields?: Record<string, string>; values?: Record<string, string | boolean> };

const FIELD_IDS: Record<string, string> = { phone: "ti-phone", ownershipConfirmed: "ti-ownership", contactName: "ti-name", notes: "ti-notes", preferredWindow: "ti-window" };

function InspectionStep({ view }: { view: ViewOf<"inspection"> }) {
  const t = useUsedT();
  const f = useFormat();
  const errorText = useErrorText();
  const root = useRouteLoaderData("root") as { storeMode?: string } | undefined;
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const address = layout?.shell?.contact?.address ?? null;
  const actionData = useActionFailure();
  const values = actionData?.values ?? {};
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string[] | null>(null);
  const shown = { ...(actionData?.fields ?? {}), ...errors };
  const estimate = view.estimate;

  const checkPhone = (value: string): string | null => (value.trim() === "" ? errorText("required") : normalizeIraqPhone(value) ? null : errorText("phone_invalid"));
  const setField = (name: string, message: string | null) =>
    setErrors((current) => {
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Offline the request cannot leave: the form stays as it is (Enter in a field included), the keys say why.
    if (stayOffline(event)) return;
    const form = new FormData(event.currentTarget);
    const phone = checkPhone(String(form.get("phone") ?? ""));
    const ownership = form.get("ownership") === "1" ? null : errorText("ownership_required");
    setField("phone", phone);
    setField("ownershipConfirmed", ownership);
    const invalid = [phone ? "phone" : null, ownership ? "ownershipConfirmed" : null].filter((name): name is string => name !== null);
    setSummary(invalid.length > 0 ? invalid : null);
    if (invalid.length > 0) {
      event.preventDefault();
      document.getElementById(FIELD_IDS[invalid[0]])?.focus();
    }
  };

  // Field errors show under their fields (and in the summary); anything else (a rate limit, a device no longer bought…)
  // is one sentence above the keys.
  const inline = new Set(Object.keys(FIELD_IDS));
  const serverFields = actionData?.fields ? Object.keys(actionData.fields).filter((name) => inline.has(name)) : [];
  const formError = actionData && (!actionData.fields || Object.keys(actionData.fields).some((key) => !inline.has(key))) ? (actionData.message ?? errorText(actionData.code)) : null;
  const invalidNames = summary ?? serverFields;
  const fieldLabel: Record<string, string> = { phone: t("tradein.contact.phone"), ownershipConfirmed: t("tradein.contact.ownershipShort"), contactName: t("tradein.contact.name"), notes: t("tradein.contact.notes"), preferredWindow: t("tradein.contact.window") };
  const summaryErrors: FormError[] = invalidNames.filter((name) => shown[name]).map((name) => ({ id: FIELD_IDS[name], label: fieldLabel[name] }));
  // The server found a field to fix (v2 §4.9): focus moves to the first one, as it does for the browser's own checks.
  const firstServerField = serverFields[0] ?? null;
  useEffect(() => {
    if (firstServerField) document.getElementById(FIELD_IDS[firstServerField])?.focus();
  }, [actionData, firstServerField]);

  return (
    <section aria-labelledby="ti-contact" className="grid gap-6">
      <div className="panel p-4 2xl:hidden">
        <DeviceSummary name={view.device.name} image={view.device.image}>
          <p className="type-sm text-ink-2">
            {estimate.kind === "range" ? <bdi className="nums">{t("tradein.estimate.range", { min: iqdText(f, estimate.minIqd), max: iqdText(f, estimate.maxIqd) })}</bdi> : t("tradein.contact.noEstimate")}
            {" · "}
            {t("tradein.contact.photosAttached", { count: view.photoCount, n: f.number(view.photoCount) })}
          </p>
        </DeviceSummary>
      </div>

      <header className="grid gap-2">
        <h1 id="ti-contact" {...STEP_HEADING} className="type-h1 text-ink outline-none">
          {t("tradein.contact.title")}
        </h1>
        <p className="type-body text-ink-2">{t("tradein.contact.text")}</p>
        {address ? (
          <p className="used-read flex items-start gap-1.5 text-ink">
            <Icon name="map-pin" size={16} className="mt-1.5 shrink-0" />
            <span>
              <b className="font-semibold">{t("tradein.contact.where")}</b> {address}
            </span>
          </p>
        ) : null}
      </header>

      <FormErrorSummary errors={summaryErrors} />

      <Form method="post" noValidate onSubmit={onSubmit} id={FORM_ID} className="grid gap-5">
        {view.hidden.map(([name, value], index) => (
          <input key={`${name}:${value}:${index}`} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="idempotencyKey" value={view.idempotencyKey} />

        <TextField
          id={FIELD_IDS.phone}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          label={t("tradein.contact.phone")}
          required
          hint={t("tradein.contact.phoneHint")}
          defaultValue={String(values.phone ?? "")}
          error={shown.phone}
          onBlur={(event) => setField("phone", checkPhone(event.currentTarget.value))}
          onInput={(event) => (errors.phone ? setField("phone", checkPhone(event.currentTarget.value)) : undefined)}
        />
        <TextField id={FIELD_IDS.contactName} name="contactName" label={t("tradein.contact.name")} optional autoComplete="name" maxLength={100} defaultValue={String(values.contactName ?? "")} error={shown.contactName} />

        <PreferencePicker
          name="preferredWindow"
          legend={
            <>
              {t("tradein.contact.window")} <span className="field__mark">{t("tradein.photos.optional")}</span>
            </>
          }
          defaultValue={isPeriod(values.preferredWindow) ? values.preferredWindow : "any"}
        />

        <TextArea id={FIELD_IDS.notes} name="notes" label={t("tradein.contact.notes")} optional hint={t("tradein.contact.notesHint")} maxLength={500} defaultValue={String(values.notes ?? "")} error={shown.notes} />

        <Checkbox
          id={FIELD_IDS.ownershipConfirmed}
          name="ownership"
          value="1"
          label={t("tradein.contact.ownership")}
          hint={t("tradein.contact.ownershipHint")}
          defaultChecked={values.ownership === true}
          error={shown.ownershipConfirmed}
          onChange={(event) => (event.currentTarget.checked ? setField("ownershipConfirmed", null) : undefined)}
        />

        {root?.storeMode !== "live" ? <DemoNote variant="line">{t("tradein.contact.demo")}</DemoNote> : null}

        {formError ? (
          <div className="callout callout--danger" role="alert">
            <Icon name="warning-circle" size={20} />
            <span className="callout__text text-ink">
              {t("tradein.contact.failed")} {formError}
            </span>
          </div>
        ) : null}
        <Key type="submit" className="used-nojs justify-self-start">
          {t("tradein.contact.submit")}
        </Key>
      </Form>
    </section>
  );
}

const isPeriod = (value: unknown): value is Period => value === "any" || value === "morning" || value === "afternoon" || value === "evening";

/** The action's failure (field errors already translated on the server), when the last submission failed. */
function useActionFailure(): ActionFailure | null {
  const data = useActionData() as { ok?: boolean } | undefined;
  return data && data.ok === false ? (data as ActionFailure) : null;
}

// ───────────────────────────────────────────────────────────────── the aside (from 1280)

/** Beside the column from 1280: the device, the answers so far, the estimate, what happens next, a person to ask. */
function WizardAside({ view }: { view: Exclude<WizardView, { step: "device" }> }) {
  const t = useUsedT();
  const f = useFormat();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const channels = layout?.shell?.contact?.channels ?? null;
  const estimate: TradeInEstimate | null = view.step === "estimate" || view.step === "inspection" ? view.estimate : null;
  let figure: ReactNode = null;
  if (estimate?.kind === "range") {
    figure = (
      <p className="flex flex-wrap items-center justify-between gap-2">
        <bdi className="nums type-sm-strong text-ink">{t("tradein.estimate.range", { min: iqdText(f, estimate.minIqd), max: iqdText(f, estimate.maxIqd) })}</bdi>
        <Status tone="warn">{t("tradein.estimate.pending")}</Status>
      </p>
    );
  } else if (estimate?.kind === "inspection") {
    figure = <p className="type-sm text-ink">{t("tradein.contact.noEstimate")}</p>;
  }
  return (
    <aside className="used-wizard__aside" aria-label={t("tradein.aside.label")}>
      <div className="panel grid gap-4 p-5">
        <DeviceSummary size="lg" name={view.device.name} image={view.device.image} action={{ href: `${TRADE_IN_PATH}?device=${encodeURIComponent(view.device.slug)}`, label: t("tradein.changeDevice") }} />
        <div className="grid gap-1 border-t border-line pt-3">
          <h2 className="type-sm-strong text-ink">{t("tradein.estimate.summary")}</h2>
          <AnswerList questions={view.questions} answers={view.answers} edit={view.edit} />
        </div>
        {figure ? (
          <div className="grid gap-1 border-t border-line pt-3">
            <h2 className="type-sm-strong text-ink">{t("tradein.estimate.label")}</h2>
            {figure}
          </div>
        ) : null}
      </div>
      <WhatNext className="panel p-5" />
      {channels ? (
        <ContactCard channels={channels} />
      ) : (
        <p className="type-sm text-ink-2">
          {t("tradein.aside.question")}{" "}
          <TextLink as={LocaleLink} to={HANDOFF} inline>
            {t("tradein.device.support")}
          </TextLink>
        </p>
      )}
    </aside>
  );
}
