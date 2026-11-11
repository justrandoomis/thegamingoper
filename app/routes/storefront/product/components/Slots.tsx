/**
 * The cross-area pieces of the product page, wired by the integration pass (docs/CONTRACTS.md §3, docs/areas/product.md
 * "Integration slots"). The loader reads them; these components only draw:
 *
 *   <CompatibilitySlot rows />          devices area: getCompatibilityForProduct(db, locale, productId) — every device a
 *                                       rule speaks about, plus an explicit "not checked" for the other consoles of the
 *                                       product's platforms. Each row is ~/ui/CompatBadge (icon AND words; "unverified"
 *                                       is a real answer) and a link to the device's hub when it has one.
 *   <DeviceHubSlot device />            devices area: the "everything about this device" row link for a product that IS
 *                                       a device (getDeviceLink — null when the model has no hub). Its picture grows
 *                                       into the hub's stage (shared element device-image:<slug>).
 *   <RecommendationsSlot result />      devices area: getRecommendations(context "product") through recommendationsFor,
 *                                       streamed by the loader — compatibility-checked, stock-aware shelves with their
 *                                       honest reason lines ("complete your setup", the store's links that fit, real
 *                                       "bought together" only past its threshold, alternatives). They replace the
 *                                       page's own unchecked editorial shelves.
 *   wished (product.tsx)                account area: wishedAmong(db, wishlistWho(cookie, customerId), [id]) →
 *                                       <WishlistKey initial={wished} />.
 */
import { useId } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import type { CompatibilityStatus } from "~/lib/dto";
import type { ProductCompatibility } from "~/server/services/compatibility.server";
import type { DeviceLink } from "~/server/services/devices.server";
import { CompatBadge } from "~/ui/CompatBadge";
import { Disclosure } from "~/ui/Disclosure";
import { DeviceHubLink } from "~/routes/storefront/devices/components/DeviceHubLink";
import { RecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";
import { useProductT } from "../i18n";

/** How many rows show before "show the other devices" (the rest stay one press away). */
const VISIBLE_ROWS = 6;
/** Stated answers first: what works, what works in part, what does not; "not checked" last. */
const STATUS_ORDER: Record<CompatibilityStatus, number> = { verified: 0, partial: 1, incompatible: 2, unverified: 3 };

function CompatRow({ row }: { row: ProductCompatibility }) {
  const badge = <CompatBadge status={row.status} device={row.deviceName} note={row.note} className="min-w-0" />;
  if (!row.hasHub) return <li className="py-1.5">{badge}</li>;
  return (
    <li>
      <LocaleLink to={`/device/${row.deviceSlug}`} className="group flex min-h-11 items-center justify-between gap-3 rounded-md py-1.5 no-underline">
        <span className="min-w-0 group-hover:underline group-hover:underline-offset-4">{badge}</span>
        <Icon name="arrow-right" size={16} className="shrink-0 text-ink-2" />
      </LocaleLink>
    </li>
  );
}

/** "يعمل مع" — the product's compatibility as stated facts (nothing renders when no rule and no platform speaks). */
export function CompatibilitySlot({ rows }: { rows: readonly ProductCompatibility[] }) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  if (rows.length === 0) return null;
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index)
    .map((entry) => entry.row);
  // Show everything when only one or two would be folded away: a fold must save more than it costs.
  const cut = ordered.length > VISIBLE_ROWS + 2 ? VISIBLE_ROWS : ordered.length;
  const shown = ordered.slice(0, cut);
  const rest = ordered.slice(cut);
  return (
    <section aria-labelledby={id} className="grid gap-2" data-compat-section="">
      <div className="grid gap-0.5">
        <h2 id={id} className="type-sub text-ink">
          {t("compat.title")}
        </h2>
        <p className="type-caption text-ink-2">{t("compat.reason")}</p>
      </div>
      <ul className="grid">
        {shown.map((row) => (
          <CompatRow key={row.deviceSlug} row={row} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <Disclosure summary={t("compat.more", { n: f.number(rest.length) })}>
          <ul className="grid">
            {rest.map((row) => (
              <CompatRow key={row.deviceSlug} row={row} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

/** The hub of the device this product IS (devices area owns /device/:model). */
export function DeviceHubSlot({ device }: { device: DeviceLink | null }) {
  const t = useProductT();
  if (!device) return null;
  return <DeviceHubLink device={device} title={t("hub.title", { device: device.name })} text={t("hub.text")} className="max-w-[40rem]" />;
}

/** "يكمّل جهازك" and the other compatibility-checked shelves (devices area), streamed after the page. */
export function RecommendationsSlot({ result }: { result: Promise<RecommendationResult> | RecommendationResult | null }) {
  return <RecommendationShelves result={result} source="product" />;
}
