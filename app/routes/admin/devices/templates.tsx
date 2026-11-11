import { data, Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/templates";
import { canAny } from "~/server/actor";
import { DEVICES_PERMISSIONS } from "~/server/services/admin/devices/shared.server";
import { getTemplateEditor, listTemplates, saveTemplate } from "~/server/services/admin/devices/templates.server";
import { INPUT_LIST, INSPECTION_KIND_LIST, NEW_TEMPLATE_ROWS } from "~/server/services/admin/devices/types";
import type { InspectionKind } from "~/server/db/schema";
import { throwAsResponse } from "~/server/errors";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { failure, openDevices, text } from "./devices.server";
import { devicesMeta } from "./meta";
import { templateItemsFrom } from "./templates.server";
import { Failure, Section, useDevicesT, When, type ActionFailure } from "./ui";

/**
 * /admin/devices/templates — the inspection checklists (13.02): one per kind (console, handheld PC, controller,
 * headset, other hardware, used game — disc, case, region and platform: 13.05), with their items, which are required
 * and which are critical. `?kind=<kind>` opens the editor (devices.inspection_template.manage); a save is a NEW version
 * and the older ones are switched off, so filled checklists keep their own words. The form works without JavaScript:
 * blank rows add items, "keep" unticked removes one, the position orders them.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, DEVICES_PERMISSIONS);
  const kindParam = new URL(request.url).searchParams.get("kind");
  const kind = (INSPECTION_KIND_LIST as readonly string[]).includes(kindParam ?? "") ? (kindParam as InspectionKind) : null;
  try {
    return { list: await listTemplates(db, actor, locale), editor: kind ? await getTemplateEditor(db, actor, kind, locale) : null, canEdit: canAny(actor, ["devices.inspection_template.manage"]), saved: new URL(request.url).searchParams.get("saved") === "1" };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openDevices(context, "devices.inspection_template.manage");
  const form = await request.formData();
  const kind = text(form, "kind");
  const expected = text(form, "expectedVersion");
  try {
    await saveTemplate(db, actor, { kind, expectedVersion: expected === "" ? null : Number(expected), name: { ar: text(form, "nameAr"), en: text(form, "nameEn"), ckb: text(form, "nameCkb") }, items: templateItemsFrom(form), reason: text(form, "reason") }, now);
    return redirect(`/admin/devices/templates?kind=${encodeURIComponent(kind)}&saved=1`);
  } catch (error) {
    const result = failure(error, locale, "template");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "templates.title");

export default function TemplatesPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const navigation = useNavigation();
  const failed = useActionData<typeof action>() as ActionFailure | undefined;
  const fields = failed?.fields ?? {};
  const { list, editor, canEdit, saved } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("templates.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("templates.lead")}</p>
      </header>

      <Section id="templates-list" title={t("templates.list")}>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {INSPECTION_KIND_LIST.map((kind) => {
            const entry = list.find((item) => item.kind === kind);
            return (
              <li key={kind}>
                <Link to={`/admin/devices/templates?kind=${kind}`} className="dev-card" aria-current={editor?.kind === kind ? "true" : undefined}>
                  <span className="dev-card__top">
                    <span className="type-strong">{t(`kind.${kind}`)}</span>
                    {entry ? <span className="dev-tag">{t("templates.version", { n: entry.version })}</span> : <span className="dev-tag">{t("templates.none")}</span>}
                  </span>
                  {entry ? (
                    <>
                      <span className="type-body">{entry.name}</span>
                      <span className="type-caption text-ink-2">{t("templates.itemsCount", { count: entry.items, critical: entry.critical })}</span>
                      <span className="type-caption text-ink-2">
                        <When at={entry.updatedAt} style="date" /> {entry.updatedBy ? `· ${entry.updatedBy}` : ""}
                      </span>
                    </>
                  ) : (
                    <span className="type-caption text-ink-2">{t("templates.noneHint")}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </Section>

      {editor ? (
        <Section id="template-editor" title={t("templates.editorTitle", { kind: t(`kind.${editor.kind}`) })}>
          {saved && !failed ? (
            <p className="type-body" role="status">
              {t("templates.saved")}
            </p>
          ) : null}
          {editor.versions.length > 0 ? <p className="type-caption text-ink-2">{t("templates.versions", { list: editor.versions.map((version) => `v${version.version}${version.isActive ? "*" : ""}`).join(" · ") })}</p> : null}
          {canEdit ? (
            <Form method="post" className="grid gap-4" noValidate key={`${editor.kind}-${editor.current?.version ?? 0}`}>
              <input type="hidden" name="kind" value={editor.kind} />
              <input type="hidden" name="expectedVersion" value={editor.current?.version ?? ""} />
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField name="nameAr" label={t("templates.nameAr")} required defaultValue={editor.current?.name.ar ?? ""} error={fields["name.ar"]} />
                <TextField name="nameEn" label={t("templates.nameEn")} required defaultValue={editor.current?.name.en ?? ""} error={fields["name.en"]} dir="ltr" />
                <TextField name="nameCkb" label={t("templates.nameCkb")} optional defaultValue={editor.current?.name.ckb ?? ""} />
              </div>
              <div className="dev-rows">
                {[...(editor.current?.items ?? []).map((item) => ({ item, isNew: false })), ...Array.from({ length: NEW_TEMPLATE_ROWS }, () => ({ item: null, isNew: true }))].map(({ item, isNew }, index) => (
                  <fieldset key={index} className="dev-row">
                    <legend className="type-label">{isNew ? t("templates.newItem") : t("templates.item", { n: index + 1 })}</legend>
                    <input type="hidden" name={`i.${index}.new`} value={isNew ? "1" : "0"} />
                    <div className="dev-fields dev-fields--4">
                      <TextField name={`i.${index}.key`} label={t("templates.key")} defaultValue={item?.key ?? ""} ltr error={fields[`items.${index}.key`]} hint={isNew ? t("templates.keyHint") : undefined} readOnly={!isNew} />
                      <TextField name={`i.${index}.ar`} label={t("templates.labelAr")} defaultValue={item?.label.ar ?? ""} error={fields[`items.${index}.label.ar`]} />
                      <TextField name={`i.${index}.en`} label={t("templates.labelEn")} defaultValue={item?.label.en ?? ""} error={fields[`items.${index}.label.en`]} dir="ltr" />
                      <TextField name={`i.${index}.ckb`} label={t("templates.labelCkb")} optional defaultValue={item?.label.ckb ?? ""} />
                      <TextField name={`i.${index}.hintAr`} label={t("templates.hintAr")} optional defaultValue={item?.hint?.ar ?? ""} />
                      <TextField name={`i.${index}.hintEn`} label={t("templates.hintEn")} optional defaultValue={item?.hint?.en ?? ""} dir="ltr" />
                      <Select name={`i.${index}.input`} label={t("templates.input")} defaultValue={item?.input ?? "pass_fail"} options={INPUT_LIST.map((input) => ({ value: input, label: t(`input.${input}`) }))} />
                      <TextField name={`i.${index}.position`} label={t("templates.position")} inputMode="numeric" ltr defaultValue={String(index + 1)} />
                    </div>
                    <div className="dev-actions">
                      <Checkbox name={`i.${index}.required`} label={t("templates.required")} defaultChecked={item?.required ?? true} />
                      <Checkbox name={`i.${index}.critical`} label={t("templates.critical")} defaultChecked={item?.critical === true} error={fields[`items.${index}.critical`]} />
                      {!isNew ? <Checkbox name={`i.${index}.keep`} label={t("templates.keep")} defaultChecked /> : null}
                    </div>
                  </fieldset>
                ))}
              </div>
              <TextField name="reason" label={t("templates.reason")} required error={fields.reason} hint={t("templates.reasonHint")} />
              <Failure message={failed && (!failed.fields || failed.fields.items) ? (failed.fields?.items ? t(`errors.${failed.fields.items}`) : failed.message) : null} />
              <div>
                <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting"}>
                  {t("templates.save")}
                </Key>
              </div>
            </Form>
          ) : editor.current ? (
            <ul className="dev-checklist">
              {editor.current.items.map((item) => (
                <li key={item.key}>
                  <span>
                    {item.label.ar} {item.critical ? <span className="dev-tag ms-2">{t("checklist.critical")}</span> : null}
                  </span>
                  <span className="type-caption text-ink-2">
                    {t(`input.${item.input}`)} · {item.required ? t("templates.required") : t("optional")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body text-ink-2">{t("templates.noneHint")}</p>
          )}
        </Section>
      ) : null}
    </>
  );
}
