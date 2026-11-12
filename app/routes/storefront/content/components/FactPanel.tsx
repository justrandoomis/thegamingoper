import { useId } from "react";

import type { IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { FactList } from "~/ui/FactList";
import type { PaymentMethodKey, PolicyFact } from "../content-model";

const ICON: Record<PolicyFact["kind"], IconName> = {
  delivery_fee: "truck",
  coverage_paused: "map-pin",
  track: "package",
  return_window: "arrow-counter-clockwise",
  proof_window: "clock",
  payment_methods: "wallet",
  transfers_checked: "seal-check",
  store_warranty_pending: "storefront",
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
 * «باختصار» — a policy's key facts (Design System v2 §6.15): the kit's fact rows in a paper card under an h2, read live
 * from the store's settings, so they hold whatever the policy text says. Money is formatted by the shopper's formatter,
 * figure first, always in dinars (the payable currency).
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
      case "coverage_paused":
        return fact.all ? t("facts.coverageNone") : t("facts.coveragePaused");
      case "track":
        return t("facts.track");
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
    <section aria-labelledby={headingId} className={cx("cglance", className)}>
      <h2 id={headingId} className="cglance__title">
        {t("common.glance")}
      </h2>
      <FactList facts={facts.map((fact) => ({ id: fact.kind, icon: ICON[fact.kind], title: <span className="nums">{text(fact)}</span> }))} />
    </section>
  );
}
