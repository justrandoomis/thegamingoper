import type { ElementType, ReactNode } from "react";

import { Icon, ICONS_WITH_FILL, type IconName } from "~/art/Icon";
import { cx } from "./cx";
import { Key, type KeyProps, type KeyVariant } from "./Key";

/**
 * A round key with an icon and no visible text: favourite, close, copy, back/cart orbs, the stepper's − and +.
 * `label` is required — it is the accessible name (and the pointer tooltip).
 *
 *   <IconKey icon="x" label={t("close")} onClick={close} />
 *   <IconKey icon="heart" label={t("favourite")} held={isFavourite} onClick={toggle} />   held → filled heart
 *   <IconKey icon="copy" label={t("copyAccount")} size="sm" />                           36px, 44px hit area
 *   <IconKey as={LocaleLink} to="/cart" icon="shopping-bag" label={t("cart")} variant="quiet" />
 *
 * Held state is never depth alone: a held icon key also takes the filled weight of its icon when the sprite has
 * one, and exposes `aria-pressed`.
 */
export type IconKeyProps<C extends ElementType = "button"> = Omit<KeyProps<C>, "icon" | "iconEnd" | "children" | "size" | "block" | "variant"> & {
  icon: IconName | ReactNode;
  /** Accessible name. Say what happens: "أغلق", "أضف إلى المفضلة". */
  label: string;
  variant?: KeyVariant;
  /** md 44 (default) · sm 36 with a 44px hit area (inside cart lines). */
  size?: "md" | "sm";
};

export function IconKey<C extends ElementType = "button">({ icon, label, size = "md", held, className, variant = "clay", ...rest }: IconKeyProps<C>) {
  const glyphSize = size === "sm" ? 18 : 20;
  const glyph =
    typeof icon === "string" ? <Icon name={icon as IconName} size={glyphSize} filled={Boolean(held) && ICONS_WITH_FILL.has(icon as IconName)} /> : icon;
  const keyProps = {
    ...rest,
    variant,
    held,
    size: size === "sm" ? "sm" : "md",
    icon: glyph,
    className: cx("key--round", className),
    "aria-label": label,
    title: (rest as { title?: string }).title ?? label,
  } as unknown as KeyProps<C>;
  return <Key {...keyProps} />;
}
