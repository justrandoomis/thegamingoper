import { useEffect, useRef } from "react";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { NumberMorph } from "../number";
import { LAB_TABS, type LabTab } from "./items";
import { resetPerf, watchPerf } from "./perf";
import { useLabCart } from "./store";

/** Compact live frame-rate figure; `detailed` adds the longest frame and the long-task count with labels. */
export function PerfReadout({ detailed = false }: { detailed?: boolean }) {
  const t = useT("motion");
  const fps = useRef<HTMLSpanElement>(null);
  const worst = useRef<HTMLSpanElement>(null);
  const long = useRef<HTMLSpanElement>(null);

  useEffect(
    () =>
      // Written straight into the DOM twice a second: a readout must not cost renders of its own.
      watchPerf((reading) => {
        if (fps.current) fps.current.textContent = String(reading.fps);
        if (worst.current) worst.current.textContent = `${Math.round(reading.worst)} ms`;
        if (long.current) long.current.textContent = String(reading.longTasks);
      }),
    [],
  );

  if (!detailed) {
    return (
      <span className="lab-perf" data-testid="perf" aria-hidden="true">
        <bdi>
          <span ref={fps}>–</span> {t("perf.fps")}
        </bdi>
      </span>
    );
  }
  return (
    <dl className="lab-perf-table" data-testid="perf-detail">
      <div>
        <dt>{t("perf.fps")}</dt>
        <dd dir="ltr" ref={fps}>
          –
        </dd>
      </div>
      <div>
        <dt>{t("perf.worst")}</dt>
        <dd dir="ltr" ref={worst}>
          –
        </dd>
      </div>
      <div>
        <dt>{t("perf.long")}</dt>
        <dd dir="ltr" ref={long}>
          –
        </dd>
      </div>
      <button type="button" className="lab-btn" data-press="soft" onClick={resetPerf}>
        {t("perf.reset")}
      </button>
    </dl>
  );
}

function CartGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h2.2l2.1 10.2a1.6 1.6 0 0 0 1.6 1.3h7.9a1.6 1.6 0 0 0 1.6-1.2L20 8H6.2" />
      <circle cx="9.5" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </svg>
  );
}

/** The lab's own sticky bar: title, live frame rate, and the pretend cart that fly-to-cart lands in. */
export function LabBar() {
  const t = useT("motion");
  const f = useFormat();
  const count = useLabCart();
  return (
    <header className="lab-bar" data-motion-persist="lab">
      <strong className="lab-bar__title">{t("title")}</strong>
      <PerfReadout />
      <span className="lab-cart" data-cart-target="" data-testid="lab-cart">
        <CartGlyph />
        <span className="lab-cart__badge" data-cart-badge="" aria-hidden="true">
          <NumberMorph value={count} format={f.number} data-testid="lab-cart-count" />
        </span>
        <span className="lab-sr" role="status" aria-live="polite">
          {t("cart.badge", { count })}
        </span>
      </span>
    </header>
  );
}

/** Sibling tabs. Plain links: the route's `handle.order` makes them push sideways in the right direction. */
export function LabTabs({ active }: { active: LabTab }) {
  const t = useT("motion");
  return (
    <nav className="lab-tabs" aria-label={t("tabs.label")}>
      {LAB_TABS.map((tab) => (
        <LocaleLink
          key={tab}
          to={`/motion?tab=${tab}`}
          className="lab-tab"
          data-press="soft"
          data-testid={`tab-${tab}`}
          aria-current={tab === active ? "page" : undefined}
        >
          {t(`tabs.${tab}`)}
        </LocaleLink>
      ))}
    </nav>
  );
}
