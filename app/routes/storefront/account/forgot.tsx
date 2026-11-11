import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/forgot";
import { Icon } from "~/art/Icon";
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
import { AuthShell } from "./components/AuthShell";
import { AnswerNotice, fieldError, FormNotice, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import { ltr, PHONE_EXAMPLE } from "./components/text";

/**
 * Password reset by a code to the phone — THE SMS BOUNDARY. No SMS provider is configured, so in production this page
 * says that codes cannot be sent and points to the store's contact page; nothing is requested. In development the
 * code is created and shown on the page, labelled as development-only, so the flow can be exercised end to end.
 */
export const handle = { nav: "push", order: 2, group: "account-entry" } satisfies MotionHandle;

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  if (await getCustomer(ctx, getDb())) throw localeRedirect("/account/settings", ctx.locale);
  return { delivery: codeDelivery(ctx.isDev), i18n: messagesFor(ctx.locale, "account") };
}

type ResetAnswer = ActionAnswer & { step?: "code"; phone?: string; id?: string; phoneMasked?: string; devCode?: string | null };

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

  if (loaderData.delivery === "unavailable") {
    return (
      <AuthShell>
        <header className="grid gap-2">
          <h1 className="type-title text-ink">{t("forgot.title")}</h1>
        </header>
        <section className="grid gap-3 rounded-md bg-niche p-4" aria-labelledby="forgot-unavailable">
          <h2 id="forgot-unavailable" className="flex items-start gap-2 type-sub text-ink">
            <Icon name="info" size={22} className="mt-0.5 shrink-0 text-info" />
            {t("forgot.unavailableTitle")}
          </h2>
          <p className="type-body text-ink-2">{t("forgot.unavailableText")}</p>
          <Key as={LocaleLink} to="/contact" icon="chat-circle" className="justify-self-start">
            {t("forgot.contact")}
          </Key>
        </section>
        <TextLink as={LocaleLink} to="/account/login">
          {t("forgot.back")}
        </TextLink>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <header className="grid gap-2">
        <h1 className="type-title text-ink">{t("forgot.title")}</h1>
        <p className="type-body text-ink-2">{t("forgot.lead")}</p>
      </header>
      {loaderData.delivery === "dev" ? (
        <FormNotice tone="warn">
          <strong className="font-semibold">{t("common.devOnly")}</strong> · {t("forgot.devNote")}
        </FormNotice>
      ) : null}
      {failed && failed.code !== "invalid" ? <AnswerNotice answer={failed} /> : null}
      {!codeStep ? (
        <Form method="post" className="grid gap-4" noValidate>
          <input type="hidden" name="intent" value="request" />
          <TextField
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
          <SubmitKey pending={pending} icon="paper-plane-tilt">
            {t("forgot.requestCode")}
          </SubmitKey>
        </Form>
      ) : (
        <Form method="post" className="grid gap-4" noValidate>
          <input type="hidden" name="intent" value="reset" />
          <input type="hidden" name="phone" value={answer?.phone ?? ""} />
          <input type="hidden" name="id" value={answer?.id ?? ""} />
          {answer?.ok && answer.phoneMasked ? (
            <FormNotice tone="info">
              <p>{t("forgot.codeCreated", { phone: ltr(answer.phoneMasked) })}</p>
              {answer.devCode ? (
                <p className="pt-1 type-sub nums" dir="ltr">
                  {t("forgot.devCode", { code: answer.devCode })}
                </p>
              ) : null}
            </FormNotice>
          ) : null}
          <TextField name="code" inputMode="numeric" autoComplete="one-time-code" label={t("forgot.code")} required ltr error={fieldError(failed, "code")} />
          <PasswordField name="password" autoComplete="new-password" label={t("forgot.newPassword")} hint={t("signup.passwordHint")} required error={fieldError(failed, "password")} />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitKey pending={pending} icon="key">
              {t("forgot.submit")}
            </SubmitKey>
            <TextLink as={LocaleLink} to="/account/forgot" arrow={false}>
              {t("forgot.newCode")}
            </TextLink>
          </div>
        </Form>
      )}
      <TextLink as={LocaleLink} to="/account/login">
        {t("forgot.back")}
      </TextLink>
    </AuthShell>
  );
}
