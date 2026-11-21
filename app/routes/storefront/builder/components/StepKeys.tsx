/**
 * «رجوع» | «تابع» — the builder's step keys (docs/switch-builder.md §6.1), the same pair in the task bar below 1024
 * (`compact`: the kit's 44px keys and the short «تابع», so both stay whole on a 320 phone in Sorani) and in the sticky
 * aside from 1024 (the full names: «تابع إلى الألعاب»). The review step has no «تابع»: its one primary is «أضف الكل
 * إلى السلة» (./AddAllKey), so this file holds the page's only other primary (lint `primary-count`).
 *
 * Steps are addresses (`?step=`): the keys are links, Back and reload work. While the next step loads the primary
 * keeps its width and spins. Offline both keys go flat with the reason above them — a step that cannot load would
 * end on the error page (the plan itself is safe on this device either way).
 */
import { useId, type ReactNode } from "react";
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

export type StepKeysProps = {
  step: BuilderStep;
  /** The task bar's compact pair (below 1024). */
  compact?: boolean;
  /** This copy carries the guide's `data-tour="continue"` (the copy the shopper can see). */
  tour?: boolean;
  /** Something before the keys on their row (the review step's add-all key takes the primary's place). */
  children?: ReactNode;
  className?: string;
};

export function StepKeys({ step, compact = false, tour = false, children, className }: StepKeysProps) {
  const t = useBuilderT();
  const navigation = useNavigation();
  const location = useLocation();
  const online = useOnline();
  const reasonId = useId();
  const back = previousStep(step);
  const next = nextStep(step);
  const pending = navigation.state !== "idle" && navigation.location?.pathname === location.pathname;
  const offline = { disabled: !online, "aria-describedby": online ? undefined : reasonId };
  const fit = compact ? "compact" : undefined;
  return (
    <div className={cx("sb-keys", className)}>
      {online ? null : (
        <p id={reasonId} className="sb-keys__offline" role="status">
          <Icon name="wifi-slash" size={16} />
          {t("keys.offline")}
        </p>
      )}
      <div className="sb-keys__row">
        {back ? (
          <Key as={LocaleLink} to={stepHref(back)} fit={fit} className="shrink-0" {...offline}>
            {t("keys.back")}
          </Key>
        ) : null}
        {children}
        {next ? (
          <Key
            variant="primary"
            as={LocaleLink}
            to={stepHref(next)}
            iconEnd="arrow-right"
            loading={pending}
            fit={fit}
            className="min-w-0 flex-1"
            {...(tour ? { "data-tour": "continue" } : {})}
            {...offline}
          >
            {compact ? t("keys.continue") : t(FULL_NAME[next])}
          </Key>
        ) : null}
      </div>
    </div>
  );
}
