import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Price } from "~/ui/Price";
import { groupDigits } from "../checkout-form";
import { CopyKey } from "./CopyKey";

/**
 * Where a manual transfer goes (brief §4 C/D, Design System v2 §4.24): rows between hairlines — the amount, the
 * recipient and the card / Zain Cash number, each value in Plex 600 20px tabular type (numbers grouped for reading,
 * «9269 3174 27»; left to right), each with its own copy key that copies the plain value and says «نُسخ» — then the
 * fraud warning as an info callout. Every value comes from settings through the commerce core
 * (getPaymentInstructions / OrderView.payment.instructions); nothing is hard-coded here. The store never asks for a
 * card number, CVV or password, and the warning says so.
 */
export type TransferDestination = { method: "bank_transfer"; accountNumber: string; recipientName: string } | { method: "zaincash"; number: string };

export function TransferDetails({ destination, amountIqd, orderRef, className }: { destination: TransferDestination; amountIqd: number | null; orderRef?: string | null; className?: string }) {
  const t = useT("checkout");
  return (
    <div className={cx("grid gap-3", className)}>
      <dl className="co-values">
        {amountIqd !== null ? (
          <Row label={t("transfer.amount")} copy={<CopyKey value={String(amountIqd)} label={t("transfer.amount")} />}>
            <Price amountIqd={amountIqd} size="lg" approx="off" as="span" />
          </Row>
        ) : null}
        {destination.method === "bank_transfer" ? (
          <>
            <Row label={t("transfer.card")} copy={<CopyKey value={destination.accountNumber} label={t("transfer.card")} />}>
              <bdi dir="ltr" className="copyval__value">
                {groupDigits(destination.accountNumber, "card")}
              </bdi>
            </Row>
            <Row label={t("transfer.recipient")} copy={<CopyKey value={destination.recipientName} label={t("transfer.recipient")} />}>
              <bdi className="type-card text-ink">{destination.recipientName}</bdi>
            </Row>
          </>
        ) : (
          <Row label={t("transfer.zain")} copy={<CopyKey value={destination.number} label={t("transfer.zain")} />}>
            <bdi dir="ltr" className="copyval__value">
              {groupDigits(destination.number, "phone")}
            </bdi>
          </Row>
        )}
        {orderRef ? (
          <Row label={t("transfer.reference")} hint={t("transfer.referenceHint")} copy={<CopyKey value={orderRef} label={t("transfer.reference")} />}>
            <bdi dir="ltr" className="copyval__value">
              {orderRef}
            </bdi>
          </Row>
        ) : null}
      </dl>
      <FraudWarning />
    </div>
  );
}

function Row({ label, hint, copy, children }: { label: string; hint?: string; copy: ReactNode; children: ReactNode }) {
  return (
    <div className="co-values__row">
      <dt className="type-xs text-ink-2">{label}</dt>
      <dd className="co-values__value">
        <span className="min-w-0 break-words">{children}</span>
        {hint ? <span className="type-xs text-ink-2">{hint}</span> : null}
      </dd>
      <dd className="co-values__copy">{copy}</dd>
    </div>
  );
}

/** The fraud warning (brief §4: "fraud warning"; §4.24: an info panel). */
export function FraudWarning({ className }: { className?: string }) {
  const t = useT("checkout");
  return (
    <div className={cx("callout", className)}>
      <Icon name="shield-check" size={20} />
      <div className="grid gap-0.5">
        <p className="callout__title">{t("transfer.fraudTitle")}</p>
        <p className="callout__text">{t("transfer.fraud")}</p>
      </div>
    </div>
  );
}
