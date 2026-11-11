/**
 * /compare?ids=a&ids=b (or ids=a,b) — up to four products of one kind side by side (brief §3.6; DESIGN.md §8.7 comparison table:
 * paper, hairlines, a sticky first column, sideways scroll). The URL is the list (ids or slugs, comma-separated), so
 * a comparison is shareable and works without script; this device remembers the last list (compare-client.ts) and
 * offers it back when /compare is opened empty. Rows: what the research says (platforms; for games the devices,
 * Arabic support, format, players, age rating…), then every spec key any of the products states, aligned by key —
 * "not stated" where a product's research does not say. "Only differences" hides the rows where all agree.
 */
import { useEffect, useId, useState, type ReactNode } from "react";

import type { Route } from "./+types/compare";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getComparison } from "~/server/services/catalog/listing.server";
import { AddToCartKey } from "~/ui/AddToCartKey";
import { ProductImage } from "~/ui/ProductCard";
import { EmptyState } from "~/ui/EmptyState";
import { Switch } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { PriceTag } from "~/ui/PriceTag";
import { StockNote } from "~/ui/StockNote";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { PlatformName } from "./components/Hub";
import { compareHref, syncCompare, useCompare } from "./compare-client";
import { MAX_COMPARE } from "./listing-model";
import "./catalog.css";

const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const refs = [...new Set(url.searchParams.getAll("ids").flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => REF.test(value)))].slice(0, MAX_COMPARE * 3);
  const comparison = refs.length > 0 ? await getComparison(getDb(), ctx.locale, refs, { now: ctx.now }) : null;
  const t = serverT(ctx.locale, "catalog");
  return {
    asked: refs.length,
    comparison,
    meta: { title: t("meta.compareTitle"), description: t("meta.compare") },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: true });

type Cell = string | boolean | null;
type Row = { key: string; label: string; values: Cell[]; same: boolean };

const sameValues = (values: Cell[]) => values.length > 1 && values.every((value) => String(value ?? "∅") === String(values[0] ?? "∅"));

export default function ComparePage({ loaderData }: Route.ComponentProps) {
  const { comparison, asked } = loaderData;
  const t = useT("catalog");
  const f = useFormat();
  const saved = useCompare();
  const [differences, setDifferences] = useState(false);
  const captionId = useId();

  const products = comparison?.products ?? [];
  const ids = products.map((product) => product.card.id);
  // the URL is the list: this device remembers it (keyed on the ids, not on the array's identity)
  const idsKey = ids.join("|");
  const kind = comparison?.kind ?? null;
  useEffect(() => {
    if (kind && idsKey) syncCompare({ kind, ids: idsKey.split("|") });
  }, [kind, idsKey]);

  if (products.length === 0) {
    return (
      <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pb-12 pt-5">
        <h1 className="type-title text-ink">{t("compare.title")}</h1>
        {asked > 0 ? <p className="type-body text-ink-2">{t("compare.allGone")}</p> : null}
        {saved.ids.length > 0 ? (
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="type-body text-ink">{t("compare.saved", { count: saved.ids.length, n: f.number(saved.ids.length) })}</p>
            <Key as={LocaleLink} to={compareHref(saved.ids)} icon="scales">
              {t("compare.open")}
            </Key>
          </div>
        ) : null}
        <EmptyState
          layout="stack"
          icon="scales"
          title={t("compare.emptyTitle")}
          text={t("compare.emptyText")}
          action={
            <Key as={LocaleLink} to="/c/consoles">
              {t("compare.emptyAction")}
            </Key>
          }
        />
      </div>
    );
  }

  const without = (id: string) => compareHref(ids.filter((entry) => entry !== id));
  const arabicWords = (rank: number | null) => (rank === null ? t("compare.notKnown") : rank === 0 ? t("compare.arabicNone") : t(`filter.arabicLevel.${["", "interface", "subtitles", "voice"][rank]}`));

  // fact rows first (keys prefixed: spec keys may be called "platforms" too), then the aligned spec sheet
  const facts: Row[] = [];
  const add = (key: string, label: string, values: Cell[]) => {
    if (values.some((value) => value !== null)) facts.push({ key: `fact:${key}`, label, values, same: sameValues(values) });
  };
  const games = products.some((product) => product.facts.game);
  // games' own sheets state their platforms in detail; for everything else the store platforms are the useful fact
  if (!games) add("platforms", t("compare.platforms"), products.map((product) => product.facts.platforms.map((platform) => platform.slug).join("|") || null));
  if (games) {
    const game = products.map((product) => product.facts.game);
    add("arabic", t("filter.arabic"), game.map((g) => (g ? arabicWords(g.arabic) : null)));
    add("genres", t("compare.genres"), game.map((g) => g?.genres ?? null));
  }
  const rows: Row[] = [...facts, ...comparison!.specs];
  const shown = differences ? rows.filter((row) => !row.same) : rows;

  const cell = (row: Row, value: Cell, index: number): ReactNode => {
    if (value === null) return <span className="type-caption text-ink-2">{t("compare.notStated")}</span>;
    if (typeof value === "boolean") return value ? t("compare.yes") : t("compare.no");
    if (row.key === "fact:platforms") {
      const platform = products[index].facts.platforms;
      return (
        <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
          {platform.map((entry) => (
            <PlatformName key={entry.slug} slug={entry.slug} fallback={entry.name} />
          ))}
        </span>
      );
    }
    // a sentence of the research in the page's language: the browser's bidi algorithm places its Latin runs and
    // brackets right (names too: the kit's BidiText isolates "PlayStation 5 (" apart from the Arabic it opens)
    return value;
  };

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-5 pb-12 pt-5">
      <header className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <h1 className="type-title text-ink">{t("compare.title")}</h1>
        <p className="type-body text-ink-2">
          {t("compare.intro", { kind: t(`compare.kind.${comparison!.kind}`), max: f.number(MAX_COMPARE) })}
        </p>
      </header>

      {comparison!.missing > 0 ? <p className="type-caption text-ink-2">{t("compare.missing", { count: comparison!.missing, n: f.number(comparison!.missing) })}</p> : null}
      {comparison!.otherKind.length > 0 ? (
        <p className="type-caption text-ink-2">
          <bdi>{t("compare.otherKind", { names: comparison!.otherKind.map((entry) => entry.name).join("، ") })}</bdi>
        </p>
      ) : null}

      <div className="catalog-js-only">
        <Switch label={t("compare.onlyDifferences")} checked={differences} onChange={(event) => setDifferences(event.target.checked)} />
      </div>

      <div className="catalog-compare" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="catalog-compare__table">
          <caption id={captionId} className="sr-only">
            {t("compare.table", { kind: t(`compare.kind.${comparison!.kind}`) })}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="catalog-compare__corner">
                <VisuallyHidden>{t("compare.spec")}</VisuallyHidden>
              </th>
              {products.map(({ card }) => (
                <th key={card.id} scope="col" className="catalog-compare__product">
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-2 text-start">
                    <Niche as="span" tagZone={false}>
                      <ProductImage image={card.image} alt="" sizes="(min-width: 1024px) 220px, 40vw" />
                    </Niche>
                    <LocaleLink to={`/p/${card.slug}`} className="type-strong text-ink line-clamp-3">
                      {card.name}
                    </LocaleLink>
                    <PriceTag priceIqd={card.priceIqd} compareAtIqd={card.compareAtIqd} />
                    {card.stock !== "in_stock" ? <StockNote stock={card.stock} /> : null}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <AddToCartKey item={{ variantId: card.variantId }} name={card.name} stock={card.stock} chooseHref={card.hasVariants ? `/p/${card.slug}` : null} image={card.image} />
                      <TextLink as={LocaleLink} to={without(card.id)} arrow={false} className="type-label" aria-label={t("compare.removeNamed", { name: card.name })}>
                        {t("compare.remove")}
                      </TextLink>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.key} data-same={row.same ? "" : undefined}>
                <th scope="row" className="catalog-compare__label">
                  <bdi>{row.label}</bdi>
                </th>
                {row.values.map((value, index) => (
                  <td key={products[index].card.id}>{cell(row, value, index)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {differences && shown.length === 0 ? <p className="type-body text-ink-2">{t("compare.noDifferences")}</p> : null}
      <p className="type-caption text-ink-2">{t("compare.sourceNote")}</p>

      {comparison!.more.length > 0 && products.length < MAX_COMPARE ? (
        <section aria-labelledby="catalog-compare-more" className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <h2 id="catalog-compare-more" className="type-section text-ink">
            {t("compare.addMore")}
          </h2>
          <ul role="list" className="catalog-compare__more">
            {comparison!.more.map((card) => (
              <li key={card.id} className="flex items-center gap-3">
                <Niche as="span" ratio="1/1" tagZone={false} className="w-16 shrink-0">
                  <ProductImage image={card.image} alt="" sizes="64px" />
                </Niche>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="type-label text-ink line-clamp-2">
                    {card.name}
                  </span>
                  <PriceTag priceIqd={card.priceIqd} size="line" />
                </span>
                <Key as={LocaleLink} to={compareHref([...ids, card.id])} size="sm" icon="plus" aria-label={t("compare.addNamed", { name: card.name })}>
                  {t("compare.add")}
                </Key>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
