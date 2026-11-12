/**
 * /p/:slug — the product page (design v2 spec §6.7; brief §3.7–3.8).
 *
 *   phones (< 768)   the stage full bleed and square (1:1) under the header, its thumbnails below it; then the buy box:
 *                    platform and kind · h1 · one fact line · price + demo tag · stock and delivery · the payment
 *                    sentence · the versions (each with its own price) · المفضلة · قارن · مشاركة · the facts card ·
 *                    «قبل أن تطلب»; then the reading part. The BUY BAR replaces the tab bar at the bottom (the kit's
 *                    <BuyBar bare> inside the shell's <TaskBar>): price and version at the start, «أضف إلى السلة» at
 *                    the end — «✓ في السلة» + «عرض السلة (n)» after an add.
 *   768–1023         one column, the stage 4:3 with --r-xl, the buy bar.
 *   ≥ 1024           7 + 5: the gallery sticky at the inline START, the buy box at the inline end with the buy controls
 *                    (stepper + «أضف إلى السلة») after the versions; no bottom bar. The breadcrumbs above both.
 *
 * Data: getProductDetail (variants with stock STATES, release dates, pictures, specs, game facts, store-set contents,
 * warranty and delivery facts) and getReviewSummary (approved verified-purchase reviews only — nothing shows until
 * real ones exist). The payment switches come from settings (the layout's shell data); the TamTam wallet is named only
 * to a signed-in shopper. The chosen variant is `?v=<sku>` (./useVariant: without it the page opens on the default
 * version, or on the first orderable one when the default is sold out). Unknown, unpublished or variant-less slugs
 * answer 404 inside the shell; a slug in other letter case redirects to the canonical one.
 *
 * Cross-area pieces (./components/Slots): "يعمل مع" from the devices area's getCompatibilityForProduct; the device hub
 * row link for a product that IS a device; the devices area's compatibility-checked recommendation shelves (streamed —
 * «أكمل تجهيزك», alternatives); the heart's starting state from the account area's wishlist; the catalog's compare
 * key. Once the page is on screen, and only with consent, the "view" signal goes to /api/events and the view to the
 * shopper's ONE recently-viewed list (home/personal → recordProductView).
 */
import { useEffect, useId, useRef, useState } from "react";
import { data, redirect, useRouteLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/product";
import { productShareImage } from "~/art";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import { makeT, type MessageTree } from "~/i18n/translate";
import { DEFAULT_LOCALE, isLocale, localePath, type Locale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { kindLabelOf } from "~/server/services/catalog/card-facts";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { galleryFor, type ProductDetail } from "~/server/services/catalog/product-types";
import { getCompatibilityForProduct } from "~/server/services/compatibility.server";
import { getDeviceLink } from "~/server/services/devices.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { getReviewSummary } from "~/server/services/reviews.server";
import { wishedAmong, wishlistWho } from "~/server/services/wishlist.server";
import { redirectIfMoved } from "~/routes/storefront/content/redirect.server";
import { sendRecommendationEvent } from "~/routes/storefront/devices/components/signals";
import { readConsent, recordProductView } from "~/routes/storefront/home/personal";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellData, ShellHandle } from "~/routes/storefront/shell/types";
import { BuyBar, BuyControls } from "~/ui/AddToCartKey";
import { BidiText } from "~/ui/BidiText";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { cx } from "~/ui/cx";
import { Gallery } from "~/ui/Gallery";
import { useOnline } from "~/ui/OfflineBanner";
import { PlatformLabel } from "~/ui/PlatformLed";
import { Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { SecondaryActions } from "./components/Actions";
import { About, BeforeYouOrder, boxPhoto, GameFacts, Highlights, InTheBox, Specs } from "./components/Details";
import { FactsCard, PaymentLine, paymentMethods } from "./components/Facts";
import { MixedText } from "./components/MixedText";
import { PriceBlock } from "./components/PriceBlock";
import { Reviews } from "./components/Reviews";
import { SetContents } from "./components/SetContents";
import { alternativesPath, CompatibilitySlot, DeviceHubSlot, RecommendationsSlot } from "./components/Slots";
import { VariantPicker } from "./components/VariantPicker";
import { useProductT } from "./i18n";
import { jsonForScript, productJsonLd } from "./jsonld";
import { factLine, factRow, proseWithoutPreorder, withoutPreorder } from "./text";
import { onlyVariantChanged, useVariantInUrl } from "./useVariant";

import "./product.css";

export async function loader({ params, context, request, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  // The related products come as the devices area's compatibility-checked shelves below, not as the raw links.
  const [product, session] = await Promise.all([getProductDetail(db, ctx.locale, params.slug, { now: ctx.now, related: false }), getCustomer(ctx, db)]);
  if (!product) {
    // A product whose address staff redirected in the content module (admin 17.04) goes there (same-site only).
    await redirectIfMoved(db, url, ctx);
    // A missing product (spec §6.16): the shell's 404 panel — `what` and `query` (the slug as words) let it say «هذا
    // المنتج لم يعد متوفراً أو تغيّر رابطه» and prefill its search.
    throw data({ error: "not_found", what: "product", query: params.slug.replace(/[-_]+/g, " ").trim().slice(0, 80) }, { status: 404 });
  }
  if (product.slug !== params.slug) {
    // "/p/DualSense" → "/p/dualsense": one address per product (the chosen variant travels along).
    const v = new URL(request.url).searchParams.get("v");
    throw redirect(`${localePath(`/p/${product.slug}`, ctx.locale)}${v ? `?v=${encodeURIComponent(v)}` : ""}`, 301);
  }
  const customerId = session?.customer.id ?? null;
  const [reviews, compatibility, wished, device] = await Promise.all([
    getReviewSummary(db, product.id),
    getCompatibilityForProduct(db, ctx.locale, product.id),
    wishedAmong(db, wishlistWho(ctx.cookie, customerId), [product.id]),
    getDeviceLink(db, ctx.locale, product.deviceModel?.slug),
  ]);
  return {
    product,
    reviews,
    compatibility,
    wished: wished.has(product.id),
    device,
    // streamed, never awaited: the page does not wait for its suggestions (the promise never rejects)
    recommendations: recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale: ctx.locale, context: "product", productId: product.id, now: ctx.now }, 8),
    storeMode: ctx.storeMode,
    // "catalog" for the compare key (CompareToggle reads its own namespace)
    i18n: messagesFor(ctx.locale, "product", "catalog"),
  };
}

/** The product page has its own bottom bar (the buy bar): the tab bar gives way (one bar per edge, spec §5.1). */
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
    description: product.seo.description ?? clip(proseWithoutPreorder(product.description) ?? factLine(product.short) ?? fallback),
    image: productShareImage(product.slug)?.src ?? null,
    type: "product",
    noindex: product.seo.noindex,
  });
};

type LayoutData = { shell?: Pick<ShellData, "publicOrigin" | "payments"> };

/** A digital code (gift card, subscription): its own facts, no delivery fee (spec §6.7 states, §13 row 11). Pure. */
export const isDigital = (product: Pick<ProductDetail, "kind" | "mediaFormat">) => product.kind === "digital" || product.mediaFormat === "digital";

export default function ProductPage({ loaderData }: Route.ComponentProps) {
  const { product, reviews, storeMode, compatibility, wished, device, recommendations } = loaderData;
  const t = useProductT();
  const shop = useT("ui-shop");
  const locale = useLocale();
  const online = useOnline();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const root = useRouteLoaderData("root") as { origin?: string; customer?: { id: string } | null } | undefined;
  const origin = layout?.shell?.publicOrigin || root?.origin || "";
  const signedIn = Boolean(root?.customer);

  // The page is on screen: the "view" signal and the recently-viewed entry — only with consent, once per product
  // (a change of variant is the same product). Prefetching a card's link never runs this: nothing is counted on hover.
  // Consent is this device's answer as it is NOW (the cookie — root data can be a visit behind an answer just given);
  // the server checks again (the account's answer wins there).
  useEffect(() => {
    if (readConsent() !== true) return;
    sendRecommendationEvent({ kind: "view", productId: product.id, source: "pdp" });
    recordProductView(product.id, { signedIn });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per product shown (sign-in is read as it is then)
  }, [product.id]);

  const { variant, choose } = useVariantInUrl(product);
  const gallery = galleryFor(product, variant);
  const stage = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const offlineId = useId();

  // The gallery stays put while the language changes (docs/MOTION.md "anchors") — below 1024 only, where it is full
  // width: from 1024 it sits at the inline start and would have to cross the page.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const narrow = window.matchMedia("(max-width: 63.99rem)");
    const apply = () => element.toggleAttribute("data-motion-anchor", narrow.matches);
    apply();
    narrow.addEventListener("change", apply);
    return () => narrow.removeEventListener("change", apply);
  }, []);

  // A new set of pictures (another colour) starts at its first one.
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
  const platforms = (product.platform ? [product.platform] : product.forPlatforms).slice(0, 2);
  const soon = !variant.orderable && variant.releaseAt !== null;
  const soldOut = !variant.orderable && !soon;
  const digital = isDigital(product);
  const facts = factRow(product.short);
  // sold out: «شاهد بدائل» opens the product's own category, which lists what is in stock first (the page's shelves
  // are mostly add-ons for it, or none at all)
  const alternatives = alternativesPath(product);
  const methods = paymentMethods(layout?.shell?.payments, signedIn);
  const share = productShareImage(product.slug);
  // No connection: the add keys go flat and say why (spec §6.17); the server render always says online.
  const offline = !online && variant.orderable;
  const describedBy = offline ? offlineId : variant.orderable ? undefined : reasonId;

  const buy = {
    item: { variantId: variant.id },
    name: product.name,
    stock: variant.orderable ? variant.stock : soon ? ("preorder" as const) : ("out_of_stock" as const),
    image: gallery.images[0] ?? null,
    optionsLabel: product.variants.length > 1 ? variant.label : null,
    source: () => stage.current?.querySelector(".stage__slot img") ?? stage.current,
    disabled: offline,
    "aria-describedby": describedBy,
  };

  return (
    <div className="pp" data-product={product.id} data-variant={variant.sku}>
      {/* Phones: tight steps between the head blocks, so the price, the demo tag and the stock-and-delivery line sit above
          the buy bar on first load (spec §6.7 target, y ≤ 760 at 390×844) for names up to two lines. */}
      <div className="page grid gap-x-8 gap-y-3 md:gap-y-5 lg:grid-cols-12 lg:items-start lg:gap-y-6 2xl:gap-x-12">
        <Breadcrumbs items={crumbs} jsonLd={origin ? { origin } : undefined} className="lg:col-span-12" />

        {/* The gallery: the card's well grows into this stage (shared element product-image:<id>). */}
        <div ref={stage} className="pp-gallery min-w-0 lg:col-span-7">
          <Gallery
            name={product.name}
            // each view names itself by its own description (§7.8: «Nintendo Switch 2 من الأمام…»), not by a kind word
            items={gallery.images.map((image) => ({ image, caption: image.alt || undefined }))}
            sharedName={`product-image:${product.id}`}
            index={index}
            onIndexChange={setIndex}
            priority
          />
          {gallery.borrowed ? (
            <p className="mt-2 type-xs text-ink-2" aria-live="polite">
              {t("picker.borrowed", { label: gallery.from?.label ?? product.name })}
            </p>
          ) : null}
        </div>

        <div className="pp-buy grid min-w-0 content-start gap-3 md:gap-5 lg:col-span-5">
          <div className="grid gap-1 md:gap-2">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-xs-strong text-ink-2" data-kind-line="">
              {soon ? <Tag kind="soon" /> : product.isNew && variant.orderable ? <Tag kind="new" /> : null}
              {platforms.map((platform) =>
                platform.gel ? (
                  <PlatformLabel key={platform.slug} platform={platform.gel} />
                ) : (
                  <span key={platform.slug} className="plat">
                    <bdi>{platform.name}</bdi>
                  </span>
                ),
              )}
              {platforms.length > 0 ? <span aria-hidden="true">·</span> : null}
              <span>{product.kindLabel ?? kindLabelOf({ kind: product.kind, families: [] }, locale)}</span>
            </p>
            <h1 className="type-h1 text-ink">
              <BidiText text={product.name} />
            </h1>
            {/* ONE fact line (§6.7 item 5): the second fact shows only when it fits beside the first (.pp-facts); a first
                fact longer than a phone line is shown alone and wraps (text.ts factRow) */}
            {facts.facts.length > 0 ? (
              <p className={cx("pp-facts type-sm text-ink-2", facts.wrap && "pp-facts--wrap")} data-facts-line="">
                {facts.facts.map((fact, index) => (
                  <span key={index}>
                    {index > 0 ? "· " : null}
                    <MixedText text={fact} />
                  </span>
                ))}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3">
            <PriceBlock
              variant={variant}
              variants={product.variants}
              delivery={product.delivery}
              lifecycle={product.lifecycle}
              isDemo={product.isDemo}
              digital={digital}
              reasonId={reasonId}
              offline={offline}
              offlineId={offlineId}
            />
            <PaymentLine methods={methods} />
          </div>

          {product.variants.length > 1 ? <VariantPicker variants={product.variants} selector={product.selector} value={variant.id} onChange={choose} /> : null}

          {/* ≥ 1024: the buy controls in the buy box (phones and tablets: the buy bar). Coming soon: no key at all. */}
          {soon ? null : (
            <div className="hidden lg:grid lg:gap-2">
              <BuyControls {...buy} />
              {soldOut ? (
                <TextLink as={LocaleLink} to={alternatives} className="justify-self-start">
                  {shop("add.alternatives")}
                </TextLink>
              ) : null}
            </div>
          )}

          <SecondaryActions product={{ id: product.id, kind: product.kind, name: product.name, image: gallery.images[0] ?? null }} wished={wished} />

          <FactsCard
            delivery={product.delivery}
            methods={methods}
            returnsWindowDays={product.returnsWindowDays}
            makerWarranty={product.makerWarranty}
            storeWarrantyMonths={product.storeWarrantyMonths}
            digital={digital}
          />
          <BeforeYouOrder text={proseWithoutPreorder(product.notes)} />
        </div>
      </div>

      {/* Phones and tablets: the buy bar in place of the tab bar (one bar per edge) — the kit's bar, bare, inside the
          shell's <TaskBar> (the glass, the named region, the persisted name and the measured height that becomes
          --shell-bottom). Fixed on screen, it sits here in the reading order — right after the buy box, before the long
          reading part. A failed add and «لا يوجد اتصال» take the bar's own info line; a new version starts afresh. */}
      <TaskBar aria-label={t("bar.label", { name: product.name })} className="lg:hidden">
        <BuyBar key={variant.id} {...buy} bare priceIqd={variant.priceIqd} releaseAt={soon ? variant.releaseAt : null} alternativesHref={localePath(alternatives, locale)} />
      </TaskBar>

      {/* The reading part: what it is, what it works with, what it is made of, what is in the box. */}
      <div className="page mt-(--gap-section) grid gap-(--gap-section)">
        <div className="pp-duo">
          <div className="grid content-start gap-(--gap-row)">
            <Highlights items={withoutPreorder(product.highlights)} />
            <About text={proseWithoutPreorder(product.description)} />
          </div>
          <CompatibilitySlot rows={compatibility} />
        </div>
        {product.game ? <GameFacts game={product.game} ageRating={product.ageRating} className="max-w-[48rem]" /> : null}
        <div className="pp-duo">
          <Specs specs={product.specs} variant={variant} sources={product.sources} brand={product.brand} />
          <div className="grid content-start gap-(--gap-row)">
            {variant.bundle ? <SetContents components={variant.bundle} /> : null}
            <InTheBox items={withoutPreorder(product.inTheBox)} image={boxPhoto(product.images)} />
          </div>
        </div>
        <DeviceHubSlot device={device} className="max-w-[40rem]" />
        <RecommendationsSlot key={product.id} result={recommendations} />
        <Reviews summary={reviews} />
      </div>

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
