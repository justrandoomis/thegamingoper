import type { ReactElement } from "react";

/**
 * The trust strip's motion scenes (home, `variant="motion"`): one small WIDE looping scene per fact (160×64, like a
 * short GIF), drawn as inline SVG and animated with CSS only (transform, opacity, offset-distance — `.tmo*` rules in
 * components.css). Line work is `currentColor` (--ink), accents are --red-ink on --red-tint. Decorative: aria-hidden —
 * the fact's title says it. The scenes are mirrored in RTL so everything travels in the reading direction. With reduced
 * motion every scene stands still in its resting pose.
 */
export type TrustMotionKey = "delivery" | "cod" | "transfer" | "guest" | "warranty";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** One block of the skyline, 160 wide; drawn twice side by side so the loop is seamless. */
function Skyline({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} {...S} strokeWidth={1.5}>
      <path d="M4 52V30h14v22M22 52V20h12v32M40 52V34h18v18M66 52V24h10l6 6v22M90 52V36h12v16M108 52V16h14v36M128 52V28h10v24M144 52V38h12v14" />
      <path d="M26 26h4M26 32h4M26 38h4M112 22h6M112 28h6M112 34h6M70 32h2M70 38h2" strokeWidth={1.2} />
    </g>
  );
}

function Delivery() {
  return (
    <svg viewBox="0 0 160 64" className="tmo tmo--delivery">
      {/* the city scrolls by behind, the road dashes rush past, the truck bobs with its wheels turning */}
      <g className="tmo-far">
        <Skyline x={0} />
        <Skyline x={160} />
      </g>
      <path {...S} strokeWidth={1.5} d="M0 54h160" />
      <g className="tmo-road" {...S} strokeWidth={2}>
        <path d="M0 60h8M20 60h8M40 60h8M60 60h8M80 60h8M100 60h8M120 60h8M140 60h8M160 60h8M180 60h8" />
      </g>
      <g className="tmo-wind" {...S} strokeWidth={1.8}>
        <path d="M30 30h12" />
        <path d="M24 38h14" />
        <path d="M32 46h8" />
      </g>
      <g className="tmo-truck">
        <rect x="52" y="22" width="36" height="26" rx="2" className="tmo-tint" {...S} />
        <path {...S} d="M88 30h14l10 10v8H88z" fill="var(--ground, #fff)" />
        <path {...S} d="M93 34h7l6 6H93z" strokeWidth={1.5} />
        <rect x="58" y="28" width="12" height="9" rx="1.5" className="tmo-solid" />
      </g>
      <g className="tmo-wheel">
        <circle {...S} cx="64" cy="50" r="5" fill="var(--ground, #fff)" />
        <path {...S} d="M64 46.5v7M60.5 50h7" strokeWidth={1.4} />
      </g>
      <g className="tmo-wheel">
        <circle {...S} cx="100" cy="50" r="5" fill="var(--ground, #fff)" />
        <path {...S} d="M100 46.5v7M96.5 50h7" strokeWidth={1.4} />
      </g>
    </svg>
  );
}

/** An open hand from the left edge, palm up. */
function Hand() {
  return (
    <g {...S}>
      <path d="M2 44c6-4 12-5 18-2l10 4c3 1 3 5-1 5H18" />
      <path d="M2 54h24l16-9c3-2 1-6-3-5l-11 4" />
    </g>
  );
}

function Cash() {
  return (
    <svg viewBox="0 0 160 64" className="tmo tmo--cod">
      {/* the parcel travels from the courier's hand to the customer's, the banknote goes back, a tick seals it */}
      <Hand />
      <g transform="translate(160 0) scale(-1 1)" className="tmo-static">
        <Hand />
      </g>
      <g className="tmo-parcel">
        <rect x="18" y="22" width="18" height="16" rx="2" className="tmo-tint" {...S} />
        <path {...S} d="M18 28h18M27 22v6" strokeWidth={1.5} />
      </g>
      <g className="tmo-bill">
        <rect x="120" y="24" width="26" height="14" rx="2" {...S} fill="var(--ground, #fff)" />
        <circle cx="133" cy="31" r="3" className="tmo-solid" />
      </g>
      <g className="tmo-check">
        <circle cx="80" cy="22" r="9" className="tmo-solid" />
        <g className="tmo-upright"><path d="M75.5 22l3 3 6-6.5" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></g>
      </g>
    </svg>
  );
}

function Transfer() {
  return (
    <svg viewBox="0 0 160 64" className="tmo tmo--transfer">
      {/* money leaves the phone, runs along the line into the card; the card glows and confirms */}
      <g className="tmo-phone">
        <rect x="14" y="8" width="26" height="48" rx="5" {...S} />
        <path {...S} d="M24 50h6" />
        <rect x="19" y="16" width="16" height="12" rx="2" className="tmo-tint" {...S} strokeWidth={1.4} />
        <g className="tmo-upright"><path {...S} d="M23 20h8l-8 5h8" strokeWidth={1.4} className="tmo-ink-red" /></g>
        <path {...S} d="M19 34h16M19 40h10" strokeWidth={1.4} />
      </g>
      <path {...S} d="M46 32h60" strokeWidth={1.5} strokeDasharray="2 5" opacity={0.45} />
      <g>
        <circle className="tmo-coin tmo-solid" cx="48" cy="32" r="4" />
        <circle className="tmo-coin tmo-solid" cx="48" cy="32" r="4" />
        <circle className="tmo-coin tmo-solid" cx="48" cy="32" r="4" />
      </g>
      <g className="tmo-card">
        <rect x="108" y="16" width="44" height="30" rx="4" {...S} fill="var(--ground, #fff)" />
        <path {...S} d="M108 24h44" strokeWidth={3} />
        <rect x="113" y="31" width="9" height="7" rx="1.5" className="tmo-solid" />
        <path {...S} d="M127 38h18" strokeWidth={1.5} />
      </g>
      <g className="tmo-check">
        <circle cx="150" cy="46" r="7" className="tmo-solid" />
        <g className="tmo-upright"><path d="M146.5 46l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></g>
      </g>
    </svg>
  );
}

const ROUTE = "M42 40c18 0 18-20 40-20s22 22 46 8";

function Guest() {
  return (
    <svg viewBox="0 0 160 64" className="tmo tmo--guest">
      {/* the order number on the phone, the parcel rides the route across the map, the pin hops when it lands */}
      <g {...S} strokeWidth={1} opacity={0.18}>
        <path d="M48 8v52M80 8v52M112 8v52M144 8v52M44 16h112M44 36h112M44 56h112" />
      </g>
      <g className="tmo-phone">
        <rect x="10" y="10" width="26" height="46" rx="5" {...S} />
        <path {...S} d="M20 50h6" />
        <path {...S} d="M16 20h4M16 26h4M21 17l-2 12M25 17l-2 12" strokeWidth={1.4} className="tmo-ink-red" />
        <path {...S} d="M16 36h14M16 42h9" strokeWidth={1.4} />
      </g>
      <path {...S} d={ROUTE} strokeWidth={1.8} strokeDasharray="3 5" opacity={0.5} />
      <g className="tmo-rider" style={{ offsetPath: `path('${ROUTE}')` }}>
        <rect x="-5" y="-5" width="10" height="10" rx="2" className="tmo-solid" />
      </g>
      <ellipse className="tmo-shadow" cx="138" cy="40" rx="6" ry="1.8" fill="currentColor" opacity={0.18} />
      <g className="tmo-pin">
        <path {...S} d="M138 38s9-9 9-16a9 9 0 1 0-18 0c0 7 9 16 9 16z" className="tmo-tint" />
        <circle cx="138" cy="22" r="3" fill="currentColor" />
      </g>
    </svg>
  );
}

function Warranty() {
  return (
    <svg viewBox="0 0 160 64" className="tmo tmo--warranty">
      {/* a protective field ripples out around the controller, the shield badge pops with its tick, sparks twinkle */}
      <g className="tmo-ring">
        <ellipse cx="80" cy="40" rx="44" ry="22" {...S} className="tmo-ink-red" strokeWidth={1.5} />
      </g>
      <g className="tmo-ring tmo-ring--2">
        <ellipse cx="80" cy="40" rx="44" ry="22" {...S} className="tmo-ink-red" strokeWidth={1.5} />
      </g>
      <g className="tmo-pad">
        <path
          {...S}
          className="tmo-tint"
          d="M62 30h36c8 0 12 6 13 14l1 5c1 5-5 8-9 4l-6-6H63l-6 6c-4 4-10 1-9-4l1-5c1-8 5-14 13-14z"
        />
        <path {...S} d="M64 36v8M60 40h8" strokeWidth={1.8} />
        <circle cx="94" cy="37" r="2" className="tmo-solid" />
        <circle cx="99" cy="42" r="2" fill="currentColor" />
      </g>
      <g className="tmo-badge">
        <path d="M118 8l12 4v8c0 8-5 13-12 16-7-3-12-8-12-16v-8z" className="tmo-solid" />
        <g className="tmo-upright"><path d="M113 20l3.5 3.5 6.5-7" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></g>
      </g>
      <g {...S} strokeWidth={1.6}>
        <path className="tmo-spark" d="M26 14v8M22 18h8" />
        <path className="tmo-spark tmo-spark--2" d="M144 44v6M141 47h6" />
        <path className="tmo-spark tmo-spark--3" d="M40 50v6M37 53h6" />
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
