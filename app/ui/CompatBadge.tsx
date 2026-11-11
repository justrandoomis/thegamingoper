import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import type { CompatibilityStatus } from "~/lib/dto";
import { cx } from "./cx";

/**
 * Compatibility as a stated fact (docs/DESIGN.md §8.7, brief §6): an icon AND words in a state colour — never colour
 * alone, never a chip (it is not a choice), never inferred. "unverified" is a first-class answer, not a soft yes.
 *
 *   <CompatBadge status="verified" device="Nintendo Switch 2" />       ✓ متوافق مع Nintendo Switch 2
 *   <CompatBadge status="partial" device="PS5" note={rule.note} />     ⚠ متوافق جزئياً مع PS5 + the reason underneath
 *   <CompatBadge status="incompatible" device="Xbox Series S" />       ✕ غير متوافق مع Xbox Series S
 *   <CompatBadge status="unverified" />                                ? لم نتحقق من التوافق بعد
 *
 * Feed it `getCompatibilityForProduct()` rows (devices area, docs/CONTRACTS.md §3).
 */
export type CompatBadgeProps = {
  status: CompatibilityStatus;
  /** Device name (Latin names stay Latin and are isolated). */
  device?: string | null;
  /** The rule's note (why partial / what is missing), in the page's language. */
  note?: string | null;
  className?: string;
};

const LOOK: Record<CompatibilityStatus, { icon: IconName; tone: string; key: string }> = {
  verified: { icon: "check-circle", tone: "text-ok", key: "verified" },
  partial: { icon: "warning", tone: "text-warn", key: "partial" },
  incompatible: { icon: "x-circle", tone: "text-red-ink", key: "incompatible" },
  unverified: { icon: "question", tone: "text-ink-2", key: "unverified" },
};

export function CompatBadge({ status, device, note, className }: CompatBadgeProps) {
  const t = useT("ui-shop");
  const look = LOOK[status] ?? LOOK.unverified;
  const words = device ? t(`compat.${look.key}With`, { device: `⁨${device}⁩` }) : t(`compat.${look.key}`);
  return (
    <span className={cx("inline-grid gap-0.5", className)} data-compat={status}>
      <span className={cx("inline-flex items-start gap-1.5 type-label font-semibold", look.tone)}>
        <Icon name={look.icon} size={18} mirror={false} className="mt-px" filled={status !== "unverified"} />
        <span>{words}</span>
      </span>
      {note ? <span className="ps-6 type-caption text-ink-2">{note}</span> : null}
    </span>
  );
}
