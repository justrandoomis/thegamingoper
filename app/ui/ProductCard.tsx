import { lazy, Suspense, useRef, useState, type MouseEvent, type SyntheticEvent } from "react";
import { useRouteLoaderData } from "react-router";

import { getArt, isPhoto } from "~/art";
import { LocaleLink, useT } from "~/i18n/react";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { MotionLink, SharedElement } from "~/motion";
import { AddToCartKey } from "./AddToCartKey";
import { BidiText } from "./BidiText";
import { mediaUrl } from "./cart-client";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { IconKey } from "./IconKey";
import { Niche } from "./Niche";
import { PriceTag, SavingNote } from "./PriceTag";
import { RatingStars } from "./RatingStars";
import { AddGlyph, Socket } from "./Socket";
import { Render } from "./Stage";
import { StockNote } from "./StockNote";
import { Status, Tag } from "./Tag";

/**
 * The product card — the one card (docs/DESIGN.md §9.5, reference a.png): no chrome at all. A flat niche holds the
 * picture and the one tag; the name (two lines, height reserved), the fact line and the price sit on the floor; the
 * red add key is seated in its socket at the end of the price row.
 *
 *   <ProductCard card={card} />                        ProductCardData from the catalogue read layer
 *   <ProductCard card={card} priority />               the first card above the fold only
 *   <ProductCard card={card} slot="trending" />        the same product in two rails on one page
 *
 * The card is ONE link to /p/<slug> (MotionLink nav="zoom": the niche grows into the product page's stage through
 * <SharedElement name="product-image:<id>">); its link covers the whole card, and the add key sits above it as a
 * separate control — nothing interactive is nested. Out of stock: an empty socket and "نفد" in the status line. A
 * rating shows only when real reviews exist. `isDemo` rows say "تجريبي" when the store is live (in demo mode the
 * store-wide ribbon already says it).
 *
 * Products with options (§9.5 "open the quick-preview sheet instead of adding"): the socket key opens the product
 * area's QuickPreview sheet over the page — variants, stock, the buy controls, "التفاصيل الكاملة". The sheet's code is
 * loaded on first intent (hover, focus, press), so the card itself stays light. The key is a real link to the product
 * page underneath: without script, or opened in a new tab (Ctrl/⌘/middle click), it simply goes there.
 *
 * Not out yet (`stock: "preorder"` — announced, no stock): "قريباً" as the tag and the status, an empty socket and no
 * add key. The commerce core has no pre-order flow, so the cart would refuse it (409); the card never offers it.
 * (The card data carries no release date; the product page and the home's "coming soon" shelf say the date.)
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
  /** Make the name a heading (h2–h4) for the page outline. Default: plain text inside the link. */
  headingLevel?: 2 | 3 | 4;
  /** Force the demo note on or off. Default: on for demo rows when the store is not in demo mode. */
  demoNote?: boolean;
  className?: string;
};

const CARD_SIZES = "(min-width: 1200px) 210px, (min-width: 768px) 30vw, 46vw";

/**
 * The price and the 52px socket share one row. Measured on /design-system: a seven-digit price (1,095,000) needs a
 * card of ~184px at 17px, a six-digit one ~152px — rail cards on phones are narrower, so there the price steps down
 * to 15px (Kufam's floor, DESIGN.md §5.5). Below that (a seven-digit price in a 141px rail card on a 360px phone)
 * the row wraps and the socket keeps to the end (`ms-auto`).
 */
export function priceFit(priceIqd: number): string {
  return priceIqd >= 1_000_000 ? "@max-[11.5rem]:[--price-md:15px]" : "@max-[9.5rem]:[--price-md:15px]";
}

type RootStore = { storeMode?: string };

/** The product area's quick-preview sheet — its code is fetched only when a shopper reaches for a card's key. */
const loadQuickPreview = () => import("~/routes/storefront/product/QuickPreview");
const QuickPreview = lazy(() => loadQuickPreview().then((module) => ({ default: module.QuickPreview })));
const warmQuickPreview = () => void loadQuickPreview().catch(() => undefined);

export function ProductCard({ card, priority = false, sharedName, slot, sizes = CARD_SIZES, headingLevel, demoNote, className }: ProductCardProps) {
  const root = useRef<HTMLElement>(null);
  const store = useRouteLoaderData("root") as RootStore | undefined;
  const words = useT("ui-card");
  const showDemo = demoNote ?? (card.isDemo && store?.storeMode !== "demo");
  const href = `/p/${card.slug}`;
  const Name = headingLevel ? (`h${headingLevel}` as const) : "span";
  // announced, not in stock: never "pre-order" — nothing can be ordered before stock exists
  const soon = card.stock === "preorder";
  const tag = card.badge === "new" ? <Tag kind="new" /> : card.badge === "preorder" || soon ? <Tag kind="preorder">{words("soon")}</Tag> : null;
  const saving = card.compareAtIqd !== null && card.compareAtIqd > card.priceIqd;
  const choose = card.hasVariants && card.stock !== "out_of_stock" && !soon;

  return (
    <article ref={root} className={cx("relative flex w-full min-w-0 flex-col", className)} data-product={card.id}>
      <MotionLink nav="zoom" to={href} className="flex flex-col gap-2 rounded-lg after:absolute after:inset-0 after:content-['']">
        <SharedElement name={sharedName ?? `product-image:${card.id}`} slot={slot} as="span" className="block">
          <Niche as="span" tag={tag}>
            <ProductImage image={card.image} alt="" sizes={sizes} priority={priority} />
          </Niche>
        </SharedElement>
        <Name className="line-clamp-2 min-h-[2lh] type-strong text-ink">
          <BidiText text={card.name} />
        </Name>
      </MotionLink>
      <p className="min-h-[1lh] type-caption text-ink-2">
        {card.subtitle}
        {saving ? (
          <>
            {card.subtitle ? " · " : null}
            <SavingNote priceIqd={card.priceIqd} compareAtIqd={card.compareAtIqd} />
          </>
        ) : null}
      </p>
      {soon ? (
        <span className="mt-0.5 inline-flex">
          <Status tone="info">{words("soonNote")}</Status>
        </span>
      ) : card.stock !== "in_stock" ? (
        <StockNote stock={card.stock} className="mt-0.5" />
      ) : null}
      {card.rating ? <RatingStars rating={card.rating} className="mt-0.5" /> : null}
      <div className="@container mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1.5">
        <PriceTag priceIqd={card.priceIqd} compareAtIqd={card.compareAtIqd} className={priceFit(card.priceIqd)} />
        {choose ? (
          <QuickLookKey card={card} href={href} className="ms-auto" />
        ) : (
          <AddToCartKey
            item={{ variantId: card.variantId }}
            name={card.name}
            // not out yet: the empty socket of a product that cannot be added (the status line says why)
            stock={soon ? "out_of_stock" : card.stock}
            image={card.image}
            source={() => root.current?.querySelector(".niche") ?? null}
            className="ms-auto"
          />
        )}
      </div>
      {showDemo ? <DemoNote compact className="relative mt-1 self-start" /> : null}
    </article>
  );
}

/**
 * The socket key of a card with options: opens the quick-preview sheet (product area) to choose, then add — the page
 * behind keeps its URL and scroll. A real link to the product page underneath (no script, new tab, modified click).
 * Focus returns to this key when the sheet closes (the sheet's modal layer remembers its opener).
 */
function QuickLookKey({ card, href, className }: { card: ProductCardData; href: string; className?: string }) {
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
      <Socket className={className}>
        <IconKey
          as={LocaleLink}
          to={href}
          prefetch="none"
          variant="commit"
          icon={<AddGlyph />}
          label={shop("add.chooseNamed", { name: card.name })}
          aria-haspopup="dialog"
          onClick={onClick}
          onPointerEnter={warmQuickPreview}
          onFocus={warmQuickPreview}
          onTouchStart={warmQuickPreview}
        />
      </Socket>
      {mounted ? (
        <Suspense fallback={null}>
          <QuickPreview slug={card.slug} name={card.name} card={card} open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * The same geometry with nothing in it (DESIGN.md §7.2 "Bubble / inflate reveal": no grey skeletons). Use it as the
 * Suspense fallback; reveal the real cards with <Bubble> into exactly this space.
 */
export function ProductCardPlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("flex w-full min-w-0 flex-col", className)}>
      <Niche as="span" tagZone={false} />
      <span className="mt-2 block min-h-[2lh] type-strong" />
      <span className="block min-h-[1lh] type-caption" />
      <div className="mt-auto flex items-center justify-between pt-1.5">
        <span className="block min-h-[1.3em] price price--md" />
        <Socket state="empty" />
      </div>
    </div>
  );
}

export type ProductImageProps = {
  image: ImageRef;
  /** Default `image.alt`. Pass "" when the name is right beside the picture (cards, rows). */
  alt?: string;
  sizes?: string;
  priority?: boolean;
  /** Uploaded photos: "cover" fills the box (used units in a niche), "contain" fits it (default). */
  fit?: "contain" | "cover";
  /** Tilt for cut-outs on a stage; ignored for framed photos, box art and screenshots (they never tilt). */
  pose?: number;
  shadow?: boolean;
  className?: string;
};

/**
 * One ImageRef, drawn the right way (DESIGN.md §12): a catalogue photo through <Render> (cut-outs
 * float with a contact shadow; opaque photos, box art and screenshots sit flat in their frame), or an uploaded photo
 * from /media/<key>. Nothing at all when the ref has neither — the surface colour stays, no fake picture.
 */
export function ProductImage({ image, alt, sizes, priority = false, fit = "contain", pose, shadow, className }: ProductImageProps) {
  const text = alt ?? image.alt;
  if (image.artKey) {
    const art = getArt(image.artKey);
    const framed = isPhoto(art) && (!art.transparent || art.kind === "box-art" || art.kind === "screenshot");
    return <Render name={image.artKey} alt={text} sizes={sizes} priority={priority} pose={framed ? 0 : pose} shadow={framed ? false : shadow} className={className} />;
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
 * A product name as the shopper should read it — the design system's one implementation (./BidiText: Latin names and
 * numbers isolated where a reader expects them to end, brackets and list punctuation kept in the sentence). Kept as an
 * export of this module because the storefront imports it from here (`import { BidiText } from "~/ui/ProductCard"`).
 */
export { BidiText };
