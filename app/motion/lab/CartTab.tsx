import { useEffect, useRef, useState } from "react";
import { useFormat, useT } from "~/i18n/react";
import { flyToCart } from "../lazy";
import { useSheet } from "../sheet-hook";
import { LAB_ITEMS, labArt } from "./items";
import { addToLabCart, clearLabCart, removeFromLabCart, useLabCart } from "./store";

const noop = () => {};

/** How long the pretend server takes to refuse the request in the failure demo. */
const FAILURE_AFTER_MS = 450;

function FlySection() {
  const t = useT("motion");
  const f = useFormat();
  const count = useLabCart();
  const picture = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const item = LAB_ITEMS[1];

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const target = () => document.querySelector('[data-testid="lab-cart"]');

  const add = () => {
    // State first: the cart is updated before any animation exists.
    setFailed(false);
    addToLabCart();
    if (picture.current) flyToCart(picture.current, { target: target() });
  };

  /** The same add, but the (pretend) server refuses it: the count rolls back and the bead returns along its arc. */
  const addFailing = () => {
    setFailed(false);
    addToLabCart();
    const flight = picture.current ? flyToCart(picture.current, { target: target() }) : null;
    timers.current.push(
      setTimeout(() => {
        removeFromLabCart();
        flight?.revert();
        setFailed(true);
      }, FAILURE_AFTER_MS),
    );
  };

  return (
    <section className="lab-card" aria-labelledby="lab-fly">
      <h2 id="lab-fly">{t("cart.title")}</h2>
      <p>{t("cart.body")}</p>
      <div className="lab-product">
        <img ref={picture} className="lab-product__art" src={labArt(item.hue)} alt="" width={400} height={400} onLoad={noop} data-testid="fly-source" />
        <div className="lab-product__body">
          <strong>{t("flow.item", { n: f.number(2) })}</strong>
          <bdi className="lab-note">{f.iqd(item.priceIqd)}</bdi>
          <button type="button" className="lab-btn clay--red" data-press="clay" data-haptic="tap" data-testid="fly-add" onClick={add}>
            {t("cart.add")}
          </button>
          <button type="button" className="lab-btn" data-press="soft" data-testid="fly-add-failing" onClick={addFailing}>
            {t("cart.addFailing")}
          </button>
        </div>
      </div>
      {failed ? (
        <p className="lab-error" role="alert" data-testid="fly-failed">
          {t("cart.failed")}{" "}
          <button type="button" className="lab-btn" data-press="soft" data-testid="fly-retry" onClick={add}>
            {t("cart.retry")}
          </button>
        </p>
      ) : null}
      <div className="lab-row lab-row--spread">
        <span className="lab-note" data-testid="fly-count">
          {t("cart.badge", { count })}
        </span>
        <button type="button" className="lab-btn" data-press="soft" data-testid="fly-clear" disabled={count === 0} onClick={clearLabCart}>
          {t("cart.empty")}
        </button>
      </div>
    </section>
  );
}

/** The sheet component: useSheet owns the physics, the focus (in, trapped, back to the opener) and Escape. */
function DemoSheet({ onClose }: { onClose: () => void }) {
  const t = useT("motion");
  const f = useFormat();
  const sheet = useSheet({ snapPoints: [0.5, 1], initialSnap: 0, onClose });
  const side = sheet.edge === "inline-end";

  return (
    <>
      <div ref={sheet.backdropRef as React.RefObject<HTMLDivElement | null>} className="lab-scrim" data-testid="sheet-scrim" onClick={sheet.close} />
      <section
        ref={sheet.ref as React.RefObject<HTMLElement | null>}
        className="tt-sheet lab-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("sheet.label")}
        tabIndex={-1}
        data-testid="sheet"
      >
        <div {...sheet.handleProps} className="lab-sheet__handle" data-testid="sheet-handle" aria-label={t("sheet.handle")}>
          <span className="lab-sheet__grabber" aria-hidden="true" />
        </div>
        <div className="lab-row lab-sheet__actions">
          {side ? null : (
            <>
              <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-half" onClick={() => sheet.snapTo(0)}>
                {t("sheet.half")}
              </button>
              <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-full" onClick={() => sheet.snapTo(1)}>
                {t("sheet.full")}
              </button>
            </>
          )}
          <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-close" onClick={sheet.close}>
            {t("sheet.close")}
          </button>
        </div>
        <div className="lab-sheet__content">
          <p>{t("sheet.content")}</p>
          <ul>
            {Array.from({ length: 14 }, (_, i) => (
              <li key={i}>{t("sheet.row", { n: f.number(i + 1) })}</li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

function SheetSection() {
  const t = useT("motion");
  const [open, setOpen] = useState(false);
  return (
    <section className="lab-card" aria-labelledby="lab-sheet">
      <h2 id="lab-sheet">{t("sheet.title")}</h2>
      <p>{t("sheet.body")}</p>
      <button type="button" className="lab-btn lab-btn--primary" data-press="clay" data-testid="sheet-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t("sheet.open")}
      </button>
      {open ? <DemoSheet onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

export function CartTab() {
  return (
    <>
      <FlySection />
      <SheetSection />
    </>
  );
}
