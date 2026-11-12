import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import type { FlashPriceView } from "~/server/services/orders/types";
import { isolate } from "~/ui/BidiText";
import type { CartEditor } from "~/ui/cart-client";
import { CartLineRow } from "~/ui/CartLineRow";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, FieldGroup, OptionCard, Select, TextArea, TextField } from "~/ui/Field";
import { GovernoratePicker } from "~/ui/GovernoratePicker";
import { Key } from "~/ui/Key";
import { PreferencePicker, type Period } from "~/ui/PreferencePicker";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { WalletBalance } from "~/ui/WalletBalance";
import { isTransferMethod, OTHER_DISTRICT, optionValue, parsePoints, type CheckoutDraft, type FieldIssue, type FieldIssues, type FieldName } from "../checkout-form";
import type { CheckoutPageData } from "../checkout.server";
import { withFlash } from "./Adjustments";
import type { CartWithIssue } from "./CouponForm";
import { TransferDetails } from "./TransferDetails";

/**
 * The three checkout steps (Design System v2 §6.10; brief §4): the delivery (contact, address, the preferred time,
 * the consent), the payment method, the review. They are plain views of the page's draft: every change goes up
 * through `onChange`, every blur through `onBlur`, and the page decides which issues to show (checked on blur,
 * re-checked on every keystroke once one shows). Field ids are `co-<field>`, so the page can move focus to the first
 * field with a problem and the error summary can link to it.
 *
 * Without script (the page renders all three steps and one plain post places the order) every control is native: the
 * governorate is a <select> there (the picker sheet needs script), the time cells, the payment option cards and the
 * boxes are radios and checkboxes with their own names.
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
/** The governorate's native select, drawn only without script (the picker is the field with script). */
export const NOJS_GOVERNORATE_ID = "co-governorateId-nojs";

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

// ───────────────────────────────────────────────────────────────── 1. delivery

export type AddressStepProps = StepProps & {
  /** The delivery fields came from the account's saved address (the page says so, with a way to start empty). */
  saved?: { label: string | null } | null;
  onClearSaved?: () => void;
  /** Signed in and the address is not the saved one as it is: offer «احفظ هذا العنوان لطلباتك القادمة». */
  offerSave?: boolean;
};

export function AddressStep({ draft, issues, onChange, onBlur, data, signedIn, saved, onClearSaved, offerSave = false }: AddressStepProps) {
  const t = useT("checkout");
  const f = useFormat();
  const issueText = useIssueText();
  const districts = draft.governorateId ? (data.districts[draft.governorateId] ?? []) : [];
  const chosen = data.governorates.find((g) => g.id === draft.governorateId) ?? null;
  const fee = (amount: number) => <bdi className="nums">{f.iqd(amount)}</bdi>;
  const feeHint = data.shipping.overridesEnabled ? (chosen && chosen.feeIqd !== null ? fillNodes(t("address.feeChosen"), { fee: fee(chosen.feeIqd) }) : t("address.feeVaries")) : fillNodes(t("address.feeFlat"), { fee: fee(data.shipping.flatFeeIqd) });
  const text = (name: FieldName) => ({
    id: fieldId(name),
    name,
    value: draft[name] as string,
    onChange: (event: { currentTarget: { value: string } }) => onChange(name, event.currentTarget.value as never),
    onBlur: () => onBlur(name),
    error: issueText(name, issues[name]),
  });
  const governorateError = issueText("governorateId", issues.governorateId);

  return (
    <div className="grid gap-8">
      <fieldset className="co-group">
        <legend className="co-group__title">{t("address.contact")}</legend>
        <TextField {...text("phone")} type="tel" inputMode="tel" autoComplete="tel-national" enterKeyHint="next" maxLength={40} label={t("address.phone")} required hint={t("address.phoneHint")} />
        <TextField {...text("contactName")} autoComplete="name" enterKeyHint="next" maxLength={100} label={t("address.name")} optional hint={signedIn ? t("address.nameHintSignedIn") : t("address.nameHint")} />
      </fieldset>

      <fieldset className="co-group">
        <legend className="co-group__title">{t("address.delivery")}</legend>
        {saved ? (
          // the account area's default address filled these in — a starting point the shopper may change or drop
          <div className="co-note" role="note">
            <p className="flex min-w-0 flex-1 items-start gap-2">
              <Icon name="map-pin" size={16} className="mt-0.5 shrink-0 text-ink-2" />
              <span>{saved.label ? t("address.savedNamed", { label: saved.label }) : t("address.saved")}</span>
            </p>
            {onClearSaved ? (
              <TextLink as="button" type="button" arrow={false} onClick={onClearSaved}>
                {t("address.savedClear")}
              </TextLink>
            ) : null}
          </div>
        ) : null}
        {/* with script: the picker (a sheet with 52px rows and the fee on top); without: the native list */}
        <GovernoratePicker
          id={fieldId("governorateId")}
          className="co-js"
          label={t("address.governorate")}
          required
          placeholder={t("address.governoratePlaceholder")}
          governorates={data.governorates.map((g) => ({ id: g.id, name: g.name, unserved: g.feeIqd === null }))}
          value={draft.governorateId || null}
          onChange={(id) => onChange("governorateId", id)}
          feeIqd={data.shipping.overridesEnabled ? null : data.shipping.flatFeeIqd}
          hint={feeHint}
          error={governorateError}
        />
        <Select
          {...text("governorateId")}
          id={NOJS_GOVERNORATE_ID}
          className="co-nojs"
          autoComplete="address-level1"
          label={t("address.governorate")}
          required
          placeholder={t("address.governoratePlaceholder")}
          options={data.governorates.map((g) => ({ value: g.id, label: g.name, disabled: g.feeIqd === null }))}
          hint={feeHint}
        />
        <Select
          {...text("districtId")}
          autoComplete="address-level2"
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

      {/* the period alone until the owner configures dispatch days (data.days is empty then) — never a promise */}
      <PreferencePicker
        name="preferredWindow"
        value={(draft.preferredWindow || "any") as Period}
        onChange={(period) => onChange("preferredWindow", period === "any" ? "" : period)}
        days={data.days.map((day) => ({ value: day.value, label: day.weekday }))}
        dayName="preferredDay"
        dayValue={draft.preferredDay || null}
        onDayChange={(day) => onChange("preferredDay", day)}
      />

      <div className="grid gap-2">
        <Checkbox
          id={fieldId("marketingConsent")}
          name="marketingConsent"
          checked={draft.marketingConsent}
          onChange={(event) => onChange("marketingConsent", event.currentTarget.checked)}
          label={t("review.consent")}
          hint={t("review.consentHint")}
        />
        {signedIn && offerSave ? (
          <Checkbox
            id={fieldId("saveAddress")}
            name="saveAddress"
            checked={draft.saveAddress}
            onChange={(event) => onChange("saveAddress", event.currentTarget.checked)}
            label={t("address.saveAddress")}
            hint={t("address.saveAddressHint")}
          />
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── 2. payment

export function PaymentStep({ draft, issues, onChange, onBlur, data, cart, signedIn }: StepProps) {
  const t = useT("checkout");
  const f = useFormat();
  const issueText = useIssueText();
  const methods = data.methods;
  const walletBalance = data.walletBalanceIqd;
  const walletShort = walletBalance !== null && walletBalance < cart.totalIqd;
  // nothing to pay (points and free delivery cover it): no transfer is asked for — the core refuses one of 0
  const transferable = cart.totalIqd > 0;
  const anyMethod = methods.cod || (methods.wallet && signedIn) || (transferable && (methods.bankTransfer || methods.zaincash));
  // a split payment: the whole balance from the wallet, the rest by the method chosen (a balance below the total)
  const canSplit = signedIn && methods.wallet && walletBalance !== null && walletBalance > 0 && walletShort;
  const splitting = canSplit && draft.useWallet && draft.paymentMethod !== "wallet";
  const toPay = splitting && walletBalance !== null ? cart.totalIqd - walletBalance : cart.totalIqd;
  let first = true;
  /** The first option carries the field's id, so focus can be sent to the group. */
  const idFor = () => {
    if (!first) return undefined;
    first = false;
    return fieldId("paymentMethod");
  };
  const option = (value: string, label: string, hint: ReactNode, mark: string, disabled = false) => (
    <OptionCard pay id={idFor()} name="paymentMethod" value={value} checked={draft.paymentMethod === value} onChange={() => onChange("paymentMethod", value)} label={label} hint={hint} mark={mark} disabled={disabled} />
  );

  if (!anyMethod) {
    return (
      <div role="alert" className="callout callout--danger">
        <Icon name="warning-circle" size={20} />
        <p className="callout__text text-ink">{t("payment.none")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <FieldGroup legend={t("payment.legend")} required error={issueText("paymentMethod", issues.paymentMethod)}>
        {methods.cod ? option("cod", t("payment.cod"), t("payment.codHint"), t("payment.codMark")) : null}
        {methods.wallet && signedIn ? option("wallet", t("payment.wallet"), <WalletBalance compact balanceIqd={walletBalance} payIqd={cart.totalIqd} />, t("payment.walletMark"), walletShort) : null}
        {methods.bankTransfer && transferable ? option("bank_transfer", t("payment.bank"), t("payment.bankHint"), t("payment.bankMark")) : null}
        {methods.zaincash && transferable ? option("zaincash", t("payment.zain"), t("payment.zainHint"), t("payment.zainMark")) : null}
      </FieldGroup>

      {methods.wallet && !signedIn ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-xs text-ink-2">
          <Icon name="wallet" size={16} />
          {t("payment.walletGuest")}
          <TextLink as={LocaleLink} to="/account/login?next=%2Fcheckout%3Fstep%3Dpayment" inline>
            {t("payment.walletSignIn")}
          </TextLink>
        </p>
      ) : null}

      {canSplit && walletBalance !== null ? (
        <Checkbox
          id={fieldId("useWallet")}
          name="useWallet"
          checked={draft.useWallet}
          onChange={(event) => onChange("useWallet", event.currentTarget.checked)}
          label={t("split.label", { balance: isolate(iqdText(f, walletBalance)) })}
          hint={t("split.hint", { rest: isolate(iqdText(f, Math.max(0, cart.totalIqd - walletBalance))) })}
          error={issueText("useWallet", issues.useWallet)}
        />
      ) : null}

      {signedIn ? <PointsBox draft={draft} issues={issues} onChange={onChange} onBlur={onBlur} cart={cart} /> : null}

      {isTransferMethod(draft.paymentMethod) ? (
        <section aria-labelledby="co-transfer" className="co-card grid gap-4">
          <h2 id="co-transfer" className="type-h3 text-ink">
            {t("payment.transferTitle")}
          </h2>
          <ol className="co-tsteps">
            <li>
              <span className="co-tsteps__n" aria-hidden="true">
                {f.number(1)}
              </span>
              <span>{t("payment.transferConfirm")}</span>
            </li>
            <li>
              <span className="co-tsteps__n" aria-hidden="true">
                {f.number(2)}
              </span>
              <span>{fillNodes(t("payment.transferSend"), { total: <bdi className="nums font-semibold">{f.iqd(toPay)}</bdi> })}</span>
            </li>
            <li>
              <span className="co-tsteps__n" aria-hidden="true">
                {f.number(3)}
              </span>
              <span>{t("payment.transferUpload")}</span>
            </li>
          </ol>
          <p className="flex items-start gap-2 type-sm-strong text-ink">
            <Icon name="info" size={20} className="shrink-0 text-info" />
            <span>
              {t("payment.transferRule")} <span className="font-normal text-ink-2">{t("payment.transferHold", { hours: f.number(data.proofHours) })}</span>
            </span>
          </p>
          <h3 className="type-sm-strong text-ink">{t("payment.transferWhere")}</h3>
          <TransferDetails
            destination={draft.paymentMethod === "bank_transfer" ? { method: "bank_transfer", accountNumber: data.transfer.accountNumber, recipientName: data.transfer.recipientName } : { method: "zaincash", number: data.transfer.zaincashNumber }}
            amountIqd={null}
          />
        </section>
      ) : null}
      <p className="flex items-start gap-2 type-xs text-ink-2">
        <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
        {t("payment.noCard")}
      </p>
    </div>
  );
}

/**
 * The points a signed-in customer redeems on this order (module 08's programme; the commerce core prices them): the
 * balance and a point's worth, the number to redeem (never more than `points.max` — the balance, and the goods left
 * after the other discounts), «استخدم …» for all of them, and what comes off. The page prices the cart again when the
 * number changes (GET /api/cart?points=).
 */
function PointsBox({ draft, issues, onChange, onBlur, cart }: Pick<StepProps, "draft" | "issues" | "onChange" | "onBlur" | "cart">) {
  const t = useT("checkout");
  const f = useFormat();
  const issueText = useIssueText();
  const points = (cart as CartWithIssue).points ?? null;
  if (!points) return null;
  if (points.balance <= 0) {
    return (
      <p className="co-note">
        <Icon name="star" size={16} className="shrink-0 text-ink-2" />
        <span className="min-w-0 flex-1">{t("points.none")}</span>
      </p>
    );
  }
  const asked = parsePoints(draft.redeemPoints);
  const applied = (cart as CartWithIssue).discounts?.find((entry) => entry.kind === "points") ?? null;
  return (
    <section aria-labelledby="co-points" className="co-card co-extra">
      <h2 id="co-points" className="type-h3 text-ink">
        {t("points.title")}
      </h2>
      <p className="type-sm text-ink-2">
        {t("points.balance", { count: points.balance, n: f.number(points.balance) })} {t("points.worth", { value: isolate(iqdText(f, points.pointValueIqd)) })}
      </p>
      <div className="co-extra__row">
        <TextField
          id={fieldId("redeemPoints")}
          name="redeemPoints"
          inputMode="numeric"
          autoComplete="off"
          optional
          label={t("points.label")}
          value={draft.redeemPoints}
          onChange={(event) => onChange("redeemPoints", event.currentTarget.value)}
          onBlur={() => onBlur("redeemPoints")}
          hint={t("points.hint", { max: f.number(points.max) })}
          error={issueText("redeemPoints", issues.redeemPoints)}
        />
        {points.max > 0 && asked !== points.max ? (
          <Key size="sm" onClick={() => onChange("redeemPoints", String(points.max))}>
            {t("points.useAll", { max: f.number(points.max) })}
          </Key>
        ) : null}
      </div>
      {applied && applied.kind === "points" ? <p className="type-xs-strong text-ok">{t("points.applied", { amount: isolate(iqdText(f, applied.amountIqd)) })}</p> : null}
      {draft.redeemPoints.trim() !== "" ? (
        <TextLink as="button" type="button" arrow={false} className="justify-self-start" onClick={() => onChange("redeemPoints", "")}>
          {t("points.clear")}
        </TextLink>
      ) : null}
    </section>
  );
}

/**
 * «لديك رمز إحالة من صديق؟» (module 08's referrals; the commerce core records it with the order): the code, «تحقق»
 * (the page asks the server about it — known, switched on, below its cap), and what the server said. It changes no
 * price; a refusal at «أكّد الطلب» lands on this field.
 */
function ReferralBox({ draft, issues, onChange, onBlur, cart, onCheck, pending }: Pick<StepProps, "draft" | "issues" | "onChange" | "onBlur" | "cart"> & { onCheck?: () => void; pending?: boolean }) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const issueText = useIssueText();
  const referral = (cart as CartWithIssue).referral ?? null;
  const typed = draft.referralCode.trim();
  const said = referral && typed !== "" && referral.code.replace(/[\s-]+/g, "").toUpperCase() === typed.replace(/[\s-]+/g, "").toUpperCase() ? referral : null;
  return (
    <Disclosure summary={t("referral.summary")} icon="users" defaultOpen={typed !== ""}>
      <div className="co-extra pt-2">
        <div className="co-extra__row">
          <TextField
            id={fieldId("referralCode")}
            name="referralCode"
            ltr
            autoComplete="off"
            optional
            maxLength={40}
            label={t("referral.label")}
            value={draft.referralCode}
            onChange={(event) => onChange("referralCode", event.currentTarget.value)}
            onBlur={() => onBlur("referralCode")}
            hint={t("referral.hint")}
            error={issueText("referralCode", issues.referralCode) ?? (said && said.status !== "ok" ? errorsT(`errors.${said.status}`) : undefined)}
          />
          {onCheck ? (
            <Key size="sm" loading={pending} disabled={typed === ""} onClick={onCheck}>
              {t("referral.check")}
            </Key>
          ) : null}
        </div>
        {said && said.status === "ok" ? <p className="type-xs-strong text-ok">{t("referral.ok", { code: isolate(said.code) })}</p> : null}
        {typed !== "" ? (
          <TextLink as="button" type="button" arrow={false} className="justify-self-start" onClick={() => onChange("referralCode", "")}>
            {t("referral.remove")}
          </TextLink>
        ) : null}
      </div>
    </Disclosure>
  );
}

// ───────────────────────────────────────────────────────────────── 3. review

export type ReviewStepProps = StepProps & {
  /** The refusal of the last «أكّد الطلب», shown where the review starts. */
  notice: ReactNode;
  /** The cart's lines, editable in place (quantities, removal with undo) — the page's cart editor. */
  editor: CartEditor;
  /** Phones: the terms sentence and the demo-order line (from 1024 they sit in the summary card by the key). */
  foot?: ReactNode;
  /** «تحقق» on the referral code: the page asks the server about it (priced again with the code). */
  onReferralCheck?: () => void;
  referralPending?: boolean;
};

export function ReviewStep({ draft, issues, onChange, onBlur, data, cart, notice, editor, foot, onReferralCheck, referralPending }: ReviewStepProps) {
  const t = useT("checkout");
  const f = useFormat();
  const governorate = data.governorates.find((g) => g.id === draft.governorateId)?.name ?? "";
  const district = draft.districtId && draft.districtId !== OTHER_DISTRICT ? (data.districts[draft.governorateId]?.find((d) => d.id === draft.districtId)?.name ?? "") : "";
  const day = data.days.find((d) => d.value === draft.preferredDay);
  const preference = [day ? day.weekday : null, draft.preferredWindow ? t(`windows.${draft.preferredWindow}`) : null].filter(Boolean).join(" · ");
  const method = draft.paymentMethod;

  return (
    <div className="grid gap-4">
      {notice}
      {/* the delivery and payment summaries need the page running: without script every field is on screen above */}
      <ReviewBlock id="co-review-delivery" title={t("review.delivery")} editTo="/checkout?step=address" editLabel={t("review.editDelivery")} className="co-js">
        <dl className="co-facts">
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
                <span className="type-xs text-ink-2">{t("address.timingNote")}</span>
              </span>
            ) : (
              t("review.noPreference")
            )}
          </Fact>
        </dl>
      </ReviewBlock>

      <ReviewBlock id="co-review-payment" title={t("review.payment")} editTo="/checkout?step=payment" editLabel={t("review.editPayment")} className="co-js">
        <p className="type-card text-ink">{method ? t(`payment.${methodKey(method)}`) : "—"}</p>
        {isTransferMethod(method) ? (
          <p className="type-xs text-ink-2">
            {t("payment.transferRule")} {t("payment.transferHold", { hours: f.number(data.proofHours) })}
          </p>
        ) : method === "cod" ? (
          <p className="type-xs text-ink-2">{t("payment.codHint")}</p>
        ) : null}
      </ReviewBlock>

      <ReferralBox draft={draft} issues={issues} onChange={onChange} onBlur={onBlur} cart={cart} onCheck={onReferralCheck} pending={referralPending} />

      <ReviewBlock id="co-review-items" title={t("review.items", { count: cart.count, n: f.number(cart.count) })} editTo="/cart" editLabel={t("review.editCart")}>
        <ul className="co-lines" aria-label={t("review.items", { count: cart.count, n: f.number(cart.count) })}>
          {editor.rows.map((row) => (
            <CartLineRow
              // one key through removal: the row becomes its undo row and the kit moves the focus to «تراجع»
              key={row.line.id}
              line={withFlash(withOptionValue(row.line), (row.line as { flash?: FlashPriceView | null }).flash, t, f)}
              removed={row.removed}
              busy={row.busy}
              error={row.error}
              onQtyChange={(qty) => editor.setQty(row.line.id, qty)}
              onRemove={() => editor.remove(row.line.id)}
              onRestore={() => editor.restore(row.line.id)}
              onDismiss={() => editor.dismiss(row.line.id)}
            />
          ))}
        </ul>
      </ReviewBlock>
      {foot}
    </div>
  );
}

/** A line with its option value only («النسخة الدولية»), never the product's name again (§4.13). */
export function withOptionValue<T extends { name: string; optionsLabel: string | null }>(line: T): T {
  const label = optionValue(line.name, line.optionsLabel);
  return label === line.optionsLabel ? line : { ...line, optionsLabel: label };
}

const methodKey = (method: string) => (method === "bank_transfer" ? "bank" : method === "zaincash" ? "zain" : method);

function ReviewBlock({ id, title, editTo, editLabel, className, children }: { id: string; title: string; editTo: string; editLabel: string; className?: string; children: ReactNode }) {
  const t = useT("checkout");
  return (
    <section aria-labelledby={id} className={cx("co-card grid gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 id={id} className="type-h3 text-ink">
          {title}
        </h2>
        {/* «عدّل» with its pencil inline (outside the underline); the accessible name says what is edited */}
        <TextLink as={LocaleLink} to={editTo} icon="pencil-simple" arrow={false} aria-label={editLabel}>
          {t("review.edit")}
        </TextLink>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="co-facts__row">
      <dt className="type-xs text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words type-body text-ink">{children}</dd>
    </div>
  );
}

