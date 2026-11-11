import { data, Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/guides";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { listGuides, modelOptions, saveGuide } from "~/server/services/admin/devices/guides.server";
import { GRADE_LIST, MAX_DEDUCTIONS, NEW_DEDUCTION_ROWS, type GuideRow } from "~/server/services/admin/devices/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { failure, openDevices, text } from "./devices.server";
import { devicesMeta } from "./meta";
import { Failure, Money, Name, Ref, Section, useDevicesT, When, type ActionFailure } from "./ui";

/**
 * /admin/devices/guides — trade-in price guides (13.03): per device model (or one exact variant) the reference market
 * price of a grade-A+ unit, the share each grade is worth, and what each missing accessory takes off. `?edit=<id>` or
 * `?new=1` opens the form (devices.price_guide.manage); every change is audited before/after. The storefront prices
 * its estimate ranges from the model's active guide; the admin shows the guide's suggestion beside each inspection.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, ["devices.price_guide.manage", "devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"]);
  const search = new URL(request.url).searchParams;
  try {
    const guides = await listGuides(db, actor, locale);
    const canEdit = can(actor, "devices.price_guide.manage");
    const editId = search.get("edit");
    const editing = canEdit && editId ? (guides.find((guide) => guide.id === editId) ?? null) : null;
    return { guides, canEdit, editing, creating: canEdit && search.get("new") === "1", models: canEdit ? await modelOptions(db, actor, locale) : [], saved: search.get("saved") === "1" };
  } catch (error) {
    throwAsResponse(error);
  }
}

function deductionsFrom(form: FormData) {
  const out: { key: string; amountIqd: string }[] = [];
  for (let index = 0; index < MAX_DEDUCTIONS + NEW_DEDUCTION_ROWS; index++) {
    const key = text(form, `d.${index}.key`);
    const amount = text(form, `d.${index}.amount`);
    if (!key && !amount) continue;
    out.push({ key, amountIqd: amount });
  }
  return out;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openDevices(context, "devices.price_guide.manage");
  const form = await request.formData();
  const expected = text(form, "expectedUpdatedAt");
  try {
    await saveGuide(
      db,
      actor,
      {
        guideId: text(form, "guideId"),
        ...(expected ? { expectedUpdatedAt: Number(expected) } : {}),
        deviceModelId: text(form, "deviceModelId"),
        variantCode: text(form, "variantCode"),
        baseIqd: text(form, "baseIqd"),
        multipliers: Object.fromEntries(GRADE_LIST.map((grade) => [grade, text(form, `m.${grade}`) || undefined])),
        deductions: deductionsFrom(form),
        isActive: form.get("isActive") === "on",
        reason: text(form, "reason"),
      },
      now,
    );
    return redirect("/admin/devices/guides?saved=1");
  } catch (error) {
    const result = failure(error, locale, "guide");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "guides.title");

export default function GuidesPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const f = useFormat();
  const navigation = useNavigation();
  const failed = useActionData<typeof action>() as ActionFailure | undefined;
  const fields = failed?.fields ?? {};
  const { guides, canEdit, editing, creating, models, saved } = loaderData;
  const columns: DataColumn<GuideRow>[] = [
    {
      key: "model",
      header: t("guides.col.model"),
      cell: (row) => (
        <span className="grid py-1">
          <Name text={row.model} />
          <span className="type-caption text-ink-2">{row.variant ? <Ref value={row.variant.sku} /> : t("guides.allVariants")}</span>
        </span>
      ),
    },
    { key: "base", header: t("guides.col.base"), numeric: true, cell: (row) => <Money iqd={row.baseIqd} /> },
    ...GRADE_LIST.map((grade): DataColumn<GuideRow> => ({ key: grade, header: grade, numeric: true, cell: (row) => (typeof row.multipliers[grade] === "number" ? <bdi className="nums">{f.number((row.multipliers[grade] as number) / 100)} %</bdi> : "—") })),
    { key: "deductions", header: t("guides.col.deductions"), cell: (row) => (row.deductions.length ? row.deductions.map((line) => `${t(`accessory.${line.key}`)} −${f.iqd(line.amountIqd)}`).join("، ") : "—") },
    { key: "active", header: t("guides.col.active"), cell: (row) => <span className="dev-tag">{row.isActive ? t("guides.active") : t("guides.inactive")}</span> },
    { key: "updated", header: t("guides.col.updated"), cell: (row) => <span className="grid whitespace-nowrap"><When at={row.updatedAt} style="date" /><span className="type-caption text-ink-2">{row.updatedBy ?? "—"}</span></span> },
    ...(canEdit ? [{ key: "edit", header: t("guides.col.edit"), cell: (row: GuideRow) => <Key as={Link} to={`/admin/devices/guides?edit=${row.id}#guide-form`} size="sm" icon="pencil-simple">{t("guides.edit")}</Key> } satisfies DataColumn<GuideRow>] : []),
  ];
  const form = editing ?? (creating ? null : undefined);
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("guides.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("guides.lead")}</p>
        {canEdit && !creating ? (
          <div>
            <Key as={Link} to="/admin/devices/guides?new=1#guide-form" icon="plus" variant="ink">
              {t("guides.new")}
            </Key>
          </div>
        ) : null}
        {saved && !failed ? (
          <p className="type-body" role="status">
            {t("guides.saved")}
          </p>
        ) : null}
      </header>

      {form !== undefined ? (
        <Section id="guide-form" title={editing ? t("guides.editTitle", { model: editing.model }) : t("guides.newTitle")}>
          <Form method="post" className="grid max-w-[52rem] gap-4" noValidate>
            <input type="hidden" name="guideId" value={editing?.id ?? ""} />
            <input type="hidden" name="expectedUpdatedAt" value={editing?.updatedAt ?? ""} />
            <div className="dev-grid-2">
              <Select name="deviceModelId" label={t("guides.model")} required defaultValue={editing?.modelId ?? ""} error={fields.deviceModelId} options={[{ value: "", label: t("counter.chooseModel") }, ...models.map((model) => ({ value: model.id, label: model.platform ? `${model.name} · ${model.platform}` : model.name }))]} />
              <TextField name="variantCode" label={t("guides.variant")} optional ltr defaultValue={editing?.variant?.sku ?? ""} error={fields.variantCode} hint={t("guides.variantHint")} />
              <TextField name="baseIqd" label={t("guides.base")} required inputMode="numeric" ltr defaultValue={editing ? String(editing.baseIqd) : ""} error={fields.baseIqd} hint={t("guides.baseHint")} end={<span className="type-caption">{t("iqd")}</span>} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="type-label">{t("guides.multipliers")}</legend>
              <p className="type-caption text-ink-2">{t("guides.multipliersHint")}</p>
              <div className="dev-fields dev-fields--4">
                {GRADE_LIST.map((grade) => (
                  <TextField key={grade} name={`m.${grade}`} label={`${grade} · ${t(`gradeWord.${grade}`)}`} inputMode="numeric" ltr defaultValue={editing && typeof editing.multipliers[grade] === "number" ? String((editing.multipliers[grade] as number) / 100) : grade === "A+" ? "100" : ""} error={fields[`multipliers.${grade}`]} end={<span className="type-caption">%</span>} />
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="type-label">{t("guides.deductions")}</legend>
              <p className="type-caption text-ink-2">{t("guides.deductionsHint")}</p>
              <div className="dev-rows">
                {[...(editing?.deductions ?? []), ...Array.from({ length: NEW_DEDUCTION_ROWS }, () => null)].map((line, index) => (
                  <div key={index} className="dev-grid-2">
                    <TextField name={`d.${index}.key`} label={t("guides.deductionKey")} ltr defaultValue={line?.key ?? ""} error={fields[`deductions.${index}.key`]} hint={index === 0 ? t("guides.deductionKeyHint") : undefined} />
                    <TextField name={`d.${index}.amount`} label={t("guides.deductionAmount")} inputMode="numeric" ltr defaultValue={line ? String(line.amountIqd) : ""} error={fields[`deductions.${index}.amountIqd`]} end={<span className="type-caption">{t("iqd")}</span>} />
                  </div>
                ))}
              </div>
            </fieldset>
            <Checkbox name="isActive" label={t("guides.isActive")} hint={t("guides.isActiveHint")} defaultChecked={editing ? editing.isActive : true} />
            <TextField name="reason" label={t("guides.reason")} required error={fields.reason} hint={t("guides.reasonHint")} />
            <Failure message={failed && !failed.fields ? failed.message : null} />
            <div className="dev-actions">
              <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting"}>
                {t("guides.save")}
              </Key>
              <Key as={Link} to="/admin/devices/guides">
                {t("cancel")}
              </Key>
            </div>
          </Form>
        </Section>
      ) : null}

      <Section id="guides-list" title={t("guides.list")}>
        {guides.length === 0 ? (
          <EmptyState title={t("guides.empty")} text={t("guides.emptyHint")} icon="coins" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("guides.list")} columns={columns} rows={guides} rowKey={(row) => row.id} rowLabel={(row) => row.model} maxHeight={null} />
            </div>
            <ul className="dev-cards md:hidden" aria-label={t("guides.list")}>
              {guides.map((row) => (
                <li key={row.id} className="dev-card">
                  <span className="dev-card__top">
                    <span className="type-strong">
                      <Name text={row.model} />
                    </span>
                    <span className="dev-tag">{row.isActive ? t("guides.active") : t("guides.inactive")}</span>
                  </span>
                  <span className="dev-card__top type-body">
                    <span>{t("guides.col.base")}</span>
                    <Money iqd={row.baseIqd} />
                  </span>
                  <span className="type-caption text-ink-2">{GRADE_LIST.map((grade) => `${grade} ${typeof row.multipliers[grade] === "number" ? f.number((row.multipliers[grade] as number) / 100) : "—"}%`).join(" · ")}</span>
                  {canEdit ? (
                    <span>
                      <Key as={Link} to={`/admin/devices/guides?edit=${row.id}#guide-form`} size="sm" icon="pencil-simple">
                        {t("guides.edit")}
                      </Key>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
