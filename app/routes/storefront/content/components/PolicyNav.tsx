import { useId } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";
import { policyOrder, type PolicySummary } from "../content-model";

/**
 * Every policy, the current one marked (aria-current, weight 600 and an ink bar at the inline start — never colour
 * alone). Between the six known policies the link asks for the sideways push in their order (DESIGN.md §7.2); a
 * policy the owner added in the CMS has no order and fades. Drafts say so in words.
 */
export function PolicyNav({ policies, current, className }: { policies: readonly PolicySummary[]; current: string; className?: string }) {
  const t = useT("content");
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className={cx("grid content-start gap-3", className)}>
      <h2 id={headingId} className="type-sub text-ink">
        {t("common.allPolicies")}
      </h2>
      <ul className="grid gap-1">
        {policies.map((policy) => {
          const order = policyOrder(policy.slug);
          const here = policy.slug === current;
          return (
            <li key={policy.slug}>
              <MotionLink
                to={`/policies/${policy.slug}`}
                nav={order === null ? "fade" : "push"}
                order={order ?? undefined}
                aria-current={here ? "page" : undefined}
                data-press="soft"
                className={cx(
                  "group flex min-h-11 items-center gap-3 rounded-sm border-s-[3px] py-2 ps-3 pe-2",
                  here ? "border-ink bg-niche text-ink" : "border-transparent text-ink-2 hover:text-ink",
                )}
              >
                <Icon name={policy.icon} size={18} />
                <span className={cx("min-w-0 flex-1 decoration-[1.5px] underline-offset-[6px] group-hover:underline", here ? "type-strong" : "type-label")}>{policy.title}</span>
                {policy.approved ? null : <span className="shrink-0 type-caption text-ink-2">{t("common.draftShort")}</span>}
              </MotionLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
