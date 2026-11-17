/**
 * The home hero — a carousel of banners (client notes 1–3; brief §2.2, Design v2.1 G3/G6). Built on the kit's
 * `useCarousel` (~/ui/Carousel: a native scroll-snap track, so swiping works before and without JavaScript) with the
 * page's own banners:
 *
 *   platform banners   every platform's hero (a staff pin, else its lead device) in the key bank's order, the featured
 *                      one first (./view heroSlides), each on its platform's glossy colour (Nintendo red, PlayStation
 *                      blue, Xbox green, the handhelds' violet): the platform pill, the headline in Kufam (two lines at
 *                      most: «العب على» / «Nintendo Switch 2»), the short facts line, the price and «سعر تجريبي», the
 *                      white clay key and «تفاصيل الجهاز» as the second way in, the product on a glossy floor with a
 *                      little parallax as the banners move
 *   trade-in           brand crimson: «استبدل جهازك» — an estimate now, the final price after the inspection — → /trade-in
 *   used               graphite: «المستعمل والمفحوص» (the glossary's title) → /used (only while used units are listed)
 *
 * Phones (< 768): a compact WIDE banner (`--hero-phone-ratio`, ONE custom property in home.css — about 220px tall at
 * 390) with the next banner peeking at the end: the name and the price at the start, the product at the end, the key
 * along the bottom; the pause key and the dots under it. From 768: the copy at the inline start, the product at the
 * inline end; the pause key, the dots and the round clay arrows in the bar under the banner. The delivery fee is not
 * repeated here (the header's strip says it from 1024; the trust strip under the platform tiles on phones).
 *
 * Behaviour (the kit's hook): autoplay every 6.5 s, held while the pointer is over the hero, while focus is inside it,
 * while a finger is on it, while the tab is hidden and while it is off screen; stopped for good by a swipe, an arrow, a
 * dot or a key; ← → (in the reading direction), Home, End; the pause / play key. A fling stops at the next banner (the
 * kit's `scroll-snap-stop: always`); a move further than one banner slides across too, the banners side by side (the
 * kit's `far: "slide"`; owner request 2026-11-17: never a fade). Reduced motion: no autoplay,
 * instant moves, no parallax. The current dot fills with the time left while the banners move on by themselves (the
 * kit's `api.running` and `<CarouselDots progress>`). Only the
 * banner in view is interactive (`inert` on the others once the page is live: one banner's keys in the tab order, and
 * screen readers meet the banner that is shown — a region «عرض شرائح» named «أبرز ما في المتجر», each banner a group
 * «1 من 6»; the track is a polite live region only once the shopper has taken over). Every banner is server-rendered;
 * only the first one's photo loads with the page (eager, fetchpriority high), the others are lazy in the markup and the
 * next banner's photo is fetched while one is shown (./view photoToWarm), so no banner arrives as a blurred miniature;
 * the banner's shape is fixed by the stylesheet (CLS 0).
 *
 * A product with versions opens the product area's quick look on the version choice (the page keeps its URL and
 * scroll; a real link to the product page underneath); a product with one version is added at once by the kit's
 * on-band add key. The photo links into the product page with the card → page zoom (<SharedElement
 * name="product-image:<id>" slot="hero">). A photo that fails leaves its box empty; the banner keeps its size.
 */
import { lazy, memo, Suspense, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { LOCALES, type Locale } from "~/lib/locales";
import { getMotionTier, MotionLink, SharedElement } from "~/motion";
import { AddToCartKey } from "~/ui/AddToCartKey";
import { Band } from "~/ui/Band";
import { BidiText } from "~/ui/BidiText";
import { CarouselArrows, CarouselDots, CarouselPlay, useCarousel } from "~/ui/Carousel";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { PlatformLed, type Platform } from "~/ui/PlatformLed";
import { SafePrice } from "~/ui/PriceTag";
import { ProductImage } from "~/ui/ProductCard";
import { Render } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { TEAR_BOTTOM, TEAR_TOP, TEAR_VIEWBOX } from "./tear";
import { bannerAway, HERO_AUTOPLAY_MS, heroTitleSizes, inView, keepLastWord, photoToWarm, pictureFailed, plainFinalYeh, splitHeadline, wordsShown } from "./view";

/** The product area's quick look — fetched only when a shopper reaches for a key. */
const loadQuickPreview = () => import("~/routes/storefront/product/QuickPreview");
const QuickPreview = lazy(() => loadQuickPreview().then((module) => ({ default: module.QuickPreview })));
const warmQuickPreview = () => void loadQuickPreview().catch(() => undefined);

/** The longest product name «اشترِ {name}» takes on the key before it would be cut (from 768). */
const HERO_KEY_NAME_MAX = 24;

/** How wide a banner's photo is drawn: the phone banner's product column, 2/5 at 768, 5/12 from 1024, 1/2 from 1280. */
const HERO_SIZES = "(min-width: 1280px) 520px, (min-width: 1024px) 380px, (min-width: 768px) 36vw, 40vw";

/** A staff pin's words, and the language they are in (HomeHeroPin in ~/server/services/home.server). */
export type HeroPin = { headline: string; deck: string | null; textLocale: Locale };

export type ProductHeroSlide = {
  kind: "product";
  key: string;
  /** The platform's hero (a buyable product with a photo). */
  card: ProductCardData;
  platform: Platform;
  /** "new": released within the last 120 days («وصل …»); "lead": the platform's lead device («العب على …»). */
  mode: "new" | "lead";
  pin: HeroPin | null;
  /** The device hub of the product's model ("/device/switch-2"); null → the product page. */
  deviceHref: string | null;
  /** The price is a demo value («سعر تجريبي» beside it). */
  demoPrice: boolean;
};

export type ServiceHeroSlide = {
  kind: "tradeIn" | "used";
  key: string;
  /** The console the banner shows (a catalogue photo key), or null: the banner draws its icon. */
  art: string | null;
};

export type HeroSlide = ProductHeroSlide | ServiceHeroSlide;

/** A banner's words: they fade with its move (HeroCarousel). */
const BANNER_WORDS = ".home-slide__pill, .home-slide__title, .home-slide__facts, .home-slide__price, .home-slide__buy";

/** The keys the kit's hook moves the banners with (in the reading direction; ~/ui/Carousel). */
const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

const isTouch = (event: PointerEvent) => event.pointerType === "touch" || event.pointerType === "pen";

/** The shopper asked the browser to save data (Save-Data, Chromium): no photo is fetched ahead. */
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

/**
 * The carousel. A move re-renders this frame only — the wrapper of each banner (inert, data-current, data-arrived), the
 * lights, the dots and the controls; the banners' bodies are memoised with stable props (`slides` from the page's
 * memo, one `onChoose`), so a move is one light render, never six banners over again (cross-check 2026-11-13: three
 * long tasks of 74–164ms per move at 4× CPU, a stutter on slow phones).
 */
export const HeroCarousel = memo(function HeroCarousel({ slides }: { slides: readonly HeroSlide[] }) {
  const t = useT("home");
  // the kit's hook: what holds autoplay (pointer, focus, a finger, a hidden tab, off screen) and whether the banners move
  // on by themselves right now (`api.running` — the dots' progress follows it: <CarouselDots progress>)
  const api = useCarousel({ count: slides.length, autoplay: HERO_AUTOPLAY_MS, far: "slide" });
  // the page is live: before that, every banner stays usable (no inert)
  const [live, setLive] = useState(false);
  // the banner that arrived by a move (its product settles once): once the banners have moved, the one in view — none on
  // the first paint. Derived in the same render (React's adjust-state-while-rendering pattern, once per page): an
  // effect that set it after each move rendered the hero a second time.
  const [moved, setMoved] = useState(false);
  if (!moved && api.index !== 0) setMoved(true);
  const arrived = moved ? api.index : null;
  const [preview, setPreview] = useState<{ card: ProductCardData; open: boolean } | null>(null);
  const choose = useCallback((card: ProductCardData) => setPreview({ card, open: true }), []);
  // a finger (or a pen) is on the track right now — known at once, before any render (the track's scroll asks it)
  const fingerDown = useRef(false);

  useEffect(() => setLive(true), []);
  // the next banner's photo is fetched while this one is shown, once the page has loaded (./view photoToWarm): the
  // markup keeps it lazy, and a lazy photo in the sideways track would wait until it scrolls in — the banner would
  // arrive as a blurred miniature. React leaves the attribute alone: its prop never changes.
  const trackRef = api.trackProps.ref;
  useEffect(() => {
    if (!live) return;
    const next = photoToWarm(api.index, slides.length, saveData());
    const track = trackRef.current;
    if (next === null || !track) return;
    const warm = () => {
      const img = track.querySelector(`[data-carousel-slide="${next}"] img[loading="lazy"]`);
      if (img instanceof HTMLImageElement) img.loading = "eager";
    };
    if (document.readyState === "complete") {
      warm();
      return;
    }
    window.addEventListener("load", warm, { once: true });
    return () => window.removeEventListener("load", warm);
  }, [live, api.index, slides.length, trackRef]);

  // every banner's words and product follow its move (client note 1, "smooth switching"), written as the track
  // scrolls, once a frame: the words show as much as their column is on screen (./view inView, wordsShown — a banner
  // comes in words first in Arabic, so they arrive with it, and the leaving banner's fade as they slide off: no banner
  // crosses the screen as an empty band of colour; they used to appear only after it landed) and drift 60px a banner
  // slower than it, its product 9% of its width faster (./view bannerAway: its distance from its resting place). Inline
  // opacity and translate on those few elements: a custom property on the banner restyled all of it, 8–10ms a frame at
  // 4× CPU against ~2. No drift unless motion is full (reduced motion, the lite tier). CSS scroll-driven timelines would
  // do it without script, but Chromium measures a right-to-left scroller's view() timeline from the wrong edge (the
  // banner in view read -200% in Arabic, 50% in English — Edge 157, 2026-11-13).
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    // the track's direction, scroll padding and gap: read again only when the window changes size
    let edges: { rtl: boolean; pad: number; gap: number } | null = null;
    // each banner's moving parts (its title stands for the words' column); what it was last given: a banner is written
    // only when its values change (in a move between two banners the other four stay as they were)
    type Parts = { words: HTMLElement[]; column: HTMLElement | null; product: HTMLElement | null };
    const parts = new Map<HTMLElement, Parts>();
    const partsOf = (banner: HTMLElement): Parts => {
      let own = parts.get(banner);
      if (!own) {
        own = { words: [...banner.querySelectorAll<HTMLElement>(BANNER_WORDS)], column: banner.querySelector<HTMLElement>(".home-slide__title"), product: banner.querySelector<HTMLElement>(".home-slide__link") };
        parts.set(banner, own);
      }
      return own;
    };
    // the drift the words carry now, read from the element (an earlier run of this effect — React's strict mode runs it
    // twice in development — may have written it)
    const shiftOf = (element: HTMLElement | null) => parseFloat(element?.style.translate ?? "") || 0;
    const written = new Map<HTMLElement, string>();
    const paint = () => {
      frame = 0;
      if (!edges) {
        const style = getComputedStyle(track);
        edges = { rtl: style.direction === "rtl", pad: parseFloat(style.scrollPaddingInlineStart) || 0, gap: parseFloat(style.columnGap) || 0 };
      }
      const drift = getMotionTier() === "full";
      // the inline end, on screen (+1: the right)
      const end = edges.rtl ? -1 : 1;
      // the scroll from the track's start (negative to the left in a right-to-left track) and how far it can go: the
      // last banner of a phone's track rests at the track's end
      const scroll = { scroll: Math.abs(track.scrollLeft), maxScroll: Math.max(0, track.scrollWidth - track.clientWidth) };
      const box = track.getBoundingClientRect();
      const banners = [...track.querySelectorAll<HTMLElement>("[data-carousel-slide]")];
      // every box is read before any banner is written (no layout in between); a column's box without the drift its
      // words carry
      const boxes = banners.map((banner) => banner.getBoundingClientRect());
      const columns = banners.map((banner) => {
        const column = partsOf(banner).column;
        if (!column) return null;
        const rect = column.getBoundingClientRect();
        const shift = shiftOf(column);
        return { left: rect.left - shift, right: rect.right - shift };
      });
      banners.forEach((banner, index) => {
        const own = partsOf(banner);
        const away = bannerAway({ ...edges!, ...scroll, trackLeft: box.left, trackRight: box.right, left: boxes[index].left, right: boxes[index].right });
        const column = columns[index];
        const show = column ? wordsShown(inView({ ...column, trackLeft: box.left, trackRight: box.right })) : 1;
        const key = `${away.toFixed(3)}|${show.toFixed(3)}|${drift}`;
        if (written.get(banner) === key) return;
        written.set(banner, key);
        const moving = drift && away !== 0;
        for (const word of own.words) {
          word.style.opacity = show === 1 ? "" : show.toFixed(3);
          word.style.translate = moving ? `${(-60 * away * end).toFixed(1)}px 0` : "";
        }
        if (own.product) own.product.style.translate = moving ? `${(9 * away * end).toFixed(2)}% 0` : "";
      });
    };
    const onMove = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onResize = () => {
      edges = null;
      onMove();
    };
    paint();
    track.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onResize);
    // the page settling (its fonts, its pictures) may move a column without a scroll
    window.addEventListener("load", onMove, { once: true });
    void document.fonts?.ready.then(onMove);
    return () => {
      cancelAnimationFrame(frame);
      frame = -1; // a late font or load event paints nothing
      track.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("load", onMove);
      // the words and products as the markup has them (an effect that runs again starts from the page as rendered)
      for (const own of parts.values()) {
        for (const word of own.words) {
          word.style.removeProperty("opacity");
          word.style.removeProperty("translate");
        }
        own.product?.style.removeProperty("translate");
      }
    };
  }, [trackRef, slides.length]);

  const root = api.rootProps;
  const rootProps = {
    ...root,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      // the hook moves the banners with ← → Home End — never for a key pressed in the quick look, a portal whose events
      // React bubbles through this section (the kit's guard)
      root.onKeyDown(event);
      if (!MOVE_KEYS.has(event.key) || !event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
      // a key pressed on a link inside the banner that is leaving: that banner turns inert and would drop the focus to
      // <body> — the focus goes to the track instead (the banners' own stop), where the next arrow keeps working
      const banner = (event.target as HTMLElement).closest(".home-hero__slide");
      if (banner) api.trackProps.ref.current?.focus({ preventScroll: true });
    },
  };
  const track = api.trackProps;
  const trackProps = {
    ...track,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      track.onPointerDown(event);
      if (isTouch(event)) fingerDown.current = true;
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      track.onPointerUp(event);
      if (isTouch(event)) fingerDown.current = false;
    },
    onTouchEnd: () => {
      track.onTouchEnd();
      fingerDown.current = false;
    },
    onTouchCancel: () => {
      track.onTouchCancel();
      fingerDown.current = false;
    },
    // a scroll is a take-over only under a finger (the kit's carouselHold): the hook hears it only then — on every
    // scroll event of a move it re-rendered the hero, ~30 renders a move (profiled at 4× CPU)
    onScroll: () => {
      if (fingerDown.current) track.onScroll();
    },
  };

  if (slides.length === 0) return null;
  return (
    <section {...rootProps} aria-label={t("hero.label")} className="carousel home-hero" data-live={live ? "" : undefined}>
      {/* the banners run the page's full width, integrated into the floor (owner request 2026-11-17): the floor is laid
          over their top and bottom as a torn-paper edge (./tear), with a soft fade from the floor's colour under the top
          tear and a shadow cast onto the banner. No glow spills around the hero (the owner asked for it gone). */}
      <div className="home-hero__stage">
        <div {...trackProps} className="carousel__track home-hero__track">
          {slides.map((slide, index) => (
            <div
              key={slide.key}
              {...api.slideProps(index)}
              className="carousel__slide home-hero__slide"
              inert={live && index !== api.index ? true : undefined}
              data-current={index === api.index ? "" : undefined}
              data-arrived={arrived === index ? "" : undefined}
            >
              {slide.kind === "product" ? <ProductSlide slide={slide} first={index === 0} onChoose={choose} /> : <ServiceSlide slide={slide} />}
            </div>
          ))}
        </div>
        <span className="home-hero__fade" aria-hidden="true" />
        <Tear edge="top" />
        <Tear edge="bottom" />
      </div>
      {slides.length > 1 ? (
        // the pause / play key first (the keyboard meets it before the dots, WCAG 2.2.2; home.css keeps it off the dots
        // at every width), the dots with the kit's progress (the current one fills while the banners move on by
        // themselves), the round clay arrows from 768
        <div className="home-hero__bar">
          <CarouselPlay api={api} className="home-hero__play" />
          <CarouselDots api={api} progress className="home-hero__dots" />
          <CarouselArrows api={api} className="home-hero__arrows max-md:hidden" />
        </div>
      ) : null}
      {preview ? (
        <Suspense fallback={null}>
          <QuickPreview slug={preview.card.slug} name={preview.card.name} card={preview.card} open={preview.open} onClose={() => setPreview((state) => (state ? { ...state, open: false } : state))} />
        </Suspense>
      ) : null}
    </section>
  );
});

/** A torn-paper edge in the floor's colour, laid over the banners' top or bottom (./tear; home.css colours it). */
function Tear({ edge }: { edge: "top" | "bottom" }) {
  return (
    <svg className="home-hero__tear" data-edge={edge} viewBox={TEAR_VIEWBOX} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={edge === "top" ? TEAR_TOP : TEAR_BOTTOM} />
    </svg>
  );
}

/** The headline's size in each range, as custom properties (./view heroTitleSizes). */
function titleStyle(sizes: Record<"sm" | "md" | "lg" | "xl", number>): CSSProperties {
  return { "--hero-fs-sm": `${sizes.sm}px`, "--hero-fs-md": `${sizes.md}px`, "--hero-fs-lg": `${sizes.lg}px`, "--hero-fs-xl": `${sizes.xl}px` } as CSSProperties;
}

/** A platform banner's body. Memoised: a move of the carousel changes only its wrapper's attributes, never these props. */
const ProductSlide = memo(function ProductSlide({ slide, first, onChoose }: { slide: ProductHeroSlide; first: boolean; onChoose: (card: ProductCardData) => void }) {
  const t = useT("home");
  const ui = useT("ui");
  const shop = useT("ui-shop");
  const locale = useLocale();
  const online = useOnline();
  const headingId = useId();
  const noticeId = useId();
  const media = useRef<HTMLDivElement>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // the server-rendered photo may have failed before the page came to life (no onError then): look once
  useEffect(() => {
    if (pictureFailed(media.current?.querySelector("img"))) setPhotoFailed(true);
  }, []);

  const { card, platform, mode, pin, deviceHref } = slide;
  const href = `/p/${card.slug}`;
  const name = keepLastWord(card.name);
  const headline = splitHeadline((value) => t(mode === "new" ? "hero.new" : "hero.lead", { name: value }), name);
  const secondLine = headline.after ? `${name} ${headline.after}` : name;
  // phones show the name alone (the words around it are read, not shown); a staff pin's headline may take two lines,
  // and so may the name with the words after it (Sorani's «{name} گەیشت»: the verb goes under the name)
  const sizes = heroTitleSizes(pin ? [pin.headline] : [headline.lead, secondLine], "kufam", pin ? { wrap: true, phone: pin.headline } : { wrap: Boolean(headline.after), phone: name });
  const pinLang = pin && pin.textLocale !== locale ? { lang: LOCALES[pin.textLocale].bcp47, dir: LOCALES[pin.textLocale].dir } : {};
  // on phones «اشترِ الآن» (short: the key stays beside the product); from 768 «اشترِ {name}» while it fits the key,
  // else the kit's own words («اختر نسخة» / «أضف إلى السلة»)
  const own = card.hasVariants ? shop("add.choose") : shop("add.label");
  const label: ReactNode = (
    <>
      <span className="md:hidden">{t("hero.buyNow")}</span>
      <span className="max-md:hidden">{[...card.name].length <= HERO_KEY_NAME_MAX ? t("hero.buy", { name }) : own}</span>
    </>
  );
  const offline = !online && !card.hasVariants && card.stock !== "out_of_stock";

  const choose = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onChoose(card);
  };

  return (
    <Band as="div" kind="platform" platform={platform} className="home-slide" contentClassName="home-slide__body" data-kind="product">
      <span className="home-slide__gloss" aria-hidden="true" />
      <p className="home-slide__pill pill" data-gel={platform}>
        <PlatformLed platform={platform} />
        {ui(`platform.${platform}`)}
      </p>

      {pin ? (
        <h2 id={headingId} className="home-slide__title" style={titleStyle(sizes)} {...pinLang} data-pinned="">
          <BidiText text={plainFinalYeh(pin.headline)} />
        </h2>
      ) : (
        <h2 id={headingId} className="home-slide__title" style={titleStyle(sizes)}>
          {headline.lead ? (
            <>
              {/* on phones the words before the name are read, not shown: the compact banner shows the name */}
              <span className="home-slide__lead">{`${headline.lead} `}</span>
              <br className="home-slide__break" />
            </>
          ) : null}
          <BidiText text={name} />
          {headline.after ? <span className="home-slide__lead">{` ${headline.after}`}</span> : null}
        </h2>
      )}

      {pin ? (
        // a pinned banner names its product under the staff's headline, and the staff's deck follows (from 768)
        <p className="home-slide__facts home-slide__facts--pinned">
          <span className="home-slide__name">
            <BidiText text={card.name} />
          </span>
          {pin.deck ? (
            <span className="home-slide__deck" {...pinLang}>
              <BidiText text={plainFinalYeh(pin.deck)} />
            </span>
          ) : null}
        </p>
      ) : card.subtitle ? (
        // «حتى 4K على التلفاز» — never Plex's «حق»-shaped ligature (./view plainFinalYeh)
        <p className="home-slide__facts">{plainFinalYeh(card.subtitle)}</p>
      ) : null}

      <div className="home-slide__price">
        <SafePrice amountIqd={card.priceIqd} size="xl" tone="onColor" approx="off" as="span" />
        {slide.demoPrice ? <DemoNote variant="tag" what="price" onColor /> : null}
      </div>

      <div className="home-slide__buy">
        {card.hasVariants ? (
          <Key
            as={LocaleLink}
            to={href}
            prefetch="none"
            variant="onBand"
            aria-haspopup="dialog"
            className="home-slide__key"
            onClick={choose}
            onPointerEnter={warmQuickPreview}
            onFocus={warmQuickPreview}
            onTouchStart={warmQuickPreview}
          >
            {label}
          </Key>
        ) : (
          // one version: nothing to choose — the kit's on-band add key adds it (the bead flies from the photo); its
          // offline reason and any failure are said on the band in the band's ink (below), not in the page's grey
          <AddToCartKey
            variant="key"
            look="onBand"
            item={{ variantId: card.variantId }}
            name={card.name}
            label={label}
            stock={card.stock}
            image={card.image}
            source={() => media.current?.querySelector("img") ?? null}
            message="none"
            onMessage={(text) => setNotice(text)}
            aria-describedby={offline || notice ? noticeId : undefined}
            className="home-slide__key"
          />
        )}
        {/* the device hub when the product is a device that has one, else its own page (a pinned game or accessory) */}
        <TextLink as={LocaleLink} to={deviceHref ?? href} className="home-slide__more">
          {deviceHref ? t("hero.details") : t("hero.productDetails")}
        </TextLink>
        {offline || notice ? (
          <p id={noticeId} className="home-slide__notice" role={notice ? "status" : undefined}>
            <Icon name={offline ? "wifi-slash" : "warning-circle"} size={16} />
            <span>{offline ? shop("add.offline") : notice}</span>
          </p>
        ) : null}
      </div>

      {/* a photo that fails to load leaves its box empty (no broken-image frame): the banner keeps its size */}
      <div ref={media} className="home-slide__media" onErrorCapture={() => setPhotoFailed(true)}>
        {photoFailed ? null : <span className="home-slide__floor" aria-hidden="true" />}
        <MotionLink nav="zoom" to={href} className="home-slide__link" aria-label={card.name}>
          <SharedElement name={`product-image:${card.id}`} slot="hero" as="span" className="home-slide__shared render-slot">
            {photoFailed ? null : <ProductImage image={card.image} alt="" sizes={HERO_SIZES} priority={first} />}
          </SharedElement>
        </MotionLink>
      </div>
    </Band>
  );
});

const SERVICE: Record<ServiceHeroSlide["kind"], { to: string; icon: IconName }> = {
  tradeIn: { to: "/trade-in", icon: "recycle" },
  used: { to: "/used", icon: "kind-used" },
};

/**
 * The trade-in and used banners: their pill, a two-word title, the honest line (from 768), one white clay key and a
 * console no platform banner shows (decorative: the key is the way in). Memoised like the platform banners.
 */
const ServiceSlide = memo(function ServiceSlide({ slide }: { slide: ServiceHeroSlide }) {
  const t = useT("home");
  const { to, icon } = SERVICE[slide.kind];
  const title = t(`hero.${slide.kind}.title`);
  const sizes = heroTitleSizes([title], "kufam", { wrap: true, phone: title });
  return (
    // the same glossy band as the platforms' banners: the brand's crimson for the trade-in (data-gel="brand"), the
    // graphite of the page's dark band for the used devices (home.css data-tone)
    <Band
      as="div"
      kind="platform"
      platform={slide.kind === "tradeIn" ? "brand" : undefined}
      className="home-slide"
      contentClassName="home-slide__body"
      data-kind={slide.kind}
      data-tone={slide.kind === "used" ? "graphite" : undefined}
    >
      <span className="home-slide__gloss" aria-hidden="true" />
      <p className="home-slide__pill pill">
        <Icon name={icon} size={16} />
        {t(`hero.${slide.kind}.pill`)}
      </p>
      <h2 className="home-slide__title" style={titleStyle(sizes)}>
        {title}
      </h2>
      <p className="home-slide__facts">{plainFinalYeh(t(`hero.${slide.kind}.text`))}</p>
      <div className="home-slide__buy">
        <Key as={LocaleLink} to={to} variant="onBand" iconEnd="arrow-right" className="home-slide__key">
          {t(`hero.${slide.kind}.cta`)}
        </Key>
      </div>
      <div className="home-slide__media" aria-hidden="true">
        {slide.art ? (
          <>
            <span className="home-slide__floor" />
            <span className="home-slide__link">
              <span className="home-slide__shared render-slot">
                <Render name={slide.art} alt="" sizes={HERO_SIZES} />
              </span>
            </span>
          </>
        ) : (
          <span className="home-slide__glyph">
            <Icon name={icon} size={64} />
          </span>
        )}
      </div>
    </Band>
  );
});
