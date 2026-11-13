import type { ElementType, ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { cx } from "./cx";

/**
 * Note — Design v2.1 G5 (docs/DESIGN.md §15.5, docs/UI.md "Note"): ONE pattern for side information — the before's
 * calm way of writing it (client notes 5 and 8). A neutral soft card: an icon in a circle on the start side, a short
 * bold title line, muted text (16px / 1.75), and an optional action on its own line with an arrow. Tinted only where
 * the tone matters, and then only the circle: the card stays neutral and the words stay ink.
 *
 *   <Note icon="shopping-bag" title={t("guestTitle")} action={<TextLink as={LocaleLink} to="/account/sign-in">{t("signIn")}</TextLink>}>
 *     {t("guestText")}
 *   </Note>
 *   <Note tone="info" icon="info" title={t("transferTitle")}>{t("transferRule")}</Note>
 *   <Note tone="warning" title={t("beforeYouOrder")}>{t("checkCompat")}</Note>
 *   <Note tone="danger" title={t("stopNow")}>{t("unplugIt")}</Note>             a safety warning: the circle and the title red
 *   <Note tone="demo">{t("demoOrder")}</Note>                                   «طلب تجريبي…» in the demo pair
 *   <Note variant="line" icon="credit-card">{t("payLine")}</Note>               a quiet line with an icon, no card (16px)
 *   <Note variant="flat" …>                                                     inside another card or a sheet
 *
 * Replaces bold side paragraphs and tinted callouts with inline links (the v2 product page's payment sentence, the
 * checkout's green guest strip). Write a short title (≤ 6 words) and one or two sentences; the action says what it
 * does («سجّل الدخول»). Never for errors that block a form (use the field error and the form summary) and never for
 * the demo marking's strip or chip (DemoNote).
 */
export type NoteTone = "neutral" | "info" | "success" | "warning" | "danger" | "demo";

export type NoteProps = {
  /** The short bold line. Optional: a note can be one sentence. */
  title?: ReactNode;
  /** The muted text. */
  children?: ReactNode;
  /** An action on its own line (a <TextLink> with its arrow, or a small <Key>). */
  action?: ReactNode;
  /** The icon in the circle. Default per tone: neutral info · info info · success check-circle · warning warning ·
   *  danger warning-circle · demo info. */
  icon?: IconName;
  tone?: NoteTone;
  /** card (default): the soft raised card · flat: no raise (inside another card) · line: a quiet line, no card. */
  variant?: "card" | "flat" | "line";
  /**
   * The element (default <div>). An <aside> in <main> is a complementary LANDMARK — one per note, unnamed, would crowd
   * the landmark list — so pass `as="aside"` only for a page's one real side panel, with an aria-label.
   */
  as?: ElementType;
  "aria-label"?: string;
  /** Live region for a note that appears after an action ("polite"). */
  "aria-live"?: "polite" | "off";
  className?: string;
};

const TONE_ICON: Record<NoteTone, IconName> = {
  neutral: "info",
  info: "info",
  success: "check-circle",
  warning: "warning",
  danger: "warning-circle",
  demo: "info",
};

export function Note({ title, children, action, icon, tone = "neutral", variant = "card", as, "aria-live": live, "aria-label": label, className }: NoteProps) {
  const Tag: ElementType = as ?? "div";
  return (
    <Tag className={cx("note", tone !== "neutral" && `note--${tone}`, variant !== "card" && `note--${variant}`, className)} aria-live={live} aria-label={label}>
      <span className="note__icon" aria-hidden="true">
        <Icon name={icon ?? TONE_ICON[tone]} size={variant === "line" ? 20 : 22} />
      </span>
      {title ? <p className="note__title">{title}</p> : null}
      {children !== undefined && children !== null && children !== false ? <div className="note__text">{children}</div> : null}
      {action ? <div className="note__action">{action}</div> : null}
    </Tag>
  );
}
