import { useRef, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/accounts";
import { listAccounts, saveAccount, type AccountRow } from "~/server/services/admin/finance/ledger.server";
import { ACCOUNT_TYPE_LIST, parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { checked, failed, financeT, ok, openFinance, optionalText, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, Flag, FormDialog, Money, Note, PageHead, Pair, PeriodName, PrintKey, RangeBar, ResponsiveTable, Section, useFinT, usePrintInLight } from "./ui";

/**
 * /admin/finance/accounts — 10.01: the chart of accounts with the trial balance at the end of the range (each
 * account's balance on its side, the totals that must be equal) and each account's movement in the range. Printable
 * (browser print). finance.account.manage adds and changes accounts: postings name accounts by their system key, so
 * renumbering never breaks them; a system account keeps its type and stays on.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.journal.read");
  const range = parseRange(new URL(request.url).searchParams, now);
  const chart = await orRespond(() => listAccounts(db, actor, range, locale));
  return { chart, range, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.account.manage");
  const form = await request.formData();
  try {
    const { created } = await saveAccount(
      req.db,
      req.actor,
      {
        id: optionalText(form, "id"),
        code: text(form, "code"),
        nameAr: text(form, "nameAr"),
        nameEn: optionalText(form, "nameEn"),
        type: optionalText(form, "type") as (typeof ACCOUNT_TYPE_LIST)[number] | undefined,
        // "" (no parent chosen) removes the parent; a form without the field keeps it
        parentId: form.has("parentId") ? text(form, "parentId") : undefined,
        description: optionalText(form, "description"),
        isActive: checked(form, "isActive"),
        reason: text(form, "reason"),
      },
      req.now,
    );
    return ok({ intent: "save", message: financeT(req.locale)(created ? "accounts.created" : "accounts.saved") });
  } catch (error) {
    return failed(error, req.locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "accounts.title");

export default function AccountsPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { chart, range, now } = loaderData;
  const [editing, setEditing] = useState<AccountRow | "new" | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const search = rangeSearch(range);

  const columns: DataColumn<AccountRow>[] = [
    { key: "code", header: t("accounts.col.code"), cell: (row) => <Code>{row.code}</Code> },
    {
      key: "name",
      header: t("accounts.col.name"),
      cell: (row) => (
        <span className={`fin-depth-${Math.min(row.depth, 3)} inline-flex flex-wrap items-center gap-1.5`}>
          <Link to={`/admin/finance/accounts/${row.id}${search}`} className="adm-link">
            {row.name}
          </Link>
          {row.isContra ? <Flag>{t("accounts.contra")}</Flag> : null}
          {!row.isActive ? <Status tone="neutral">{t("accounts.inactive")}</Status> : null}
        </span>
      ),
    },
    { key: "type", header: t("accounts.col.type"), cell: (row) => t(`accountType.${row.type}`) },
    { key: "debit", header: t("accounts.col.debit"), numeric: true, cell: (row) => (row.debitIqd ? <Money iqd={row.debitIqd} plain /> : "") },
    { key: "credit", header: t("accounts.col.credit"), numeric: true, cell: (row) => (row.creditIqd ? <Money iqd={row.creditIqd} plain /> : "") },
    { key: "balanceDebit", header: t("accounts.col.balanceDebit"), numeric: true, cell: (row) => (row.balanceDebitIqd ? <Money iqd={row.balanceDebitIqd} plain /> : "") },
    { key: "balanceCredit", header: t("accounts.col.balanceCredit"), numeric: true, cell: (row) => (row.balanceCreditIqd ? <Money iqd={row.balanceCreditIqd} plain /> : "") },
    ...(chart.canManage
      ? [
          {
            key: "edit",
            header: <span className="sr-only">{t("accounts.edit")}</span>,
            // a key, not a figure: the printed trial balance leaves the column out
            className: "fin-noprint",
            cell: (row: AccountRow) => (
              <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)} aria-label={t("accounts.editNamed", { name: row.name })}>
                {t("accounts.edit")}
              </Key>
            ),
          },
        ]
      : []),
  ];

  return (
    <div ref={sheet} className="fin-print">
      <PageHead
        title={t("accounts.title")}
        lead={t("accounts.lead")}
        actions={
          <>
            <PrintKey label={t("common.print")} />
            {chart.canManage ? (
              <Key size="sm" variant="ink" icon="plus" onClick={() => setEditing("new")}>
                {t("accounts.add")}
              </Key>
            ) : null}
          </>
        }
      />
      <p className="fin-print-only type-body">
        {t("accounts.printedFor")} {range.period ? <PeriodName period={range.period} /> : `${range.from} — ${range.to}`}
      </p>
      <RangeBar range={range} action="/admin/finance/accounts" now={now} />

      <Section
        id="tb"
        title={t("accounts.trialBalance")}
        aside={
          chart.totals.balanced ? (
            <Status tone="ok">{t("accounts.balanced")}</Status>
          ) : (
            <Status tone="bad">{t("accounts.unbalanced")}</Status>
          )
        }
      >
        <p className="type-caption text-ink-2">{t("accounts.asOf", { date: range.to, entries: chart.totals.entries })}</p>
        <ResponsiveTable
          caption={t("accounts.trialBalance")}
          columns={columns}
          rows={chart.rows}
          rowKey={(row) => row.id}
          card={(row) => (
            <>
              <span className="flex items-baseline justify-between gap-2">
                <Link to={`/admin/finance/accounts/${row.id}${search}`} className="adm-link">
                  <Code>{row.code}</Code> · {row.name}
                </Link>
                {!row.isActive ? <Status tone="neutral">{t("accounts.inactive")}</Status> : null}
              </span>
              <Pair label={t("accounts.col.type")}>{t(`accountType.${row.type}`)}</Pair>
              <Pair label={t("accounts.balance")}>
                <Money iqd={row.balanceIqd} />
              </Pair>
              {chart.canManage ? (
                <div>
                  <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)}>
                    {t("accounts.edit")}
                  </Key>
                </div>
              ) : null}
            </>
          )}
          footer={
            <div className="adm-card">
              <div className="fin-ledger">
                <div className="fin-ledger__total">
                  <dt>{t("accounts.totals")}</dt>
                  <dd className="flex flex-wrap justify-end gap-4">
                    <span>
                      {t("accounts.col.balanceDebit")}: <Money iqd={chart.totals.debitIqd} />
                    </span>
                    <span>
                      {t("accounts.col.balanceCredit")}: <Money iqd={chart.totals.creditIqd} />
                    </span>
                  </dd>
                </div>
              </div>
            </div>
          }
        />
        <Note>
          <p>{t("accounts.howToRead")}</p>
        </Note>
      </Section>

      {editing ? <AccountDialog account={editing === "new" ? null : editing} rows={chart.rows} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function AccountDialog({ account, rows, onClose }: { account: AccountRow | null; rows: AccountRow[]; onClose: () => void }) {
  const t = useFinT();
  const [type, setType] = useState<AccountRow["type"]>(account?.type ?? "expense");
  const parents = rows.filter((row) => row.type === type && row.isActive && row.id !== account?.id);
  return (
    <FormDialog
      title={account ? t("accounts.editTitle", { code: account.code }) : t("accounts.addTitle")}
      description={account?.isSystem ? t("accounts.systemNote") : t("accounts.formLead")}
      submitLabel={account ? t("accounts.saveKey") : t("accounts.addKey")}
      onClose={onClose}
      fetcherKey="account-save"
      hidden={account ? { id: account.id } : undefined}
    >
      {(fields) => (
        <>
          <TextField name="code" label={t("accounts.col.code")} hint={t("accounts.codeHint")} defaultValue={account?.code ?? ""} required inputMode="numeric" ltr maxLength={6} error={fields.code} />
          <TextField name="nameAr" label={t("accounts.nameAr")} defaultValue={account?.nameL10n.ar ?? ""} required maxLength={80} error={fields.nameAr} />
          <TextField name="nameEn" label={t("accounts.nameEn")} defaultValue={account?.nameL10n.en ?? ""} optional maxLength={80} error={fields.nameEn} />
          {account ? (
            <p className="type-body">
              {t("accounts.col.type")}: <b>{t(`accountType.${account.type}`)}</b>
            </p>
          ) : (
            <Select name="type" label={t("accounts.col.type")} value={type} onChange={(event) => setType(event.target.value as AccountRow["type"])} options={ACCOUNT_TYPE_LIST.map((value) => ({ value, label: t(`accountType.${value}`) }))} error={fields.type} />
          )}
          <Select
            name="parentId"
            label={t("accounts.parent")}
            hint={t("accounts.parentHint")}
            defaultValue={account?.parentId ?? ""}
            options={[{ value: "", label: t("accounts.noParent") }, ...parents.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))]}
            error={fields.parentId}
          />
          <TextArea name="description" label={t("accounts.description")} defaultValue={account?.description ?? ""} optional rows={2} maxLength={300} />
          <Checkbox name="isActive" label={t("accounts.active")} hint={account?.isSystem ? t("accounts.systemActive") : t("accounts.activeHint")} defaultChecked={account ? account.isActive : true} disabled={account?.isSystem} error={fields.isActive} />
          {account?.isSystem ? <input type="hidden" name="isActive" value="on" /> : null}
          <TextField name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} />
        </>
      )}
    </FormDialog>
  );
}
