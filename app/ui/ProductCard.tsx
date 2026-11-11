import { useRef, type ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { getArt, isPhoto } from "~/art";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { MotionLink, SharedElement } from "~/motion";
import { AddToCartKey } from "./AddToCartKey";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { Niche } from "./Niche";
import { PriceTag, SavingNote } from "./PriceTag";
import { RatingStars } from "./RatingStars";
import { Socket } from "./Socket";
import { Render } from "./Stage";
import { StockNote } from "./StockNote";
import { Tag } from "./Tag";

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
 * separate control — nothing interactive is nested. Products with options get a key that opens the product page.
 * Out of stock: an empty socket and "نفد" in the status line. A rating shows only when real reviews exist.
 * `isDemo` rows say "تجريبي" when the store is live (in demo mode the store-wide ribbon already says it).
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

type RootStore = { storeMode?: string };

export function ProductCard({ card, priority = false, sharedName, slot, sizes = CARD_SIZES, headingLevel, demoNote, className }: ProductCardProps) {
  const root = useRef<HTMLElement>(null);
  const store = useRouteLoaderData("root") as RootStore | undefined;
  const showDemo = demoNote ?? (card.isDemo && store?.storeMode !== "demo");
  const href = `/p/${card.slug}`;
  const Name = headingLevel ? (`h${headingLevel}` as const) : "span";
  const tag = card.badge === "new" ? <Tag kind="new" /> : card.badge === "preorder" ? <Tag kind="preorder" /> : null;
  const saving = card.compareAtIqd !== null && card.compareAtIqd > card.priceIqd;

  return (
    <article ref={root} className={cx("relative flex min-w-0 flex-col", className)} data-product={card.id}>
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
      {card.stock !== "in_stock" ? <StockNote stock={card.stock} className="mt-0.5" /> : null}
      {card.rating ? <RatingStars rating={card.rating} className="mt-0.5" /> : null}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1.5">
        <PriceTag priceIqd={card.priceIqd} compareAtIqd={card.compareAtIqd} />
        <AddToCartKey
          item={{ variantId: card.variantId }}
          name={card.name}
          stock={card.stock}
          chooseHref={card.hasVariants ? href : null}
          image={card.image}
          source={() => root.current?.querySelector(".niche") ?? null}
        />
      </div>
      {showDemo ? <DemoNote compact className="relative mt-1 self-start" /> : null}
    </article>
  );
}

/**
 * The same geometry with nothing in it (DESIGN.md §7.2 "Bubble / inflate reveal": no grey skeletons). Use it as the
 * Suspense fallback; reveal the real cards with <Bubble> into exactly this space.
 */
export function ProductCardPlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("flex min-w-0 flex-col", className)}>
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
 * One ImageRef, drawn the right way (DESIGN.md §12): a catalogue photo or clay render through <Render> (cut-outs
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
        src={`/media/${encodeURIComponent(image.mediaKey)}`}
        width={image.width ?? 1200}
        height={image.height ?? 900}
        alt={text}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        className={cx("block size-full", fit === "cover" ? "object-cover" : "object-contain", className)}
      />
    );
  }
  return null;
}

const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
const LATIN_RUN = /[\p{Script=Latin}\d](?:[\p{Script=Latin}\d'’&.:+\-/()]|[  ](?=[\p{Script=Latin}\d(]))*/gu;

/**
 * A product name as the shopper should read it: a Latin-only name is one isolated left-to-right run; inside an
 * Arabic or Kurdish name, every Latin run and number is isolated with <bdi> ("حزمة <bdi>Mario Kart World</bdi>"),
 * and the name itself keeps the page's direction — nothing forces `direction` on a name (DESIGN.md §5.5).
 */
export function BidiText({ text }: { text: string }) {
  if (!RTL_SCRIPT.test(text)) return <bdi dir="ltr">{text}</bdi>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LATIN_RUN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      <bdi key={index} dir="ltr">
        {match[0]}
      </bdi>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
