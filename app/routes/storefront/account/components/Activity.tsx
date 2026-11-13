import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import type { TFunction } from "~/i18n/translate";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";
import { fillNodes } from "~/ui/PriceTag";

/** «الطلب TT-…» (account `rewards.order`) kept on one line, the number left-to-right: it never breaks at its hyphen. */
export function orderRefText(t: TFunction, ref: string): ReactNode {
  return (
    <span className="whitespace-nowrap">
      {fillNodes(t("rewards.order"), {
        ref: (
          <bdi dir="ltr" className="nums">
            {ref}
          </bdi>
        ),
      })}
    </span>
  );
}

/**
 * Facts that share one line of a row (when, for which order): each part wraps whole (account.css `.acct-meta`) — one
 * idea per line in a narrow row; side by side with a dot between them where there is room. The dot is drawn by the
 * stylesheet before every part and clipped when the part starts a line, so a line never ends (or starts) with a dot —
 * and it is never read out. Empty parts are dropped.
 *
 *   <MetaLine parts={[<time …>12/11/2026</time>, orderRefText(t, ref)]} />
 */
export function MetaLine({ parts, className }: { parts: readonly ReactNode[]; className?: string }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return (
    <span className={cx("acct-meta", className)}>
      {shown.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </span>
  );
}

/** What an entry did, for its disc: money or points in (ok), out (red), given back (info), the store's own (neutral). */
export type ActivityTone = "ok" | "red" | "info" | "neutral";

export type ActivityItem = {
  id: string;
  icon: IconName;
  tone: ActivityTone;
  title: ReactNode;
  meta?: ReactNode;
  /** The signed figure, already formatted ("+1,500", "−1,000"); the sign is a character, never colour alone. */
  amount: ReactNode;
  sign: "credit" | "debit" | "zero";
  /** A locale-less path the whole row opens (the order it belongs to). */
  to?: string;
};

/**
 * A history (Design v2.1, the reference card's «العمليات الأخيرة»): a soft card of rows — a disc tinted by what the entry
 * did, its words and date, the signed amount at the end (+ green, − red). A row that belongs to one of the customer's
 * orders is one link into it, with a chevron.
 */
export function ActivityList({ items, label, className }: { items: readonly ActivityItem[]; label?: string; className?: string }) {
  return (
    <ol className={cx("acct-activity", className)} aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <ActivityRow item={item} />
        </li>
      ))}
    </ol>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const body = (
    <>
      <span className={cx("acct-act__disc", item.tone !== "neutral" && `acct-act__disc--${item.tone}`)} aria-hidden="true">
        <Icon name={item.icon} size={20} />
      </span>
      <span className="acct-act__body">
        <span className="acct-act__title">{item.title}</span>
        {item.meta ? <span className="acct-act__meta">{item.meta}</span> : null}
      </span>
      <span className="acct-act__amount" data-sign={item.sign}>
        {item.amount}
      </span>
      {item.to ? <Icon name="caret-right" size={18} className="acct-act__go" /> : null}
    </>
  );
  if (item.to) {
    return (
      <MotionLink to={item.to} nav="rise" className="acct-act" data-press="soft">
        {body}
      </MotionLink>
    );
  }
  return <div className="acct-act">{body}</div>;
}
