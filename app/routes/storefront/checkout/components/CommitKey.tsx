import type { ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";

/**
 * The one red primary of a cart or checkout view (Design System v2 §1 principle 3, §4.3, §5.7) — the kit's glossy red
 * key (v2.1 G2). Pages render it twice — in the phone task bar (below 1024px) and inside the order summary card (from
 * 1024px) — and CSS shows exactly one of them, so every view still has a single primary. It lives in its own module so
 * the design lint's one-per-module count holds for the pages that place it.
 *
 *   <CommitKey to="/checkout">إتمام الطلب</CommitKey>                              a link (the cart), arrow at the end
 *   <CommitKey type="submit" form="checkout-form" iconEnd="arrow-right">…</CommitKey>    a step forward
 *   <CommitKey type="submit" form="checkout-form" icon="check" loading={busy} busyLabel={t("keys.placing")}>…</CommitKey>
 *
 * A disabled key goes flat; the page writes the reason next to it and points `aria-describedby` at it. While busy it
 * keeps its width and cannot be pressed again (the kit's loading state): with a leading icon the spinner takes the
 * icon's place and the words stay — `busyLabel` says what is happening («جارٍ تأكيد طلبك…», client round 1: a pressed /
 * progress state for «أكّد الطلب»). Its words are never cut: where they do not fit on one line they take a second line
 * inside the 48px key (`.co-commit` in checkout.css) — the kit's key cuts a long label with an ellipsis.
 */
type Common = {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** The words while `loading` (the leading icon becomes the spinner). */
  busyLabel?: ReactNode;
  icon?: IconName;
  iconEnd?: IconName;
  className?: string;
  "aria-describedby"?: string;
  block?: boolean;
};

export type CommitKeyProps = (Common & { to: string; type?: undefined; form?: undefined; onClick?: undefined }) | (Common & { to?: undefined; type: "submit" | "button"; form?: string; onClick?: () => void });

export function CommitKey(props: CommitKeyProps) {
  const { children, disabled = false, loading = false, busyLabel, icon, iconEnd, className, block = true } = props;
  // A link (the cart's "check out") or a button (the checkout form's submit) — one key either way.
  const element: Record<string, unknown> =
    props.to !== undefined ? { as: LocaleLink, to: props.to, iconEnd: iconEnd ?? "arrow-right" } : { type: props.type, form: props.form, onClick: props.onClick, icon, iconEnd };
  return (
    <Key {...element} variant="primary" block={block} disabled={disabled} loading={loading} className={cx("co-commit", className)} aria-describedby={props["aria-describedby"]}>
      {loading && busyLabel ? busyLabel : children}
    </Key>
  );
}
