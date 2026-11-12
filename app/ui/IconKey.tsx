import type { ElementType, ReactNode } from "react";

import { Icon, ICONS_WITH_FILL, type IconName } from "~/art/Icon";
import { cx } from "./cx";
import { Key, type KeyProps } from "./Key";

/**
 * The icon button — Design System v2 §4.4; v2.1 (DESIGN.md §15.2, client note 4): a raised 44px CLAY CIRCLE (36 small,
 * 32 on product photos) with the icon at the before's weight, rising 1px under the pointer and sinking onto its wall
 * when pressed; always a 44px hit area. `label` is required: it is the accessible name (and the pointer tooltip) and
 * names the object ("أضف PlayStation 5 Slim إلى المفضلة").
 *
 *   <IconKey icon="x" label={t("close")} onClick={close} />                              outline (default): a clay circle
 *   <IconKey icon="x" label={t("close")} variant="plain" />                              transparent (bars, sheet heads)
 *   <IconKey icon="heart" label={…} variant="onImage" size="sm" />                       a frosted disc on a photo
 *   <IconKey as={LocaleLink} to=… icon="arrow-right" label={…} variant="onColor" />      the white disc on tiles and bands
 *   <IconKey icon="heart" label={…} held={on} onClick={toggle} />                        held → filled glyph + aria-pressed
 *
 * State is never colour alone: a held icon button takes the filled weight of its glyph and exposes `aria-pressed`.
 * 1.0 names keep working until stage 4: `clay` and `ink` render outline, `quiet` renders plain, `commit` renders the
 * neutral card add button look (the red round key is retired).
 */
export type IconKeyVariant = "outline" | "plain" | "onImage" | "onColor" | /* 1.0 */ "clay" | "ink" | "quiet" | "commit";

export type IconKeyProps<C extends ElementType = "button"> = Omit<KeyProps<C>, "icon" | "iconEnd" | "children" | "size" | "block" | "variant"> & {
  icon: IconName | ReactNode;
  /** Accessible name. Say what happens and to what: "أغلق", "أضف … إلى المفضلة". */
  label: string;
  variant?: IconKeyVariant;
  /** md 44 (default, v2.1) · sm 36 · xs 32 (on small product photos only). All keep a 44px hit area. */
  size?: "md" | "sm" | "xs";
};

const VARIANT_CLASS: Record<IconKeyVariant, string> = {
  outline: "key--outline",
  clay: "key--outline",
  ink: "key--outline",
  plain: "key--plain",
  quiet: "key--plain",
  onImage: "key--on-image",
  onColor: "key--on-color",
  commit: "key--outline cadd",
};

const SIZE_CLASS = { md: undefined, sm: "key--sm", xs: "key--xs" } as const;

/*
 * A held icon button keeps its own face (v2 §4.4: the filled glyph and aria-pressed say "on", never an ink disc; v2.1:
 * the clay circle stays clay). The stylesheet's "selected = ink" rule leaves round keys out; the face is restated here
 * as utilities all the same, so no later rule can paint a held icon key ink — storefront only: the admin keeps its 1.0
 * held-down ink key.
 */
const CLAY_HELD = "not-admin:[--face:var(--key-face)] not-admin:[--edge:var(--key-edge)] not-admin:[--hover-face:var(--key-face-hover)]";
const HELD_FACE: Record<IconKeyVariant, string> = {
  outline: CLAY_HELD,
  clay: CLAY_HELD,
  ink: CLAY_HELD,
  commit: CLAY_HELD,
  plain: "not-admin:[--face:transparent] not-admin:[--edge:transparent] not-admin:[--hover-face:var(--niche)]",
  quiet: "not-admin:[--face:transparent] not-admin:[--edge:transparent] not-admin:[--hover-face:var(--niche)]",
  onImage: "not-admin:[--face:var(--on-image)] not-admin:[--edge:var(--line-glass)] not-admin:[--hover-face:var(--paper)]",
  onColor: "not-admin:[--face:var(--on-color)] not-admin:[--edge:transparent] not-admin:[--hover-face:var(--on-color)]",
};

export function IconKey<C extends ElementType = "button">({ icon, label, size = "md", held, className, variant = "outline", ...rest }: IconKeyProps<C>) {
  const glyph = typeof icon === "string" ? <Icon name={icon as IconName} size={20} filled={Boolean(held) && ICONS_WITH_FILL.has(icon as IconName)} /> : icon;
  const wish = typeof className === "string" && className.includes("key--wish");
  const heldFace = held
    ? cx(HELD_FACE[variant] ?? HELD_FACE.outline, wish ? "not-admin:[--on:var(--red-ink)]" : "not-admin:[--on:var(--ink)]")
    : undefined;
  const keyProps = {
    ...rest,
    variant: "secondary",
    held,
    icon: glyph,
    className: cx("key--round", VARIANT_CLASS[variant] ?? "key--outline", SIZE_CLASS[size], heldFace, className),
    "aria-label": label,
    title: (rest as { title?: string }).title ?? label,
    "data-press": "icon",
  } as unknown as KeyProps<C>;
  return <Key {...keyProps} />;
}
