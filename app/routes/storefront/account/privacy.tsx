import { useEffect, useRef, useState } from "react";
import { data, useFetcher, useRevalidator } from "react-router";

import type { Route } from "./+types/privacy";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { newId } from "~/lib/ids";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { fileOwnPrivacyRequest, listOwnPrivacyRequests, type OwnPrivacyKind, type OwnPrivacyRequest } from "~/server/services/account/privacy.server";
import { FieldGroup, OptionCard, TextArea } from "~/ui/Field";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { fieldError, FormFailure, Notice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { ltr } from "./components/text";

/**
 * Privacy and your data (`/account/privacy`) — module 07's privacy requests, filed by the customer for their own
 * account (account/privacy.server): a copy of their data, a correction, or the deletion of the account. Nothing happens
 * by itself: a staff member confirms who the person is first (module 07 verifies, then carries it out under the
 * retention rules). Rate-limited; one open request per kind. Stopping messages is the settings page's switches.
 */
export const handle = { nav: "push", order: sectionOrder("privacy") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  // one key per visit: the same form sent twice opens one request
  return { requests: await listOwnPrivacyRequests(db, customer.id), attempt: newId("prv") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    const filed = await fileOwnPrivacyRequest(db, actor, { kind: fields.kind, details: fields.details, attempt: fields.attempt }, ctx.now);
    return data({ ok: true as const, ref: filed.ref, replayed: filed.replayed });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data(failure, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "privacy");

const STATUS_TONE: Record<OwnPrivacyRequest["status"], StatusTone> = { open: "info", verifying: "warn", in_progress: "warn", completed: "ok", rejected: "neutral" };

/** The service's OWN_PRIVACY_KINDS, spelled here: a `.server` module's values never reach the browser (the type keeps them equal). */
const KINDS = ["export", "rectify", "delete"] as const satisfies readonly OwnPrivacyKind[];

export default function Privacy({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [kind, setKind] = useState<OwnPrivacyKind>("export");
  const handled = useRef<unknown>(null);
  // a fetcher answers with script; without it the form posts as a document and the page answers with actionData
  const answer = (fetcher.data ?? actionData ?? null) as (ActionAnswer & { ref?: string }) | null;
  const failed = answer && answer.ok === false ? answer : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok) toast.success(t("privacy.sent", { ref: ltr(String(answer.ref ?? "")) }));
    else void revalidator.revalidate();
  }, [fetcher.state, answer, t, revalidator]);

  return (
    <>
      <PageHead title={t("privacy.title")} lead={t("privacy.lead")} />
      {actionData?.ok && !fetcher.data ? (
        <Notice tone="ok">
          <p>{t("privacy.sent", { ref: ltr(String(actionData.ref ?? "")) })}</p>
        </Notice>
      ) : null}
      <fetcher.Form method="post" className="acct-card acct-narrow" noValidate>
        <input type="hidden" name="attempt" value={loaderData.attempt} />
        <FormFailure
          answer={failed}
          fields={[
            { name: "kind", id: "privacy-kind", label: t("privacy.kindLegend") },
            { name: "details", id: "privacy-details", label: t("privacy.details") },
          ]}
        />
        <FieldGroup legend={t("privacy.kindLegend")} required error={fieldError(failed, "kind")}>
          {KINDS.map((value, index) => (
            <OptionCard key={value} id={index === 0 ? "privacy-kind" : undefined} name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} label={t(`privacy.kinds.${value}`)} hint={t(`privacy.kindHints.${value}`)} />
          ))}
        </FieldGroup>
        <TextArea id="privacy-details" name="details" rows={3} maxLength={1000} label={t("privacy.details")} hint={t("privacy.detailsHint")} optional={kind !== "rectify"} required={kind === "rectify"} error={fieldError(failed, "details")} />
        <SubmitKey variant="primary" pending={fetcher.state !== "idle"} icon="paper-plane-tilt">
          {t("privacy.submit")}
        </SubmitKey>
      </fetcher.Form>
      <Notice>
        <p>
          {t("privacy.unsubscribeNote")}{" "}
          <TextLink as={LocaleLink} to="/account/settings" inline>
            {t("privacy.settings")}
          </TextLink>
        </p>
      </Notice>

      <Section id="privacy-requests" title={t("privacy.listTitle")}>
        {loaderData.requests.length === 0 ? (
          <p className="type-sm text-ink-2">{t("privacy.listEmpty")}</p>
        ) : (
          <ul className="acct-rows">
            {loaderData.requests.map((request) => (
              <li key={request.ref} className="acct-row">
                <div className="acct-row__body">
                  <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="flex flex-wrap items-center gap-x-2">
                      <bdi dir="ltr" className="acct-row__title nums">
                        {request.ref}
                      </bdi>
                      <span className="acct-row__meta">{t(`privacy.kinds.${request.kind}`)}</span>
                    </span>
                    <Status tone={STATUS_TONE[request.status]}>{t(`privacy.status.${request.status}`)}</Status>
                  </p>
                  <p className="acct-row__meta">
                    {f.date(request.createdAt, "medium")}
                    {request.completedAt !== null ? <> · {t("privacy.done", { date: f.date(request.completedAt, "medium") })}</> : request.dueAt !== null && request.status !== "rejected" ? <> · {t("privacy.due", { date: f.date(request.dueAt, "medium") })}</> : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
