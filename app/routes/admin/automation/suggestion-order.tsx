import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/suggestion-order";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { COST_CURRENCIES } from "~/server/services/admin/pricing/rules";
import { createDraftOrder, draftOrderForm } from "~/server/services/admin/automation/suggestions.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { all, automation, newKey, text } from "./automation.server";
import { Code, DemoTag, FormError, Note, PageHead, Section, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/suggestions/order?ids=… — open reorder suggestions → ONE draft purchase order of module 09
 * (automation.suggestion.approve + purchasing.po.create + cost.read): supplier, destination, currency, rate and unit
 * costs to confirm (the last price paid is shown with cost.read), quantities prefilled with the suggestion. The draft
 * moves nothing: 09's own page submits it, where the spending limit and a second person decide.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.suggestion.approve");
  const ids = new URL(args.request.url).searchParams.getAll("ids");
  const form = await automation.orRespond(() => draftOrderForm(req.db, req.actor, ids, req.locale));
  return { form, key: newKey() };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args, "automation.suggestion.approve");
  try {
    const form = await automation.form(args.request);
    const ids = all(form, "suggestionIds");
    const result = await createDraftOrder(
      req.db,
      req.actor,
      {
        suggestionIds: ids,
        supplierId: text(form, "supplierId"),
        locationId: text(form, "locationId"),
        currency: text(form, "currency"),
        fxRate: text(form, "fxRate") || undefined,
        expectedOn: text(form, "expectedOn") || undefined,
        notes: text(form, "notes"),
        lines: ids.map((id) => ({ suggestionId: id, qty: text(form, `qty_${id}`), unitCost: text(form, `cost_${id}`) })),
        idempotencyKey: text(form, "idempotencyKey"),
      },
      req.now,
      req.locale,
    );
    return redirect(can(req.actor, "purchasing.po.read") ? `/admin/purchasing/orders/${result.poId}` : "/admin/automation/suggestions?view=approved");
  } catch (error) {
    return automation.failed(error, req, "draft");
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "order.title");

export default function SuggestionOrderPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { form, key } = loaderData;
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement | null>(null);
  const confirmed = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [currency, setCurrency] = useState(form.currency);
  const failure = actionData && actionData.ok === false ? actionData : null;
  const fields = failure?.fields ?? {};
  // a refused draft: the next submit (with corrected lines) shows its impact again before it is sent
  useEffect(() => {
    if (actionData) confirmed.current = false;
  }, [actionData]);
  const units = form.lines.reduce((sum, line) => sum + line.qty, 0);
  const blocked = form.missingPermissions.length > 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!confirmed.current) {
      event.preventDefault();
      setConfirming(true);
    }
  };
  const decimals = (code: string) => (COST_CURRENCIES as Record<string, number>)[code] ?? 0;

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/automation/suggestions" className="adm-link">
            {t("suggestions.title")}
          </Link>
        }
        title={t("order.title")}
        lead={t("order.lead")}
      />
      {form.skipped > 0 ? (
        <Note tone="warn" icon="warning">
          <p>{t("order.skipped", { count: form.skipped })}</p>
        </Note>
      ) : null}
      {blocked ? (
        <Note tone="warn" icon="lock">
          <p>{t("order.missing", { permissions: form.missingPermissions.join(t("common.listSep")) })}</p>
        </Note>
      ) : null}
      {form.lines.length === 0 ? (
        <Note icon="info">
          <p>{t("order.nothing")}</p>
          <p>
            <Link to="/admin/automation/suggestions" className="adm-link">
              {t("order.back")}
            </Link>
          </p>
        </Note>
      ) : (
        <Form method="post" ref={formRef} onSubmit={onSubmit} className="auto-form" noValidate>
          <input type="hidden" name="idempotencyKey" value={key} />
          {form.lines.map((line) => (
            <input key={line.suggestionId} type="hidden" name="suggestionIds" value={line.suggestionId} />
          ))}
          <fieldset className="auto-fieldset">
            <legend className="adm-h3">{t("order.header")}</legend>
            {form.demo ? (
              <p className="type-caption text-ink-2">
                <DemoTag /> {t("order.demo")}
              </p>
            ) : null}
            <div className="auto-grid">
              <Select name="supplierId" label={t("order.supplier")} defaultValue={form.supplierId ?? ""} placeholder={t("order.chooseSupplier")} options={form.suppliers} error={fields.supplierId} required disabled={blocked} />
              <Select name="locationId" label={t("order.location")} defaultValue={form.locationId ?? ""} options={form.locations} error={fields.locationId} required disabled={blocked} />
              <Select
                name="currency"
                label={t("order.currency")}
                value={currency}
                onChange={(change) => setCurrency(change.currentTarget.value)}
                options={Object.keys(COST_CURRENCIES).map((code) => ({ value: code, label: code }))}
                error={fields.currency}
                disabled={blocked}
              />
              {currency !== "IQD" ? <TextField name="fxRate" label={t("order.fxRate")} hint={t("order.fxRateHint", { currency })} inputMode="decimal" error={fields.fxRate} disabled={blocked} optional /> : null}
              <TextField name="expectedOn" type="date" label={t("order.expectedOn")} error={fields.expectedOn} disabled={blocked} optional />
            </div>
            <TextArea name="notes" label={t("order.notes")} rows={2} maxLength={300} error={fields.notes} disabled={blocked} optional />
          </fieldset>

          <Section id="auto-order-lines" title={t("order.lines")} aside={<span className="type-caption text-ink-2">{t("order.units", { count: units })}</span>}>
            <ul role="list" className="grid gap-2">
              {form.lines.map((line, index) => (
                <li key={line.suggestionId} className="adm-card gap-2">
                  <p className="type-strong">
                    <bdi>{line.name}</bdi>
                  </p>
                  <p className="type-caption text-ink-2">
                    <Code>{line.sku}</Code>
                    {line.lastUnitCost ? (
                      <>
                        {" · "}
                        {t("order.lastCost", { cost: f.number(line.lastUnitCost.minor / 10 ** line.lastUnitCost.decimals, { minimumFractionDigits: line.lastUnitCost.decimals }), currency: line.lastUnitCost.currency })}
                      </>
                    ) : null}
                  </p>
                  <div className="auto-grid">
                    <TextField name={`qty_${line.suggestionId}`} label={t("order.qty")} inputMode="numeric" defaultValue={String(line.qty)} error={fields[`lines.${index}.qty`]} disabled={blocked} required />
                    <TextField
                      name={`cost_${line.suggestionId}`}
                      label={t("order.unitCost", { currency })}
                      hint={decimals(currency) ? t("order.unitCostHintDecimals", { decimals: decimals(currency) }) : t("order.unitCostHint")}
                      inputMode="decimal"
                      error={fields[`lines.${index}.unitCost`] ?? fields[`lines.${index}.code`]}
                      defaultValue={line.lastUnitCost && line.lastUnitCost.currency === currency ? String(line.lastUnitCost.minor / 10 ** line.lastUnitCost.decimals) : ""}
                      disabled={blocked}
                      required
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          {fields.lines ? <FormError message={fields.lines} /> : null}
          <Note icon="shield-check" tone="ok">
            <p>{t("order.safeguard")}</p>
          </Note>
          <FormError message={failure?.message ?? (failure && !Object.keys(fields).length ? t("common.checkFields") : null)} />
          <div className="auto-actions">
            <Key type="submit" variant="primary" loading={navigation.state === "submitting"} disabled={blocked}>
              {t("order.submit")}
            </Key>
            <Key as={Link} to="/admin/automation/suggestions" variant="ghost">
              {t("common.back")}
            </Key>
          </div>
        </Form>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("order.confirmTitle")}
        consequence={t("order.confirmConsequence")}
        confirmLabel={t("confirm.createDraft")}
        cancelLabel={t("common.back")}
        impact={[
          { label: t("order.lines"), value: f.number(form.lines.length) },
          { label: t("order.confirmUnits"), value: f.number(units) },
          { label: t("rules.runMoves"), value: t("rules.runMovesNothing") },
        ]}
        onConfirm={() => {
          confirmed.current = true;
          setConfirming(false);
          formRef.current?.requestSubmit();
        }}
      />
    </>
  );
}
