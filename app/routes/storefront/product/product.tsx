/**
 * /p/:slug — the product page (design v2.1 "Clay & Glass", client note 5: the BEFORE arrangement, rebuilt with the v2.1
 * pieces and v2's features; design v2 spec §6.7; brief §3.7–3.8).
 *
 *   phones (< 768)   the stage as a soft card edge to edge under the header (./components/StageCard: rounded lower
 *                    corners, the platform's ambient light, the whole product with room around it, round clay keys —
 *                    back and share — the counter and the thumbnails in a clay tray); then the breadcrumb bar; the
 *                    brand line («جديد» + the platform's colour line and name); the name in Kufam; the fact line (16px);
 *                    the price block (the price big at the start with the demo mark; the delivery fee note and the
 *                    stock state at the end); the versions as cards with their own prices; المفضلة · قارن; the side
 *                    information as calm notes (payment and the transfer rule, delivery, returns, warranty) and
 *                    «قبل أن تطلب»; «أبرز ما فيه»; then the reading part. The BUY BAR replaces the tab bar at the bottom
 *                    (./components/BuyStrip inside the shell's <TaskBar>, sliding in): the clay quantity tray and the
 *                    glossy red «أضف إلى السلة» — «✓ في السلة» + «عرض السلة (n)» after an add.
 *   768–1023         one column, the stage card inside the page column, the buy bar.
 *   ≥ 1024           5 + 7: the information column at the inline START (breadcrumbs, brand line, name, facts, price,
 *                    versions, the quantity tray + «أضف إلى السلة», المفضلة · قارن · مشاركة, the notes, highlights) and
 *                    the gallery at the inline END, sticky; no bottom bar.
 *   below            about the product and «يعمل مع», the game facts, the specifications beside the store set and the
 *                    box, the device hub row, the reviews slot (real ones only) and the recommendation shelves — each
 *                    section fades up as it arrives (v2.1 G6).
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
import { Fragment, useEffect, useId, useRef, useState } from "react";
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
import { BuyControls } from "~/ui/AddToCartKey";
import { BidiLabel, BidiText } from "~/ui/BidiText";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { cx } from "~/ui/cx";
import { useOnline } from "~/ui/OfflineBanner";
import { PlatformLabel, PlatformLed } from "~/ui/PlatformLed";
import { Reveal } from "~/ui/reveal";
import { Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { SecondaryActions } from "./components/Actions";
import { BuyStrip } from "./components/BuyStrip";
import { About, BeforeYouOrder, boxPhoto, GameFacts, Highlights, InTheBox, Specs } from "./components/Details";
import { paymentMethods, SideNotes } from "./components/Facts";
import { MixedText } from "./components/MixedText";
import { PriceBlock } from "./components/PriceBlock";
import { Reviews } from "./components/Reviews";
import { SetContents } from "./components/SetContents";
import { alternativesPath, CompatibilitySlot, DeviceHubSlot, RecommendationsSlot } from "./components/Slots";
import { StageCard, stageBack, stageGel } from "./components/StageCard";
import { VariantPicker } from "./components/VariantPicker";
import { useProductT } from "./i18n";
import { jsonForScript, productJsonLd } from "./jsonld";
import { factLine, factRow, isLongName, keepTokens, proseWithoutPreorder, withoutPreorder } from "./text";
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
  // width: from 1024 it sits at the inline end and would have to cross the page.
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
  const soon = !variant.orderable && variant.releaseAt !== null;
  const soldOut = !variant.orderable && !soon;
  const digital = isDigital(product);
  const longName = isLongName(product.name);
  const facts = factRow(product.short);
  // sold out: «شاهد بدائل» opens the product's own category, which lists what is in stock first (the page's shelves
  // are mostly add-ons for it, or none at all)
  const alternatives = alternativesPath(product);
  const methods = paymentMethods(layout?.shell?.payments, signedIn);
  const share = productShareImage(product.slug);
  // No connection: the add keys go flat and say why (spec §6.17); the server render always says online. Phones and
  // tablets: the sentence under the price says it (the bar's own line is short); from 1024 the kit says it under the
  // column's key and the sentence under the price gives way (product.css) — one sentence, not two.
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
      <div className="page pp-top">
        {/* The gallery: the card's well grows into this stage (shared element product-image:<id>). First in the reading
            order, as before: on phones it is the top of the page; from 1024 it sits at the inline end. */}
        <div ref={stage} className="pp-gallery">
          <StageCard
            name={product.name}
            // each view names itself by its own description (§7.8: «Nintendo Switch 2 من الأمام…»), not by a kind word
            items={gallery.images.map((image) => ({ image, caption: image.alt || undefined }))}
            sharedName={`product-image:${product.id}`}
            gel={stageGel(product, variant)}
            backTo={stageBack(product)}
            index={index}
            onIndexChange={setIndex}
            pictures={pictures}
            priority
          />
          {gallery.borrowed ? (
            <p className="pp-gallery__note type-xs text-ink-2" aria-live="polite">
              {t("picker.borrowed", { label: gallery.from?.label ?? product.name })}
            </p>
          ) : null}
        </div>

        <div className="pp-info">
          {/* the breadcrumb bar above the product block, at every width (client note 5: "the bar above the name"): on
              phones the kit's one-line trail (up to the category: product.css), from 768 the kit's trail that wraps */}
          <Breadcrumbs items={crumbs} phone className="pp-crumbs md:hidden" />
          <Breadcrumbs items={crumbs} jsonLd={origin ? { origin } : undefined} className="pp-crumbs" />

          <div className="pp-head">
            <BrandLine product={product} soon={soon} isNew={Boolean(product.isNew) && variant.orderable} />
            {/* protected tokens never break («Switch 2», «Z-A»: text.ts keepTokens, v2 §4.18); a name of three lines and
                more is set one step down on phones (text.ts isLongName) */}
            <h1 className={cx("type-h1 text-ink", longName && "max-md:type-h2")} data-long-name={longName ? "" : undefined}>
              <BidiText text={keepTokens(product.name)} />
            </h1>
            {/* the fact line in reading size (G7): at most two facts of the research's short line (text.ts factRow), as
                running text — the « · » keeps to the fact before it, so a second line never starts with it; a list of
                contents is drawn as its whole « + » parts, two lines of them on a phone (all from 768) */}
            {facts.facts.length > 0 ? (
              <p className={cx("pp-facts", facts.parts && "pp-facts--parts")} data-facts-line="">
                {facts.facts.map((fact, index) =>
                  facts.parts ? (
                    <span key={index}>
                      {index > 0 ? "+ " : null}
                      <MixedText text={fact} />
                    </span>
                  ) : (
                    <Fragment key={index}>
                      {index > 0 ? " · " : null}
                      <MixedText text={fact} />
                    </Fragment>
                  ),
                )}
              </p>
            ) : null}
          </div>

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

          {product.variants.length > 1 ? <VariantPicker variants={product.variants} selector={product.selector} value={variant.id} onChange={choose} className="pp-versions" /> : null}

          {/* ≥ 1024: the quantity tray and «أضف إلى السلة» in the column (phones and tablets: the buy bar). Coming soon: no
              key at all. */}
          {soon ? null : (
            <div className="pp-buy hidden lg:grid lg:gap-2">
              {/* offline, the kit's own line under the key describes it (the sentence under the price is hidden here) */}
              <BuyControls {...buy} aria-describedby={variant.orderable ? undefined : reasonId} />
              {soldOut ? (
                <TextLink as={LocaleLink} to={alternatives} className="justify-self-start">
                  {shop("add.alternatives")}
                </TextLink>
              ) : null}
            </div>
          )}

          <SecondaryActions product={{ id: product.id, kind: product.kind, name: product.name, image: gallery.images[0] ?? null }} wished={wished} shareFrom="lg" />

          <SideNotes
            delivery={product.delivery}
            methods={methods}
            returnsWindowDays={product.returnsWindowDays}
            makerWarranty={product.makerWarranty}
            storeWarrantyMonths={product.storeWarrantyMonths}
            digital={digital}
          />
          <BeforeYouOrder text={proseWithoutPreorder(product.notes)} />
          <Highlights items={withoutPreorder(product.highlights)} className="pp-highlights" />
        </div>
      </div>

      {/* Phones and tablets: the buy bar in place of the tab bar (one bar per edge) — inside the shell's <TaskBar> (the
          glass, the named region, the persisted name and the measured height that becomes --shell-bottom); it slides in
          with the page. Fixed on screen, it sits here in the reading order — right after the buy column, before the long
          reading part. A new version starts afresh. */}
      <TaskBar aria-label={t("bar.label", { name: product.name })} className="pp-buybar lg:hidden">
        <BuyStrip key={variant.id} {...buy} priceIqd={variant.priceIqd} releaseAt={soon ? variant.releaseAt : null} alternativesHref={localePath(alternatives, locale)} />
      </TaskBar>

      {/* The reading part: what it is, what it works with, what it is made of, what is in the box; sections fade up as
          they arrive (below the fold only — the engine leaves what is on screen alone). */}
      <div className="page pp-read">
        <Reveal className="pp-duo">
          <About text={proseWithoutPreorder(product.description)} />
          <CompatibilitySlot rows={compatibility} />
        </Reveal>
        {product.game ? (
          <Reveal>
            <GameFacts game={product.game} ageRating={product.ageRating} className="max-w-[48rem]" />
          </Reveal>
        ) : null}
        <Reveal className="pp-duo">
          <Specs specs={product.specs} variant={variant} sources={product.sources} brand={product.brand} />
          <div className="grid content-start gap-(--gap-row)">
            {variant.bundle ? <SetContents components={variant.bundle} /> : null}
            <InTheBox items={withoutPreorder(product.inTheBox)} image={boxPhoto(product.images)} />
          </div>
        </Reveal>
        <DeviceHubSlot device={device} className="max-w-[40rem]" />
        <Reviews summary={reviews} />
        <RecommendationsSlot key={product.id} result={recommendations} />
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

/**
 * The brand line right above the name (client note 5: "the bar above the name is much better"): «جديد» (only
 * `product.isNew`) or «قريباً», then each platform's colour line and name — the before's LED, the kit's
 * `<PlatformLabel bar>` — or, for a product of no platform, its brand beside a neutral line.
 */
function BrandLine({ product, soon, isNew }: { product: Pick<ProductDetail, "platform" | "forPlatforms" | "brand">; soon: boolean; isNew: boolean }) {
  const platforms = (product.platform ? [product.platform] : product.forPlatforms).slice(0, 2);
  const tag = soon ? <Tag kind="soon" /> : isNew ? <Tag kind="new" /> : null;
  if (!tag && platforms.length === 0 && !product.brand) return null;
  return (
    <p className="pp-brand" data-kind-line="">
      {tag}
      {platforms.length > 0
        ? platforms.map((platform) =>
            platform.gel ? (
              <PlatformLabel key={platform.slug} platform={platform.gel} bar />
            ) : (
              <span key={platform.slug} className="plat">
                <PlatformLed bar />
                <BidiLabel>{platform.name}</BidiLabel>
              </span>
            ),
          )
        : product.brand ? (
            <span className="plat">
              <PlatformLed bar />
              <BidiLabel>{product.brand}</BidiLabel>
            </span>
          ) : null}
    </p>
  );
}
