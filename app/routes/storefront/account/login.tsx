import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/login";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCustomer, signInCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { TextField } from "~/ui/Field";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, completeSignIn, formFields, localeRedirect, nextFrom } from "./account.server";
import { AuthCard } from "./components/AuthCard";
import { fieldError, FormFailure, Notice, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import { PHONE_EXAMPLE } from "./components/text";

/**
 * Sign in with phone + password (Design System v2 §6.12: one centred card, the guest note under it). A signed-in
 * visitor goes straight to `next`. Guests are never forced here to order.
 */
export const handle = { nav: "push", order: 0, group: "account-entry" } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const next = nextFrom(url.searchParams.get("next"));
  if (await getCustomer(ctx, getDb())) throw localeRedirect(next, ctx.locale);
  const notice = url.searchParams.has("signedout") ? "signedOut" : url.searchParams.has("reset") ? "resetDone" : null;
  return { next, asked: url.searchParams.has("next"), notice, i18n: messagesFor(ctx.locale, "account") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const fields = formFields(await request.formData());
  try {
    const session = await signInCustomer(ctx, db, { phone: fields.phone ?? "", password: fields.password ?? "" });
    await completeSignIn(ctx, db, session.customer.id);
    return localeRedirect(nextFrom(fields.next), ctx.locale);
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, phone: fields.phone ?? "" }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "login");

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const navigation = useNavigation();
  const answer = (actionData ?? null) as (ActionAnswer & { phone?: string }) | null;
  const pending = navigation.state === "submitting";
  const failed = answer && answer.ok === false ? answer : null;
  // A wrong password and an unknown number get one sentence above the form; the field itself is only marked.
  const credentials = failed?.code === "invalid_credentials";
  const signUpHref = loaderData.asked ? `/account/signup?next=${encodeURIComponent(loaderData.next)}` : "/account/signup";
  return (
    <AuthCard
      title={t("login.title")}
      lead={loaderData.asked ? t("login.continueHint") : t("login.lead")}
      footer={
        <>
          <span>{t("login.noAccount")}</span>
          <TextLink as={LocaleLink} to={signUpHref}>
            {t("login.createAccount")}
          </TextLink>
        </>
      }
    >
      {loaderData.notice && !failed ? (
        <Notice tone="ok" flat>
          {t(`login.${loaderData.notice}`)}
        </Notice>
      ) : null}
      <FormFailure
        answer={failed}
        fields={[
          { name: "phone", id: "login-phone", label: t("login.phone") },
          { name: "password", id: "login-password", label: t("login.password") },
        ]}
      />
      <Form method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="next" value={loaderData.next} />
        <TextField
          id="login-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="username"
          label={t("login.phone")}
          hint={t("common.phoneHint", { example: PHONE_EXAMPLE })}
          required
          defaultValue={answer?.phone ?? ""}
          error={fieldError(failed, "phone")}
        />
        <PasswordField
          id="login-password"
          name="password"
          autoComplete="current-password"
          label={t("login.password")}
          required
          error={credentials ? undefined : fieldError(failed, "password")}
          aria-invalid={credentials ? true : undefined}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
          <SubmitKey variant="primary" pending={pending} icon="sign-in">
            {t("login.submit")}
          </SubmitKey>
          <TextLink as={LocaleLink} to="/account/forgot" arrow={false}>
            {t("login.forgot")}
          </TextLink>
        </div>
      </Form>
    </AuthCard>
  );
}
