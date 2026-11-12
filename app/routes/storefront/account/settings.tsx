import { useEffect, useRef, useState } from "react";
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
import { enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { CONSENT_CHANGES_PER_CUSTOMER, getPreferences, recordConsent, setNotificationChannels } from "~/server/services/account/preferences.server";
import { MAX_RECENTLY_VIEWED } from "~/server/services/account/recently-viewed.server";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "~/server/services/account/types";
import { Switch, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { Tag } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { saveConsent } from "../home/personal";
import { forgetPersonalData } from "../home/personal.server";
import { accountFailure, formFields, otpOptions, requireSignedIn, setConsentCookie } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { describeUserAgent } from "./components/device-name";
import { fieldError, FormFailure, Notice, OfflineNote, PasswordField, rescueFocus, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { ltr } from "./components/text";

/**
 * Settings — one card width (Design System v2 §6.12): the offers and viewing-history consents as switches that save on
 * their own with a toast (each choice is recorded only when the customer makes it — never assumed; the offers sentence
 * is the checkout's), order-message channels and phone confirmation ONLY when a provider can deliver them (none today:
 * no inert checkboxes, no "development mode"), the password, and the signed-in devices (sign one out, or every other).
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
    // A code can be sent only through a configured text-message provider; anything else hides the section.
    phoneCodes: codeDelivery(ctx.isDev) === "provider",
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
  const subject = { subjectType: "customer" as const, subjectId: customer.id };
  /** Personalization withdrawn: forget what was kept under it (the account's recently-viewed list, recommendation signals). */
  const followPersonalization = async (granted: boolean) => {
    setConsentCookie(ctx, granted);
    if (!granted) await forgetPersonalData(ctx, db, customer.id);
  };
  try {
    switch (intent) {
      case "channels":
        await setNotificationChannels(db, actor, { sms: fields.sms, whatsapp: fields.whatsapp, email: fields.email }, ctx.now);
        return ok({});
      case "consent": {
        // One switch: only the consent the customer touched is recorded (append-only; one budget with the home panel).
        await enforceRateLimit(db, await limitKey("consent", "customer", customer.id), CONSENT_CHANGES_PER_CUSTOMER, ctx.now);
        const kind = fields.kind === "marketing" || fields.kind === "personalization" ? fields.kind : null;
        if (!kind) throw new AppError("invalid", 400);
        const granted = fields.granted === "1";
        await recordConsent(db, { ...subject, kind, granted, source: "account", ip: ctx.ip, now: ctx.now });
        if (kind === "personalization") await followPersonalization(granted);
        return ok({ kind, granted });
      }
      case "consents": {
        // Both at once: the form without script (security review 2026-11: consents are append-only).
        await enforceRateLimit(db, await limitKey("consent", "customer", customer.id), CONSENT_CHANGES_PER_CUSTOMER, ctx.now);
        const personalization = fields.personalization === "1";
        await recordConsent(db, { ...subject, kind: "marketing", granted: fields.marketing === "1", source: "account", ip: ctx.ip, now: ctx.now });
        await recordConsent(db, { ...subject, kind: "personalization", granted: personalization, source: "account", ip: ctx.ip, now: ctx.now });
        await followPersonalization(personalization);
        return ok({});
      }
      case "phoneRequest": {
        const sent = await requestPhoneCode(ctx, db, otpOptions());
        // devCode: development only, for the tests (auth-rotation); the page never shows it.
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

type Answer = ActionAnswer & { intent?: string; codeId?: string | null; count?: number; kind?: string; granted?: boolean };

/** A fetcher per card, and a callback when its request answered (once per answer). */
function useCardFetcher(onAnswer: (answer: Answer) => void) {
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as Answer | null;
  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    onAnswer(answer);
  });
  return { fetcher, answer, failed: answer && answer.ok === false ? answer : null, pending: fetcher.state !== "idle" };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const channels = NOTIFICATION_CHANNELS.filter((channel) => loaderData.preferences.providers[channel]);
  return (
    <>
      <PageHead title={t("settings.title")} lead={t("settings.lead")} />
      <div className="acct-narrow grid gap-6">
        <ConsentsCard preferences={loaderData.preferences} phone={loaderData.phone.masked} maxRecent={loaderData.maxRecent} />
        {channels.length > 0 ? <ChannelsCard preferences={loaderData.preferences} channels={channels} /> : null}
        {loaderData.phoneCodes || loaderData.phone.verified ? <PhoneCard phone={loaderData.phone} /> : null}
        <PasswordCard />
        <SessionsCard sessions={loaderData.sessions} now={loaderData.now} />
      </div>
    </>
  );
}

type Preferences = Awaited<ReturnType<typeof loader>>["preferences"];

/** One consent switch: it saves itself when changed, says so in a toast, and goes back with a sentence if refused. */
function ConsentSwitch({ kind, initial, label, hint }: { kind: "marketing" | "personalization"; initial: boolean; label: string; hint: string }) {
  const t = useT("account");
  const online = useOnline();
  const [on, setOn] = useState(initial);
  const saved = useRef(initial);
  const [error, setError] = useState<string | null>(null);
  const { fetcher, pending } = useCardFetcher((answer) => {
    if (answer.ok) {
      saved.current = answer.granted === true;
      setError(null);
      // This device follows the viewing-history answer the way the home area's onboarding does: withdrawing it also
      // forgets the platforms and the recently-viewed list kept on the device (~/routes/storefront/home/personal).
      if (kind === "personalization") saveConsent(saved.current);
      toast.success(t("settings.saved"));
    } else {
      setOn(saved.current);
      setError(answer.message ?? t("settings.failed"));
    }
  });
  return (
    <div className="grid gap-1" aria-busy={pending || undefined}>
      <Switch
        name={kind}
        value="1"
        checked={on}
        label={label}
        hint={hint}
        error={error ?? undefined}
        disabled={!online}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setOn(next);
          fetcher.submit({ intent: "consent", kind, granted: next ? "1" : "0" }, { method: "post" });
        }}
      />
    </div>
  );
}

function ConsentsCard({ preferences, phone, maxRecent }: { preferences: Preferences; phone: string; maxRecent: number }) {
  const t = useT("account");
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="acct-card">
      <h2 id="privacy-title" className="acct-card__title">
        {t("settings.privacyTitle")}
      </h2>
      {/* Without script the switches post together (intent "consents"); with it each one saves on its own. */}
      <form method="post" className="grid gap-4">
        <input type="hidden" name="intent" value="consents" />
        {/* Ticked only when the customer said yes before — never by default. */}
        <ConsentSwitch kind="marketing" initial={preferences.marketing === true} label={t("settings.marketing")} hint={t("settings.marketingHint", { phone: ltr(phone) })} />
        <ConsentSwitch kind="personalization" initial={preferences.personalization === true} label={t("settings.personalization")} hint={t("settings.personalizationHint", { max: maxRecent })} />
        <OfflineNote />
        <noscript>
          <Key type="submit" size="sm">
            {t("settings.save")}
          </Key>
        </noscript>
      </form>
    </section>
  );
}

function ChannelsCard({ preferences, channels }: { preferences: Preferences; channels: readonly NotificationChannel[] }) {
  const t = useT("account");
  const online = useOnline();
  const [chosen, setChosen] = useState(preferences.channels);
  const saved = useRef(preferences.channels);
  const wanted = useRef(preferences.channels);
  const { fetcher } = useCardFetcher((answer) => {
    if (answer.ok) {
      saved.current = wanted.current;
      toast.success(t("settings.saved"));
    } else {
      setChosen(saved.current);
      toast.error(answer.message ?? t("settings.failed"));
    }
  });
  const change = (channel: NotificationChannel, on: boolean) => {
    const next = { ...chosen, [channel]: on };
    setChosen(next);
    wanted.current = next;
    fetcher.submit({ intent: "channels", ...Object.fromEntries(NOTIFICATION_CHANNELS.filter((name) => next[name]).map((name) => [name, "1"])) }, { method: "post" });
  };
  return (
    <section id="notify" aria-labelledby="notify-title" className="acct-card">
      <div className="grid gap-1">
        <h2 id="notify-title" className="acct-card__title">
          {t("settings.notifyTitle")}
        </h2>
        <p className="type-sm text-ink-2">{t("settings.notifyLead")}</p>
      </div>
      {/* Without script the switches post together with «احفظ» (intent "channels"); with it each change saves at once. */}
      <form method="post" className="grid gap-3">
        <input type="hidden" name="intent" value="channels" />
        {channels.map((channel) => (
          <Switch key={channel} name={channel} value="1" checked={chosen[channel]} disabled={!online} label={t(`settings.channels.${channel}`)} onChange={(event) => change(channel, event.currentTarget.checked)} />
        ))}
        <noscript>
          <Key type="submit" size="sm">
            {t("settings.save")}
          </Key>
        </noscript>
      </form>
    </section>
  );
}

function PhoneCard({ phone }: { phone: { masked: string; verified: boolean } }) {
  const t = useT("account");
  const { fetcher, answer, failed, pending } = useCardFetcher((ok) => {
    if (ok.ok && ok.intent === "phoneConfirm") toast.success(t("settings.phoneConfirmed"));
  });
  const codeId = answer?.ok && answer.intent === "phoneRequest" ? answer.codeId : failed?.intent === "phoneConfirm" ? failed.codeId : null;
  return (
    <section id="phone" aria-labelledby="phone-title" className="acct-card">
      <h2 id="phone-title" className="acct-card__title">
        {t("settings.phoneTitle")}
      </h2>
      {phone.verified ? (
        <p className="flex items-center gap-2 type-sm text-ink">
          <Icon name="seal-check" size={20} className="text-ok" />
          {t("settings.phoneVerified", { phone: ltr(phone.masked) })}
        </p>
      ) : (
        <>
          <FormFailure answer={failed} fields={[{ name: "code", id: "phone-code", label: t("settings.phoneCode") }]} />
          {codeId ? (
            <fetcher.Form method="post" className="grid gap-4" noValidate>
              <input type="hidden" name="intent" value="phoneConfirm" />
              <input type="hidden" name="codeId" value={codeId} />
              <Notice tone="ok">{t("settings.codeSent", { phone: ltr(phone.masked) })}</Notice>
              <TextField id="phone-code" name="code" inputMode="numeric" autoComplete="one-time-code" ltr label={t("settings.phoneCode")} required error={fieldError(failed, "code")} />
              <SubmitKey pending={pending} icon="seal-check">
                {t("settings.phoneConfirm")}
              </SubmitKey>
            </fetcher.Form>
          ) : (
            <fetcher.Form method="post" className="grid justify-items-start gap-3">
              <input type="hidden" name="intent" value="phoneRequest" />
              <p className="type-sm text-ink-2">{t("settings.phoneLead", { phone: ltr(phone.masked) })}</p>
              <SubmitKey pending={pending} icon="paper-plane-tilt">
                {t("settings.phoneRequest")}
              </SubmitKey>
            </fetcher.Form>
          )}
        </>
      )}
    </section>
  );
}

function PasswordCard() {
  const t = useT("account");
  const [round, setRound] = useState(0);
  const { fetcher, failed, pending } = useCardFetcher((answer) => {
    if (!answer.ok) return;
    toast.success(t("settings.passwordChanged"));
    // Both fields empty again.
    setRound((value) => value + 1);
  });
  return (
    <section id="password" aria-labelledby="password-title" className="acct-card">
      <h2 id="password-title" className="acct-card__title">
        {t("settings.passwordTitle")}
      </h2>
      <fetcher.Form key={round} method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="intent" value="password" />
        <FormFailure
          answer={failed}
          fields={[
            { name: "currentPassword", id: "password-current", label: t("settings.currentPassword") },
            { name: "newPassword", id: "password-new", label: t("settings.newPassword") },
          ]}
        />
        <PasswordField id="password-current" name="currentPassword" autoComplete="current-password" label={t("settings.currentPassword")} required error={fieldError(failed, "currentPassword")} />
        <PasswordField id="password-new" name="newPassword" autoComplete="new-password" label={t("settings.newPassword")} hint={t("signup.passwordHint")} required error={fieldError(failed, "newPassword")} />
        <SubmitKey variant="primary" pending={pending} icon="key">
          {t("settings.changePassword")}
        </SubmitKey>
      </fetcher.Form>
    </section>
  );
}

type SessionRow = Awaited<ReturnType<typeof loader>>["sessions"][number];

function SessionsCard({ sessions, now }: { sessions: SessionRow[]; now: number }) {
  const t = useT("account");
  const online = useOnline();
  const f = useFormat();
  // Both keys go with what they signed out (the row, or every other row): focus lands on the card's title, not <body>.
  const others = useCardFetcher((answer) => {
    if (!answer.ok) return;
    toast.success(t("settings.signedOutOthers", { count: answer.count ?? 0 }));
    rescueFocus("sessions-title");
  });
  // One device at a time is signed out from here (the row is gone once the list reloads; the card is not).
  const one = useCardFetcher((answer) => {
    if (!answer.ok) return;
    toast.success(t("settings.signedOutOne"));
    rescueFocus("sessions-title");
  });
  const revoking = one.pending ? String(one.fetcher.formData?.get("sessionId") ?? "") : null;
  const hasOthers = sessions.some((session) => !session.current);
  return (
    <section id="sessions" aria-labelledby="sessions-title" className="acct-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="sessions-title" tabIndex={-1} className="acct-card__title">
            {t("settings.sessionsTitle")}
          </h2>
          <p className="type-sm text-ink-2">{t("settings.sessionsLead")}</p>
        </div>
        {hasOthers ? (
          <others.fetcher.Form method="post">
            <input type="hidden" name="intent" value="revokeOthers" />
            <Key type="submit" size="sm" icon="sign-out" loading={others.pending} disabled={!online}>
              {t("settings.signOutOthers")}
            </Key>
          </others.fetcher.Form>
        ) : null}
      </div>
      <FormFailure answer={others.failed ?? one.failed} />
      <OfflineNote />
      <ul className="grid">
        {sessions.map((session) => {
          const label = sessionLabel(t, session);
          return (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
              <div className="flex min-w-0 items-start gap-3">
                <Icon name={session.os === "Android" || session.os === "iPhone" ? "device-mobile" : "desktop"} size={24} className="mt-0.5 shrink-0 text-ink-2" />
                <div className="grid min-w-0 gap-0.5">
                  <p className="flex flex-wrap items-center gap-2 type-sm-strong text-ink">
                    <bdi>{label}</bdi>
                    {session.current ? <Tag kind="ok">{t("settings.thisDevice")}</Tag> : null}
                  </p>
                  <p className="type-xs text-ink-2">
                    {t("settings.lastSeen", { when: f.relative(session.lastSeenAt, now) })} · {t("settings.since", { date: f.date(session.createdAt, "long") })}
                  </p>
                </div>
              </div>
              {!session.current ? (
                <Key
                  size="sm"
                  variant="ghost"
                  icon="sign-out"
                  loading={revoking === session.id}
                  disabled={!online}
                  aria-label={t("settings.signOutSessionNamed", { device: label })}
                  onClick={() => one.fetcher.submit({ intent: "revokeSession", sessionId: session.id }, { method: "post" })}
                >
                  {t("settings.signOutSession")}
                </Key>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function sessionLabel(t: ReturnType<typeof useT>, session: SessionRow): string {
  if (!session.browser && !session.os) return t("settings.unknownDevice");
  return t("settings.device", { browser: session.browser ?? t("settings.unknownDevice"), os: session.os ?? t("settings.unknownOs") });
}
