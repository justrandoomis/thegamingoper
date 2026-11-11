import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/customer-privacy";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { customerConsentHistory, customerPrivacyRequests } from "~/server/services/admin/customers/privacy.server";
import { customerById } from "~/server/services/admin/customers/shared.server";
import { PRIVACY_DUE_DAYS, PRIVACY_KIND_LIST, type ConsentState } from "~/server/services/admin/customers/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Select, TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { customerPrivacyAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { Failure, newKey, Notice, PrivacyStatusBadge, Ref, Section, sourceLabel, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/:customerId/privacy — 07.04 for one customer: each consent's current answer and its whole history
 * (append-only: staff never change or delete an answer), recording a withdrawal the customer asked for (never a
 * grant), and the customer's privacy requests with a form to open one on their behalf.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, ["customers.consent.read", "customers.privacy.manage"]);
  try {
    const row = await customerById(db, params.customerId);
    const [consents, requests] = await Promise.all([
      can(actor, "customers.consent.read") ? customerConsentHistory(db, actor, row.id) : Promise.resolve(null),
      can(actor, "customers.privacy.manage") ? customerPrivacyRequests(db, actor, row.id, now) : Promise.resolve(null),
    ]);
    return { consents, requests, canManage: can(actor, "customers.privacy.manage"), changeable: row.status === "active" || row.status === "blocked" };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await customerPrivacyAction(req.ctx, req.db, req.session, params.customerId, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "customerPrivacy.title");

export default function CustomerPrivacyPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { consents, requests, canManage, changeable } = loaderData;
  return (
    <div className="cus-layout">
      <div className="cus-main">
        {consents ? (
          <>
            <Section id="consents-now" title={t("customerPrivacy.current")}>
              <ul className="cus-rows">
                {consents.current.map((state) => (
                  <ConsentRow key={state.kind} state={state} canWithdraw={canManage && changeable} />
                ))}
              </ul>
              <Notice>{t("customerPrivacy.appendOnly")}</Notice>
            </Section>
            <Section id="consents-history" title={t("customerPrivacy.history", { count: consents.history.length })}>
              {consents.history.length === 0 ? (
                <p className="type-body text-ink-2">{t("customerPrivacy.noHistory")}</p>
              ) : (
                <ol className="cus-timeline">
                  {consents.history.map((entry) => (
                    <li key={entry.id} data-actor={entry.source === "admin" || entry.source === "privacy_request" || entry.source === "erasure" || entry.source === "merge" ? "employee" : "customer"}>
                      <span className="type-body">
                        {t(`consentKind.${entry.kind}`)}: {t(entry.granted ? "consent.granted" : "consent.withdrawn")}
                      </span>
                      <span className="type-caption text-ink-2">
                        <When at={entry.at} /> · {t("consentLog.source")}: {sourceLabel(t, entry.source)}
                        {entry.policyVersion ? (
                          <>
                            {" · "}
                            {t("consentLog.policy")} <Ref value={entry.policyVersion} />
                          </>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        ) : null}
      </div>
      <aside className="cus-side" aria-label={t("customerPrivacy.side")}>
        {requests ? <RequestsSection requests={requests} canCreate={canManage && changeable} /> : null}
      </aside>
    </div>
  );
}

function ConsentRow({ state, canWithdraw }: { state: ConsentState; canWithdraw: boolean }) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("withdraw", "done.withdrawn", () => setOpen(false));
  return (
    <li className="cus-row">
      <span className="grid min-w-0">
        <span className="type-strong">{t(`consentKind.${state.kind}`)}</span>
        <span className="type-caption text-ink-2">{t(`consentKindHint.${state.kind}`)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Status tone={state.granted === true ? "ok" : "neutral"}>{t(state.granted === true ? "consent.granted" : state.granted === false ? "consent.withdrawn" : "consent.never")}</Status>
        {state.at ? (
          <span className="type-caption text-ink-2">
            <When at={state.at} style="date" />
          </span>
        ) : null}
        {canWithdraw && state.granted !== false ? (
          <Key size="sm" onClick={() => setOpen(true)}>
            {t("customerPrivacy.withdraw")}
          </Key>
        ) : null}
      </span>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("customerPrivacy.withdrawQ", { kind: t(`consentKind.${state.kind}`) })}
        consequence={t("customerPrivacy.withdrawWhat")}
        confirmLabel={t("customerPrivacy.withdraw")}
        reason={{ label: t("dialog.reason"), hint: t("customerPrivacy.withdrawHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "withdraw", kind: state.kind, reason }, { method: "post" })}
      />
    </li>
  );
}

function RequestsSection({ requests, canCreate }: { requests: NonNullable<Route.ComponentProps["loaderData"]["requests"]>; canCreate: boolean }) {
  const t = useCustomersT();
  const [kind, setKind] = useState<string>("export");
  const [details, setDetails] = useState("");
  const key = useMemo(() => newKey(), []);
  const [formKey, setFormKey] = useState(key);
  const { fetcher, pending, message, fields } = useIntent("request", "done.requestOpened", () => {
    setDetails("");
    setFormKey(newKey());
  });
  const opened = fetcher.data && fetcher.data.ok && fetcher.data.intent === "request" ? String((fetcher.data as { ref?: string }).ref ?? "") : "";
  return (
    <Section id="customer-requests" title={t("customerPrivacy.requests")}>
      {requests.length === 0 ? (
        <p className="type-body text-ink-2">{t("customerPrivacy.noRequests")}</p>
      ) : (
        <ul className="cus-rows">
          {requests.map((request) => (
            <li key={request.id} className="cus-row">
              <span className="grid min-w-0">
                <Link to={`/admin/customers/privacy/${request.ref}`} className="adm-link">
                  <Ref value={request.ref} /> · {t(`privacy.kind.${request.kind}`)}
                </Link>
                <span className="type-caption text-ink-2">
                  <When at={request.createdAt} style="date" />
                </span>
              </span>
              <PrivacyStatusBadge status={request.status} />
            </li>
          ))}
        </ul>
      )}
      {canCreate ? (
        <fetcher.Form method="post" className="grid gap-3">
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="idempotencyKey" value={formKey} />
          <Select name="kind" label={t("privacy.form.kind")} value={kind} onChange={(event) => setKind(event.currentTarget.value)} options={PRIVACY_KIND_LIST.map((value) => ({ value, label: t(`privacy.kind.${value}`) }))} />
          <p className="type-caption text-ink-2">{t(`privacy.kindHint.${kind}`)}</p>
          <TextArea name="details" label={t("privacy.form.details")} hint={t("privacy.form.detailsHint")} value={details} onChange={(event) => setDetails(event.currentTarget.value)} rows={3} maxLength={1000} error={fields.details} />
          <Failure message={message} />
          {opened ? (
            <p className="type-body" role="status">
              {t("privacy.form.opened")}{" "}
              <Link to={`/admin/customers/privacy/${opened}`} className="adm-link">
                <Ref value={opened} />
              </Link>
            </p>
          ) : null}
          <div>
            <Key type="submit" size="sm" icon="shield-check" loading={pending}>
              {t("privacy.form.open")}
            </Key>
          </div>
          <p className="type-caption text-ink-2">{t("privacy.form.due", { days: PRIVACY_DUE_DAYS })}</p>
        </fetcher.Form>
      ) : null}
    </Section>
  );
}

