import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT, type Formatters } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Checkbox, FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Niche } from "~/ui/Niche";
import { fillNodes, PriceTag } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { TextLink } from "~/ui/TextLink";
import { WalletBalance } from "~/ui/WalletBalance";
import { isTransferMethod, OTHER_DISTRICT, WINDOWS, type CheckoutDraft, type FieldIssue, type FieldIssues, type FieldName } from "../checkout-form";
import type { CheckoutPageData } from "../checkout.server";
import { TransferDetails } from "./TransferDetails";

/**
 * The three checkout steps (DESIGN.md §8.6, §9.9, §9.17; brief §4): the address (contact and delivery), the payment
 * method, the review. They are plain views of the page's draft: every change goes up through `onChange`, every blur
 * through `onBlur`, and the page decides which issues to show (checked on blur, re-checked on every keystroke once
 * one shows). Field ids are `co-<field>`, so the page can move focus to the first field with a problem.
 */
export type StepProps = {
  draft: CheckoutDraft;
  /** The issues to show now (the page filters by touched fields). */
  issues: FieldIssues;
  onChange: <K extends FieldName>(name: K, value: CheckoutDraft[K]) => void;
  onBlur: (name: FieldName) => void;
  data: CheckoutPageData;
  /** The cart as priced now (the total a wallet must cover, the lines under review). */
  cart: CartView;
  signedIn: boolean;
};

export const fieldId = (name: FieldName) => `co-${name}`;

/** The sentence for a field issue: our own words (`fields.<field>.<code>`), or the errors namespace for server keys. */
export function useIssueText(): (name: FieldName, issue: FieldIssue | undefined) => string | undefined {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const f = useFormat();
  return (name, issue) => {
    if (!issue) return undefined;
    if (issue.code.startsWith("server.")) return errorsT(`errors.${issue.code.slice("server.".length)}`);
    return t(`fields.${name}.${issue.code}`, issue.count === undefined ? undefined : { count: issue.count, n: f.number(issue.count) });
  };
}

// ───────────────────────────────────────────────────────────────── 1. address

export function AddressStep({ draft, issues, onChange, onBlur, data, signedIn, saved, onClearSaved }: StepProps & { saved?: { label: string | null } | null; onClearSaved?: () => void }) {
  const t = useT("checkout");
  const f = useFormat();
  const issueText = useIssueText();
  const districts = draft.governorateId ? (data.districts[draft.governorateId] ?? []) : [];
  const chosen = data.governorates.find((g) => g.id === draft.governorateId) ?? null;
  const feeHint = data.shipping.overridesEnabled
    ? chosen && chosen.feeIqd !== null
      ? fillNodes(t("address.feeChosen"), { fee: <bdi className="nums">{f.iqd(chosen.feeIqd)}</bdi> })
      : t("address.feeVaries")
    : fillNodes(t("address.feeFlat"), { fee: <bdi className="nums">{f.iqd(data.shipping.flatFeeIqd)}</bdi> });
  const text = (name: FieldName) => ({
    id: fieldId(name),
    name,
    value: draft[name] as string,
    onChange: (event: { currentTarget: { value: string } }) => onChange(name, event.currentTarget.value as never),
    onBlur: () => onBlur(name),
    error: issueText(name, issues[name]),
  });

  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-4">
        <legend className="mb-3 type-sub text-ink">{t("address.contact")}</legend>
        <TextField {...text("phone")} type="tel" inputMode="tel" autoComplete="tel-national" enterKeyHint="next" maxLength={40} label={t("address.phone")} required hint={t("address.phoneHint")} />
        <TextField {...text("contactName")} autoComplete="name" enterKeyHint="next" maxLength={100} label={t("address.name")} optional hint={signedIn ? t("address.nameHintSignedIn") : t("address.nameHint")} />
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-3 type-sub text-ink">{t("address.delivery")}</legend>
        {saved ? (
          // the account area's default address filled these in — a starting point the shopper may change or drop
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-paper px-3 py-2.5" role="note">
            <p className="flex min-w-0 flex-1 items-start gap-2 type-caption text-ink">
              <Icon name="map-pin" size={16} className="mt-0.5 shrink-0 text-ink-2" />
              <span>{saved.label ? t("address.savedNamed", { label: saved.label }) : t("address.saved")}</span>
            </p>
            {onClearSaved ? (
              <TextLink as="button" type="button" arrow={false} onClick={onClearSaved} className="type-caption">
                {t("address.savedClear")}
              </TextLink>
            ) : null}
          </div>
        ) : null}
        <Select
          {...text("governorateId")}
          autoComplete="address-level1"
          label={t("address.governorate")}
          required
          placeholder={t("address.governoratePlaceholder")}
          options={data.governorates.map((g) => ({ value: g.id, label: g.name, disabled: g.feeIqd === null }))}
          hint={feeHint}
        />
        <Select
          {...text("districtId")}
          label={t("address.district")}
          required={districts.length > 0}
          disabled={!draft.governorateId}
          placeholder={draft.governorateId ? t("address.districtPlaceholder") : t("address.districtFirst")}
          options={[...districts.map((d) => ({ value: d.id, label: d.name })), ...(districts.length > 0 ? [{ value: OTHER_DISTRICT, label: t("address.districtOther") }] : [])]}
          hint={draft.districtId === OTHER_DISTRICT ? t("address.districtOtherHint") : undefined}
        />
        <TextField {...text("areaText")} autoComplete="address-level3" enterKeyHint="next" maxLength={200} label={t("address.area")} required hint={t("address.areaHint")} />
        <TextArea {...text("addressText")} autoComplete="street-address" maxLength={500} rows={3} label={t("address.address")} required hint={t("address.addressHint")} />
        <TextArea {...text("notes")} maxLength={500} rows={2} label={t("address.notes")} optional hint={t("address.notesHint")} />
      </fieldset>

      <FieldGroup legend={t("address.timing")} optional hint={t("address.timingHint")} error={issueText("preferredDay", issues.preferredDay) ?? issueText("preferredWindow", issues.preferredWindow)}>
        <div className="grid gap-3">
          <div role="radiogroup" aria-label={t("address.day")} className="chips">
            <Chip input="radio" name="preferredDay" value="" checked={draft.preferredDay === ""} onChange={() => onChange("preferredDay", "")}>
              {t("address.anyDay")}
            </Chip>
            {data.days.map((day) => (
              <Chip key={day.value} input="radio" name="preferredDay" value={day.value} checked={draft.preferredDay === day.value} onChange={() => onChange("preferredDay", day.value)}>
                {t("address.dayChip", { rel: t(`address.days.${day.rel}`), weekday: day.weekday })}
              </Chip>
            ))}
          </div>
          <div role="radiogroup" aria-label={t("address.window")} className="chips">
            <Chip input="radio" name="preferredWindow" value="" checked={draft.preferredWindow === ""} onChange={() => onChange("preferredWindow", "")}>
              {t("address.anyTime")}
            </Chip>
            {WINDOWS.filter((w) => w !== "any").map((w) => (
              <Chip key={w} input="radio" name="preferredWindow" value={w} checked={draft.preferredWindow === w} onChange={() => onChange("preferredWindow", w)}>
                {t(`windows.${w}`)}
              </Chip>
            ))}
          </div>
        </div>
      </FieldGroup>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── 2. payment

export function PaymentStep({ draft, issues, onChange, data, cart, signedIn }: StepProps) {
  const t = useT("checkout");
  const f = useFormat();
  const issueText = useIssueText();
  const methods = data.methods;
  const walletBalance = data.walletBalanceIqd;
  const walletShort = walletBalance !== null && walletBalance < cart.totalIqd;
  const anyMethod = methods.cod || (methods.wallet && signedIn) || methods.bankTransfer || methods.zaincash;
  let first = true;
  /** The first radio carries the field's id, so focus can be sent to the group. */
  const idFor = () => {
    if (!first) return undefined;
    first = false;
    return fieldId("paymentMethod");
  };
  const radio = (value: string, label: string, hint: ReactNode, extra: { disabled?: boolean; end?: ReactNode } = {}) => (
    <Radio
      row
      id={idFor()}
      name="paymentMethod"
      value={value}
      checked={draft.paymentMethod === value}
      onChange={() => onChange("paymentMethod", value)}
      label={label}
      hint={hint}
      disabled={extra.disabled}
      end={extra.end}
    />
  );
  const transferNote = fillNodes(t("payment.transferAfter"), { total: <bdi className="nums font-semibold">{f.iqd(cart.totalIqd)}</bdi>, hours: f.number(data.proofHours) });

  if (!anyMethod) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg bg-paper p-4 type-body text-red-ink">
        <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
        {t("payment.none")}
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <FieldGroup legend={t("payment.legend")} required error={issueText("paymentMethod", issues.paymentMethod)}>
        {methods.cod ? radio("cod", t("payment.cod"), t("payment.codHint"), { end: <Icon name="money" size={22} className="text-ink-2" /> }) : null}
        {methods.wallet && signedIn
          ? radio("wallet", t("payment.wallet"), <WalletBalance compact balanceIqd={walletBalance} payIqd={cart.totalIqd} />, { disabled: walletShort, end: <Icon name="wallet" size={22} className="text-ink-2" /> })
          : null}
        {methods.bankTransfer ? radio("bank_transfer", t("payment.bank"), t("payment.bankHint"), { end: <Icon name="credit-card" size={22} className="text-ink-2" /> }) : null}
        {methods.zaincash ? radio("zaincash", t("payment.zain"), t("payment.zainHint"), { end: <Icon name="device-mobile" size={22} className="text-ink-2" /> }) : null}
      </FieldGroup>

      {methods.wallet && !signedIn ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-2">
          <Icon name="wallet" size={16} />
          {t("payment.walletGuest")}
          <TextLink as={LocaleLink} to="/account/login?next=%2Fcheckout%3Fstep%3Dpayment" inline>
            {t("payment.walletSignIn")}
          </TextLink>
        </p>
      ) : null}

      {isTransferMethod(draft.paymentMethod) ? (
        <section aria-labelledby="co-transfer" className="grid gap-3">
          <h3 id="co-transfer" className="type-sub text-ink">
            {t("payment.transferTitle")}
          </h3>
          <p className="type-body text-ink">{transferNote}</p>
          <TransferDetails
            destination={draft.paymentMethod === "bank_transfer" ? { method: "bank_transfer", accountNumber: data.transfer.accountNumber, recipientName: data.transfer.recipientName } : { method: "zaincash", number: data.transfer.zaincashNumber }}
            amountIqd={null}
          />
        </section>
      ) : null}
      <p className="flex items-start gap-2 type-caption text-ink-2">
        <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
        {t("payment.noCard")}
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── 3. review

export function ReviewStep({ draft, onChange, data, cart, notice }: StepProps & { notice: ReactNode }) {
  const t = useT("checkout");
  const f = useFormat();
  const governorate = data.governorates.find((g) => g.id === draft.governorateId)?.name ?? "";
  const district = draft.districtId && draft.districtId !== OTHER_DISTRICT ? (data.districts[draft.governorateId]?.find((d) => d.id === draft.districtId)?.name ?? "") : "";
  const day = data.days.find((d) => d.value === draft.preferredDay);
  const preference = [day ? t("address.dayChip", { rel: t(`address.days.${day.rel}`), weekday: day.weekday }) : null, draft.preferredWindow ? t(`windows.${draft.preferredWindow}`) : null].filter(Boolean).join(" · ");
  const method = draft.paymentMethod;

  return (
    <div className="grid gap-4">
      {notice}
      <ReviewBlock title={t("review.delivery")} editTo="/checkout?step=address" editLabel={t("review.editDelivery")}>
        <Facts>
          <Fact label={t("address.phone")}>
            <bdi dir="ltr" className="nums">
              {draft.phone.trim()}
            </bdi>
          </Fact>
          {draft.contactName.trim() ? <Fact label={t("review.recipient")}>{draft.contactName.trim()}</Fact> : null}
          <Fact label={t("review.place")}>{[governorate, district, draft.areaText.trim()].filter(Boolean).join(" · ")}</Fact>
          <Fact label={t("address.address")}>{draft.addressText.trim()}</Fact>
          {draft.notes.trim() ? <Fact label={t("address.notes")}>{draft.notes.trim()}</Fact> : null}
          <Fact label={t("address.timing")}>
            {preference ? (
              <span className="grid gap-0.5">
                <span>{preference}</span>
                <span className="type-caption text-ink-2">{t("address.timingHint")}</span>
              </span>
            ) : (
              t("review.noPreference")
            )}
          </Fact>
        </Facts>
      </ReviewBlock>

      <ReviewBlock title={t("review.payment")} editTo="/checkout?step=payment" editLabel={t("review.editPayment")}>
        <p className="type-body text-ink">{method ? t(`payment.${methodKey(method)}`) : "—"}</p>
        {isTransferMethod(method) ? (
          <p className="type-caption text-ink-2">{fillNodes(t("payment.transferAfter"), { total: <bdi className="nums font-semibold">{f.iqd(cart.totalIqd)}</bdi>, hours: f.number(data.proofHours) })}</p>
        ) : method === "cod" ? (
          <p className="type-caption text-ink-2">{t("payment.codHint")}</p>
        ) : null}
      </ReviewBlock>

      <ReviewBlock title={t("review.items", { count: cart.count, n: f.number(cart.count) })} editTo="/cart" editLabel={t("review.editCart")}>
        <ul className="grid gap-2">
          {cart.lines.map((line) => (
            <li key={line.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-start gap-3">
              <Niche as="span" ratio="1/1" tagZone={false} fill={Boolean(line.image.mediaKey) && !line.image.isIllustration} className="rounded-md">
                <ProductImage image={line.image} alt="" sizes="52px" pose={0} shadow={false} fit="cover" />
              </Niche>
              <span className="grid min-w-0 gap-0.5">
                <span className="line-clamp-2 type-label text-ink">
                  <BidiText text={line.name} />
                </span>
                <span className="type-caption text-ink-2">{[line.optionsLabel, t("review.qty", { count: line.qty, n: f.number(line.qty) })].filter(Boolean).join(" · ")}</span>
                {line.problem ? (
                  <span className={cx("type-caption font-medium", line.problem === "out_of_stock" || line.problem === "unavailable" ? "text-red-ink" : "text-warn")}>{t(`review.problem.${line.problem}`)}</span>
                ) : null}
              </span>
              {line.problem === "out_of_stock" || line.problem === "unavailable" ? <span className="type-caption text-ink-2">{t("review.excluded")}</span> : <PriceTag size="line" priceIqd={line.lineTotalIqd} approx="off" />}
            </li>
          ))}
        </ul>
      </ReviewBlock>

      <Checkbox
        id={fieldId("marketingConsent")}
        name="marketingConsent"
        checked={draft.marketingConsent}
        onChange={(event) => onChange("marketingConsent", event.currentTarget.checked)}
        label={t("review.consent")}
        hint={t("review.consentHint")}
      />
    </div>
  );
}

const methodKey = (method: string) => (method === "bank_transfer" ? "bank" : method === "zaincash" ? "zain" : method);

function ReviewBlock({ title, editTo, editLabel, children }: { title: string; editTo: string; editLabel: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 rounded-lg bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-sub text-ink">{title}</h3>
        <TextLink as={LocaleLink} to={editTo} arrow={false} className="type-label">
          <Icon name="pencil-simple" size={16} />
          {editLabel}
        </TextLink>
      </div>
      {children}
    </section>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid gap-0">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-line py-2 last:border-b-0">
      <dt className="type-caption text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words type-body text-ink">{children}</dd>
    </div>
  );
}

/** "749,000 د.ع" for sentences. */
export const iqdIn = (f: Formatters, amount: number) => "⁦" + f.iqd(amount) + "⁩";
