/**
 * /support/repair — the repair request form (brief §7; services/support/repairs.server createRepairTicket).
 *
 * Device (ours, or "not in the list" with its name), an optional PRIVATE serial, the problem in the shopper's words,
 * up to three private photos, a phone (required) and name, and how and when they would like to hand the device over —
 * stated as a preference, never a booking. Coming from the assistant (?from=assistant&<conversation>), the problem is
 * prefilled with the conversation's summary, which the shopper may edit.
 *
 * On success the shopper lands on the status page with the request's reference and access token. Field errors come
 * back with the values typed (so the form also works without JavaScript); a request that never reached the store keeps
 * the form as it is (clientAction).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { redirect, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/repair";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { LOCALES, localePath } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { runAssistant } from "~/server/services/support/assistant.server";
import { nextDays } from "~/server/services/support/common.server";
import { findDevice, getSupportDirectory } from "~/server/services/support/kb.server";
import { createRepairTicket } from "~/server/services/support/repairs.server";
import { DEVICE_OTHER, parseAssistantState } from "~/server/services/support/state";
import { PREFERRED_WINDOWS, type SupportPlatformGroup } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { Chip } from "~/ui/Chip";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { isPlatform } from "~/ui/PlatformLed";
import { fieldMessage, formMessage, isFailure, keepFormOnFailure, phoneProblem } from "./client";
import { SupportTabs } from "./components/parts";
import { PhotoPicker } from "./components/PhotoPicker";
import { failed, formFiles, formKey, photoStore, supportWho, textFields } from "./support.server";

export const handle = { nav: "push", order: 2, group: "support" } satisfies MotionHandle;

const FIELDS = ["idempotencyKey", "device", "deviceText", "serial", "issue", "phone", "contactName", "handover", "preferredDay", "preferredWindow", "source"] as const;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [directory, person] = await Promise.all([getSupportDirectory(db, ctx.locale), supportWho(ctx, db)]);
  const asked = url.searchParams.get("device");
  const device = asked === DEVICE_OTHER ? DEVICE_OTHER : (findDevice(directory, asked)?.slug ?? "");
  const fromAssistant = url.searchParams.get("from") === "assistant";
  const summary = fromAssistant ? (await runAssistant(db, ctx.locale, parseAssistantState(url.searchParams))).summary : "";
  // Day choices are worded on the server (Baghdad calendar, the shopper's language), so the client renders the same text.
  const t = serverT(ctx.locale, "support");
  const weekday = new Intl.DateTimeFormat(`${LOCALES[ctx.locale].bcp47}-u-nu-latn`, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const days = nextDays(ctx.now, 6).map((value, index) => ({ value, label: index === 0 ? t("days.today") : index === 1 ? t("days.tomorrow") : weekday.format(Date.parse(`${value}T12:00:00Z`)) }));
  return { directory, device, summary, fromAssistant, days, contact: person.contact, formKey: formKey(), i18n: messagesFor(ctx.locale, "support", "errors") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
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
  return shellMeta(args, { title: tree?.meta?.repair?.title, description: tree?.meta?.repair?.description });
};

type Check = (value: string) => string | undefined;

export default function Repair({ loaderData, actionData }: Route.ComponentProps) {
  const { directory, days, contact, summary, fromAssistant } = loaderData;
  const t = useT("support");
  const errorsT = useT("errors");
  const ui = useT("ui");
  const submit = useSubmit();
  const navigation = useNavigation();
  const online = useOnline();
  const failure = isFailure(actionData) ? actionData : null;
  const values = failure?.values ?? {};
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const [device, setDevice] = useState(values.device ?? loaderData.device);
  const [photos, setPhotos] = useState<File[]>([]);
  const [local, setLocal] = useState<Record<string, string | undefined>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const ids = { form: useId(), next: useId(), status: useId() };
  // The server refused a field the browser could not check (a device that left the catalogue…): go to it.
  useEffect(() => {
    const first = failure?.fields ? Object.keys(failure.fields)[0] : null;
    const element = first ? formRef.current?.elements.namedItem(first) : null;
    if (element instanceof HTMLElement) element.focus();
  }, [failure]);

  const checks: Record<string, Check> = {
    device: (value) => (value ? undefined : t("fieldErrors.device.required")),
    deviceText: (value) => (device !== DEVICE_OTHER || value.trim().length >= 2 ? undefined : t("fieldErrors.deviceText.required")),
    serial: (value) => (!value.trim() || /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(value.replace(/\s+/g, "")) ? undefined : t("fieldErrors.serial.invalid")),
    issue: (value) => (!value.trim() ? t("fieldErrors.issue.required") : value.trim().length < 10 ? t("fieldErrors.issue.too_short") : value.trim().length > 2000 ? t("fieldErrors.issue.too_long") : undefined),
    phone: (value) => phoneProblem(value, t, errorsT),
  };
  const serverField = (name: string) => fieldMessage(name, failure?.fields?.[name], t, errorsT);
  const error = (name: string) => (name in local ? local[name] : serverField(name));
  const validate = (name: string, value: string) => setLocal((prev) => ({ ...prev, [name]: checks[name]?.(value) }));
  const onBlur = (name: string) => (event: { currentTarget: { value: string } }) => validate(name, event.currentTarget.value);
  const onInput = (name: string) => (event: { currentTarget: { value: string } }) => {
    if (error(name)) validate(name, event.currentTarget.value);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const read = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "");
    const next: Record<string, string | undefined> = { ...local };
    for (const name of Object.keys(checks)) next[name] = checks[name](read(name));
    setLocal(next);
    const firstBad = Object.keys(checks).find((name) => next[name]);
    if (firstBad) {
      (form.elements.namedItem(firstBad) as HTMLElement | null)?.focus();
      return;
    }
    const data = new FormData(form);
    data.delete("photos");
    for (const photo of photos) data.append("photos", photo);
    submit(data, { method: "post", encType: "multipart/form-data" });
  };

  const platformLabel = (group: SupportPlatformGroup) => (isPlatform(group.slug) ? ui(`platform.${group.slug}`) : group.name);
  const dayValue = values.preferredDay ?? "";
  const windowValue = values.preferredWindow ?? "";
  const handoverValue = values.handover ?? "";

  return (
    <div className="page grid gap-section pb-12 pt-4 lg:grid-cols-12 lg:gap-x-10 lg:pt-6">
      <div className="grid min-w-0 content-start gap-5 lg:col-span-8">
        <header className="grid gap-3">
          <SupportTabs current="repair" />
          <h1 className="type-title text-ink">{t("repair.title")}</h1>
          <p className="max-w-[68ch] type-body text-ink-2">{t("repair.lede")}</p>
        </header>

        {fromAssistant && summary ? (
          <p className="flex items-start gap-2 rounded-md bg-niche px-3 py-2 type-caption text-ink-2">
            <Icon name="info" size={16} className="mt-0.5 shrink-0" />
            <span>{t("repair.fromAssistant")}</span>
          </p>
        ) : null}

        <form ref={formRef} id={ids.form} method="post" encType="multipart/form-data" noValidate onSubmit={onSubmit} className="grid gap-8">
          <input type="hidden" name="idempotencyKey" value={values.idempotencyKey || loaderData.formKey} />
          <input type="hidden" name="source" value={fromAssistant ? "assistant" : "storefront"} />

          <fieldset className="grid gap-4">
            <legend className="mb-3 type-section text-ink">{t("repair.sections.device")}</legend>
            <Select
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
              <TextField label={t("repair.deviceText")} name="deviceText" required maxLength={120} hint={t("repair.deviceTextHint")} defaultValue={values.deviceText ?? ""} error={error("deviceText")} onBlur={onBlur("deviceText")} onInput={onInput("deviceText")} />
            ) : null}
            <TextField
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
          </fieldset>

          <fieldset className="grid gap-4">
            <legend className="mb-3 type-section text-ink">{t("repair.sections.problem")}</legend>
            <TextArea
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
            <PhotoPicker
              name="photos"
              files={photos}
              onChange={(files, problem) => {
                setPhotos(files);
                setLocal((prev) => ({ ...prev, photos: problem ? fieldMessage("photos", problem, t, errorsT) : undefined }));
              }}
              label={t("photos.label")}
              hint={t("photos.hint")}
              error={error("photos")}
              disabled={busy}
            />
          </fieldset>

          <fieldset className="grid gap-4">
            <legend className="mb-3 type-section text-ink">{t("repair.sections.contact")}</legend>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
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
              <TextField label={t("repair.name")} name="contactName" autoComplete="name" optional maxLength={80} defaultValue={values.contactName ?? contact?.name ?? ""} error={serverField("contactName")} />
            </div>
          </fieldset>

          <fieldset className="grid gap-5">
            <legend className="mb-3 type-section text-ink">{t("repair.sections.handover")}</legend>
            <FieldGroup legend={t("repair.handover")} optional error={serverField("handover")}>
              <Radio row name="handover" value="drop_off" label={t("handover.drop_off")} hint={t("handover.drop_offHint")} defaultChecked={handoverValue === "drop_off"} />
              <Radio row name="handover" value="pickup" label={t("handover.pickup")} hint={t("handover.pickupHint")} defaultChecked={handoverValue === "pickup"} />
              <Radio row name="handover" value="" label={t("handover.none")} defaultChecked={handoverValue === ""} />
            </FieldGroup>
            <FieldGroup legend={t("repair.day")} optional layout="row" error={serverField("preferredDay")}>
              <Chip input="radio" name="preferredDay" value="" defaultChecked={dayValue === ""}>
                {t("days.any")}
              </Chip>
              {days.map((day) => (
                <Chip key={day.value} input="radio" name="preferredDay" value={day.value} defaultChecked={dayValue === day.value}>
                  {day.label}
                </Chip>
              ))}
            </FieldGroup>
            <FieldGroup legend={t("repair.window")} optional layout="row" error={serverField("preferredWindow")}>
              <Chip input="radio" name="preferredWindow" value="" defaultChecked={windowValue === ""}>
                {t("windows.any")}
              </Chip>
              {PREFERRED_WINDOWS.filter((window) => window !== "any").map((window) => (
                <Chip key={window} input="radio" name="preferredWindow" value={window} defaultChecked={windowValue === window}>
                  {t(`windows.${window}`)}
                </Chip>
              ))}
            </FieldGroup>
            <p className="flex items-start gap-2 type-caption text-ink-2">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-info" />
              <span>{t("repair.preference")}</span>
            </p>
          </fieldset>

          <div className="grid gap-3 border-t border-line pt-5">
            <p className="type-caption text-ink-2">{t("repair.privacy")}</p>
            {failure && !failure.fields ? (
              <p role="alert" className="flex items-start gap-2 type-body text-red-ink">
                <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
                <span>{formMessage(failure, t, errorsT)}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Key type="submit" variant="commit" size="lg" icon="wrench" loading={busy} disabled={!online} aria-describedby={ids.status}>
                {t("repair.submit")}
              </Key>
              <span id={ids.status} role="status" className="type-caption text-ink-2">
                {busy ? (photos.length > 0 ? t("repair.sendingPhotos", { count: photos.length }) : t("repair.sending")) : !online ? t("form.offline") : ""}
              </span>
            </div>
          </div>
        </form>
      </div>

      <aside aria-labelledby={ids.next} className="grid content-start gap-3 lg:col-span-4 lg:pt-14">
        <div className="grid gap-3 rounded-panel bg-paper p-4 md:p-5 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--s-4))]">
          <h2 id={ids.next} className="type-sub text-ink">
            {t("repair.next.title")}
          </h2>
          <ol className="grid gap-3">
            {(["review", "call", "check", "approve"] as const).map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-ink text-[13px] font-semibold text-ink nums" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="pt-0.5 type-body text-ink">{t(`repair.next.${step}`)}</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
