/**
 * «تتبّع طلب استبدال» — the track card of the trade-in start page (v2.1, client note 10: the status lookup visible on
 * the start page). The request number and the mobile number it was sent with open the request's page:
 *
 *   with script      the form posts straight to /trade-in/<ref> — that page's action looks the request up (reference
 *                    AND phone, rate-limited, one sentence for a wrong reference or phone) and the page shows it
 *   without script   the form posts to /trade-in, whose action sends the browser on with a 307 (the phone goes along)
 *
 * Checked here first, so nothing is sent to be refused: a number that cannot be a request number (any case, spaces,
 * «TI-» left out and Arabic digits are fine — ../wizard tradeInRefFromInput) and an empty or unreadable phone; field
 * errors under their fields and focus on the first. Offline the key goes flat with the reason. The key is a clay
 * secondary: the start page's job is choosing a device (its tiles), not this.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { Form, useActionData, useNavigation } from "react-router";

import { Icon } from "~/art/Icon";
import { useLocalePath } from "~/i18n/react";
import { normalizeIraqPhone } from "~/lib/phone";
import { cx } from "~/ui/cx";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { useErrorText, useUsedT } from "../i18n";
import { TRADE_IN_PATH, tradeInRefFromInput } from "../wizard";

/**
 * The trade-in route's answer to a lookup it could not pass on (no script, a number that cannot be a reference) — with
 * the numbers as they were typed, which the card keeps.
 */
type LookupRefused = { intent?: string; ok?: boolean; fields?: Record<string, string>; values?: { ref?: string; phone?: string } };

export function TradeInTrack({ id, className }: { id: string; className?: string }) {
  const t = useUsedT();
  const errorText = useErrorText();
  const localePath = useLocalePath();
  const navigation = useNavigation();
  const online = useOnline();
  const headingId = useId();
  const reasonId = useId();
  const refInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const answer = useActionData() as LookupRefused | undefined;
  const lookupAnswer = answer?.intent === "lookup" && answer.ok === false ? answer : null;
  const refused = lookupAnswer?.fields?.ref ?? null;
  const [ref, setRef] = useState(lookupAnswer?.values?.ref ?? "");
  const [errors, setErrors] = useState<{ ref?: string; phone?: string }>({});
  const normalized = tradeInRefFromInput(ref);
  // with script the form goes straight to the request's page; the server-rendered form (no script) to this page
  const action = localePath(normalized ? `${TRADE_IN_PATH}/${normalized}` : TRADE_IN_PATH);
  const sending = navigation.state !== "idle" && navigation.formData?.get("intent") === "lookup";

  const checkRef = (value: string) => (tradeInRefFromInput(value) ? undefined : t("tradein.start.track.refInvalid"));
  const checkPhone = (value: string) => (value.trim() === "" ? errorText("required") : normalizeIraqPhone(value) ? undefined : errorText("phone_invalid"));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // offline the lookup cannot leave the device (it would end on the error page and drop what was typed)
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      event.preventDefault();
      return;
    }
    const data = new FormData(event.currentTarget);
    const next = { ref: checkRef(String(data.get("ref") ?? "")), phone: checkPhone(String(data.get("phone") ?? "")) };
    setErrors(next);
    if (next.ref || next.phone) {
      event.preventDefault();
      (next.ref ? refInput : phoneInput).current?.focus();
    }
  };

  return (
    <section id={id} aria-labelledby={headingId} className={cx("used-track", className)}>
      <div className="flex items-start gap-3">
        <span className="clay-disc used-disc" aria-hidden="true">
          <Icon name="receipt" size={22} />
        </span>
        <div className="grid min-w-0 gap-1">
          <h2 id={headingId} className="type-h3 text-ink">
            {t("tradein.start.track.title")}
          </h2>
          <p className="type-sm text-ink-2">{t("tradein.start.track.text")}</p>
        </div>
      </div>
      <Form method="post" action={action} noValidate onSubmit={onSubmit} className="grid gap-4">
        <input type="hidden" name="intent" value="lookup" />
        <div className="used-track__fields">
          <TextField
            ref={refInput}
            name="ref"
            label={t("tradein.start.track.ref")}
            required
            ltr
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={24}
            hint={t("tradein.start.track.refHint")}
            value={ref}
            onChange={(event) => setRef(event.currentTarget.value)}
            onBlur={(event) => {
              // read now: the event's target is gone by the time a state updater runs
              const value = event.currentTarget.value;
              if (value.trim()) setErrors((current) => ({ ...current, ref: checkRef(value) }));
            }}
            error={errors.ref ?? refused ?? undefined}
          />
          <TextField
            ref={phoneInput}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            label={t("track.lookup.phone")}
            required
            hint={t("track.lookup.phoneHint")}
            defaultValue={lookupAnswer?.values?.phone ?? undefined}
            onInput={(event) => {
              const value = event.currentTarget.value;
              if (errors.phone) setErrors((current) => ({ ...current, phone: checkPhone(value) }));
            }}
            error={errors.phone}
          />
        </div>
        <div className="grid gap-2">
          {online ? null : (
            <p id={reasonId} className="flex items-start gap-1.5 type-xs text-ink-2" role="status">
              <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
              {t("track.lookup.offline")}
            </p>
          )}
          <Key type="submit" icon="magnifying-glass" loading={sending} disabled={!online} aria-describedby={online ? undefined : reasonId} className="justify-self-start">
            {t("track.lookup.submit")}
          </Key>
        </div>
      </Form>
      <p className="flex items-start gap-2 type-xs text-ink-2">
        <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
        {t("track.lookup.why")}
      </p>
    </section>
  );
}
