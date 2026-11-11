import { useState } from "react";
import { Form, Link, useNavigate } from "react-router";

import type { Route } from "./+types/customer-merge";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { listCustomers } from "~/server/services/admin/customers/list.server";
import { duplicateCandidates, planMerge, type MergePlan, type MergeSide } from "~/server/services/admin/customers/merge.server";
import { customerById, ID } from "~/server/services/admin/customers/shared.server";
import { MERGE_VERIFY_METHODS, parseCustomerFilters, searchText } from "~/server/services/admin/customers/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { mergeAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { CustomerStatusBadge, Failure, FlagTags, Money, Notice, Num, PhoneText, Section, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/:customerId/merge?with=<id> — 07.05: fold a duplicate account into this one. Candidates come with
 * the reason they look like the same person; the plan shows what moves, what stays (the wallet never moves) and what
 * stands in the way, before anyone confirms; the merge needs how staff verified it is the same person, a note and a
 * reason (audited, with the moved order references).
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.customer.merge");
  const url = new URL(request.url);
  const withId = url.searchParams.get("with");
  const q = searchText(url.searchParams.get("q"));
  try {
    const keep = await customerById(db, params.customerId);
    const [candidates, plan, found] = await Promise.all([
      duplicateCandidates(db, actor, keep.id),
      withId && ID.test(withId) && withId !== keep.id ? planMerge(db, actor, { keepId: keep.id, mergeId: withId }, now) : Promise.resolve(null),
      q ? listCustomers(db, actor, { ...parseCustomerFilters(new URLSearchParams()), q }, now) : Promise.resolve(null),
    ]);
    return { keepId: keep.id, candidates, plan, q, found: found ? found.rows.filter((row) => row.id !== keep.id).slice(0, 10) : null };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await mergeAction(req.ctx, req.db, req.session, params.customerId, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "merge.title");

export default function CustomerMergePage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { keepId, candidates, plan, q, found } = loaderData;
  const base = `/admin/customers/${encodeURIComponent(keepId)}/merge`;
  return (
    <div className="grid gap-6">
      <p className="max-w-[70ch] type-body text-ink-2">{t("merge.lead")}</p>
      {plan ? (
        <PlanSection plan={plan} base={base} />
      ) : (
        <>
          <Section id="merge-candidates" title={t("merge.candidates")}>
            {candidates.length === 0 ? (
              <p className="type-body text-ink-2">{t("merge.noCandidates")}</p>
            ) : (
              <ul className="cus-rows">
                {candidates.map((candidate) => (
                  <li key={candidate.customer.id} className="cus-row">
                    <span className="grid min-w-0">
                      <span className="type-strong">{candidate.customer.name ?? t("list.noName")}</span>
                      <span className="type-caption text-ink-2">
                        <PhoneText phone={candidate.customer.phone} /> · {candidate.reasons.map((reason) => t(`duplicateReason.${reason}`)).join(" · ")}
                      </span>
                    </span>
                    <Key as={Link} to={`${base}?with=${encodeURIComponent(candidate.customer.id)}`} size="sm" iconEnd="arrow-right">
                      {t("merge.review")}
                    </Key>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section id="merge-search" title={t("merge.searchTitle")}>
            <Form method="get" action={base} className="flex flex-wrap items-end gap-2">
              <TextField name="q" type="search" label={t("merge.search")} hint={t("list.searchHint")} defaultValue={q} maxLength={40} />
              <Key type="submit" size="sm" icon="magnifying-glass">
                {t("merge.find")}
              </Key>
            </Form>
            {found ? (
              found.length === 0 ? (
                <p className="type-body text-ink-2">{t("merge.notFound")}</p>
              ) : (
                <ul className="cus-rows">
                  {found.map((row) => (
                    <li key={row.id} className="cus-row">
                      <span className="grid min-w-0">
                        <span className="type-strong">{row.name ?? t("list.noName")}</span>
                        <span className="type-caption text-ink-2">
                          <PhoneText phone={row.phone} /> · {t("list.purchases", { count: row.purchases })}
                        </span>
                      </span>
                      <Key as={Link} to={`${base}?with=${encodeURIComponent(row.id)}`} size="sm" iconEnd="arrow-right">
                        {t("merge.review")}
                      </Key>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </Section>
        </>
      )}
    </div>
  );
}

function SidePanel({ side, role }: { side: MergeSide; role: "keep" | "merge" }) {
  const t = useCustomersT();
  return (
    <div className="cus-panel" data-role={role}>
      <p className="type-caption text-ink-2">{t(role === "keep" ? "merge.keepRole" : "merge.mergeRole")}</p>
      <p className="type-strong">
        <Link to={`/admin/customers/${encodeURIComponent(side.id)}`} className="adm-link">
          {side.name ?? t("list.noName")}
        </Link>
      </p>
      <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
        <PhoneText phone={side.phone} />
        <CustomerStatusBadge status={side.status as never} />
        <FlagTags flags={side.fraudFlag ? [{ id: "risk_manual", vars: {} }] : []} />
      </p>
      <dl className="cus-ledger">
        <div>
          <dt>{t("merge.orders")}</dt>
          <dd>
            <Num value={side.orders} />
          </dd>
        </div>
        <div>
          <dt>{t("merge.spent")}</dt>
          <dd>
            <Money iqd={side.spentIqd} />
          </dd>
        </div>
        <div>
          <dt>{t("merge.wallet")}</dt>
          <dd>
            <Money iqd={side.walletIqd} />
          </dd>
        </div>
        <div>
          <dt>{t("merge.joined")}</dt>
          <dd>
            <When at={side.createdAt} style="date" />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PlanSection({ plan, base }: { plan: MergePlan; base: string }) {
  const t = useCustomersT();
  const f = useFormat();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<string>(MERGE_VERIFY_METHODS[0]);
  const [verification, setVerification] = useState("");
  const { fetcher, pending, message, fields } = useIntent("merge", "done.merged", () => {
    setOpen(false);
    navigate(`/admin/customers/${encodeURIComponent(plan.keep.id)}`);
  });
  const moves = Object.entries(plan.moves).filter(([, count]) => count > 0);
  const blocked = plan.blockers.length > 0;
  const verificationShort = verification.trim().length < 10;
  return (
    <>
      <Section
        id="merge-plan"
        title={t("merge.planTitle")}
        action={
          <Link to={`/admin/customers/${encodeURIComponent(plan.merge.id)}/merge?with=${encodeURIComponent(plan.keep.id)}`} className="adm-link type-caption">
            {t("merge.swap")}
          </Link>
        }
      >
        <div className="cus-compare">
          <SidePanel side={plan.keep} role="keep" />
          <SidePanel side={plan.merge} role="merge" />
        </div>
        {blocked ? (
          <div className="grid gap-2" role="alert">
            <p className="type-strong text-red-ink">{t("merge.blockedTitle")}</p>
            <ul className="grid gap-1">
              {plan.blockers.map((blocker) => (
                <li key={blocker.code} className="type-body">
                  {blocker.code === "wallet_balance" && blocker.amount === undefined
                    ? t("mergeBlocker.wallet_balance_hidden")
                    : t(`mergeBlocker.${blocker.code}`, { count: blocker.count ?? 0, amount: blocker.code === "loyalty_balance" ? f.number(blocker.amount ?? 0) : f.iqd(blocker.amount ?? 0) })}
                </li>
              ))}
            </ul>
            {plan.walletHref ? (
              <div>
                <Key as={Link} to={plan.walletHref} size="sm" iconEnd="arrow-right">
                  {t("merge.openWallet")}
                </Key>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="grid items-start gap-4 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <h3 className="adm-h3">{t("merge.moves")}</h3>
            {moves.length === 0 ? (
              <p className="type-body text-ink-2">{t("merge.nothingMoves")}</p>
            ) : (
              <dl className="cus-ledger">
                {moves.map(([key, count]) => (
                  <div key={key}>
                    <dt>{t(`mergeMove.${key}`)}</dt>
                    <dd>
                      <Num value={count} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div className="grid content-start gap-2">
            <h3 className="adm-h3">{t("merge.stays")}</h3>
            <dl className="cus-ledger">
              {Object.entries(plan.stays).map(([key, count]) => (
                <div key={key}>
                  <dt>{t(`mergeStay.${key}`)}</dt>
                  <dd>
                    <Num value={count} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="type-caption text-ink-2">{t("merge.walletRule")}</p>
            {plan.consentCarry.length ? <p className="type-caption">{t("merge.consentCarry", { kinds: plan.consentCarry.map((kind) => t(`consentKind.${kind}`)).join("، ") })}</p> : <p className="type-caption text-ink-2">{t("merge.consentRule")}</p>}
          </div>
        </div>
      </Section>

      {!blocked ? (
        <Section id="merge-verify" title={t("merge.verifyTitle")}>
          <div className="grid gap-3 md:grid-cols-2">
            <Select name="method" label={t("merge.method")} value={method} onChange={(event) => setMethod(event.currentTarget.value)} options={MERGE_VERIFY_METHODS.map((value) => ({ value, label: t(`mergeMethod.${value}`) }))} error={fields.method} />
            <TextArea name="verification" label={t("merge.verification")} hint={t("merge.verificationHint")} value={verification} onChange={(event) => setVerification(event.currentTarget.value)} rows={3} maxLength={500} error={fields.verification} required />
          </div>
          <Failure message={!open ? message : null} />
          <div className="cus-actions">
            <Key icon="swap" variant="ink" disabled={verificationShort} aria-describedby={verificationShort ? "merge-why" : undefined} onClick={() => setOpen(true)}>
              {t("merge.confirm")}
            </Key>
            <Key as={Link} to={base}>
              {t("dialog.cancel")}
            </Key>
            {verificationShort ? (
              <span id="merge-why" className="type-caption text-ink-2">
                {t("merge.needVerification")}
              </span>
            ) : null}
          </div>
          <Notice>{t("merge.irreversible")}</Notice>
        </Section>
      ) : null}

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("merge.confirmQ")}
        consequence={t("merge.confirmWhat", { merge: plan.merge.name ?? t("list.noName"), keep: plan.keep.name ?? t("list.noName") })}
        confirmLabel={t("merge.confirm")}
        impact={[
          { label: t("mergeMove.orders"), value: t("merge.impactOrders", { count: plan.moves.orders }) },
          { label: t("mergeMove.addresses"), value: t("merge.impactCount", { count: plan.moves.addresses }) },
          { label: t("merge.wallet"), value: t("merge.impactWallet") },
          { label: t("merge.signIn"), value: t("merge.impactSignIn", { count: plan.moves.sessions }) },
        ]}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "merge", mergeId: plan.merge.id, method, verification, reason, fingerprint: plan.fingerprint }, { method: "post" })}
      />
    </>
  );
}
