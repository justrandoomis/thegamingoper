/**
 * The home page below the hero (DESIGN.md §8 "floor, stage, keys, shelf", §8.1 below the fold, §9.4, §9.5): every
 * section is a head (title, the honest reason it is shown, one link) and one grid or rail of the one card.
 *
 *   NewArrivals        the platform in focus, a grid (2 → 3 → 6 across), "كل PlayStation" → its hub
 *   ServicesPanel      two flat rows: used and inspected (with the real count) · repairs and help
 *   PlatformTiles      shop by platform → /platform/<slug>, with the real product count
 *   ComingSoon         pre-orders and unreleased variants with their release date — no add key (no pre-order flow)
 *   RecentlyViewed     the shopper's ONE list (./personal.ts): this device's for a guest, the account's when signed
 *                      in — only with consent, loaded after the page is on screen
 *   RecommendationShelves   the devices area's personal shelf (streamed by the loader, consent only)
 *
 * Product shelves (games, accessories, deals, used) use <ShelfRail> from the kit directly (./home.tsx).
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { Bubble, BubbleGroup, MotionLink, SharedElement } from "~/motion";
import type { ComingSoonItem } from "~/server/services/home.server";
import { RecommendationShelves as SharedRecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";
import type { NavPlatform } from "~/routes/storefront/shell/types";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { Niche } from "~/ui/Niche";
import { PlatformLabel, isPlatform, type Platform } from "~/ui/PlatformLed";
import { PriceTag } from "~/ui/PriceTag";
import { BidiText, ProductCard, ProductImage } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { Render } from "~/ui/Stage";
import { Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { forgetRecentlyViewed, handDeviceListToAccount, readRecentlyViewed } from "./personal";

const CARD_SIZES = "(min-width: 1200px) 210px, (min-width: 768px) 30vw, 46vw";

// ───────────────────────────────────────────────────────────────── a section head (the same head as <ShelfRail>)

export function SectionHead({ id, title, reason, action, level = 2 }: { id: string; title: ReactNode; reason?: ReactNode; action?: ReactNode; level?: 2 | 3 }) {
  const Heading = `h${level}` as const;
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="grid min-w-0 gap-0.5">
        <Heading id={id} className="type-section text-ink">
          {title}
        </Heading>
        {reason ? <p className="type-caption text-ink-2">{reason}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── new arrivals (the platform in focus)

export function NewArrivals({
  cards,
  title,
  reason,
  href,
  linkLabel,
  busyKey,
  inflate,
}: {
  cards: ProductCardData[];
  title: string;
  reason: string;
  href: string | null;
  linkLabel: string;
  /** Changes with the platform in focus: the grid is rebuilt and its cards inflate in. */
  busyKey: string;
  /** The cards arrive after the page is on screen (another platform was lit): let them inflate. */
  inflate: boolean;
}) {
  const id = useId();
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3" data-shelf="new-arrivals">
      <SectionHead
        id={id}
        title={title}
        reason={reason}
        action={
          href ? (
            <TextLink as={LocaleLink} to={href}>
              {linkLabel}
            </TextLink>
          ) : null
        }
      />
      <BubbleGroup as="ul" key={busyKey} className="grid grid-cols-2 gap-x-[var(--gap-card)] gap-y-6 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card, index) => (
          <Bubble as="li" key={card.id} index={index} always={inflate} className="flex min-w-0">
            <ProductCard card={card} slot="new" headingLevel={3} sizes={CARD_SIZES} />
          </Bubble>
        ))}
      </BubbleGroup>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── used + support (§8.1 "a two-row flat panel")

export function ServicesPanel({ usedCount }: { usedCount: number | null }) {
  const t = useT("home");
  const id = useId();
  return (
    <section aria-labelledby={id} className="home-services">
      <h2 id={id} className="sr-only">
        {t("services.title")}
      </h2>
      <ul className="panel home-services__list">
        <li>
          <LocaleLink to="/used" className="home-row">
            <span className="home-row__icon" aria-hidden="true">
              <Icon name="recycle" size={22} />
            </span>
            <span className="home-row__text">
              <span className="type-strong text-ink">{t("services.usedTitle")}</span>
              {usedCount !== null ? <span className="type-caption text-ink-2">{t("services.usedCount", { count: usedCount })}</span> : null}
            </span>
            <Icon name="arrow-right" size={18} className="home-row__arrow" />
          </LocaleLink>
        </li>
        <li>
          <LocaleLink to="/support" className="home-row">
            <span className="home-row__icon" aria-hidden="true">
              <Icon name="wrench" size={22} />
            </span>
            <span className="home-row__text">
              <span className="type-strong text-ink">{t("services.supportTitle")}</span>
              <span className="type-caption text-ink-2">{t("services.supportText")}</span>
            </span>
            <Icon name="arrow-right" size={18} className="home-row__arrow" />
          </LocaleLink>
        </li>
      </ul>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── shop by platform (§9.4 category cards)

export function PlatformTiles({ platforms }: { platforms: readonly NavPlatform[] }) {
  const t = useT("home");
  const id = useId();
  const tiles = platforms.filter((platform): platform is NavPlatform & { slug: Platform } => isPlatform(platform.slug));
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3">
      <SectionHead id={id} title={t("platforms.title")} />
      <Rail aria-labelledby={id} itemClassName="flex w-[31%] md:w-[23.5%]" railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
        {tiles.map((platform) => (
          <MotionLink key={platform.slug} nav="zoom" to={platform.href} className="home-tile" data-gel={platform.slug}>
            <Niche as="span" ratio="1/1" tagZone={false}>
              {platform.artKey ? <Render name={platform.artKey} alt="" sizes="(min-width: 768px) 22vw, 30vw" pose={0} /> : null}
            </Niche>
            <span className="home-tile__label">
              <PlatformLabel platform={platform.slug} className="type-strong text-ink" />
            </span>
            <span className="type-caption text-ink-2">{t("platforms.count", { count: platform.productCount })}</span>
          </MotionLink>
        ))}
      </Rail>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── coming soon

function ComingSoonCard({ item }: { item: ComingSoonItem }) {
  const t = useT("home");
  const f = useFormat();
  const href = `/p/${item.slug}`;
  const detail = item.variantCount > 1 ? t("coming.variants", { count: item.variantCount }) : item.detail;
  return (
    <article className="relative flex w-full min-w-0 flex-col" data-product={item.productId}>
      <MotionLink nav="zoom" to={href} className="flex flex-col gap-2 rounded-lg after:absolute after:inset-0 after:content-['']">
        <SharedElement name={`product-image:${item.productId}`} slot={`coming-${item.key}`} as="span" className="block">
          <Niche as="span" tag={<Tag kind="preorder">{t("coming.tag")}</Tag>}>
            <ProductImage image={item.image} alt="" sizes={CARD_SIZES} />
          </Niche>
        </SharedElement>
        <span className="line-clamp-2 min-h-[2lh] type-strong text-ink">
          <BidiText text={item.name} />
        </span>
      </MotionLink>
      {/* plain text, like the product card's fact line: the bidi algorithm keeps "25,000" whole */}
      {detail ? <p className="line-clamp-2 type-caption text-ink-2">{detail}</p> : null}
      <p className="mt-1 flex items-center gap-1.5 type-caption font-medium text-ink">
        <Icon name="calendar-blank" size={16} />
        <span>{t("coming.date", { date: f.date(item.releaseAt, "long") })}</span>
      </p>
      <div className="mt-auto pt-1.5">
        <PriceTag priceIqd={item.priceIqd} />
      </div>
    </article>
  );
}

export function ComingSoon({ items }: { items: readonly ComingSoonItem[] }) {
  const t = useT("home");
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3" data-shelf="coming-soon">
      <SectionHead id={id} title={t("shelf.comingSoon")} reason={t("shelf.comingSoonReason")} />
      <Rail aria-labelledby={id} railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
        {items.map((item) => (
          <ComingSoonCard key={item.key} item={item} />
        ))}
      </Rail>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── recently viewed (one store, with consent)

type RecentState = { status: "idle" | "loading" | "ready" | "error"; cards: ProductCardData[] };

/**
 * The shopper's ONE recently-viewed list (./personal.ts): a guest's lives on this device; a signed-in customer's in
 * the account (this device's guest list is handed over first, once, then leaves the device). Loaded after the page is
 * on screen; nothing without consent.
 */
export function RecentlyViewed({ consent, signedIn }: { consent: boolean | null; signedIn: boolean }) {
  const t = useT("home");
  const locale = useLocale();
  const id = useId();
  const [state, setState] = useState<RecentState>({ status: "idle", cards: [] });
  const request = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++request.current;
    let url: string;
    if (signedIn) {
      await handDeviceListToAccount();
      url = `/api/recently-viewed?scope=account&locale=${locale}`;
    } else {
      const ids = readRecentlyViewed().map((entry) => entry.id);
      if (ids.length === 0) {
        if (ticket === request.current) setState({ status: "ready", cards: [] });
        return;
      }
      url = `/api/recently-viewed?ids=${encodeURIComponent(ids.join(","))}&locale=${locale}`;
    }
    if (ticket === request.current) setState((current) => ({ ...current, status: "loading" }));
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
      const body = (await response.json()) as { ok: boolean; cards?: ProductCardData[] };
      if (!response.ok || !body.ok || !Array.isArray(body.cards)) throw new Error(`recently viewed: ${response.status}`);
      if (ticket === request.current) setState({ status: "ready", cards: body.cards });
    } catch {
      if (ticket === request.current) setState({ status: "error", cards: [] });
    }
  }, [locale, signedIn]);

  useEffect(() => {
    if (consent === true) void load();
    else {
      request.current++;
      setState({ status: "idle", cards: [] });
    }
  }, [consent, load]);

  const clear = () => {
    request.current++;
    setState({ status: "ready", cards: [] });
    if (signedIn) {
      // the account's list (server); the device keeps nothing of a signed-in customer
      void fetch("/api/recently-viewed", { method: "POST", body: new URLSearchParams({ intent: "clear" }), credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((response) => toast.info(t(response.ok ? "shelf.recentClearedAccount" : "shelf.recentClearFailed")))
        .catch(() => toast.info(t("shelf.recentClearFailed")));
      return;
    }
    forgetRecentlyViewed();
    toast.info(t("shelf.recentCleared"));
  };

  if (consent !== true || state.status === "idle" || state.status === "loading") return null;
  if (state.status === "ready" && state.cards.length === 0) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3" data-shelf="recently-viewed">
      <SectionHead
        id={id}
        title={t("shelf.recent")}
        reason={t(signedIn ? "shelf.recentReasonAccount" : "shelf.recentReason")}
        action={
          state.status === "ready" ? (
            <TextLink as="button" type="button" arrow={false} onClick={clear}>
              {t("shelf.recentClear")}
            </TextLink>
          ) : null
        }
      />
      {state.status === "error" ? (
        <ErrorState title={t("shelf.recentFailed")} onRetry={() => void load()} />
      ) : (
        <Rail aria-labelledby={id} railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
          {state.cards.map((card, index) => (
            <Bubble key={card.id} index={index} className="flex w-full min-w-0">
              <ProductCard card={card} slot="recent" sizes={CARD_SIZES} />
            </Bubble>
          ))}
        </Rail>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── recommendations (devices area)

/**
 * The devices area's shelf built from the shopper's own signals (getRecommendations, context "home": what they looked
 * at and, signed in, their saved devices — hard compatibility filter, an honest reason line). The loader streams it
 * only with consent; it disappears the moment the shopper stops personalisation on this page.
 */
export function RecommendationShelves({ result, consent }: { result: Promise<RecommendationResult> | RecommendationResult | null; consent: boolean | null }) {
  if (consent !== true) return null;
  return <SharedRecommendationShelves result={result} source="home" sizes={CARD_SIZES} />;
}

/** Joins section elements with the section gap — a column on the floor. */
export function Sections({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("page grid min-w-0 gap-section", className)}>{children}</div>;
}
