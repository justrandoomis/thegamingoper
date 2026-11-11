import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import type { CompatibilityStatus } from "~/lib/dto";
import { BidiText } from "./BidiText";
import { cx } from "./cx";

/**
 * Compatibility as a stated fact — Design System v2 §4.1 (CompatBadge) and G17: an icon AND a state word — يعمل ·
 * يعمل جزئياً · لا يعمل · لم نتحقق — never colour alone, never a chip (it is not a choice), never inferred. "unverified"
 * is a first-class answer, not a soft yes.
 *
 *   <CompatBadge status="verified" device="Nintendo Switch 2" />       ✓ متوافق مع Nintendo Switch 2
 *   <CompatBadge status="partial" device="PS5" note={rule.note} />     ⚠ متوافق جزئياً مع PS5 + the reason underneath
 *   <CompatList rows={[{ status: "verified", device: "PS5 Slim" }, { status: "unverified", device: "PS5 Pro" }]} />
 *        a paper card of rows: the device, then its state word (and the note)
 *
 * Feed them `getCompatibilityForProduct()` rows (devices area, docs/CONTRACTS.md §3).
 */
export type CompatBadgeProps = {
  status: CompatibilityStatus;
  /** Device name (Latin names stay Latin and are isolated). */
  device?: string | null;
  /** The rule's note (why partial / what is missing), in the page's language. */
  note?: string | null;
  className?: string;
};

type Look = { icon: IconName; tone: string; key: string; state: "yes" | "part" | "no" | "unknown" };

const LOOK: Record<CompatibilityStatus, Look> = {
  verified: { icon: "check-circle", tone: "text-ok", key: "verified", state: "yes" },
  partial: { icon: "warning", tone: "text-warn", key: "partial", state: "part" },
  incompatible: { icon: "x-circle", tone: "text-danger", key: "incompatible", state: "no" },
  unverified: { icon: "question", tone: "text-ink-2", key: "unverified", state: "unknown" },
};

export function CompatBadge({ status, device, note, className }: CompatBadgeProps) {
  const t = useT("ui-shop");
  const look = LOOK[status] ?? LOOK.unverified;
  const words = device ? t(`compat.${look.key}With`, { device: `⁨${device}⁩` }) : t(`compat.${look.key}`);
  return (
    <span className={cx("inline-grid gap-0.5", className)} data-compat={status}>
      <span className={cx("inline-flex items-start gap-1.5 type-sm-strong", look.tone)}>
        <Icon name={look.icon} size={20} filled={status !== "unverified"} />
        <span>{words}</span>
      </span>
      {note ? <span className="ps-7 type-xs text-ink-2">{note}</span> : null}
    </span>
  );
}

export type CompatRow = { status: CompatibilityStatus; device: string; note?: string | null };

/** Compatibility rows in one paper card: a mark, the device, and its state word («يعمل جزئياً · …»). */
export function CompatList({ rows, className }: { rows: readonly CompatRow[]; className?: string }) {
  const t = useT("ui-shop");
  if (rows.length === 0) return null;
  return (
    <ul className={cx("compat", className)}>
      {rows.map((row, index) => {
        const look = LOOK[row.status] ?? LOOK.unverified;
        return (
          <li key={`${row.device}-${index}`} className="compat__row" data-state={look.state}>
            <span className="compat__mark">
              <Icon name={look.icon === "check-circle" ? "check" : look.icon === "x-circle" ? "x" : look.icon} size={16} />
            </span>
            <span className="compat__name">
              <BidiText text={row.device} />
            </span>
            <span className="compat__state">
              {t(`compat.state.${look.key}`)}
              {row.note ? <> · {row.note}</> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
