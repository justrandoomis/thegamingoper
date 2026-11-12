/**
 * "Talk to a person" (Design System v2 §6.13): one destination everywhere (/support/assistant?handoff=1#handoff). A
 * paper card with what staff will receive (the conversation summary), the contact fields, optional private photos and
 * the consent the conversation needs before anything is stored — «نرسل محادثتك إلى موظف مع رقم طلب تتابع به ردّه.»
 * No call promise: the phone is "used only about your request". After sending, the page is reloaded with the ticket's
 * reference and access token, and the receipt shows the reference (Plex 600 20px, tabular, left-to-right, with a copy
 * key), the ticket's status and the replies staff write to the shopper — that page's link is how they follow it.
 *
 * The form works without JavaScript (a native multipart POST); with it, fields are checked as the shopper leaves them,
 * a summary of what is wrong sits above the form on submit, and photos are previewed (PhotoPicker).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigation, useSubmit } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { AssistantView } from "~/server/services/support/types";
import { DemoNote } from "~/ui/DemoNote";
import { Checkbox, FormErrorSummary, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { fillNodes } from "~/ui/PriceTag";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { fieldMessage, formMessage, phoneProblem, type FormFailure } from "../client";
import { CopyKey, CopyLinkKey } from "./parts";
import { PhotoPicker } from "./PhotoPicker";

export type HandoffReceipt = { ref: string; createdAt: number; phoneMasked: string; status: string; isDemo: boolean; replies?: Array<{ at: number; body: string }>; canRate?: boolean };

const STATUS_TONE: Record<string, StatusTone> = { open: "warn", pending_staff: "warn", pending_customer: "info", on_hold: "neutral", resolved: "ok", closed: "neutral" };

/**
 * The receipt after sending. `token`: the receipt's own access token — its page /support/ticket shows the same request
 * by the same private link, and asks for the rating once staff solved it («قيّم المساعدة»).
 */
export function HandoffReceiptCard({ receipt, summary, token = null }: { receipt: HandoffReceipt; summary: string; token?: string | null }) {
  const t = useT("support");
  const f = useFormat();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Arriving here after sending: the receipt's heading takes focus, so screen readers start with the outcome.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.closest("section")?.scrollIntoView({ block: "start" });
  }, []);
  const replies = receipt.replies ?? [];
  const statusKey = `handoff.statuses.${receipt.status}`;
  const statusWords = t(statusKey) === statusKey ? receipt.status : t(statusKey);
  return (
    <section aria-labelledby={headingId} className="sup-card sup-receipt">
      <div className="flex items-start gap-3">
        <span className="sup-done-disc" aria-hidden="true">
          <Icon name="check" size={24} />
        </span>
        <div className="grid min-w-0 gap-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-h3 text-ink">
            {t("handoff.success.title")}
          </h2>
          <p className="type-sm text-ink-2">{t("handoff.success.text")}</p>
          {/* this page's link is one way back to the reply (a key copies it); the reference and the phone are the other */}
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
            <CopyLinkKey />
            <TextLink as={LocaleLink} to={token ? `/support/ticket?ref=${encodeURIComponent(receipt.ref)}&tk=${encodeURIComponent(token)}${receipt.canRate ? "#rate" : ""}` : "/support/ticket"}>
              {receipt.canRate ? t("handoff.rate") : t("handoff.follow")}
            </TextLink>
          </div>
        </div>
      </div>
      <dl className="sup-receipt__facts">
        <div className="grid gap-1">
          <dt className="type-sm-strong text-ink-2">{t("handoff.success.ticket")}</dt>
          <dd className="flex flex-wrap items-center gap-x-2">
            <bdi dir="ltr" className="type-code text-ink">
              {receipt.ref}
            </bdi>
            <CopyKey text={receipt.ref} what={t("handoff.success.ticket")} />
            {receipt.isDemo ? <DemoNote variant="tag">{t("handoff.success.demo")}</DemoNote> : null}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="type-sm-strong text-ink-2">{t("handoff.success.status")}</dt>
          <dd>
            <Status tone={STATUS_TONE[receipt.status] ?? "neutral"} size="lg">
              {statusWords}
            </Status>
          </dd>
        </div>
      </dl>
      <div className="grid gap-2">
        <h3 className="type-sm-strong text-ink">{t("handoff.success.replies")}</h3>
        {replies.length > 0 ? (
          <ol className="grid gap-2">
            {replies.map((reply, index) => (
              <li key={`${reply.at}:${index}`} className="sup-bubble sup-bubble--bot">
                <p className="whitespace-pre-wrap type-body text-ink" dir="auto">
                  {reply.body}
                </p>
                <p className="type-xs text-ink-2">{f.dateTime(reply.at)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="type-sm text-ink-2">{t("handoff.success.noReply")}</p>
        )}
      </div>
      {summary ? (
        <details className="sup-details">
          <summary className="sup-details__summary">
            <span className="min-w-0 flex-1">{t("handoff.preview")}</span>
            <Icon name="caret-down" size={20} className="sup-details__caret" />
          </summary>
          <pre className="sup-summary">{summary}</pre>
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
  /** Opened from an order's page (`?order=TT-…`): the order it is about — said here, and sent along. */
  orderRef?: string | null;
};

export function HandoffForm({ view, formKey, contact, failure, orderRef = null }: Props) {
  const t = useT("support");
  const errorsT = useT("errors");
  const headingId = useId();
  const offlineId = useId();
  const submit = useSubmit();
  const navigation = useNavigation();
  const online = useOnline();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [summaryShown, setSummaryShown] = useState(false);
  // A whole-form failure (the store unreachable, a limit): its sentence comes into view.
  useEffect(() => {
    if (failure && !failure.fields) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
  // Opened from a "talk to a person" link (#handoff): the form's heading takes focus, so screen readers start there.
  useEffect(() => {
    if (window.location.hash === "#handoff") headingRef.current?.focus({ preventScroll: true });
  }, []);
  const [local, setLocal] = useState<Record<string, string | undefined>>({});
  // The server refused a field: its word wins over an earlier client check of that field, and focus goes to it.
  useEffect(() => {
    const fields = failure?.fields ? Object.keys(failure.fields) : [];
    if (fields.length === 0) return;
    setLocal((prev) => Object.fromEntries(Object.entries(prev).filter(([name]) => !fields.includes(name))));
    setSummaryShown(true);
    const element = formRef.current?.elements.namedItem(fields[0]);
    if (element instanceof HTMLElement) element.focus();
  }, [failure]);
  const values = failure?.values ?? {};
  const serverField = (name: string) => fieldMessage(name, failure?.fields?.[name], t, errorsT);
  const error = (name: string) => (name in local ? local[name] : serverField(name));
  const ids = { phone: `${headingId}-phone`, contactName: `${headingId}-name`, note: `${headingId}-note`, photos: `${headingId}-photos`, consent: `${headingId}-consent` };

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
    setSummaryShown(Boolean(firstBad));
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
  const LABELS = { phone: t("handoff.phone"), contactName: t("handoff.name"), note: t("handoff.note"), photos: t("photos.label"), consent: t("handoff.consent") } as const;
  const summaryErrors = summaryShown ? (Object.keys(LABELS) as Array<keyof typeof LABELS>).filter((name) => error(name)).map((name) => ({ id: ids[name], label: LABELS[name] })) : [];
  return (
    <section id="handoff" aria-labelledby={headingId} className="sup-card sup-handoff">
      <div className="grid gap-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-h3 text-ink">
          {t("handoff.title")}
        </h2>
        <p className="type-sm text-ink-2">{t("handoff.text")}</p>
        {orderRef ? (
          <p className="flex flex-wrap items-center gap-x-1.5 type-sm-strong text-ink" data-handoff-order={orderRef}>
            <Icon name="package" size={16} />
            {fillNodes(t("handoff.about"), { ref: <bdi dir="ltr" className="nums">{orderRef}</bdi> })}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1 rounded-sm bg-niche px-4 py-3">
        <p className="type-sm-strong text-ink">{t("handoff.preview")}</p>
        <pre className="sup-summary">{view.summary}</pre>
      </div>
      <form ref={formRef} method="post" encType="multipart/form-data" noValidate onSubmit={onSubmit} className="grid gap-5">
        <input type="hidden" name="intent" value="handoff" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        {orderRef ? <input type="hidden" name="order" value={orderRef} /> : null}
        {[...fields.entries()].map(([name, value], index) => (
          <input key={`${name}:${index}`} type="hidden" name={name} value={value} />
        ))}
        <FormErrorSummary errors={summaryErrors} />
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            id={ids.phone}
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
          <TextField id={ids.contactName} label={t("handoff.name")} name="contactName" autoComplete="name" optional maxLength={80} defaultValue={values.contactName ?? contact?.name ?? ""} error={serverField("contactName")} />
        </div>
        <TextArea id={ids.note} label={t("handoff.note")} name="note" optional hint={t("handoff.noteHint")} maxLength={2000} rows={3} defaultValue={values.note ?? ""} error={serverField("note")} />
        <PhotoPicker
          id={ids.photos}
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
          id={ids.consent}
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
          <p ref={alertRef} role="alert" className="sup-alert">
            <Icon name="warning-circle" size={20} />
            <span>{formMessage(failure, t, errorsT)}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Key type="submit" variant="primary" icon="paper-plane-tilt" loading={busy} disabled={!online} aria-describedby={!online ? offlineId : undefined}>
            {t("handoff.submit")}
          </Key>
          <Key as={LocaleLink} to={`/support/assistant${view.search}`} preventScrollReset variant="ghost">
            {t("handoff.close")}
          </Key>
          {!online ? (
            <span id={offlineId} className="type-xs text-ink-2">
              {t("form.offline")}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
