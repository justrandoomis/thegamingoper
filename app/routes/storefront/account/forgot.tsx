import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/forgot";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { codeDelivery, requestPasswordResetCode, resetPasswordWithCode } from "~/server/services/account/codes.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, formFields, localeRedirect, otpOptions } from "./account.server";
import { AuthCard } from "./components/AuthCard";
import { fieldError, FormFailure, Notice, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import { HANDOFF, ltr, PHONE_EXAMPLE } from "./components/text";

/**
 * Password reset by a code to the phone — THE SMS BOUNDARY. The code flow is shown only when a text-message provider is
 * configured (`codeDelivery` = "provider"). Today none is, so the page says plainly that a staff member resets the
 * password and hands over to the one "talk to a person" destination (Design System v2 §6.13) — in production and in
 * development alike: the customer pages carry no "development mode" text (§9.5). The answers keep their shape for the
 * security suite (tests/storefront-adversarial: `delivery` from the loader; a `devCode` from the action in
 * development only) — the page itself never shows a development code.
 */
export const handle = { nav: "push", order: 2, group: "account-entry" } satisfies MotionHandle;

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  if (await getCustomer(ctx, getDb())) throw localeRedirect("/account/settings", ctx.locale);
  return { delivery: codeDelivery(ctx.isDev), i18n: messagesFor(ctx.locale, "account") };
}

type ResetAnswer = ActionAnswer & { step?: "code"; phone?: string; id?: string; phoneMasked?: string };

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const fields = formFields(await request.formData());
  try {
    if (fields.intent === "reset") {
      await resetPasswordWithCode(ctx, db, { phone: fields.phone, code: fields.code, id: fields.id, password: fields.password }, otpOptions());
      return localeRedirect("/account/login?reset=1", ctx.locale);
    }
    const sent = await requestPasswordResetCode(ctx, db, { phone: fields.phone }, otpOptions());
    return data({ ok: true as const, step: "code" as const, phone: fields.phone ?? "", id: sent.id, phoneMasked: sent.phoneMasked, devCode: sent.devCode });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    // A failed reset keeps the code step open (same phone and code id).
    const keep = fields.intent === "reset" ? { step: "code" as const, phone: fields.phone ?? "", id: fields.id ?? "" } : { phone: fields.phone ?? "" };
    return data({ ...failure, ...keep }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "forgot");

export default function Forgot({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const navigation = useNavigation();
  const answer = (actionData ?? null) as ResetAnswer | null;
  const failed = answer && answer.ok === false ? answer : null;
  const pending = navigation.state === "submitting";
  const codeStep = answer?.step === "code";
  // «العودة إلى تسجيل الدخول» goes back: its arrow points toward the reading start (a leading arrow-left, mirrored in
  // Arabic and Kurdish), not the forward arrow every other text link carries.
  const back = (
    <TextLink as={LocaleLink} to="/account/login" icon="arrow-left" arrow={false}>
      {t("forgot.back")}
    </TextLink>
  );

  // Without a text-message provider (today, everywhere) a person resets the password.
  if (loaderData.delivery !== "provider") {
    return (
      <AuthCard title={t("forgot.title")} footer={back}>
        <Notice title={t("forgot.unavailableTitle")} flat>
          {t("forgot.unavailableText")}
        </Notice>
        <Key as={LocaleLink} to={HANDOFF} variant="primary" icon="chat-circle" className="justify-self-start">
          {t("common.talk")}
        </Key>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("forgot.title")} lead={codeStep ? undefined : t("forgot.lead")} footer={back}>
      <FormFailure
        answer={failed}
        fields={[
          { name: "phone", id: "forgot-phone", label: t("forgot.phone") },
          { name: "code", id: "forgot-code", label: t("forgot.code") },
          { name: "password", id: "forgot-password", label: t("forgot.newPassword") },
        ]}
      />
      {!codeStep ? (
        <Form method="post" className="grid gap-4" noValidate>
          <input type="hidden" name="intent" value="request" />
          <TextField
            id="forgot-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            label={t("forgot.phone")}
            hint={t("common.phoneHint", { example: PHONE_EXAMPLE })}
            required
            defaultValue={answer?.phone ?? ""}
            error={fieldError(failed, "phone")}
          />
          <SubmitKey variant="primary" pending={pending} icon="paper-plane-tilt">
            {t("forgot.requestCode")}
          </SubmitKey>
        </Form>
      ) : (
        <Form method="post" className="grid gap-4" noValidate>
          <input type="hidden" name="intent" value="reset" />
          <input type="hidden" name="phone" value={answer?.phone ?? ""} />
          <input type="hidden" name="id" value={answer?.id ?? ""} />
          {answer?.ok && answer.phoneMasked ? (
            <Notice tone="ok" flat>
              {t("forgot.codeSent", { phone: ltr(answer.phoneMasked) })}
            </Notice>
          ) : null}
          <TextField id="forgot-code" name="code" inputMode="numeric" autoComplete="one-time-code" label={t("forgot.code")} required ltr error={fieldError(failed, "code")} />
          <PasswordField id="forgot-password" name="password" autoComplete="new-password" label={t("forgot.newPassword")} hint={t("signup.passwordHint")} required error={fieldError(failed, "password")} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <SubmitKey variant="primary" pending={pending} icon="key">
              {t("forgot.submit")}
            </SubmitKey>
            <TextLink as={LocaleLink} to="/account/forgot" arrow={false}>
              {t("forgot.newCode")}
            </TextLink>
          </div>
        </Form>
      )}
    </AuthCard>
  );
}
