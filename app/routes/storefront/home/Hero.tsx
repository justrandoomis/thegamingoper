/**
 * The home hero — Design System v2 §6.1, §4.18 (the showcase band), §2.10c (light), G2/G15: the crimson band with the
 * featured console (default: the Nintendo platform's lead device, Nintendo Switch 2, until staff pin one — §13 #13).
 *
 *   phones   the platform pill · the headline in two lines («العب على» / «Nintendo Switch 2», the name isolated, one
 *            edge) · the product on the brand light (168px, the page's LCP image) · the price (xl, white) and «سعر
 *            تجريبي» · the on-band key «اشترِ Nintendo Switch 2», full width · «التوصيل 5,000 د.ع لكل المحافظات · الدفع
 *            عند الاستلام». At most 440px tall at 390.
 *   ≥ 768    the copy at the inline start (plus the fact line and «تفاصيل الجهاز» → the device hub), the product at
 *            the inline end on its light (≤ 410px wide); 400px tall at 1024, 420 from 1280. English mirrors by itself.
 *
 * The key: a product with versions opens the product area's quick look on the version choice (the page keeps its URL
 * and scroll; a real link to the product page underneath for a new tab or no script); a product with one version is
 * added at once by the kit's on-band add key (AddToCartKey `look="onBand"`: the flight to the cart, «تراجع», and flat
 * with its reason while offline). The photo is a link into the product page with the card → page zoom
 * (<SharedElement name="product-image:<id>" slot="hero">). Dark theme: the band is a lit cabinet and the same key
 * renders as the red primary (CSS). If the photo fails, the band keeps its size, the copy and the key.
 * The headline steps down the type scale until its longest line fits (./view heroTitleSizes) — never a fluid size.
 *
 * A PINNED hero (staff, content module 17.01): the staff's headline replaces «العب على …» (in the pin's language —
 * Arabic when it has none in the page's — with lang/dir set), and its deck takes the fact line's place.
 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { LOCALES, type Locale } from "~/lib/locales";
import { MotionLink, SharedElement } from "~/motion";
import { AddToCartKey } from "~/ui/AddToCartKey";
import { Band } from "~/ui/Band";
import { BidiText } from "~/ui/BidiText";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { PlatformLed, type Platform } from "~/ui/PlatformLed";
import { fillNodes, iqdText, isIqd, SafePrice } from "~/ui/PriceTag";
import { ProductImage } from "~/ui/ProductCard";
import { TextLink } from "~/ui/TextLink";
import { heroTitleSizes, keepTogether, pictureFailed, splitHeadline } from "./view";

/** The product area's quick look — fetched only when a shopper reaches for the key. */
const loadQuickPreview = () => import("~/routes/storefront/product/QuickPreview");
const QuickPreview = lazy(() => loadQuickPreview().then((module) => ({ default: module.QuickPreview })));
const warmQuickPreview = () => void loadQuickPreview().catch(() => undefined);

/** The longest product name «اشترِ {name}» takes on the full-width phone key (Arabic, 390px) before it would be cut. */
const HERO_KEY_NAME_MAX = 24;

/** How wide the photo is drawn: the 168px phone box (≈ 82vw wide), half the band from 768, ≤ 410px from 1024. */
const HERO_SIZES = "(min-width: 1024px) 410px, (min-width: 768px) 40vw, 82vw";

export type HeroProps = {
  /** The featured product (a buyable console with a photo). */
  card: ProductCardData;
  platform: Platform;
  /** "new": released within the last 120 days («وصل …»); "lead": the platform's lead device («العب على …»). */
  mode: "new" | "lead";
  /** The device hub of the product's model ("/device/switch-2"); the product page when there is none. */
  deviceHref: string | null;
  /** The flat delivery fee from settings; null hides the delivery fact. */
  deliveryFeeIqd: number | null;
  /** Cash on delivery is switched on in the settings. */
  cod: boolean;
  /** The price is a demo value («سعر تجريبي» beside it). */
  demoPrice: boolean;
  /** Staff pinned this product (content module): their headline and deck, and the language they are in. */
  pin?: { headline: string; deck: string | null; textLocale: Locale } | null;
};

export function Hero({ card, platform, mode, deviceHref, deliveryFeeIqd, cod, demoPrice, pin = null }: HeroProps) {
  const t = useT("home");
  const ui = useT("ui");
  const shop = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const headingId = useId();
  const [preview, setPreview] = useState({ mounted: false, open: false });
  const [photoFailed, setPhotoFailed] = useState(false);
  const media = useRef<HTMLDivElement>(null);
  // the server-rendered photo may have failed before the page came to life (no onError then): look once
  useEffect(() => {
    if (pictureFailed(media.current?.querySelector("img"))) setPhotoFailed(true);
  }, []);
  const href = `/p/${card.slug}`;
  const name = keepTogether(card.name);
  const headline = splitHeadline((value) => t(mode === "new" ? "hero.new" : "hero.lead", { name: value }), name);
  const secondLine = headline.after ? `${name} ${headline.after}` : name;
  // Sorani headings are set in Plex 600 until a native reader approves Kufi's letters (v2 §2.6) — a pin's words in
  // the face of the language they are written in
  const titleLocale = pin?.textLocale ?? locale;
  const sizes = heroTitleSizes(pin ? [pin.headline] : [headline.lead, secondLine], titleLocale === "ckb" ? "plex" : "kufi");
  const titleStyle = { "--hero-fs-sm": `${sizes.sm}px`, "--hero-fs-md": `${sizes.md}px`, "--hero-fs-lg": `${sizes.lg}px`, "--hero-fs-xl": `${sizes.xl}px` } as CSSProperties;
  const pinLang = pin && pin.textLocale !== locale ? { lang: LOCALES[pin.textLocale].bcp47, dir: LOCALES[pin.textLocale].dir } : {};
  // the pin's deck in its own language, else the product's facts in the page's
  const deck = pin?.deck ?? null;
  // «اشترِ {name}» while it fits the full-width key on a phone; a longer name is said by the hero itself (the headline,
  // or the name line of a pinned hero) and the key keeps the kit's own words («أضف إلى السلة» / «اختر نسخة»)
  const keyLabel = [...card.name].length <= HERO_KEY_NAME_MAX ? t("hero.buy", { name }) : undefined;

  const openPreview = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setPreview({ mounted: true, open: true });
  };

  return (
    <Band kind="hero" aria-labelledby={headingId} className="home-hero" contentClassName="home-hero__body">
      <p className="home-hero__pill pill" data-gel={platform}>
        <PlatformLed platform={platform} />
        {ui(`platform.${platform}`)}
      </p>

      {pin ? (
        <h2 id={headingId} className="home-hero__title text-balance" style={titleStyle} {...pinLang} data-pinned="">
          <BidiText text={pin.headline} />
        </h2>
      ) : (
        <h2 id={headingId} className="home-hero__title" style={titleStyle}>
          {headline.lead ? (
            <>
              {headline.lead}
              <br />
            </>
          ) : null}
          <BidiText text={name} />
          {headline.after ? ` ${headline.after}` : null}
        </h2>
      )}

      {pin ? (
        // a pinned hero names its product under the staff's headline (on every width); the deck follows from 768
        <p className="home-hero__facts home-hero__facts--pinned">
          <span className="home-hero__name">
            <BidiText text={card.name} />
          </span>
          {deck ? (
            <span className="home-hero__deck" {...pinLang}>
              <BidiText text={deck} />
            </span>
          ) : null}
        </p>
      ) : card.subtitle ? (
        <p className="home-hero__facts">{card.subtitle}</p>
      ) : null}

      {/* a photo that fails to load leaves its box empty (no broken-image frame): the band keeps its size */}
      <div ref={media} className="home-hero__media" onErrorCapture={() => setPhotoFailed(true)}>
        {photoFailed ? null : <span className="band__contact" aria-hidden="true" />}
        <MotionLink nav="zoom" to={href} className="home-hero__link" aria-label={card.name}>
          <SharedElement name={`product-image:${card.id}`} slot="hero" as="span" className="home-hero__shared render-slot">
            {photoFailed ? null : <ProductImage image={card.image} alt="" sizes={HERO_SIZES} priority />}
          </SharedElement>
        </MotionLink>
      </div>

      <div className="home-hero__price">
        <SafePrice amountIqd={card.priceIqd} size="xl" tone="onColor" approx="off" as="span" />
        {demoPrice ? <DemoNote variant="tag" what="price" onColor /> : null}
      </div>

      <div className="home-hero__buy">
        {card.hasVariants ? (
          <Key
            as={LocaleLink}
            to={href}
            prefetch="none"
            variant="onBand"
            block
            aria-haspopup="dialog"
            className="md:w-fit"
            onClick={openPreview}
            onPointerEnter={warmQuickPreview}
            onFocus={warmQuickPreview}
            onTouchStart={warmQuickPreview}
          >
            {keyLabel ?? shop("add.choose")}
          </Key>
        ) : (
          // one version: nothing to choose — the kit's on-band add key adds it (the bead flies from the photo)
          <AddToCartKey
            variant="key"
            look="onBand"
            item={{ variantId: card.variantId }}
            name={card.name}
            label={keyLabel}
            stock={card.stock}
            image={card.image}
            source={() => media.current?.querySelector("img") ?? null}
            block
            className="md:w-fit"
          />
        )}
        {/* the device hub when the product is a device that has one, else its own page (a pinned game or accessory) */}
        <TextLink as={LocaleLink} to={deviceHref ?? href} className="max-md:hidden">
          {deviceHref ? t("hero.details") : t("hero.productDetails")}
        </TextLink>
      </div>

      {isIqd(deliveryFeeIqd) ? (
        <p className="home-hero__line">
          <Icon name="truck" size={16} />
          {/* each fact is one unit: a narrow phone breaks between them (inside one only when it alone is too long) */}
          <span>
            <span className="inline-block">{fillNodes(shop("price.delivery"), { price: <bdi className="nums">{iqdText(f, deliveryFeeIqd)}</bdi> })}</span>
            {cod ? (
              <>
                {" · "}
                <span className="inline-block">{shop("trust.cod")}</span>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {preview.mounted ? (
        <Suspense fallback={null}>
          <QuickPreview slug={card.slug} name={card.name} card={card} open={preview.open} onClose={() => setPreview((state) => ({ ...state, open: false }))} />
        </Suspense>
      ) : null}
    </Band>
  );
}
