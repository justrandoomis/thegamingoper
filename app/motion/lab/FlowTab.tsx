import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useFormat, useT } from "~/i18n/react";
import { MotionLink } from "../nav";
import { SharedElement } from "../shared";
import { LAB_ITEMS, labArt } from "./items";

/** Any `onLoad` handler tells React not to hold the navigation for this image (see docs/MOTION.md). */
const noop = () => {};

export function FlowTab() {
  const t = useT("motion");
  const f = useFormat();
  return (
    <>
      <section className="lab-card" aria-labelledby="lab-flow">
        <h2 id="lab-flow">{t("flow.title")}</h2>
        <p>{t("flow.body")}</p>
        <ul className="lab-grid">
          {LAB_ITEMS.map((item, index) => (
            <li key={item.id}>
              <MotionLink nav="zoom" to={`/motion/item/${item.id}`} className="lab-tile" data-press="soft" data-testid={`card-${item.id}`}>
                <SharedElement name={`lab-item:${item.id}`} className="lab-tile__art">
                  <img src={labArt(item.hue)} alt="" width={400} height={400} decoding="async" onLoad={noop} />
                </SharedElement>
                <span className="lab-tile__name">{t("flow.item", { n: f.number(index + 1) })}</span>
                <bdi className="lab-note">{f.iqd(item.priceIqd)}</bdi>
              </MotionLink>
            </li>
          ))}
        </ul>
      </section>
      <section className="lab-card" aria-labelledby="lab-grammar">
        <h2 id="lab-grammar">{t("flow.grammarTitle")}</h2>
        <p>{t("flow.grammarBody")}</p>
        <div className="lab-row">
          <MotionLink nav="rise" to="/motion/item/d" className="lab-btn" data-press="soft" data-testid="link-rise">
            {t("flow.rise")}
          </MotionLink>
          <MotionLink nav="fade" to="/motion/item/e" className="lab-btn" data-press="soft" data-testid="link-fade">
            {t("flow.fade")}
          </MotionLink>
        </div>
        <p className="lab-note lab-gap">{t("flow.viewerBody")}</p>
        <MotionLink nav="rise" to="/motion?tab=flow#viewer" preventScrollReset className="lab-btn" data-press="soft" data-testid="viewer-open">
          {t("flow.viewer")}
        </MotionLink>
      </section>
    </>
  );
}

/**
 * A full-screen viewer that is a state of the same page: `#viewer` shows the first picture, `#viewer-2` the second.
 *
 * Going Back from the second picture to the first is a hash-to-hash navigation. It needs no data, so React Router
 * finishes it synchronously inside `popstate` — exactly the case where React alone skips the view transition.
 * The engine's pop gate keeps the reverse push (see docs/MOTION.md §"Back and Forward").
 */
export function LabViewer({ slide }: { slide: 0 | 1 }) {
  const t = useT("motion");
  const navigate = useNavigate();
  const close = useRef<HTMLButtonElement>(null);
  const leave = () => void navigate(slide === 0 ? -1 : -2);

  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void navigate(slide === 0 ? -1 : -2);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, slide]);

  return (
    <div className="lab-viewer" role="dialog" aria-modal="true" aria-label={t("flow.viewerLabel")} data-testid="viewer" data-slide={slide}>
      <img src={labArt(LAB_ITEMS[slide === 0 ? 3 : 5].hue)} alt="" width={400} height={400} onLoad={noop} />
      <div className="lab-row">
        {slide === 0 ? (
          <MotionLink nav="push" to="/motion?tab=flow#viewer-2" preventScrollReset className="lab-btn" data-press="soft" data-testid="viewer-next">
            {t("flow.viewerNext")}
          </MotionLink>
        ) : (
          <button type="button" className="lab-btn" data-press="soft" data-testid="viewer-previous" onClick={() => void navigate(-1)}>
            {t("flow.viewerPrevious")}
          </button>
        )}
        <button ref={close} type="button" className="lab-btn" data-press="soft" data-testid="viewer-close" onClick={leave}>
          {t("flow.viewerClose")}
        </button>
      </div>
    </div>
  );
}
