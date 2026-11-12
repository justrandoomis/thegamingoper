import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/signup";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import { normalizeIraqPhone } from "~/lib/phone";
import type { MotionHandle } from "~/motion";
import { getCustomer, signUpCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { invalid } from "~/server/errors";
import { recordConsent } from "~/server/services/account/preferences.server";
import { Checkbox, TextField } from "~/ui/Field";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, completeSignIn, formFields, localeRedirect, nextFrom } from "./account.server";
import { AuthCard } from "./components/AuthCard";
import { fieldError, FormFailure, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import { PHONE_EXAMPLE } from "./components/text";

/**
 * Create an account: phone + password (+ an optional name). The offers consent is its own unticked box with the
 * checkout's sentence («أرسل لي العروض على هذا الرقم»), stored as a consent record only when ticked. The number is not
 * confirmed by SMS (no provider); nothing on the page pretends it is.
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
    let failure = accountFailure(error, ctx.locale);
    // The sign-up checks the number only after the other fields pass: say everything that is wrong in one answer, so
    // a short password and a mistyped number do not take two rounds (§4.9: one summary of every field).
    if (failure.code === "invalid" && failure.fields && !failure.fields.phone && fields.phone?.trim() && normalizeIraqPhone(fields.phone) === null) {
      const phone = accountFailure(invalid({ phone: "phone_invalid" }), ctx.locale).fields?.phone;
      if (phone) failure = { ...failure, fields: { ...failure.fields, phone } };
    }
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
    <AuthCard
      title={t("signup.title")}
      lead={t("signup.lead")}
      footer={
        <>
          <span>{t("signup.haveAccount")}</span>
          <TextLink as={LocaleLink} to={signInHref}>
            {t("signup.signIn")}
          </TextLink>
        </>
      }
    >
      <FormFailure
        answer={failed}
        fields={[
          { name: "name", id: "signup-name", label: t("signup.name") },
          { name: "phone", id: "signup-phone", label: t("signup.phone") },
          { name: "password", id: "signup-password", label: t("signup.password") },
        ]}
      />
      <Form method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="next" value={loaderData.next} />
        <TextField id="signup-name" name="name" autoComplete="name" label={t("signup.name")} optional defaultValue={values?.name ?? ""} error={fieldError(failed, "name")} />
        <TextField
          id="signup-phone"
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
        <PasswordField id="signup-password" name="password" autoComplete="new-password" label={t("signup.password")} hint={t("signup.passwordHint")} required error={fieldError(failed, "password")} />
        {/* never ticked by default; the same sentence as the checkout's consent */}
        <Checkbox name="marketing" value="1" label={t("signup.marketing")} hint={t("signup.marketingHint")} defaultChecked={values?.marketing === true} />
        <p className="type-xs text-ink-2">
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
        <SubmitKey variant="primary" pending={pending} icon="user" className="pt-1">
          {t("signup.submit")}
        </SubmitKey>
      </Form>
    </AuthCard>
  );
}
