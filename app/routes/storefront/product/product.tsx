/**
 * /p/:slug — the product page (brief §3.7–3.8; DESIGN.md §8.4 phone, §8.10 desktop, §8.11 tablet, §9.6 gallery).
 *
 *   phones (< 768)   the Lit Stage edge to edge under the header (back / cart orbs on it), then the info on the floor,
 *                    the buy bar pinned to the bottom edge in place of the tab bar (handle + <TaskBar>)
 *   768–1023         the same with the stage inside the page column
 *   ≥ 1024           7 + 5: the stage sticky at the inline end, the info column at the start with the buy controls in
 *                    it (no bottom bar); from 1200 the header's cart orb is the flight target
 *
 * Data: getProductDetail (variants with stock STATES, release dates, pictures, specs, game facts, store-set contents,
 * related products, warranty and delivery facts) and getReviewSummary (approved verified-purchase reviews only).
 * The chosen variant is `?v=<sku>` (./useVariant). Unknown, unpublished or variant-less slugs answer 404 inside the
 * shell; a slug in other letter case redirects to the canonical one.
 *
 * Cross-area pieces (compatibility, recommendation shelves, the device hub link, the wishlist state) are slots in
 * ./components/Slots — filled by the integration pass, empty until then.
 */
import { useId, useRef, useState } from "react";
import { data, redirect, useRouteLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/product";
import { productShareImage } from "~/art";
import { messagesFor } from "~/i18n/i18n.server";
import { useLocale } from "~/i18n/react";
import { makeT, type MessageTree } from "~/i18n/translate";
import { DEFAULT_LOCALE, isLocale, localePath, type Locale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { galleryFor } from "~/server/services/catalog/product-types";
import { getReviewSummary } from "~/server/services/reviews.server";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { BuyControls } from "~/ui/AddToCartKey";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { Gallery } from "~/ui/Gallery";
import { PlatformLabel } from "~/ui/PlatformLed";
import { BidiText } from "~/ui/ProductCard";
import { Tag } from "~/ui/Tag";
import { WishlistKey } from "~/ui/WishlistKey";
import { Credits, GameFacts, Highlights, InTheBox, Notes, Section, Specs, VariantNote } from "./components/Details";
import { MixedText } from "./components/MixedText";
import { SetContents } from "./components/SetContents";
import { Facts } from "./components/Facts";
import { PriceBlock } from "./components/PriceBlock";
import { RelatedShelves } from "./components/Related";
import { Reviews } from "./components/Reviews";
import { CompatibilitySlot, DeviceHubSlot, RecommendationsSlot } from "./components/Slots";
import { StageOrbs } from "./components/StageOrbs";
import { VariantPicker } from "./components/VariantPicker";
import { useProductT } from "./i18n";
import { jsonForScript, productJsonLd } from "./jsonld";
import { onlyVariantChanged, useVariantInUrl } from "./useVariant";

import "./product.css";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const product = await getProductDetail(db, ctx.locale, params.slug, {
    now: ctx.now,
  });
  if (!product) throw data({ error: "not_found" }, { status: 404 });
  if (product.slug !== params.slug) {
    // "/p/DualSense" → "/p/dualsense": one address per product (the chosen variant travels along).
    const v = new URL(request.url).searchParams.get("v");
    throw redirect(`${localePath(`/p/${product.slug}`, ctx.locale)}${v ? `?v=${encodeURIComponent(v)}` : ""}`, 301);
  }
  const reviews = await getReviewSummary(db, product.id);
  return {
    product,
    reviews,
    storeMode: ctx.storeMode,
    i18n: messagesFor(ctx.locale, "product"),
  };
}

/** The product page has its own bottom bar (the buy bar): the tab bar gives way (DESIGN.md §8 sticky rule). */
export const handle = { shell: { tabBar: false } } satisfies ShellHandle;

/** A change of `?v=` only is a choice on this page — every variant is already here, so the loader is not asked again. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && onlyVariantChanged(currentUrl.searchParams, nextUrl.searchParams)) return false;
  return defaultShouldRevalidate;
}

/** About 160 characters, cut at a word. */
function clip(value: string, max = 160): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).trim()}…`;
}

export const meta: Route.MetaFunction = (args) => {
  const loaderData = args.loaderData;
  if (!loaderData) return shellMeta(args);
  const { product } = loaderData;
  const rootLocale = (args.matches.find((match) => match?.id === "root")?.loaderData as { locale?: string } | undefined)?.locale;
  const locale: Locale = isLocale(rootLocale) ? rootLocale : DEFAULT_LOCALE;
  const t = makeT(loaderData.i18n.product as MessageTree, locale, "product");
  const fallback = t("meta.description", {
    name: product.name,
    fee: formatMoney(product.delivery.flatFeeIqd, "IQD", locale),
  });
  return shellMeta(args, {
    title: product.seo.title ?? product.name,
    description: product.seo.description ?? clip(product.description ?? product.short ?? fallback),
    image: productShareImage(product.slug)?.src ?? null,
    type: "product",
    noindex: product.seo.noindex,
  });
};

type OriginData = { shell?: { publicOrigin?: string } };

export default function ProductPage({ loaderData }: Route.ComponentProps) {
  const { product, reviews, storeMode } = loaderData;
  const t = useProductT();
  const locale = useLocale();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as OriginData | undefined;
  const root = useRouteLoaderData("root") as { origin?: string } | undefined;
  const origin = layout?.shell?.publicOrigin || root?.origin || "";

  const { variant, choose } = useVariantInUrl(product);
  const gallery = galleryFor(product, variant);
  const stage = useRef<HTMLDivElement>(null);
  const reasonId = useId();

  // A new set of pictures (another colour) starts at its first one; the picture swaps with the stage's inflate.
  const pictures = gallery.images.map((image) => image.artKey ?? image.mediaKey).join("|");
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(pictures);
  if (pictures !== shown) {
    setShown(pictures);
    setIndex(0);
  }

  const crumbs = [
    { label: t("crumbs.home"), href: "/" },
    ...product.categories.map((category) => ({
      label: category.name,
      href: `/c/${category.slug}`,
    })),
    { label: product.name },
  ];
  const backTo = product.categories.length > 0 ? `/c/${product.categories[product.categories.length - 1].slug}` : "/";
  const platforms = product.platform ? [product.platform] : product.forPlatforms;
  const comingSoon = variant.releaseAt !== null || product.releaseAt !== null;
  const share = productShareImage(product.slug);

  const buy = {
    item: { variantId: variant.id },
    name: product.name,
    stock: variant.orderable ? variant.stock : ("out_of_stock" as const),
    image: gallery.images[0] ?? null,
    optionsLabel: product.variants.length > 1 ? variant.label : null,
    source: () => stage.current?.querySelector(".stage__slot img") ?? stage.current,
    "aria-describedby": variant.orderable ? undefined : reasonId,
  };

  return (
    <div className="pp" data-product={product.id} data-variant={variant.sku}>
      <div className="page grid gap-x-10 gap-y-6 lg:grid-cols-12 lg:items-start lg:pt-6">
        {/* The stage: the card's niche grown into it (shared element product-image:<id>), lit by the variant's platform. */}
        <div ref={stage} className="pp-stage min-w-0 lg:sticky lg:col-span-7 lg:col-start-6 lg:row-start-1">
          <Gallery
            name={product.name}
            items={gallery.images.map((image) => ({ image }))}
            gel={variant.gel}
            sharedName={`product-image:${product.id}`}
            index={index}
            onIndexChange={setIndex}
            priority
            flush
            top={<StageOrbs backTo={backTo} className="xl:hidden" />}
          />
          {gallery.borrowed ? (
            <p className="gutter mt-2 type-caption text-ink-2 md:px-1" aria-live="polite">
              {t("picker.borrowed", {
                label: gallery.from?.label ?? product.name,
              })}
            </p>
          ) : null}
        </div>

        <div className="grid min-w-0 content-start gap-6 lg:col-span-5 lg:col-start-1 lg:row-start-1">
          <Breadcrumbs items={crumbs} jsonLd={origin ? { origin } : undefined} />
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {comingSoon ? <Tag kind="preorder">{t("tagSoon")}</Tag> : <Tag kind="new" />}
              {platforms.map((platform) =>
                platform.gel ? (
                  <PlatformLabel key={platform.slug} platform={platform.gel} />
                ) : (
                  <span key={platform.slug} className="plat">
                    <bdi>{platform.name}</bdi>
                  </span>
                ),
              )}
            </div>
            <div className="flex items-start justify-between gap-3">
              <h1 className="min-w-0 type-title text-ink">
                <BidiText text={product.name} />
              </h1>
              {/* Integration: initial={wished} from the account area's getWishlistIds (Slots.tsx). */}
              <WishlistKey productId={product.id} name={product.name} className="shrink-0" />
            </div>
            {product.short ? (
              <p className="type-body text-ink-2">
                <MixedText text={product.short} />
              </p>
            ) : null}
          </div>

          <PriceBlock
            variant={variant}
            variants={product.variants}
            delivery={product.delivery}
            lifecycle={product.lifecycle}
            isDemo={product.isDemo}
            reasonId={reasonId}
          />

          {product.variants.length > 1 ? (
            <div className="grid gap-2">
              <VariantPicker variants={product.variants} selector={product.selector} value={variant.id} onChange={choose} />
              <VariantNote note={variant.note} />
            </div>
          ) : (
            <VariantNote note={variant.note} />
          )}

          {/* ≥ 1024: the buy controls live in the info column as a flat panel (DESIGN.md §8.10). */}
          <div className="hidden lg:block">
            <BuyControls {...buy} />
          </div>

          <CompatibilitySlot productId={product.id} />
          <Highlights items={product.highlights} />
          {product.game ? <GameFacts game={product.game} ageRating={product.ageRating} /> : null}
          <Facts makerWarranty={product.makerWarranty} storeWarrantyMonths={product.storeWarrantyMonths} returnsWindowDays={product.returnsWindowDays} />
        </div>
      </div>

      <div className="page mt-12 grid gap-12">
        {product.description ? (
          <Section title={t("about")}>
            <p className="max-w-[70ch] type-body text-ink">
              <MixedText text={product.description} />
            </p>
          </Section>
        ) : null}
        <div className="grid gap-12 lg:grid-cols-2">
          <Specs specs={product.specs} variant={variant} />
          <div className="grid content-start gap-12">
            {variant.bundle ? <SetContents components={variant.bundle} /> : null}
            <InTheBox items={product.inTheBox} />
            <Notes text={product.notes} />
          </div>
        </div>
        <DeviceHubSlot deviceModel={product.deviceModel} />
        <RelatedShelves shelves={product.related} />
        <RecommendationsSlot productId={product.id} />
        <Reviews summary={reviews} />
        <Credits credits={product.credits} sources={product.sources} />
      </div>

      {/* Phones and tablets: the buy bar in place of the tab bar (one bar per edge). */}
      <TaskBar aria-label={t("buy.label")} className="lg:hidden">
        <BuyControls {...buy} className="mx-auto max-w-[40rem]" />
      </TaskBar>

      {origin ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonForScript(
              productJsonLd({
                product,
                variant,
                reviews,
                origin,
                locale,
                image: share?.src ?? null,
                storeMode: storeMode === "live" ? "live" : "demo",
              }),
            ),
          }}
        />
      ) : null}
    </div>
  );
}
