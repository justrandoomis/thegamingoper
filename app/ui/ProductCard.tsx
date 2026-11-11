import { lazy, Suspense, useId, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { useRouteLoaderData } from "react-router";

import { artAspect, getArt, isPhoto } from "~/art";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { CKB_MONTHS } from "~/lib/dates";
import { LOCALES, type Locale } from "~/lib/locales";
import { MotionLink, SharedElement } from "~/motion";
import { CardAddButton } from "./AddToCartKey";
import { BidiText } from "./BidiText";
import { mediaUrl } from "./cart-client";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { IconKey } from "./IconKey";
import { Niche, type NicheKind } from "./Niche";
import { isPlatform, PlatformLed } from "./PlatformLed";
import { SafePrice } from "./PriceTag";
import { RatingStars } from "./RatingStars";
import { Render } from "./Stage";
import { Tag } from "./Tag";
import { WishlistKey } from "./WishlistKey";

/**
 * The product card — Design System v2 §4.11: the one card, NO CONTAINER (no border, no shadow, no fill around the
 * text). A 1:1 well on the product ground holds the picture (contained, bottom-aligned, the CSS contact ellipse), the one
 * badge top-start and the wishlist top-end; under it the platform line (8px dots + the kind label «جهاز PS5»), the name
 * (type-card, two lines, never truncated to one), at most two facts, and the foot pinned to the bottom: the price at the
 * start and the neutral add button at the end. Cards in a row are equal height (grid stretch), so prices align.
 *
 *   <ProductCard card={card} />                          ProductCardData from the catalogue read layer
 *   <ProductCard card={card} priority />                 the first card above the fold only
 *   <ProductCard card={card} wishlist wished={ids.has(card.id)} />   with the heart on the well
 *   <ProductCard card={card} layout="row" />             a 96px well at the start (device hubs, wide suggestions)
 *
 * The card is ONE link to /p/<slug> (MotionLink nav="zoom"): the link holds the well (the shared element
 * `product-image:<id>`) and the words, and its stretched layer covers the card; the add button and the heart sit
 * above it as separate controls — nothing interactive is nested. Its accessible name is the product name.
 *
 * States (from the data): in stock · sale («تخفيض», the real previous price struck, the price in red-ink) · coming soon
 * («قريباً»; «يصدر 19 تشرين الثاني» + «الطلب يفتح عند وصوله», no add button, no pre-order) · sold out («نفد»; the
 * photo at 50%, the price muted, «نفد حالياً», no notify-me) · image failed (the empty well, «تعذّر تحميل الصورة» and a
 * retry). A product with options opens the quick look («اختر نسخة {name}»). Loading: <ProductCardPlaceholder> — the
 * same geometry and the well colour, no grey skeleton.
 */
export type ProductCardProps = {
  card: ProductCardData;
  /** The first picture above the fold (loaded eagerly, preloaded). One per page. */
  priority?: boolean;
  /** Shared-element name. Default `product-image:${card.id}` — the Gallery on /p/<slug> is the target. */
  sharedName?: string;
  /** Distinguishes the same product shown twice on one page. */
  slot?: string;
  /** `sizes` for the picture. */
  sizes?: string;
  /** The name's heading level. Default 3 (cards under a section's h2). */
  headingLevel?: 2 | 3 | 4;
  /** grid (default) · row. */
  layout?: "grid" | "row";
  /** Show the heart on the well (pass `wished` from the page's wishlist read). */
  wishlist?: boolean;
  wished?: boolean;
  /** Force the demo note on or off. Default: on for demo rows when the store is not in demo mode. */
  demoNote?: boolean;
  className?: string;
};

const CARD_SIZES = "(min-width: 1280px) 240px, (min-width: 1024px) 22vw, (min-width: 768px) 30vw, 46vw";

/** 1.0: the card's price fit is a container query in v2 (`.price--long` steps down below 170px). Kept for importers. */
export function priceFit(_priceIqd: number): string {
  return "";
}

type RootStore = { storeMode?: string };

/** The product area's quick look — its code is fetched only when a shopper reaches for a card's button. */
const loadQuickPreview = () => import("~/routes/storefront/product/QuickPreview");
const QuickPreview = lazy(() => loadQuickPreview().then((module) => ({ default: module.QuickPreview })));
const warmQuickPreview = () => void loadQuickPreview().catch(() => undefined);

/** How the picture fits its well (v2 §7.3): box art, digital cards, wide objects, or hardware. Pure. */
export function wellKind(card: Pick<ProductCardData, "kind" | "image">): NicheKind {
  const art = card.image.artKey ? getArt(card.image.artKey) : undefined;
  if (isPhoto(art) && art.kind === "box-art") return "box";
  if (card.kind === "digital") return "card";
  const aspect = card.image.artKey ? artAspect(card.image.artKey) : undefined;
  if (aspect !== undefined && aspect >= 1.8) return "wide";
  return "hardware";
}

/** «19 تشرين الثاني» · "19 November" · "19ی تشرینی دووەم" — a release day in Iraq time, Western digits. Pure. */
export function releaseDay(ms: number, locale: Locale): string {
  if (locale === "ckb") {
    const date = new Date(ms + 3 * 3_600_000);
    return `${date.getUTCDate()}ی ${CKB_MONTHS[date.getUTCMonth()]}`;
  }
  return new Intl.DateTimeFormat(`${LOCALES[locale].bcp47}-u-nu-latn`, { day: "numeric", month: "long", timeZone: "Asia/Baghdad" }).format(ms);
}

export function ProductCard({ card, priority = false, sharedName, slot, sizes = CARD_SIZES, headingLevel = 3, layout = "grid", wishlist = false, wished = false, demoNote, className }: ProductCardProps) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const store = useRouteLoaderData("root") as RootStore | undefined;
  const words = useT("ui-card");
  const locale = useLocale();
  const demoMode = store?.storeMode === "demo";
  const showDemo = demoNote ?? (card.isDemo && !demoMode);
  const href = `/p/${card.slug}`;
  const Name = `h${headingLevel}` as const;
  const soon = card.stock === "preorder";
  const out = card.stock === "out_of_stock";
  // a demo previous price is struck only under the demo marking, in demo mode (dto: compareAtDemo)
  const compareAt = card.compareAtIqd !== null && card.compareAtIqd > card.priceIqd && (!card.compareAtDemo || demoMode) ? card.compareAtIqd : null;
  const state = out ? "out" : soon ? "soon" : compareAt !== null ? "sale" : "in";
  const badge = out ? (
    <Tag kind="out" />
  ) : soon || card.badge === "preorder" ? (
    <Tag kind="soon" />
  ) : compareAt !== null || card.badge === "deal" ? (
    <Tag kind="sale" />
  ) : card.badge === "new" || card.isNew ? (
    <Tag kind="new" />
  ) : null;
  const choose = card.hasVariants && !out && !soon;
  const dots = (card.forPlatforms?.length ? card.forPlatforms : card.platformSlug ? [card.platformSlug] : []).filter(isPlatform).slice(0, 2);
  const kindLabel = card.kindLabel ?? card.platformName;
  const facts = (card.subtitle ?? "").split(" · ").map((fact) => fact.trim()).filter(Boolean).slice(0, 2);
  const row = layout === "row";
  const price = <SafePrice amountIqd={card.priceIqd} compareAtIqd={compareAt} tone={out ? "muted" : undefined} approx="off" />;

  return (
    <article
      ref={root}
      className={cx("pcard", row && "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3", className)}
      data-state={state}
      data-layout={layout}
      data-product={card.id}
    >
      <MotionLink
        nav="zoom"
        to={href}
        className={cx("pcard__link min-w-0", row ? "grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-4" : "flex flex-1 flex-col")}
        aria-labelledby={titleId}
        data-press="soft"
      >
        <SharedElement name={sharedName ?? `product-image:${card.id}`} slot={slot} as="span" className="block">
          <Niche as="span" kind={wellKind(card)} state={out ? "out" : undefined} tag={row ? undefined : badge} size={row ? "sm" : "md"}>
            <CardImage image={card.image} sizes={row ? "96px" : sizes} priority={priority} />
          </Niche>
        </SharedElement>
        <span className={cx("pcard__body", row && "py-0")}>
          {kindLabel || dots.length ? (
            <span className="pcard__kind">
              {dots.map((p) => (
                <PlatformLed key={p} platform={p} />
              ))}
              {kindLabel ? <span className="min-w-0 truncate">{kindLabel}</span> : null}
            </span>
          ) : null}
          {/* the page's start edge: with `unicode-bidi: plaintext` Chromium aligns a Latin name to the left of an
              Arabic card (match-parent resolves against the name's own direction). BidiText already isolates the
              name, so the title keeps the page's direction. */}
          <Name id={titleId} className="pcard__title [unicode-bidi:isolate]">
            <BidiText text={card.name} />
          </Name>
          {facts.length ? (
            <span className="pcard__meta">
              {facts.map((fact, index) => (
                <span key={index}>
                  {index > 0 ? " · " : null}
                  <bdi>{fact}</bdi>
                </span>
              ))}
            </span>
          ) : null}
          {card.rating ? <RatingStars rating={card.rating} /> : null}
          {row ? <span className="mt-1">{price}</span> : null}
        </span>
      </MotionLink>
      {wishlist && !row ? (
        <span className="absolute end-1.5 top-1.5 z-2">
          <WishlistKey productId={card.id} name={card.name} initial={wished} onImage size="xs" message="none" />
        </span>
      ) : null}
      <div className={cx("pcard__foot", row && "mt-0 pt-0")}>
        {row ? null : price}
        {out ? (
          <span className="pcard__status">{words("outNow")}</span>
        ) : soon ? (
          <span className="pcard__status">
            <span>{card.releaseAt ? words("soonOn", { date: releaseDay(card.releaseAt, locale) }) : words("soon")}</span>
            <span>{words("soonNote")}</span>
          </span>
        ) : choose ? (
          <QuickLookButton card={card} href={href} />
        ) : (
          <CardAddButton
            item={{ variantId: card.variantId }}
            name={card.name}
            image={card.image}
            source={() => root.current?.querySelector(".niche") ?? null}
          />
        )}
      </div>
      {showDemo ? <DemoNote variant="tag" what="data" className="relative z-2 mt-1 self-start" /> : null}
    </article>
  );
}

/**
 * The add button of a product with options: opens the product area's quick look over the page (choose, then add) —
 * the page behind keeps its URL and scroll. A real link to the product page underneath (no script, new tab, a modified
 * click). Focus returns to this button when the sheet closes.
 */
function QuickLookButton({ card, href }: { card: ProductCardData; href: string }) {
  const shop = useT("ui-shop");
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setMounted(true);
    setOpen(true);
  };
  return (
    <>
      <IconKey
        as={LocaleLink}
        to={href}
        prefetch="none"
        icon="bag-plus"
        label={shop("add.chooseNamed", { name: card.name })}
        aria-haspopup="dialog"
        className="cadd"
        onClick={onClick}
        onPointerEnter={warmQuickPreview}
        onFocus={warmQuickPreview}
        onTouchStart={warmQuickPreview}
      />
      {mounted ? (
        <Suspense fallback={null}>
          <QuickPreview slug={card.slug} name={card.name} card={card} open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/** The card's picture, with the "image failed" state: the empty well, one line and a retry (v2 §4.11). */
function CardImage({ image, sizes, priority }: { image: ImageRef; sizes: string; priority: boolean }) {
  const words = useT("ui-card");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed) {
    return (
      <span className="absolute inset-0 z-2 grid place-content-center justify-items-center gap-1 p-3 text-center">
        <span className="type-xs text-ink-2">{words("imageFailed")}</span>
        <IconKey
          icon="arrows-clockwise"
          variant="onImage"
          size="sm"
          label={words("imageRetry")}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      </span>
    );
  }
  return (
    <span key={attempt} className="contents" onErrorCapture={() => setFailed(true)}>
      <ProductImage image={image} alt="" sizes={sizes} priority={priority} />
    </span>
  );
}

/**
 * The same geometry with nothing in it (no grey skeletons): the well colour, the reserved lines. Use it as the Suspense
 * fallback; reveal the real cards with <Bubble> into exactly this space.
 */
export function ProductCardPlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("pcard", className)}>
      <Niche as="span" />
      <span className="pcard__body">
        <span className="block min-h-[1lh] type-xs" />
        <span className="block min-h-[2lh] type-card" />
        <span className="pcard__foot">
          <span className="block min-h-[1.2em] price price--md" />
        </span>
      </span>
    </div>
  );
}

export type ProductImageProps = {
  image: ImageRef;
  /** Default `image.alt`. Pass "" when the name is right beside the picture (cards, rows). */
  alt?: string;
  sizes?: string;
  priority?: boolean;
  /** Uploaded photos: "cover" fills the box (used units in a well), "contain" fits it (default). */
  fit?: "contain" | "cover";
  /** 1.0 — ignored: products are never tilted. */
  pose?: number;
  /** 1.0 — ignored: the contact ellipse belongs to the well. */
  shadow?: boolean;
  className?: string;
};

/**
 * One ImageRef, drawn the right way (v2 §7): a catalogue photo through <Render> (contained and bottom-aligned in its
 * slot; an opaque photo draws its own rounded frame until it is re-cut), or an uploaded photo from /media/<key>. Nothing
 * at all when the ref has neither — the ground stays, no fake picture.
 */
export function ProductImage({ image, alt, sizes, priority = false, fit = "contain", className }: ProductImageProps) {
  const text = alt ?? image.alt;
  if (image.artKey) {
    return <Render name={image.artKey} alt={text} sizes={sizes} priority={priority} className={className} />;
  }
  if (image.mediaKey) {
    return (
      <img
        src={mediaUrl(image.mediaKey)}
        width={image.width ?? 1200}
        height={image.height ?? 900}
        alt={text}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        // An onLoad prop keeps React from holding a card → page navigation until the photo has loaded (docs/MOTION.md §4.6).
        onLoad={markLoaded}
        className={cx("block size-full", fit === "cover" ? "object-cover" : "object-contain", className)}
      />
    );
  }
  return null;
}

function markLoaded(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.dataset.loaded = "";
}

/**
 * A product name as the shopper should read it — the design system's one implementation (./BidiText). Kept as an
 * export of this module because the storefront imports it from here (`import { BidiText } from "~/ui/ProductCard"`).
 */
export { BidiText };

/** For pages that build their own rows: the card's platform dots and kind label (v2 §4.11). */
export function KindLine({ card, className }: { card: Pick<ProductCardData, "kindLabel" | "platformName" | "forPlatforms" | "platformSlug">; className?: string }): ReactNode {
  const dots = (card.forPlatforms?.length ? card.forPlatforms : card.platformSlug ? [card.platformSlug] : []).filter(isPlatform).slice(0, 2);
  const label = card.kindLabel ?? card.platformName;
  if (!label && dots.length === 0) return null;
  return (
    <span className={cx("pcard__kind", className)}>
      {dots.map((p) => (
        <PlatformLed key={p} platform={p} />
      ))}
      {label ? <span className="min-w-0 truncate">{label}</span> : null}
    </span>
  );
}
