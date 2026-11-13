/**
 * /trade-in/:ref without the link (Design System v2 §6.11 "Track", reused for trade-ins): a centred 560px card — the
 * reference, «رقم الموبايل» and the primary «اعرض الطلب» — and why the number is asked. A wrong reference and a wrong
 * phone get the same sentence (nothing to probe); a missing or unreadable number is a field error. The action is the
 * page's (intent=lookup); after a match the page shows the request and moves focus to its heading.
 *
 * Review 2026-11-13: the start page's track card posts here, so a lookup that found nothing often arrives on a page of
 * its own — the phone as typed comes back with the answer (kept in the field) and focus goes to it; and the reference
 * is part of this page's address, so «تتبّع طلباً آخر» leads back to the track card, where both numbers can be changed.
 */
import { useEffect, useId, useRef } from "react";
import { Form, useActionData, useNavigation } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { TextLink } from "~/ui/TextLink";
import { useErrorText, useUsedT } from "../i18n";

/** Left-to-right isolate and its end: the reference reads left to right inside Arabic and Sorani. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
/**
 * A word joiner after the reference's dash: the sentence never breaks «TI-» from the rest (at 390 in Sorani the line
 * ended on «TI-» and the next began «7KP4S8J9ـت» — review 2026-11-13).
 */
const unbroken = (ref: string) => ref.replace(/-/g, `-${String.fromCharCode(0x2060)}`);

type LookupAnswer = { intent: "lookup" | "respond" | null; ok: boolean; code?: string; message?: string; fields?: Record<string, string>; phone?: string };

export function TradeInLookup({ refText }: { refText: string }) {
  const t = useUsedT();
  const errorText = useErrorText();
  const answer = useActionData() as LookupAnswer | undefined;
  const navigation = useNavigation();
  const failed = answer?.intent === "lookup" && !answer.ok ? answer : null;
  const fieldError = failed?.fields?.phone;
  const notFound = failed && !failed.fields ? (failed.message ?? errorText(failed.code)) : null;
  const sending = navigation.state !== "idle" && navigation.formData?.get("intent") === "lookup";
  // Offline the lookup cannot leave the device (it would end on the error page and drop the number): the key goes flat
  // with the reason, and Enter in the field does nothing.
  const online = useOnline();
  const reasonId = useId();
  const phoneInput = useRef<HTMLInputElement>(null);
  // A lookup that found nothing (or a number to fix): the field to correct takes focus — also when the answer arrived on
  // a page of its own (from the start page's track card), where focus would otherwise start at the top.
  useEffect(() => {
    if (failed) phoneInput.current?.focus();
  }, [failed]);
  return (
    <section aria-labelledby="ti-lookup" className="panel mx-auto grid w-full max-w-[35rem] gap-5 p-5 md:p-8">
      <header className="grid justify-items-start gap-3">
        {/* the before's raised circle with the brand's line icon (v2.1) */}
        <span className="clay-disc used-disc used-disc--lg" aria-hidden="true">
          <Icon name="receipt" size={26} />
        </span>
        <h1 id="ti-lookup" className="type-h1 text-ink">
          {t("track.lookup.title")}
        </h1>
        <p className="used-read text-ink-2">{t("track.lookup.text", { ref: `${LRI}${unbroken(refText)}${PDI}` })}</p>
      </header>
      <Form method="post" className="grid gap-4" noValidate onSubmit={(event) => (navigator.onLine ? undefined : event.preventDefault())}>
        <input type="hidden" name="intent" value="lookup" />
        <TextField
          ref={phoneInput}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          label={t("track.lookup.phone")}
          required
          hint={t("track.lookup.phoneHint")}
          defaultValue={failed?.phone ?? undefined}
          error={fieldError}
        />
        {notFound ? (
          <div className="callout callout--danger" role="alert">
            <Icon name="warning-circle" size={20} />
            <span className="callout__text text-ink">{notFound}</span>
          </div>
        ) : null}
        {online ? null : (
          <p id={reasonId} className="flex items-start gap-1.5 type-xs text-ink-2" role="status">
            <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
            {t("track.lookup.offline")}
          </p>
        )}
        <Key type="submit" variant="primary" loading={sending} disabled={!online} aria-describedby={online ? undefined : reasonId} className="justify-self-start">
          {t("track.lookup.submit")}
        </Key>
      </Form>
      <p className="used-read flex items-start gap-2 text-ink-2">
        <Icon name="lock" size={16} className="mt-1.5 shrink-0" />
        {t("track.lookup.why")}
      </p>
      <div className="flex flex-wrap gap-x-6 border-t border-line pt-4">
        {/* the reference is this page's address: a different number is typed on the start page's track card */}
        <TextLink as={LocaleLink} to="/trade-in#ti-track">
          {t("track.lookup.otherRef")}
        </TextLink>
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
