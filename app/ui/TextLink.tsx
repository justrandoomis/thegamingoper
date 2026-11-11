import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * The one link look (docs/DESIGN.md §9.1): ink, weight 600, an arrow that follows the reading direction, underlined
 * on hover; at least 44px tall. Inside a paragraph the same link is always underlined (`inline`). Links are never
 * red and never clay — a text-only action is a TextLink, not a third button style.
 *
 *   <TextLink as={LocaleLink} to="/platform/playstation">{t("allPlatform", { name })}</TextLink>   "كل PlayStation ←"
 *   <TextLink as={MotionLink} nav="push" to="/used" arrow={false}>{t("used")}</TextLink>
 *   <p>… <TextLink as={LocaleLink} to="/policies/returns" inline>{t("returns")}</TextLink> …</p>
 *   <TextLink as="a" href="https://wa.me/…" external>WhatsApp</TextLink>                            new tab, said aloud
 *   <TextLink as="button" type="button" tone="danger" onClick={remove}>{t("removeAddress")}</TextLink>
 */
export type TextLinkOwnProps = {
  /** Trailing arrow pointing toward the reading end (← in Arabic and Kurdish, → in English). Default on, off for `inline`. */
  arrow?: boolean;
  /** Always underlined, inherits the paragraph's type. */
  inline?: boolean;
  /** Opens in a new tab: adds rel/target and tells assistive technology. */
  external?: boolean;
  /** "danger" = a destructive text action in red-ink words (it must state the consequence). */
  tone?: "ink" | "danger";
  className?: string;
  children: ReactNode;
};

export type TextLinkProps<C extends ElementType = "a"> = TextLinkOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof TextLinkOwnProps | "as">;

export function TextLink<C extends ElementType = "a">({ as, arrow, inline = false, external = false, tone = "ink", className, children, ...rest }: TextLinkProps<C>) {
  const t = useT("ui");
  const Tag: ElementType = as ?? "a";
  const showArrow = arrow ?? !inline;
  const externalProps = external ? { target: "_blank", rel: "noopener noreferrer" } : null;
  return (
    <Tag {...rest} {...externalProps} className={cx("link", inline && "link--inline", tone === "danger" && "link--danger", className)}>
      <span className="link__text">{children}</span>
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
