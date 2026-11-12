/**
 * The intro — "the lights come on" (brief §2 "Intro"; Design System v2 §6.1 "Intro and onboarding", §2.11; DESIGN.md
 * §7.2 for the motion grammar). A client-only overlay above the home page, which is already rendered underneath (SSR is
 * the home page; crawlers and returning shoppers never get this). At most ~1.4 s, skippable from the first frame,
 * shown once per device.
 *
 *   0–300 ms     the floor; the logo's layers (mascot, Arabic lettering, TAM TAM, GAMES) float up and inflate, 60 ms
 *                apart, 6 px of parallax between them
 *   300–620 ms   the four platforms' lead devices come in at the corners, half out of frame, one after another
 *   560 ms       the logo lifts; the one game-turn line of the store «دورك. اختر منصّتك.» rises; the four platform
 *                tiles inflate (they toggle: press one or several — a chosen tile stays down on its wall, ringed and
 *                checked); the hint and «ابدأ» rise last
 *   Start        state first (the page below arranges itself at once) — then each corner object leans in 8 px and is
 *                pulled back out along its own diagonal past the edge (no fade), the logo travels to the header's
 *                lockup, the floor fades: the home page is already there
 *   Skip         the same exit, nothing chosen. «تخطَّ» is a visible secondary key from the first frame.
 *
 * Any tap during the sequence jumps to the end state. Reduced motion: the still composition, then a 120 ms fade
 * out. Lite tier: no staggered inflate (content appears in place); the exit is unchanged (transforms only).
 * Modal layer from the kit (~/ui/Dialog): focus moves in and is trapped, Escape and Android's back skip, the page
 * behind is inert until the overlay starts to leave.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { Art } from "~/art/Art";
import { Logo } from "~/art/Logo";
import { useT } from "~/i18n/react";
import { easings, getMotionTier, springTiming, type MotionTier } from "~/motion";
import { useModalLayer, useOverlayRoot } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import type { Platform } from "~/ui/PlatformLed";
import { PlatformTile } from "~/ui/PlatformTile";

export type IntroCorner = { platform: Platform; artKey: string };
export type IntroTile = { platform: Platform; name: string; count: number | null; artKey: string | null };
export type IntroResult = { started: boolean; chosen: Platform[] };

export type IntroProps = {
  /** One official cut-out per platform (its lead device), in store order: start-top, end-top, start-bottom, end-bottom. */
  corners: readonly IntroCorner[];
  /** The platform tiles the shopper chooses from, in store order. */
  tiles: readonly IntroTile[];
  /** Start or Skip was pressed — called at once, before any exit animation. */
  onLeave: (result: IntroResult) => void;
  /** The exit animation has finished: unmount. */
  onDone: () => void;
};

/** Long enough for the whole sequence (the last element, «ابدأ», settles at about 1.33 s). */
const SEQUENCE_MS = 1400;

export function Intro({ corners, tiles, onLeave, onDone }: IntroProps) {
  const t = useT("home");
  const lineId = useId();
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [settled, setSettled] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [tier, setTier] = useState<MotionTier>("full");
  const leavingRef = useRef(false);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  useLayoutEffect(() => setTier(getMotionTier()), []);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), SEQUENCE_MS);
    return () => clearTimeout(timer);
  }, []);

  const leave = (started: boolean) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const result: IntroResult = { started, chosen: started ? chosenRef.current : [] };
    onLeave(result); // state first: cookies, the page below arranges itself
    const element = host;
    setLeaving(true);
    if (!element) {
      onDone();
      return;
    }
    void playExit(element, getMotionTier()).then(onDone);
  };

  useModalLayer({
    root,
    host,
    active: !leaving,
    onEscape: () => leave(false),
    initialFocus: () => host,
  });

  if (!root) return null;
  const toggle = (platform: Platform) => setChosen((list) => (list.includes(platform) ? list.filter((slug) => slug !== platform) : [...list, platform]));

  return createPortal(
    <div
      ref={setHost}
      className="intro"
      role="dialog"
      aria-modal="true"
      aria-label={t("intro.label")}
      tabIndex={-1}
      data-layer-panel=""
      data-tier={tier}
      data-settled={settled ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      onPointerDownCapture={() => setSettled(true)}
    >
      <div className="intro__floor" aria-hidden="true" />
      <div className="intro__corners" aria-hidden="true">
        {corners.slice(0, 4).map((corner, index) => (
          <div key={corner.platform} className="intro__corner" data-corner={index} style={{ "--i": index } as CSSProperties}>
            <span className="intro__object">
              <Art name={corner.artKey} alt="" sizes="(min-width: 768px) 260px, 34vw" fetchPriority="low" />
            </span>
          </div>
        ))}
      </div>

      <div className="intro__skip">
        <Key size="sm" onClick={() => leave(false)}>
          {t("intro.skip")}
        </Key>
      </div>

      <div className="intro__center">
        <div className="intro__logo text-logo">
          <Logo variant="stacked" />
        </div>
        <div className="intro__panel">
          <h2 id={lineId} className="intro__line">
            {t("intro.line")}
          </h2>
          <ul className="ptiles intro__tiles" aria-labelledby={lineId}>
            {tiles.map((tile, index) => {
              const on = chosen.includes(tile.platform);
              return (
                <li key={tile.platform} className="intro__tile" style={{ "--i": index } as CSSProperties}>
                  {/* the kit's toggle tile: held on its wall, ringed and checked while chosen (aria-pressed), no arrow */}
                  <PlatformTile as="button" type="button" platform={tile.platform} name={tile.name} count={tile.count} selected={on} onClick={() => toggle(tile.platform)} art={tile.artKey ?? undefined} />
                </li>
              );
            })}
          </ul>
          <p className="intro__hint">{t("intro.hint")}</p>
          <Key variant="primary" block className="intro__start" onClick={() => leave(true)}>
            {t("intro.start")}
          </Key>
        </div>
      </div>
    </div>,
    root,
  );
}

/**
 * The exit, transform and opacity only, never awaited by anything but the unmount. Reduced motion: a 120 ms fade.
 */
async function playExit(host: HTMLElement, tier: MotionTier): Promise<void> {
  const animations: Animation[] = [];
  const fill: FillMode = "forwards";
  if (tier === "reduced" || typeof host.animate !== "function") {
    if (typeof host.animate === "function") animations.push(host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill }));
  } else {
    const width = window.innerWidth;
    const height = window.innerHeight;
    // corners: lean 8px toward the centre (60ms), then out along their own diagonal past the edge (200ms) — no fade
    host.querySelectorAll<HTMLElement>(".intro__corner").forEach((corner, index) => {
      const box = corner.getBoundingClientRect();
      const x = box.left + box.width / 2 - width / 2;
      const y = box.top + box.height / 2 - height / 2;
      const length = Math.hypot(x, y) || 1;
      const ux = x / length;
      const uy = y / length;
      const out = Math.max(box.width, box.height) + 48;
      animations.push(
        corner.animate(
          [
            { translate: "0px 0px", easing: "ease-out" },
            { translate: `${(-ux * 8).toFixed(1)}px ${(-uy * 8).toFixed(1)}px`, offset: 60 / 260, easing: easings.exit },
            { translate: `${(ux * out).toFixed(1)}px ${(uy * out).toFixed(1)}px` },
          ],
          { duration: 260, delay: index * 40, fill },
        ),
      );
    });
    // the panel and the skip key leave the way things leave
    for (const element of host.querySelectorAll<HTMLElement>(".intro__panel, .intro__skip")) {
      animations.push(element.animate([{ opacity: 1 }, { opacity: 0, translate: "0 8px" }], { duration: 140, easing: easings.exit, fill }));
    }
    // the logo travels to the header's lockup (a shared element in spirit): the wordmark lands on the header's wordmark
    const logo = host.querySelector<SVGSVGElement>(".intro__logo svg");
    const word = logo?.querySelector<SVGGraphicsElement>('[data-part="wordmark"]');
    const target = visibleElement(".shell-lockup__word") ?? visibleElement(".shell-lockup__mark");
    if (logo && word && target) {
      const from = word.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const svg = logo.getBoundingClientRect();
      const scale = to.width / Math.max(1, from.width);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      logo.style.transformOrigin = `${from.left + from.width / 2 - svg.left}px ${from.top + from.height / 2 - svg.top}px`;
      const settle = springTiming("settle");
      animations.push(logo.animate([{ transform: "none" }, { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})` }], { duration: settle.duration, easing: settle.easing, fill }));
      animations.push(logo.animate([{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: settle.duration, fill }));
      logo.querySelectorAll<SVGGElement>('[data-part]:not([data-part="wordmark"])').forEach((part) => {
        animations.push(part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: easings.exit, fill }));
      });
    }
    // the floor fades: the home page is already there underneath
    const floor = host.querySelector<HTMLElement>(".intro__floor");
    if (floor) animations.push(floor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, delay: 80, easing: easings.water, fill }));
  }
  await Promise.allSettled(animations.map((animation) => animation.finished));
}

function visibleElement(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden") return element;
  }
  return null;
}
