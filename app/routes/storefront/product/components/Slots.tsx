/**
 * The cross-area pieces of the product page (docs/CONTRACTS.md §3, docs/areas/product.md "Integration slots"). The
 * loader reads them; these components only draw:
 *
 *   <CompatibilitySlot rows />          devices area: getCompatibilityForProduct(db, locale, productId) — every device a
 *                                       rule speaks about, plus an explicit "not checked" for the other consoles of the
 *                                       product's platforms. Drawn as the kit's CompatList (design v2 G17: a mark, the
 *                                       device, and its STATE WORD — يعمل · يعمل جزئياً · لا يعمل · لم نتحقق — with the
 *                                       rule's note), under today's honest line «من سجلّ التوافق الذي تحقّقنا منه…».
 *   <DeviceHubSlot device />            devices area: the "everything about this device" row link for a product that IS
 *                                       a device (getDeviceLink — null when the model has no hub). Its picture grows
 *                                       into the hub's stage (shared element device-image:<slug>).
 *   <RecommendationsSlot result />      devices area: the compatibility-checked shelves (recommendationsFor, context
 *                                       "product"), streamed by the loader — «أكمل تجهيزك», the store's links that fit,
 *                                       real "bought together" past its threshold, alternatives. They render only with
 *                                       enough items (the kit's ShelfRail hides a shelf under 3).
 *   alternativesPath(product)           where «شاهد بدائل» leads on a sold-out page: the product's own category, which
 *                                       lists what is in stock first. Not the shelves above: on a sold-out page they are
 *                                       mostly add-ons FOR the product («يكمّل PlayStation 5 Slim»), or there are none.
 */
import { useId } from "react";

import { useFormat } from "~/i18n/react";
import type { CompatibilityStatus } from "~/lib/dto";
import type { ProductDetail } from "~/server/services/catalog/product-types";
import type { ProductCompatibility } from "~/server/services/compatibility.server";
import type { DeviceLink } from "~/server/services/devices.server";
import { CompatList } from "~/ui/CompatBadge";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { DeviceHubLink } from "~/routes/storefront/devices/components/DeviceHubLink";
import { deviceIn } from "~/routes/storefront/devices/components/format";
import { RecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";
import { useProductT } from "../i18n";

/** How many rows show before "show the other devices" (the rest stay one press away). */
const VISIBLE_ROWS = 6;
/** Stated answers first: what works, what works in part, what does not; "not checked" last. */
const STATUS_ORDER: Record<CompatibilityStatus, number> = { verified: 0, partial: 1, incompatible: 2, unverified: 3 };

/** The rows in the order they are read, and how many show before the fold (pure; exported for tests). */
export function compatRows(rows: readonly ProductCompatibility[]): { shown: ProductCompatibility[]; rest: ProductCompatibility[] } {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index)
    .map((entry) => entry.row);
  // Show everything when only one or two would be folded away: a fold must save more than it costs.
  const cut = ordered.length > VISIBLE_ROWS + 2 ? VISIBLE_ROWS : ordered.length;
  return { shown: ordered.slice(0, cut), rest: ordered.slice(cut) };
}

/** The kit's rows; a device with a hub links to it (the row's whole width, the kit's CompatList `href`). */
const listRows = (rows: readonly ProductCompatibility[]) => rows.map((row) => ({ status: row.status, device: row.deviceName, note: row.note, href: row.hasHub ? `/device/${row.deviceSlug}` : null }));

/** «يعمل مع» — the product's compatibility as stated facts (nothing renders when no rule and no platform speaks). */
export function CompatibilitySlot({ rows, className }: { rows: readonly ProductCompatibility[]; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  if (rows.length === 0) return null;
  const { shown, rest } = compatRows(rows);
  return (
    <section aria-labelledby={id} className={cx("grid min-w-0 content-start gap-4", className)} data-compat-section="">
      <div className="grid gap-1">
        <h2 id={id} className="type-h2 text-ink">
          {t("compat.title")}
        </h2>
        <p className="type-sm text-ink-2">{t("compat.reason")}</p>
      </div>
      <CompatList rows={listRows(shown)} />
      {rest.length > 0 ? (
        <Disclosure summary={t("compat.more", { n: f.number(rest.length) })}>
          <CompatList rows={listRows(rest)} />
        </Disclosure>
      ) : null}
    </section>
  );
}

/**
 * The hub of the device this product IS (devices area owns /device/:model). The name goes in as the hub itself puts it
 * in a sentence (deviceIn): its Latin runs isolated and its short last word kept with the one before, so «كل شيء عن
 * Nintendo Switch 2» never leaves the «2» alone on a line (v2 §4.18).
 */
export function DeviceHubSlot({ device, className }: { device: DeviceLink | null; className?: string }) {
  const t = useProductT();
  if (!device) return null;
  return <DeviceHubLink device={device} title={t("hub.title", { device: deviceIn(device.name) })} text={t("hub.text")} className={className} />;
}

/** «أكمل تجهيزك» and the other compatibility-checked shelves (devices area), streamed after the page. */
export function RecommendationsSlot({ result }: { result: Promise<RecommendationResult> | RecommendationResult | null }) {
  return <RecommendationShelves result={result} source="product" />;
}

/**
 * «شاهد بدائل» (sold out, spec §6.7): the product's most specific category — its listing puts what is in stock first —
 * else its platform's hub, else the search page. A locale-less path. Pure.
 */
export function alternativesPath(product: Pick<ProductDetail, "categories" | "platform" | "forPlatforms">): string {
  const category = product.categories.at(-1);
  if (category) return `/c/${category.slug}`;
  const platform = product.platform ?? product.forPlatforms[0] ?? null;
  return platform ? `/platform/${platform.slug}` : "/search";
}
