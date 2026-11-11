import type { ReactNode } from "react";

import { LocaleLink } from "~/i18n/react";
import { Key } from "~/ui/Key";

/**
 * The one red key of a cart or checkout view (DESIGN.md §0 law 4, §8.5–8.6, §9.17). Pages render it twice — in the
 * phone task bar (< 1024px) and under the order summary (≥ 1024px) — and CSS shows exactly one of them, so every view
 * still has a single commit key. It lives in its own module so the design lint's one-per-module count holds.
 *
 *   <CommitKey to="/checkout">إتمام الطلب</CommitKey>                       a link (the cart)
 *   <CommitKey type="submit" form="checkout-form" loading={busy}>…</CommitKey>   the checkout form's submit
 *
 * Disabled keys go flat; the page writes the reason next to it and points `aria-describedby` at it.
 */
type Common = { children: ReactNode; disabled?: boolean; loading?: boolean; className?: string; "aria-describedby"?: string; block?: boolean };

export type CommitKeyProps = (Common & { to: string; type?: undefined; form?: undefined; onClick?: undefined }) | (Common & { to?: undefined; type: "submit" | "button"; form?: string; onClick?: () => void });

export function CommitKey(props: CommitKeyProps) {
  const { children, disabled = false, loading = false, className, block = true } = props;
  // A link (the cart's "check out") or a button (the checkout form's submit) — one key either way.
  const element: Record<string, unknown> = props.to !== undefined ? { as: LocaleLink, to: props.to, iconEnd: "arrow-right" } : { type: props.type, form: props.form, onClick: props.onClick };
  return (
    <Key {...element} variant="commit" size="lg" block={block} disabled={disabled} loading={loading} className={className} aria-describedby={props["aria-describedby"]}>
      {children}
    </Key>
  );
}
