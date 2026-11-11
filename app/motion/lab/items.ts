/**
 * Demo content for the motion lab. Nothing here is a real product: the pictures are generated shapes and the
 * prices are placeholder numbers used to exercise the number morph. The lab says so on screen.
 */
export type LabItem = { id: string; hue: number; priceIqd: number };

export const LAB_ITEMS: readonly LabItem[] = [
  { id: "a", hue: 352, priceIqd: 749_000 },
  { id: "b", hue: 212, priceIqd: 615_000 },
  { id: "c", hue: 148, priceIqd: 89_000 },
  { id: "d", hue: 268, priceIqd: 1_250_000 },
  { id: "e", hue: 28, priceIqd: 45_000 },
  { id: "f", hue: 190, priceIqd: 320_000 },
];

export function labItemIndex(id: string | undefined): number {
  return LAB_ITEMS.findIndex((item) => item.id === id);
}

/** Demo exchange rate for the currency toggle (not a market rate). */
export const LAB_FX = { iqdPerUnit: { USD: 1310 }, source: "demo", updatedAt: 0 };

const artCache = new Map<number, string>();

/** A soft generic "device" drawn in one hue, as an SVG data URL (square, transparent background). */
export function labArt(hue: number): string {
  let url = artCache.get(hue);
  if (url) return url;
  const body = `hsl(${hue} 68% 56%)`;
  const light = `hsl(${hue} 80% 72%)`;
  const dark = `hsl(${hue} 60% 38%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">` +
    `<ellipse cx="200" cy="338" rx="128" ry="18" fill="rgb(0 0 0 / 0.14)"/>` +
    `<rect x="52" y="112" width="296" height="176" rx="64" fill="${dark}"/>` +
    `<rect x="52" y="100" width="296" height="176" rx="64" fill="${body}"/>` +
    `<rect x="122" y="132" width="156" height="104" rx="18" fill="hsl(${hue} 30% 16%)"/>` +
    `<circle cx="92" cy="170" r="20" fill="${light}"/>` +
    `<circle cx="308" cy="206" r="20" fill="${light}"/>` +
    `<circle cx="308" cy="158" r="9" fill="${dark}"/>` +
    `<circle cx="92" cy="218" r="9" fill="${dark}"/>` +
    `<path d="M92 118c40-12 176-12 216 0" stroke="rgb(255 255 255 / 0.5)" stroke-width="8" stroke-linecap="round" fill="none"/>` +
    `</svg>`;
  url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  artCache.set(hue, url);
  return url;
}

export const LAB_TABS = ["touch", "flow", "reveal", "cart", "system"] as const;
export type LabTab = (typeof LAB_TABS)[number];

export function labTab(search: string): LabTab {
  const value = new URLSearchParams(search).get("tab");
  return (LAB_TABS as readonly string[]).includes(value ?? "") ? (value as LabTab) : "touch";
}
