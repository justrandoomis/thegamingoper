import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/points-customer";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { adjustPoints, customerPoints, decideAdjustment, withdrawAdjustment } from "~/server/services/admin/promotions/loyalty.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { LOYALTY_KIND_TONE, parseWhole, type LedgerRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent, text } from "./promotions.server";
import { ConfirmAction, Failure, Kpis, newKey, Notice, Num, PhoneText, Section, ToneStatus, useChangeText, useIntent, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/points/:customerId — 08.04 for one customer: the balance (and what it is worth), points expiring in
 * 30 days, the VIP multiplier, every ledger row, and a manual adjustment with a reason (a second person beyond
 * LOYALTY.adjustSecondPersonPoints; the requester withdraws, never decides).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.points);
  try {
    return { points: await customerPoints(db, actor, params.customerId, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.loyalty.adjust");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { adjust: ["promotions.loyalty.adjust"], decide: ["promotions.loyalty.adjust"], withdraw: ["promotions.loyalty.adjust"] }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "adjust":
          return { ok: true, intent, ...(await adjustPoints(db, actor, { customerId: params.customerId, points: text(form, "points"), reason: text(form, "reason"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now)) };
        case "decide":
          return { ok: true, intent, ...(await decideAdjustment(db, actor, { approvalId: text(form, "approvalId"), customerId: params.customerId, decision: text(form, "decision"), note: text(form, "note") }, ctx.now)) };
        case "withdraw":
          return { ok: true, intent, ...(await withdrawAdjustment(db, actor, { approvalId: text(form, "approvalId"), customerId: params.customerId }, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "points.title");

export default function CustomerPointsPage({ loaderData }: Route.ComponentProps) {
  const program = useProgram();
  const t = usePromotionsT();
  const f = useFormat();
  const change = useChangeText();
  const { points } = loaderData;
  const columns: DataColumn<LedgerRow>[] = [
    { key: "at", header: t("points.col.at"), cell: (row) => <When at={row.at} /> },
    { key: "kind", header: t("points.col.kind"), cell: (row) => <ToneStatus tone={LOYALTY_KIND_TONE[row.kind]}>{t(`points.kind.${row.kind}`)}</ToneStatus> },
    { key: "points", header: t("points.col.points"), numeric: true, negative: (row) => row.points < 0, cell: (row) => <Num value={row.points} /> },
    { key: "ref", header: t("points.col.ref"), cell: (row) => <span className="grid">{row.refLabel ? <bdi dir="ltr" className="nums">{row.refLabel}</bdi> : t(`points.ref.${row.refType ?? "none"}`)}{row.reason ? <span className="type-caption text-ink-2">{row.reason}</span> : null}</span> },
    { key: "expires", header: t("points.col.expires"), cell: (row) => (row.expiresAt ? <When at={row.expiresAt} style="date" /> : "—") },
    { key: "actor", header: t("points.col.actor"), cell: (row) => (row.actor === "system" ? t("common.system") : (row.actor ?? "—")) },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/promotions/points" className="adm-link">
            {t("points.title")}
          </Link>
        </p>
        <h1 className="adm-title">{points.name ?? t("common.noName")}</h1>
        <div className="prm-actions">
          <span className="type-body text-ink-2">
            <PhoneText phone={points.phone} />
          </span>
          {points.status !== "active" ? <ToneStatus tone="out">{t(`points.customerStatus.${points.status}`)}</ToneStatus> : null}
          {points.canSeeProfile ? (
            <Key as={Link} to={`/admin/customers/${points.customerId}`} size="sm" variant="ghost" iconEnd="arrow-right">
              {t("points.profile")}
            </Key>
          ) : null}
        </div>
      </header>
      <div className="prm-block">
      <Kpis
        items={[
          { label: t("points.k.balance"), value: <Num value={points.balance} />, note: t("points.k.worth", { amount: f.iqd(points.valueIqd) }) },
          { label: t("points.k.expiringSoon"), value: <Num value={points.expiringSoon} /> },
          { label: t("points.k.multiplier"), value: points.multiplierBps ? <bdi className="nums">×{(points.multiplierBps / 10_000).toFixed(2).replace(/0$/, "")}</bdi> : "—", note: points.multiplierBps ? t("points.k.multiplierNote") : t("points.k.noMultiplier") },
          { label: t("points.k.entries"), value: <Num value={points.entries.length} /> },
        ]}
      />
      </div>
      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-entries" title={t("points.entries")}>
            {points.entries.length === 0 ? <p className="type-body text-ink-2">{t("points.noEntries")}</p> : <DataTable caption={t("points.entries")} columns={columns} rows={points.entries} rowKey={(row) => row.id} maxHeight={null} />}
          </Section>
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          {points.pending.map((request) => (
            <div key={request.approvalId} className="prm-panel prm-panel--decide">
              <p className="adm-h3">{t("points.pending.title")}</p>
              <p className="type-body">{t("points.pending.what", { points: f.number(request.points) })}</p>
              <p className="type-caption text-ink-2">
                {t("common.requestedBy", { name: request.requestedBy ?? "—" })} · <When at={request.requestedAt} />
              </p>
              {request.reason ? <p className="type-body">{t("common.reasonWas", { reason: request.reason })}</p> : null}
              {request.mine ? (
                <>
                  <Notice>{t("common.yourRequest")}</Notice>
                  <ConfirmAction intent="withdraw" label={t("common.withdraw")} title={t("common.withdrawQ")} consequence={t("points.pending.withdrawWhat")} confirmLabel={t("common.withdraw")} values={{ approvalId: request.approvalId }} reason={false} doneKey="done.withdrawn" />
                </>
              ) : request.canDecide ? (
                <div className="prm-actions">
                  <ConfirmAction intent="decide" label={t("common.approve")} title={t("points.pending.approveQ")} consequence={t("points.pending.approveWhat", { points: f.number(request.points) })} confirmLabel={t("common.approve")} values={{ approvalId: request.approvalId, decision: "approve" }} impact={[{ label: t("points.k.balance"), value: change(f.number(points.balance), f.number(points.balance + request.points)), negative: request.points < 0 }]} reasonField="note" reasonLabel={t("common.note")} tone="commit" icon="check-circle" doneKey="done.approved" />
                  <ConfirmAction intent="decide" label={t("common.reject")} title={t("coupons.pending.rejectQ")} consequence={t("points.pending.rejectWhat")} confirmLabel={t("common.reject")} values={{ approvalId: request.approvalId, decision: "reject" }} reasonField="note" tone="destructive" icon="x-circle" doneKey="done.rejected" />
                </div>
              ) : (
                <Notice>{t("common.decidedBy")}</Notice>
              )}
            </div>
          ))}
          {points.canAdjust ? <AdjustForm balance={points.balance} /> : null}
        </aside>
      </div>
    </>
  );
}

/**
 * A manual adjustment moves value (a point is worth program.loyalty.pointValueIqd): the form asks first — the balance before and
 * after, what the points are worth — then sends the form with its idempotency key. Input the server would refuse is
 * sent without asking, so its field errors appear in place.
 */
function AdjustForm({ balance }: { balance: number }) {
  const program = useProgram();
  const t = usePromotionsT();
  const f = useFormat();
  const change = useChangeText();
  const [formKey, setFormKey] = useState(newKey);
  const [ask, setAsk] = useState<{ data: FormData; points: number } | null>(null);
  const { fetcher, pending, message, fields: errors } = useIntent(
    "adjust",
    (result) => (result.status === "requested" ? "done.requested" : "done.adjusted"),
    () => {
      setAsk(null);
      setFormKey(newKey());
    },
  );
  return (
    <Section id="prm-adjust" title={t("points.adjust.title")} lead={t("points.adjust.lead", { n: f.number(program.loyalty.adjustSecondPersonPoints), day: f.number(program.loyalty.adjustSoloDayPoints) })}>
      <ConfirmDialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={t("points.adjust.q", { points: f.number(ask?.points ?? 0) })}
        consequence={t("points.adjust.what")}
        confirmLabel={t("points.adjust.save")}
        impact={
          ask
            ? [
                { label: t("points.k.balance"), value: change(f.number(balance), f.number(balance + ask.points)), negative: ask.points < 0 },
                { label: t("points.adjust.worth"), value: f.iqd(ask.points * program.loyalty.pointValueIqd), negative: ask.points < 0 },
              ]
            : undefined
        }
        pending={pending}
        error={message}
        onConfirm={() => {
          if (ask) fetcher.submit(ask.data, { method: "post" });
        }}
      />
      <fetcher.Form
        method="post"
        className="prm-form"
        noValidate
        key={formKey}
        onSubmit={(event) => {
          const data = new FormData(event.currentTarget);
          const points = parseWhole(String(data.get("points") ?? ""));
          // what the server refuses anyway goes straight to it, so the fields say what is wrong
          if (points === null || points === 0 || String(data.get("reason") ?? "").trim().length < 3) return;
          event.preventDefault();
          setAsk({ data, points });
        }}
      >
        <input type="hidden" name="intent" value="adjust" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <TextField name="points" label={t("points.adjust.points")} hint={t("points.adjust.pointsHint", { balance: f.number(balance) })} inputMode="numeric" required error={errors.points} />
        <TextArea name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required rows={2} maxLength={500} error={errors.reason} />
        <p className="type-caption text-ink-2">{t("points.adjust.value", { amount: f.iqd(program.loyalty.pointValueIqd) })}</p>
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="coins">
            {t("points.adjust.save")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}
