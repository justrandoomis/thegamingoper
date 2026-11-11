import { useEffect, useRef, useState } from "react";
import { data, Form, useFetcher, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/addresses";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { deleteAddress, listAddresses, listGeography, MAX_ADDRESSES, saveAddress, setDefaultAddress, type AddressInput } from "~/server/services/account/addresses.server";
import type { AddressView, GeographyOption } from "~/server/services/account/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, localeRedirect, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { AnswerNotice, fieldError, FormNotice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { PHONE_EXAMPLE } from "./components/text";

/**
 * Delivery addresses (brief §3.10): governorates and districts from the shipping geography, the same fields as the
 * checkout. The add / edit form is part of the URL (`?new=1`, `?edit=<id>`), so it works before JavaScript and Back
 * closes it; deleting asks first.
 */
export const handle = { nav: "push", order: sectionOrder("addresses") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const [addresses, geography] = await Promise.all([listAddresses(db, customer.id, ctx.locale), listGeography(db, ctx.locale)]);
  return { addresses, geography, max: MAX_ADDRESSES };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    switch (fields.intent) {
      case "save": {
        // Raw form strings: the service parses and validates every field (zod).
        await saveAddress(db, actor, { ...fields, id: fields.id || undefined, makeDefault: fields.makeDefault === "1" } as AddressInput, ctx.now);
        return localeRedirect("/account/addresses?saved=1", ctx.locale);
      }
      case "delete":
        await deleteAddress(db, actor, fields.id ?? "", ctx.now);
        return data({ ok: true as const, done: "deleted" as const });
      case "default":
        await setDefaultAddress(db, actor, fields.id ?? "", ctx.now);
        return data({ ok: true as const, done: "default" as const });
      default:
        return data({ ok: false as const, code: "invalid" }, { status: 400 });
    }
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, intent: fields.intent ?? null, values: fields }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "addresses");

type Answer = ActionAnswer & { intent?: string | null; done?: string; values?: Record<string, string> };

export default function Addresses({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const [params] = useSearchParams();
  const editing = params.get("edit");
  const adding = params.get("new") === "1";
  const saved = params.get("saved") === "1";
  const answer = (actionData ?? null) as Answer | null;
  const failedSave = answer && answer.ok === false && answer.intent === "save" ? answer : null;
  const target = editing ? (loaderData.addresses.find((address) => address.id === editing) ?? null) : null;
  const formOpen = adding || target !== null || failedSave !== null;
  const atLimit = loaderData.addresses.length >= loaderData.max;

  // Deleting lives here, not in the card: the card is gone once the list reloads, the page is not.
  const remover = useFetcher<typeof action>();
  const [deleting, setDeleting] = useState<AddressView | null>(null);
  const handled = useRef<unknown>(null);
  const removal = (remover.data ?? null) as Answer | null;
  useEffect(() => {
    if (remover.state !== "idle" || !removal || handled.current === removal) return;
    handled.current = removal;
    if (removal.ok && removal.done === "deleted") {
      setDeleting(null);
      toast.success(t("addresses.deleted"));
    }
  }, [remover.state, removal, t]);
  const deletingLabel = deleting ? deleting.label || t("addresses.untitled") : "";

  return (
    <>
      <PageHead
        title={t("addresses.title")}
        lead={t("addresses.lead")}
        aside={
          !formOpen && !atLimit && loaderData.addresses.length > 0 ? (
            <Key as={LocaleLink} to="/account/addresses?new=1" preventScrollReset icon="plus" size="sm">
              {t("addresses.add")}
            </Key>
          ) : null
        }
      />
      {saved && !formOpen ? <FormNotice tone="ok">{t("addresses.saved")}</FormNotice> : null}
      {atLimit && !target ? <FormNotice tone="info">{t("errors.address_limit")}</FormNotice> : null}

      {formOpen ? (
        <AddressForm key={target?.id ?? "new"} address={target} geography={loaderData.geography} answer={failedSave} />
      ) : loaderData.addresses.length === 0 ? (
        <EmptyState
          layout="stack"
          icon="map-pin"
          title={t("addresses.emptyTitle")}
          text={t("addresses.emptyText")}
          action={
            <Key as={LocaleLink} to="/account/addresses?new=1" preventScrollReset icon="plus">
              {t("addresses.add")}
            </Key>
          }
        />
      ) : null}

      {loaderData.addresses.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {loaderData.addresses.map((address) => (
            <li key={address.id}>
              <AddressCard address={address} onDelete={() => setDeleting(address)} />
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="destructive"
        title={t("addresses.deleteQ")}
        consequence={t("addresses.deleteWhat", { label: deletingLabel })}
        confirmLabel={t("addresses.deleteConfirm")}
        cancelLabel={t("common.cancel")}
        pending={remover.state !== "idle"}
        error={removal && removal.ok === false && removal.intent === "delete" ? removal.message : undefined}
        onConfirm={() => {
          if (deleting) remover.submit({ intent: "delete", id: deleting.id }, { method: "post" });
        }}
      />
    </>
  );
}

function AddressCard({ address, onDelete }: { address: AddressView; onDelete: () => void }) {
  const t = useT("account");
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  const label = address.label || t("addresses.untitled");
  const answer = (fetcher.data ?? null) as Answer | null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "default") toast.success(t("addresses.defaultSet"));
    else if (answer.ok === false) toast.error(answer.message ?? t("common.formError"));
  }, [fetcher.state, answer, t]);

  const busy = fetcher.state !== "idle";
  return (
    <article className="grid h-full content-start gap-2 rounded-lg bg-paper p-4" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="type-sub text-ink">{label}</h2>
        {address.isDefault ? <Status tone="ok">{t("addresses.isDefault")}</Status> : null}
      </div>
      {address.recipientName || address.phoneE164 ? (
        <p className="type-body text-ink">
          {address.recipientName}
          {address.recipientName && address.phoneE164 ? " · " : null}
          {address.phoneE164 ? (
            <bdi dir="ltr" className="nums">
              {f.phone(address.phoneE164)}
            </bdi>
          ) : null}
        </p>
      ) : null}
      <p className="type-body text-ink-2">
        {[address.governorateName, address.districtName, address.areaText].filter(Boolean).join("، ")}
        <br />
        {address.addressText}
      </p>
      {address.notes ? <p className="type-caption text-ink-2">{address.notes}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Key as={LocaleLink} to={`/account/addresses?edit=${address.id}`} preventScrollReset size="sm" icon="pencil-simple" aria-label={t("addresses.editNamed", { label })}>
          {t("common.edit")}
        </Key>
        {!address.isDefault ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="default" />
            <input type="hidden" name="id" value={address.id} />
            <Key type="submit" size="sm" variant="quiet" loading={busy && fetcher.formData?.get("intent") === "default"}>
              {t("addresses.makeDefault")}
            </Key>
          </fetcher.Form>
        ) : null}
        <Key size="sm" variant="quiet" icon="trash" aria-haspopup="dialog" onClick={onDelete} aria-label={t("addresses.deleteNamed", { label })}>
          {t("common.delete")}
        </Key>
      </div>
    </article>
  );
}

function AddressForm({ address, geography, answer }: { address: AddressView | null; geography: GeographyOption[]; answer: Answer | null }) {
  const t = useT("account");
  const navigation = useNavigation();
  const values = answer?.values;
  const pick = (name: string, fallback: string | null | undefined) => values?.[name] ?? fallback ?? "";
  const [governorateId, setGovernorateId] = useState(pick("governorateId", address?.governorateId));
  const [districtId, setDistrictId] = useState(pick("districtId", address?.districtId));
  const pending = navigation.state === "submitting" && navigation.formData?.get("intent") === "save";
  const gov = geography.find((item) => item.id === governorateId) ?? null;
  const heading = address ? t("addresses.editTitle") : t("addresses.newTitle");

  return (
    <section aria-labelledby="address-form-title" className="grid gap-4 rounded-lg bg-paper p-4 sm:p-6">
      <h2 id="address-form-title" className="type-sub text-ink">
        {heading}
      </h2>
      <AnswerNotice answer={answer && answer.code !== "invalid" ? answer : null} />
      <Form method="post" className="grid gap-4" noValidate preventScrollReset>
        <input type="hidden" name="intent" value="save" />
        {address ? <input type="hidden" name="id" value={address.id} /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <TextField name="label" label={t("addresses.label")} hint={t("addresses.labelHint")} optional defaultValue={pick("label", address?.label)} error={fieldError(answer, "label")} />
          <TextField name="recipientName" autoComplete="name" label={t("addresses.recipient")} optional defaultValue={pick("recipientName", address?.recipientName)} error={fieldError(answer, "recipientName")} />
          <TextField
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            label={t("addresses.phone")}
            hint={t("addresses.phoneHint", { example: PHONE_EXAMPLE })}
            optional
            defaultValue={pick("phone", address?.phoneE164 ? address.phoneE164.replace(/^\+964/, "0") : "")}
            error={fieldError(answer, "phone")}
          />
          <Select
            name="governorateId"
            label={t("addresses.governorate")}
            required
            placeholder={t("addresses.chooseGovernorate")}
            value={governorateId}
            onChange={(event) => {
              setGovernorateId(event.target.value);
              setDistrictId("");
            }}
            options={geography.map((item) => ({ value: item.id, label: item.name }))}
            error={fieldError(answer, "governorateId")}
          />
          <Select
            name="districtId"
            label={t("addresses.district")}
            optional
            value={districtId}
            onChange={(event) => setDistrictId(event.target.value)}
            error={fieldError(answer, "districtId")}
          >
            <option value="">{t("addresses.chooseDistrict")}</option>
            {gov
              ? gov.districts.map((district) => (
                  <option key={district.id} value={district.id}>
                    {district.name}
                  </option>
                ))
              : geography.map((item) => (
                  // Before a governorate is chosen (or without script) every district is listed under its governorate.
                  <optgroup key={item.id} label={item.name}>
                    {item.districts.map((district) => (
                      <option key={district.id} value={district.id}>
                        {district.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
          </Select>
          <TextField name="areaText" label={t("addresses.area")} required defaultValue={pick("areaText", address?.areaText)} error={fieldError(answer, "areaText")} />
        </div>
        <TextArea name="addressText" autoComplete="street-address" label={t("addresses.address")} hint={t("addresses.addressHint")} required defaultValue={pick("addressText", address?.addressText)} error={fieldError(answer, "addressText")} />
        <TextArea name="notes" rows={2} label={t("addresses.notes")} optional defaultValue={pick("notes", address?.notes)} error={fieldError(answer, "notes")} />
        {!address?.isDefault ? <Checkbox name="makeDefault" value="1" label={t("addresses.setDefault")} defaultChecked={values?.makeDefault === "1"} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitKey pending={pending} icon="floppy-disk">
            {t("addresses.save")}
          </SubmitKey>
          <Key as={LocaleLink} to="/account/addresses" preventScrollReset variant="quiet">
            {t("common.cancel")}
          </Key>
        </div>
      </Form>
    </section>
  );
}
