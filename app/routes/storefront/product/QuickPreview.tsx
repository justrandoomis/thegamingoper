/**
 * The quick-preview sheet (brief §3.8 "fast preview sheet"; DESIGN.md §9.5 "products with required options open the
 * quick-preview sheet instead of adding", §9.14 sheets). The integration pass opens it from product cards — this
 * area does not edit ~/ui/ProductCard:
 *
 *   import { QuickPreview } from "~/routes/storefront/product/QuickPreview";
 *   const [preview, setPreview] = useState<ProductCardData | null>(null);
 *   <QuickPreview slug={preview?.slug ?? ""} name={preview?.name ?? ""} card={preview} open={preview !== null} onClose={() => setPreview(null)} />
 *
 * It shows the essentials of the product page — picture, platform, name, price with the delivery fee, stock or
 * release date, the variant choice, the buy controls with fly-to-cart, three highlights — and "التفاصيل الكاملة" to
 * /p/<slug>?v=<the chosen sku>. Data comes from GET /api/product-preview/:slug (./preview.ts) with its own strings,
 * so the sheet works on any page.
 *
 * States: loading (the card's picture, name and price at once; the rest of the space reserved, no grey skeleton),
 * ready, gone (the product is no longer shown — 404), failed / offline (what failed and a retry; never endless
 * motion), and every state of the add key itself (sold out, not out yet, network failure — ~/ui/AddToCartKey).
 * The choice of variant is local to the sheet (the page behind keeps its URL).
 */
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import type { MessageTree } from "~/i18n/translate";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { MotionLink } from "~/motion";
import { galleryFor, selectVariant, type ProductPreview, type VariantDetail } from "~/server/services/catalog/product-types";
import { BuyControls } from "~/ui/AddToCartKey";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { useOnline } from "~/ui/OfflineBanner";
import { PlatformLabel } from "~/ui/PlatformLed";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { PriceTag } from "~/ui/PriceTag";
import { Sheet } from "~/ui/Sheet";
import { Tag } from "~/ui/Tag";
import { VariantNote } from "./components/Details";
import { MixedText } from "./components/MixedText";
import { PriceBlock } from "./components/PriceBlock";
import { VariantPicker } from "./components/VariantPicker";
import { ProductMessages, useProductT } from "./i18n";
import { searchFor } from "./useVariant";

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

export function QuickPreview({ slug, name, open, onClose, card, image }: QuickPreviewProps) {
  const locale = useLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [goneMessages, setGoneMessages] = useState<MessageTree | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<{
    slug: string;
    variantId: string;
  } | null>(null);
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

  const product = loaded?.slug === slug ? loaded.product : null;
  const messages = product ? loaded!.messages : goneMessages;
  // The sheet keeps its own choice of variant (the page behind keeps its URL); a new product starts at its default.
  const variant = product
    ? (product.variants.find((entry) => entry.id === (chosen?.slug === slug ? chosen.variantId : null)) ?? selectVariant(product, null))
    : null;
  const choose = (variantId: string) => setChosen({ slug, variantId });
  return (
    <ProductMessages messages={messages}>
      <Sheet
        open={open}
        onClose={onClose}
        title={<BidiText text={product?.name ?? name} />}
        presentation="side"
        sideFrom={768}
        footer={product && variant ? <DetailsLink product={product} variant={variant} /> : null}
      >
        {product && variant && (status === "ready" || status === "loading") ? (
          <PreviewBody product={product} variant={variant} onChoose={choose} />
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

/** What the opener already knows, while the rest loads — the same geometry as the loaded body's top. */
function Known({ card, image }: { card: ProductCardData | null; image: ImageRef | null }) {
  const picture = card?.image ?? image;
  return (
    <div className="grid gap-3">
      <Niche ratio="3/2">{picture ? <ProductImage image={picture} alt="" sizes="(min-width: 768px) 380px, 90vw" /> : null}</Niche>
      {card ? <PriceTag priceIqd={card.priceIqd} compareAtIqd={card.compareAtIqd} /> : null}
    </div>
  );
}

function Loading({ card, image }: { card: ProductCardData | null; image: ImageRef | null }) {
  const ui = useT("ui");
  return (
    <div className="grid gap-4" aria-busy="true">
      <Known card={card} image={image} />
      <p className="type-caption text-ink-2" role="status">
        {ui("loading")}
      </p>
      {/* the space the price, the choice and the keys will take — reserved, empty, never a grey skeleton */}
      <div className="min-h-48" aria-hidden="true" />
    </div>
  );
}

function PreviewError({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  const overlays = useT("ui-overlays");
  return <ErrorState alert title={overlays("error.title")} text={offline ? overlays("offline.generic") : overlays("error.text")} onRetry={onRetry} />;
}

function Gone() {
  const t = useProductT();
  const overlays = useT("ui-overlays");
  const title = t("preview.gone");
  return (
    <p className="flex items-start gap-2 rounded-lg bg-niche px-4 py-3 type-body text-ink" role="status">
      <Icon name="info" size={20} className="mt-0.5 shrink-0 text-info" />
      {/* the strings came with the 404 answer; without them (an odd answer) the generic failure sentence is said */}
      <span>{title === "preview.gone" ? overlays("error.title") : title}</span>
    </p>
  );
}

function DetailsLink({ product, variant }: { product: ProductPreview; variant: VariantDetail }) {
  const t = useProductT();
  return (
    <Key as={MotionLink} to={`/p/${product.slug}${searchFor("", product, variant)}`} nav="zoom" iconEnd="arrow-right" block>
      {t("preview.details")}
    </Key>
  );
}

function PreviewBody({ product, variant, onChoose }: { product: ProductPreview; variant: VariantDetail; onChoose: (variantId: string) => void }) {
  const t = useProductT();
  const reasonId = useId();
  const picture = useRef<HTMLDivElement>(null);
  const gallery = galleryFor(product, variant);
  const image = gallery.images[0] ?? null;
  const platforms = product.platform ? [product.platform] : product.forPlatforms;
  const comingSoon = variant.releaseAt !== null || product.releaseAt !== null;

  return (
    <div className="grid gap-4">
      <div ref={picture}>
        <Niche ratio="3/2" tag={comingSoon ? <Tag kind="preorder">{t("tagSoon")}</Tag> : <Tag kind="new" />}>
          {image ? <ProductImage key={image.artKey ?? image.mediaKey ?? ""} image={image} alt={image.alt} sizes="(min-width: 768px) 380px, 90vw" /> : null}
        </Niche>
      </div>
      {gallery.borrowed ? <p className="type-caption text-ink-2">{t("picker.borrowed", { label: gallery.from?.label ?? product.name })}</p> : null}
      <div className="grid gap-1.5">
        {platforms.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {platforms.map((platform) =>
              platform.gel ? (
                <PlatformLabel key={platform.slug} platform={platform.gel} />
              ) : (
                <span key={platform.slug} className="plat">
                  <bdi>{platform.name}</bdi>
                </span>
              ),
            )}
          </div>
        ) : null}
        {product.short ? (
          <p className="type-caption text-ink-2">
            <MixedText text={product.short} />
          </p>
        ) : null}
      </div>
      <PriceBlock
        variant={variant}
        variants={product.variants}
        delivery={product.delivery}
        lifecycle={product.lifecycle}
        isDemo={product.isDemo}
        reasonId={reasonId}
      />
      {product.variants.length > 1 ? (
        <VariantPicker variants={product.variants} selector={product.selector} value={variant.id} onChange={onChoose} form={false} />
      ) : null}
      <VariantNote note={variant.note} />
      <BuyControls
        item={{ variantId: variant.id }}
        name={product.name}
        stock={variant.orderable ? variant.stock : "out_of_stock"}
        image={image}
        optionsLabel={product.variants.length > 1 ? variant.label : null}
        source={() => picture.current?.querySelector("img") ?? picture.current}
        aria-describedby={variant.orderable ? undefined : reasonId}
      />
      {product.highlights.length > 0 ? (
        <ul className="grid gap-1.5">
          {product.highlights.map((item, index) => (
            <li key={index} className="flex items-start gap-2 type-caption text-ink">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" />
              <span className="min-w-0">
                <MixedText text={item} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="flex items-start gap-2 type-caption text-ink-2">
        <Icon name="truck" size={16} className="mt-0.5 shrink-0" />
        <span>{t("facts.deliveryTime")}</span>
      </p>
    </div>
  );
}
