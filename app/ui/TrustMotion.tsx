import type { ReactElement } from "react";

/**
 * The trust strip's motion icons (home, `variant="motion"`): one small looping motion graphic per fact, drawn as inline
 * SVG and animated with CSS only (transform and opacity, `.tmo*` rules in components.css). Line work is `currentColor`
 * (--ink), the accents are the brand red. Decorative: every icon is aria-hidden — the fact's title says it. With reduced
 * motion the icons stand still in their resting pose.
 */
export type TrustMotionKey = "delivery" | "cod" | "transfer" | "guest" | "warranty";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Delivery() {
  return (
    <svg viewBox="0 0 64 64" className="tmo tmo--delivery">
      {/* speed lines rush backwards while the truck bobs on the road */}
      <g className="tmo-lines" {...S} strokeWidth={2.2}>
        <path d="M4 22h10" />
        <path d="M2 30h8" />
        <path d="M6 38h9" />
      </g>
      <g className="tmo-truck">
        <path {...S} d="M16 18h24v24H16z" className="tmo-red-fill" />
        <path {...S} d="M40 26h9l7 8v8H40z" />
        <path {...S} d="M44 29h4l4 5h-8z" strokeWidth={1.8} />
      </g>
      <g className="tmo-wheel" style={{ transformOrigin: "24px 45px" }}>
        <circle {...S} cx="24" cy="45" r="5" fill="var(--card-face, #fff)" />
        <path {...S} d="M24 41v8M20 45h8" strokeWidth={1.6} />
      </g>
      <g className="tmo-wheel" style={{ transformOrigin: "48px 45px" }}>
        <circle {...S} cx="48" cy="45" r="5" fill="var(--card-face, #fff)" />
        <path {...S} d="M48 41v8M44 45h8" strokeWidth={1.6} />
      </g>
      <defs>
        <clipPath id="tmo-road-clip">
          <rect x="0" y="50" width="64" height="8" />
        </clipPath>
      </defs>
      <g clipPath="url(#tmo-road-clip)">
        <path className="tmo-road" {...S} strokeWidth={2} d="M2 54h76" strokeDasharray="8 6" />
      </g>
    </svg>
  );
}

function Cash() {
  return (
    <svg viewBox="0 0 64 64" className="tmo tmo--cod">
      {/* a banknote slides into the hand, a coin drops and bounces */}
      <g className="tmo-bill">
        <rect {...S} x="14" y="12" width="36" height="20" rx="3" className="tmo-red-fill" />
        <circle {...S} cx="32" cy="22" r="4.5" />
      </g>
      <path {...S} d="M8 44c6-5 12-6 18-3l10 4c3 1 3 5-1 5H24" />
      <path {...S} d="M8 54h28l18-10c3-2 1-6-3-5l-12 4" />
      <g className="tmo-coin">
        <circle {...S} cx="57" cy="12" r="5" className="tmo-red-stroke" />
        <path {...S} d="M57 9.5v5" strokeWidth={2} className="tmo-red-stroke" />
      </g>
    </svg>
  );
}

function Transfer() {
  return (
    <svg viewBox="0 0 64 64" className="tmo tmo--transfer">
      {/* a card tilts, signal arcs pulse out of it, a tick confirms the transfer */}
      <g className="tmo-card">
        <rect {...S} x="6" y="18" width="38" height="26" rx="4" />
        <path {...S} d="M6 26h38" strokeWidth={3.4} />
        <rect x="11" y="32" width="8" height="6" rx="1.5" className="tmo-red-solid" />
        <path {...S} d="M24 38h14" strokeWidth={1.8} />
      </g>
      <g {...S} className="tmo-red-stroke">
        <path className="tmo-arc tmo-arc--1" d="M48 24a8 8 0 0 1 0 12" />
        <path className="tmo-arc tmo-arc--2" d="M52 19a15 15 0 0 1 0 22" />
        <path className="tmo-arc tmo-arc--3" d="M56 14a22 22 0 0 1 0 32" />
      </g>
      <g className="tmo-tick">
        <circle cx="44" cy="48" r="8" className="tmo-red-solid" />
        <path d="M40 48l3 3 5-6" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="tmo-draw" />
      </g>
    </svg>
  );
}

function Guest() {
  return (
    <svg viewBox="0 0 64 64" className="tmo tmo--guest">
      {/* a phone shows the order's number, tracking dots travel along a path to the pin */}
      <g className="tmo-phone">
        <rect {...S} x="8" y="10" width="22" height="40" rx="4" />
        <path {...S} d="M16 44h6" strokeWidth={2} />
        <path {...S} d="M13 20h12M13 26h8" strokeWidth={1.8} className="tmo-red-stroke" />
      </g>
      <path {...S} strokeWidth={1.8} d="M30 40c8 0 8-14 18-14" strokeDasharray="2 5" opacity={0.5} />
      <circle className="tmo-dot" cx="0" cy="0" r="2.6" style={{ offsetPath: "path('M30 40c8 0 8-14 18-14')" }} />
      <g className="tmo-pin">
        <path {...S} d="M50 34s8-8 8-14a8 8 0 1 0-16 0c0 6 8 14 8 14z" className="tmo-red-fill" />
        <circle cx="50" cy="20" r="2.6" fill="currentColor" />
      </g>
      <ellipse className="tmo-shadow" cx="50" cy="38" rx="5" ry="1.6" fill="currentColor" opacity={0.18} />
    </svg>
  );
}

function Warranty() {
  return (
    <svg viewBox="0 0 64 64" className="tmo tmo--warranty">
      {/* the shield's tick pops in, a glint sweeps across */}
      <defs>
        <clipPath id="tmo-shield-clip">
          <path d="M32 6l20 7v15c0 14-9 23-20 28C21 51 12 42 12 28V13z" />
        </clipPath>
      </defs>
      <g className="tmo-shield">
        <path {...S} d="M32 6l20 7v15c0 14-9 23-20 28C21 51 12 42 12 28V13z" className="tmo-red-fill" />
        <g clipPath="url(#tmo-shield-clip)">
          <rect className="tmo-glint" x="-6" y="0" width="8" height="64" fill="#fff" opacity={0.55} transform="skewX(-20)" />
        </g>
        <path {...S} strokeWidth={3} d="M23 30l6 6 12-13" className="tmo-draw tmo-red-stroke" />
      </g>
      <g className="tmo-spark" {...S} strokeWidth={2}>
        <path d="M54 6v6M51 9h6" />
      </g>
    </svg>
  );
}

const ICONS: Record<TrustMotionKey, () => ReactElement> = { delivery: Delivery, cod: Cash, transfer: Transfer, guest: Guest, warranty: Warranty };

export function TrustMotion({ name }: { name: TrustMotionKey }) {
  const Art = ICONS[name];
  return (
    <span className="trust__motion" aria-hidden="true">
      <Art />
    </span>
  );
}
