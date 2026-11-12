/**
 * The facts a buyer asks before ordering — design v2 spec §6.7 items 8 and 11, §4.20 FactList, §9 glossary:
 *
 *   <PaymentLine methods />    item 8, under the price: ONE sentence with the enabled payment methods (15px), and the
 *                              transfer rule under it (13 ink-2) when a transfer method is on.
 *   <FactsCard … />            item 11: a paper card of fact rows — delivery (+ «اطلب بدون حساب»), payment, returns,
 *                              warranty.
 *
 * Only what is true: the fee and the returns window come from settings, the payment methods from the switches the
 * owner turned on (the TamTam wallet only for a signed-in shopper), the warranty is the manufacturer's when the
 * research states it — always labelled as theirs — or the STORE's once the owner sets one; otherwise a question link
 * («اسألنا عن شروط الضمان», to the one "talk to a person" form), never an admission. No delivery time, no call
 * promise. Digital codes take their own facts: no delivery fee or returns row (spec §6.7 states, §13 row 11).
 */
import { useId, type ReactNode } from "react";

import { LocaleLink, useFormat } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { FactList, type Fact } from "~/ui/FactList";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { useProductT } from "../i18n";

/** The store's payment switches (layout loader `shell.payments`). */
export type PaymentSwitches = { cod: boolean; wallet: boolean; card: boolean; zaincash: boolean };
export type PaymentMethod = "cod" | "zaincash" | "card" | "wallet";

/** The one "talk to a person" destination (spec §6.13): the warranty question goes there. */
export const ASK_HREF = "/support/assistant?handoff=1#handoff";

/**
 * The methods to name, in the sentence's order (spec §6.7 item 8): cash on delivery, Zain Cash, the card transfer —
 * and the TamTam wallet only for a signed-in shopper. Only what the owner switched on. Pure.
 */
export function paymentMethods(switches: PaymentSwitches | null | undefined, signedIn: boolean): PaymentMethod[] {
  if (!switches) return [];
  const methods: PaymentMethod[] = [];
  if (switches.cod) methods.push("cod");
  if (switches.zaincash) methods.push("zaincash");
  if (switches.card) methods.push("card");
  if (switches.wallet && signedIn) methods.push("wallet");
  return methods;
}

/** A transfer (card or Zain Cash) waits for a person to verify it: the rule is said whenever one is offered. Pure. */
export const offersTransfer = (methods: readonly PaymentMethod[]) => methods.includes("card") || methods.includes("zaincash");

function useMethodsSentence(methods: readonly PaymentMethod[]): string {
  const t = useProductT();
  const names = methods.map((method) => t(`pay.${method}`));
  const list = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(t("pay.join"))}${t("pay.last")}${names[names.length - 1]}`;
  return t("pay.sentence", { methods: list });
}

/** Item 8: «الدفع عند الاستلام، أو زين كاش، أو تحويل إلى بطاقة ماستركارد» + the transfer rule. Nothing when no method is on. */
export function PaymentLine({ methods, className }: { methods: readonly PaymentMethod[]; className?: string }) {
  const t = useProductT();
  const sentence = useMethodsSentence(methods);
  if (methods.length === 0) return null;
  return (
    <div className={cx("grid gap-0.5", className)} data-pay-line="">
      {/* 15px reading text (the card-title size, at the body weight) */}
      <p className="type-card font-normal text-ink">{sentence}</p>
      {offersTransfer(methods) ? <p className="type-xs text-ink-2">{t("pay.rule")}</p> : null}
    </div>
  );
}

export type FactsCardProps = {
  delivery: { flatFeeIqd: number; overridesEnabled: boolean };
  methods: readonly PaymentMethod[];
  returnsWindowDays: number;
  makerWarranty: string | null;
  storeWarrantyMonths: number | null;
  /** A digital code: its own delivery fact, no fee, no returns and no warranty rows. */
  digital?: boolean;
  className?: string;
};

/** Item 11: the facts card (FactList on paper), headed for screen readers. */
export function FactsCard({ delivery, methods, returnsWindowDays, makerWarranty, storeWarrantyMonths, digital = false, className }: FactsCardProps) {
  const t = useProductT();
  const f = useFormat();
  const titleId = useId();
  const sentence = useMethodsSentence(methods);
  const link = (label: string, to: string): ReactNode => (
    <TextLink as={LocaleLink} to={to}>
      {label}
    </TextLink>
  );

  const facts: Fact[] = [];
  if (digital) {
    facts.push({ id: "code", icon: "qr-code", title: t("facts.code"), text: t("facts.guest") });
  } else {
    facts.push({
      id: "delivery",
      icon: "truck",
      title: delivery.overridesEnabled ? t("facts.deliveryVaries") : fillNodes(t("facts.delivery"), { fee: <bdi className="nums">{iqdText(f, delivery.flatFeeIqd)}</bdi> }),
      text: t("facts.guest"),
    });
  }
  if (methods.length > 0) {
    facts.push({ id: "pay", icon: "wallet", title: sentence, text: offersTransfer(methods) ? t("pay.rule") : undefined });
  }
  if (!digital) {
    facts.push({
      id: "returns",
      icon: "arrow-counter-clockwise",
      title: returnsWindowDays > 0 ? t("facts.returns", { count: returnsWindowDays, n: f.number(returnsWindowDays) }) : t("facts.returnsNone"),
      text: link(t("facts.returnsPolicy"), "/policies/returns"),
    });
    const ask = link(t("facts.askWarranty"), ASK_HREF);
    if (storeWarrantyMonths) {
      facts.push({
        id: "warranty",
        icon: "shield-check",
        title: t("facts.storeWarranty", { count: storeWarrantyMonths, n: f.number(storeWarrantyMonths) }),
        text: makerWarranty ? (
          <span className="grid justify-items-start">
            <span>{t("facts.makerWarranty", { terms: makerWarranty })}</span>
            {ask}
          </span>
        ) : (
          ask
        ),
      });
    } else if (makerWarranty) {
      facts.push({
        id: "warranty",
        icon: "shield-check",
        title: t("facts.makerWarranty", { terms: makerWarranty }),
        text: (
          <span className="grid justify-items-start">
            <span>{t("facts.makerWarrantyNote")}</span>
            {ask}
          </span>
        ),
      });
    } else {
      facts.push({ id: "warranty", icon: "shield-check", title: t("facts.warranty"), text: ask });
    }
  }

  return (
    <section aria-labelledby={titleId} className={className} data-facts-card="">
      <VisuallyHidden as="h2" id={titleId}>
        {t("facts.title")}
      </VisuallyHidden>
      <FactList facts={facts} />
    </section>
  );
}
