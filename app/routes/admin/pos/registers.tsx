import { useState } from "react";

import type { Route } from "./+types/registers";
import { throwAsResponse } from "~/server/errors";
import { listRegisters, registerFormOptions, saveRegister } from "~/server/services/admin/pos/registers.server";
import { posAccess, POS_READERS } from "~/server/services/admin/pos/shared.server";
import type { RegisterRow } from "~/server/services/admin/pos/types";
import { Dialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { posMeta } from "./meta";
import { checked, failed, openPos, text } from "./pos.server";
import { Failure, Notice, Ref, useIntent, usePosT, When } from "./ui";

/**
 * /admin/pos/registers — the tills (06.01, 06.04): each sells from one inventory location of kind "store" (the shop's
 * stock IS the website's stock, through the commerce core) and may belong to a branch. Everyone with a POS permission
 * sees them and who works on them now; pos.register.manage adds one, renames it, moves it to another store location
 * or switches it off — never under an open shift — with a reason, audited.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, POS_READERS);
  try {
    const access = posAccess(actor);
    return { registers: await listRegisters(db, actor, locale), options: access.registers ? await registerFormOptions(db, actor, locale) : null, access };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPos(context, "pos.register.manage");
  const form = await request.formData();
  try {
    const result = await saveRegister(
      db,
      actor,
      { registerId: text(form, "registerId") || undefined, code: text(form, "code"), name: text(form, "name"), locationId: text(form, "locationId"), branchId: text(form, "branchId") || null, isActive: checked(form, "isActive"), reason: text(form, "reason") || null },
      now,
    );
    return { ok: true as const, intent: "save", replayed: !result.changed, registerId: result.registerId };
  } catch (error) {
    return failed(error, locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "registers.title");

type Data = Route.ComponentProps["loaderData"];

export default function Registers({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { registers, options, access } = loaderData;
  const [editing, setEditing] = useState<RegisterRow | "new" | null>(null);
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("registers.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("registers.lead")}</p>
      </header>
      {access.registers ? (
        <div className="pos-actions mb-4">
          <Key variant="ink" icon="plus" onClick={() => setEditing("new")} disabled={!options?.locations.length}>
            {t("registers.add")}
          </Key>
          {!options?.locations.length ? <span className="type-caption text-ink-2">{t("registers.noStores")}</span> : null}
        </div>
      ) : (
        <div className="mb-4">
          <Notice>{t("registers.readOnly")}</Notice>
        </div>
      )}
      {registers.length === 0 ? (
        <EmptyState title={t("registers.empty")} text={access.registers ? t("registers.emptyManager") : t("registers.emptyHint")} icon="storefront" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t("registers.title")}>
          {registers.map((register) => (
            <li key={register.id} className="adm-card">
              <div className="pos-card__row">
                <span className="type-strong">
                  <Ref value={register.code} /> · {register.name}
                </span>
                {!register.isActive ? <Status tone="neutral">{t("registers.off")}</Status> : register.openShift ? <Status tone="ok">{t("registers.inUse")}</Status> : <Status tone="neutral">{t("registers.free")}</Status>}
              </div>
              <p className="type-caption text-ink-2">
                {register.location ? (
                  <>
                    {t("registers.sellsFrom")} <Ref value={register.location.code} /> · {register.location.name}
                    {register.location.kind !== "store" || !register.location.isActive ? ` · ${t("registers.locationInvalid")}` : ""}
                  </>
                ) : (
                  t("registers.noLocation")
                )}
              </p>
              <p className="type-caption text-ink-2">{register.branch ? t("registers.branch", { name: register.branch.name }) : t("registers.noBranch")}</p>
              {register.openShift ? (
                <p className="type-caption text-ink-2">
                  {t("registers.openBy", { name: register.openShift.openedBy })} · <When at={register.openShift.openedAt} />
                </p>
              ) : null}
              {access.registers ? (
                <div className="pos-actions">
                  <Key size="sm" icon="pencil-simple" onClick={() => setEditing(register)}>
                    {t("registers.edit")}
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing && options ? <RegisterDialog register={editing === "new" ? null : editing} options={options} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function RegisterDialog({ register, options, onClose }: { register: RegisterRow | null; options: NonNullable<Data["options"]>; onClose: () => void }) {
  const t = usePosT();
  const { fetcher, pending, message, fields } = useIntent("save", register ? "done.registerSaved" : "done.registerAdded", onClose);
  const formId = "register-form";
  const locations = options.locations.some((location) => location.id === register?.location?.id) || !register?.location ? options.locations : [...options.locations, { id: register.location.id, code: register.location.code, name: register.location.name }];
  return (
    <Dialog
      open
      onClose={onClose}
      title={register ? t("registers.editTitle", { code: register.code }) : t("registers.addTitle")}
      dismissible={!pending}
      footer={
        <>
          <Key onClick={onClose} disabled={pending}>
            {t("dialog.back")}
          </Key>
          <Key type="submit" form={formId} variant="ink" loading={pending}>
            {register ? t("registers.save") : t("registers.create")}
          </Key>
        </>
      }
    >
      <fetcher.Form id={formId} method="post" className="grid gap-3">
        {register ? <input type="hidden" name="registerId" value={register.id} /> : null}
        <TextField name="code" label={t("registers.code")} hint={t("registers.codeHint")} ltr required defaultValue={register?.code ?? ""} error={fields.code} autoComplete="off" />
        <TextField name="name" label={t("registers.name")} required defaultValue={register?.name ?? ""} error={fields.name} />
        <Select name="locationId" label={t("registers.location")} hint={t("registers.locationHint")} required defaultValue={register?.location?.id ?? options.locations[0]?.id} error={fields.locationId} options={locations.map((location) => ({ value: location.id, label: `${location.code} · ${location.name}` }))} />
        <Select name="branchId" label={t("registers.branchField")} optional defaultValue={register?.branch?.id ?? ""} error={fields.branchId} options={[{ value: "", label: t("registers.noBranch") }, ...options.branches.map((branch) => ({ value: branch.id, label: `${branch.code} · ${branch.name}` }))]} />
        <Checkbox name="isActive" label={t("registers.active")} defaultChecked={register ? register.isActive : true} />
        {register ? <TextField name="reason" label={t("registers.reason")} hint={t("registers.reasonHint")} required error={fields.reason} /> : null}
        <Failure message={message} />
      </fetcher.Form>
    </Dialog>
  );
}

