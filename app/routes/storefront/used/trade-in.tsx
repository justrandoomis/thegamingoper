/**
 * /trade-in — the trade-in wizard (brief §5, DESIGN.md §9.21): الجهاز → الحالة → الصور → التقدير → الفحص.
 *
 * Every step is a URL (./trade-in.server.ts): Back, reload and a shared link work, the question forms are GET forms
 * that submit without script, and steps push sideways in reading order (handle below). One question per screen,
 * answers as option rows with a line of explanation. Photos are private uploads (POST /api/upload/tradein). The
 * estimate is a RANGE from the model's price guide, labelled as an estimate with its expiry — or, honestly, "priced
 * after the inspection"; a locked device is refused. The last step POSTs the contact details and a preferred time
 * (a preference, never an appointment) and creates the request (~/server/services/tradein.server createTradeIn:
 * rate-limited, idempotent), then goes to /trade-in/<ref>?t=<token>.
 *
 * There is no commit (red) key here: nothing is bought or sold until an employee issues a final offer (§9.21).
 * States: each step · an unknown device · a question sent without an answer · a refused device · photo failures
 * (per photo) · field errors (client and server) · rate limits and other failures (a sentence above the key) ·
 * sending (the key spins) · demo mode (the request is recorded as a demo).
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { data, Form, redirect, useActionData, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/trade-in";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { LOCALES, localePath } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import type { MotionHandle } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { clearCookie, getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { createTradeIn, getTradeInDevice, readTradeInAnswers, TRADE_IN_DRAFT_COOKIE, type TradeInQuestion } from "~/server/services/tradein.server";
import { Icon } from "~/art/Icon";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, Radio, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { TextLink } from "~/ui/TextLink";
import { AnswerList, DeviceSummary, EstimatePanel, RADIO_GROUP_FIX, useAccessoryLabel } from "./components/TradeInParts";
import { TradeInPhotos } from "./components/TradeInPhotos";
import { combinedErrorT, useErrorText, useUsedT } from "./i18n";
import { loadWizard, type WizardView } from "./trade-in.server";

/** The wizard's path (locale-less) — kept here: component code must not import from ./trade-in.server. */
const TRADE_IN_PATH = "/trade-in";
const STEPS = ["device", "condition", "photos", "estimate", "inspection"] as const;
const QUESTIONS = ["power", "body", "screen", "included", "account"] as const;

/** Steps (and the questions inside "condition") push sideways in order (docs/MOTION.md, sibling order from the URL). */
function wizardOrder(search: string): number {
  const params = new URLSearchParams(search);
  const step = params.get("step");
  const index = Math.max(0, STEPS.indexOf((step ?? "device") as (typeof STEPS)[number]));
  if (step !== "condition") return index * 10;
  const q = params.get("q");
  const at = params.get("at");
  const position = q ? QUESTIONS.indexOf(q as (typeof QUESTIONS)[number]) : at ? QUESTIONS.indexOf(at as (typeof QUESTIONS)[number]) + 1 : 0;
  return index * 10 + Math.max(0, position);
}

// Its own sibling group: other areas' ordered routes (hub tabs, checkout steps) never push against the wizard's steps.
export const handle = { nav: "push", group: "trade-in", order: ({ search }) => wizardOrder(search) } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const wizard = await loadWizard(getDb(), ctx.locale, new URL(request.url), ctx.cookie(TRADE_IN_DRAFT_COOKIE), ctx.now);
  const t = serverT(ctx.locale, "used");
  return { ...wizard, meta: { title: t("tradein.title"), description: t("tradein.metaDescription") }, i18n: messagesFor(ctx.locale, "used", "errors") };
}

export const meta: Route.MetaFunction = (args) =>
  // Steps after the first carry the shopper's answers in the query: only the first step is a page for search engines.
  shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: args.location.search !== "" });

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const deviceSlug = text("device");
  const device = await getTradeInDevice(db, ctx.locale, deviceSlug);
  const answers = device ? readTradeInAnswers(form, device) : {};
  const values = { contactName: text("contactName"), phone: text("phone"), preferredDay: text("preferredDay"), preferredWindow: text("preferredWindow"), notes: text("notes"), ownership: text("ownership") === "1" };
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
        preferredDay: values.preferredDay,
        preferredWindow: values.preferredWindow,
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
    return data({ ...failure, values }, { status: failure.status });
  }
}

export default function TradeIn({ loaderData }: Route.ComponentProps) {
  const t = useUsedT();
  const { view, stepIndex, rail } = loaderData;
  const steps = STEPS.map((step, index) => ({ label: t(`tradein.steps.${step}`), href: rail[index] ?? undefined }));
  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-12 lg:pt-8">
      <header className="grid gap-2">
        <h1 className="type-title text-ink">{t("tradein.title")}</h1>
        <p className="max-w-[62ch] type-body text-ink-2">{t("tradein.intro")}</p>
      </header>
      <ProgressSteps steps={steps} current={stepIndex} aria-label={t("tradein.steps.label")} className="max-w-[40rem]" />
      <div className="min-w-0 max-w-[44rem]">
        <Step view={view} />
      </div>
    </div>
  );
}

function Step({ view }: { view: WizardView }) {
  switch (view.step) {
    case "device":
      return <DeviceStep view={view} />;
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

function Keys({ back, children }: { back: string | null; children: ReactNode }) {
  const t = useUsedT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
      {back ? (
        <Key as={LocaleLink} to={back} variant="quiet" icon="arrow-left">
          {t("tradein.back")}
        </Key>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── 1. device

function DeviceStep({ view }: { view: ViewOf<"device"> }) {
  const t = useUsedT();
  const ui = useT("ui");
  if (view.groups.length === 0) {
    return <EmptyState layout="stack" headingLevel={2} title={t("tradein.device.none")} action={<Key as={LocaleLink} to="/support">{t("tradein.device.support")}</Key>} />;
  }
  return (
    <section aria-labelledby="ti-device" className="grid gap-6">
      <div className="grid gap-1">
        <h2 id="ti-device" className="type-section text-ink">
          {t("tradein.device.title")}
        </h2>
        <p className="type-body text-ink-2">{t("tradein.device.text")}</p>
      </div>
      {view.unknown ? (
        <p className="flex items-start gap-2 rounded-md bg-niche p-3 type-label font-medium text-warn" role="alert">
          <Icon name="warning" size={18} className="mt-0.5 shrink-0" />
          {t("tradein.device.unknown")}
        </p>
      ) : null}
      {view.groups.map((group) => (
        <section key={group.platformSlug} aria-labelledby={`ti-platform-${group.platformSlug}`} className="grid gap-3">
          <h3 id={`ti-platform-${group.platformSlug}`} className="type-label font-semibold text-ink">
            {isPlatform(group.platformSlug) ? <PlatformLabel platform={group.platformSlug} label={ui(`platform.${group.platformSlug}`)} /> : group.platformName}
          </h3>
          <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4">
            {group.devices.map((device) => {
              const current = view.current === device.slug;
              return (
                <li key={device.slug} className="min-w-0">
                  <LocaleLink
                    to={`${TRADE_IN_PATH}?step=condition&device=${encodeURIComponent(device.slug)}`}
                    aria-current={current ? "true" : undefined}
                    aria-label={t("tradein.device.choose", { name: device.name })}
                    className="group grid gap-2 rounded-lg"
                    data-press="soft"
                  >
                    <Niche as="span" ratio="1/1" tagZone={false} className={cx(current && "outline-[2.5px] outline-offset-2 outline-ink outline-solid")}>
                      {device.image ? <ProductImage image={device.image} alt="" sizes="(min-width: 768px) 160px, 30vw" pose={0} /> : null}
                    </Niche>
                    <span className="line-clamp-2 min-h-[2lh] type-strong text-ink group-hover:underline">
                      <BidiText text={device.name} />
                    </span>
                  </LocaleLink>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="type-caption text-ink-2">
        <b className="font-semibold text-ink">{t("tradein.device.missing")}</b> {t("tradein.device.missingText")}{" "}
        <TextLink as={LocaleLink} to="/support" inline>
          {t("tradein.device.support")}
        </TextLink>
      </p>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 2. condition (one question per screen)

function ConditionStep({ view }: { view: ViewOf<"condition"> }) {
  const t = useUsedT();
  const f = useFormat();
  const localePath = useLocalePath();
  const accessory = useAccessoryLabel();
  const question = view.question;
  const legend = (
    <span className="grid gap-1">
      <span className="type-caption font-normal text-ink-2">{t("tradein.question.counter", { n: f.number(view.index), total: f.number(view.total) })}</span>
      <span className="type-sub text-ink">{t(`tradein.q.${question}.title`)}</span>
      <span className="type-caption font-normal text-ink-2">{t(`tradein.q.${question}.hint`)}</span>
    </span>
  );
  return (
    <section aria-label={t("tradein.steps.condition")} className="grid gap-5">
      <DeviceSummary name={view.device.name} image={view.device.image} action={{ href: `${TRADE_IN_PATH}?device=${encodeURIComponent(view.device.slug)}`, label: t("tradein.changeDevice") }} />
      <Form method="get" action={localePath(TRADE_IN_PATH)} className="grid gap-5" key={question}>
        {view.hidden.map(([name, value], index) => (
          <input key={`${name}:${value}:${index}`} type="hidden" name={name} value={value} />
        ))}
        {question === "included" ? (
          <FieldGroup legend={legend}>
            <input type="hidden" name="inc" value="1" />
            {view.options.map((key) => (
              <Checkbox key={key} name="included" value={key} label={accessory(key)} defaultChecked={view.answers.included?.includes(key) ?? false} />
            ))}
          </FieldGroup>
        ) : (
          <FieldGroup legend={legend} error={view.missing ? t("tradein.question.required") : undefined} className={RADIO_GROUP_FIX}>
            {view.options.map((option) => (
              <Radio
                key={option}
                row
                name={question}
                value={option}
                label={t(`tradein.q.${question}.options.${option}.label`)}
                hint={t(`tradein.q.${question}.options.${option}.hint`)}
                defaultChecked={(view.answers as Record<string, unknown>)[question] === option}
              />
            ))}
          </FieldGroup>
        )}
        <Keys back={view.back}>
          <Key type="submit" variant="ink" iconEnd="arrow-right">
            {t("tradein.continue")}
          </Key>
        </Keys>
      </Form>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 3. photos

function PhotosStep({ view }: { view: ViewOf<"photos"> }) {
  const t = useUsedT();
  return (
    <section aria-labelledby="ti-photos" className="grid gap-5">
      <DeviceSummary name={view.device.name} image={view.device.image} />
      <div className="grid gap-1">
        <h2 id="ti-photos" className="type-section text-ink">
          {t("tradein.photos.title")} <span className="type-body font-normal text-ink-2">{t("tradein.photos.optional")}</span>
        </h2>
        <p className="type-body text-ink-2">{t("tradein.photos.text")}</p>
        <p className="flex items-center gap-1.5 type-caption text-ink-2">
          <Icon name="lock" size={16} className="shrink-0" />
          {t("tradein.photos.private")}
        </p>
      </div>
      <TradeInPhotos initial={view.photos} limit={view.limit} maxBytes={view.maxBytes} />
      <Keys back={view.back}>
        <Key as={LocaleLink} to={view.next} variant="ink" iconEnd="arrow-right">
          {t("tradein.photos.continue")}
        </Key>
      </Keys>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 4. estimate

function EstimateStep({ view }: { view: ViewOf<"estimate"> }) {
  const t = useUsedT();
  const estimate = view.estimate;
  return (
    <section aria-labelledby="ti-estimate" className="grid gap-5">
      <DeviceSummary name={view.device.name} image={view.device.image} />
      <h2 id="ti-estimate" className="type-section text-ink">
        {t("tradein.estimate.title")}
      </h2>
      {estimate.kind === "refused" ? (
        <div className="grid gap-2 rounded-lg bg-paper p-5" role="alert">
          <p className="flex items-start gap-2 type-sub text-ink">
            <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-warn" />
            {t("tradein.estimate.refused.title")}
          </p>
          <p className="type-body text-ink-2">{t("tradein.estimate.refused.text")}</p>
          {view.edit.account ? (
            <TextLink as={LocaleLink} to={view.edit.account} className="justify-self-start">
              {t("tradein.estimate.refused.change")}
            </TextLink>
          ) : null}
        </div>
      ) : estimate.kind === "range" ? (
        <EstimatePanel
          range={{ minIqd: estimate.minIqd, maxIqd: estimate.maxIqd, expiresAt: estimate.expiresAt }}
          low={estimate.low}
          high={estimate.high}
          missing={estimate.missing}
          deductionsIqd={estimate.deductionsIqd}
          headingLevel={3}
        />
      ) : (
        <EstimatePanel range={null} reason={estimate.reason} headingLevel={3} />
      )}
      <section aria-labelledby="ti-summary" className="grid gap-1 rounded-lg bg-paper px-5 py-3">
        <h3 id="ti-summary" className="pt-1 type-label font-semibold text-ink">
          {t("tradein.estimate.summary")}
        </h3>
        <AnswerList questions={view.questions as TradeInQuestion[]} answers={view.answers} edit={view.edit} />
      </section>
      <Keys back={view.back}>
        {view.next ? (
          <Key as={LocaleLink} to={view.next} variant="ink" iconEnd="arrow-right">
            {t("tradein.estimate.continue")}
          </Key>
        ) : null}
      </Keys>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── 5. inspection: contact and a preferred time

type ActionFailure = { ok: false; code: string; message?: string; fields?: Record<string, string>; values?: Record<string, string | boolean> };

function InspectionStep({ view }: { view: ViewOf<"inspection"> }) {
  const t = useUsedT();
  const f = useFormat();
  const errorText = useErrorText();
  const navigation = useNavigation();
  const root = useRouteLoaderData("root") as { storeMode?: string } | undefined;
  const actionData = useActionFailure();
  const sending = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const values = actionData?.values ?? {};
  const [errors, setErrors] = useState<Record<string, string>>({});
  const shown = { ...(actionData?.fields ?? {}), ...errors };
  const estimate = view.estimate;

  const dayFormat = new Intl.DateTimeFormat(`${LOCALES[f.locale].bcp47}-u-nu-${f.numbering}`, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const dayLabel = (day: string, index: number) => (index === 0 ? t("tradein.contact.today") : index === 1 ? t("tradein.contact.tomorrow") : dayFormat.format(Date.parse(`${day}T12:00:00Z`)));

  const checkPhone = (value: string): string | null => (value.trim() === "" ? errorText("required") : normalizeIraqPhone(value) ? null : errorText("phone_invalid"));
  const setField = (name: string, message: string | null) =>
    setErrors((current) => {
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const phone = checkPhone(String(new FormData(form).get("phone") ?? ""));
    const ownership = new FormData(form).get("ownership") === "1" ? null : errorText("ownership_required");
    setField("phone", phone);
    setField("ownershipConfirmed", ownership);
    if (phone || ownership) {
      event.preventDefault();
      (form.querySelector<HTMLElement>(phone ? "[name=phone]" : "[name=ownership]"))?.focus();
    }
  };

  // Field errors show under their fields; anything else (a rate limit, a device no longer bought…) above the key.
  const inline = new Set(["phone", "ownershipConfirmed", "preferredDay", "notes", "contactName"]);
  const formError = actionData && (!actionData.fields || Object.keys(actionData.fields).some((key) => !inline.has(key))) ? (actionData.message ?? errorText(actionData.code)) : null;

  return (
    <section aria-labelledby="ti-contact" className="grid gap-5">
      <div className="grid gap-3 rounded-lg bg-paper p-4">
        <p className="type-label font-semibold text-ink-2">{t("tradein.contact.summary")}</p>
        <DeviceSummary name={view.device.name} image={view.device.image}>
          <p className="type-caption text-ink-2">
            {estimate.kind === "range" ? (
              <bdi className="nums">{t("tradein.estimate.range", { min: iqdText(f, estimate.minIqd), max: iqdText(f, estimate.maxIqd) })}</bdi>
            ) : (
              t("tradein.contact.noEstimate")
            )}
            {" · "}
            {t("tradein.contact.photosAttached", { count: view.photoCount, n: f.number(view.photoCount) })}
          </p>
        </DeviceSummary>
      </div>

      <div className="grid gap-1">
        <h2 id="ti-contact" className="type-section text-ink">
          {t("tradein.contact.title")}
        </h2>
        <p className="type-body text-ink-2">{t("tradein.contact.text")}</p>
      </div>

      <Form method="post" noValidate onSubmit={onSubmit} className="grid gap-5">
        {view.hidden.map(([name, value], index) => (
          <input key={`${name}:${value}:${index}`} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="idempotencyKey" value={view.idempotencyKey} />

        <TextField name="contactName" label={t("tradein.contact.name")} optional autoComplete="name" maxLength={100} defaultValue={String(values.contactName ?? "")} error={shown.contactName} />
        <TextField
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

        <FieldGroup legend={t("tradein.contact.day")} optional layout="row" error={shown.preferredDay}>
          <Chip input="radio" name="preferredDay" value="" defaultChecked={!values.preferredDay}>
            {t("tradein.contact.anyDay")}
          </Chip>
          {view.days.map((day, index) => (
            <Chip key={day} input="radio" name="preferredDay" value={day} defaultChecked={values.preferredDay === day}>
              {dayLabel(day, index)}
            </Chip>
          ))}
        </FieldGroup>

        <FieldGroup legend={t("tradein.contact.window")} optional layout="row" hint={t("tradein.contact.preference")}>
          {(["any", "morning", "afternoon", "evening"] as const).map((window) => (
            <Chip key={window} input="radio" name="preferredWindow" value={window === "any" ? "" : window} defaultChecked={window === "any" ? !values.preferredWindow : values.preferredWindow === window}>
              {t(`tradein.contact.windows.${window}`)}
            </Chip>
          ))}
        </FieldGroup>

        <TextArea name="notes" label={t("tradein.contact.notes")} optional hint={t("tradein.contact.notesHint")} maxLength={500} defaultValue={String(values.notes ?? "")} error={shown.notes} />

        <Checkbox
          name="ownership"
          value="1"
          label={t("tradein.contact.ownership")}
          hint={t("tradein.contact.ownershipHint")}
          defaultChecked={values.ownership === true}
          error={shown.ownershipConfirmed}
          onChange={(event) => (event.currentTarget.checked ? setField("ownershipConfirmed", null) : undefined)}
        />

        <p className="flex items-start gap-2 type-caption text-ink-2">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
          {t("tradein.contact.privacy")}
        </p>
        {root?.storeMode !== "live" ? <DemoNote>{t("tradein.contact.demo")}</DemoNote> : null}

        {formError ? (
          <p className="flex items-start gap-2 rounded-md bg-niche p-3 type-label font-medium text-red-ink" role="alert">
            <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
            <span>
              {t("tradein.contact.failed")} {formError}
            </span>
          </p>
        ) : null}

        <Keys back={view.back}>
          <Key type="submit" variant="ink" loading={sending} iconEnd="paper-plane-tilt">
            {t("tradein.contact.submit")}
          </Key>
        </Keys>
      </Form>
    </section>
  );
}

/** The action's failure (field errors already translated on the server), when the last submission failed. */
function useActionFailure(): ActionFailure | null {
  const data = useActionData() as { ok?: boolean } | undefined;
  return data && data.ok === false ? (data as ActionFailure) : null;
}
