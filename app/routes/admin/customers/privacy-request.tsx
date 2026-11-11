import { useRef, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/privacy-request";
import { throwAsResponse } from "~/server/errors";
import { getPrivacyRequest, type PrivacyRequestDetail } from "~/server/services/admin/customers/privacy.server";
import { CONSENT_KIND_LIST, RETENTION, VERIFY_METHODS } from "~/server/services/admin/customers/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { privacyRequestAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { activityLabel, Facts, Failure, Money, Notice, Num, PhoneText, PrivacyStatusBadge, Ref, Section, useCustomersT, useIntent, usePrintInLight, When } from "./ui";

/**
 * /admin/customers/privacy/:ref — one privacy request (07.04): who asked, what, by when; verification (how the person
 * was confirmed to be the account holder, with a note); then the work of its kind — the export file (downloaded and
 * audited each time), the erasure plan with what is erased, what is kept and what stands in the way (confirmed with a
 * reason; ledgers and order history are never deleted), the withdrawals of an unsubscribe — and the request's history.
 * The page prints as a record of the request (browser print).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.privacy.manage");
  try {
    return { request: await getPrivacyRequest(db, actor, params.ref, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await privacyRequestAction(req.ctx, req.db, req.session, params.ref, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, null, undefined, args.loaderData?.request.ref ?? null);

export default function PrivacyRequestPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { request } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  return (
    <div ref={sheet} className="cus-print grid gap-5">
      <header className="adm-page-head">
        <p className="adm-eyebrow cus-noprint">
          <Link to="/admin/customers/privacy" className="adm-link">
            {t("privacyRequest.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <Ref value={request.ref} />
          <span>{t(`privacy.kind.${request.kind}`)}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <PrivacyStatusBadge status={request.status} />
          <span className={request.overdue ? "type-caption text-red-ink" : "type-caption text-ink-2"}>
            {t("privacy.col.due")}: {request.dueAt ? <When at={request.dueAt} style="date" /> : "—"}
            {request.overdue ? ` · ${t("privacy.overdue")}` : ""}
          </span>
          <Key size="sm" icon="printer" className="cus-noprint" onClick={() => window.print()}>
            {t("privacyRequest.print")}
          </Key>
        </div>
      </header>
      <div className="cus-layout">
        <div className="cus-main">
          <Section id="request-facts" title={t("privacyRequest.facts")}>
            <Facts
              rows={[
                {
                  label: t("privacy.col.customer"),
                  value: request.customer ? (
                    <Link to={`/admin/customers/${encodeURIComponent(request.customer.id)}`} className="adm-link">
                      {request.customer.status === "deleted" ? t("customer.erasedTitle") : (request.customer.name ?? t("list.noName"))}
                    </Link>
                  ) : (
                    t("privacy.noAccount")
                  ),
                },
                { label: t("privacyRequest.phone"), value: <PhoneText phone={request.phone} /> },
                { label: t("privacyRequest.opened"), value: <When at={request.createdAt} /> },
                { label: t("privacy.col.verified"), value: request.verifiedAt ? <><When at={request.verifiedAt} /> · {request.verifyMethod ? t(`verifyMethod.${request.verifyMethod}`) : ""}</> : t("privacy.notVerified") },
                { label: t("privacyRequest.handledBy"), value: request.handledBy ?? "—" },
                { label: t("privacyRequest.completed"), value: request.completedAt ? <When at={request.completedAt} /> : "—" },
              ]}
            />
            {request.details ? (
              <div className="grid gap-1">
                <p className="type-caption text-ink-2">{t("privacy.form.details")}</p>
                <p className="cus-quote">{request.details}</p>
              </div>
            ) : null}
            {request.resolutionNote ? (
              <div className="grid gap-1">
                <p className="type-caption text-ink-2">{t("privacyRequest.resolution")}</p>
                <p className="cus-quote">{request.resolutionNote}</p>
              </div>
            ) : null}
          </Section>

          {request.kind === "export" ? <ExportSection request={request} /> : null}
          {request.kind === "delete" ? <ErasureSection request={request} /> : null}
          {request.kind === "unsubscribe" && request.can.unsubscribe ? <UnsubscribeSection request={request} /> : null}
          {request.kind === "rectify" && request.customer && request.can.complete ? (
            <Section id="request-rectify" title={t("privacyRequest.rectifyTitle")}>
              <p className="type-body">{t("privacyRequest.rectifyLead")}</p>
              <div className="cus-noprint">
                <Key as={Link} to={`/admin/customers/${encodeURIComponent(request.customer.id)}/contact`} size="sm" iconEnd="arrow-right">
                  {t("privacyRequest.rectifyOpen")}
                </Key>
              </div>
            </Section>
          ) : null}

          <Section id="request-history" title={t("privacyRequest.history")}>
            {request.history.length === 0 ? (
              <p className="type-body text-ink-2">—</p>
            ) : (
              <ol className="cus-timeline">
                {request.history.map((event) => (
                  <li key={event.id} data-actor="employee">
                    <span className="type-body">
                      {activityLabel(t, event.action)} — {event.by ?? t("actor.employee")}
                      {event.method ? ` · ${t(`verifyMethod.${event.method}`)}` : ""}
                    </span>
                    <span className="type-caption text-ink-2">
                      <When at={event.at} />
                    </span>
                    {event.reason ? <span className="cus-quote type-caption">{event.reason}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
        <aside className="cus-side cus-noprint" aria-label={t("privacyRequest.side")}>
          <ActionsSection request={request} />
        </aside>
      </div>
    </div>
  );
}

type Props = { request: PrivacyRequestDetail };

function ActionsSection({ request }: Props) {
  const t = useCustomersT();
  const { can } = request;
  if (!can.verify && !can.reject && !can.complete) {
    return (
      <Section id="request-actions" title={t("privacyRequest.actions")}>
        <p className="type-body text-ink-2">{request.status === "completed" || request.status === "rejected" ? t("privacyRequest.closed") : t("privacyRequest.nothingNow")}</p>
      </Section>
    );
  }
  return (
    <Section id="request-actions" title={t("privacyRequest.actions")}>
      {can.verify ? <VerifyBox request={request} /> : null}
      <div className="cus-actions">
        {can.complete ? <CompleteButton request={request} /> : null}
        {can.reject ? <RejectButton request={request} /> : null}
      </div>
      {!request.verifiedAt ? <Notice icon="lock">{t("privacyRequest.verifyFirst")}</Notice> : null}
    </Section>
  );
}

function VerifyBox({ request }: Props) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<string>(VERIFY_METHODS[0]);
  const { fetcher, pending, message } = useIntent("verify", "done.verified", () => setOpen(false));
  return (
    <div className="grid gap-2">
      <Select name="method" label={t("privacyRequest.method")} value={method} onChange={(event) => setMethod(event.currentTarget.value)} options={VERIFY_METHODS.map((value) => ({ value, label: t(`verifyMethod.${value}`) }))} />
      <p className="type-caption text-ink-2">{t(`verifyMethodHint.${method}`)}</p>
      <div>
        <Key size="sm" variant="ink" icon="seal-check" onClick={() => setOpen(true)}>
          {t("privacyRequest.verify")}
        </Key>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("privacyRequest.verifyQ", { ref: request.ref })}
        consequence={t("privacyRequest.verifyWhat", { method: t(`verifyMethod.${method}`) })}
        confirmLabel={t("privacyRequest.verify")}
        reason={{ label: t("privacyRequest.verifyNote"), hint: t("privacyRequest.verifyNoteHint"), minLength: 3 }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "verify", method, note: reason }, { method: "post" })}
      />
    </div>
  );
}

function RejectButton({ request }: Props) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("reject", "done.rejected", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="x-circle" className="enabled:[--on:var(--red-ink)]" onClick={() => setOpen(true)}>
        {t("privacyRequest.reject")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("privacyRequest.rejectQ", { ref: request.ref })}
        consequence={t("privacyRequest.rejectWhat")}
        confirmLabel={t("privacyRequest.reject")}
        reason={{ label: t("dialog.reason"), hint: t("privacyRequest.rejectHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "reject", note: reason }, { method: "post" })}
      />
    </>
  );
}

function CompleteButton({ request }: Props) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("complete", "done.completed", () => setOpen(false));
  const needsExport = request.kind === "export" && request.exports.length === 0;
  return (
    <>
      <Key size="sm" icon="check-circle" disabled={needsExport} aria-describedby={needsExport ? "complete-why" : undefined} onClick={() => setOpen(true)}>
        {t("privacyRequest.complete")}
      </Key>
      {needsExport ? (
        <span id="complete-why" className="type-caption text-ink-2">
          {t("privacyRequest.exportFirst")}
        </span>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("privacyRequest.completeQ", { ref: request.ref })}
        consequence={t(request.kind === "export" ? "privacyRequest.completeExportWhat" : "privacyRequest.completeRectifyWhat")}
        confirmLabel={t("privacyRequest.complete")}
        reason={{ label: t("privacyRequest.completeNote"), hint: t("privacyRequest.completeNoteHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "complete", note: reason }, { method: "post" })}
      />
    </>
  );
}

function ExportSection({ request }: Props) {
  const t = useCustomersT();
  return (
    <Section id="request-export" title={t("privacyRequest.exportTitle")}>
      <p className="type-body">{t("privacyRequest.exportLead")}</p>
      {request.can.export ? (
        <div className="cus-noprint">
          <Key as="a" href={`/admin/customers/privacy/${request.ref}/export`} size="sm" icon="download-simple" download>
            {t("privacyRequest.download")}
          </Key>
        </div>
      ) : (
        <Notice icon="lock">{request.verifiedAt ? t("privacyRequest.exportClosed") : t("privacyRequest.verifyFirst")}</Notice>
      )}
      {request.exports.length ? (
        <ul className="cus-rows">
          {request.exports.map((download, index) => (
            <li key={index} className="cus-row">
              <span className="type-body">
                {download.by ?? t("actor.employee")} · <When at={download.at} />
              </span>
              <span className="type-caption text-ink-2">
                {download.bytes !== null ? (
                  <>
                    <Num value={download.bytes} /> {t("privacyRequest.bytes")}
                  </>
                ) : null}
                {download.sha256 ? (
                  <>
                    {" · "}
                    <Ref value={download.sha256.slice(0, 16)} />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-caption text-ink-2">{t("privacyRequest.noDownloads")}</p>
      )}
      <Notice>{t("privacyRequest.exportBoundary")}</Notice>
    </Section>
  );
}

function ErasureSection({ request }: Props) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("erase", "done.erased", () => setOpen(false));
  const plan = request.erasure;
  if (!plan) {
    return (
      <Section id="request-erasure" title={t("privacyRequest.erasureTitle")}>
        <p className="type-body text-ink-2">{request.status === "completed" ? t("privacyRequest.erasureDone") : t("privacyRequest.erasureNoAccount")}</p>
      </Section>
    );
  }
  return (
    <Section id="request-erasure" title={t("privacyRequest.erasureTitle")}>
      <p className="type-body">{t("privacyRequest.erasureLead")}</p>
      {plan.blockers.length ? (
        <div className="grid gap-1" role="alert">
          <p className="type-strong text-red-ink">{t("privacyRequest.blockedTitle")}</p>
          <ul className="grid gap-1">
            {plan.blockers.map((blocker) => (
              <li key={blocker.code} className="type-body">
                {blocker.code === "wallet_balance" && blocker.amountIqd === undefined ? (
                  t("erasureBlocker.wallet_balance_hidden")
                ) : (
                  <>
                    {t(`erasureBlocker.${blocker.code}`, { count: blocker.count })} {blocker.amountIqd !== undefined ? <Money iqd={blocker.amountIqd} /> : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <div className="grid content-start gap-2">
          <h3 className="adm-h3">{t("privacyRequest.erased")}</h3>
          <dl className="cus-ledger">
            {RETENTION.erased.map((part) => (
              <div key={part}>
                <dt>{t(`erasedPart.${part}`)}</dt>
                <dd>
                  <Num value={plan.erased[part]} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="grid content-start gap-2">
          <h3 className="adm-h3">{t("privacyRequest.kept")}</h3>
          <dl className="cus-ledger">
            {RETENTION.kept.map((part) => (
              <div key={part}>
                <dt>{t(`keptPart.${part}`)}</dt>
                <dd>
                  <Num value={plan.kept[part]} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="type-caption text-ink-2">{t("privacyRequest.keptWhy")}</p>
        </div>
      </div>
      {request.can.erase ? (
        <div className="cus-noprint">
          <Key icon="trash" className="enabled:[--on:var(--red-ink)]" onClick={() => setOpen(true)}>
            {t("privacyRequest.erase")}
          </Key>
        </div>
      ) : !request.verifiedAt ? (
        <Notice icon="lock">{t("privacyRequest.verifyFirst")}</Notice>
      ) : null}
      <Failure message={!open ? message : null} />
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("privacyRequest.eraseQ")}
        consequence={t("privacyRequest.eraseWhat")}
        confirmLabel={t("privacyRequest.erase")}
        impact={[
          { label: t("erasedPart.addresses"), value: t("privacyRequest.impactRemoved", { count: plan.erased.addresses }), negative: plan.erased.addresses > 0 },
          { label: t("erasedPart.profile"), value: t("privacyRequest.impactAnonymized") },
          ...(plan.erased.mergedAccounts > 0 ? [{ label: t("erasedPart.mergedAccounts"), value: t("privacyRequest.impactAnonymized") }] : []),
          { label: t("keptPart.orders"), value: t("privacyRequest.impactKept", { count: plan.kept.orders }) },
          { label: t("keptPart.wallet"), value: t("privacyRequest.impactKept", { count: plan.kept.wallet }) },
        ]}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "erase", reason }, { method: "post" })}
      />
    </Section>
  );
}

function UnsubscribeSection({ request }: Props) {
  const t = useCustomersT();
  const [kinds, setKinds] = useState<string[]>(["marketing"]);
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("unsubscribe", "done.unsubscribed", () => setOpen(false));
  return (
    <Section id="request-unsubscribe" title={t("privacyRequest.unsubscribeTitle")}>
      <FieldGroup legend={t("privacyRequest.unsubscribeLegend")} hint={t("privacyRequest.unsubscribeHint")}>
        {CONSENT_KIND_LIST.map((kind) => (
          <Checkbox
            key={kind}
            name="kind"
            value={kind}
            label={t(`consentKind.${kind}`)}
            checked={kinds.includes(kind)}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setKinds((current) => (on ? [...new Set([...current, kind])] : current.filter((value) => value !== kind)));
            }}
          />
        ))}
      </FieldGroup>
      <div className="cus-noprint">
        <Key size="sm" variant="ink" disabled={kinds.length === 0} onClick={() => setOpen(true)}>
          {t("privacyRequest.unsubscribe")}
        </Key>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("privacyRequest.unsubscribeQ")}
        consequence={t("privacyRequest.unsubscribeWhat", { kinds: kinds.map((kind) => t(`consentKind.${kind}`)).join("، ") })}
        confirmLabel={t("privacyRequest.unsubscribe")}
        reason={{ label: t("privacyRequest.completeNote"), hint: t("privacyRequest.completeNoteHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => {
          const form = new FormData();
          form.set("intent", "unsubscribe");
          form.set("note", reason);
          for (const kind of kinds) form.append("kind", kind);
          fetcher.submit(form, { method: "post" });
        }}
      />
    </Section>
  );
}
