import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/wallets";
import { useFormat } from "~/i18n/react";
import { decideWalletAdjustment, listAdjustments, listTopups, listWalletLedger, walletOverview, type AdjustmentRow, type TopupRow, type WalletEntryRow } from "~/server/services/admin/finance/wallets.server";
import { idParam, pageOf, parseRange, rangeSearch, TOPUP_STATUS_LIST, WALLET_KIND_LIST } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, Code, DemoHidden, DemoTag, Flag, Kpi, Money, Note, PageHead, Pair, RangeBar, ResponsiveTable, Section, StateTag, useFinT, When } from "./ui";

const TABS = ["topups", "adjustments", "ledger"] as const;
type Tab = (typeof TABS)[number];

/**
 * /admin/finance/wallets — 10.07: the customer wallet as a ledger nobody edits (balance = the sum of its rows), the
 * ledger against its account in the journal (they must agree to the dinar), the top-up requests customers sent from
 * their account (decided on their own page, mobile-first), and wallet adjustments (two people: one asks, another
 * approves; credited through creditWallet). finance.wallet.read; decisions customers.wallet.adjust.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context, "finance.wallet.read");
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "topups";
  const status = params.get("status");
  const kind = params.get("kind");
  const page = pageOf(params);
  const [overview, topups, adjustments, ledger] = await orRespond(() =>
    Promise.all([
      walletOverview(db, actor, range),
      tab === "topups" ? listTopups(db, actor, { status: (TOPUP_STATUS_LIST as readonly string[]).includes(status ?? "") ? (status as TopupRow["status"]) : null, page }) : Promise.resolve(null),
      tab === "adjustments" ? listAdjustments(db, actor, 50) : Promise.resolve(null),
      tab === "ledger" ? listWalletLedger(db, actor, { ...range, kind: (WALLET_KIND_LIST as readonly string[]).includes(kind ?? "") ? kind : null, customer: idParam(params, "customer"), page }) : Promise.resolve(null),
    ]),
  );
  return { overview, topups, adjustments, ledger, tab, range, now, status: (TOPUP_STATUS_LIST as readonly string[]).includes(status ?? "") ? status : null, kind };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.wallet.read");
  const form = await request.formData();
  // the service's schema refuses anything but approve / reject (a malformed form must never become a rejection)
  const decision = text(form, "decision") as "approve" | "reject";
  try {
    const { status } = await decideWalletAdjustment(req.db, req.actor, { approvalId: text(form, "approvalId"), decision, note: text(form, "reason") || undefined }, req.now);
    return ok({ intent: "adjustment", message: financeT(req.locale)(status === "approved" ? "adjust.approved" : "adjust.rejected") });
  } catch (error) {
    return failed(error, req.locale, "adjustment");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "wallets.title");

export default function WalletsPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { overview, topups, adjustments, ledger, tab, range, now, status, kind } = loaderData;
  const [deciding, setDeciding] = useState<{ row: AdjustmentRow; decision: "approve" | "reject" } | null>(null);
  const tabHref = (next: Tab) => `/admin/finance/wallets${rangeSearch(range, { tab: next === "topups" ? null : next })}`;

  const topupColumns: DataColumn<TopupRow>[] = [
    {
      key: "ref",
      header: t("topups.col.ref"),
      cell: (row) => (
        <Link to={`/admin/finance/wallets/topups/${row.id}`} className="adm-link">
          <Code>{row.ref}</Code>
        </Link>
      ),
    },
    { key: "customer", header: t("topups.col.customer"), cell: (row) => <CustomerCell row={row} /> },
    { key: "method", header: t("topups.col.method"), cell: (row) => t(`method.${row.method}`) },
    { key: "declared", header: t("topups.col.declared"), numeric: true, cell: (row) => <Money iqd={row.declaredAmountIqd ?? row.amountIqd} plain /> },
    { key: "at", header: t("topups.col.at"), cell: (row) => <When at={row.createdAt} /> },
    {
      key: "status",
      header: t("topups.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="topup" value={row.status} label={t(`topupStatus.${row.status}`)} />
          {row.firstApproval ? <Flag icon="users">{t("topups.firstDone")}</Flag> : null}
          {row.notCredited ? <Status tone="bad">{t("topups.notCredited")}</Status> : null}
          {row.flags.sameProof ? <Flag icon="warning">{t("topups.sameProof")}</Flag> : null}
          {row.flags.sameReference ? <Flag icon="warning">{t("topups.sameReference")}</Flag> : null}
        </span>
      ),
    },
  ];

  const ledgerColumns: DataColumn<WalletEntryRow>[] = [
    { key: "at", header: t("walletLedger.col.at"), cell: (row) => <When at={row.at} /> },
    {
      key: "customer",
      header: t("walletLedger.col.customer"),
      cell: (row) => (
        <Link to={`/admin/finance/wallets/${row.customerId}`} className="adm-link">
          {row.customer?.name ?? t("common.noName")}
          {row.customer?.phone ? (
            <span className="ms-1 type-caption text-ink-2">
              <bdi dir="ltr">{row.customer.phone.display}</bdi>
            </span>
          ) : null}
        </Link>
      ),
    },
    { key: "kind", header: t("walletLedger.col.kind"), cell: (row) => t(`walletKind.${row.kind}`) },
    { key: "amount", header: t("walletLedger.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} plain signed /> },
    { key: "ref", header: t("walletLedger.col.ref"), cell: (row) => (row.refHref ? <Link to={row.refHref} className="adm-link"><Code>{row.refLabel ?? "—"}</Code></Link> : row.refLabel ? <Code>{row.refLabel}</Code> : "—") },
    { key: "reason", header: t("walletLedger.col.reason"), cell: (row) => <span className="line-clamp-2">{row.reason ?? "—"}</span> },
    { key: "by", header: t("walletLedger.col.by"), cell: (row) => (row.by.name ? row.by.name : t(`actorKind.${row.by.kind}`)) },
  ];

  return (
    <>
      <PageHead title={t("wallets.title")} lead={t("wallets.lead")} />

      <div className="fin-kpis mb-5">
        <Kpi icon="wallet" label={t("wallets.liability")} value={<Money iqd={overview.ledgerIqd} />} hint={t("wallets.holders", { count: overview.customersWithBalance })} />
        <Kpi icon="book-open" label={t("wallets.journal")} value={<Money iqd={overview.journalIqd} />} hint={overview.differenceIqd === 0 ? t("wallets.agree") : t("wallets.differ", { amount: f.iqd(overview.differenceIqd) })} />
        <Kpi icon="hourglass" label={t("wallets.pendingTopups")} value={<Money iqd={overview.pendingTopups.iqd} />} hint={t("common.countOf", { count: overview.pendingTopups.count })} />
        <Kpi icon="hand-coins" label={t("wallets.pendingAdjustments")} value={<Money iqd={overview.pendingAdjustments.iqd} />} hint={t("common.countOf", { count: overview.pendingAdjustments.count })} />
      </div>
      {overview.differenceIqd !== 0 ? (
        <Note tone="bad" icon="warning">
          <p>{t("wallets.mismatch", { amount: f.iqd(overview.differenceIqd) })}</p>
        </Note>
      ) : null}

      <nav aria-label={t("wallets.tabs")} className="my-4 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <Key key={item} as={Link} to={tabHref(item)} size="sm" held={tab === item} aria-current={tab === item ? "page" : undefined}>
            {t(`wallets.tab.${item}`)}
          </Key>
        ))}
      </nav>

      {topups ? (
        <Section
          id="wallet-topups"
          title={t("wallets.tab.topups")}
          aside={
            <Form method="get" className="flex items-end gap-2">
              <Select name="status" label={t("topups.col.status")} hideLabel defaultValue={status ?? ""} options={[{ value: "", label: t("topups.allStatuses") }, ...TOPUP_STATUS_LIST.map((value) => ({ value, label: t(`topupStatus.${value}`) }))]} />
              <Key type="submit" size="sm" variant="ink" icon="funnel">
                {t("range.apply")}
              </Key>
            </Form>
          }
        >
          <p className="max-w-[72ch] type-body text-ink-2">{t("topups.lead")}</p>
          <ResponsiveTable
            caption={t("wallets.tab.topups")}
            columns={topupColumns}
            rows={topups.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("topups.empty")} text={t("topups.emptyHint")} icon="wallet" />}
            footer={<Pagination page={topups.page} pageCount={topups.pageCount} href={(n) => `?${new URLSearchParams({ ...(status ? { status } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`} />}
            card={(row) => (
              <Link to={`/admin/finance/wallets/topups/${row.id}`} className={row.status === "pending_verification" ? "grid gap-1 no-underline" : "grid gap-1 no-underline"}>
                <span className="flex items-baseline justify-between gap-2">
                  <Code className="type-strong">{row.ref}</Code>
                  <Money iqd={row.declaredAmountIqd ?? row.amountIqd} className="type-strong" />
                </span>
                <Pair label={t("topups.col.customer")}>{row.customer?.name ?? t("common.noName")}</Pair>
                <Pair label={t("topups.col.method")}>{t(`method.${row.method}`)}</Pair>
                <span className="flex flex-wrap items-center gap-1">
                  <StateTag group="topup" value={row.status} label={t(`topupStatus.${row.status}`)} />
                  {row.firstApproval ? <Flag icon="users">{t("topups.firstDone")}</Flag> : null}
                  {row.notCredited ? <Status tone="bad">{t("topups.notCredited")}</Status> : null}
                </span>
              </Link>
            )}
          />
        </Section>
      ) : null}

      {adjustments ? (
        <Section id="wallet-adjustments" title={t("wallets.tab.adjustments")}>
          <p className="max-w-[72ch] type-body text-ink-2">{t("adjust.lead")}</p>
          {adjustments.length === 0 ? (
            <EmptyState title={t("adjust.empty")} text={t("adjust.emptyHint")} icon="hand-coins" />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {adjustments.map((row) => (
                <li key={row.id}>
                  <article className={row.status === "pending" && !row.mine ? "adm-card adm-card--act" : "adm-card"}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link to={`/admin/finance/wallets/${row.customerId}`} className="adm-link">
                        {row.customer?.name ?? t("common.noName")}
                      </Link>
                      <StateTag group="approval" value={row.status} label={t(`approvalStatus.${row.status}`)} />
                    </div>
                    <p className="type-kpi nums">
                      <Money iqd={row.amountIqd} />
                    </p>
                    <p className="type-body">{row.reason}</p>
                    <p className="type-caption text-ink-2">
                      {t("adjust.requestedBy", { name: row.requestedBy ?? "—" })} · <When at={row.createdAt} />
                    </p>
                    {row.decidedBy ? (
                      <p className="type-caption text-ink-2">
                        {t("adjust.decidedBy", { name: row.decidedBy })} {row.decisionNote ? `— ${row.decisionNote}` : ""}
                      </p>
                    ) : null}
                    {row.notCredited ? <Status tone="bad">{t("topups.notCredited")}</Status> : null}
                    {row.status === "pending" ? (
                      <div className="flex flex-wrap gap-2">
                        {row.mine ? (
                          <>
                            <p className="flex items-center gap-1 type-caption text-ink-2">{t("adjust.mine")}</p>
                            <Key size="sm" onClick={() => setDeciding({ row, decision: "reject" })}>
                              {t("adjust.withdraw")}
                            </Key>
                          </>
                        ) : (
                          <>
                            <Key size="sm" className="enabled:[--on:var(--red-ink)]" onClick={() => setDeciding({ row, decision: "reject" })}>
                              {t("adjust.reject")}
                            </Key>
                            <Key size="sm" variant="ink" icon="seal-check" onClick={() => setDeciding({ row, decision: "approve" })}>
                              {t("adjust.approve")}
                            </Key>
                          </>
                        )}
                      </div>
                    ) : row.notCredited && !row.mine ? (
                      <Key size="sm" variant="ink" onClick={() => setDeciding({ row, decision: "approve" })}>
                        {t("topups.finishCredit")}
                      </Key>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          )}
          <p className="type-caption text-ink-2">{t("adjust.howToAsk")}</p>
        </Section>
      ) : null}

      {ledger ? (
        <Section id="wallet-ledger" title={t("wallets.tab.ledger")}>
          <RangeBar range={range} action="/admin/finance/wallets" keep={{ tab: "ledger", kind }} now={now} />
          <Form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="ledger" />
            {range.period ? <input type="hidden" name="period" value={range.period} /> : <><input type="hidden" name="from" value={range.from} /><input type="hidden" name="to" value={range.to} /></>}
            {range.demo ? <input type="hidden" name="demo" value="1" /> : null}
            <Select name="kind" label={t("walletLedger.col.kind")} defaultValue={kind ?? ""} options={[{ value: "", label: t("common.any") }, ...WALLET_KIND_LIST.map((value) => ({ value, label: t(`walletKind.${value}`) }))]} />
            <Key type="submit" size="sm" variant="ink" icon="funnel">
              {t("range.apply")}
            </Key>
          </Form>
          <p className="type-caption text-ink-2">{t("walletLedger.totals", { count: ledger.total, in: f.iqd(ledger.inIqd), out: f.iqd(ledger.outIqd) })}</p>
          <DemoHidden count={ledger.demoHidden} href={`/admin/finance/wallets${rangeSearch({ ...range, demo: true }, { tab: "ledger", kind })}`} />
          <ResponsiveTable
            caption={t("wallets.tab.ledger")}
            columns={ledgerColumns}
            rows={ledger.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("walletLedger.empty")} icon="wallet" />}
            footer={<Pagination page={ledger.page} pageCount={ledger.pageCount} href={(n) => rangeSearch(range, { tab: "ledger", kind, page: n > 1 ? n : null }) || "?"} />}
            card={(row) => (
              <>
                <span className="flex items-baseline justify-between gap-2">
                  <Link to={`/admin/finance/wallets/${row.customerId}`} className="adm-link">
                    {row.customer?.name ?? t("common.noName")}
                  </Link>
                  <Money iqd={row.amountIqd} signed className="type-strong" />
                </span>
                <Pair label={t("walletLedger.col.kind")}>{t(`walletKind.${row.kind}`)}</Pair>
                <Pair label={t("walletLedger.col.at")}>
                  <When at={row.at} />
                </Pair>
                {row.customer?.isDemo ? (
                  <span className="flex">
                    <DemoTag show />
                  </span>
                ) : null}
              </>
            )}
          />
          <Note icon="lock">
            <p>{t("walletLedger.immutable")}</p>
          </Note>
        </Section>
      ) : null}

      {deciding ? (
        <ActionDialog
          open
          onClose={() => setDeciding(null)}
          tone={deciding.decision === "approve" ? "commit" : "destructive"}
          title={t(deciding.decision === "approve" ? "adjust.approveQ" : deciding.row.mine ? "adjust.withdrawQ" : "adjust.rejectQ")}
          consequence={t(deciding.decision === "approve" ? "adjust.approveWhat" : "adjust.rejectWhat")}
          confirmLabel={t(deciding.decision === "approve" ? "adjust.approve" : deciding.row.mine ? "adjust.withdraw" : "adjust.reject")}
          impact={deciding.decision === "approve" ? [{ label: t("adjust.credit"), value: f.iqd(deciding.row.amountIqd) }] : undefined}
          reason={deciding.decision === "approve" ? { label: t("common.noteOptional"), noteRequired: false, minLength: 0 } : { label: t("common.reason"), minLength: 3 }}
          fields={{ intent: "adjustment", approvalId: deciding.row.id, decision: deciding.decision }}
        />
      ) : null}
    </>
  );
}

function CustomerCell({ row }: { row: TopupRow }) {
  const t = useFinT();
  return (
    <span className="grid justify-items-start py-1">
      <Link to={`/admin/finance/wallets/${row.customerId}`} className="adm-link">
        {row.customer?.name ?? t("common.noName")}
      </Link>
      {row.customer?.phone ? (
        <span className="type-caption text-ink-2">
          <bdi dir="ltr">{row.customer.phone.display}</bdi>
        </span>
      ) : null}
      {row.customer?.isDemo ? <DemoTag show /> : null}
    </span>
  );
}
