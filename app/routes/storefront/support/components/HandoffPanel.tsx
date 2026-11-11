/**
 * "Talk to staff" (DESIGN.md §9.22 handoff): a paper card with what staff will receive (the conversation summary),
 * the contact fields, optional private photos and the consent the conversation needs before anything is stored.
 * After sending, the page is reloaded with the ticket's reference and access token, and this card shows the ticket
 * number in tabular type with a copy key.
 *
 * The form works without JavaScript (a native multipart POST); with it, fields are checked as the shopper leaves them
 * and photos are previewed (PhotoPicker).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigation, useSubmit } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import type { AssistantView } from "~/server/services/support/types";
import { Checkbox, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { DemoNote } from "~/ui/DemoNote";
import { fieldMessage, formMessage, phoneProblem, type FormFailure } from "../client";
import { CopyKey } from "./parts";
import { PhotoPicker } from "./PhotoPicker";

export type HandoffReceipt = { ref: string; createdAt: number; phoneMasked: string; status: string; isDemo: boolean };

export function HandoffReceiptCard({ receipt, summary }: { receipt: HandoffReceipt; summary: string }) {
  const t = useT("support");
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-3 rounded-panel border border-line bg-paper p-4 md:p-5" role="status">
      <p className="flex items-center gap-2 text-ok">
        <Icon name="check-circle" size={22} />
        <span id={headingId} className="type-sub text-ink">
          {t("handoff.success.title")}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="type-label text-ink-2">{t("handoff.success.ticket")}</span>
        <bdi dir="ltr" className="type-kpi nums text-ink">
          {receipt.ref}
        </bdi>
        <CopyKey text={receipt.ref} what={t("handoff.success.ticket")} />
      </div>
      <p className="type-body text-ink-2">
        {t("handoff.success.text", { phone: `${String.fromCharCode(0x2066)}${receipt.phoneMasked}${String.fromCharCode(0x2069)}` })}
      </p>
      {receipt.isDemo ? <DemoNote compact>{t("handoff.success.demo")}</DemoNote> : null}
      {summary ? (
        <details className="rounded-md bg-niche px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer items-center type-label text-ink">{t("handoff.preview")}</summary>
          <pre className="whitespace-pre-wrap pb-2 font-plex type-caption text-ink-2">{summary}</pre>
        </details>
      ) : null}
    </section>
  );
}

type Props = {
  view: AssistantView;
  formKey: string;
  contact: { name: string; phone: string } | null;
  failure: FormFailure | null;
};

export function HandoffForm({ view, formKey, contact, failure }: Props) {
  const t = useT("support");
  const errorsT = useT("errors");
  const headingId = useId();
  const submit = useSubmit();
  const navigation = useNavigation();
  const online = useOnline();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  // Opened from a "talk to staff" link (#handoff): the form's heading takes focus, so screen readers start there.
  useEffect(() => {
    if (window.location.hash === "#handoff") headingRef.current?.focus({ preventScroll: true });
  }, []);
  // The server refused a field: go to it.
  useEffect(() => {
    const first = failure?.fields ? Object.keys(failure.fields)[0] : null;
    const element = first ? formRef.current?.elements.namedItem(first) : null;
    if (element instanceof HTMLElement) element.focus();
  }, [failure]);
  const [local, setLocal] = useState<Record<string, string | undefined>>({});
  const values = failure?.values ?? {};
  const serverField = (name: string) => fieldMessage(name, failure?.fields?.[name], t, errorsT);
  const error = (name: string) => (name in local ? local[name] : serverField(name));

  const check = (name: string, value: string) => {
    if (name === "phone") return phoneProblem(value, t, errorsT);
    if (name === "consent") return value ? undefined : t("fieldErrors.consent.required");
    return undefined;
  };
  // Read the value while the event is current: a state updater runs later, when React has already let go of it.
  const onBlur = (name: string) => (event: { currentTarget: HTMLInputElement }) => {
    const problem = check(name, event.currentTarget.value);
    setLocal((prev) => ({ ...prev, [name]: problem }));
  };
  const onInput = (name: string) => (event: { currentTarget: HTMLInputElement }) => {
    if (!error(name)) return;
    const problem = check(name, event.currentTarget.value);
    setLocal((prev) => ({ ...prev, [name]: problem }));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const phone = (form.elements.namedItem("phone") as HTMLInputElement | null)?.value ?? "";
    const consent = (form.elements.namedItem("consent") as HTMLInputElement | null)?.checked ? "on" : "";
    const next = { ...local, phone: check("phone", phone), consent: check("consent", consent) };
    setLocal(next);
    const firstBad = (["phone", "consent"] as const).find((name) => next[name]);
    if (firstBad) {
      (form.elements.namedItem(firstBad) as HTMLElement | null)?.focus();
      return;
    }
    const data = new FormData(form);
    data.delete("photos");
    for (const photo of photos) data.append("photos", photo);
    submit(data, { method: "post", encType: "multipart/form-data", preventScrollReset: true });
  };

  const fields = new URLSearchParams(view.search.slice(1));
  return (
    <section id="handoff" aria-labelledby={headingId} className="grid scroll-mt-24 gap-4 rounded-panel border border-line bg-paper p-4 md:p-5">
      <div className="grid gap-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-section text-ink outline-offset-4">
          {t("handoff.title")}
        </h2>
        <p className="type-body text-ink-2">{t("handoff.text")}</p>
      </div>
      <div className="grid gap-1 rounded-md bg-niche px-3 py-2">
        <p className="type-label text-ink">{t("handoff.preview")}</p>
        <pre className="whitespace-pre-wrap font-plex type-caption text-ink-2">{view.summary}</pre>
      </div>
      <form ref={formRef} method="post" encType="multipart/form-data" noValidate onSubmit={onSubmit} className="grid gap-4">
        <input type="hidden" name="intent" value="handoff" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        {[...fields.entries()].map(([name, value], index) => (
          <input key={`${name}:${index}`} type="hidden" name={name} value={value} />
        ))}
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label={t("handoff.phone")}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            required
            hint={t("handoff.phoneHint")}
            defaultValue={values.phone ?? contact?.phone ?? ""}
            error={error("phone")}
            onBlur={onBlur("phone")}
            onInput={onInput("phone")}
          />
          <TextField label={t("handoff.name")} name="contactName" autoComplete="name" optional maxLength={80} defaultValue={values.contactName ?? contact?.name ?? ""} error={serverField("contactName")} />
        </div>
        <TextArea label={t("handoff.note")} name="note" optional hint={t("handoff.noteHint")} maxLength={2000} rows={3} defaultValue={values.note ?? ""} error={serverField("note")} />
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
        <Checkbox
          label={t("handoff.consent")}
          hint={t("handoff.consentHint")}
          name="consent"
          value="on"
          defaultChecked={false}
          error={error("consent")}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setLocal((prev) => ({ ...prev, consent: checked ? undefined : prev.consent }));
          }}
        />
        {failure && !failure.fields ? (
          <p role="alert" className="flex items-start gap-2 type-body text-red-ink">
            <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
            <span>{formMessage(failure, t, errorsT)}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Key type="submit" variant="ink" icon="paper-plane-tilt" loading={busy} disabled={!online} aria-describedby={!online ? `${headingId}-offline` : undefined}>
            {t("handoff.submit")}
          </Key>
          {!online ? (
            <span id={`${headingId}-offline`} className="type-caption text-ink-2">
              {t("form.offline")}
            </span>
          ) : null}
          <LocaleLink to={`/support/assistant${view.search}`} preventScrollReset className="inline-flex min-h-11 items-center type-label text-ink-2 hover:underline">
            {t("handoff.close")}
          </LocaleLink>
        </div>
      </form>
    </section>
  );
}
