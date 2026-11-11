/**
 * The reading part of the product page — flat, on the floor (DESIGN.md §0 law 5 "flat is for reading", §8.4):
 * highlights, game facts, what is in the box, the specification rows, the research notes, and where the photos and
 * facts come from. Every section renders nothing when its data is missing, so a product with partial data reads as a
 * shorter page, never as empty boxes.
 *
 * Mixed-script SENTENCES (research text: "مجموعة Prism الشفافة (Flare Orange …)") are plain text in the page's
 * direction — the browser's bidi algorithm pairs their brackets and full stops correctly. Only short Latin NAMES that
 * sit alone (model numbers, publishers, PEGI ratings) are isolated with <bdi>.
 */
import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { GameFacts as GameFactsData, ImageCredit, SourceLink, SpecRow, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { useProductT } from "../i18n";
import { MixedText } from "./MixedText";

/** Spec keys under which the research already lists the maker's model number(s). */
const MODEL_KEYS = new Set(["model", "model_number", "modelNumber"]);

/** A titled section of the page (h2) — the title and the outline come from one place. */
export function Section({ title, children, className, level = 2 }: { title: ReactNode; children: ReactNode; className?: string; level?: 2 | 3 }) {
  const id = useId();
  const Heading = `h${level}` as const;
  return (
    <section aria-labelledby={id} className={cx("grid min-w-0 content-start gap-3", className)}>
      <Heading id={id} className={level === 2 ? "type-section text-ink" : "type-sub text-ink"}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

function List({ items, icon, tone }: { items: readonly string[]; icon: "check" | "package"; tone: string }) {
  return (
    <ul className="grid gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 type-body text-ink">
          <Icon name={icon} size={18} className={cx("mt-1 shrink-0", tone)} />
          <span className="min-w-0">
            <MixedText text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Highlights({ items, level = 2, className }: { items: readonly string[]; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (items.length === 0) return null;
  return (
    <Section title={t("highlights")} level={level} className={className}>
      <List items={items} icon="check" tone="text-ok" />
    </Section>
  );
}

export function InTheBox({ items, level = 2, className }: { items: readonly string[]; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (items.length === 0) return null;
  return (
    <Section title={t("inBox")} level={level} className={className}>
      <List items={items} icon="package" tone="text-ink-2" />
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
        <p className="flex items-start gap-2.5 rounded-lg bg-niche px-4 py-3 type-body text-ink" data-notice={game.format}>
          <Icon name="download-simple" size={20} className="mt-0.5 shrink-0 text-warn" />
          <span>{t(game.format === "game-key-card" ? "game.keyCard" : "game.codeInBox")}</span>
        </p>
      ) : null}
      <Rows rows={rows} />
    </Section>
  );
}

/** Plain rows on the floor with hairlines: the label at the start, the value after it (DESIGN.md §8.4 "Specifications"). */
export function Rows({ rows, className }: { rows: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl className={cx("grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-5 type-body", className)}>
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt className="border-b border-line py-2.5 text-ink-2">{row.label}</dt>
          <dd className="min-w-0 border-b border-line py-2.5 font-medium text-ink [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The specification sheet as researched, after the store's product code and — when the research does not already
 * list the maker's model numbers — the chosen variant's model number.
 */
export function Specs({ specs, variant, level = 2, className }: { specs: readonly SpecRow[]; variant: VariantDetail; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  const rows: { label: ReactNode; value: ReactNode }[] = [
    {
      label: t("specs.sku"),
      value: (
        <bdi dir="ltr" className="nums">
          {variant.sku}
        </bdi>
      ),
    },
  ];
  if (variant.modelNumber && !specs.some((spec) => MODEL_KEYS.has(spec.key))) rows.push({ label: t("specs.model"), value: <bdi dir="ltr">{variant.modelNumber}</bdi> });
  for (const spec of specs) rows.push({ label: <MixedText text={spec.label} />, value: <MixedText text={spec.value} /> });
  return (
    <Section title={t("specs.title")} level={level} className={className}>
      <Rows rows={rows} />
      {specs.length === 0 ? <p className="type-caption text-ink-2">{t("specs.none")}</p> : null}
    </Section>
  );
}

export function Notes({ text, level = 2, className }: { text: string | null; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  if (!text) return null;
  return (
    <Section title={t("notes")} level={level} className={className}>
      <p className="flex items-start gap-2.5 rounded-lg bg-niche px-4 py-3 type-body text-ink">
        <Icon name="info" size={20} className="mt-0.5 shrink-0 text-info" />
        <span>
          <MixedText text={text} />
        </span>
      </p>
    </Section>
  );
}

/** A research note about the chosen variant (shown right under the selector). */
export function VariantNote({ note, className }: { note: string | null; className?: string }) {
  const t = useProductT();
  if (!note) return null;
  return (
    <p className={cx("flex items-start gap-2 type-caption text-ink-2", className)} aria-live="polite">
      <Icon name="info" size={16} className="mt-0.5 shrink-0" />
      <span>
        <b className="font-semibold text-ink">{t("variantNote")}:</b> <MixedText text={note} />
      </span>
    </p>
  );
}

/** Who owns the photos (official images, DESIGN.md §12) and the sources the facts were taken from. */
export function Credits({ credits, sources, className }: { credits: readonly ImageCredit[]; sources: readonly SourceLink[]; className?: string }) {
  const t = useProductT();
  if (credits.length === 0 && sources.length === 0) return null;
  const owners = credits.map((credit, index) => (
    <span key={credit.owner}>
      {index > 0 ? t("separator") : null}
      {credit.page ? (
        <TextLink href={credit.page} external inline>
          <bdi>{credit.owner}</bdi>
        </TextLink>
      ) : (
        <bdi>{credit.owner}</bdi>
      )}
    </span>
  ));
  return (
    <Section title={t("credits.title")} className={className}>
      {credits.length > 0 ? (
        <div className="grid gap-1 type-caption text-ink-2">
          <p>{fillNodes(t("credits.images"), { owners })}</p>
          <p>{t("credits.imagesNote")}</p>
        </div>
      ) : null}
      {sources.length > 0 ? (
        <Disclosure summary={t("credits.sources")} icon="book-open" variant="panel">
          <ul className="grid gap-1.5 pb-3 type-caption">
            {sources.map((source) => (
              <li key={source.url} className="min-w-0 [overflow-wrap:anywhere]">
                <TextLink href={source.url} external inline>
                  <bdi>{source.title ?? source.url}</bdi>
                </TextLink>
                {source.publisher ? (
                  <span className="text-ink-2">
                    {" · "}
                    <bdi>{source.publisher}</bdi>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Section>
  );
}
