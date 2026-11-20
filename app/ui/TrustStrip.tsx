import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { isolate } from "./BidiText";
import { cx } from "./cx";
import { iqdText, isIqd } from "./PriceTag";
import { TextLink } from "./TextLink";
import { TrustMotion, type TrustMotionKey } from "./TrustMotion";

/**
 * The trust strip — Design System v2 §4.20: four HONEST facts in one paper card divided by hairlines (one row of four
 * from 768, 2×2 on phones). Each fact is shown only when it is true in the admin settings — pass what is true, nothing
 * is assumed:
 *
 *   <TrustStrip deliveryIqd={settings.deliveryFeeIqd} cod={settings.codEnabled} transfer={{ zaincash, card }} guest />
 *   <TrustStrip variant="line" cod={settings.codEnabled} returnsTo="/policies/returns" />   cart, under the commit key
 *
 *   delivery   «التوصيل 5,000 د.ع» · «لكل المحافظات»                       (the fee from settings)
 *   cod        «الدفع عند الاستلام» · «نقداً للمندوب عند استلام الطلب»       (only while COD is enabled)
 *   transfer   the methods that are switched on, by name — «زين كاش أو تحويل إلى بطاقة ماستركارد», «زين كاش» alone,
 *              or «تحويل إلى بطاقة ماستركارد» alone — · «نراجع كل تحويل قبل تأكيد الطلب»
 *   guest      «اطلب بدون حساب» · «وتتبّع طلبك برقمه ورقم موبايلك»
 *
 * A cell: a 40px --red-tint icon tile with a 22px --red-ink icon, a 15/600 title, a 13px line. The `line` variant is the
 * same facts as one 13px row with 16px icons (and «سياسة الإرجاع» when `returnsTo` is given). With no fact, nothing.
 * Amounts inside the sentences are first-strong isolates: the figure comes first in every language.
 *
 * The `motion` variant (home, under the platforms): the same facts (+ `warranty`) as small borderless vertical cells,
 * each with its own small wide looping scene (TrustMotion, like a GIF), centred and narrower than the page. The words
 * are small and arrive with a short animation, one cell after another, when the strip first scrolls into view (only
 * once JavaScript runs and motion is allowed; otherwise they are simply there).
 */
export type TrustStripProps = {
  /** The delivery fee from settings (integer IQD). Omit or null: the fact is not shown. */
  deliveryIqd?: number | null;
  /** Cash on delivery is enabled. */
  cod?: boolean;
  /**
   * The transfer methods that are switched on: `{ zaincash, card }` names only those (one fact). `true` means both
   * (Zain Cash and a transfer to a Mastercard card). Nothing on: no fact.
   */
  transfer?: boolean | { zaincash?: boolean; card?: boolean };
  /** Guest checkout is offered. */
  guest?: boolean;
  /** motion: the warranty fact (each product's warranty is written on its own page). */
  warranty?: boolean;
  /** line: the returns policy link (a locale-less path). */
  returnsTo?: string;
  variant?: "card" | "line" | "motion";
  className?: string;
};

type Fact = { key: TrustMotionKey; icon: IconName; title: ReactNode; text: ReactNode; short: ReactNode };

/** Which transfer methods the fact names: both, one of them, or none (no fact). Pure. */
export function transferMethods(transfer: TrustStripProps["transfer"]): "both" | "zaincash" | "card" | null {
  if (transfer === true) return "both";
  if (!transfer) return null;
  if (transfer.zaincash && transfer.card) return "both";
  if (transfer.zaincash) return "zaincash";
  if (transfer.card) return "card";
  return null;
}

/** motion: hide the words until the strip is in view, then let them arrive (CSS `.trust--motion[data-in]`). */
function useWordsEntrance(enabled: boolean) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = ref.current;
    if (!enabled || !list || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced") return;
    list.dataset.armed = "";
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        list.dataset.in = "";
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(list);
    return () => {
      observer.disconnect();
      delete list.dataset.armed;
    };
  }, [enabled]);
  return ref;
}

export function TrustStrip({ deliveryIqd = null, cod = false, transfer = false, guest = false, warranty = false, returnsTo, variant = "card", className }: TrustStripProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const wordsRef = useWordsEntrance(variant === "motion");
  const facts: Fact[] = [];
  if (isIqd(deliveryIqd)) {
    const fee = <bdi className="nums">{iqdText(f, deliveryIqd)}</bdi>;
    facts.push({ key: "delivery", icon: "truck", title: <>{t("trust.delivery", { price: isolate(iqdText(f, deliveryIqd)) })}</>, text: t("trust.deliveryText"), short: fee });
  }
  if (cod) facts.push({ key: "cod", icon: "money", title: t("trust.cod"), text: t("trust.codText"), short: t("trust.codLine") });
  const methods = transferMethods(transfer);
  if (methods) {
    const title = t(methods === "both" ? "trust.transfer" : methods === "zaincash" ? "trust.transferZain" : "trust.transferCard");
    facts.push({ key: "transfer", icon: "credit-card", title, text: t("trust.transferText"), short: title });
  }
  if (guest) facts.push({ key: "guest", icon: "user", title: t("trust.guest"), text: t("trust.guestText"), short: t("trust.guest") });
  if (warranty && variant === "motion") facts.push({ key: "warranty", icon: "shield-check", title: t("trust.warranty"), text: t("trust.warrantyText"), short: t("trust.warranty") });

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
            {/* a fact of its own, not a word in a sentence: a 44px target around the 13px words (§10) */}
            <TextLink as={LocaleLink} to={returnsTo} inline arrow={false} className="relative hit-44">
              {t("trust.returns")}
            </TextLink>
          </li>
        ) : null}
      </ul>
    );
  }

  if (facts.length === 0) return null;
  if (variant === "motion") {
    return (
      <ul ref={wordsRef} className={cx("trust trust--motion", className)}>
        {facts.map((fact, index) => (
          <li key={fact.key} className="trust__cell" style={{ "--i": index } as CSSProperties}>
            <TrustMotion name={fact.key} />
            <span className="trust__title">{fact.title}</span>
            <span className="trust__text">{fact.text}</span>
          </li>
        ))}
      </ul>
    );
  }
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
