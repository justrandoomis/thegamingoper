/**
 * /compare?ids=a&ids=b (or ids=a,b) — up to four products of one kind side by side (Design System v2 §6.5). The URL is
 * the list (ids or slugs), so a comparison is shareable and works without script; this device remembers the last list
 * (compare-client.ts, with names and pictures for the tray) and /compare opened without ids goes straight back to it.
 *
 * The table: paper, hairlines; product headers that stay under the header while the rows scroll (a 96px well, the
 * name, the price, the add button and a 44×44 «أزل»); the corner cell offers «أضف منتجاً (حتى 4)». Rows: what the
 * research says (platforms; for games Arabic support and genre), then every spec key any of the products states,
 * aligned by key — «غير موثّق» where a product's research does not say. «اعرض الفروق فقط» hides the rows where all
 * agree. Phones: two product columns, each spec's name a full-width row above its values (more products scroll
 * sideways); from 768 the names are a sticky first column.
 */
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";

import type { Route } from "./+types/compare";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useDir, useFormat, useLocalePath, useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getComparison } from "~/server/services/catalog/listing.server";
import { CardAddButton } from "~/ui/AddToCartKey";
import { BidiText, latinName } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { Switch } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { PriceTag } from "~/ui/PriceTag";
import { ProductImage, wellKind } from "~/ui/ProductCard";
import { StockNote } from "~/ui/StockNote";
import { TextLink } from "~/ui/TextLink";
import { PlatformName, TitleRow } from "./components/Hub";
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

/**
 * A product's name, two lines at most, with the card title's treatment (the kit's ProductCard): a Latin name on an
 * Arabic page is ONE left-to-right line set at the page's start edge, so the clamp's ellipsis cuts its logical end
 * («Nintendo Switch 2 – The Legend…»); laid out as a right-to-left paragraph it cut the start of line 2 instead
 * («…e Legend of Zelda –», QA 2026-11-12). A name with Arabic in it keeps the page's direction, its Latin runs isolated.
 */
function CompareName({ name }: { name: string }) {
  const title = latinName(name, useDir());
  return (
    <span dir={title.dir} className={cx("[unicode-bidi:isolate]", title.className)}>
      <BidiText text={name} />
    </span>
  );
}

/** Nothing (or nothing listed any more) in the URL: back to the list this device keeps, else the empty state. */
function NothingToCompare({ asked }: { asked: number }) {
  const t = useT("catalog");
  const saved = useCompare();
  const navigate = useNavigate();
  const localePath = useLocalePath();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const reopen = asked === 0 && saved.ids.length > 0;
  useEffect(() => {
    if (reopen) void navigate(localePath(compareHref(saved.ids)), { replace: true });
  }, [reopen, saved.ids, navigate, localePath]);

  // a list on this device (the link's products are gone): offer it — never «لا شيء للمقارنة بعد» beside a saved list.
  // v2.1: on the kit's soft card, the scales large on their disc
  const state = (keep: boolean) => {
    const open = keep && saved.ids.length > 0;
    return (
      <EmptyState
        layout="stack"
        panel
        art={<Icon name="scales" size={44} className="text-red-ink" />}
        title={open ? t("compare.allGone") : t("compare.emptyTitle")}
        text={open ? undefined : t("compare.emptyText")}
        action={
          <Key variant="primary" as={LocaleLink} to={open ? compareHref(saved.ids) : "/c/consoles"} icon={open ? "scales" : undefined}>
            {open ? t("compare.open") : t("compare.emptyAction")}
          </Key>
        }
      />
    );
  };
  return (
    <div className="page catalog-page">
      <TitleRow title={t("compare.title")} icon="scales" />
      {/* without script the saved list cannot be read: the empty state (the link's products gone, if it had any) */}
      <div className="catalog-nojs">
        {asked > 0 ? <p className="type-body text-ink-2">{t("compare.allGone")}</p> : null}
        {state(false)}
      </div>
      <div className="catalog-js-only min-h-80">
        {/* before hydration the empty state's own geometry, unseen (nothing may claim "nothing to compare" beside a saved
            list): the 320px reserve alone was shorter than the state, so the footer — on the first screen — jumped when
            it arrived (CLS 0.13–0.26 at 390 px, acceptance run 2026-11-12) */}
        {!hydrated ? (
          <div aria-hidden="true" className="invisible">
            {state(false)}
          </div>
        ) : reopen ? (
          <p className="type-body text-ink-2" role="status">
            {t("compare.opening")}
          </p>
        ) : (
          <>
            {asked > 0 && saved.ids.length === 0 ? <p className="type-body text-ink-2">{t("compare.allGone")}</p> : null}
            {state(true)}
          </>
        )}
      </div>
    </div>
  );
}

export default function ComparePage({ loaderData }: Route.ComponentProps) {
  const { comparison, asked } = loaderData;
  const t = useT("catalog");
  const f = useFormat();
  const [differences, setDifferences] = useState(false);
  const captionId = useId();

  const products = comparison?.products ?? [];
  const ids = products.map((product) => product.card.id);
  // the URL is the list: this device remembers it (keyed on the ids, not on the array's identity), with the names and
  // pictures the tray draws
  const idsKey = ids.join("|");
  const kind = comparison?.kind ?? null;
  useEffect(() => {
    if (!kind || !idsKey) return;
    syncCompare({ kind, ids: idsKey.split("|"), items: products.map(({ card }) => ({ id: card.id, name: card.name, image: card.image })) });
    // the products are what the ids name; the ids are the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, idsKey]);

  if (products.length === 0) return <NothingToCompare asked={asked} />;

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
  const canAdd = comparison!.more.length > 0 && products.length < MAX_COMPARE;

  const cell = (row: Row, value: Cell, index: number): ReactNode => {
    if (value === null) return <span className="text-ink-2">{t("compare.notStated")}</span>;
    if (typeof value === "boolean") return value ? t("compare.yes") : t("compare.no");
    if (row.key === "fact:platforms") {
      return (
        <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
          {products[index].facts.platforms.map((entry) => (
            <PlatformName key={entry.slug} slug={entry.slug} fallback={entry.name} />
          ))}
        </span>
      );
    }
    // a sentence of the research in the page's language: the browser's bidi algorithm places its Latin runs and
    // brackets right (an isolate would pull "PlayStation 5 (" apart from the Arabic it opens)
    return value;
  };

  return (
    <div className="page catalog-page">
      <TitleRow title={t("compare.title")} icon="scales">
        <p className="type-read text-ink-2">{t("compare.intro", { kind: t(`compare.kind.${comparison!.kind}`), max: f.number(MAX_COMPARE) })}</p>
      </TitleRow>

      {comparison!.missing > 0 ? <p className="type-sm text-ink-2">{t("compare.missing", { count: comparison!.missing, n: f.number(comparison!.missing) })}</p> : null}
      {comparison!.otherKind.length > 0 ? <p className="type-sm text-ink-2">{t("compare.otherKind", { names: comparison!.otherKind.map((entry) => entry.name).join("، ") })}</p> : null}

      {/* differences need two products to differ */}
      {products.length >= 2 ? (
        <div className="catalog-js-only catalog-compare__switch">
          <Switch label={t("compare.onlyDifferences")} checked={differences} onChange={(event) => setDifferences(event.target.checked)} />
        </div>
      ) : null}

      <div className={cx("catalog-compare", products.length > 2 && "catalog-compare--wide")} role="region" aria-labelledby={captionId} tabIndex={products.length > 2 ? 0 : undefined}>
        <table className="catalog-compare__table" style={{ "--n": products.length } as CSSProperties}>
          <caption id={captionId} className="sr-only">
            {t("compare.table", { kind: t(`compare.kind.${comparison!.kind}`) })}
          </caption>
          <thead>
            <tr>
              <td className="catalog-compare__corner">
                {canAdd ? (
                  <TextLink href="#catalog-compare-more" as="a" arrow={false}>
                    {t("compare.addCorner", { max: f.number(MAX_COMPARE) })}
                  </TextLink>
                ) : products.length >= MAX_COMPARE ? (
                  <span className="type-sm text-ink-2">{t("compare.fullCorner")}</span>
                ) : null}
              </td>
              {products.map(({ card }) => (
                <th key={card.id} scope="col" className="catalog-compare__product">
                  <div className="catalog-compare__head">
                    <div className="catalog-compare__top">
                      <Niche as="span" size="sm" kind={wellKind(card)} className="catalog-compare__well">
                        <ProductImage image={card.image} alt="" sizes="96px" />
                      </Niche>
                      <IconKey as={LocaleLink} to={without(card.id)} icon="x" variant="plain" className="catalog-compare__remove" label={t("compare.removeNamed", { name: card.name })} />
                    </div>
                    <LocaleLink to={`/p/${card.slug}`} className="catalog-compare__name">
                      <CompareName name={card.name} />
                    </LocaleLink>
                    <div className="catalog-compare__foot">
                      <PriceTag priceIqd={card.priceIqd} compareAtIqd={card.compareAtDemo ? null : card.compareAtIqd} size="line" approx="off" />
                      {card.stock === "out_of_stock" || card.stock === "preorder" ? null : (
                        <CardAddButton item={{ variantId: card.variantId }} name={card.name} stock={card.stock} chooseHref={card.hasVariants ? `/p/${card.slug}` : null} image={card.image} />
                      )}
                    </div>
                    {card.stock !== "in_stock" ? <StockNote stock={card.stock} /> : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          {shown.map((row) => (
            <tbody key={row.key} data-same={row.same ? "" : undefined}>
              {/* phones: the spec's name as a full-width row above its values */}
              <tr className="catalog-compare__labelrow">
                <th scope="rowgroup" colSpan={products.length}>
                  <span>{row.label}</span>
                </th>
              </tr>
              <tr>
                <th scope="row" className="catalog-compare__label">
                  {row.label}
                </th>
                {row.values.map((value, index) => (
                  <td key={products[index].card.id}>{cell(row, value, index)}</td>
                ))}
              </tr>
            </tbody>
          ))}
        </table>
      </div>
      {differences && shown.length === 0 ? <p className="type-body text-ink-2">{t("compare.noDifferences")}</p> : null}
      {/* what «غير موثّق» means: the kit's quiet line (v2.1 G5; at 13px it was the smallest text on the page) */}
      <Note variant="line" icon="info">
        {t("compare.sourceNote")}
      </Note>

      {canAdd ? (
        <section id="catalog-compare-more" aria-labelledby="catalog-compare-more-title" className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <h2 id="catalog-compare-more-title" className="type-h2 text-ink">
            {t("compare.addMore")}
          </h2>
          <ul role="list" className="catalog-compare__more">
            {comparison!.more.map((card) => (
              <li key={card.id} className="catalog-compare__candidate">
                <Niche as="span" size="sm" kind={wellKind(card)} className="w-16 shrink-0">
                  <ProductImage image={card.image} alt="" sizes="64px" />
                </Niche>
                <span className="catalog-compare__info">
                  <LocaleLink to={`/p/${card.slug}`} className="catalog-compare__name catalog-compare__name--sm">
                    <CompareName name={card.name} />
                  </LocaleLink>
                  <PriceTag priceIqd={card.priceIqd} size="line" approx="off" />
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
