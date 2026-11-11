/**
 * The two static glass orbs over the product stage on phones and tablets (DESIGN.md §8.4, §9.2 "task screens",
 * reference b.png): back at the start, the cart with its bead at the end. The product page has no tab bar (its buy bar
 * takes the bottom edge), so this orb is where fly-to-cart lands below 1200px (`data-cart-target`, `data-cart-badge`);
 * from 1200px the header's cart orb takes over and these are hidden.
 *
 * Back is real history Back when the shopper came from a page of this site (it restores that page's scroll and plays
 * the reverse zoom); on a deep link it is a link to the product's category (or home) with the zoom-back transition.
 */
import type { MouseEvent } from "react";
import { useNavigate } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { useCartCount } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { Glass } from "~/ui/Glass";
import { useProductT } from "../i18n";

const ORB = "relative grid size-11 place-items-center rounded-full text-ink";

export function StageOrbs({ backTo, className }: { backTo: string; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const navigate = useNavigate();
  const { count } = useCartCount();

  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      event.preventDefault();
      void navigate(-1);
    }
  };

  return (
    <div className={cx("flex items-center justify-between", className)}>
      <Glass as={MotionLink} to={backTo} nav="zoom" back variant="static" className={ORB} aria-label={t("orbs.back")} data-press="icon" onClick={back}>
        <Icon name="arrow-left" size={22} />
      </Glass>
      <Glass
        as={LocaleLink}
        to="/cart"
        variant="static"
        className={ORB}
        aria-label={t("orbs.cart", { count, n: f.number(count) })}
        data-cart-target=""
        data-press="icon"
      >
        <Icon name="shopping-bag" size={22} />
        {count > 0 ? (
          <b className="bead absolute -end-1.5 -top-1" data-cart-badge="" aria-hidden="true">
            {f.number(count)}
          </b>
        ) : null}
      </Glass>
    </div>
  );
}
