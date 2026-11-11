import { useRef, type MouseEvent } from "react";
import { data, useNavigate } from "react-router";

import type { Route } from "./+types/motion-lab-item";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { flyToCart, MotionLink, NumberMorph, SharedElement, type MotionHandle } from "~/motion";
import { LAB_ITEMS, labArt, labItemIndex } from "~/motion/lab/items";
import { addToLabCart } from "~/motion/lab/store";
import { getCtx } from "~/server/context.server";

/** /motion/item/:id — the detail side of the lab's shared-element navigation. Demo data only. */
export function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  if (labItemIndex(params.id) < 0) throw data({ error: "not_found" }, { status: 404 });
  return { id: params.id, i18n: messagesFor(ctx.locale, "motion") };
}

/** Items are siblings in list order: Previous / Next push sideways without any link props. */
export const handle = {
  nav: "push",
  order: ({ params }) => labItemIndex(params.id),
} satisfies MotionHandle;

const noop = () => {};

export default function MotionLabItem({ loaderData }: Route.ComponentProps) {
  const t = useT("motion");
  const f = useFormat();
  const navigate = useNavigate();
  const picture = useRef<HTMLImageElement>(null);
  const index = labItemIndex(loaderData.id);
  const item = LAB_ITEMS[index];
  const previous = LAB_ITEMS[index - 1];
  const next = LAB_ITEMS[index + 1];

  // Prefer real history Back (it restores the list's scroll position and reverses the transition that got us here);
  // on a deep link there is nothing to go back to, so the link's own zoom-back navigation is used.
  const goBack = (event: MouseEvent<HTMLAnchorElement>) => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      event.preventDefault();
      void navigate(-1);
    }
  };

  const add = () => {
    addToLabCart();
    if (picture.current) flyToCart(picture.current, { target: document.querySelector('[data-testid="lab-cart"]') });
  };

  return (
    <main className="lab-main" data-testid="lab-detail" data-item={item.id}>
      <MotionLink to="/motion?tab=flow" nav="zoom" back className="lab-btn lab-back" data-press="soft" data-testid="detail-back" onClick={goBack}>
        <span className="lab-arrow lab-arrow--back" aria-hidden="true" />
        {t("detail.back")}
      </MotionLink>
      <SharedElement name={`lab-item:${item.id}`} target className="lab-hero">
        <img ref={picture} src={labArt(item.hue)} alt="" width={400} height={400} onLoad={noop} data-testid="detail-art" />
      </SharedElement>
      <h1 className="lab-title">{t("flow.item", { n: f.number(index + 1) })}</h1>
      <p className="lab-note">{t("detail.demo")}</p>
      <p className="lab-total">
        <span>{t("detail.price")}</span>
        <NumberMorph value={item.priceIqd} format={f.iqd} className="lab-total__value" data-testid="detail-price" />
      </p>
      <button type="button" className="lab-btn clay--red lab-btn--wide" data-press="clay" data-haptic="tap" data-testid="detail-add" onClick={add}>
        {t("detail.add")}
      </button>
      <p>{t("detail.body")}</p>
      <nav className="lab-row lab-row--spread" aria-label={t("tabs.label")}>
        {previous ? (
          <LocaleLink to={`/motion/item/${previous.id}`} className="lab-btn" data-press="soft" data-testid="detail-previous">
            {t("detail.previous")}
          </LocaleLink>
        ) : (
          <span />
        )}
        {next ? (
          <LocaleLink to={`/motion/item/${next.id}`} className="lab-btn" data-press="soft" data-testid="detail-next">
            {t("detail.next")}
          </LocaleLink>
        ) : (
          <span />
        )}
      </nav>
      <div className="lab-filler" aria-hidden="true" />
    </main>
  );
}
