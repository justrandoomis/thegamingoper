/**
 * What the preview frames draw (17.06): the storefront's own kit components with the UNPUBLISHED values — a page's
 * draft as <Blocks> under its title (exactly how the policy and content pages draw their text), a banner as a band,
 * a pinned hero as the hero band with the product's photo and price. Banners and pins have no storefront slot yet
 * (the storefront team draws them after its redesign), so their frames show the kit's band, said so on the page.
 * Rendered inside the frames' documents; nothing here posts or navigates.
 */
import type { L10n, Locale } from "~/lib/locales";
import type { ProductCardData } from "~/lib/dto";
import { Band } from "~/ui/Band";
import { Blocks } from "~/ui/Blocks";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import type { Gel } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { Render } from "~/ui/Stage";

const textOf = (value: L10n | null | undefined, lang: Locale) => (value ? (value[lang] ?? "").trim() || value.ar : "");

/** A page as the content pages draw it: the title, then the blocks; the Arabic text when the language has none. */
export function PagePreview({ title, blocks, lang, emptyText }: { title: L10n; blocks: Partial<Record<Locale, unknown[]>>; lang: Locale; emptyText: string }) {
  const own = blocks[lang] ?? [];
  const shown = own.length > 0 ? own : (blocks.ar ?? []);
  return (
    <article className="cms-pv-page">
      <h1 className="type-h1">{textOf(title, lang)}</h1>
      {/* the empty line is in the admin's language, the frame in the content's: isolated, so «No text yet.» keeps its stop */}
      {shown.length > 0 ? (
        <Blocks blocks={shown} />
      ) : (
        <p className="type-body text-ink-2">
          <bdi>{emptyText}</bdi>
        </p>
      )}
    </article>
  );
}

const GELS = new Set(["nintendo", "playstation", "xbox", "handheld"]);

/** The photo's place on the band: at the inline end from 768px, a 200px box at the top on phones (the words go under it). */
const MEDIA = "absolute inset-y-0 end-0 w-[42%] max-md:inset-x-0 max-md:bottom-auto max-md:h-[200px] max-md:w-auto";

/** A banner as a band: words on the band, the catalogue photo at its end, the key with its label. */
export function BannerPreview({ title, subtitle, ctaLabel, artKey, accent, lang }: { title: L10n; subtitle: L10n | null; ctaLabel: L10n | null; artKey: string | null; accent: string; lang: Locale }) {
  const platform = GELS.has(accent) ? (accent as Gel) : undefined;
  return (
    <div className="cms-pv-band">
      <Band
        kind={platform ? "platform" : "hero"}
        platform={platform}
        media={artKey ? <Render name={artKey} alt="" sizes="480px" /> : undefined}
        mediaClassName={artKey ? MEDIA : undefined}
        contact={Boolean(artKey)}
        contentClassName={artKey ? "grid max-w-[56%] gap-2 p-6 max-md:max-w-none max-md:pt-[210px]" : "grid gap-2 p-6"}
      >
        <h2 className="type-h2">{textOf(title, lang)}</h2>
        {subtitle ? <p className="type-lead">{textOf(subtitle, lang)}</p> : null}
        {ctaLabel ? (
          <div>
            <Key variant="onBand" size="sm" tabIndex={-1}>
              {textOf(ctaLabel, lang)}
            </Key>
          </div>
        ) : null}
      </Band>
    </div>
  );
}

/** A pinned hero: the headline, the product's name and price, its photo on the stage. */
export function PinPreview({ headline, deck, card, lang, buyLabel, demoPrice }: { headline: L10n; deck: L10n | null; card: ProductCardData | null; lang: Locale; buyLabel: string; demoPrice: boolean }) {
  const art = card?.image.artKey ?? card?.image.mediaKey ?? null;
  return (
    <div className="cms-pv-band">
      <Band kind="hero" media={art ? <Render name={art} alt="" sizes="(min-width: 768px) 50vw, 220px" /> : undefined} contact={Boolean(art)} contentClassName="grid max-w-[52%] gap-3 p-6 max-md:max-w-none max-md:pt-[230px] md:p-10">
        <h2 className="type-display">{textOf(headline, lang)}</h2>
        {deck ? <p className="type-lead">{textOf(deck, lang)}</p> : null}
        {card ? (
          <>
            <p className="type-card">{card.name}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Price amountIqd={card.priceIqd} size="xl" tone="onColor" approx="off" />
              {demoPrice ? <DemoNote variant="tag" what="price" onColor /> : null}
            </div>
            <div>
              <Key variant="onBand" tabIndex={-1}>
                {buyLabel}
              </Key>
            </div>
          </>
        ) : null}
      </Band>
    </div>
  );
}
