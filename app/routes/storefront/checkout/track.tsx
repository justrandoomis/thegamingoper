import { useEffect, useRef, useState, type FormEvent } from "react";
import { data, Form, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/track";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { fillNodes } from "~/ui/PriceTag";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { cleanOrderRef, phoneIssue, type FieldIssue } from "./checkout-form";
import { NO_STORE, trackOrder, type TrackResult } from "./checkout.server";
import { OrderDetails, When } from "./components/OrderDetails";

/**
 * /track — guest order lookup (brief §4: "secure lookup via order reference plus phone"; ARCHITECTURE §8): the
 * reference AND the phone the order was placed with. The commerce core's lookupGuestOrder rate-limits by IP and by
 * reference and answers a wrong reference and a wrong phone identically, so the page has one sentence for both. The
 * phone travels in a POST body, never in the URL. A found order is shown read-only below the form (uploading a
 * transfer photo needs the confirmation link — the core's access rule — and the page says so).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const ref = normalizeOrderRef(new URL(request.url).searchParams.get("ref"));
  return data({ ref: ref ?? "", i18n: messagesFor(ctx.locale, "checkout", "errors") }, { headers: NO_STORE });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const result = await trackOrder(getDb(), await request.formData(), { ip: ctx.ip, locale: ctx.locale }, ctx.now);
  const headers = new Headers(NO_STORE);
  if (!result.ok && result.retryAfterSec !== undefined) headers.set("Retry-After", String(result.retryAfterSec));
  return data(result, { status: result.ok ? 200 : result.status, headers });
}

export function headers() {
  return NO_STORE;
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.checkout as { meta?: { track?: string } } | undefined;
  return shellMeta(args, { title: tree?.meta?.track ?? null, noindex: true });
};

type Issues = { ref?: FieldIssue; phone?: FieldIssue };

function check(ref: string, phone: string): Issues {
  const issues: Issues = {};
  if (ref.trim() === "") issues.ref = { code: "required" };
  else if (!cleanOrderRef(ref)) issues.ref = { code: "invalid" };
  const phoneProblem = phoneIssue(phone);
  if (phoneProblem) issues.phone = phoneProblem;
  return issues;
}

export default function TrackPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const f = useFormat();
  const online = useOnline();
  const navigation = useNavigation();
  const submit = useSubmit();
  const result = actionData as TrackResult | undefined;
  const [ref, setRef] = useState(result && !result.ok ? result.values.ref : loaderData.ref);
  const [phone, setPhone] = useState(result && !result.ok ? result.values.phone : "");
  const [issues, setIssues] = useState<Issues>({});
  const [touched, setTouched] = useState<{ ref?: boolean; phone?: boolean }>({});
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const resultRef = useRef<HTMLDivElement>(null);

  // A found order takes the focus (its status is what the shopper came for); a miss is announced where the form is.
  useEffect(() => {
    if (result?.ok) resultRef.current?.focus();
  }, [result]);

  const text = (name: "ref" | "phone", issue: FieldIssue | undefined): string | undefined => {
    if (!issue) return undefined;
    if (name === "ref") return t(`track.refErrors.${issue.code}`);
    return t(`fields.phone.${issue.code}`, issue.count === undefined ? undefined : { count: issue.count, n: f.number(issue.count) });
  };
  const serverField = (name: "ref" | "phone") => (result && !result.ok && result.fields?.[name] && !touched[name] ? errorsT(`errors.${result.fields[name]}`) : undefined);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const found = check(ref, phone);
    setIssues(found);
    setTouched({ ref: true, phone: true });
    if (found.ref || found.phone) {
      document.getElementById(found.ref ? "track-ref" : "track-phone")?.focus();
      return;
    }
    setTouched({});
    void submit({ ref: cleanOrderRef(ref) ?? ref, phone }, { method: "post" });
  };
  const recheck = (name: "ref" | "phone", nextRef: string, nextPhone: string) => {
    if (!issues[name]) return;
    setIssues((current) => ({ ...current, [name]: check(nextRef, nextPhone)[name] }));
  };

  const failure = result && !result.ok && !result.fields ? result : null;

  return (
    <div className="page grid gap-6 pb-10 pt-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start lg:gap-x-10">
      <div className="grid min-w-0 gap-4 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--safe-top)+var(--s-4))]">
        <div className="grid gap-1">
          <h1 className="type-title text-ink">{t("track.title")}</h1>
          <p className="type-body text-ink-2">{t("track.lead")}</p>
        </div>
        <Form method="post" noValidate onSubmit={onSubmit} className="grid gap-4 rounded-lg bg-paper p-4">
          <TextField
            id="track-ref"
            name="ref"
            label={t("track.ref")}
            required
            ltr
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            value={ref}
            onChange={(event) => {
              setRef(event.currentTarget.value);
              recheck("ref", event.currentTarget.value, phone);
            }}
            onBlur={() => setIssues((current) => ({ ...current, ref: check(ref, phone).ref }))}
            hint={t("track.refHint")}
            error={text("ref", issues.ref) ?? serverField("ref")}
          />
          <TextField
            id="track-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            label={t("track.phone")}
            required
            maxLength={40}
            value={phone}
            onChange={(event) => {
              setPhone(event.currentTarget.value);
              recheck("phone", ref, event.currentTarget.value);
            }}
            onBlur={() => setIssues((current) => ({ ...current, phone: check(ref, phone).phone }))}
            hint={t("track.phoneHint")}
            error={text("phone", issues.phone) ?? serverField("phone")}
          />
          {failure ? (
            <p role="alert" className="flex items-start gap-2 type-label font-medium text-red-ink">
              <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
              {failure.code === "not_found" ? t("track.notFound") : errorsT(`errors.${failure.code}`)}
            </p>
          ) : null}
          <Key type="submit" variant="ink" block loading={busy} disabled={!online} icon="magnifying-glass" aria-describedby={!online ? "track-offline" : undefined}>
            {t("track.submit")}
          </Key>
          {!online ? (
            <p id="track-offline" className="type-caption text-ink-2">
              {t("reasons.offline")}
            </p>
          ) : null}
        </Form>
        <p className="type-caption text-ink-2">
          {t("track.account")}{" "}
          <LocaleLink to="/account" className="font-semibold text-ink underline underline-offset-4">
            {t("track.accountLink")}
          </LocaleLink>
        </p>
      </div>

      {result?.ok ? (
        <div ref={resultRef} tabIndex={-1} className="grid min-w-0 gap-4 outline-none" aria-labelledby="track-result">
          <div className="grid gap-1">
            <p className="type-label text-ink-2">{t("order.number")}</p>
            <h2 id="track-result" className="type-title text-ink">
              <bdi dir="ltr" className="nums">
                {result.order.ref}
              </bdi>
            </h2>
            <p className="type-caption text-ink-2">{fillNodes(t("order.placedAt"), { date: <When at={result.order.placedAt} f={f} /> })}</p>
          </div>
          <OrderDetails order={result.order} mode="tracked" headingLevel={3} />
        </div>
      ) : null}
    </div>
  );
}
