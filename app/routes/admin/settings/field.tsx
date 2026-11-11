import { useMemo, useState } from "react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/field";
import { useFormat } from "~/i18n/react";
import { getCustomField, productCountsByKind, saveCustomField, setCustomFieldActive } from "~/server/services/admin/settings/custom-fields.server";
import { FIELD_KINDS, FIELD_TYPES, parseWhole } from "~/server/services/admin/settings/catalog";
import { assertCan, can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Note, PageHead, Pair, Section, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { checked, ok, text } from "../security/route-kit.server";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/fields/:fieldId ("new" for a new one) — 22.03: one custom field: label in three languages, the
 * product kind it applies to, its type and options, required or not, offered as a storefront filter, its order. The
 * key is chosen once. Saving shows what it does to products first (how many live products of the kind have no value
 * and stay on sale as incomplete, how many drafts cannot be published until filled) and needs a reason.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await settingsKit.open(context, "settings.read");
  const counts = await productCountsByKind(db);
  if (params.fieldId === "new") {
    // a role that may not add fields gets a 403 page, like every other page it may not use
    await settingsKit.orRespond(async () => assertCan(actor, "settings.custom_field.manage"));
    return { field: null, counts, canManage: true };
  }
  return { field: await settingsKit.orRespond(() => getCustomField(db, actor, params.fieldId, locale)), counts, canManage: can(actor, "settings.custom_field.manage") };
}

/** "value | label ar | label en" per line → options. */
function optionsFrom(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", labelAr = "", labelEn = ""] = line.split("|").map((part) => part.trim());
      return { value: value.toLowerCase(), labelAr: labelAr || value, ...(labelEn ? { labelEn } : {}) };
    });
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const OPTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The checks the server makes on the form (its error keys), shown on the fields before the dialog opens. */
function formErrors(values: { key: string; labelAr: string; options: string }, withOptions: boolean, creating: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const key = values.key.trim();
  if (creating && !KEY_PATTERN.test(key)) errors.key = key ? "key_invalid" : "required";
  if (values.labelAr.trim().length < 2) errors.labelAr = "required";
  if (withOptions) {
    const options = optionsFrom(values.options);
    if (options.length === 0) errors.options = "required";
    else if (options.some((option) => !OPTION_PATTERN.test(option.value))) errors.options = "option_invalid";
    else if (new Set(options.map((option) => option.value)).size !== options.length) errors.options = "option_duplicate";
  }
  return errors;
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await settingsKit.open(context, "settings.custom_field.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent === "save") {
      const result = await saveCustomField(
        req.db,
        req.actor,
        {
          fieldId: params.fieldId === "new" ? undefined : params.fieldId,
          version: text(form, "version") || undefined,
          key: text(form, "key"),
          productKind: text(form, "productKind"),
          labelAr: text(form, "labelAr"),
          labelEn: text(form, "labelEn") || undefined,
          labelCkb: text(form, "labelCkb") || undefined,
          type: text(form, "type"),
          options: optionsFrom(text(form, "options")),
          required: checked(form, "required"),
          filterable: checked(form, "filterable"),
          sort: parseWhole(text(form, "sort")) ?? 0,
          reason: text(form, "reason"),
        },
        req.now,
      );
      if (result.created) throw redirect(`/admin/settings/fields/${result.fieldId}`);
      return ok(intent, result);
    }
    if (intent === "active") return ok(intent, await setCustomFieldActive(req.db, req.actor, { fieldId: params.fieldId, active: text(form, "active") === "1", reason: text(form, "reason") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    if (error instanceof Response) throw error;
    return settingsKit.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, args.loaderData?.field ? "field.title" : "field.newTitle", { label: args.loaderData?.field?.label ?? "" });

export default function FieldPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { field, counts, canManage } = loaderData;
  const [values, setValues] = useState(() => ({
    key: field?.key ?? "",
    productKind: (field?.productKind ?? "*") as string,
    labelAr: field?.labelL10n.ar ?? "",
    labelEn: field?.labelL10n.en ?? "",
    labelCkb: field?.labelL10n.ckb ?? "",
    type: (field?.type ?? "text") as string,
    options: (field?.options ?? []).map((option) => [option.value, option.labelL10n.ar, option.labelL10n.en ?? ""].filter((part, index) => index < 2 || part).join(" | ")).join("\n"),
    required: field?.required ?? false,
    filterable: field?.filterable ?? false,
    sort: String(field?.sort ?? 0),
  }));
  const [open, setOpen] = useState(false);
  const [toggle, setToggle] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorText = (name: string) => (errors[name] ? t(`errors.${errors[name]}`) : undefined);
  const set = (patch: Partial<typeof values>) => setValues((current) => ({ ...current, ...patch }));
  const withOptions = values.type === "select" || values.type === "multiselect";
  const impact = useMemo(() => {
    const scope = counts[values.productKind] ?? { live: 0, drafts: 0 };
    // an existing field of the same kind: what its values already cover; a new one (or another kind): nothing yet
    const sameKind = field && field.productKind === values.productKind;
    const live = sameKind ? field.usage.liveMissing : scope.live;
    const drafts = sameKind ? field.usage.draftMissing : scope.drafts;
    return { live, drafts };
  }, [counts, field, values.productKind]);
  const editable = canManage;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/settings/fields" className="adm-link">
            {t("fields.title")}
          </Link>
        }
        title={field ? field.label : t("field.newTitle")}
        lead={t("field.lead")}
      />
      <div className="sec-split mt-5">
        <form
          className="adm-card grid gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!editable) return;
            const found = formErrors(values, withOptions, !field);
            setErrors(found);
            if (Object.keys(found).length === 0) setOpen(true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t("field.key")} hint={field ? t("field.keyLocked") : t("field.keyHint")} ltr value={values.key} onChange={(event) => set({ key: event.currentTarget.value.toLowerCase() })} readOnly={Boolean(field)} required error={errorText("key")} />
            <Select label={t("fields.col.kind")} value={values.productKind} onChange={(event) => set({ productKind: event.currentTarget.value })} options={FIELD_KINDS.map((kind) => ({ value: kind, label: t(`kinds.${kind === "*" ? "all" : kind}`) }))} disabled={!editable} />
            <TextField label={t("field.labelAr")} value={values.labelAr} onChange={(event) => set({ labelAr: event.currentTarget.value })} required readOnly={!editable} error={errorText("labelAr")} />
            <TextField label={t("field.labelEn")} value={values.labelEn} onChange={(event) => set({ labelEn: event.currentTarget.value })} optional readOnly={!editable} />
            <TextField label={t("field.labelCkb")} value={values.labelCkb} onChange={(event) => set({ labelCkb: event.currentTarget.value })} optional readOnly={!editable} />
            <Select label={t("fields.col.type")} value={values.type} onChange={(event) => set({ type: event.currentTarget.value })} options={FIELD_TYPES.map((type) => ({ value: type, label: t(`types.${type}`) }))} hint={field && field.usage.withValue > 0 ? t("field.typeLocked") : undefined} disabled={!editable || Boolean(field && field.usage.withValue > 0)} />
            <TextField label={t("field.sort")} inputMode="numeric" value={values.sort} onChange={(event) => set({ sort: event.currentTarget.value.replace(/[^0-9٠-٩]/g, "") })} readOnly={!editable} />
          </div>
          {withOptions ? <TextArea label={t("field.options")} hint={t("field.optionsHint")} rows={5} value={values.options} onChange={(event) => set({ options: event.currentTarget.value })} readOnly={!editable} dir="ltr" required error={errorText("options")} /> : null}
          <Checkbox label={t("field.required")} hint={t("field.requiredHint")} checked={values.required} onChange={(event) => set({ required: event.currentTarget.checked })} disabled={!editable} />
          <Checkbox label={t("field.filterable")} hint={t("field.filterableHint")} checked={values.filterable} onChange={(event) => set({ filterable: event.currentTarget.checked })} disabled={!editable} />
          {editable ? (
            <div className="sec-actions">
              <Key type="submit" size="sm" variant="ink" icon="floppy-disk">
                {field ? t("field.save") : t("field.create")}
              </Key>
            </div>
          ) : null}
        </form>
        <aside className="grid min-w-0 gap-3">
          {field ? (
            <div className="adm-card gap-1.5">
              <Pair label={t("fields.col.values")}>{f.number(field.usage.withValue)}</Pair>
              <Pair label={t("field.liveMissing")}>{f.number(field.usage.liveMissing)}</Pair>
              <Pair label={t("field.draftMissing")}>{f.number(field.usage.draftMissing)}</Pair>
              <Pair label={t("fields.col.state")}>
                <Status tone={field.isActive ? "ok" : "neutral"}>{field.isActive ? t("fields.active") : t("fields.inactive")}</Status>
              </Pair>
              {editable ? (
                <div>
                  <Key size="sm" onClick={() => setToggle(true)}>
                    {field.isActive ? t("field.deactivate") : t("field.activate")}
                  </Key>
                </div>
              ) : null}
            </div>
          ) : null}
          <Note>
            <p>{t("field.where")}</p>
          </Note>
        </aside>
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={field ? t("field.saveTitle", { label: values.labelAr || values.key }) : t("field.createTitle", { label: values.labelAr || values.key })}
        consequence={values.required ? t("field.requiredConsequence") : t("field.optionalConsequence")}
        confirmLabel={field ? t("field.save") : t("field.create")}
        impact={[
          { label: t("fields.col.kind"), value: t(`kinds.${values.productKind === "*" ? "all" : values.productKind}`) },
          { label: t("field.liveMissing"), value: f.number(impact.live), negative: values.required && impact.live > 0 },
          { label: t("field.draftMissing"), value: f.number(impact.drafts), negative: values.required && impact.drafts > 0 },
          { label: t("fields.col.required"), value: values.required ? t("fields.required") : t("fields.optional") },
        ]}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "save", version: field?.version ?? "", key: values.key, productKind: values.productKind, labelAr: values.labelAr, labelEn: values.labelEn, labelCkb: values.labelCkb, type: values.type, options: withOptions ? values.options : "", required: values.required ? "1" : "", filterable: values.filterable ? "1" : "", sort: values.sort }}
        successMessage={t("field.saved")}
      />
      {field ? (
        <ActionDialog
          open={toggle}
          onClose={() => setToggle(false)}
          title={field.isActive ? t("field.deactivateTitle") : t("field.activateTitle")}
          consequence={field.isActive ? t("field.deactivateConsequence") : t("field.activateConsequence")}
          confirmLabel={field.isActive ? t("field.deactivate") : t("field.activate")}
          impact={[{ label: t("fields.col.values"), value: f.number(field.usage.withValue) }]}
          reason={{ label: t("common.reason") }}
          fields={{ intent: "active", active: field.isActive ? "0" : "1" }}
          successMessage={t("field.saved")}
        />
      ) : null}
    </>
  );
}
