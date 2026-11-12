/**
 * Server-only reads of the device hub's loader that are not the hub itself (services/devices.server → getDeviceHub).
 *
 *   const from = fromPriceOf(db, ctx.locale, hub, ctx.now);     // streamed: Promise<number | null>
 *
 * The head's «من 756,500 د.ع» is the cheapest version of THIS device a shopper can order now (v2 §6.6). A card carries
 * only its default version's price, so an edition with several versions is read through the catalogue's product read
 * layer (services/catalog/product.server → getProductDetail: every version's price and whether the cart accepts it
 * now), and only the hub's own versions count (DeviceHub.versions — one product may cover two models). Null when
 * nothing of this device can be ordered now. The loader streams the answer as a `FromOutcome` (format.ts) — a failed
 * read is `{ failed: true }`, which the head shows as no price at all, never a guess.
 * Requested of the devices service owner: a `fromIqd` on DeviceHub, which would make these reads unnecessary.
 */
import type { Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import type { DeviceHub } from "~/server/services/devices.server";
import { cheapestOrderable, type VersionOffer } from "./components/format";

export async function fromPriceOf(db: Db, locale: Locale, hub: Pick<DeviceHub, "editions" | "versions">, now: number): Promise<number | null> {
  const several = hub.editions.filter((edition) => edition.hasVariants);
  const details = await Promise.all(several.map((edition) => getProductDetail(db, locale, edition.slug, { now, related: false })));
  const offers = new Map<string, VersionOffer[]>();
  details.forEach((detail, index) => {
    const edition = several[index];
    if (detail && edition) offers.set(edition.slug, detail.variants.map((variant) => ({ variantId: variant.id, priceIqd: variant.priceIqd, orderable: variant.orderable })));
  });
  return cheapestOrderable(hub.editions, offers, new Set(hub.versions.map((version) => version.variantId)));
}
