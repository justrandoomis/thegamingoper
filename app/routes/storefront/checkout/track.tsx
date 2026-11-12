import { useEffect, useRef, useState, type FormEvent } from "react";
import { data, Form, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/track";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { DemoNote } from "~/ui/DemoNote";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { cleanOrderRef, phoneIssue, type FieldIssue } from "./checkout-form";
import { NO_STORE, trackOrder, type TrackResult } from "./checkout.server";
import { OrderDetails, When } from "./components/OrderDetails";
import "./checkout.css";

/**
 * /track — guest order lookup (Design System v2 §6.11; brief §4: "secure lookup via order reference plus phone"): a
 * centred 560px card — «رقم الطلب», «رقم الموبايل», the primary «اعرض الطلب» — and three lines of what the lookup shows.
 * The commerce core's lookupGuestOrder rate-limits by IP and by reference and answers a wrong reference and a wrong
 * phone identically, so the page has one sentence for both. The phone travels in a POST body, never in the URL. A found
 * order takes the focus (its heading) and the form folds into «ابحث عن طلب آخر»; it is shown read-only with the order
 * status template (uploading a transfer photo needs the confirmation link — the core's access rule — and it says so).
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
  const resultRef = useRef<HTMLHeadingElement>(null);
  const found = result?.ok ? result.order : null;

  // A found order takes the focus (its status is what the shopper came for); a miss is announced where the form is.
  useEffect(() => {
    if (found) resultRef.current?.focus();
  }, [found]);

  const text = (name: "ref" | "phone", issue: FieldIssue | undefined): string | undefined => {
    if (!issue) return undefined;
    if (name === "ref") return t(`track.refErrors.${issue.code}`);
    // the phone the order was placed with (§9): its own sentence when it is missing
    if (issue.code === "required") return t("track.phoneRequired");
    return t(`fields.phone.${issue.code}`, issue.count === undefined ? undefined : { count: issue.count, n: f.number(issue.count) });
  };
  const serverField = (name: "ref" | "phone") => (result && !result.ok && result.fields?.[name] && !touched[name] ? errorsT(`errors.${result.fields[name]}`) : undefined);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next = check(ref, phone);
    setIssues(next);
    setTouched({ ref: true, phone: true });
    if (next.ref || next.phone) {
      document.getElementById(next.ref ? "track-ref" : "track-phone")?.focus();
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
    <div className="page co-page">
      <div className="co-track">
        <div className="grid gap-2">
          <h1 className="type-h1 text-ink">{t("track.title")}</h1>
          {found ? null : <p className="type-body text-ink-2">{t("track.lead")}</p>}
        </div>

        {found ? (
          // the form folds once an order is found; a fresh /track opens it again (with or without script)
          <Key as={LocaleLink} to="/track" icon="magnifying-glass" className="justify-self-start">
            {t("track.another")}
          </Key>
        ) : (
          <>
            <Form method="post" noValidate onSubmit={onSubmit} className="co-card grid gap-4">
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
                <p role="alert" className="form-alert">
                  <span className="flex items-start gap-1.5">
                    <Icon name="warning-circle" size={20} className="shrink-0" />
                    <span>{failure.code === "not_found" ? t("track.notFound") : errorsT(`errors.${failure.code}`)}</span>
                  </span>
                </p>
              ) : null}
              <Key type="submit" variant="primary" block loading={busy} disabled={!online} icon="magnifying-glass" aria-describedby={!online ? "track-offline" : undefined}>
                {t("track.submit")}
              </Key>
              {!online ? (
                <p id="track-offline" className="type-xs-strong text-ink-2">
                  {t("reasons.offline")}
                </p>
              ) : null}
            </Form>
            <section aria-labelledby="track-see" className="grid gap-3">
              <h2 id="track-see" className="type-sm-strong text-ink">
                {t("track.see.heading")}
              </h2>
              <ul className="co-see">
                <li>
                  <Icon name="package" size={16} />
                  {t("track.see.status")}
                </li>
                <li>
                  <Icon name="receipt" size={16} />
                  {t("track.see.items")}
                </li>
                <li>
                  <Icon name="map-pin" size={16} />
                  {t("track.see.delivery")}
                </li>
              </ul>
            </section>
            <p className="type-xs text-ink-2">
              {t("track.account")}{" "}
              <TextLink as={LocaleLink} to="/account" inline>
                {t("track.accountLink")}
              </TextLink>
            </p>
          </>
        )}
      </div>

      {found ? (
        <div className="co-track-result">
          <div className="grid gap-1">
            <h2 id="track-result" ref={resultRef} tabIndex={-1} className="type-h2 text-ink outline-none">
              {t("track.result", { ref: "⁦" + found.ref + "⁩" })}
            </h2>
            {/* a demo order stays marked as one wherever it is shown (§9.7), as on the order page */}
            {found.isDemo ? <DemoNote variant="tag" what="order" className="justify-self-start" /> : null}
            <p className="type-xs text-ink-2">{fillNodes(t("order.placedAt"), { date: <When at={found.placedAt} f={f} /> })}</p>
          </div>
          <OrderDetails order={found} mode="tracked" headingLevel={3} />
        </div>
      ) : null}
    </div>
  );
}
