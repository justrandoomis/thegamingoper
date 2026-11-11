/**
 * The home hero (DESIGN.md §2 "The Lit Stage and the key that stays down", §8.1 mobile, §8.9 desktop, §8.11 tablet):
 * a one-line headline (an Arabic verb + the product's own name), the lit stage with the product's official photo,
 * the glass price tag and the one red key on the rim, and the bank of four platform keys under it. Pressing a key
 * relights the stage for that platform at once (state first — the URL only remembers it, no request is made).
 *
 * Phones: headline → stage (+ tag and commit key on the rim) → bank. From 768 the copy column (headline, deck, the
 * device link and the commit key, the delivery fact, the bank) sits at the inline start beside the stage — 6 + 6,
 * then 5 + 7 from 1200 — so it mirrors in English. The stage's photo is a link into the product page (the card →
 * page zoom: <SharedElement name="product-image:<id>" slot="hero">).
 */
import { useId, type CSSProperties } from "react";
import { preload } from "react-dom";

import { artSrcSet, getArt } from "~/art";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { MotionLink, SharedElement } from "~/motion";
import type { HomePlatform } from "~/server/services/home.server";
import { AddToCartKey } from "~/ui/AddToCartKey";
import { Key } from "~/ui/Key";
import { PlatformBank } from "~/ui/PlatformBank";
import { PlatformLabel, type Platform } from "~/ui/PlatformLed";
import { DeliveryNote } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Stage, StageTag } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { baghdadDay, headlineEm, isolate } from "./view";

/** How wide the hero photo is drawn (the stage column): phones ~80vw, tablets half the page, desktop 7/12 of 1280. */
const HERO_SIZES = "(min-width: 1200px) 640px, (min-width: 768px) 46vw, 82vw";

export type HeroProps = {
  platforms: readonly HomePlatform[];
  cards: Readonly<Record<string, ProductCardData>>;
  focus: Platform | null;
  onFocus: (platform: Platform) => void;
  /** The platform the server rendered first: only its photo is the page's LCP image (priority). */
  firstFocus: Platform | null;
  deliveryFeeIqd: number | null;
};

export function Hero({ platforms, cards, focus, onFocus, firstFocus, deliveryFeeIqd }: HeroProps) {
  const t = useT("home");
  const f = useFormat();
  const headingId = useId();
  const platform = platforms.find((entry) => entry.slug === focus) ?? null;
  const card = platform?.hero ? cards[platform.hero.productId] : undefined;
  const phrase = focus ? isolate(t(`phrase.${focus}`)) : "";
  const headline = card ? t(platform!.hero!.mode === "new" ? "hero.new" : "hero.lead", { name: card.name }) : t("hero.platformOnly", { platform: phrase });
  const href = card ? `/p/${card.slug}` : focus ? `/platform/${focus}` : "/";
  const released = platform?.hero?.mode === "new" ? baghdadDay(platform.hero.releasedOn) : null;
  const stageImage = () => document.querySelector<HTMLElement>(".home-hero .stage__slot .render");

  // Pointer-down on a platform key that is not lit yet: fetch its photo now (DESIGN.md §6.5 — never stacked in the DOM).
  const prefetch = (next: Platform) => {
    const other = platforms.find((entry) => entry.slug === next);
    const key = other?.hero ? cards[other.hero.productId]?.image.artKey : null;
    const art = key ? getArt(key) : undefined;
    if (!art || art.variants.avif.length === 0) return;
    const middle = art.variants.avif[Math.min(2, art.variants.avif.length - 1)];
    preload(middle.src, { as: "image", type: "image/avif", imageSrcSet: artSrcSet(art.variants.avif), imageSizes: HERO_SIZES });
  };

  return (
    <section className="home-hero page" aria-labelledby={headingId}>
      <div className="home-hero__copy">
        {focus ? (
          // phones show the platform on the held-down key; the eyebrow stays there only to date a "new" headline
          <p className={released ? "home-hero__eyebrow" : "home-hero__eyebrow max-md:hidden"}>
            <PlatformLabel platform={focus} />
            {released ? (
              <span className="type-caption text-ink-2">
                {" · "}
                {t("hero.releasedOn", { date: f.date(released, "long") })}
              </span>
            ) : null}
          </p>
        ) : null}
        <h1 id={headingId} className="home-hero__title text-ink" style={{ "--em": headlineEm(headline) } as CSSProperties}>
          <BidiText text={headline} />
        </h1>
        <div className="home-hero__deck">
          {card?.subtitle ? <p className="type-body text-ink-2">{card.subtitle}</p> : null}
          {card ? (
            <div className="home-hero__keys">
              <Key as={MotionLink} nav="zoom" to={href} size="lg">
                {t("hero.details")}
              </Key>
              <AddToCartKey
                variant="key"
                size="lg"
                item={{ variantId: card.variantId }}
                name={card.name}
                stock={card.stock}
                chooseHref={card.hasVariants ? href : null}
                image={card.image}
                source={stageImage}
              />
            </div>
          ) : null}
          {deliveryFeeIqd !== null ? <DeliveryNote feeIqd={deliveryFeeIqd} /> : null}
        </div>
      </div>

      <div className="home-hero__stage">
        {card ? (
          <Stage
            size="hero"
            gel={focus}
            tag={<StageTag name={<BidiText text={card.name} />} priceIqd={card.priceIqd} />}
            action={
              <AddToCartKey
                variant="key"
                item={{ variantId: card.variantId }}
                name={card.name}
                stock={card.stock}
                chooseHref={card.hasVariants ? href : null}
                image={card.image}
                source={stageImage}
                className="md:hidden"
              />
            }
          >
            <MotionLink nav="zoom" to={href} className="home-hero__link" aria-label={card.name}>
              <SharedElement name={`product-image:${card.id}`} slot="hero" as="span" className="home-hero__shared">
                <ProductImage image={card.image} alt="" sizes={HERO_SIZES} priority={focus === firstFocus} />
              </SharedElement>
            </MotionLink>
          </Stage>
        ) : (
          <Stage size="hero" gel={null}>
            <div className="home-hero__empty">
              <p className="type-sub text-ink">{t("hero.empty", { platform: phrase })}</p>
              {focus ? (
                <TextLink as={LocaleLink} to={`/platform/${focus}`}>
                  {t("hero.emptyAction", { platform: phrase })}
                </TextLink>
              ) : null}
            </div>
          </Stage>
        )}
      </div>

      {platforms.length > 0 ? (
        <div className="home-hero__bank">
          <PlatformBank value={focus} onChange={onFocus} onIntent={prefetch} platforms={platforms.map((entry) => entry.slug)} />
        </div>
      ) : null}
    </section>
  );
}
