import { Suspense, use, useRef, useState } from "react";
import { useFormat, useT } from "~/i18n/react";
import { useAmbient } from "../ambient";
import { Bubble, BubbleGroup } from "../bubble";
import { useRail } from "../rail-hook";

const HUES = [352, 212, 148, 268, 28, 190, 320, 96];

function Chip({ n }: { n: number }) {
  const f = useFormat();
  return (
    <span className="lab-chip__face" style={{ background: `hsl(${HUES[(n - 1) % HUES.length]} 62% 58%)` }}>
      {f.number(n)}
    </span>
  );
}

function Placeholders() {
  return (
    <div className="lab-grid lab-grid--chips" aria-hidden="true">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <div key={n} className="lab-chip lab-chip--placeholder" />
      ))}
    </div>
  );
}

function Loaded({ promise, extra }: { promise: Promise<number[]>; extra: number[] }) {
  const items = use(promise);
  return (
    <BubbleGroup stagger className="lab-grid lab-grid--chips" data-testid="reveal-grid">
      {[...items, ...extra].map((n) => (
        <Bubble key={n} className="lab-chip" data-testid={`chip-${n}`} origin={n > items.length ? "pointer" : undefined}>
          <Chip n={n} />
        </Bubble>
      ))}
    </BubbleGroup>
  );
}

function RevealSection() {
  const t = useT("motion");
  const sequence = useRef(0);
  const [request, setRequest] = useState<{ id: number; promise: Promise<number[]> } | null>(null);
  const [extra, setExtra] = useState<number[]>([]);

  const load = () => {
    setExtra([]);
    setRequest({
      id: ++sequence.current,
      // Stands in for a slow loader; the reveal is the real <Suspense> mechanism.
      promise: new Promise((resolve) => setTimeout(() => resolve([1, 2, 3, 4, 5, 6]), 900)),
    });
  };

  return (
    <section className="lab-card" aria-labelledby="lab-reveal">
      <h2 id="lab-reveal">{t("reveal.title")}</h2>
      <p>{t("reveal.body")}</p>
      <div className="lab-row">
        <button type="button" className="lab-btn lab-btn--primary" data-press="clay" data-testid="reveal-load" onClick={load}>
          {request ? t("reveal.reset") : t("reveal.load")}
        </button>
        <button type="button" className="lab-btn" data-press="soft" data-testid="reveal-insert" disabled={!request || extra.length >= 3} onClick={() => setExtra((list) => [...list, 7 + list.length])}>
          {t("reveal.insert")}
        </button>
      </div>
      {/* Mounted together with the page: the first stays still (the page transition is its animation), the second opts in. */}
      <div className="lab-row lab-gap">
        <Bubble as="span" className="lab-pill" data-testid="bubble-with-page">
          {t("reveal.withPage")}
        </Bubble>
        <Bubble as="span" always className="lab-pill" data-testid="bubble-always">
          {t("reveal.always")}
        </Bubble>
      </div>
      <div className="lab-reserve" data-testid="reveal-box">
        {request ? (
          <Suspense key={request.id} fallback={<Placeholders />}>
            <Loaded promise={request.promise} extra={extra} />
          </Suspense>
        ) : (
          <Placeholders />
        )}
      </div>
    </section>
  );
}

function RailSection() {
  const t = useT("motion");
  const f = useFormat();
  const rail = useRail<HTMLDivElement>({ tilt: true });
  return (
    <section className="lab-card" aria-labelledby="lab-rail">
      <h2 id="lab-rail">{t("rail.title")}</h2>
      <p>{t("rail.body")}</p>
      <div {...rail.props} className={`${rail.props.className} lab-rail`} aria-label={t("rail.label")} data-testid="rail">
        {HUES.map((hue, index) => (
          <div key={hue} className="lab-rail__item" style={{ background: `hsl(${hue} 60% 56%)` }}>
            {f.number(index + 1)}
          </div>
        ))}
      </div>
      <div className="lab-row">
        <button type="button" className="lab-btn lab-btn--icon" data-press="icon" data-testid="rail-prev" aria-label={t("rail.previous")} onClick={() => rail.step(false)}>
          <span className="lab-arrow lab-arrow--back" aria-hidden="true" />
        </button>
        <button type="button" className="lab-btn lab-btn--icon" data-press="icon" data-testid="rail-next" aria-label={t("rail.next")} onClick={() => rail.step(true)}>
          <span className="lab-arrow" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function AmbientSection() {
  const t = useT("motion");
  const float = useAmbient<HTMLSpanElement>();
  return (
    <section className="lab-card" aria-labelledby="lab-ambient">
      <h2 id="lab-ambient">{t("ambient.title")}</h2>
      <p>{t("ambient.body")}</p>
      <div className="lab-ambient" aria-hidden="true">
        <span ref={float} data-ambient="" className="lab-ambient__bubble" data-testid="ambient" />
      </div>
    </section>
  );
}

export function RevealTab() {
  return (
    <>
      <RevealSection />
      <RailSection />
      <AmbientSection />
    </>
  );
}
