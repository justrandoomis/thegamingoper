import { useMemo, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/journal-new";
import { useFormat } from "~/i18n/react";
import { randomToken } from "~/lib/ids";
import { manualEntryOptions, postManualEntry } from "~/server/services/admin/finance/ledger.server";
import { baghdadDay, MAX_MANUAL_LINES, parseAmount, periodDays, shiftPeriod } from "~/server/services/admin/finance/types";
import { Select, TextArea, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { all, failed, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Failure, failureOf, Ledger, Money, Note, PageHead, Section, useFinT } from "./ui";

/**
 * /admin/finance/journal/new — 10.01: a manual journal entry (finance.journal.post + the books). Balanced or refused,
 * dated in an open month (the database refuses a closed one), never on the wallet liability (its subledger is the
 * wallet), with a reason kept in the audit trail. A resubmitted form posts once (the key travels with the form).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.journal.post");
  const options = await orRespond(() => manualEntryOptions(db, actor, locale));
  return { options, today: baghdadDay(now), key: randomToken(18) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.journal.post");
  const form = await request.formData();
  const accounts = all(form, "line.account");
  const debits = all(form, "line.debit");
  const credits = all(form, "line.credit");
  const centers = all(form, "line.center");
  const memos = all(form, "line.memo");
  const lines = accounts
    .map((accountId, i) => ({ accountId, debitIqd: parseAmount(debits[i] ?? ""), creditIqd: parseAmount(credits[i] ?? ""), costCenter: centers[i] || undefined, memo: memos[i] || undefined }))
    .filter((line) => line.accountId || line.debitIqd !== undefined || line.creditIqd !== undefined);
  try {
    const { entryId } = await postManualEntry(req.db, req.actor, { date: text(form, "date"), memo: text(form, "memo"), reason: text(form, "reason"), lines, idempotencyKey: text(form, "key") }, req.now);
    return redirect(`/admin/finance/journal/${entryId}?posted=1`);
  } catch (error) {
    return failed(error, req.locale, "post");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "manual.title");

type Line = { id: number; account: string; debit: string; credit: string; center: string; memo: string };

export default function ManualEntryPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = failureOf(result);
  const { options, today, key } = loaderData;
  // nothing may be dated on or before the last closed month: the first day after it is the earliest date
  const lastClosed = options.closed.length ? options.closed[options.closed.length - 1] : null;
  const earliest = lastClosed ? periodDays(shiftPeriod(lastClosed, 1)).first : undefined;
  const [lines, setLines] = useState<Line[]>(() => [0, 1, 2, 3].map((id) => ({ id, account: "", debit: "", credit: "", center: "", memo: "" })));
  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let bad = false;
    for (const line of lines) {
      const d = parseAmount(line.debit);
      const c = parseAmount(line.credit);
      if (Number.isNaN(d) || Number.isNaN(c)) bad = true;
      debit += d && !Number.isNaN(d) ? d : 0;
      credit += c && !Number.isNaN(c) ? c : 0;
    }
    return { debit, credit, bad };
  }, [lines]);
  const update = (id: number, patch: Partial<Line>) => setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  const fieldError = (name: string) => failure?.fields?.[name];
  const pending = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const difference = totals.debit - totals.credit;
  const accountOptions = [{ value: "", label: t("manual.chooseAccount") }, ...options.accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))];
  const centerOptions = [{ value: "", label: t("manual.noCenter") }, ...options.costCenters.map((center) => ({ value: center.code, label: `${center.code} · ${center.name}` }))];

  return (
    <div className="adm-narrow max-w-5xl">
      <PageHead eyebrow={<Link to="/admin/finance/journal" className="adm-link">{t("manual.back")}</Link>} title={t("manual.title")} lead={t("manual.lead")} />
      <Note icon="lock">
        <p>{t("manual.rules")}</p>
      </Note>

      <Form method="post" className="mt-5 grid gap-5" noValidate>
        <input type="hidden" name="key" value={key} />
        <Section id="manual-head" title={t("manual.what")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="date" type="date" label={t("manual.date")} hint={t("manual.dateHint")} defaultValue={today} min={earliest} max={today} required ltr error={fieldError("date")} />
            <TextField name="memo" label={t("manual.memo")} hint={t("manual.memoHint")} required maxLength={200} error={fieldError("memo")} />
          </div>
        </Section>

        <Section id="manual-lines" title={t("manual.lines")} aside={<span className="type-caption text-ink-2">{t("manual.linesHint", { max: MAX_MANUAL_LINES })}</span>}>
          <ol className="fin-lines">
            {lines.map((line, index) => (
              <li key={line.id} className="fin-line">
                <Select name="line.account" label={t("manual.account", { n: index + 1 })} options={accountOptions} value={line.account} onChange={(event) => update(line.id, { account: event.target.value })} error={fieldError(`lines.${index}.accountId`)} />
                <TextField name="line.debit" label={t("manual.debit")} inputMode="numeric" value={line.debit} onChange={(event) => update(line.id, { debit: event.target.value, credit: event.target.value ? "" : line.credit })} error={fieldError(`lines.${index}.amount`)} end={<span className="type-caption">{t("common.iqd")}</span>} />
                <TextField name="line.credit" label={t("manual.credit")} inputMode="numeric" value={line.credit} onChange={(event) => update(line.id, { credit: event.target.value, debit: event.target.value ? "" : line.debit })} end={<span className="type-caption">{t("common.iqd")}</span>} />
                <Select name="line.center" label={t("manual.center")} options={centerOptions} value={line.center} onChange={(event) => update(line.id, { center: event.target.value })} error={fieldError(`lines.${index}.costCenter`)} />
                <TextField name="line.memo" label={t("manual.lineMemo")} value={line.memo} maxLength={200} onChange={(event) => update(line.id, { memo: event.target.value })} />
                <IconKey icon="trash" className="justify-self-end" label={t("manual.removeLine", { n: index + 1 })} disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} />
              </li>
            ))}
          </ol>
          <div>
            <Key type="button" size="sm" icon="plus" disabled={lines.length >= MAX_MANUAL_LINES} onClick={() => setLines((current) => [...current, { id: Math.max(...current.map((l) => l.id)) + 1, account: "", debit: "", credit: "", center: "", memo: "" }])}>
              {t("manual.addLine")}
            </Key>
          </div>
          <Ledger
            className="adm-card max-w-md"
            rows={[
              { label: t("manual.totalDebit"), value: <Money iqd={totals.debit} /> },
              { label: t("manual.totalCredit"), value: <Money iqd={totals.credit} /> },
              { label: t("manual.difference"), value: difference === 0 ? <span className="text-ok">{t("manual.balanced")}</span> : <Money iqd={Math.abs(difference)} className="text-red-ink" />, strong: true },
            ]}
          />
          {difference !== 0 && totals.debit + totals.credit > 0 ? (
            <p className="type-caption text-red-ink" role="status">
              {t("manual.offBy", { amount: f.iqd(Math.abs(difference)) })}
            </p>
          ) : null}
          {totals.bad ? <p className="type-caption text-red-ink">{t("manual.wholeDinars")}</p> : null}
          {fieldError("lines") ? <p className="type-caption text-red-ink">{fieldError("lines")}</p> : null}
        </Section>

        <Section id="manual-reason" title={t("manual.reasonTitle")}>
          <TextArea name="reason" label={t("common.reason")} hint={t("manual.reasonHint")} required minLength={3} maxLength={500} rows={3} error={fieldError("reason")} />
        </Section>

        <Failure message={failure && !failure.fields ? failure.message : failure?.fields ? t("common.checkFields") : null} />
        <div className="flex flex-wrap gap-2">
          {/* posting is final (corrections are reversals), so it is the screen's one commit */}
          <Key type="submit" variant="commit" icon="seal-check" loading={pending} disabled={difference !== 0 || totals.debit === 0}>
            {t("manual.post", { amount: f.iqd(totals.debit) })}
          </Key>
          <Key as={Link} to="/admin/finance/journal">
            {t("common.back")}
          </Key>
        </div>
      </Form>
    </div>
  );
}
