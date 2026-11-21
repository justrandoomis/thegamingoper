/**
 * «رجوع» | «تابع» — the builder's step keys (docs/switch-builder.md §6.1), the same pair in the task bar below 1024
 * (`compact`: the kit's 44px keys and the short «تابع», so both stay whole on a 320 phone in Sorani) and in the sticky
 * aside from 1024 (the full names: «تابع إلى المراجعة», «بەردەوام بە بۆ پێداچوونەوە»). In the aside the primary has the
 * card's whole width on its own line, «رجوع» under it, and may take a second line (`wrap`): its words are never cut to
 * «تابع إلى الـ…» — not at 1024, not with a larger text size. The aside's copy renders the primary FIRST, so the Tab
 * order is the order on screen (it was drawn with column-reverse: «رجوع» came first — QA 2026-11-21). The review step
 * has no «تابع»: its one primary is «أضف الكل إلى السلة» (./AddAllKey), so this file holds the page's only other
 * primary (lint `primary-count`).
 *
 * Steps are addresses (`?step=`): the keys are links, Back and reload work. While the next step loads the primary
 * keeps its width and spins. A step change asks nothing of the network (the route does not reload its data for one,
 * and the plan is in this browser), so the keys stay usable offline; the line above them only says the connection is
 * gone and the choices are safe (QA 2026-11-21: they went flat while the rail and Back still worked). Each step says
 * what it cannot do offline itself — the list loads when the connection is back, the quote is asked again.
 *
 * The primary carries `data-step-next`: the games step's «تخطَّ قائمة الألعاب» sends the keyboard to it.
 */
import type { ReactNode } from "react";
import { useLocation, useNavigation } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import type { BuilderStep } from "~/lib/switch-builder/types";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { useBuilderT } from "../lib/format";
import { nextStep, previousStep, stepHref } from "../lib/steps";

const FULL_NAME: Record<BuilderStep, string> = { device: "keys.continue", memory: "keys.toMemory", games: "keys.toGames", review: "keys.toReview" };

/** The attribute on a step's primary key (the skip key's target). */
export const STEP_NEXT = "data-step-next";

export type StepKeysProps = {
  step: BuilderStep;
  /** The task bar's compact pair (below 1024). */
  compact?: boolean;
  /** This copy carries the guide's `data-tour="continue"` (the copy the shopper can see). */
  tour?: boolean;
  /** The primary in place of «تابع» (the review step's add-all key). */
  children?: ReactNode;
  className?: string;
};

export function StepKeys({ step, compact = false, tour = false, children, className }: StepKeysProps) {
  const t = useBuilderT();
  const navigation = useNavigation();
  const location = useLocation();
  const online = useOnline();
  const back = previousStep(step);
  const next = nextStep(step);
  const pending = navigation.state !== "idle" && navigation.location?.pathname === location.pathname;
  const fit = compact ? "compact" : undefined;
  // the aside's keys say the full names: a second line before an ellipsis (a primary key's words are never cut)
  const wrap = !compact;
  const backKey = back ? (
    <Key as={LocaleLink} to={stepHref(back)} fit={fit} wrap={wrap} className="shrink-0">
      {t("keys.back")}
    </Key>
  ) : null;
  const nextKey = next ? (
    <Key
      variant="primary"
      as={LocaleLink}
      to={stepHref(next)}
      iconEnd="arrow-right"
      loading={pending}
      fit={fit}
      wrap={wrap}
      className="min-w-0 flex-1"
      {...{ [STEP_NEXT]: "" }}
      {...(tour ? { "data-tour": "continue" } : {})}
    >
      {compact ? t("keys.continue") : t(FULL_NAME[next])}
    </Key>
  ) : null;
  return (
    <div className={cx("sb-keys", className)}>
      {online ? null : (
        <p className="sb-keys__offline" role="status">
          <Icon name="wifi-slash" size={16} />
          {t("keys.offline")}
        </p>
      )}
      <div className="sb-keys__row">
        {compact ? (
          // a row: «رجوع» at the start, the primary taking the rest
          <>
            {backKey}
            {children}
            {nextKey}
          </>
        ) : (
          // a column in the aside: the primary on top, «رجوع» under it — in this order for the keyboard too
          <>
            {children}
            {nextKey}
            {backKey}
          </>
        )}
      </div>
    </div>
  );
}
