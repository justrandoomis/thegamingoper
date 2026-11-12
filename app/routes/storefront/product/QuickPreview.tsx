/**
 * The quick look — design v2 spec §6.9: a sheet (bottom on phones, side from 768). Its header strip holds the title,
 * the text link «التفاصيل الكاملة» and close; then a 4:3 stage, the price with the demo tag, the stock-and-delivery
 * line and the version cards (swatches for photographed colours); the PINNED FOOT holds [price | «أضف إلى السلة»].
 * Adding closes nothing: the foot then says «✓ في السلة» and offers «عرض السلة (n)». Opened from cards of products
 * with options (~/ui/ProductCard — this area does not edit the kit), from the home hero, and from store-set rows:
 *
 *   import { QuickPreview } from "~/routes/storefront/product/QuickPreview";
 *   const [preview, setPreview] = useState<ProductCardData | null>(null);
 *   <QuickPreview slug={preview?.slug ?? ""} name={preview?.name ?? ""} card={preview} open={preview !== null} onClose={() => setPreview(null)} />
 *
 * Data comes from GET /api/product-preview/:slug (./preview.ts) with its own strings, so the sheet works on any page.
 * The version choice is local to the sheet (the page behind keeps its URL); «التفاصيل الكاملة» opens /p/<slug> on the
 * chosen version (`?v=`). A version that cannot be ordered says why: sold out («نفد حالياً», no key), or not out yet
 * («يصدر … · الطلب يفتح عند وصوله», no key — the store takes no pre-orders).
 *
 * States: loading (the opener's picture and price at once; the rest of the space reserved, no grey skeleton), ready,
 * gone (the product is no longer shown — 404), failed / offline (what failed and a retry; it retries by itself when the
 * connection is back; never endless motion), offline while ready (the add key goes flat with its reason), and every
 * state of the add key itself (~/ui/AddToCartKey: the failure sentence and «أعد المحاولة» beside it).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { MessageTree } from "~/i18n/translate";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { MotionLink } from "~/motion";
import { galleryFor, type ProductPreview, type VariantDetail } from "~/server/services/catalog/product-types";
import { AddToCartKey } from "~/ui/AddToCartKey";
import { BidiText } from "~/ui/BidiText";
import { useCartCount } from "~/ui/cart-client";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { ProductImage } from "~/ui/ProductCard";
import { PriceTag, SafePrice } from "~/ui/PriceTag";
import { Sheet } from "~/ui/Sheet";
import { Stage } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { PriceBlock, struckPrice, useDemoStore } from "./components/PriceBlock";
import { VariantPicker } from "./components/VariantPicker";
import { ProductMessages, useProductT } from "./i18n";
import { searchFor, shownDefault } from "./useVariant";

export type QuickPreviewProps = {
  /** The product to preview ("dualsense"). */
  slug: string;
  /** Its name — the sheet's title from the first frame. */
  name: string;
  open: boolean;
  onClose: () => void;
  /** The card it opened from: its picture and price show at once while the details load. */
  card?: ProductCardData | null;
  /** Without a card: the picture to show at once while the details load. */
  image?: ImageRef | null;
};

type Loaded = { slug: string; product: ProductPreview; messages: MessageTree };
type Status = "loading" | "ready" | "gone" | "failed" | "offline";

/** The preview answer, or why there is none. Never throws. */
export async function fetchPreview(
  slug: string,
  locale: string,
  signal?: AbortSignal,
): Promise<
  { status: "ready"; product: ProductPreview; messages: MessageTree } | { status: "gone"; messages: MessageTree | null } | { status: "failed" | "offline" }
> {
  try {
    const response = await fetch(`/api/product-preview/${encodeURIComponent(slug)}?locale=${encodeURIComponent(locale)}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      product?: ProductPreview;
      i18n?: { product?: MessageTree };
    } | null;
    if (response.ok && body?.ok && body.product && body.i18n?.product)
      return {
        status: "ready",
        product: body.product,
        messages: body.i18n.product,
      };
    if (response.status === 404) return { status: "gone", messages: body?.i18n?.product ?? null };
    return { status: "failed" };
  } catch {
    if (signal?.aborted) return { status: "failed" };
    return {
      status: typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "failed",
    };
  }
}

/** A digital code: no delivery fee is stated (the owner has not decided one for codes, spec §13 row 11). Pure. */
const isDigital = (product: Pick<ProductPreview, "kind">) => product.kind === "digital";

export function QuickPreview({ slug, name, open, onClose, card, image }: QuickPreviewProps) {
  const locale = useLocale();
  const location = useLocation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [goneMessages, setGoneMessages] = useState<MessageTree | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<{ slug: string; variantId: string } | null>(null);
  const online = useOnline();

  // (Re)load whenever it opens, for this product and language — the last answer stays on screen meanwhile.
  useEffect(() => {
    if (!open || !slug) return;
    const controller = new AbortController();
    setStatus((current) => (loaded?.slug === slug && current === "ready" ? "ready" : "loading"));
    void fetchPreview(slug, locale, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      if (answer.status === "ready") setLoaded({ slug, product: answer.product, messages: answer.messages });
      if (answer.status === "gone") setGoneMessages(answer.messages);
      setStatus(answer.status);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded` only decides what to show while reloading
  }, [open, slug, locale, attempt]);

  // Coming back online after an offline failure tries again by itself.
  useEffect(() => {
    if (open && online && status === "offline") setAttempt((n) => n + 1);
  }, [open, online, status]);

  // A navigation (the «التفاصيل الكاملة» link, Back) leaves the sheet behind.
  const opened = useRef(location.key);
  useEffect(() => {
    if (open && location.key !== opened.current) onClose();
    opened.current = location.key;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a navigation only
  }, [location.key]);

  const product = loaded?.slug === slug ? loaded.product : null;
  const messages = product ? loaded!.messages : goneMessages;
  // The sheet keeps its own choice of version (the page behind keeps its URL); a new product starts where its page would.
  const variant = product ? (product.variants.find((entry) => entry.id === (chosen?.slug === slug ? chosen.variantId : null)) ?? shownDefault(product)) : null;
  const choose = (variantId: string) => setChosen({ slug, variantId });
  const ready = product !== null && variant !== null && (status === "ready" || status === "loading");
  // one pair of ids for the body's reason sentences and the foot's key that points at them
  const base = useId();
  const ids = { reason: `ql-reason-${base}`, offline: `ql-offline-${base}` };

  return (
    <ProductMessages messages={messages}>
      <Sheet
        open={open}
        onClose={onClose}
        title={<BidiText text={product?.name ?? name} />}
        description={ready ? <DetailsLink product={product} variant={variant} /> : null}
        presentation="side"
        sideFrom={768}
        footer={ready ? <QuickFoot product={product} variant={variant} offline={!online} ids={ids} /> : null}
      >
        {ready ? (
          <PreviewBody product={product} variant={variant} onChoose={choose} offline={!online} ids={ids} />
        ) : status === "gone" ? (
          <Gone />
        ) : status === "failed" || status === "offline" ? (
          <div className="grid gap-4">
            <Known card={card ?? null} image={image ?? null} />
            <PreviewError offline={status === "offline"} onRetry={() => setAttempt((n) => n + 1)} />
          </div>
        ) : (
          <Loading card={card ?? null} image={image ?? null} />
        )}
      </Sheet>
    </ProductMessages>
  );
}

/** The 4:3 stage of the quick look (spec §4.14: 4:3 with --r-xl "in the quick look"). */
function QuickStage({ picture, priority = false }: { picture: ImageRef | null; priority?: boolean }) {
  return (
    <Stage size="pdp" className="aspect-[4/3] rounded-xl">
      {picture ? <ProductImage key={picture.artKey ?? picture.mediaKey ?? ""} image={picture} sizes="(min-width: 768px) 388px, 92vw" priority={priority} /> : null}
    </Stage>
  );
}

/** What the opener already knows, while the rest loads — the same geometry as the loaded body's top. */
function Known({ card, image }: { card: ProductCardData | null; image: ImageRef | null }) {
  const demoStore = useDemoStore();
  const picture = card?.image ?? image;
  return (
    <div className="grid gap-4">
      <QuickStage picture={picture} />
      {card ? <PriceTag size="page" priceIqd={card.priceIqd} compareAtIqd={struckPrice({ priceIqd: card.priceIqd, compareAtIqd: card.compareAtIqd, compareAtDemo: card.compareAtDemo }, demoStore)} showSaving={!card.compareAtDemo} /> : null}
    </div>
  );
}

function Loading({ card, image }: { card: ProductCardData | null; image: ImageRef | null }) {
  const ui = useT("ui");
  return (
    <div className="grid gap-4" aria-busy="true">
      <Known card={card} image={image} />
      <p className="type-xs text-ink-2" role="status">
        {ui("loading")}
      </p>
      {/* the space the stock line and the versions will take — reserved, empty, never a grey skeleton */}
      <div className="min-h-40" aria-hidden="true" />
    </div>
  );
}

function PreviewError({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  const overlays = useT("ui-overlays");
  return <ErrorState alert offline={offline} title={overlays("error.title")} text={offline ? overlays("offline.generic") : overlays("error.text")} onRetry={onRetry} />;
}

function Gone() {
  const t = useProductT();
  const overlays = useT("ui-overlays");
  const title = t("preview.gone");
  return (
    <p className="flex items-start gap-2 py-2 type-body text-ink" role="status">
      <Icon name="info" size={20} className="mt-0.5 shrink-0 text-info" />
      {/* the strings came with the 404 answer; without them (an odd answer) the generic failure sentence is said */}
      <span>{title === "preview.gone" ? overlays("error.title") : title}</span>
    </p>
  );
}

/** «التفاصيل الكاملة ←» — the product page, on the chosen version. In the sheet's header strip. */
function DetailsLink({ product, variant }: { product: ProductPreview; variant: VariantDetail }) {
  const t = useProductT();
  return (
    <TextLink as={MotionLink} to={`/p/${product.slug}${searchFor("", product, variant)}`} nav="zoom">
      {t("preview.details")}
    </TextLink>
  );
}

type Ids = { reason: string; offline: string };

function PreviewBody({ product, variant, onChoose, offline, ids }: { product: ProductPreview; variant: VariantDetail; onChoose: (variantId: string) => void; offline: boolean; ids: Ids }) {
  const t = useProductT();
  const gallery = galleryFor(product, variant);

  return (
    <div className="grid gap-4 pb-2" data-quick-look="">
      <div data-quick-stage="">
        <QuickStage picture={gallery.images[0] ?? null} />
      </div>
      {gallery.borrowed ? <p className="type-xs text-ink-2">{t("picker.borrowed", { label: gallery.from?.label ?? product.name })}</p> : null}
      <PriceBlock
        variant={variant}
        variants={product.variants}
        delivery={product.delivery}
        lifecycle={product.lifecycle}
        isDemo={product.isDemo}
        digital={isDigital(product)}
        reasonId={ids.reason}
        offline={offline && variant.orderable}
        offlineId={ids.offline}
      />
      {product.variants.length > 1 ? <VariantPicker variants={product.variants} selector={product.selector} value={variant.id} onChange={onChoose} form={false} /> : null}
    </div>
  );
}

/**
 * The pinned foot (spec §6.9): the chosen version's price at the start and the primary «أضف إلى السلة» at the end.
 * After an add of this version: «✓ في السلة» over the price and «عرض السلة (n)» (another version restores the add key).
 * Sold out: «نفد حالياً», no key. Not out yet: «يصدر … · الطلب يفتح عند وصوله», no key. Offline: the key is flat.
 */
function QuickFoot({ product, variant, offline, ids }: { product: ProductPreview; variant: VariantDetail; offline: boolean; ids: Ids }) {
  const shop = useT("ui-shop");
  const f = useFormat();
  const { count } = useCartCount();
  const [addedFor, setAddedFor] = useState<string | null>(null);
  const added = addedFor === variant.id;
  const soon = !variant.orderable && variant.releaseAt !== null;
  const soldOut = !variant.orderable && !soon;
  const picture = galleryFor(product, variant).images[0] ?? null;

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2" data-quick-foot="">
      <div className="grid min-w-0 gap-0.5">
        {added ? (
          <span className="flex items-center gap-1 type-xs-strong text-ok">
            <Icon name="check" size={16} />
            {shop("add.inCart")}
          </span>
        ) : null}
        {soon ? (
          <span className="type-xs-strong text-ink">
            {shop("add.soonOn", { date: f.date(variant.releaseAt as number, "long") })}
            <span className="font-normal text-ink-2"> · {shop("add.soonNote")}</span>
          </span>
        ) : soldOut ? (
          <span className="type-sm-strong text-ink-2">{shop("add.soldOut")}</span>
        ) : (
          <SafePrice amountIqd={variant.priceIqd} size="lg" approx="off" as="span" />
        )}
      </div>
      {soon || soldOut ? null : added ? (
        <Key as={LocaleLink} to="/cart" variant="primary" iconEnd="arrow-right" className="min-w-[168px]">
          {shop("add.viewCartCount", { n: f.number(count) })}
        </Key>
      ) : (
        <AddToCartKey
          variant="key"
          item={{ variantId: variant.id }}
          name={product.name}
          stock={variant.stock}
          image={picture}
          optionsLabel={product.variants.length > 1 ? variant.label : null}
          source={() => document.querySelector("[data-quick-stage] img")}
          disabled={offline}
          aria-describedby={offline ? ids.offline : undefined}
          className="min-w-[168px]"
          onAdded={() => setAddedFor(variant.id)}
        />
      )}
    </div>
  );
}
