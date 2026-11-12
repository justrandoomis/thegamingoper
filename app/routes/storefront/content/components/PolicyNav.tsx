import { useId } from "react";

import { useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";
import { policyOrder, type PolicySummary } from "../content-model";

/**
 * Every policy (Design System v2 §6.15: the 240px list beside the text from 1024, after it on smaller screens): a
 * hairline rail, the current one marked by an ink bar at the inline start, weight 600 and aria-current — never colour
 * alone. Between the six known policies the link asks for the sideways push in their order (DESIGN.md §7.2); a policy
 * the owner added in the CMS has no order and fades. No per-row "draft" words: the page's status line says it once.
 */
export function PolicyNav({ policies, current, className }: { policies: readonly PolicySummary[]; current: string; className?: string }) {
  const t = useT("content");
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className={cx("ctoc", className)}>
      <h2 id={headingId} className="ctoc__title">
        {t("common.allPolicies")}
      </h2>
      <ul className="ctoc__list">
        {policies.map((policy) => {
          const order = policyOrder(policy.slug);
          return (
            <li key={policy.slug}>
              <MotionLink
                to={`/policies/${policy.slug}`}
                nav={order === null ? "fade" : "push"}
                order={order ?? undefined}
                aria-current={policy.slug === current ? "page" : undefined}
                data-press="soft"
                className="ctoc__link"
              >
                {policy.title}
              </MotionLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
