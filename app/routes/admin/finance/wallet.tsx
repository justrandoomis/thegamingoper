import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/wallet";
import { useFormat } from "~/i18n/react";
import { randomToken } from "~/lib/ids";
import { customerWallet, requestWalletAdjustment, type WalletEntryRow } from "~/server/services/admin/finance/wallets.server";
import { pageOf } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { CustomerName } from "../shell/CustomerName";
import { customerProfileId } from "../shell/access.server";
import { amount, failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, DemoTag, FormDialog, Kpi, Money, Note, PageHead, Pair, ResponsiveTable, Section, StateTag, useFinT, When } from "./ui";

/**
 * /admin/finance/wallets/:customerId — one customer's wallet (10.07): the balance (the sum of the ledger — there is no
 * balance to edit), every movement with its reference, actor and reason, their top-up requests and adjustment
 * requests. An adjustment is only ever REQUESTED here: another person approves it (creditWallet, kind "adjustment").
 */
export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { db, actor } = await openFinance(context, "finance.wallet.read");
  const wallet = await orRespond(() => customerWallet(db, actor, params.customerId, pageOf(new URL(request.url).searchParams)));
  // the name opens the customer's profile for staff who may open it (customers.customer.read), text otherwise
  return { wallet, key: randomToken(18), customerProfileId: customerProfileId(actor, wallet.customer.id) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openFinance(context, "customers.wallet.adjust");
  const form = await request.formData();
  try {
    const { replayed } = await requestWalletAdjustment(req.db, req.actor, { customerId: params.customerId, amountIqd: amount(form, "amountIqd") as number, reason: text(form, "reason"), idempotencyKey: text(form, "key") }, req.now);
    return ok({ intent: "request", message: financeT(req.locale)(replayed ? "adjust.requestedAgain" : "adjust.requested") });
  } catch (error) {
    return failed(error, req.locale, "request");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "wallet.title");

export default function CustomerWalletPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { wallet, key } = loaderData;
  const [asking, setAsking] = useState(false);
  const pendingTopups = wallet.topups.filter((row) => row.status === "pending_verification");

  const columns: DataColumn<WalletEntryRow>[] = [
    { key: "at", header: t("walletLedger.col.at"), cell: (row) => <When at={row.at} /> },
    { key: "kind", header: t("walletLedger.col.kind"), cell: (row) => t(`walletKind.${row.kind}`) },
    { key: "amount", header: t("walletLedger.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} plain signed /> },
    { key: "ref", header: t("walletLedger.col.ref"), cell: (row) => (row.refHref ? <Link to={row.refHref} className="adm-link"><Code>{row.refLabel ?? "—"}</Code></Link> : "—") },
    { key: "reason", header: t("walletLedger.col.reason"), cell: (row) => <span className="line-clamp-2">{row.reason ?? "—"}</span> },
    { key: "by", header: t("walletLedger.col.by"), cell: (row) => (row.by.name ? row.by.name : t(`actorKind.${row.by.kind}`)) },
  ];

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/finance/wallets?tab=ledger" className="adm-link">
            {t("wallet.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <CustomerName profileId={loaderData.customerProfileId}>{wallet.customer.name ?? t("common.noName")}</CustomerName>
            <DemoTag show={wallet.customer.isDemo} />
            {wallet.customer.status !== "active" ? <Status tone="warn">{t(`customerStatus.${wallet.customer.status}`)}</Status> : null}
          </span>
        }
        lead={wallet.customer.phone ? <bdi dir="ltr">{wallet.customer.phone.display}</bdi> : undefined}
        actions={
          wallet.canDecide ? (
            <Key size="sm" icon="hand-coins" onClick={() => setAsking(true)}>
              {t("adjust.ask")}
            </Key>
          ) : null
        }
      />

      <div className="fin-kpis mb-5">
        <Kpi icon="wallet" label={t("wallet.balance")} value={<Money iqd={wallet.balanceIqd} />} hint={t("wallet.balanceHint")} />
        <Kpi icon="hourglass" label={t("wallet.pending")} value={<Money iqd={pendingTopups.reduce((total, row) => total + (row.declaredAmountIqd ?? row.amountIqd), 0)} />} hint={t("common.countOf", { count: pendingTopups.length })} />
      </div>

      <Section id="wallet-entries" title={t("wallet.entries")} aside={<span className="type-caption text-ink-2">{t("walletLedger.count", { count: wallet.total })}</span>}>
        <ResponsiveTable
          caption={t("wallet.entries")}
          columns={columns}
          rows={wallet.entries}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("wallet.empty")} icon="wallet" />}
          footer={<Pagination page={wallet.page} pageCount={wallet.pageCount} href={(n) => (n > 1 ? `?page=${n}` : "?")} />}
          card={(row) => (
            <>
              <span className="flex items-baseline justify-between gap-2">
                <span>{t(`walletKind.${row.kind}`)}</span>
                <Money iqd={row.amountIqd} signed className="type-strong" />
              </span>
              <Pair label={t("walletLedger.col.at")}>
                <When at={row.at} />
              </Pair>
              {row.reason ? <p className="type-caption text-ink-2">{row.reason}</p> : null}
            </>
          )}
        />
      </Section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Section id="wallet-topups" title={t("wallet.topups")}>
          {wallet.topups.length === 0 ? (
            <p className="type-body text-ink-2">{t("wallet.noTopups")}</p>
          ) : (
            <ul className="grid gap-2">
              {wallet.topups.map((row) => (
                <li key={row.id} className="adm-card gap-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <Link to={`/admin/finance/wallets/topups/${row.id}`} className="adm-link">
                      <Code>{row.ref}</Code>
                    </Link>
                    <Money iqd={row.declaredAmountIqd ?? row.amountIqd} />
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StateTag group="topup" value={row.status} label={t(`topupStatus.${row.status}`)} />
                    <When at={row.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section id="wallet-adjustments" title={t("wallet.adjustments")}>
          {wallet.adjustments.length === 0 ? (
            <p className="type-body text-ink-2">{t("wallet.noAdjustments")}</p>
          ) : (
            <ul className="grid gap-2">
              {wallet.adjustments.map((row) => (
                <li key={row.id} className="adm-card gap-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <StateTag group="approval" value={row.status} label={t(`approvalStatus.${row.status}`)} />
                    <Money iqd={row.amountIqd} />
                  </span>
                  <p className="type-body">{row.reason}</p>
                  <p className="type-caption text-ink-2">
                    {t("adjust.requestedBy", { name: row.requestedBy ?? "—" })} · <When at={row.createdAt} />
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="type-caption">
            <Link to="/admin/finance/wallets?tab=adjustments" className="adm-link">
              {t("wallet.toAdjustments")}
            </Link>
          </p>
        </Section>
      </div>

      <Note icon="lock">
        <p>{t("walletLedger.immutable")}</p>
      </Note>

      {asking ? (
        <FormDialog title={t("adjust.askTitle")} description={t("adjust.askLead")} submitLabel={t("adjust.askKey")} onClose={() => setAsking(false)} fetcherKey="adjust-request" hidden={{ key }}>
          {(fields) => (
            <>
              <TextField name="amountIqd" label={t("adjust.amount")} hint={t("adjust.amountHint", { max: f.iqd(10_000_000) })} inputMode="numeric" required error={fields.amountIqd} end={<span className="type-caption">{t("common.iqd")}</span>} />
              <TextArea name="reason" label={t("common.reason")} hint={t("adjust.reasonHint")} required minLength={10} maxLength={500} rows={3} error={fields.reason} />
              <Note>
                <p>{t("adjust.twoPeople")}</p>
              </Note>
            </>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}
