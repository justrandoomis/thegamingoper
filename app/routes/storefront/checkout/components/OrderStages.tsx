import type { CSSProperties } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { ORDER_STAGES } from "../checkout-form";
// its look (.co-progress, .co-stage) travels with it: the account's order page draws the same rail
import "../checkout.css";

/** Each stage's icon on the status rail. */
export const STAGE_ICON: Record<(typeof ORDER_STAGES)[number], IconName> = { received: "receipt", confirmed: "seal-check", preparing: "package", shipped: "truck", delivered: "house" };

/**
 * Where an order is — the status rail of the order status template (Design System v2 §6.11; v2.1, client round 1): the
 * five real stages (استلمنا · تأكيد · تجهيز · في الطريق · تم التسليم), each with its icon in a circle (reached ones ink,
 * the one the order is at with a ring, the next ones raised clay), joined by a line that fills up to `stage` (it draws
 * itself once under full motion; drawn at once otherwise). One rail for the order page, /track and the account's order
 * page (QA 2026-11-13: the account drew plain hollow circles). `stage` is checkout-form's `orderStage(status)`.
 */
export function OrderStages({ stage, className, "aria-label": label }: { stage: number; className?: string; "aria-label"?: string }) {
  const t = useT("checkout");
  return (
    <div className={cx("co-progress", className)} style={{ "--progress": stage / (ORDER_STAGES.length - 1) } as CSSProperties}>
      <span className="co-progress__track" aria-hidden="true">
        <span className="co-progress__fill" />
      </span>
      <ol className="co-stages" aria-label={label}>
        {ORDER_STAGES.map((name, index) => {
          const state = index < stage ? "done" : index === stage ? "current" : "upcoming";
          return (
            <li key={name} className="co-stage" data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="co-stage__disc" aria-hidden="true">
                <Icon name={STAGE_ICON[name]} size={20} />
              </span>
              <span className="co-stage__label">{t(`order.stages.${name}`)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
