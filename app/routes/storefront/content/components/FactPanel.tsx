import { useId } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import type { PaymentMethodKey, PolicyFact } from "../content-model";

const ICON: Record<PolicyFact["kind"], IconName> = {
  delivery_fee: "truck",
  governorates: "map-pin",
  return_window: "arrow-counter-clockwise",
  proof_window: "clock",
  payment_methods: "wallet",
  transfers_checked: "seal-check",
  store_warranty_pending: "hourglass",
  maker_warranty: "certificate",
  used_warranty: "recycle",
  no_tracking: "eye-slash",
  proofs_private: "lock",
  guest_checkout: "user",
  estimate_valid: "calendar-blank",
};

/** Payment method names joined in the page's language ("الدفع عند الاستلام، زين كاش"). */
export function useMethodList(): (methods: readonly PaymentMethodKey[]) => string {
  const t = useT("content");
  return (methods) => methods.map((method) => t(`pay.${method}`)).join(t("common.listSeparator"));
}

/**
 * "باختصار" — a policy's key facts, read live from the store's settings (so they hold whatever the policy text says).
 * Money is formatted by the shopper's formatter, figure first, always in dinars (the payable currency).
 */
export function FactPanel({ facts, className }: { facts: readonly PolicyFact[]; className?: string }) {
  const t = useT("content");
  const f = useFormat();
  const methodList = useMethodList();
  const headingId = useId();
  if (facts.length === 0) return null;

  const text = (fact: PolicyFact): string => {
    switch (fact.kind) {
      case "delivery_fee":
        return fact.varies ? t("facts.deliveryVaries") : t("facts.deliveryFee", { fee: `⁨${f.iqd(fact.amountIqd)}⁩` });
      case "governorates":
        return fact.count > 0 ? t("facts.governorates", { count: fact.count }) : t("facts.governoratesNone");
      case "return_window":
        return fact.days > 0 ? t("facts.returnWindow", { count: fact.days }) : t("facts.returnNone");
      case "proof_window":
        return t("facts.proofWindow", { count: fact.hours });
      case "payment_methods":
        return fact.methods.length > 0 ? t("facts.payments", { methods: methodList(fact.methods) }) : t("facts.paymentsNone");
      case "transfers_checked":
        return t("facts.transfersChecked");
      case "store_warranty_pending":
        return t("facts.storeWarrantyPending");
      case "maker_warranty":
        return t("facts.makerWarranty");
      case "used_warranty":
        return t("facts.usedWarranty");
      case "no_tracking":
        return t("facts.noTracking");
      case "proofs_private":
        return t("facts.proofsPrivate");
      case "guest_checkout":
        return t("facts.guestCheckout");
      case "estimate_valid":
        return t("facts.estimateValid", { count: fact.days });
    }
  };

  return (
    <section aria-labelledby={headingId} className={cx("panel grid gap-3 p-4 md:p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="type-sub text-ink">
          {t("common.glance")}
        </h2>
        <p className="type-caption text-ink-2">{t("common.glanceNote")}</p>
      </div>
      <ul className="grid gap-2.5">
        {facts.map((fact) => (
          <li key={fact.kind} className="flex items-start gap-3">
            <Icon name={ICON[fact.kind]} size={20} className="mt-0.5 text-ink" />
            <span className="type-body text-ink nums">{text(fact)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
