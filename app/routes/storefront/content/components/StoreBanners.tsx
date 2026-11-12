/**
 * Banners staff publish in the content module (admin 17.01) — the store's slots for them: the home page's strip
 * (`home_strip`, under the trust strip) and the top of a category hub (`category_top`). Read with getStoreBanners
 * (~/server/services/content.server): live, never demo, at most three, and only links the store can open.
 *
 * Each banner is a showcase band (Design System v2 §4.18), as the module's preview draws it: a platform accent takes
 * that platform's surface (a lit cabinet in the dark theme), "brand" the crimson. The title (an h2, two lines at most),
 * the subtitle, the catalogue photo at the inline end, and the link as the band's white text link — never a red key:
 * the page keeps its one primary (§1.3). The words are in the banner's own language (`textLocale`): lang and dir are
 * set when it is not the page's. Another site's address opens in a new tab and says so. One column on phones; two side
 * by side from 1024 (a third takes the next row whole), three from 1280.
 */
import { useId } from "react";

import { LocaleLink, useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import type { ShopBanner } from "~/server/services/content.server";
import { Band } from "~/ui/Band";
import { BidiText } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { isPlatform } from "~/ui/PlatformLed";
import { Render } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";

export type StoreBannersProps = {
  banners: readonly ShopBanner[];
  /** Names the strip for screen readers («عروض المتجر»), in the page's own namespace. */
  label: string;
  /** The link's words when the banner has none of its own («اعرض العرض»). */
  ctaFallback: string;
  className?: string;
};

/** The photo at the inline end, standing on the band's floor; the words keep the other 60%. */
const MEDIA = "absolute inset-y-2 end-1 w-[40%] md:end-3";

export function StoreBanners({ banners, label, ctaFallback, className }: StoreBannersProps) {
  if (banners.length === 0) return null;
  return (
    <section aria-label={label} className={cx("grid min-w-0 gap-card", banners.length > 1 && "lg:grid-cols-2", banners.length > 2 && "2xl:grid-cols-3", className)} data-banners="">
      {banners.map((banner, index) => (
        // three banners on two columns (1024–1279): the third takes the whole row rather than half of it beside a hole
        <StoreBanner key={banner.id} banner={banner} ctaFallback={ctaFallback} className={banners.length === 3 && index === 2 ? "lg:col-span-2 2xl:col-span-1" : undefined} />
      ))}
    </section>
  );
}

function StoreBanner({ banner, ctaFallback, className }: { banner: ShopBanner; ctaFallback: string; className?: string }) {
  const ui = useT("ui");
  const locale = useLocale();
  const id = useId();
  const platform = isPlatform(banner.accent) ? banner.accent : undefined;
  const lang = banner.textLocale !== locale ? { lang: LOCALES[banner.textLocale].bcp47, dir: LOCALES[banner.textLocale].dir } : {};
  // the banner's own words when it has them (in its language), else the page's
  const cta = banner.ctaLabel ?? ctaFallback;
  return (
    <Band
      kind={platform ? "platform" : "hero"}
      platform={platform}
      as="article"
      aria-labelledby={id}
      className={cx("min-h-[148px] md:min-h-[168px]", className)}
      media={banner.artKey ? <Render name={banner.artKey} alt="" sizes="(min-width: 1024px) 240px, 40vw" /> : undefined}
      mediaClassName={banner.artKey ? MEDIA : undefined}
      contentClassName={cx("grid h-full content-center justify-items-start gap-1.5 p-5 md:p-6", banner.artKey && "max-w-[60%]")}
      data-banner={banner.id}
    >
      <div {...lang} className="grid gap-1.5">
        <h2 id={id} className="type-h3 line-clamp-2 text-balance">
          <BidiText text={banner.title} />
        </h2>
        {banner.subtitle ? (
          <p className="type-sm line-clamp-3">
            <BidiText text={banner.subtitle} />
          </p>
        ) : null}
      </div>
      {banner.href?.kind === "path" ? (
        <TextLink as={LocaleLink} to={banner.href.to} className="mt-1">
          <span {...(banner.ctaLabel ? lang : {})}>
            <BidiText text={cta} />
          </span>
        </TextLink>
      ) : banner.href?.kind === "external" ? (
        <TextLink as="a" href={banner.href.href} target="_blank" rel="noopener noreferrer" icon="arrow-square-out" arrow={false} className="mt-1">
          <span {...(banner.ctaLabel ? lang : {})}>
            <BidiText text={cta} />
          </span>
          <VisuallyHidden>{ui("link.external")}</VisuallyHidden>
        </TextLink>
      ) : null}
    </Band>
  );
}
