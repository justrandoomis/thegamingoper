/**
 * The reading part of the product page — design v2 spec §6.7 items 12–13, v2.1 (client note 5, G5, G7): «قبل أن تطلب»
 * (the kit's calm Note in the warning tone), highlights (the before's checked list, reading size), about the product,
 * game facts, the specification rows (label 14/600 ink-2 + the value between hairlines — a fact: 16 / 1.75 on phones
 * and tablets, 14 from 1024, product.css `.pp-fact`; the store's product code last, in caption; one line on where the
 * facts come from, the sources behind a disclosure, each title in its own language and direction) and what is in the
 * box (the retail-box photo beside a checked list). Flat on the floor: no panels around reading text.
 *
 * Every section renders nothing when its data is missing, so a product with partial data reads as a shorter page,
 * never as empty boxes. No image-credit section (credits live in the footer line and the sources disclosure).
 *
 * Mixed-script research text goes through MixedText (each Latin run isolated, brackets and separators left to the
 * sentence); short Latin NAMES that sit alone (model numbers, publishers, PEGI ratings) are isolated with <bdi>.
 */
import { useId, type ReactNode } from "react";

import { getArt, isPhoto } from "~/art";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { SourceText } from "~/routes/storefront/devices/components/SourceText";
import type { GameFacts as GameFactsData, SourceLink, SpecRow, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { ProductImage } from "~/ui/ProductCard";
import { TextLink } from "~/ui/TextLink";
import { useProductT } from "../i18n";
import { MixedText } from "./MixedText";

/** Spec keys under which the research already lists the maker's model number(s). */
const MODEL_KEYS = new Set(["model", "model_number", "modelNumber"]);

/** A titled section of the page — the title and the outline come from one place (h2 = type-h2, h3 = type-h3). */
export function Section({ title, children, className, level = 2, id }: { title: ReactNode; children: ReactNode; className?: string; level?: 2 | 3; id?: string }) {
  const auto = useId();
  const headingId = id ?? auto;
  const Heading = `h${level}` as const;
  return (
    <section aria-labelledby={headingId} className={cx("grid min-w-0 content-start gap-4", className)}>
      <Heading id={headingId} className={level === 2 ? "type-h2 text-ink" : "type-h3 text-ink"}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

/** «قبل أن تطلب»: the product's buyer note as the kit's calm Note in the warning tone (G5), when it has one. */
export function BeforeYouOrder({ text, className }: { text: string | null; className?: string }) {
  const t = useProductT();
  if (!text) return null;
  return (
    <Note tone="warning" title={t("notes")} className={className}>
      <MixedText text={text} />
    </Note>
  );
}

/** «أبرز ما فيه»: the before's checked list, in reading size (16px / 1.75). */
export function Highlights({ items, level = 2, className }: { items: readonly string[]; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (items.length === 0) return null;
  return (
    <Section title={t("highlights")} level={level} className={className}>
      <ul className="grid gap-2.5">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-3 type-read text-ink">
            <Icon name="check" size={20} className="mt-1 shrink-0 text-ok" />
            <span className="min-w-0">
              <MixedText text={item} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function About({ text, level = 2, className }: { text: string | null; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (!text) return null;
  return (
    <Section title={t("about")} level={level} className={className}>
      <p className="max-w-[65ch] type-read text-ink">
        <MixedText text={text} />
      </p>
    </Section>
  );
}

/** The retail-box photo of a product, when its gallery has one (the photo manifest's kind "in-box"). Pure. */
export function boxPhoto(images: readonly ImageRef[]): ImageRef | null {
  return (
    images.find((image) => {
      const art = image.artKey ? getArt(image.artKey) : undefined;
      return isPhoto(art) && art.kind === "in-box";
    }) ?? null
  );
}

/** «في العلبة»: a checked list beside the retail-box photo (when there is one). */
export function InTheBox({ items, image, level = 2, className }: { items: readonly string[]; image?: ImageRef | null; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (items.length === 0) return null;
  return (
    <Section title={t("inBox")} level={level} className={className}>
      <div className={cx("grid items-start gap-4", image && "grid-cols-[minmax(0,1fr)_7rem] md:grid-cols-[minmax(0,1fr)_10rem]")}>
        <ul className="grid gap-2.5">
          {items.map((item, index) => (
            <li key={index} className="flex items-start gap-3 type-read text-ink">
              <Icon name="check" size={20} className="mt-1 shrink-0 text-ok" />
              <span className="min-w-0">
                <MixedText text={item} />
              </span>
            </li>
          ))}
        </ul>
        {image ? (
          <Niche>
            <ProductImage image={image} sizes="(min-width: 768px) 160px, 112px" />
          </Niche>
        ) : null}
      </div>
    </Section>
  );
}

const FORMAT_KEY = { cartridge: "cartridge", "game-key-card": "gameKeyCard", disc: "disc", "code-in-box": "codeInBox" } as const;
const ARABIC_KEY = {
  "voice+subtitles+interface": "voiceSubtitlesInterface",
  "subtitles+interface": "subtitlesInterface",
  interface: "interface",
  none: "none",
  unknown: "unknown",
} as const;

/** "About the game": the facts a buyer needs before a game — and, plainly, what a Game-Key Card or a code in the box means. */
export function GameFacts({ game, ageRating, level = 2, className }: { game: GameFactsData; ageRating: string | null; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const age = [game.ageRating.pegi !== null ? `PEGI ${game.ageRating.pegi}` : null, game.ageRating.esrb ? `ESRB ${game.ageRating.esrb}` : null].filter(Boolean).join(" · ") || ageRating;
  const rows: { label: string; value: ReactNode }[] = [];
  if (game.platforms.length > 0) rows.push({ label: t("game.platforms"), value: <MixedText text={game.platforms.map((entry) => entry.name).join(t("separator"))} /> });
  if (game.format) rows.push({ label: t("game.format"), value: t(`game.formats.${FORMAT_KEY[game.format]}`) });
  rows.push({ label: t("game.arabic"), value: t(`game.arabicValues.${ARABIC_KEY[game.arabic]}`) });
  if (age) rows.push({ label: t("game.age"), value: <bdi dir="ltr">{age}</bdi> });
  if (game.players) rows.push({ label: t("game.players"), value: <MixedText text={game.players} /> });
  if (game.online) rows.push({ label: t("game.online"), value: <MixedText text={game.online} /> });
  if (game.sizeGb !== null) rows.push({ label: t("game.size"), value: t("game.sizeValue", { size: f.number(game.sizeGb, { maximumFractionDigits: 1 }) }) });
  if (game.genres.length > 0) rows.push({ label: t("game.genres"), value: <MixedText text={game.genres.join(t("separator"))} /> });
  if (game.developer) rows.push({ label: t("game.developer"), value: <bdi>{game.developer}</bdi> });
  if (game.publisher) rows.push({ label: t("game.publisher"), value: <bdi>{game.publisher}</bdi> });

  return (
    <Section title={t("game.title")} level={level} className={className}>
      {game.format === "game-key-card" || game.format === "code-in-box" ? (
        <Note tone="info" icon={game.format === "game-key-card" ? "key" : "download-simple"}>
          {t(game.format === "game-key-card" ? "game.keyCard" : "game.codeInBox")}
        </Note>
      ) : null}
      <Rows rows={rows} />
    </Section>
  );
}

/**
 * Rows between hairlines: the label (14/600 ink-2) at the start, the value after it — a fact in reading size on phones
 * and tablets (16 / 1.75, G7), 14 from 1024 (product.css `.pp-fact`).
 */
export function Rows({ rows, className }: { rows: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl className={cx("grid grid-cols-[minmax(6.5rem,32%)_minmax(0,1fr)] gap-x-5 border-t border-line", className)}>
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt className="border-b border-line py-3 type-sm-strong text-ink-2">{row.label}</dt>
          <dd className="pp-fact min-w-0 border-b border-line py-3 text-ink [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where the facts come from, said exactly: all sources are the maker's own sites, some are, or none is. A source is
 * the maker's when its publisher names the product's brand ("Nintendo of America" for Nintendo). Pure.
 */
export function sourceLine(sources: readonly Pick<SourceLink, "publisher">[], brand: string | null): "official" | "officialAndOthers" | "listed" {
  const mark = brand?.trim().toLowerCase();
  const official = mark ? sources.filter((source) => source.publisher?.toLowerCase().includes(mark)).length : 0;
  if (official > 0 && official === sources.length) return "official";
  return official > 0 ? "officialAndOthers" : "listed";
}

/**
 * The specification sheet as researched, then — when the research does not already list the maker's model numbers —
 * the chosen variant's model number; the store's product code last, in caption; then where the facts come from.
 */
export function Specs({
  specs,
  variant,
  sources,
  brand,
  level = 2,
  className,
}: {
  specs: readonly SpecRow[];
  variant: VariantDetail;
  sources: readonly SourceLink[];
  brand: string | null;
  level?: 2 | 3;
  className?: string;
}) {
  const t = useProductT();
  const f = useFormat();
  const rows: { label: ReactNode; value: ReactNode }[] = specs.map((spec) => ({ label: <MixedText text={spec.label} />, value: <MixedText text={spec.value} /> }));
  if (variant.modelNumber && !specs.some((spec) => MODEL_KEYS.has(spec.key))) rows.push({ label: t("specs.model"), value: <bdi dir="ltr">{variant.modelNumber}</bdi> });
  return (
    <Section title={t("specs.title")} level={level} className={className}>
      {specs.length === 0 ? <p className="pp-fact text-ink-2">{t("specs.none")}</p> : null}
      <Rows rows={rows} />
      <div className="grid gap-1">
        <p className="type-xs text-ink-2">
          {t("specs.sku")}{" "}
          <bdi dir="ltr" className="nums">
            {variant.sku}
          </bdi>
        </p>
        {sources.length > 0 ? (
          <>
            <p className="pp-fact text-ink-2">{t(`specs.${sourceLine(sources, brand)}`)}</p>
            <Disclosure summary={t("specs.sources", { n: f.number(sources.length) })} icon="book-open">
              {/* each title and publisher in its own language and direction: an Arabic or Japanese source on an English
                  page is read with its own voice (QA 2026-11-13); the publisher on its own caption line under the
                  title, so a wrapping title never splits it across two lines */}
              <ul className="pp-sources grid gap-2">
                {sources.map((source) => (
                  <li key={source.url} className="grid min-w-0 justify-items-start [overflow-wrap:anywhere]">
                    <TextLink href={source.url} external>
                      <SourceText text={source.title ?? source.url} />
                    </TextLink>
                    {source.publisher ? (
                      <span className="type-xs text-ink-2">
                        <SourceText text={source.publisher} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </>
        ) : null}
      </div>
    </Section>
  );
}
