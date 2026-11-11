import type { ElementType, ReactNode } from "react";

import { Icon, ICONS_WITH_FILL, type IconName } from "~/art/Icon";
import { cx } from "./cx";
import { Key, type KeyProps } from "./Key";

/**
 * The icon button — Design System v2 §4.4: a flat 40px circle (36 inside a compact stepper, 32 only on product
 * photos) that always keeps a 44px hit area. `label` is required: it is the accessible name (and the pointer
 * tooltip) and names the object ("أضف PlayStation 5 Slim إلى المفضلة").
 *
 *   <IconKey icon="x" label={t("close")} onClick={close} />                              outline (default): paper + hairline
 *   <IconKey icon="x" label={t("close")} variant="plain" />                              transparent (bars, sheet heads)
 *   <IconKey icon="heart" label={…} variant="onImage" size="xs" />                       on a product photo
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
  /** md 40 (default) · sm 36 (inside a 40px stepper) · xs 32 (on product photos only). All keep a 44px hit area. */
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
 * A held icon button keeps its own face (v2 §4.4: the filled glyph and aria-pressed say "on", never an ink disc). The
 * stylesheet's "selected = ink" rule outranks its round-key exception (an :is() with :has() weighs more), so the face
 * is restated here as utilities — storefront only: the admin keeps its 1.0 held-down ink key.
 */
const HELD_FACE: Record<IconKeyVariant, string> = {
  outline: "not-admin:[--face:var(--paper)] not-admin:[--edge:var(--line-2)]",
  clay: "not-admin:[--face:var(--paper)] not-admin:[--edge:var(--line-2)]",
  ink: "not-admin:[--face:var(--paper)] not-admin:[--edge:var(--line-2)]",
  commit: "not-admin:[--face:var(--paper)] not-admin:[--edge:var(--line-2)]",
  plain: "not-admin:[--face:transparent] not-admin:[--edge:transparent]",
  quiet: "not-admin:[--face:transparent] not-admin:[--edge:transparent]",
  onImage: "not-admin:[--face:var(--on-image)] not-admin:[--edge:var(--line-glass)]",
  onColor: "not-admin:[--face:var(--on-color)] not-admin:[--edge:transparent]",
};

export function IconKey<C extends ElementType = "button">({ icon, label, size = "md", held, className, variant = "outline", ...rest }: IconKeyProps<C>) {
  const glyph = typeof icon === "string" ? <Icon name={icon as IconName} size={20} filled={Boolean(held) && ICONS_WITH_FILL.has(icon as IconName)} /> : icon;
  const wish = typeof className === "string" && className.includes("key--wish");
  const heldFace = held
    ? cx(HELD_FACE[variant] ?? HELD_FACE.outline, "not-admin:[--hover-face:var(--niche)]", wish ? "not-admin:[--on:var(--red-ink)]" : "not-admin:[--on:var(--ink)]")
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
