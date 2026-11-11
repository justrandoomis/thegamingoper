import { useEffect, useRef, useState } from "react";
import { useFormat, useT } from "~/i18n/react";
import { flyToCart } from "../lazy";
import { useSheet } from "../sheet-hook";
import { LAB_ITEMS, labArt } from "./items";
import { addToLabCart, clearLabCart, useLabCart } from "./store";

const noop = () => {};

function FlySection() {
  const t = useT("motion");
  const f = useFormat();
  const count = useLabCart();
  const picture = useRef<HTMLImageElement>(null);
  const item = LAB_ITEMS[1];

  const add = () => {
    // State first: the cart is updated before any animation exists.
    addToLabCart();
    if (picture.current) flyToCart(picture.current, { target: document.querySelector('[data-testid="lab-cart"]') });
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
          <button type="button" className="lab-btn lab-btn--primary" data-press="clay" data-haptic="success" data-testid="fly-add" onClick={add}>
            {t("cart.add")}
          </button>
        </div>
      </div>
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

function DemoSheet({ onClose }: { onClose: () => void }) {
  const t = useT("motion");
  const f = useFormat();
  const sheet = useSheet({ snapPoints: [0.5, 1], initialSnap: 0, onClose });
  const { ref, backdropRef, close } = sheet;

  // The sheet component owns focus and Escape: focus moves in on open and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus({ preventScroll: true });
    };
  }, [ref, close]);

  return (
    <>
      <div ref={backdropRef as React.RefObject<HTMLDivElement | null>} className="lab-scrim" data-testid="sheet-scrim" onClick={close} />
      <section
        ref={ref as React.RefObject<HTMLElement | null>}
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
          <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-half" onClick={() => sheet.snapTo(0)}>
            {t("sheet.half")}
          </button>
          <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-full" onClick={() => sheet.snapTo(1)}>
            {t("sheet.full")}
          </button>
          <button type="button" className="lab-btn" data-press="soft" data-testid="sheet-close" onClick={close}>
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
