import type { ReactNode } from "react";

/**
 * Hand-drawn glyphs that the Phosphor sprite does not have — Design v2.1 G4. Drawn on a 24px grid with 2-unit strokes,
 * round caps and joins (2px at 24px, the before's weight), in currentColor. <Icon name="device-playstation" /> renders
 * them inline, through the same API as the sprite (app/art/Icon.tsx).
 *
 *   device-*   the four platforms as neutral device silhouettes (never logos — the owner has not given logo rights,
 *              DESIGN.md §14): the before's PlatformGlyph pictograms (git ac1a104), redrawn at 2px
 *   kind-*     catalogue kinds: console, game, controller, headset, storage, charging, top-up card, accessory, used,
 *              repair — for category tiles, filters, the categories sheet
 *   media-*    play / pause for a carousel's autoplay key (filled)
 *   status-*   a toast's kind (info, ok, warning, error) and offline — inline, so they draw with no network (v2.1 fix
 *              round: the offline toast's sprite icon came out blank)
 */
export const GLYPHS = {
  "device-nintendo": (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="3.4" />
      <path d="M7.3 6.5v11M16.7 6.5v11" />
    </>
  ),
  "device-playstation": (
    <>
      <path d="M8.9 19.5 8 6c-.1-1.5.6-2.5 1.9-2.5h4.2c1.3 0 2 1 1.9 2.5l-.9 13.5" />
      <path d="M12 3.5v16M6.5 20.5h11" />
    </>
  ),
  "device-xbox": (
    <>
      <path d="m7 6.5 5-2.5 5 2.5v11L12 20l-5-2.5Z" />
      <path d="m7 6.5 5 2.5 5-2.5M12 9v11" />
    </>
  ),
  "device-handheld": (
    <>
      <rect x="2" y="6.5" width="20" height="11" rx="3.8" />
      <rect x="7.6" y="9" width="8.8" height="6" rx="1.2" />
      <path d="M4.9 10.6h.1M19 13.4h.1" />
    </>
  ),
  "kind-console": (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2.6" />
      <path d="M6.6 14h6.4" />
      <circle cx="17" cy="12" r="1.6" />
    </>
  ),
  "kind-game": (
    <>
      <rect x="5" y="2.8" width="14" height="18.4" rx="2.2" />
      <path d="M5 7h14" />
      <circle cx="12" cy="14" r="3.2" />
      <path d="M12 14h.01" />
    </>
  ),
  "kind-controller": (
    <>
      <path d="M7 8h10a4 4 0 0 1 3.9 3.1l.9 4.3a2.6 2.6 0 0 1-4.4 2.4L15.6 16H8.4l-1.8 1.8a2.6 2.6 0 0 1-4.4-2.4l.9-4.3A4 4 0 0 1 7 8Z" />
      <path d="M8.2 10.6v3.2M6.6 12.2h3.2M15.6 11.2h.01M17.6 13.2h.01" />
    </>
  ),
  "kind-headset": (
    <>
      <path d="M4 15v-2.5a8 8 0 0 1 16 0V15" />
      <rect x="3" y="13.5" width="4.4" height="6.5" rx="1.8" />
      <rect x="16.6" y="13.5" width="4.4" height="6.5" rx="1.8" />
      <path d="M19.5 20c0 1.2-1.4 2-3.5 2H14" />
    </>
  ),
  "kind-storage": (
    <>
      <rect x="2.5" y="7" width="19" height="10" rx="2.2" />
      <path d="M6 10.6h7M6 13.4h4.5M17.5 10v4" />
    </>
  ),
  "kind-charging": (
    <>
      <rect x="2.5" y="7" width="16" height="10" rx="2.6" />
      <path d="M21.5 10.5v3" />
      <path d="m11.2 9-2.4 3.4h3.4L9.8 15.9" />
    </>
  ),
  "kind-topup": (
    <>
      <rect x="2.8" y="5.5" width="18.4" height="13" rx="2.6" />
      <path d="M12 9v6M9 12h6" />
    </>
  ),
  "kind-accessory": (
    <>
      <path d="M8 3v3.5M12 3v3.5" />
      <path d="M6 6.5h8V10a4 4 0 0 1-8 0Z" />
      <path d="M10 14v2.5a4.5 4.5 0 0 0 9 0V5" />
    </>
  ),
  "kind-used": (
    <>
      <path d="M20 11a8 8 0 0 0-14.2-4.8L4 8" />
      <path d="M4 3.8V8h4.2" />
      <path d="M4 13a8 8 0 0 0 14.2 4.8L20 16" />
      <path d="M20 20.2V16h-4.2" />
    </>
  ),
  "kind-repair": <path d="M14.6 6.4a4.2 4.2 0 0 0-5.3 5.3l-5.8 5.8a1.9 1.9 0 0 0 2.6 2.6l5.8-5.8a4.2 4.2 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4Z" />,
  "media-play": <path d="M8.5 5.9v12.2a.9.9 0 0 0 1.4.8l9.4-6.1a.9.9 0 0 0 0-1.6L9.9 5.1a.9.9 0 0 0-1.4.8Z" fill="currentColor" />,
  "media-pause": (
    <>
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  // a toast's kind, drawn inline so it shows offline too (the sprite may never have been fetched — fix round 2026-11-13)
  "status-info": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  "status-ok": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m7.8 12.3 2.8 2.8 5.6-5.8" />
    </>
  ),
  "status-warning": (
    <>
      <path d="M10.3 4.2a2 2 0 0 1 3.4 0l7.6 13.2A2 2 0 0 1 19.6 20.4H4.4a2 2 0 0 1-1.7-3l7.6-13.2Z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  "status-error": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5V13" />
      <circle cx="12" cy="16.4" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  "status-offline": (
    <>
      <path d="M3 3.5 21 20.5" />
      <path d="M8.6 15.4a5 5 0 0 1 6 .4M5.2 12a9.5 9.5 0 0 1 4-2.4M18.8 12a9.5 9.5 0 0 0-3.7-2.3M2 8.6a14.5 14.5 0 0 1 5-2.9M22 8.6a14.5 14.5 0 0 0-10.5-4" />
      <circle cx="12" cy="19.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof GLYPHS;

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];

/** The glyphs by purpose — for the design-system page and for finding the right one. */
export const GLYPH_GROUPS = {
  devices: ["device-nintendo", "device-playstation", "device-xbox", "device-handheld"],
  kinds: ["kind-console", "kind-game", "kind-controller", "kind-headset", "kind-storage", "kind-charging", "kind-topup", "kind-accessory", "kind-used", "kind-repair"],
  media: ["media-play", "media-pause"],
  status: ["status-info", "status-ok", "status-warning", "status-error", "status-offline"],
} as const satisfies Record<string, readonly GlyphName[]>;

export function isGlyph(name: string): name is GlyphName {
  return Object.prototype.hasOwnProperty.call(GLYPHS, name);
}
