import { isValidElement, type ComponentPropsWithRef, type ElementType, type MouseEvent, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * The key — TamTam's one button (docs/DESIGN.md §6.1): a clay face on a static front wall; a press is the face
 * travelling down onto the wall, and a key that is "on" stays down.
 *
 *   <Key variant="commit" icon={<AddGlyph />} onClick={add}>{t("add")}</Key>        the ONE red key of a view
 *   <Key onClick={…}>{t("keepShopping")}</Key>                                        every other action (clay)
 *   <Key variant="ink" onClick={…}>{t("show24")}</Key>                                emphasis without red
 *   <Key variant="quiet" icon="moon" …>{t("theme")}</Key>                             chrome tools on bars
 *   <Key as={LocaleLink} to="/cart" size="lg">{t("viewCart")}</Key>                   a link that looks like a key
 *   <Key as={MotionLink} nav="zoom" to={`/p/${slug}`}>…</Key>
 *   <Key as="a" href="https://…">…</Key>
 *   <Key held={isOn} onClick={toggle}>…</Key>                                         a toggle: aria-pressed, held down
 *   <Key loading={fetcher.state !== "idle"}>…</Key>                                   busy: same width, spinner
 *
 * Rules (§6.1, §0): one commit key per view — the action that moves the order forward. Red is never "danger".
 * Disabled keys go flat; write the reason next to them. Icon-only keys are <IconKey label>.
 *
 * Press feedback comes from the Motion Engine (`data-press`; <MotionRoot> must be mounted by the layout) with a CSS
 * :active fallback before it mounts; the commit key adds a light haptic where supported.
 */
export type KeyVariant = "commit" | "clay" | "ink" | "quiet";
export type KeySize = "sm" | "md" | "lg";

export type KeyOwnProps = {
  /** "commit" = the red key (one per view) · "clay" (default) · "ink" · "quiet". */
  variant?: KeyVariant;
  /** sm 40 (rows, toasts) · md 48 (default) · lg 56 (desktop heroes). All keep a ≥ 44px hit area. */
  size?: KeySize;
  /** Leading icon: a sprite name or any decorative node. */
  icon?: IconName | ReactNode;
  /** Trailing icon (a direction arrow, a caret). */
  iconEnd?: IconName | ReactNode;
  /** Busy: keeps its width, shows a spinner, announces "loading", ignores activation (stays focusable). */
  loading?: boolean;
  /** A toggle that is on: held down, ink-faced, `aria-pressed`. Leave undefined for a plain action. */
  held?: boolean;
  /** Fill the inline size of the container. */
  block?: boolean;
  /** Buttons get the `disabled` attribute; links get `aria-disabled` and do not navigate. */
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
};

export type KeyProps<C extends ElementType = "button"> = KeyOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof KeyOwnProps | "as">;

const VARIANT_CLASS: Record<KeyVariant, string | undefined> = {
  commit: "key--red",
  clay: undefined,
  ink: "key--ink",
  quiet: "key--quiet",
};
const SIZE_CLASS: Record<KeySize, string | undefined> = { sm: "key--sm", md: undefined, lg: "key--lg" };

export function keyIcon(icon: IconName | ReactNode, size: number): ReactNode {
  if (icon === null || icon === undefined || icon === false) return null;
  if (typeof icon === "string") return <Icon name={icon as IconName} size={size} />;
  return isValidElement(icon) ? icon : <>{icon}</>;
}

export function Key<C extends ElementType = "button">(props: KeyProps<C>) {
  const { as, variant = "clay", size = "md", icon, iconEnd, loading = false, held, block = false, disabled = false, className, children, ...rest } = props;
  const t = useT("ui");
  const Tag: ElementType = as ?? "button";
  const isButton = Tag === "button";
  const own = rest as Record<string, unknown> & { onClick?: (event: MouseEvent<HTMLElement>) => void; type?: string };
  const iconSize = size === "sm" ? 18 : 20;

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
      className={cx("key", VARIANT_CLASS[variant], SIZE_CLASS[size], block && "key--block", className)}
      data-press="clay"
      data-haptic={variant === "commit" ? "tap" : undefined}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      <span className="key__cap">
        {keyIcon(icon, iconSize)}
        {children !== undefined && children !== null && children !== false ? <BidiLabel className="key__label">{children}</BidiLabel> : null}
        {keyIcon(iconEnd, iconSize)}
        {loading ? (
          <>
            <span className="key__spinner" aria-hidden="true">
              <Icon name="circle-notch" size={iconSize} />
            </span>
            <VisuallyHidden>{t("loading")}</VisuallyHidden>
          </>
        ) : null}
      </span>
    </Tag>
  );
}
