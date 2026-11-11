import { Children, isValidElement, type ComponentPropsWithRef, type ElementType, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * The text link — Design System v2 §4.5: ink, weight 600, 14px (16 in running text), a 1px underline in --line-2 that
 * turns ink under the pointer, and an arrow toward the reading end that nudges 3px. 44px tall outside running text.
 * Links are never red and never a third button style.
 *
 *   <TextLink as={LocaleLink} to="/platform/playstation">{t("allPlatform", { name })}</TextLink>   "كل PlayStation ←"
 *   <TextLink as={MotionLink} nav="push" to="/used" arrow={false}>{t("used")}</TextLink>
 *   <p>… <TextLink as={LocaleLink} to="/policies/returns" inline>{t("returns")}</TextLink> …</p>  always underlined
 *   <TextLink as="a" href="https://wa.me/…" external>WhatsApp</TextLink>                            new tab, said aloud
 *   <TextLink as={LocaleLink} to={editTo} icon="pencil-simple" arrow={false}>{t("edit")}</TextLink>
 *   <TextLink as="button" type="button" tone="danger" onClick={remove}>{t("removeAddress")}</TextLink>
 *
 * The icon sits OUTSIDE the underlined words (a leading <Icon> passed as the first child is moved there too), so it
 * never takes a line of its own.
 */
export type TextLinkOwnProps = {
  /** Trailing arrow pointing toward the reading end (← in Arabic and Kurdish, → in English). Default on, off for `inline`. */
  arrow?: boolean;
  /** A leading 16px icon, outside the underline. */
  icon?: IconName;
  /** Always underlined, inherits the paragraph's type. */
  inline?: boolean;
  /** Opens in a new tab: adds rel/target and tells assistive technology. */
  external?: boolean;
  /** "danger" = a destructive text action in --danger words (it must state the consequence). */
  tone?: "ink" | "danger";
  className?: string;
  children: ReactNode;
};

export type TextLinkProps<C extends ElementType = "a"> = TextLinkOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof TextLinkOwnProps | "as">;

/** A leading icon element among the children: <Icon …/> or a bare <svg>. */
function isGlyph(node: ReactNode): boolean {
  return isValidElement(node) && (node.type === Icon || node.type === "svg");
}

export function TextLink<C extends ElementType = "a">({ as, arrow, icon, inline = false, external = false, tone = "ink", className, children, ...rest }: TextLinkProps<C>) {
  const t = useT("ui");
  const Tag: ElementType = as ?? "a";
  const showArrow = arrow ?? !inline;
  const externalProps = external ? { target: "_blank", rel: "noopener noreferrer" } : null;
  const parts = Children.toArray(children);
  const lead = parts.length > 1 && isGlyph(parts[0]) ? parts[0] : null;
  const words = lead ? parts.slice(1) : children;
  return (
    <Tag {...rest} {...externalProps} className={cx("link", inline && "link--inline", tone === "danger" && "link--danger", className)}>
      {icon ? <Icon name={icon} size={16} /> : lead}
      <span className="link__text">{words}</span>
      {external ? (
        <>
          <Icon name="arrow-square-out" size={16} />
          <VisuallyHidden> ({t("link.external")})</VisuallyHidden>
        </>
      ) : showArrow ? (
        <Icon name="arrow-right" size={16} />
      ) : null}
    </Tag>
  );
}
