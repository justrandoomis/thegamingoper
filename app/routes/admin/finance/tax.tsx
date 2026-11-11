import { useState } from "react";

import type { Route } from "./+types/tax";
import { useFormat } from "~/i18n/react";
import { listTaxRates, saveTaxRate, taxReport, type TaxRateRow } from "~/server/services/admin/finance/tax.server";
import { baghdadDay, CHANNEL_LIST, parsePercentBps, parseRange, PRODUCT_KIND_LIST } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Checkbox, FieldGroup, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { all, checked, failed, financeT, ok, openFinance, optionalText, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Bps, Code, FormDialog, Ledger, Money, Note, PageHead, Pair, RangeBar, ResponsiveTable, Section, useFinT, When } from "./ui";

/**
 * /admin/finance/tax — 10.08: the tax configuration (editable, finance.tax.manage) and the tax report of a range. What
 * is configured is said plainly: no rate exists until the owner and their accountant decide one applies; prices
 * include any tax, checkout adds none, and the books have no tax account — so a configured rate is REPORTED (the tax
 * inside the delivered sales it covers), never added or posted. Nothing here invents a rule for Iraq.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.tax.manage");
  const range = parseRange(new URL(request.url).searchParams, now);
  const [rates, report] = await orRespond(() => Promise.all([listTaxRates(db, actor, locale), taxReport(db, actor, range, locale)]));
  return { rates, report, range, now, today: baghdadDay(now) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.tax.manage");
  const form = await request.formData();
  try {
    const rate = parsePercentBps(text(form, "rate"));
    const expected = text(form, "expectedUpdatedAt");
    const { created } = await saveTaxRate(
      req.db,
      req.actor,
      {
        id: optionalText(form, "id"),
        code: text(form, "code"),
        nameAr: text(form, "nameAr"),
        nameEn: optionalText(form, "nameEn"),
        rateBps: rate as number,
        productKinds: all(form, "kinds").filter(Boolean) as (typeof PRODUCT_KIND_LIST)[number][],
        channels: all(form, "channels").filter(Boolean) as (typeof CHANNEL_LIST)[number][],
        isActive: checked(form, "isActive"),
        effectiveFrom: optionalText(form, "effectiveFrom"),
        reason: text(form, "reason"),
        expectedUpdatedAt: expected ? Number(expected) : undefined,
      },
      req.now,
    );
    return ok({ intent: "save", message: financeT(req.locale)(created ? "tax.created" : "tax.saved") });
  } catch (error) {
    return failed(error, req.locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "tax.title");

export default function TaxPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { rates, report, range, now } = loaderData;
  const [editing, setEditing] = useState<TaxRateRow | "new" | null>(null);

  const columns: DataColumn<TaxRateRow>[] = [
    { key: "code", header: t("tax.code"), cell: (row) => <Code>{row.code}</Code> },
    { key: "name", header: t("tax.name"), cell: (row) => row.name },
    { key: "rate", header: t("tax.rate"), numeric: true, cell: (row) => <Bps value={row.rateBps} /> },
    { key: "scope", header: t("tax.scope"), cell: (row) => <ScopeText row={row} /> },
    { key: "from", header: t("tax.from"), cell: (row) => (row.effectiveAt ? <When at={row.effectiveAt} kind="date" /> : t("tax.always")) },
    { key: "status", header: t("tax.status"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{t(row.isActive ? "tax.active" : "tax.inactive")}</Status> },
    {
      key: "edit",
      header: <span className="sr-only">{t("tax.edit")}</span>,
      cell: (row) => (
        <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)}>
          {t("tax.edit")}
        </Key>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t("tax.title")}
        lead={t("tax.lead")}
        actions={
          <Key size="sm" variant="ink" icon="plus" onClick={() => setEditing("new")}>
            {t("tax.add")}
          </Key>
        }
      />

      <Section id="tax-config" title={t("tax.configured")}>
        {rates.length === 0 ? (
          <Note icon="info">
            <p className="type-strong">{t("tax.noneTitle")}</p>
            <p>{t("tax.noneText")}</p>
          </Note>
        ) : (
          <ResponsiveTable
            caption={t("tax.configured")}
            columns={columns}
            rows={rates}
            rowKey={(row) => row.id}
            card={(row) => (
              <>
                <span className="flex items-baseline justify-between gap-2">
                  <span>
                    <Code>{row.code}</Code> · {row.name}
                  </span>
                  <Bps value={row.rateBps} />
                </span>
                <Pair label={t("tax.scope")}>
                  <ScopeText row={row} />
                </Pair>
                <Status tone={row.isActive ? "ok" : "neutral"}>{t(row.isActive ? "tax.active" : "tax.inactive")}</Status>
                <div>
                  <Key size="sm" variant="quiet" icon="pencil-simple" onClick={() => setEditing(row)}>
                    {t("tax.edit")}
                  </Key>
                </div>
              </>
            )}
          />
        )}
        <Note icon="lock">
          <p>{t("tax.inclusiveOnly")}</p>
        </Note>
      </Section>

      <Section id="tax-report" title={t("tax.report")}>
        <RangeBar range={range} action="/admin/finance/tax" now={now} />
        <Ledger
          className="adm-card max-w-xl"
          rows={[
            { label: t("tax.recognised"), value: <Money iqd={report.revenue.netIqd} />, hint: t("tax.recognisedHint") },
            { label: t("tax.deliveredLines"), value: <Money iqd={report.deliveredLinesIqd} />, hint: t("tax.deliveredLinesHint") },
            { label: t("pl.discounts"), value: <Money iqd={report.revenue.discountsIqd} /> },
            { label: t("pl.refunds"), value: <Money iqd={report.revenue.refundsIqd} /> },
          ]}
        />
        {report.rows.length === 0 ? (
          <p className="type-body text-ink-2">{report.configured ? t("tax.noActive") : t("tax.nothingToReport")}</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {report.rows.map((row) => (
              <li key={row.rate.id} className="adm-card">
                <h3 className="adm-h3">
                  <Code>{row.rate.code}</Code> · {row.rate.name} (<Bps value={row.rate.rateBps} />)
                </h3>
                <Ledger
                  rows={[
                    { label: t("tax.base"), value: <Money iqd={row.baseIqd} />, hint: t("tax.baseHint", { lines: f.number(row.lines) }) },
                    { label: t("tax.included"), value: <Money iqd={row.taxIqd} />, strong: true },
                  ]}
                />
                {row.partial ? <p className="type-caption text-ink-2">{t("tax.partial")}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <Note>
          <p>{t("tax.formula")}</p>
        </Note>
      </Section>

      {editing ? <TaxDialog rate={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ScopeText({ row }: { row: TaxRateRow }) {
  const t = useFinT();
  const kinds = row.scope.productKinds?.map((kind) => t(`productKind.${kind}`)).join("، ");
  const channels = row.scope.channels?.map((channel) => t(`channel.${channel}`)).join("، ");
  if (!kinds && !channels) return <span>{t("tax.everything")}</span>;
  return <span>{[kinds, channels].filter(Boolean).join(" · ")}</span>;
}

function TaxDialog({ rate, onClose }: { rate: TaxRateRow | null; onClose: () => void }) {
  const t = useFinT();
  const from = rate?.effectiveAt ? new Date(rate.effectiveAt + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
  return (
    <FormDialog
      title={rate ? t("tax.editTitle", { code: rate.code }) : t("tax.addTitle")}
      description={t("tax.formLead")}
      submitLabel={rate ? t("tax.save") : t("tax.add")}
      onClose={onClose}
      fetcherKey="tax-save"
      hidden={rate ? { id: rate.id, expectedUpdatedAt: String(rate.updatedAt) } : undefined}
    >
      {(fields) => (
        <>
          <TextField name="code" label={t("tax.code")} hint={t("tax.codeHint")} defaultValue={rate?.code ?? ""} required ltr autoCapitalize="characters" maxLength={24} error={fields.code} />
          <TextField name="nameAr" label={t("tax.nameAr")} defaultValue={rate?.nameL10n.ar ?? ""} required maxLength={80} error={fields.nameAr} />
          <TextField name="nameEn" label={t("tax.nameEn")} defaultValue={rate?.nameL10n.en ?? ""} optional maxLength={80} error={fields.nameEn} />
          <TextField name="rate" label={t("tax.ratePercent")} hint={t("tax.rateHint")} inputMode="decimal" defaultValue={rate ? String(rate.rateBps / 100) : ""} required ltr error={fields.rateBps} end={<span className="type-caption">%</span>} />
          <FieldGroup legend={t("tax.kinds")} hint={t("tax.kindsHint")}>
            <div className="flex flex-wrap gap-x-4">
              {PRODUCT_KIND_LIST.map((kind) => (
                <Checkbox key={kind} name="kinds" value={kind} label={t(`productKind.${kind}`)} defaultChecked={rate?.scope.productKinds?.includes(kind) ?? false} />
              ))}
            </div>
          </FieldGroup>
          <FieldGroup legend={t("tax.channels")} hint={t("tax.channelsHint")}>
            <div className="flex flex-wrap gap-x-4">
              {CHANNEL_LIST.map((channel) => (
                <Checkbox key={channel} name="channels" value={channel} label={t(`channel.${channel}`)} defaultChecked={rate?.scope.channels?.includes(channel) ?? false} />
              ))}
            </div>
          </FieldGroup>
          <TextField name="effectiveFrom" type="date" label={t("tax.effectiveFrom")} hint={t("tax.effectiveHint")} defaultValue={from} optional ltr error={fields.effectiveFrom} />
          <Checkbox name="isActive" label={t("tax.activeLabel")} hint={t("tax.activeHint")} defaultChecked={rate?.isActive ?? false} />
          <TextField name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} />
        </>
      )}
    </FormDialog>
  );
}
