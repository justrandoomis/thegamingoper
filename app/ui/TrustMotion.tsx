import type { ReactElement } from "react";

/**
 * The trust strip's motion scenes (home, `variant="motion"`): one LONG horizontal looping scene per service (600×96),
 * each row of the strip carries one. Inline SVG animated with CSS only (transform, opacity, offset-distance — `.tmo*`
 * rules in components.css), so it scales to any width and follows the theme: line work is `currentColor` (--ink),
 * accents --red-ink on --red-tint, cut-outs in --ground. Decorative: aria-hidden — the row's words say it. Mirrored in
 * RTL so everything travels in the reading direction (`.tmo-upright` keeps ticks and letters readable). With reduced
 * motion every scene stands still in a composed resting pose.
 *
 *   delivery   a truck drives the whole row past a city, the governorate pins pop as it passes
 *   cod        the parcel goes from the van to the customer's hand, banknotes fly back, a tick seals it
 *   transfer   money flows from the phone to a receipt, a magnifier reviews it, the stamp lands, money reaches the card
 *   guest      the order number on the phone, the parcel rides a long route through two stops to the pin
 *   warranty   devices ride a belt under the shield; each one gets scanned and a tick
 */
export type TrustMotionKey = "delivery" | "cod" | "transfer" | "guest" | "warranty";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const W = "var(--ground, #fff)";

function Tick({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const k = r / 9;
  return (
    <>
      <circle cx={cx} cy={cy} r={r} className="tmo-solid" />
      <g className="tmo-upright">
        <path
          d={`M${cx - 4.5 * k} ${cy}l${3 * k} ${3 * k} ${6 * k}-${6.5 * k}`}
          fill="none"
          stroke="#fff"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </>
  );
}

/** A skyline 600 wide (drawn twice for a seamless pan). */
const BLOCKS: readonly [x: number, w: number, h: number][] = [
  [6, 26, 30], [36, 18, 48], [58, 30, 24], [96, 20, 56], [122, 34, 36], [162, 16, 44], [184, 28, 28], [218, 22, 60],
  [246, 30, 32], [282, 18, 50], [306, 36, 26], [348, 22, 54], [376, 28, 38], [410, 16, 46], [432, 34, 30], [472, 20, 62],
  [498, 30, 34], [534, 18, 48], [558, 36, 28],
];
function Skyline({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} {...S} strokeWidth={1.4}>
      {BLOCKS.map(([bx, bw, bh]) => (
        <path key={bx} d={`M${bx} 90V${90 - bh}h${bw}V90`} />
      ))}
      {BLOCKS.filter((_, i) => i % 3 === 1).map(([bx, bw, bh]) => (
        <path key={`w${bx}`} d={`M${bx + 5} ${96 - bh}h${bw - 10}M${bx + 5} ${102 - bh}h${bw - 10}M${bx + 5} ${108 - bh}h${bw - 10}`} strokeWidth={1.1} />
      ))}
    </g>
  );
}

function Pin({ x, base, delay }: { x: number; base: number; delay: string }) {
  return (
    <g className="tmo-pin-pop" style={{ animationDelay: delay }}>
      <path {...S} d={`M${x} ${base}s10-10 10-18a10 10 0 1 0-20 0c0 8 10 18 10 18z`} className="tmo-tint" />
      <circle cx={x} cy={base - 18} r={3.5} className="tmo-solid" />
    </g>
  );
}

function Delivery() {
  return (
    <svg viewBox="0 0 600 96" className="tmo tmo--delivery" preserveAspectRatio="xMidYMid meet">
      <g className="tmo-cloud">
        <path {...S} strokeWidth={1.4} d="M90 22h34a8 8 0 0 0-8-10 10 10 0 0 0-18 2 7 7 0 0 0-8 8zM420 16h28a7 7 0 0 0-7-8 9 9 0 0 0-15 2 6 6 0 0 0-6 6z" />
      </g>
      <g className="tmo-far">
        <Skyline x={0} />
        <Skyline x={600} />
      </g>
      <path {...S} strokeWidth={1.6} d="M0 90h600" />
      <g className="tmo-road" {...S} strokeWidth={2}>
        <path d={Array.from({ length: 27 }, (_, i) => `M${i * 24} 94h10`).join("")} />
      </g>
      <Pin x={170} base={88} delay="1.6s" />
      <Pin x={330} base={88} delay="2.9s" />
      <Pin x={490} base={88} delay="4.2s" />
      <g className="tmo-drive">
        <g className="tmo-wind" {...S} strokeWidth={1.8}>
          <path d="M226 56h16" />
          <path d="M218 66h22" />
          <path d="M228 76h12" />
        </g>
        <g className="tmo-bounce">
          <rect x="250" y="46" width="52" height="36" rx="3" className="tmo-tint" {...S} />
          <path {...S} d="M302 56h18l14 14v12h-32z" fill={W} />
          <path {...S} d="M307 60h11l9 9h-20z" strokeWidth={1.5} />
          <rect x="258" y="54" width="18" height="12" rx="2" className="tmo-solid" />
          <path {...S} d="M280 58h14M280 64h9" strokeWidth={1.4} />
        </g>
        <g className="tmo-wheel">
          <circle {...S} cx="266" cy="84" r="6" fill={W} />
          <path {...S} d="M266 80v8M262 84h8" strokeWidth={1.4} />
        </g>
        <g className="tmo-wheel">
          <circle {...S} cx="318" cy="84" r="6" fill={W} />
          <path {...S} d="M318 80v8M314 84h8" strokeWidth={1.4} />
        </g>
      </g>
    </svg>
  );
}

function Cash() {
  return (
    <svg viewBox="0 0 600 96" className="tmo tmo--cod" preserveAspectRatio="xMidYMid meet">
      {/* the van, the customer's hand, the dotted way between */}
      <g className="tmo-idle">
        <rect x="18" y="42" width="54" height="38" rx="3" className="tmo-tint" {...S} />
        <path {...S} d="M72 52h16l12 12v16H72z" fill={W} />
        <path {...S} d="M76 56h10l8 8H76z" strokeWidth={1.4} />
        <circle {...S} cx="34" cy="82" r="6" fill={W} />
        <circle {...S} cx="86" cy="82" r="6" fill={W} />
      </g>
      <path {...S} strokeWidth={1.6} d="M0 90h600" opacity={0.35} />
      <path {...S} d="M120 60H520" strokeWidth={1.6} strokeDasharray="2 7" opacity={0.45} />
      <g {...S}>
        <path d="M598 66c-8-6-18-7-26-3l-14 6c-4 2-4 7 1 7h16" />
        <path d="M598 80h-34l-24-13c-4-3-1-8 4-7l16 5" />
      </g>
      <g className="tmo-parcel">
        <rect x="106" y="44" width="30" height="26" rx="3" className="tmo-tint" {...S} />
        <path {...S} d="M106 54h30M121 44v10" strokeWidth={1.5} />
      </g>
      {[0, 1, 2].map((i) => (
        <g key={i} className="tmo-note" style={{ animationDelay: `${i * 0.16}s` }}>
          <rect x="540" y="30" width="38" height="20" rx="2" {...S} fill={W} />
          <circle cx="559" cy="40" r="4.5" className="tmo-solid" />
          <path {...S} d="M545 35v10M573 35v10" strokeWidth={1.2} />
        </g>
      ))}
      <g className="tmo-seal">
        <Tick cx={320} cy={30} r={11} />
      </g>
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} className="tmo-spark-dot tmo-solid" cx={300 + i * 14} cy={30} r={2} style={{ animationDelay: `${i * 0.08}s` }} />
      ))}
    </svg>
  );
}

function Coin({ x, y, delay, className }: { x: number; y: number; delay: number; className: string }) {
  return (
    <g className={className} style={{ animationDelay: `${delay}s` }}>
      <circle cx={x} cy={y} r={6} className="tmo-solid" />
      <circle cx={x} cy={y} r={3} fill="none" stroke="#fff" strokeWidth={1.2} />
    </g>
  );
}

function Transfer() {
  return (
    <svg viewBox="0 0 600 96" className="tmo tmo--transfer" preserveAspectRatio="xMidYMid meet">
      <g>
        <rect x="22" y="8" width="42" height="80" rx="7" {...S} />
        <path {...S} d="M38 80h10" />
        <rect x="29" y="18" width="28" height="22" rx="3" className="tmo-tint" {...S} strokeWidth={1.4} />
        <g className="tmo-upright">
          <path {...S} d="M36 24h14l-14 10h14" strokeWidth={1.8} className="tmo-ink-red" />
        </g>
        <path {...S} d="M30 50h26M30 58h18M30 66h22" strokeWidth={1.4} />
      </g>
      <path {...S} d="M72 49H262M338 49H512" strokeWidth={1.6} strokeDasharray="2 7" opacity={0.45} />
      {[0, 0.375, 0.75, 1.125].map((d) => (
        <Coin key={d} x={76} y={49} delay={d} className="tmo-lane-a" />
      ))}
      {/* the receipt under review */}
      <g>
        <path {...S} fill={W} d="M270 10h60v72l-7.5-5-7.5 5-7.5-5-7.5 5-7.5-5-7.5 5-7.5-5-7.5 5z" />
        <path {...S} d="M280 22h40M280 32h30M280 42h36M280 52h24" strokeWidth={1.4} />
      </g>
      <g className="tmo-lens">
        <circle {...S} cx="296" cy="36" r="13" fill="var(--red-tint)" fillOpacity={0.55} />
        <path {...S} d="M305 46l10 10" strokeWidth={3} />
      </g>
      <g className="tmo-stamp">
        <Tick cx={318} cy={66} r={12} />
      </g>
      <g className="tmo-lane-b-wrap">
        {[0, 0.375, 0.75, 1.125].map((d) => (
          <Coin key={d} x={342} y={49} delay={d} className="tmo-lane-b" />
        ))}
      </g>
      <g className="tmo-card">
        <rect x="514" y="22" width="76" height="52" rx="7" {...S} fill={W} />
        <path {...S} d="M514 36h76" strokeWidth={4} />
        <rect x="524" y="48" width="14" height="11" rx="2" className="tmo-solid" />
        <path {...S} d="M546 60h34M546 52h20" strokeWidth={1.5} />
      </g>
    </svg>
  );
}

const ROUTE = "M70 62C140 62 160 26 236 26S340 70 420 62S520 30 552 48";

function Guest() {
  return (
    <svg viewBox="0 0 600 96" className="tmo tmo--guest" preserveAspectRatio="xMidYMid meet">
      <g {...S} strokeWidth={1} opacity={0.16}>
        <path d={Array.from({ length: 9 }, (_, i) => `M${96 + i * 60} 4v88`).join("") + "M70 20h530M70 48h530M70 76h530"} />
      </g>
      <g>
        <rect x="18" y="10" width="40" height="78" rx="7" {...S} />
        <path {...S} d="M33 80h10" />
        <g className="tmo-upright">
          <path {...S} d="M26 26h10M26 34h10M31 20l-2 20M36 20l-2 20" strokeWidth={1.6} className="tmo-ink-red" />
        </g>
        <path {...S} d="M40 26h10M40 34h8M26 50h24M26 58h16" strokeWidth={1.4} />
      </g>
      <path {...S} d={ROUTE} strokeWidth={2} strokeDasharray="3 6" opacity={0.5} />
      {/* the two stops on the way: the store, the courier */}
      <g className="tmo-stop" style={{ animationDelay: "1.2s" }}>
        <circle cx="236" cy="26" r="11" className="tmo-tint" {...S} />
        <path {...S} d="M230 30v-6l6-5 6 5v6z" strokeWidth={1.4} />
      </g>
      <g className="tmo-stop" style={{ animationDelay: "2.45s" }}>
        <circle cx="420" cy="62" r="11" className="tmo-tint" {...S} />
        <path {...S} d="M413 58h9v7h-9zM422 60h3l3 3v2h-6z" strokeWidth={1.3} />
      </g>
      <g className="tmo-rider" style={{ offsetPath: `path('${ROUTE}')` }}>
        <rect x="-7" y="-7" width="14" height="14" rx="2.5" className="tmo-solid" />
        <path d="M-7 -2h14M0 -7v5" stroke="#fff" strokeWidth={1.2} fill="none" />
      </g>
      <ellipse className="tmo-shadow" cx="566" cy="88" rx="9" ry="2.4" fill="currentColor" opacity={0.18} />
      <g className="tmo-pin">
        <path {...S} d="M566 86s14-14 14-26a14 14 0 1 0-28 0c0 12 14 26 14 26z" className="tmo-tint" />
        <circle cx="566" cy="60" r="5" className="tmo-solid" />
      </g>
    </svg>
  );
}

function Controller({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} className="tmo-static">
      <path {...S} className="tmo-tint" d="M-24 52h48c10 0 15 8 16 17l1 4c1 6-6 9-10 5l-8-8h-46l-8 8c-4 4-11 1-10-5l1-4c1-9 6-17 16-17z" />
      <path {...S} d="M-20 58v10M-25 63h10" strokeWidth={1.8} />
      <circle cx="16" cy="59" r="2.5" className="tmo-solid" />
      <circle cx="22" cy="66" r="2.5" fill="currentColor" />
    </g>
  );
}
function Console({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} className="tmo-static">
      <rect x="-17" y="42" width="34" height="38" rx="4" {...S} className="tmo-tint" />
      <path {...S} d="M-10 50h20M-10 56h12" strokeWidth={1.5} />
      <circle cx="10" cy="70" r="2.5" className="tmo-solid" />
    </g>
  );
}
function Headset({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} className="tmo-static">
      <path {...S} d="M-17 70V60a17 17 0 0 1 34 0v10" strokeWidth={2.4} />
      <rect x="-26" y="60" width="12" height="20" rx="4" {...S} className="tmo-tint" />
      <rect x="14" y="60" width="12" height="20" rx="4" {...S} className="tmo-tint" />
      <circle cx="20" cy="70" r="2.5" className="tmo-solid" />
    </g>
  );
}

function Warranty() {
  return (
    <svg viewBox="0 0 600 96" className="tmo tmo--warranty" preserveAspectRatio="xMidYMid meet">
      <path className="tmo-beam" d="M290 38h20l30 44h-80z" fill="var(--red-tint)" />
      <g className="tmo-belt">
        <Controller x={-500} />
        <Console x={-300} />
        <Headset x={-100} />
        <Controller x={100} />
        <Console x={300} />
        <Headset x={500} />
      </g>
      <path {...S} d="M10 84h580M10 92h580" strokeWidth={1.6} />
      {Array.from({ length: 10 }, (_, i) => (
        <g key={i} className="tmo-roller">
          <circle {...S} cx={30 + i * 60} cy={88} r={3} strokeWidth={1.4} fill={W} />
        </g>
      ))}
      <g className="tmo-guard">
        <path {...S} className="tmo-tint" d="M300 2l15 5v10c0 9-7 15-15 18-8-3-15-9-15-18V7z" />
        <g className="tmo-upright">
          <path {...S} d="M294 18l4.5 4.5 8-9" strokeWidth={2.4} className="tmo-ink-red" />
        </g>
      </g>
      <g {...S} strokeWidth={1.6}>
        <path className="tmo-twinkle" d="M268 10v8M264 14h8" />
        <path className="tmo-twinkle" style={{ animationDelay: "0.7s" }} d="M340 16v6M337 19h6" />
        <path className="tmo-twinkle" style={{ animationDelay: "1.3s" }} d="M326 30v6M323 33h6" />
      </g>
    </svg>
  );
}

const SCENES: Record<TrustMotionKey, () => ReactElement> = { delivery: Delivery, cod: Cash, transfer: Transfer, guest: Guest, warranty: Warranty };

export function TrustMotion({ name }: { name: TrustMotionKey }) {
  const Scene = SCENES[name];
  return (
    <span className="trust__motion" aria-hidden="true">
      <Scene />
    </span>
  );
}
