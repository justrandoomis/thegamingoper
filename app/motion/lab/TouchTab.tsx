import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormat, useT } from "~/i18n/react";
import { convertFromIqd, formatMoney, type CurrencyCode } from "~/lib/money";
import { dematerialize, materialize } from "../lazy";
import { NumberMorph } from "../number";
import { springDuration, springValue } from "../spring";
import { durations, SPRING_NAMES, springs, type DurationName, type SpringName } from "../tokens";

/** The DESIGN.md §7.1 durations (the earlier aliases are left out). */
const DURATION_NAMES: DurationName[] = ["press", "exit", "micro", "release", "theme", "base", "reveal", "sheet", "page", "fly"];
import { LAB_FX } from "./items";

function HeartGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20s-7-4.4-7-9.6A4 4 0 0 1 12 8a4 4 0 0 1 7 2.4C19 15.600 12 20 12 20Z" />
    </svg>
  );
}

function PressSection() {
  const t = useT("motion");
  const f = useFormat();
  const [presses, setPresses] = useState(0);
  const bump = () => setPresses((n) => n + 1);
  return (
    <section className="lab-card" aria-labelledby="lab-press">
      <h2 id="lab-press">{t("press.title")}</h2>
      <p>{t("press.body")}</p>
      <div className="lab-row">
        <button type="button" className="lab-btn lab-btn--primary" data-press="clay" data-haptic="tap" data-testid="press-clay" onClick={bump}>
          {t("press.clay")}
        </button>
        <button type="button" className="lab-btn" data-press="soft" data-testid="press-soft" onClick={bump}>
          {t("press.soft")}
        </button>
        <button type="button" className="lab-btn lab-btn--icon" data-press="icon" data-haptic="select" data-testid="press-icon" aria-label={t("press.icon")} onClick={bump}>
          <HeartGlyph />
        </button>
      </div>
      <p className="lab-note" aria-live="polite" data-testid="press-count">
        {t("press.count", { count: f.number(presses) })}
      </p>
    </section>
  );
}

const UNIT_PRICE_IQD = 749_000;

function NumberSection() {
  const t = useT("motion");
  const f = useFormat();
  const [quantity, setQuantity] = useState(1);
  const [currency, setCurrency] = useState<CurrencyCode>("IQD");
  const money = (amountIqd: number) => {
    const minor = currency === "IQD" ? amountIqd : (convertFromIqd(amountIqd, currency, LAB_FX) ?? amountIqd);
    return formatMoney(minor, currency, f.locale, f.numbering);
  };
  return (
    <section className="lab-card" aria-labelledby="lab-number">
      <h2 id="lab-number">{t("number.title")}</h2>
      <p>{t("number.body")}</p>
      <div className="lab-row lab-row--spread">
        <div className="lab-stepper" role="group" aria-label={t("number.quantity")}>
          <button type="button" className="lab-btn lab-btn--icon" data-press="icon" data-testid="qty-minus" aria-label={t("number.decrease")} disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
            −
          </button>
          <NumberMorph value={quantity} format={f.number} className="lab-stepper__value" data-testid="qty" />
          <button type="button" className="lab-btn lab-btn--icon" data-press="icon" data-testid="qty-plus" aria-label={t("number.increase")} onClick={() => setQuantity((q) => Math.min(99, q + 1))}>
            +
          </button>
        </div>
        <button type="button" className="lab-btn" data-press="soft" data-testid="currency" onClick={() => setCurrency((c) => (c === "IQD" ? "USD" : "IQD"))}>
          {t("number.currency")}
        </button>
      </div>
      <p className="lab-total">
        <span>{t("number.total")}</span>
        <NumberMorph value={quantity * UNIT_PRICE_IQD} format={money} className="lab-total__value" data-testid="total" />
      </p>
      {currency !== "IQD" ? <p className="lab-note">{t("number.approx")}</p> : null}
    </section>
  );
}

function MenuSection() {
  const t = useT("motion");
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const toastTrigger = useRef<HTMLButtonElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const toastElement = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (menu && menuElement.current) void materialize(menuElement.current, { from: trigger.current });
  }, [menu]);
  useLayoutEffect(() => {
    if (toast && toastElement.current) void materialize(toastElement.current, { from: toastTrigger.current });
  }, [toast]);

  const closeMenu = () => {
    const element = menuElement.current;
    if (!element) return setMenu(false);
    void dematerialize(element, { from: trigger.current }).then(() => {
      setMenu(false);
      trigger.current?.focus();
    });
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuElement.current?.contains(event.target) && !trigger.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      const element = toastElement.current;
      if (!element) return setToast(false);
      void dematerialize(element).then(() => setToast(false));
    }, 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <section className="lab-card" aria-labelledby="lab-menu">
      <h2 id="lab-menu">{t("menu.title")}</h2>
      <p>{t("menu.body")}</p>
      <div className="lab-row">
        <div className="lab-anchor">
          <button ref={trigger} type="button" className="lab-btn" data-press="soft" data-testid="menu-open" aria-haspopup="menu" aria-expanded={menu} onClick={() => (menu ? closeMenu() : setMenu(true))}>
            {t("menu.open")}
          </button>
          {menu ? (
            <div ref={menuElement} className="lab-menu" role="menu" data-testid="menu">
              {(["item1", "item2", "item3"] as const).map((key) => (
                <button key={key} type="button" role="menuitem" className="lab-menu__item" data-press="soft" onClick={closeMenu}>
                  {t(`menu.${key}`)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button ref={toastTrigger} type="button" className="lab-btn" data-press="soft" data-testid="toast-open" onClick={() => setToast(true)}>
          {t("menu.toast")}
        </button>
      </div>
      {toast ? (
        <div ref={toastElement} className="lab-toast" role="status" data-testid="toast">
          {t("menu.toastText")}
        </div>
      ) : null}
    </section>
  );
}

/** The spring as a tiny curve: value over time, with the rest line at 1. */
function SpringCurve({ name }: { name: SpringName }) {
  const spring = springs[name];
  const seconds = (spring.settleMs ?? springDuration(spring) * 1000) / 1000;
  const points: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = (i / 40) * 100;
    const y = 34 - springValue(spring, (i / 40) * seconds) * 26;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <svg className="lab-curve" viewBox="0 -2 100 40" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="100" y1="8" y2="8" className="lab-curve__rest" />
      <polyline points={points.join(" ")} className="lab-curve__line" />
    </svg>
  );
}

function TokensSection() {
  const t = useT("motion");
  const f = useFormat();
  return (
    <section className="lab-card" aria-labelledby="lab-tokens">
      <h2 id="lab-tokens">{t("tokens.title")}</h2>
      <p>{t("tokens.body")}</p>
      <ul className="lab-springs">
        {SPRING_NAMES.map((name) => (
          <li key={name}>
            <SpringCurve name={name} />
            <code dir="ltr">{name}</code>
            <span className="lab-note">{t("tokens.ms", { value: f.number(springs[name].settleMs) })}</span>
          </li>
        ))}
      </ul>
      <ul className="lab-chips">
        {DURATION_NAMES.map((name) => (
          <li key={name}>
            <code dir="ltr">{name}</code> <span className="lab-note">{t("tokens.ms", { value: f.number(durations[name]) })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TouchTab() {
  return (
    <>
      <PressSection />
      <NumberSection />
      <MenuSection />
      <TokensSection />
    </>
  );
}
