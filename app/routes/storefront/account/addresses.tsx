import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type FormEvent } from "react";
import { data, Form, useFetcher, useNavigation, useRevalidator, useRouteLoaderData, useSearchParams } from "react-router";

import type { Route } from "./+types/addresses";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { deleteAddress, listAddresses, listGeography, MAX_ADDRESSES, saveAddress, setDefaultAddress, type AddressInput } from "~/server/services/account/addresses.server";
import { ADDRESS_LIMITS, type AddressView, type GeographyOption } from "~/server/services/account/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FormErrorSummary, Select, TextArea, TextField } from "~/ui/Field";
import { GovernoratePicker } from "~/ui/GovernoratePicker";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { iqdText, isIqd } from "~/ui/PriceTag";
import { Tag } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { LAYOUT_ROUTE_ID } from "../shell/meta";
import type { ShellData } from "../shell/types";
import { accountFailure, formFields, localeRedirect, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { ADDRESS_FIELD_IDS, ADDRESS_FIELDS, addressFieldIssue, addressIssues, firstAddressIssue, type AddressField, type AddressIssues, type FieldIssue } from "./components/address-checks";
import { fieldError, FormFailure, Notice, rescueFocus, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount, PHONE_EXAMPLE } from "./components/text";
import { useHydrated } from "./components/useHydrated";

/**
 * Delivery addresses (Design System v2 §6.12: cards + «أضف عنواناً»): the governorate through the kit's picker (the
 * flat fee on top, as in checkout) and its districts from the shipping geography — the same fields as the checkout,
 * checked as the checkout checks them (components/address-checks: on blur, in the checkout's words, every field before
 * the form is sent, with the error summary). The add / edit form is its own step in the URL (`?new=1`, `?edit=<id>`),
 * so Back closes it; deleting asks first.
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

export const meta: Route.MetaFunction = (args) => {
  const params = new URLSearchParams(args.location.search);
  return accountMeta(args, params.get("new") === "1" ? "addressNew" : params.get("edit") ? "addressEdit" : "addresses");
};

type Answer = ActionAnswer & { intent?: string | null; done?: string; values?: Record<string, string> };

/** «أضف عنواناً» — the list view's one primary (in the head, or in the empty state). */
function AddKey() {
  const t = useT("account");
  return (
    <Key as={LocaleLink} to="/account/addresses?new=1" variant="primary" icon="plus">
      {t("addresses.add")}
    </Key>
  );
}

export default function Addresses({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const [params, setParams] = useSearchParams();
  const editing = params.get("edit");
  const adding = params.get("new") === "1";
  const answer = (actionData ?? null) as Answer | null;
  const failedSave = answer && answer.ok === false && answer.intent === "save" ? answer : null;
  const target = editing ? (loaderData.addresses.find((address) => address.id === editing) ?? null) : null;
  const formOpen = adding || target !== null || failedSave !== null;
  const atLimit = loaderData.addresses.length >= loaderData.max;

  // Saved: say so once, then drop the flag from the address (a reload must not say it again).
  const saved = params.get("saved") === "1";
  useEffect(() => {
    if (!saved) return;
    toast.success(t("addresses.saved"));
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("saved");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [saved, setParams, t]);

  // Deleting lives here, not in the card: the card is gone once the list reloads, the page is not.
  const remover = useFetcher<typeof action>();
  const [deleting, setDeleting] = useState<AddressView | null>(null);
  const handled = useRef<unknown>(null);
  const landing = useRef("addresses-title");
  const revalidator = useRevalidator();
  const removal = (remover.data ?? null) as Answer | null;
  useEffect(() => {
    if (remover.state !== "idle" || !removal || handled.current === removal) return;
    handled.current = removal;
    if (removal.ok && removal.done === "deleted") {
      setDeleting(null);
      toast.success(t("addresses.deleted"));
      // The card and its «احذف» key are gone: focus lands on the card that takes its place (or the page's title when
      // it was the last one), not on <body>.
      rescueFocus(landing.current);
    } else if (!removal.ok) {
      // Refused (already deleted in another tab): the dialog says why, and the cards behind it are read again — a
      // refused answer does not revalidate by itself.
      void revalidator.revalidate();
    }
  }, [remover.state, removal, t, revalidator]);
  const deletingLabel = deleting ? deleting.label || t("addresses.untitled") : "";

  if (formOpen) {
    return (
      <>
        <PageHead back={{ to: "/account/addresses", label: t("addresses.back"), order: sectionOrder("addresses") }} title={target ? t("addresses.editTitle") : t("addresses.newTitle")} />
        <AddressForm key={target?.id ?? "new"} address={target} geography={loaderData.geography} answer={failedSave} />
      </>
    );
  }

  return (
    <>
      <PageHead titleId="addresses-title" title={t("addresses.title")} lead={t("addresses.lead")} aside={!atLimit && loaderData.addresses.length > 0 ? <AddKey /> : null} />
      {atLimit ? <Notice>{t("errors.address_limit")}</Notice> : null}

      {loaderData.addresses.length === 0 ? (
        <EmptyState layout="stack" panel title={t("addresses.emptyTitle")} text={t("addresses.emptyText")} action={<AddKey />} />
      ) : (
        <ul className="grid gap-card md:grid-cols-2">
          {loaderData.addresses.map((address) => (
            <li key={address.id} className="grid">
              <AddressCard address={address} onDelete={() => setDeleting(address)} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => {
          // After a refusal the card that opened the dialog may be gone: focus then lands on the title.
          rescueFocus("addresses-title");
          setDeleting(null);
        }}
        tone="destructive"
        title={t("addresses.deleteQ")}
        consequence={t("addresses.deleteWhat", { label: deletingLabel })}
        confirmLabel={t("addresses.deleteConfirm")}
        cancelLabel={t("common.cancel")}
        pending={remover.state !== "idle"}
        error={removal && removal.ok === false && removal.intent === "delete" ? removal.message : undefined}
        onConfirm={() => {
          if (!deleting) return;
          const list = loaderData.addresses;
          const at = list.findIndex((address) => address.id === deleting.id);
          const neighbour = list[at + 1] ?? list[at - 1];
          landing.current = neighbour ? `address-${neighbour.id}-title` : "addresses-title";
          remover.submit({ intent: "delete", id: deleting.id }, { method: "post" });
        }}
      />
    </>
  );
}

function AddressCard({ address, onDelete }: { address: AddressView; onDelete: () => void }) {
  const t = useT("account");
  const online = useOnline();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  const label = address.label || t("addresses.untitled");
  const answer = (fetcher.data ?? null) as Answer | null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "default") {
      toast.success(t("addresses.defaultSet"));
      // «اجعله الافتراضي» is gone from this card now that it is the default: focus lands on the card's name.
      rescueFocus(`address-${address.id}-title`);
    } else if (answer.ok === false) toast.error(answer.message ?? t("common.formError"));
  }, [fetcher.state, answer, t, address.id]);

  const busy = fetcher.state !== "idle";
  return (
    <article className="acct-card flex flex-col" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={`address-${address.id}-title`} tabIndex={-1} className="acct-card__title">
          {address.label ? <bdi dir="auto">{address.label}</bdi> : label}
        </h2>
        {address.isDefault ? <Tag kind="ok">{t("addresses.isDefault")}</Tag> : null}
      </div>
      {/* what the customer typed in its own direction (`<bdi dir="auto">`): an Arabic address on /en keeps its words and
          punctuation in order (QA 2026-11-13, as the checkout's Typed) */}
      <div className="grid gap-1">
        {address.recipientName || address.phoneE164 ? (
          <p className="type-sm-strong text-ink">
            {address.recipientName ? <bdi dir="auto">{address.recipientName}</bdi> : null}
            {address.recipientName && address.phoneE164 ? " · " : null}
            {address.phoneE164 ? (
              <bdi dir="ltr" className="nums">
                {f.phone(address.phoneE164)}
              </bdi>
            ) : null}
          </p>
        ) : null}
        <p className="type-sm text-ink-2">
          <bdi dir="auto">{[address.governorateName, address.districtName, address.areaText].filter(Boolean).join(f.locale === "en" ? ", " : "، ")}</bdi>
        </p>
        <p className="type-sm text-ink-2">
          <bdi dir="auto">{address.addressText}</bdi>
        </p>
        {address.notes ? (
          <p className="type-xs text-ink-2">
            <bdi dir="auto">{address.notes}</bdi>
          </p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Key as={LocaleLink} to={`/account/addresses?edit=${address.id}`} size="sm" icon="pencil-simple" aria-label={t("addresses.editNamed", { label })}>
          {t("common.edit")}
        </Key>
        {!address.isDefault ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="default" />
            <input type="hidden" name="id" value={address.id} />
            <Key type="submit" size="sm" variant="ghost" aria-label={t("addresses.makeDefaultNamed", { label })} loading={busy && fetcher.formData?.get("intent") === "default"} disabled={!online}>
              {t("addresses.makeDefault")}
            </Key>
          </fetcher.Form>
        ) : null}
        <Key size="sm" variant="ghost" icon="trash" aria-haspopup="dialog" onClick={onDelete} disabled={!online} aria-label={t("addresses.deleteNamed", { label })}>
          {t("common.delete")}
        </Key>
      </div>
    </article>
  );
}

type LayoutData = { shell?: Pick<ShellData, "deliveryFeeIqd"> };

/** Each checked field's label (the error summary names the fields by them). */
const FIELD_LABEL: Record<AddressField, string> = {
  label: "addresses.label",
  recipientName: "addresses.recipient",
  phone: "addresses.phone",
  governorateId: "addresses.governorate",
  districtId: "addresses.district",
  areaText: "addresses.area",
  addressText: "addresses.address",
  notes: "addresses.notes",
};

function AddressForm({ address, geography, answer }: { address: AddressView | null; geography: GeographyOption[]; answer: Answer | null }) {
  const t = useT("account");
  const f = useFormat();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const fee = layout?.shell?.deliveryFeeIqd ?? null;
  const values = answer?.values;
  const pick = (name: string, fallback: string | null | undefined) => values?.[name] ?? fallback ?? "";
  const [governorateId, setGovernorateId] = useState(pick("governorateId", address?.governorateId));
  const [districtId, setDistrictId] = useState(pick("districtId", address?.districtId));
  const pending = navigation.state === "submitting" && navigation.formData?.get("intent") === "save";
  const gov = geography.find((item) => item.id === governorateId) ?? null;
  const hydrated = useHydrated();
  const feeHint = isIqd(fee) ? t("addresses.fee", { fee: amount(iqdText(f, fee)) }) : undefined;
  const fields = ADDRESS_FIELDS.map((name) => ({ name, id: ADDRESS_FIELD_IDS[name], label: t(FIELD_LABEL[name]) }));

  // ── the page's own checks (components/address-checks — the checkout's rules and words, §4.9): a field is checked
  //    when it is left, again on every keystroke once a problem shows, and every field before the form is sent, so an
  //    empty required field never costs a request. The service checks everything again. ──
  const [issues, setIssues] = useState<AddressIssues>({});
  /** Fields the page has checked since the service last answered: their own check speaks for them, not that answer. */
  const [seen, setSeen] = useState<ReadonlySet<AddressField>>(() => new Set());
  // A new answer from the service speaks for every field again.
  const [answered, setAnswered] = useState(answer);
  if (answered !== answer) {
    setAnswered(answer);
    setIssues({});
    setSeen(new Set());
  }
  /**
   * «احفظ العنوان» was refused on the page: the answer the page's error summary stands in for (undefined: none). The
   * service's own summary (FormFailure) comes back only with its next answer — never the stale one, which would move
   * the focus again.
   */
  const [refusedOver, setRefusedOver] = useState<Answer | null | undefined>(undefined);
  const refused = refusedOver !== undefined && refusedOver === answer;
  const issueText = (name: AddressField, issue: FieldIssue | undefined) => (issue ? t(`addresses.fields.${name}.${issue.code}`, issue.count === undefined ? undefined : { count: issue.count, n: f.number(issue.count) }) : undefined);
  // The service's answer (a save posted without script, or a rule only the service knows): each field it named, in the
  // page's own words where the page's checks agree («اكتب المنطقة أو الحي.», not «هذا الحقل مطلوب.»), else in its own.
  const posted = values ? addressIssues(values) : {};
  const errorOf = (name: AddressField): string | undefined => {
    if (seen.has(name)) return issueText(name, issues[name]);
    const server = fieldError(answer, name);
    return server === undefined ? undefined : (issueText(name, posted[name]) ?? server);
  };
  const check = (name: AddressField, value: string) => {
    const issue = addressFieldIssue(name, value);
    setIssues((current) => {
      if (!issue && !current[name]) return current;
      const next = { ...current };
      if (issue) next[name] = issue;
      else delete next[name];
      return next;
    });
    setSeen((current) => (current.has(name) ? current : new Set(current).add(name)));
  };
  /** Typing checks the field again only while it shows a problem (the message goes as soon as the text is right). */
  const recheck = (name: AddressField, value: string) => {
    if (errorOf(name) !== undefined) check(name, value);
  };
  const text = (name: AddressField) => ({
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => check(name, event.currentTarget.value),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => recheck(name, event.currentTarget.value),
    error: errorOf(name),
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const sent = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    // the picker's value is the page's (its hidden field carries the same value once script runs)
    const found = addressIssues({ ...sent, governorateId });
    const first = firstAddressIssue(found);
    // nothing the page can see: the form goes to the service, which checks everything again
    if (!first) return;
    event.preventDefault();
    setIssues(found);
    setSeen(new Set(ADDRESS_FIELDS));
    setRefusedOver(answer);
    document.getElementById(ADDRESS_FIELD_IDS[first])?.focus();
  };
  // the page's summary lists what is still wrong (it shrinks as each field is put right); else the service's
  const stillWrong = fields.filter((field) => issues[field.name] !== undefined).map(({ id, label }) => ({ id, label }));
  const summary = refused ? <FormErrorSummary errors={stillWrong} /> : <FormFailure answer={answer} fields={fields} />;

  return (
    // `replace`: once saved, Back goes to the page before the form, not to the form again (the saved list replaces it).
    <Form method="post" replace className="acct-card acct-narrow" noValidate onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="save" />
      {address ? <input type="hidden" name="id" value={address.id} /> : null}
      {summary}
      <div className="grid gap-4 md:grid-cols-2">
        <TextField id="address-label" name="label" label={t("addresses.label")} hint={t("addresses.labelHint")} optional maxLength={ADDRESS_LIMITS.label} defaultValue={pick("label", address?.label)} {...text("label")} />
        <TextField id="address-recipient" name="recipientName" autoComplete="name" label={t("addresses.recipient")} optional maxLength={ADDRESS_LIMITS.recipient} defaultValue={pick("recipientName", address?.recipientName)} {...text("recipientName")} />
        <TextField
          id="address-phone"
          className="md:col-span-2"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          label={t("addresses.phone")}
          hint={t("addresses.phoneHint", { example: PHONE_EXAMPLE })}
          optional
          maxLength={ADDRESS_LIMITS.phone}
          defaultValue={pick("phone", address?.phoneE164 ? address.phoneE164.replace(/^\+964/, "0") : "")}
          {...text("phone")}
        />
        {/*
          The kit's picker needs script. It takes the field's name (and the id the error summary links to) once script
          runs; until then — and for good without script — a native select inside <noscript> is the governorate field,
          as before the v2 rebuild. Never both: the form sends one governorateId.
        */}
        <GovernoratePicker
          id={hydrated ? "address-governorate" : "address-governorate-picker"}
          name={hydrated ? "governorateId" : undefined}
          className="noscript:hidden"
          label={t("addresses.governorate")}
          required
          placeholder={t("addresses.chooseGovernorate")}
          governorates={geography}
          feeIqd={fee}
          hint={feeHint}
          value={governorateId}
          onChange={(id) => {
            setGovernorateId(id);
            setDistrictId("");
            // a choice answers «اختر المحافظة التي نوصل إليها.» at once
            check("governorateId", id);
          }}
          error={errorOf("governorateId")}
        />
        <noscript>
          <Select id="address-governorate" name="governorateId" autoComplete="address-level1" label={t("addresses.governorate")} required defaultValue={governorateId} hint={feeHint} error={errorOf("governorateId")}>
            <option value="">{t("addresses.chooseGovernorate")}</option>
            {geography.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </noscript>
        <Select
          id="address-district"
          name="districtId"
          autoComplete="address-level2"
          label={t("addresses.district")}
          optional
          value={districtId}
          onChange={(event) => {
            setDistrictId(event.target.value);
            check("districtId", event.target.value);
          }}
          error={errorOf("districtId")}
        >
          <option value="">{t("addresses.chooseDistrict")}</option>
          {gov && hydrated
            ? gov.districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))
            : geography.map((item) => (
                // Before a governorate is chosen (or without script, where the governorate can change without this
                // list following), every district is listed under its governorate.
                <optgroup key={item.id} label={item.name}>
                  {item.districts.map((district) => (
                    <option key={district.id} value={district.id}>
                      {district.name}
                    </option>
                  ))}
                </optgroup>
              ))}
        </Select>
        <TextField id="address-area" className="md:col-span-2" name="areaText" autoComplete="address-level3" label={t("addresses.area")} required defaultValue={pick("areaText", address?.areaText)} {...text("areaText")} />
      </div>
      <TextArea id="address-text" name="addressText" autoComplete="street-address" label={t("addresses.address")} hint={t("addresses.addressHint")} required defaultValue={pick("addressText", address?.addressText)} {...text("addressText")} />
      <TextArea id="address-notes" name="notes" rows={2} label={t("addresses.notes")} optional defaultValue={pick("notes", address?.notes)} {...text("notes")} />
      {!address?.isDefault ? <Checkbox name="makeDefault" value="1" label={t("addresses.setDefault")} defaultChecked={values?.makeDefault === "1"} /> : null}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <SubmitKey variant="primary" pending={pending} icon="floppy-disk">
          {t("addresses.save")}
        </SubmitKey>
        <Key as={LocaleLink} to="/account/addresses" variant="ghost">
          {t("common.cancel")}
        </Key>
      </div>
    </Form>
  );
}
