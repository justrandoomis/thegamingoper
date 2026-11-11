import { useRef, type ReactNode, type ToggleEvent as ReactToggleEvent } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { durations, easings, getMotionTier } from "~/motion";
import { cx } from "./cx";

/**
 * Disclosure — a native <details>/<summary>: one row that opens to show more (FAQ answers, warranty terms, the
 * "what is checked" list of a used device, filter groups in the admin). Native means: keyboard (Enter / Space on the
 * summary), `aria-expanded`, find-in-page opens it, and it works before JavaScript has loaded.
 *
 *   <Disclosure summary={t("whatWarranty")}>{t("warrantyText")}</Disclosure>
 *   <Disclosure summary={t("checked")} icon="clipboard-text" defaultOpen variant="panel">…</Disclosure>
 *   <Disclosure summary={…} open={open} onOpenChange={setOpen}>…</Disclosure>      mirror its state
 *   <Disclosure summary={…} name="faq">…</Disclosure> × n                         one open at a time (native group)
 *
 * The caret turns over (transform only); the content fades in 4px (opacity and transform, 160ms) when it opens —
 * the height itself never animates (DESIGN.md §6.6.5). Reduced motion: no movement. Flat: a row with a hairline
 * (`variant="row"`, 56px, inside an <Accordion>) or a paper panel with a hairline (`variant="panel"`) — v2 §4.1.
 */
export type DisclosureProps = {
  /** The always-visible row: say what is inside ("ما الذي يشمله الضمان؟"). */
  summary: ReactNode;
  children: ReactNode;
  /** Starts open (uncontrolled). */
  defaultOpen?: boolean;
  /** Mirror the open state (the shopper still toggles it natively; update `open` in onOpenChange). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Disclosures with the same name form a group: opening one closes the others (native <details name>). */
  name?: string;
  /** A leading icon in the summary row. */
  icon?: IconName;
  /** "row" (default): a 56px row with a hairline under it · "panel": a paper panel with a hairline. */
  variant?: "row" | "panel";
  className?: string;
  bodyClassName?: string;
};

export function Disclosure({ summary, children, defaultOpen, open, onOpenChange, name, icon, variant = "row", className, bodyClassName }: DisclosureProps) {
  const body = useRef<HTMLDivElement | null>(null);
  const onToggle = (event: ReactToggleEvent<HTMLDetailsElement>) => {
    const isOpen = event.currentTarget.open;
    onOpenChange?.(isOpen);
    if (isOpen && body.current) reveal(body.current);
  };
  const panel = variant === "panel";
  return (
    <details
      name={name}
      open={open ?? defaultOpen}
      onToggle={onToggle}
      className={cx("group min-w-0", panel ? "panel" : "border-b border-line", className)}
    >
      <summary
        className={cx(
          "flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-sm py-3 type-strong text-ink outline-offset-2 [&::-webkit-details-marker]:hidden",
          panel && "px-4",
        )}
      >
        {icon ? <Icon name={icon} size={20} className="text-ink-2" /> : null}
        <span className="min-w-0 flex-1">{summary}</span>
        <Icon
          name="caret-down"
          size={20}
          className="text-ink-2 transition-transform duration-(--t-micro) group-open:rotate-180 motion-reduce:transition-none [[data-motion=reduced]_&]:transition-none"
        />
      </summary>
      <div ref={body} className={cx("pb-4 type-body text-ink", panel && "px-4", bodyClassName)}>
        {children}
      </div>
    </details>
  );
}

/** The opening content settles 4px down while it fades in. Nothing at all under reduced motion. */
function reveal(element: HTMLElement): void {
  if (getMotionTier() === "reduced" || typeof element.animate !== "function") return;
  element.animate([{ opacity: 0, translate: "0 -4px" }, { opacity: 1, translate: "0 0" }], { duration: durations.micro, easing: easings.settle });
}
