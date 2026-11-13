/**
 * /support/repair — the repair request (Design System v2 §6.13; services/support/repairs.server createRepairTicket). A
 * task flow (`chrome: "task"`) in three steps — الجهاز والمشكلة → الصور → التواصل والتسليم (`?step=device|photos|
 * contact`; Back moves between steps, the sideways push follows the order) — with the task bar «رجوع | تابع» below
 * 1024 and the same keys at the end of the form from 1024.
 *
 * Device (ours, or "not in the list" with its name), an optional PRIVATE serial, the problem in the shopper's words, up
 * to three private photos, a mobile number (required) and a name, how they would like to hand the device over and a
 * preferred time — the period alone (PreferencePicker rules: no day until the owner configures dispatch days), never a
 * booking and never a call promise. "What happens next" sits above the form (step 1 on phones, a sticky aside from
 * 1024) with the facts that are true today. Coming from the assistant (?from=assistant&<conversation>), the problem is
 * prefilled with the conversation's summary, which the shopper may edit.
 *
 * One form holds the three steps (the fields stay mounted, so nothing typed is lost between steps); «تابع» checks the
 * step's fields first. Without JavaScript every step shows and the key sends the form. On success the shopper lands on
 * the status page with the request's reference and access token; field errors come back with the values typed and take
 * the shopper to the step of the first one; a request that never reached the store keeps the form (clientAction).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { redirect, useLocation, useNavigate, useNavigation, useSubmit, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/repair";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { useLocalePath, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { runAssistant } from "~/server/services/support/assistant.server";
import { findDevice, getSupportDirectory } from "~/server/services/support/kb.server";
import { createRepairTicket } from "~/server/services/support/repairs.server";
import { DEVICE_OTHER, parseAssistantState } from "~/server/services/support/state";
import type { SupportPlatformGroup } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { cx } from "~/ui/cx";
import { FieldGroup, FormErrorSummary, OptionCard, Select, TextArea, TextField, type FormError } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { isPlatform } from "~/ui/PlatformLed";
import { PreferencePicker, type Period } from "~/ui/PreferencePicker";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { fieldMessage, formMessage, isFailure, keepFormOnFailure, phoneProblem, revalidateAfter, stepBack, withServerErrors } from "./client";
import { SupportNav } from "./components/parts";
import { PhotoPicker } from "./components/PhotoPicker";
import { failed, formFiles, formKey, photoStore, readSupportForm, supportWho, textFields } from "./support.server";
import "./support.css";

const STEPS = ["device", "photos", "contact"] as const;
type Step = (typeof STEPS)[number];
const stepOf = (value: string | null | undefined): Step => (STEPS as readonly string[]).includes(value ?? "") ? (value as Step) : "device";

/** The step each field lives on (a server-side field error takes the shopper there). */
const FIELD_STEP: Record<string, Step> = { device: "device", deviceText: "device", serial: "device", issue: "device", photos: "photos", phone: "contact", contactName: "contact", handover: "contact", preferredDay: "contact", preferredWindow: "contact" };

export const handle = {
  shell: { chrome: "task" },
  nav: "push",
  // between the assistant (1) and the status page (3); the steps push sideways in their order
  order: ({ search }) => 2 + STEPS.indexOf(stepOf(new URLSearchParams(search).get("step"))) / 10,
  group: "support",
} satisfies ShellHandle & MotionHandle;

const FIELDS = ["idempotencyKey", "device", "deviceText", "serial", "issue", "phone", "contactName", "handover", "preferredDay", "preferredWindow", "source"] as const;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [directory, person] = await Promise.all([getSupportDirectory(db, ctx.locale), supportWho(ctx, db)]);
  const asked = url.searchParams.get("device");
  const device = asked === DEVICE_OTHER ? DEVICE_OTHER : (findDevice(directory, asked)?.slug ?? "");
  const fromAssistant = url.searchParams.get("from") === "assistant";
  const summary = fromAssistant ? (await runAssistant(db, ctx.locale, parseAssistantState(url.searchParams))).summary : "";
  return { directory, device, summary, fromAssistant, contact: person.contact, formKey: formKey(), i18n: messagesFor(ctx.locale, "support", "errors") };
}

/**
 * Moving between the steps changes only `?step=`: nothing to reload (the form and its idempotency key stay). A send
 * that never reached the store reloads nothing either (client.ts revalidateAfter): the form stays with its sentence.
 */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return revalidateAfter({ actionResult, defaultShouldRevalidate });
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const without = (url: URL) => {
    const params = new URLSearchParams(url.search);
    params.delete("step");
    return params.toString();
  };
  return without(currentUrl) === without(nextUrl) ? false : defaultShouldRevalidate;
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await readSupportForm(request);
  if (!(form instanceof FormData)) return form;
  const values = textFields(form, FIELDS);
  try {
    const { who } = await supportWho(ctx, db);
    const repair = await createRepairTicket(db, who, values, ctx.now, { store: photoStore(), photos: formFiles(form, "photos") });
    const params = new URLSearchParams({ ref: repair.ref, t: repair.accessToken, new: "1" });
    if (repair.replayed) params.set("replayed", "1");
    return redirect(localePath(`/support/repair/status?${params.toString()}`, ctx.locale));
  } catch (error) {
    return failed(error, values);
  }
}

/** A request that never reached the store comes back as a value: the form and everything typed stay on the page. */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  return keepFormOnFailure(serverAction);
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { repair?: { title?: string; description?: string } } } | undefined;
  return shellMeta(args, { title: tree?.meta?.repair?.title, description: tree?.meta?.repair?.description, noindex: (args.location.search ?? "").length > 1 });
};

type Check = (value: string) => string | undefined;

export default function Repair({ loaderData, actionData }: Route.ComponentProps) {
  const { directory, contact, summary, fromAssistant } = loaderData;
  const t = useT("support");
  const errorsT = useT("errors");
  const ui = useT("ui");
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const localeHref = useLocalePath();
  const online = useOnline();
  const failure = isFailure(actionData) ? actionData : null;
  const values = failure?.values ?? {};
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const step = stepOf(new URLSearchParams(location.search).get("step"));
  const stepIndex = STEPS.indexOf(step);
  const [device, setDevice] = useState(values.device ?? loaderData.device);
  const [photos, setPhotos] = useState<File[]>([]);
  // The store refused one of the attached photos: the shopper changes them before moving on (a photo the picker kept
  // out is only a sentence — it is not attached, so nothing waits on it).
  const [photosRefused, setPhotosRefused] = useState(false);
  const [local, setLocal] = useState<Record<string, string | undefined>>({});
  const [summaryFor, setSummaryFor] = useState<Step | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const focusField = useRef<string | null>(null);
  const uid = useId();
  // A whole-form failure (the store unreachable, a limit): its sentence comes into view above the task bar.
  useEffect(() => {
    if (failure && !failure.fields) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
  const id = (name: string) => `${uid}-${name}`;
  const ids = { form: id("form"), status: id("status"), how: id("how") };

  /** The address of a step, with everything else of the address kept (device, the assistant's conversation). */
  const stepHref = (target: Step) => {
    const params = new URLSearchParams(location.search);
    if (target === "device") params.delete("step");
    else params.set("step", target);
    const query = params.toString();
    return `/support/repair${query ? `?${query}` : ""}`;
  };
  /** Every step change remembers the step it came from (history state), so «رجوع» can be the browser's own Back. */
  const go = (target: Step, replace = false) => navigate(localeHref(stepHref(target)), { replace, preventScrollReset: false, state: { from: step } });

  // A new step (not the page's first render): its heading takes focus, so screen readers announce where they are.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (focusField.current) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  // The server refused a field the browser could not check (a photo it cannot read, a device that left the
  // catalogue…): go to its step and focus it there. The store's sentences are kept in the page's own state: moving to
  // the step is a navigation, which clears the action's answer (QA 2026-11-12: the form arrived on the photo step
  // with no reason and no error summary).
  useEffect(() => {
    const fields = failure?.fields ? Object.keys(failure.fields) : [];
    const first = fields[0];
    if (!first) return;
    // the server's word wins over an earlier client check of the same field
    setLocal((prev) => withServerErrors(prev, failure?.fields, t, errorsT));
    if (failure?.fields?.photos) setPhotosRefused(true);
    setSummaryFor(FIELD_STEP[first] ?? "device");
    focusField.current = first;
    const target = FIELD_STEP[first] ?? "device";
    if (target !== step) go(target, true);
    else focusPending();
  }, [failure]);
  useEffect(() => {
    focusPending();
  }, [step]);
  function focusPending() {
    const name = focusField.current;
    if (!name) return;
    focusField.current = null;
    focusNamed(name);
  }
  /** A field by its name — or, for a group (option cards, the two photo inputs), the element with its id. */
  function focusNamed(name: string) {
    const element = formRef.current?.elements.namedItem(name);
    if (element instanceof HTMLElement) element.focus();
    else document.getElementById(id(name))?.focus();
  }

  const checks: Record<string, Check> = {
    device: (value) => (value ? undefined : t("fieldErrors.device.required")),
    deviceText: (value) => (device !== DEVICE_OTHER || value.trim().length >= 2 ? undefined : t("fieldErrors.deviceText.required")),
    serial: (value) => (!value.trim() || /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(value.replace(/\s+/g, "")) ? undefined : t("fieldErrors.serial.invalid")),
    issue: (value) => (!value.trim() ? t("fieldErrors.issue.required") : value.trim().length < 10 ? t("fieldErrors.issue.too_short") : value.trim().length > 2000 ? t("fieldErrors.issue.too_long") : undefined),
    phone: (value) => phoneProblem(value, t, errorsT),
  };
  const STEP_FIELDS: Record<Step, string[]> = { device: ["device", "deviceText", "serial", "issue"], photos: [], contact: ["phone"] };
  const LABELS: Record<string, string> = { device: t("repair.device"), deviceText: t("repair.deviceText"), serial: t("repair.serial"), issue: t("repair.issue"), photos: t("photos.label"), phone: t("repair.phone"), contactName: t("repair.name"), handover: t("repair.handover") };
  const serverField = (name: string) => fieldMessage(name, failure?.fields?.[name], t, errorsT);
  const error = (name: string) => (name in local ? local[name] : serverField(name));
  const validate = (name: string, value: string) => setLocal((prev) => ({ ...prev, [name]: checks[name]?.(value) }));
  const onBlur = (name: string) => (event: { currentTarget: { value: string } }) => validate(name, event.currentTarget.value);
  const onInput = (name: string) => (event: { currentTarget: { value: string } }) => {
    if (error(name)) validate(name, event.currentTarget.value);
  };
  const read = (name: string) => ((formRef.current?.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "");

  /** Checks the fields of the given steps; on a problem shows the summary, focuses the first bad field, returns false. */
  const checkSteps = (steps: readonly Step[]): boolean => {
    const next: Record<string, string | undefined> = { ...local };
    const names = steps.flatMap((s) => STEP_FIELDS[s]);
    for (const name of names) next[name] = checks[name](read(name));
    setLocal(next);
    const firstBad = names.find((name) => next[name]) ?? (steps.includes("photos") && photosRefused ? "photos" : undefined);
    if (!firstBad) {
      setSummaryFor(null);
      return true;
    }
    const target = FIELD_STEP[firstBad] ?? "device";
    setSummaryFor(target);
    if (target !== step) {
      focusField.current = firstBad;
      go(target);
    } else {
      // the photos are two inputs under one name (choose, camera): their fieldset takes focus
      focusNamed(firstBad);
    }
    return false;
  };

  const onNext = (event: MouseEvent<HTMLElement>) => {
    if (step === "contact") return; // the submit of the form itself
    event.preventDefault();
    if (!checkSteps([step])) return;
    // a photo the picker kept out was said; it is not attached, so its sentence does not follow the shopper back here
    if (step === "photos") setLocal((prev) => ({ ...prev, photos: undefined }));
    go(STEPS[stepIndex + 1]);
  };
  // «رجوع»: when this step was reached from the previous one, it is history Back — the browser's Back and Forward then
  // keep walking the steps in order (a pushed «رجوع» would make the browser's Back step forward again). Opened
  // directly on a later step (a link, a server error), it moves to the previous step.
  const onBack = () => {
    setSummaryFor(null);
    if (stepIndex === 0) return;
    const previous = STEPS[stepIndex - 1];
    if (stepBack(previous, location.state) === "history") navigate(-1);
    else go(previous);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checkSteps(STEPS)) return;
    const data = new FormData(event.currentTarget);
    data.delete("photos");
    for (const photo of photos) data.append("photos", photo);
    submit(data, { method: "post", encType: "multipart/form-data" });
  };

  const platformLabel = (group: SupportPlatformGroup) => (isPlatform(group.slug) ? ui(`platform.${group.slug}`) : group.name);
  const handoverValue = values.handover ?? "";
  const windowValue = (["any", "morning", "afternoon", "evening"] as const).find((p) => p === values.preferredWindow) ?? "any";
  // every field of the summary's step that has an error (the client's checks and the server's refusals alike)
  const summaryErrors: FormError[] = summaryFor ? Object.keys(LABELS).filter((name) => FIELD_STEP[name] === summaryFor && error(name)).map((name) => ({ id: id(name), label: LABELS[name] })) : [];
  const stepTitle = t(`repair.steps.${step}`);
  const railSteps = STEPS.map((s, index) => ({ label: t(`repair.steps.${s}`), href: index < stepIndex ? stepHref(s) : undefined }));

  const actions = <RepairActions step={step} busy={busy} online={online} formId={ids.form} statusId={ids.status} onNext={onNext} onBack={onBack} />;

  return (
    <div className="page sup">
      <SupportNav current="repair" />
      <div className="sup-flow">
        <div className="sup-flow__main">
          <header className="grid gap-2">
            <h1 className="type-h1 text-ink">{t("repair.title")}</h1>
            <p className="type-body text-ink-2">{t("repair.lede")}</p>
          </header>

          {step === "device" ? <HowItGoes headingId={ids.how} className="lg:hidden" /> : null}

          {fromAssistant && summary ? (
            <Note tone="info" icon="lifebuoy">
              {t("repair.fromAssistant")}
            </Note>
          ) : null}

          {/* the step rail: numbers and the current step's words below 768 (three long labels do not fit a phone; its done
              discs are not links there — 24px is too small a target, and «رجوع» goes back) */}
          <ProgressSteps aria-label={t("repair.steps.label")} current={stepIndex} steps={STEPS.map((s) => ({ label: t(`repair.steps.short.${s}`) }))} variant="compact" className="sup-js md:hidden" />
          <ProgressSteps aria-label={t("repair.steps.label")} current={stepIndex} steps={railSteps} className="sup-js max-md:hidden" />

          <form ref={formRef} id={ids.form} method="post" encType="multipart/form-data" noValidate onSubmit={onSubmit} className="sup-form">
            <input type="hidden" name="idempotencyKey" value={values.idempotencyKey || loaderData.formKey} />
            <input type="hidden" name="source" value={fromAssistant ? "assistant" : "storefront"} />
            <h2 ref={headingRef} tabIndex={-1} className="sup-js type-h2 text-ink">
              {stepTitle}
            </h2>
            <FormErrorSummary errors={summaryErrors} />

            <fieldset className="sup-step" data-current={step === "device" ? "" : undefined}>
              <legend className="type-h3 text-ink">{t("repair.steps.device")}</legend>
              <Select
                id={id("device")}
                label={t("repair.device")}
                name="device"
                required
                placeholder={t("repair.choose")}
                defaultValue={device || ""}
                error={error("device")}
                onChange={(event) => {
                  setDevice(event.currentTarget.value);
                  validate("device", event.currentTarget.value);
                }}
                onBlur={onBlur("device")}
              >
                {directory.map((group) => (
                  <optgroup key={group.id} label={platformLabel(group)}>
                    {group.devices.map((entry) => (
                      <option key={entry.id} value={entry.slug}>
                        {entry.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value={DEVICE_OTHER}>{t("assistant.deviceOther")}</option>
              </Select>
              {device === DEVICE_OTHER ? (
                <TextField id={id("deviceText")} label={t("repair.deviceText")} name="deviceText" required maxLength={120} hint={t("repair.deviceTextHint")} defaultValue={values.deviceText ?? ""} error={error("deviceText")} onBlur={onBlur("deviceText")} onInput={onInput("deviceText")} />
              ) : null}
              <TextArea
                id={id("issue")}
                label={t("repair.issue")}
                name="issue"
                required
                rows={fromAssistant && summary ? 8 : 5}
                maxLength={2000}
                hint={t("repair.issueHint")}
                defaultValue={values.issue ?? summary}
                error={error("issue")}
                onBlur={onBlur("issue")}
                onInput={onInput("issue")}
              />
              <TextField
                id={id("serial")}
                label={t("repair.serial")}
                name="serial"
                optional
                ltr
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={40}
                hint={t("repair.serialHint")}
                defaultValue={values.serial ?? ""}
                error={error("serial")}
                onBlur={onBlur("serial")}
                onInput={onInput("serial")}
              />
              {/* phones: the fact strip after the first step's fields (from 1024 it sits in the aside) */}
              <RepairFacts className="lg:hidden" />
            </fieldset>

            <fieldset className="sup-step" data-current={step === "photos" ? "" : undefined}>
              <legend className="type-h3 text-ink">{t("repair.steps.photos")}</legend>
              <p className="type-body text-ink-2">{t("repair.photosLede")}</p>
              <PhotoPicker
                id={id("photos")}
                name="photos"
                files={photos}
                onChange={(files, problem) => {
                  setPhotos(files);
                  // the photos changed: what the store refused is no longer what would be sent
                  setPhotosRefused(false);
                  setLocal((prev) => ({ ...prev, photos: problem ? fieldMessage("photos", problem, t, errorsT) : undefined }));
                }}
                label={t("photos.label")}
                hint={t("photos.hint")}
                error={error("photos")}
                disabled={busy}
              />
            </fieldset>

            <fieldset className="sup-step" data-current={step === "contact" ? "" : undefined}>
              <legend className="type-h3 text-ink">{t("repair.steps.contact")}</legend>
              <div className="grid gap-5 md:grid-cols-2">
                <TextField
                  id={id("phone")}
                  label={t("repair.phone")}
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  required
                  hint={t("repair.phoneHint")}
                  defaultValue={values.phone ?? contact?.phone ?? ""}
                  error={error("phone")}
                  onBlur={onBlur("phone")}
                  onInput={onInput("phone")}
                />
                <TextField id={id("contactName")} label={t("repair.name")} name="contactName" autoComplete="name" optional maxLength={80} defaultValue={values.contactName ?? contact?.name ?? ""} error={serverField("contactName")} />
              </div>
              {/* the fieldset carries the id the error summary links to (the kit's FieldGroup `id`) */}
              <FieldGroup id={id("handover")} legend={t("repair.handover")} optional error={serverField("handover")}>
                <OptionCard name="handover" value="drop_off" label={t("handover.drop_off")} defaultChecked={handoverValue === "drop_off"} />
                <OptionCard name="handover" value="pickup" label={t("handover.pickup")} hint={t("handover.pickupHint")} defaultChecked={handoverValue === "pickup"} />
                <OptionCard name="handover" value="" label={t("handover.none")} defaultChecked={handoverValue === ""} />
              </FieldGroup>
              <PreferencePicker id={id("preferredWindow")} name="preferredWindow" defaultValue={windowValue as Period} label={t("repair.window")} />
              <p className="type-xs text-ink-2">{t("repair.privacy")}</p>
            </fieldset>

            {failure && !failure.fields ? (
              <p ref={alertRef} role="alert" className="sup-alert">
                <Icon name="warning-circle" size={20} />
                <span>{formMessage(failure, t, errorsT)}</span>
              </p>
            ) : null}
            <p id={ids.status} role="status" className="type-xs text-ink-2 empty:hidden">
              {busy ? (photos.length > 0 ? t("repair.sendingPhotos", { count: photos.length }) : t("repair.sending")) : !online ? t("form.offline") : ""}
            </p>
            <div className="sup-actions">{actions}</div>
          </form>
        </div>

        <aside aria-labelledby={`${ids.how}-aside`} className="sup-flow__aside">
          <HowItGoes headingId={`${ids.how}-aside`} facts />
        </aside>

        <TaskBar aria-label={stepTitle} className="lg:hidden sup-bar">
          {actions}
        </TaskBar>
      </div>
    </div>
  );
}

/**
 * «رجوع» (from the second step) and the step's primary — «تابع», or «أرسل طلب الصيانة» on the last step (and always
 * without JavaScript, when every step shows and the key sends the form).
 */
function RepairActions({ step, busy, online, formId, statusId, onNext, onBack }: { step: Step; busy: boolean; online: boolean; formId: string; statusId: string; onNext: (event: MouseEvent<HTMLElement>) => void; onBack: () => void }) {
  const t = useT("support");
  const last = step === "contact";
  return (
    <div className="sup-actions__row">
      {step !== "device" ? (
        <Key onClick={onBack} icon="arrow-left" className="sup-js" disabled={busy}>
          {t("repair.back")}
        </Key>
      ) : null}
      <Key
        type="submit"
        form={formId}
        variant="primary"
        iconEnd={last ? undefined : "arrow-right"}
        icon={last ? "wrench" : undefined}
        loading={busy}
        disabled={last && !online}
        aria-describedby={statusId}
        onClick={onNext}
        className="sup-actions__go"
      >
        <span className="sup-js">{last ? t("repair.submit") : t("repair.next")}</span>
        <span className="sup-nojs">{t("repair.submit")}</span>
      </Key>
    </div>
  );
}

/** "What happens next" — four honest steps (no call promise); with `facts`, the fact strip under them (the aside). */
function HowItGoes({ headingId, facts = false, className }: { headingId: string; facts?: boolean; className?: string }) {
  const t = useT("support");
  return (
    <section aria-labelledby={headingId} className={cx("sup-card sup-how", className)}>
      <h2 id={headingId} className="type-h3 text-ink">
        {t("repair.how.title")}
      </h2>
      <ol className="sup-how__list">
        {(["send", "review", "check", "approve"] as const).map((key, index) => (
          <li key={key} className="sup-how__item">
            {/* the step's number on a clay disc (the before's raised circles) */}
            <span className="clay-disc sup-how__n nums" aria-hidden="true">
              {index + 1}
            </span>
            <span>{t(`repair.how.${key}`)}</span>
          </li>
        ))}
      </ol>
      {facts ? <RepairFacts /> : null}
    </section>
  );
}

/**
 * The facts that are true today («الدفع: بعد موافقتك على عرض السعر», the private photos and serial), written the
 * before's calm way: the kit's quiet note lines (an icon, a short bold title, the muted words). The owner has
 * configured no inspection fee and no repair warranty, so those facts are not shown.
 */
function RepairFacts({ className }: { className?: string }) {
  const t = useT("support");
  const facts = [
    { key: "pay", icon: "hand-coins" as const },
    { key: "private", icon: "lock" as const },
  ];
  return (
    <ul aria-label={t("repair.facts.label")} className={cx("sup-facts", className)}>
      {facts.map((fact) => (
        <li key={fact.key}>
          <Note variant="line" icon={fact.icon} title={t(`repair.facts.${fact.key}.title`)}>
            {t(`repair.facts.${fact.key}.text`)}
          </Note>
        </li>
      ))}
    </ul>
  );
}
