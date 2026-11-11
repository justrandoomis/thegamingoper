import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/settings";
import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { changeCustomerPassword, listCustomerSessions, revokeAllCustomerSessions, revokeCustomerSession } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { AppError } from "~/server/errors";
import { codeDelivery, confirmPhoneCode, requestPhoneCode } from "~/server/services/account/codes.server";
import { getPreferences, recordConsent, setNotificationChannels } from "~/server/services/account/preferences.server";
import { clearRecentlyViewed, MAX_RECENTLY_VIEWED } from "~/server/services/account/recently-viewed.server";
import { NOTIFICATION_CHANNELS } from "~/server/services/account/types";
import { Checkbox, Switch, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { saveConsent } from "../home/personal";
import { accountFailure, formFields, otpOptions, requireSignedIn, setConsentCookie } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { describeUserAgent } from "./components/device-name";
import { AnswerNotice, fieldError, FormNotice, PasswordField, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { ltr } from "./components/text";

/**
 * Settings: order-message channels (stored; no provider can deliver yet, and the page says so), the separate offers
 * consent and personalization consent (an append-only history; never pre-ticked), phone confirmation (the SMS
 * boundary: unavailable in production, a labelled on-screen code in development), password, and signed-in devices
 * (sign one out, or every other one).
 */
export const handle = { nav: "push", order: sectionOrder("settings") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer, session } = await requireSignedIn(request, ctx, db);
  const [preferences, sessions] = await Promise.all([getPreferences(db, customer.id), listCustomerSessions(db, customer.id, ctx.now, session.id)]);
  return {
    preferences,
    sessions: sessions.map((row) => ({ id: row.id, current: row.current, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, ...describeUserAgent(row.userAgent) })),
    phone: { masked: customer.phoneMasked, verified: customer.phoneVerified },
    delivery: codeDelivery(ctx.isDev),
    maxRecent: MAX_RECENTLY_VIEWED,
    // "5 minutes ago" is computed from the request time on both sides, so the server and the browser print the same words.
    now: ctx.now,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer, actor, session } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  const intent = fields.intent ?? "";
  const ok = <T extends Record<string, unknown>>(extra: T) => data({ ok: true as const, intent, ...extra });
  try {
    switch (intent) {
      case "channels":
        await setNotificationChannels(db, actor, { sms: fields.sms, whatsapp: fields.whatsapp, email: fields.email }, ctx.now);
        return ok({});
      case "consents": {
        const subject = { subjectType: "customer" as const, subjectId: customer.id };
        const marketing = fields.marketing === "1";
        const personalization = fields.personalization === "1";
        await recordConsent(db, { ...subject, kind: "marketing", granted: marketing, source: "account", ip: ctx.ip, now: ctx.now });
        await recordConsent(db, { ...subject, kind: "personalization", granted: personalization, source: "account", ip: ctx.ip, now: ctx.now });
        setConsentCookie(ctx, personalization);
        // Withdrawing personalization forgets what was kept under it.
        if (!personalization) await clearRecentlyViewed(db, { customerId: customer.id, cartToken: null });
        return ok({});
      }
      case "phoneRequest": {
        const sent = await requestPhoneCode(ctx, db, otpOptions());
        return ok({ codeId: sent.id, devCode: sent.devCode });
      }
      case "phoneConfirm":
        await confirmPhoneCode(ctx, db, { code: fields.code, id: fields.codeId }, otpOptions());
        return ok({});
      case "password":
        await changeCustomerPassword(ctx, db, { currentPassword: fields.currentPassword ?? "", newPassword: fields.newPassword ?? "" });
        return ok({});
      case "revokeSession": {
        if (!fields.sessionId || fields.sessionId === session.id) throw new AppError("session_unknown", 409);
        if (!(await revokeCustomerSession(db, customer.id, fields.sessionId, ctx.now))) throw new AppError("session_unknown", 409);
        return ok({});
      }
      case "revokeOthers":
        return ok({ count: await revokeAllCustomerSessions(db, customer.id, ctx.now, session.id) });
      default:
        return data({ ok: false as const, code: "invalid", intent }, { status: 400 });
    }
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, intent, codeId: fields.codeId ?? null }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "settings");

type Answer = ActionAnswer & { intent?: string; codeId?: string | null; devCode?: string | null; count?: number };

/** A fetcher per section, and a toast when its request succeeded. */
function useSectionFetcher(onOk: (answer: Answer) => void) {
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as Answer | null;
  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok) onOk(answer);
  });
  return { fetcher, answer, failed: answer && answer.ok === false ? answer : null, pending: fetcher.state !== "idle" };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  return (
    <>
      <PageHead title={t("settings.title")} />
      <ChannelsSection preferences={loaderData.preferences} />
      <ConsentsSection preferences={loaderData.preferences} maxRecent={loaderData.maxRecent} />
      <PhoneSection phone={loaderData.phone} delivery={loaderData.delivery} />
      <PasswordSection />
      <SessionsSection sessions={loaderData.sessions} now={loaderData.now} />
    </>
  );
}

type Preferences = Awaited<ReturnType<typeof loader>>["preferences"];

function ChannelsSection({ preferences }: { preferences: Preferences }) {
  const t = useT("account");
  const { fetcher, failed, pending } = useSectionFetcher(() => toast.success(t("settings.channelsSaved")));
  const anyProvider = NOTIFICATION_CHANNELS.some((channel) => preferences.providers[channel]);
  return (
    <Section id="notify" title={t("settings.notifyTitle")}>
      <fetcher.Form method="post" className="grid gap-3 rounded-lg bg-paper p-4 sm:p-6">
        <input type="hidden" name="intent" value="channels" />
        <p className="type-body text-ink-2">{t("settings.notifyLead")}</p>
        {!anyProvider ? (
          <FormNotice tone="info">{t("settings.notifyNone")}</FormNotice>
        ) : null}
        <AnswerNotice answer={failed} />
        <div className="grid gap-1">
          {NOTIFICATION_CHANNELS.map((channel) => (
            <Checkbox key={channel} name={channel} value="1" label={t(`settings.channels.${channel}`)} defaultChecked={preferences.channels[channel]} />
          ))}
        </div>
        <SubmitKey pending={pending} icon="floppy-disk" size="sm" variant="clay" className="justify-self-start">
          {t("settings.saveChannels")}
        </SubmitKey>
      </fetcher.Form>
    </Section>
  );
}

function ConsentsSection({ preferences, maxRecent }: { preferences: Preferences; maxRecent: number }) {
  const t = useT("account");
  const wanted = useRef<boolean | null>(null);
  const { fetcher, failed, pending } = useSectionFetcher(() => {
    // This device follows the answer the way the home area's onboarding does: withdrawing it also forgets the
    // platforms and the recently-viewed list kept on the device (~/routes/storefront/home/personal).
    if (wanted.current !== null) saveConsent(wanted.current);
    toast.success(t("settings.consentsSaved"));
  });
  return (
    <Section id="privacy" title={t("settings.privacyTitle")}>
      <fetcher.Form
        method="post"
        className="grid gap-4 rounded-lg bg-paper p-4 sm:p-6"
        onSubmit={(event) => {
          const input = event.currentTarget.elements.namedItem("personalization");
          wanted.current = input instanceof HTMLInputElement ? input.checked : null;
        }}
      >
        <input type="hidden" name="intent" value="consents" />
        <AnswerNotice answer={failed} />
        <fieldset className="grid gap-1">
          <legend className="type-label font-semibold text-ink">{t("settings.marketingTitle")}</legend>
          {/* Ticked only when the customer said yes before — never by default. */}
          <Checkbox name="marketing" value="1" label={t("settings.marketing")} hint={t("settings.marketingHint")} defaultChecked={preferences.marketing === true} />
        </fieldset>
        <Switch name="personalization" value="1" label={t("settings.personalization")} hint={t("settings.personalizationHint", { max: maxRecent })} defaultChecked={preferences.personalization === true} />
        <SubmitKey pending={pending} icon="floppy-disk" size="sm" variant="clay" className="justify-self-start">
          {t("settings.saveConsents")}
        </SubmitKey>
      </fetcher.Form>
    </Section>
  );
}

function PhoneSection({ phone, delivery }: { phone: { masked: string; verified: boolean }; delivery: "provider" | "dev" | "unavailable" }) {
  const t = useT("account");
  const { fetcher, answer, failed, pending } = useSectionFetcher((ok) => {
    if (ok.intent === "phoneConfirm") toast.success(t("settings.phoneConfirmed"));
  });
  const codeId = answer?.ok && answer.intent === "phoneRequest" ? answer.codeId : failed?.intent === "phoneConfirm" ? failed.codeId : null;
  return (
    <Section id="phone" title={t("settings.phoneTitle")}>
      <div className="grid gap-3 rounded-lg bg-paper p-4 sm:p-6">
        {phone.verified ? (
          <p className="flex items-center gap-2 type-body text-ink">
            <Icon name="seal-check" size={20} className="text-ok" />
            {t("settings.phoneVerified", { phone: ltr(phone.masked) })}
          </p>
        ) : delivery === "unavailable" ? (
          <>
            <Status tone="neutral">{t("common.unverified")}</Status>
            <p className="type-body text-ink-2">{t("settings.phoneUnavailable")}</p>
          </>
        ) : (
          <>
            <Status tone="neutral">{t("common.unverified")}</Status>
            {delivery === "dev" ? (
              <FormNotice tone="warn">
                <strong className="font-semibold">{t("common.devOnly")}</strong> · {t("forgot.devNote")}
              </FormNotice>
            ) : null}
            <AnswerNotice answer={failed && failed.code !== "invalid" ? failed : null} />
            {codeId ? (
              <fetcher.Form method="post" className="grid gap-3">
                <input type="hidden" name="intent" value="phoneConfirm" />
                <input type="hidden" name="codeId" value={codeId} />
                {answer?.ok && answer.devCode ? (
                  <p className="type-sub nums" dir="ltr">
                    {t("forgot.devCode", { code: answer.devCode })}
                  </p>
                ) : null}
                <TextField name="code" inputMode="numeric" autoComplete="one-time-code" ltr label={t("settings.phoneCode")} required error={fieldError(failed, "code")} />
                <SubmitKey pending={pending} icon="seal-check" size="sm" variant="clay" className="justify-self-start">
                  {t("settings.phoneConfirm")}
                </SubmitKey>
              </fetcher.Form>
            ) : (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="phoneRequest" />
                <SubmitKey pending={pending} icon="paper-plane-tilt" size="sm" variant="clay">
                  {t("settings.phoneRequest")}
                </SubmitKey>
              </fetcher.Form>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function PasswordSection() {
  const t = useT("account");
  const { fetcher, answer, failed, pending } = useSectionFetcher(() => toast.success(t("settings.passwordChanged")));
  const done = answer?.ok === true;
  return (
    <Section id="password" title={t("settings.passwordTitle")}>
      {/* Re-mounted after a change so both fields are empty again. */}
      <fetcher.Form key={done ? "done" : "form"} method="post" className="grid max-w-[34rem] gap-4 rounded-lg bg-paper p-4 sm:p-6" noValidate>
        <input type="hidden" name="intent" value="password" />
        {done ? <FormNotice tone="ok">{t("settings.passwordChanged")}</FormNotice> : null}
        <AnswerNotice answer={failed && failed.code !== "invalid" ? failed : null} />
        <PasswordField name="currentPassword" autoComplete="current-password" label={t("settings.currentPassword")} required error={fieldError(failed, "currentPassword")} />
        <PasswordField name="newPassword" autoComplete="new-password" label={t("settings.newPassword")} hint={t("signup.passwordHint")} required error={fieldError(failed, "newPassword")} />
        <SubmitKey pending={pending} icon="key" size="sm" variant="clay" className="justify-self-start">
          {t("settings.changePassword")}
        </SubmitKey>
      </fetcher.Form>
    </Section>
  );
}

type SessionRow = Awaited<ReturnType<typeof loader>>["sessions"][number];

function SessionsSection({ sessions, now }: { sessions: SessionRow[]; now: number }) {
  const t = useT("account");
  const f = useFormat();
  const others = useSectionFetcher((ok) => toast.success(t("settings.signedOutOthers", { count: ok.count ?? 0 })));
  // One device at a time is signed out from here (the row is gone once the list reloads; the section is not).
  const one = useSectionFetcher(() => toast.success(t("settings.signedOutOne")));
  const revoking = one.pending ? String(one.fetcher.formData?.get("sessionId") ?? "") : null;
  const hasOthers = sessions.some((session) => !session.current);
  return (
    <Section
      id="sessions"
      title={t("settings.sessionsTitle")}
      aside={
        hasOthers ? (
          <others.fetcher.Form method="post">
            <input type="hidden" name="intent" value="revokeOthers" />
            <Key type="submit" size="sm" variant="quiet" icon="sign-out" loading={others.pending}>
              {t("settings.signOutOthers")}
            </Key>
          </others.fetcher.Form>
        ) : null
      }
    >
      <p className="type-body text-ink-2">{t("settings.sessionsLead")}</p>
      <AnswerNotice answer={others.failed ?? one.failed} />
      <ul className="grid gap-2">
        {sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            label={sessionLabel(t, session)}
            lastSeen={f.relative(session.lastSeenAt, now)}
            since={f.date(session.createdAt)}
            pending={revoking === session.id}
            onSignOut={() => one.fetcher.submit({ intent: "revokeSession", sessionId: session.id }, { method: "post" })}
          />
        ))}
      </ul>
    </Section>
  );
}

function sessionLabel(t: ReturnType<typeof useT>, session: SessionRow): string {
  if (!session.browser && !session.os) return t("settings.unknownDevice");
  return t("settings.device", { browser: session.browser ?? t("settings.unknownDevice"), os: session.os ?? t("settings.unknownOs") });
}

function SessionItem({ session, label, lastSeen, since, pending, onSignOut }: { session: SessionRow; label: string; lastSeen: string; since: string; pending: boolean; onSignOut: () => void }) {
  const t = useT("account");
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper p-4">
      <div className="grid min-w-0 gap-0.5">
        <p className="flex flex-wrap items-center gap-2 type-label text-ink">
          <Icon name={session.os === "Android" || session.os === "iPhone" ? "device-mobile" : "desktop"} size={20} className="text-ink-2" />
          <bdi>{label}</bdi>
          {session.current ? <Status tone="ok">{t("settings.thisDevice")}</Status> : null}
        </p>
        <p className="type-caption text-ink-2">
          {t("settings.lastSeen", { when: lastSeen })} · {t("settings.since", { date: since })}
        </p>
      </div>
      {!session.current ? (
        <Key size="sm" variant="quiet" icon="sign-out" loading={pending} onClick={onSignOut}>
          {t("settings.signOutSession")}
        </Key>
      ) : null}
    </li>
  );
}
