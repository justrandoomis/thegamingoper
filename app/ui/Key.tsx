import { isValidElement, type ComponentPropsWithRef, type ElementType, type MouseEvent, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * The button — Design System v2 §4.3; v2.1 "Clay & Glass" (DESIGN.md §15.2, docs/UI.md §2): the before's tactile keys —
 * a raised face on a static 2px wall that rises 1px under the pointer and sinks onto the wall when pressed (the cast
 * shortens). Labels in Kufam 600 (16px; the 40px key keeps Plex 600 14px, under Kufam's floor). Five looks, two heights:
 *
 *   <Key variant="primary" icon="bag-plus" onClick={add}>{t("add")}</Key>   the ONE glossy red action of a view
 *   <Key onClick={…}>{t("filters")}</Key>                                   secondary (default): white-to-cream clay
 *   <Key variant="ghost" onClick={undo}>{t("undo")}</Key>                   quiet actions in bars and lists
 *   <Key variant="onBand" as={MotionLink} to=…>{t("buy")}</Key>             the white key on the crimson hero / wallet band
 *   <Key variant="danger" onClick={remove}>{t("remove")}</Key>              destructive confirmations (never brand red)
 *   <Key size="sm">…</Key>                                                  40px (48 is the default; there is no third)
 *   <Key as={LocaleLink} to="/cart">…</Key> · <Key as={MotionLink} nav="zoom" to=…>…</Key> · <Key as="a" href=…>
 *   <Key held={on} onClick={toggle}>…</Key>                                 a toggle: aria-pressed, ink face
 *   <Key loading={busy}>…</Key>                                             same width, 16px spinner, aria-busy
 *
 * Rules: one primary per view (lint). Ink fill means "selected", never "action". A disabled key states its reason in
 * text beside it. A button never contains another button. Icon-only actions are <IconKey label>.
 *
 * 1.0 names keep working until stage 4 (§4.2): `commit` renders primary, `clay` and `ink` render secondary (the admin
 * keeps its 1.0 ink key through `.key--ink`), `quiet` renders ghost, `lg` is 48.
 *
 * Press feedback comes from the Motion Engine (`data-press`; <MotionRoot> mounted by the layout): every walled key (v2.1:
 * primary, secondary, on-band, danger) moves only its cap onto the 2px wall; ghost keys compress softly. The primary adds
 * a light haptic where supported.
 */
export type KeyVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "onBand"
  | "danger"
  /** 1.0 aliases — stage 4 deletes them. */
  | "commit"
  | "clay"
  | "ink"
  | "quiet";
export type KeySize = "sm" | "md" | "lg";

export type KeyOwnProps = {
  /** primary (one per view) · secondary (default) · ghost · onBand · danger. 1.0: commit · clay · ink · quiet. */
  variant?: KeyVariant;
  /** md 48 (default) · sm 40. `lg` is a 1.0 name for 48. Both keep a ≥ 44px hit area. */
  size?: KeySize;
  /** Leading icon: a sprite name or any decorative node. */
  icon?: IconName | ReactNode;
  /** Trailing icon (a direction arrow, a caret). Directional sprite icons mirror in RTL by themselves. */
  iconEnd?: IconName | ReactNode;
  /** Busy: keeps its width, shows a spinner, announces "loading", ignores activation (stays focusable). */
  loading?: boolean;
  /** A toggle that is on: ink-faced, `aria-pressed`. Leave undefined for a plain action. */
  held?: boolean;
  /** Fill the inline size of the container (sheets, task bars, the phone hero only). */
  block?: boolean;
  /** A long label (Sorani's «لەگەڵ کارمەندێک قسە بکە») may take a second line, balanced: the key grows from its 48px
   *  instead of cutting the words (v2.1 fix round). */
  wrap?: boolean;
  /** "compact": a task bar's key on a 320–375 phone — 44px tall, 12px sides (the hit area is the key itself). */
  fit?: "compact";
  /** Buttons get the `disabled` attribute; links get `aria-disabled` and do not navigate. */
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
};

export type KeyProps<C extends ElementType = "button"> = KeyOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof KeyOwnProps | "as">;

/** The v2 look each name renders. */
export type KeyLook = "primary" | "secondary" | "ghost" | "onBand" | "danger";

export const KEY_LOOK: Record<KeyVariant, KeyLook> = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  onBand: "onBand",
  danger: "danger",
  commit: "primary",
  clay: "secondary",
  ink: "secondary",
  quiet: "ghost",
};

/* `ink` keeps its own class: the storefront draws it as secondary, the admin (1.0 materials) as its ink key. */
const VARIANT_CLASS: Record<KeyVariant, string> = {
  primary: "key--primary",
  commit: "key--primary",
  secondary: "key--secondary",
  clay: "key--secondary",
  ink: "key--ink",
  ghost: "key--ghost",
  quiet: "key--ghost",
  onBand: "key--on-band",
  danger: "key--danger",
};
const SIZE_CLASS: Record<KeySize, string | undefined> = { sm: "key--sm", md: undefined, lg: "key--lg" };

/** Clay keys travel onto their wall; every other key compresses softly. */
export function keyPress(look: KeyLook): "clay" | "soft" {
  return look === "primary" || look === "onBand" ? "clay" : "soft";
}

export function keyIcon(icon: IconName | ReactNode, size: number): ReactNode {
  if (icon === null || icon === undefined || icon === false) return null;
  if (typeof icon === "string") return <Icon name={icon as IconName} size={size} />;
  return isValidElement(icon) ? icon : <>{icon}</>;
}

export function Key<C extends ElementType = "button">(props: KeyProps<C>) {
  const { as, variant = "secondary", size = "md", icon, iconEnd, loading = false, held, block = false, wrap = false, fit, disabled = false, className, children, ...rest } = props;
  const t = useT("ui");
  const Tag: ElementType = as ?? "button";
  const isButton = Tag === "button";
  const own = rest as Record<string, unknown> & { onClick?: (event: MouseEvent<HTMLElement>) => void; type?: string };
  const look = KEY_LOOK[variant] ?? "secondary";

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled || loading) {
      event.preventDefault();
      return;
    }
    own.onClick?.(event);
  };

  const state: Record<string, unknown> = isButton
    ? { type: own.type ?? "button", disabled: disabled || undefined, "aria-pressed": held ?? own["aria-pressed"] }
    : { "aria-disabled": disabled || undefined, "data-held": held ? "" : undefined };

  return (
    <Tag
      {...rest}
      {...state}
      className={cx("key", VARIANT_CLASS[variant] ?? "key--secondary", SIZE_CLASS[size], block && "key--block", wrap && "key--wrap", fit === "compact" && "key--compact", className)}
      data-press={(own["data-press"] as string | undefined) ?? keyPress(look)}
      data-haptic={look === "primary" ? "tap" : undefined}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      <span className="key__cap">
        {keyIcon(icon, 20)}
        {children !== undefined && children !== null && children !== false ? <BidiLabel className="key__label">{children}</BidiLabel> : null}
        {keyIcon(iconEnd, 20)}
        {loading ? (
          <>
            <span className="key__spinner" aria-hidden="true">
              <Icon name="circle-notch" size={16} />
            </span>
            <VisuallyHidden>{t("loading")}</VisuallyHidden>
          </>
        ) : null}
      </span>
    </Tag>
  );
}
