import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/me";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { useAdminShell } from "./actions";
import { adminSecrets } from "./env.server";
import { useAdminT } from "./i18n";
import { loadMySecurity, mySecurityAction, type MeActionResult, type MySession } from "./me.server";
import { adminMeta } from "./meta";

/**
 * /admin/me — "My security": the signed-in employee's two-step verification, password and sessions. Needs a signed-in
 * employee only (it is about their own account); every change is made, checked and audited by the server core.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db);
  return loadMySecurity(ctx, db, session);
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db);
  const result = await mySecurityAction(ctx, db, session, adminSecrets(), await request.formData());
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("me.title"));

type Fetched = MeActionResult | undefined;
const failed = (result: Fetched) => (result && !result.ok ? result : null);

export default function MySecurity({ loaderData }: Route.ComponentProps) {
  const t = useAdminT();
  const f = useFormat();
  const shell = useAdminShell();
  const { employee, sessions, recoveryCodesLeft, now } = loaderData;

  return (
    <div className="adm-narrow">
      <header className="adm-page-head">
        <h1 className="adm-title">{t("me.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("me.lead")}</p>
      </header>

      <section className="adm-section" aria-labelledby="me-account">
        <h2 id="me-account" className="adm-h2">
          {t("me.account")}
        </h2>
        <dl className="adm-card grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="type-caption text-ink-2">{t("me.name")}</dt>
            <dd className="type-strong">{employee.name}</dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("me.email")}</dt>
            <dd className="type-strong">
              <bdi dir="ltr">{employee.email}</bdi>
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("me.roles")}</dt>
            <dd className="type-body">{shell?.employee.roles.join(" · ") || "—"}</dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("me.passwordChanged")}</dt>
            <dd className="type-body nums">{employee.passwordChangedAt ? f.dateTime(employee.passwordChangedAt) : t("me.never")}</dd>
          </div>
        </dl>
      </section>

      <TwoStep enabled={employee.totpEnabled} recoveryCodesLeft={recoveryCodesLeft} />
      <PasswordForm />
      <Sessions sessions={sessions} now={now} />
    </div>
  );
}

/* ───────────────────────────── two-step verification ───────────────────────────── */

function TwoStep({ enabled, recoveryCodesLeft }: { enabled: boolean; recoveryCodesLeft: number | null }) {
  const t = useAdminT();
  // "Start again" opens a fresh round (a new fetcher), back to the form that asks for the password.
  const [round, setRound] = useState(0);
  const enrol = useFetcher<MeActionResult>({ key: `me-totp-${round}` });
  const disable = useFetcher<MeActionResult>({ key: "me-totp-disable" });
  const [codesHidden, setCodesHidden] = useState(false);
  const result = enrol.data;
  const begun = result?.ok && result.intent === "totp-begin" ? result : null;
  const confirmed = result?.ok && result.intent === "totp-confirm" ? result : null;
  const enrolError = failed(result);
  const disableError = failed(disable.data);
  const busy = enrol.state !== "idle";

  useEffect(() => {
    if (confirmed) {
      setCodesHidden(false);
      toast.success(t("me.twoStep.enabled"));
    }
  }, [confirmed, t]);
  useEffect(() => {
    if (disable.data?.ok) toast.success(t("me.twoStep.disabled"));
  }, [disable.data, t]);

  return (
    <section className="adm-section" aria-labelledby="two-step-title" id="two-step">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="two-step-title" className="adm-h2">
          {t("me.twoStep.title")}
        </h2>
        <Status tone={enabled ? "ok" : "warn"}>{enabled ? t("me.twoStep.on") : t("me.twoStep.off")}</Status>
      </div>

      {confirmed && !codesHidden ? <RecoveryCodes codes={confirmed.recoveryCodes} onDone={() => setCodesHidden(true)} /> : null}

      {!enabled ? (
        <div className="adm-card">
          {!begun ? (
            <>
              <p className="type-body text-ink">{t("me.twoStep.offText")}</p>
              {enrolError && !enrolError.fields ? (
                <p className="type-body text-red-ink" role="alert">
                  {enrolError.message ?? t("me.saveFailed")}
                </p>
              ) : null}
              <enrol.Form method="post" className="grid max-w-[24rem] gap-3 pt-3">
                <input type="hidden" name="intent" value="totp-begin" />
                <TextField
                  label={t("me.twoStep.startPassword")}
                  hint={t("me.twoStep.startPasswordHint")}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  error={enrolError?.fields?.password}
                />
                <div>
                  <Key type="submit" variant="ink" icon="lock" loading={busy}>
                    {t("me.twoStep.start")}
                  </Key>
                </div>
              </enrol.Form>
            </>
          ) : (
            <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
              <div data-theme="light" className="adm-qr" dir="ltr">
                <svg viewBox={`-2 -2 ${begun.qr.size + 4} ${begun.qr.size + 4}`} role="img" aria-label={t("me.twoStep.qrLabel")} width="100%" height="100%" shapeRendering="crispEdges">
                  <path d={begun.qr.path} fill="currentColor" />
                </svg>
              </div>
              <div className="grid gap-3">
                <p className="type-body text-ink">{t("me.twoStep.scan")}</p>
                <div>
                  <p className="type-caption text-ink-2">{t("me.twoStep.manual")}</p>
                  <p className="type-strong nums select-all" dir="ltr">
                    <bdi>{begun.secret}</bdi>
                  </p>
                </div>
                <enrol.Form method="post" className="grid gap-3">
                  <input type="hidden" name="intent" value="totp-confirm" />
                  <TextField
                    label={t("me.twoStep.code")}
                    hint={t("me.twoStep.codeHint")}
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    required
                    error={enrolError?.fields?.code ?? (enrolError && enrolError.intent === "totp-confirm" && !enrolError.fields ? enrolError.message : undefined)}
                    className="max-w-[16rem]"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Key type="submit" variant="ink" loading={busy && enrol.formData?.get("intent") === "totp-confirm"}>
                      {t("me.twoStep.confirm")}
                    </Key>
                    <Key disabled={busy} onClick={() => setRound((value) => value + 1)}>
                      {t("me.twoStep.restart")}
                    </Key>
                  </div>
                </enrol.Form>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="adm-card">
          <p className="type-body text-ink">{t("me.twoStep.onText")}</p>
          {recoveryCodesLeft !== null ? (
            <p className="type-body text-ink">
              {t("me.twoStep.recoveryLeft", { count: recoveryCodesLeft })} <span className="text-ink-2">{t("me.twoStep.recoveryHint")}</span>
            </p>
          ) : null}
          <details className="mt-2 grid gap-3">
            <summary className="cursor-pointer type-strong text-ink">{t("me.twoStep.disableTitle")}</summary>
            <disable.Form method="post" className="grid max-w-[24rem] gap-3 pt-3">
              <input type="hidden" name="intent" value="totp-disable" />
              <p className="type-caption text-ink-2">{t("me.twoStep.disableText")}</p>
              <TextField label={t("me.twoStep.password")} name="password" type="password" autoComplete="current-password" required error={disableError?.fields?.password} />
              <TextField label={t("me.twoStep.codeOrRecovery")} name="code" autoComplete="one-time-code" required ltr error={disableError?.fields?.code} />
              {disableError && !disableError.fields ? (
                <p className="type-body text-red-ink" role="alert">
                  {disableError.message ?? t("me.saveFailed")}
                </p>
              ) : null}
              <div>
                <Key type="submit" className="enabled:[--on:var(--red-ink)]" loading={disable.state !== "idle"}>
                  {t("me.twoStep.disable")}
                </Key>
              </div>
            </disable.Form>
          </details>
        </div>
      )}
    </section>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useAdminT();
  const [saved, setSaved] = useState(false);
  const textFile = `${t("me.twoStep.fileTitle")}\n\n${codes.join("\n")}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success(t("me.twoStep.copied"));
    } catch {
      toast.error(t("me.saveFailed"));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([textFile], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tamtam-admin-recovery-codes.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="adm-card adm-card--act" role="region" aria-labelledby="recovery-title">
      <h3 id="recovery-title" className="adm-h3">
        {t("me.twoStep.codesTitle")}
      </h3>
      <p className="type-body text-ink">{t("me.twoStep.codesText")}</p>
      <ol className="adm-codes" dir="ltr">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Key size="sm" icon="copy" onClick={copy}>
          {t("me.twoStep.copy")}
        </Key>
        <Key size="sm" icon="download-simple" onClick={download}>
          {t("me.twoStep.download")}
        </Key>
      </div>
      <Checkbox label={t("me.twoStep.saved")} checked={saved} onChange={(event) => setSaved(event.target.checked)} />
      <div>
        <Key variant="ink" size="sm" disabled={!saved} onClick={onDone}>
          {t("me.twoStep.done")}
        </Key>
      </div>
    </div>
  );
}

/* ───────────────────────────── password ───────────────────────────── */

function PasswordForm() {
  const t = useAdminT();
  const fetcher = useFetcher<MeActionResult>({ key: "me-password" });
  const form = useRef<HTMLFormElement | null>(null);
  const error = failed(fetcher.data);
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "password") {
      form.current?.reset();
      toast.success(t("me.password.changed"));
    }
  }, [fetcher.data, t]);
  return (
    <section className="adm-section" aria-labelledby="me-password">
      <h2 id="me-password" className="adm-h2">
        {t("me.password.title")}
      </h2>
      <fetcher.Form ref={form} method="post" className="adm-card grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="intent" value="password" />
        <TextField className="sm:col-span-2 sm:max-w-[calc(50%-var(--s-2))]" label={t("me.password.current")} name="currentPassword" type="password" autoComplete="current-password" required error={error?.fields?.currentPassword} />
        <TextField label={t("me.password.next")} hint={t("me.password.nextHint")} name="newPassword" type="password" autoComplete="new-password" required error={error?.fields?.newPassword} />
        <TextField label={t("me.password.confirm")} name="confirmPassword" type="password" autoComplete="new-password" required error={error?.fields?.confirmPassword} />
        {error && !error.fields ? (
          <p className="type-body text-red-ink sm:col-span-2" role="alert">
            {error.message ?? t("me.saveFailed")}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Key type="submit" variant="ink" loading={fetcher.state !== "idle"}>
            {t("me.password.submit")}
          </Key>
        </div>
      </fetcher.Form>
    </section>
  );
}

/* ───────────────────────────── sessions ───────────────────────────── */

function deviceName(session: MySession, unknown: string): string {
  const parts = [session.device.browser, session.device.system].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : unknown;
}

function Sessions({ sessions, now }: { sessions: MySession[]; now: number }) {
  const t = useAdminT();
  const f = useFormat();
  const fetcher = useFetcher<MeActionResult>({ key: "me-sessions" });
  const others = sessions.filter((session) => !session.current);
  const pendingId = fetcher.state !== "idle" ? fetcher.formData?.get("sessionId") : null;
  const pendingAll = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "revoke-others";
  useEffect(() => {
    const result = fetcher.data;
    if (!result?.ok) return;
    if (result.intent === "revoke") toast.success(result.ended ? t("me.sessions.ended") : t("me.sessions.alreadyEnded"));
    if (result.intent === "revoke-others") toast.success(t("me.sessions.endedOthers"));
  }, [fetcher.data, t]);

  return (
    <section className="adm-section" aria-labelledby="me-sessions">
      <div className="adm-section__head">
        <h2 id="me-sessions" className="adm-h2">
          {t("me.sessions.title")}
        </h2>
        {others.length > 0 ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revoke-others" />
            <Key type="submit" size="sm" icon="sign-out" loading={pendingAll}>
              {t("me.sessions.endOthers")}
            </Key>
          </fetcher.Form>
        ) : null}
      </div>
      <p className="max-w-[65ch] type-caption text-ink-2">{t("me.sessions.lead")}</p>
      <ul className="adm-fn-list" aria-label={t("me.sessions.caption")}>
        {sessions.map((session) => {
          const name = deviceName(session, t("me.sessions.unknownDevice"));
          return (
            <li key={session.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line p-3">
              <Icon name={session.device.system === "iPhone" || session.device.system === "Android" ? "device-mobile" : "desktop"} size={22} className="text-ink-2" />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="flex flex-wrap items-center gap-2 type-strong">
                  <bdi>{name}</bdi>
                  {session.current ? <Status tone="ok">{t("me.sessions.thisDevice")}</Status> : null}
                  {session.pendingCode ? <Status tone="warn">{t("me.sessions.pendingCode")}</Status> : null}
                </p>
                <p className="type-caption text-ink-2">
                  {t("me.sessions.address")}: <bdi dir="ltr">{session.ip ?? t("me.sessions.noAddress")}</bdi>
                  {" · "}
                  {t("me.sessions.started")}: <span className="nums">{f.dateTime(session.createdAt)}</span>
                  {" · "}
                  {t("me.sessions.lastSeen")}: <span className="nums">{f.relative(session.lastSeenAt, now)}</span>
                </p>
              </div>
              {session.current ? null : (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="sessionId" value={session.id} />
                  <Key type="submit" size="sm" aria-label={t("me.sessions.endNamed", { device: name })} loading={pendingId === session.id}>
                    {t("me.sessions.end")}
                  </Key>
                </fetcher.Form>
              )}
            </li>
          );
        })}
      </ul>
      {others.length === 0 ? <p className="type-caption text-ink-2">{t("me.sessions.onlyThis")}</p> : null}
    </section>
  );
}
