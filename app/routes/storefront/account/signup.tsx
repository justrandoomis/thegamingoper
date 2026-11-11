import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/signup";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCustomer, signUpCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { recordConsent } from "~/server/services/account/preferences.server";
import { Checkbox, TextField } from "~/ui/Field";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, completeSignIn, formFields, localeRedirect, nextFrom } from "./account.server";
import { AuthShell, GuestPanel } from "./components/AuthShell";
import { AnswerNotice, fieldError, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import { PHONE_EXAMPLE } from "./components/text";

/**
 * Create an account: phone + password (+ optional name). Marketing consent is its own unticked box, stored as a
 * consent record only when ticked. The number is NOT verified (no SMS provider) and the page says so.
 */
export const handle = { nav: "push", order: 1, group: "account-entry" } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const next = nextFrom(url.searchParams.get("next"));
  if (await getCustomer(ctx, getDb())) throw localeRedirect(next, ctx.locale);
  return { next, asked: url.searchParams.has("next"), i18n: messagesFor(ctx.locale, "account") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const fields = formFields(await request.formData());
  const name = fields.name?.trim() ? fields.name : undefined;
  try {
    const session = await signUpCustomer(ctx, db, { phone: fields.phone ?? "", password: fields.password ?? "", name, locale: ctx.locale });
    if (fields.marketing === "1") {
      await recordConsent(db, { subjectType: "customer", subjectId: session.customer.id, kind: "marketing", granted: true, source: "signup", ip: ctx.ip, now: ctx.now });
    }
    await completeSignIn(ctx, db, session.customer.id);
    return localeRedirect(nextFrom(fields.next), ctx.locale);
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, values: { phone: fields.phone ?? "", name: fields.name ?? "", marketing: fields.marketing === "1" } }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "signup");

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const navigation = useNavigation();
  const answer = (actionData ?? null) as (ActionAnswer & { values?: { phone: string; name: string; marketing: boolean } }) | null;
  const failed = answer && answer.ok === false ? answer : null;
  const values = answer?.values;
  const pending = navigation.state === "submitting";
  const signInHref = loaderData.asked ? `/account/login?next=${encodeURIComponent(loaderData.next)}` : "/account/login";
  return (
    <AuthShell
      aside={
        <>
          <section aria-labelledby="signup-why" className="panel--paper grid gap-3 rounded-lg p-4 sm:p-6">
            <h2 id="signup-why" className="type-sub text-ink">
              {t("signup.lead")}
            </h2>
            <ul className="grid gap-2">
              {(["benefitOrders", "benefitAddresses", "benefitWallet"] as const).map((key) => (
                <li key={key} className="flex items-start gap-2 type-body text-ink">
                  <Icon name="check-circle" size={20} className="mt-0.5 text-ok" />
                  <span>{t(`signup.${key}`)}</span>
                </li>
              ))}
            </ul>
          </section>
          <GuestPanel />
        </>
      }
    >
      <header className="grid gap-2">
        <h1 className="type-title text-ink">{t("signup.title")}</h1>
        <p className="type-body text-ink-2">{t("signup.lead")}</p>
      </header>
      {failed && failed.code !== "invalid" ? <AnswerNotice answer={failed} /> : null}
      <Form method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="next" value={loaderData.next} />
        <TextField name="name" autoComplete="name" label={t("signup.name")} optional defaultValue={values?.name ?? ""} error={fieldError(failed, "name")} />
        <TextField
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          label={t("signup.phone")}
          hint={t("common.phoneHint", { example: PHONE_EXAMPLE })}
          required
          defaultValue={values?.phone ?? ""}
          error={fieldError(failed, "phone")}
        />
        <PasswordField name="password" autoComplete="new-password" label={t("signup.password")} hint={t("signup.passwordHint")} required error={fieldError(failed, "password")} />
        <Checkbox name="marketing" value="1" label={t("signup.marketing")} hint={t("signup.marketingHint")} defaultChecked={values?.marketing === true} />
        <p className="flex items-start gap-2 rounded-md bg-niche p-3 type-caption text-ink-2">
          <Icon name="info" size={18} className="mt-0.5 shrink-0 text-info" />
          <span>{t("signup.unverified")}</span>
        </p>
        <p className="type-caption text-ink-2">
          {fillNodes(t("signup.terms"), {
            terms: (
              <TextLink key="terms" as={LocaleLink} to="/policies/terms" inline>
                {t("signup.termsLink")}
              </TextLink>
            ),
            privacy: (
              <TextLink key="privacy" as={LocaleLink} to="/policies/privacy" inline>
                {t("signup.privacyLink")}
              </TextLink>
            ),
          })}
        </p>
        <SubmitKey pending={pending} icon="user">
          {t("signup.submit")}
        </SubmitKey>
      </Form>
      <p className="flex flex-wrap items-center gap-x-2 border-t border-line pt-4 type-body text-ink-2">
        {t("signup.haveAccount")}
        <TextLink as={LocaleLink} to={signInHref}>
          {t("signup.signIn")}
        </TextLink>
      </p>
    </AuthShell>
  );
}
