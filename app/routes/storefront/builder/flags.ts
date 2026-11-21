/**
 * Switch bundle builder — whether the store LEADS shoppers to it (docs/switch-builder.md §8). Client-safe.
 *
 * /build/switch works whatever this says: anyone with the address can use it, and its meta asks search engines not
 * to index it while this is false. The flag decides only whether the store links to it — the Nintendo mega menu, the
 * /platform/nintendo hub, the Switch 1 device hubs (/device/switch-oled, /device/switch, /device/switch-lite), the
 * Switch 1 console product pages and the footer. Each of those asks `switchBuilderHref` and draws nothing on null.
 *
 * Turn it on when the owner has added sizes for the popular games (admin → catalog → Switch library): until then most
 * games say «لم يُضف الحجم بعد» and cannot join the space bar. The same switch lists the page in the sitemap
 * (content.server.ts `staticSitemapPaths`) and lets the page be indexed (its meta reads this flag).
 */
import { isSwitchModel } from "~/lib/switch-builder/storage";

/** Turn on when the owner has added sizes for the popular games. */
export const SWITCH_BUILDER_PUBLIC: boolean = false;

/** The builder's address, locale-less (LocaleLink adds /en or /ckb). */
export const SWITCH_BUILDER_PATH = "/build/switch";

/**
 * Where a page may link to the builder: the footer (every store page), a platform's menu or hub (Nintendo only), or a
 * device model's pages (its hub, or the product page of a console that IS the model) — Switch 1 models only: the
 * builder plans for Switch 1 (Switch 2 games and cards are not in its library).
 */
export type SwitchBuilderPlace = "footer" | { platform: string } | { deviceModel: string | null | undefined };

/** The builder's address for a link in this place, or null: the builder is not public yet, or the place is not Switch 1. */
export function switchBuilderHref(place: SwitchBuilderPlace, enabled: boolean = SWITCH_BUILDER_PUBLIC): string | null {
  if (!enabled) return null;
  if (place === "footer") return SWITCH_BUILDER_PATH;
  if ("platform" in place) return place.platform === "nintendo" ? SWITCH_BUILDER_PATH : null;
  return isSwitchModel(place.deviceModel) ? SWITCH_BUILDER_PATH : null;
}
