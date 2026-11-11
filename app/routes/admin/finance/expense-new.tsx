import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/expense-new";
import { useFormat } from "~/i18n/react";
import { randomToken } from "~/lib/ids";
import { MAX_UPLOAD_BODY_BYTES, readFormData } from "~/server/body.server";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { createExpense, CreateExpenseInput, expenseIdFor } from "~/server/services/accounting/expenses.server";
import { expenseFormOptions } from "~/server/services/admin/finance/expense-views.server";
import { baghdadDay } from "~/server/services/admin/finance/types";
import { saveImageUpload } from "~/server/uploads.server";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { financeBlobStore } from "./env.server";
import { amount, failed, openFinance, optionalText, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { FileField, Failure, failureOf, Note, PageHead, Section, useFinT } from "./ui";

/** `files.kind` of an expense receipt (a private file). */
const RECEIPT_KIND = "expense_receipt";

/**
 * /admin/finance/expenses/new — 10.05: record an expense (finance.expense.manage). It is saved as a draft — not in the
 * books until someone approves it (above the limit, someone other than whoever recorded it). An optional photo of the
 * receipt goes through the upload pipeline and is stored privately. A resubmitted form records it once.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.expense.manage");
  const options = await orRespond(() => expenseFormOptions(db, actor, locale));
  return { options, today: baghdadDay(now), key: randomToken(18) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.expense.manage");
  try {
    const form = await readFormData(request, MAX_UPLOAD_BODY_BYTES);
    const key = text(form, "key");
    const input = {
      accountId: text(form, "accountId"),
      paidFromAccountId: text(form, "paidFromAccountId"),
      costCenter: optionalText(form, "costCenter"),
      amountIqd: amount(form, "amountIqd") as number,
      vendor: optionalText(form, "vendor"),
      description: text(form, "description"),
      incurredOn: text(form, "incurredOn"),
      idempotencyKey: key,
    };
    // the form's own mistakes first: a photo is stored only for a form that can be saved (no orphaned private files)
    CreateExpenseInput.parse(input);
    let receiptFileId: string | undefined;
    const file = form.get("receipt");
    if (file instanceof File && file.size > 0 && key.length >= 8) {
      await enforceRateLimit(req.db, await limitKey("upload", "employee", req.actor.id), RATE_LIMITS.upload, req.now);
      const saved = await saveImageUpload(req.db, financeBlobStore(), file, { visibility: "private", kind: RECEIPT_KIND, ownerType: "expense", ownerId: await expenseIdFor(key), createdBy: req.actor, now: req.now });
      receiptFileId = saved.file.id;
    }
    const { expenseId } = await createExpense(req.db, req.actor, { ...input, receiptFileId }, req.now);
    return redirect(`/admin/finance/expenses/${expenseId}?created=1`);
  } catch (error) {
    return failed(error, req.locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "expenseNew.title");

export default function NewExpensePage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const navigation = useNavigation();
  const failure = failureOf(useActionData<typeof action>());
  const { options, today, key } = loaderData;
  const fields = failure?.fields ?? {};
  const busy = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const defaultPaidFrom = options.paidFrom.find((account) => account.systemKey === "cash")?.id ?? options.paidFrom[0]?.id ?? "";
  const defaultAccount = options.accounts.find((account) => account.systemKey === "operating_expenses")?.id ?? options.accounts[0]?.id ?? "";

  return (
    <div className="adm-narrow">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/expenses" className="adm-link">
            {t("expenseNew.back")}
          </Link>
        }
        title={t("expenseNew.title")}
        lead={t("expenseNew.lead", { limit: f.iqd(options.threshold) })}
      />
      <Form method="post" encType="multipart/form-data" className="grid gap-5" noValidate>
        <input type="hidden" name="key" value={key} />
        <Section id="exp-what" title={t("expenseNew.what")}>
          <TextField name="description" label={t("expenseNew.description")} hint={t("expenseNew.descriptionHint")} required maxLength={300} error={fields.description} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="amountIqd" label={t("expenseNew.amount")} inputMode="numeric" required error={fields.amountIqd} end={<span className="type-caption">{t("common.iqd")}</span>} />
            <TextField name="incurredOn" type="date" label={t("expenseNew.date")} hint={t("expenseNew.dateHint")} defaultValue={today} max={today} required ltr error={fields.incurredOn} />
          </div>
          <TextField name="vendor" label={t("expenseNew.vendor")} optional maxLength={120} error={fields.vendor} />
        </Section>
        <Section id="exp-books" title={t("expenseNew.books")}>
          <Select name="accountId" label={t("expenseNew.account")} hint={t("expenseNew.accountHint")} defaultValue={defaultAccount} options={options.accounts.map((account) => ({ value: account.id, label: account.label }))} error={fields.accountId} />
          <Select name="paidFromAccountId" label={t("expenseNew.paidFrom")} hint={t("expenseNew.paidFromHint")} defaultValue={defaultPaidFrom} options={options.paidFrom.map((account) => ({ value: account.id, label: account.label }))} error={fields.paidFromAccountId} />
          <Select
            name="costCenter"
            label={t("expenseNew.center")}
            hint={options.costCenters.length ? t("expenseNew.centerHint") : t("expenseNew.noCenters")}
            defaultValue=""
            options={[{ value: "", label: t("expenseNew.noCenter") }, ...options.costCenters.map((center) => ({ value: center.code, label: `${center.code} · ${center.name}` }))]}
            error={fields.costCenter}
          />
        </Section>
        <Section id="exp-receipt" title={t("expenseNew.receipt")}>
          <FileField name="receipt" label={t("expenseNew.receiptFile")} accept="image/jpeg,image/png,image/webp" hint={t("expenseNew.receiptHint")} error={fields.file} />
        </Section>
        <Note>
          <p>{t("expenseNew.draftNote")}</p>
        </Note>
        <Failure message={failure && !failure.fields ? failure.message : failure?.fields ? t("common.checkFields") : null} />
        <div className="flex flex-wrap gap-2">
          <Key type="submit" variant="ink" icon="floppy-disk" loading={busy}>
            {t("expenseNew.save")}
          </Key>
          <Key as={Link} to="/admin/finance/expenses">
            {t("common.back")}
          </Key>
        </div>
      </Form>
    </div>
  );
}
