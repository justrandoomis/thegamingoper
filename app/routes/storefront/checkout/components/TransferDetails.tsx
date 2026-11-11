import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Price } from "~/ui/Price";
import { CopyKey } from "./CopyKey";

/**
 * Where a manual transfer goes (brief §4 C/D, DESIGN.md §9.18): a paper panel with the amount, the recipient and the
 * card / Zain Cash number — each with a one-tap copy key, numbers in tabular left-to-right type — then the fraud
 * warning as a flat panel with an info icon. Every value comes from settings through the commerce core
 * (getPaymentInstructions / OrderView.payment.instructions); nothing is hard-coded here. The store never asks for a
 * card number, CVV or password, and the warning says so.
 */
export type TransferDestination = { method: "bank_transfer"; accountNumber: string; recipientName: string } | { method: "zaincash"; number: string };

export function TransferDetails({ destination, amountIqd, orderRef, className }: { destination: TransferDestination; amountIqd: number | null; orderRef?: string | null; className?: string }) {
  const t = useT("checkout");
  return (
    <div className={cx("grid gap-3", className)}>
      <dl className="grid gap-0 rounded-lg bg-paper px-4 py-1">
        {amountIqd !== null ? (
          <Row label={t("transfer.amount")} copy={<CopyKey value={String(amountIqd)} label={t("transfer.amount")} />}>
            <Price amountIqd={amountIqd} size="md" approx="off" as="span" />
          </Row>
        ) : null}
        {destination.method === "bank_transfer" ? (
          <>
            <Row label={t("transfer.card")} copy={<CopyKey value={destination.accountNumber} label={t("transfer.card")} />}>
              <bdi dir="ltr" className="nums type-strong text-ink">
                {destination.accountNumber}
              </bdi>
            </Row>
            <Row label={t("transfer.recipient")} copy={<CopyKey value={destination.recipientName} label={t("transfer.recipient")} />}>
              <bdi className="type-strong text-ink">{destination.recipientName}</bdi>
            </Row>
          </>
        ) : (
          <Row label={t("transfer.zain")} copy={<CopyKey value={destination.number} label={t("transfer.zain")} />}>
            <bdi dir="ltr" className="nums type-strong text-ink">
              {destination.number}
            </bdi>
          </Row>
        )}
        {orderRef ? (
          <Row label={t("transfer.reference")} hint={t("transfer.referenceHint")} copy={<CopyKey value={orderRef} label={t("transfer.reference")} />}>
            <bdi dir="ltr" className="nums type-strong text-ink">
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-line py-3 last:border-b-0">
      <dt className="col-start-1 type-caption text-ink-2">{label}</dt>
      <dd className="col-start-1 grid min-w-0 gap-0.5">
        <span className="min-w-0 break-words">{children}</span>
        {hint ? <span className="type-caption text-ink-2">{hint}</span> : null}
      </dd>
      <dd className="col-start-2 row-span-2 row-start-1">{copy}</dd>
    </div>
  );
}

/** The fraud warning (brief §4: "fraud warning"; DESIGN.md §9.18: a flat panel with an info icon). */
export function FraudWarning({ className }: { className?: string }) {
  const t = useT("checkout");
  return (
    <div className={cx("flex items-start gap-2 rounded-md bg-niche px-3 py-2.5", className)}>
      <Icon name="shield-check" size={18} className="mt-0.5 shrink-0 text-info" />
      <p className="type-caption text-ink">
        <b className="font-semibold">{t("transfer.fraudTitle")}</b> {t("transfer.fraud")}
      </p>
    </div>
  );
}
