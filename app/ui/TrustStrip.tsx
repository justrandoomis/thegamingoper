import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { iqdText, isIqd } from "./PriceTag";
import { TextLink } from "./TextLink";

/**
 * The trust strip — Design System v2 §4.20: four HONEST facts in one paper card divided by hairlines (one row of four
 * from 768, 2×2 on phones). Each fact is shown only when it is true in the admin settings — pass what is true, nothing
 * is assumed:
 *
 *   <TrustStrip deliveryIqd={settings.deliveryFeeIqd} cod={settings.codEnabled} transfer guest />
 *   <TrustStrip variant="line" cod={settings.codEnabled} returnsTo="/policies/returns" />   cart, under the commit key
 *
 *   delivery   «التوصيل 5,000 د.ع» · «لكل المحافظات»                       (the fee from settings)
 *   cod        «الدفع عند الاستلام» · «نقداً للمندوب عند استلام الطلب»       (only while COD is enabled)
 *   transfer   «زين كاش أو تحويل إلى بطاقة ماستركارد» · «نراجع كل تحويل قبل تأكيد الطلب»
 *   guest      «اطلب بدون حساب» · «وتتبّع طلبك برقمه ورقم موبايلك»
 *
 * A cell: a 40px --red-tint icon tile with a 22px --red-ink icon, a 15/600 title, a 13px line. The `line` variant is the
 * same facts as one 13px row with 16px icons (and «سياسة الإرجاع» when `returnsTo` is given). With no fact, nothing.
 */
export type TrustStripProps = {
  /** The delivery fee from settings (integer IQD). Omit or null: the fact is not shown. */
  deliveryIqd?: number | null;
  /** Cash on delivery is enabled. */
  cod?: boolean;
  /** Zain Cash / transfer to a Mastercard card is offered. */
  transfer?: boolean;
  /** Guest checkout is offered. */
  guest?: boolean;
  /** line: the returns policy link (a locale-less path). */
  returnsTo?: string;
  variant?: "card" | "line";
  className?: string;
};

type Fact = { key: string; icon: IconName; title: ReactNode; text: ReactNode; short: ReactNode };

export function TrustStrip({ deliveryIqd = null, cod = false, transfer = false, guest = false, returnsTo, variant = "card", className }: TrustStripProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const facts: Fact[] = [];
  if (isIqd(deliveryIqd)) {
    const fee = <bdi className="nums">{iqdText(f, deliveryIqd)}</bdi>;
    facts.push({ key: "delivery", icon: "truck", title: <>{t("trust.delivery", { price: "⁦" + iqdText(f, deliveryIqd) + "⁩" })}</>, text: t("trust.deliveryText"), short: fee });
  }
  if (cod) facts.push({ key: "cod", icon: "money", title: t("trust.cod"), text: t("trust.codText"), short: t("trust.codLine") });
  if (transfer) facts.push({ key: "transfer", icon: "credit-card", title: t("trust.transfer"), text: t("trust.transferText"), short: t("trust.transfer") });
  if (guest) facts.push({ key: "guest", icon: "user", title: t("trust.guest"), text: t("trust.guestText"), short: t("trust.guest") });

  if (variant === "line") {
    const line = facts.filter((fact) => fact.key !== "delivery");
    if (line.length === 0 && !returnsTo) return null;
    return (
      <ul className={cx("trust trust--line", className)}>
        {line.map((fact) => (
          <li key={fact.key} className="trust__cell">
            <Icon name={fact.icon} size={16} className="trust__icon" />
            <span>{fact.short}</span>
          </li>
        ))}
        {returnsTo ? (
          <li className="trust__cell">
            <Icon name="arrow-counter-clockwise" size={16} className="trust__icon" />
            <TextLink as={LocaleLink} to={returnsTo} inline arrow={false}>
              {t("trust.returns")}
            </TextLink>
          </li>
        ) : null}
      </ul>
    );
  }

  if (facts.length === 0) return null;
  return (
    <ul className={cx("trust", className)}>
      {facts.map((fact) => (
        <li key={fact.key} className="trust__cell">
          <span className="trust__icon" aria-hidden="true">
            <Icon name={fact.icon} size={22} />
          </span>
          <span className="trust__title">{fact.title}</span>
          <span className="trust__text">{fact.text}</span>
        </li>
      ))}
    </ul>
  );
}
