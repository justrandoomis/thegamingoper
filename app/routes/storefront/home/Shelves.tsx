/**
 * The home page below the hero — Design System v2 §6.1 in v2.1's look (client notes 1–4), in its order:
 *
 *   CategoryStrip      the icon strip right under the hero (the client's reference): glass icon tiles with the kinds'
 *                      line icons — consoles, games, controllers, headsets, accessories, gift cards, used, repair — only
 *                      departments that exist, each to its real listing (one scrolling row of tiles below 1024, one
 *                      row of compact clay pills from 1024 — lead decision 2)
 *   PlatformDoors      «تسوّق حسب المنصّة»: the four platform tiles (2×2 on phones, 4-up from 768) with their real counts,
 *                      on the ambient light
 *   TrustFacts         the trust strip: only facts that are true in the settings (delivery fee, COD, transfers, guest)
 *   NewArrivals        «وصل حديثاً»: platform dot chips that filter the shelf in place (`?platform=`, no request) and
 *                      a rail of cards (5-up whole cards from 1280); never a «جديد» badge inside this shelf
 *   Releases           the release band «قريباً» (only with ≥ 2 dated items): no countdown, no pre-order key
 *   UsedShelf          «مستعمل ومفحوص»: used units (a rail on phones), «كل المستعمل»
 *   ServiceEntries     two entry cards: trade-in and support
 *   Departments        «تسوّق حسب القسم»: category tiles with their photos and counts (3 → 6 columns)
 *   RecentlyViewed     the shopper's ONE list (./personal.ts), only with consent and ≥ 3 items
 *   RecommendationShelves   the devices area's personal shelf (streamed by the loader, consent only)
 *
 * A section head that leads to a listing carries a clay «عرض الكل» key (`ViewAll`). Every section below the first
 * screen fades up as it arrives, the doors one after another (~/ui/reveal: nothing above the fold moves, nothing hides
 * before JavaScript, none under reduced motion). Every shelf says the rule it follows, never "trending" or "customers
 * also bought": the store has no such data. An empty shelf is not drawn.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import type { ProductCardData, UsedUnitCardData } from "~/lib/dto";
import { Bubble, BubbleGroup } from "~/motion";
import { RecommendationShelves as SharedRecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";
import { IconTile } from "~/routes/storefront/shell/CategoriesSheet";
import { sheetCategories } from "~/routes/storefront/shell/chrome";
import { usePlatformName } from "~/routes/storefront/shell/MegaMenu";
import type { NavCategory, NavPlatform, ShellPayments } from "~/routes/storefront/shell/types";
import type { ComingSoonItem } from "~/server/services/home.server";
import { CategoryTile, CategoryTiles } from "~/ui/CategoryTile";
import { ChipGroup } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { EntryCard } from "~/ui/EntryCard";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { isPlatform, type Gel, type Platform } from "~/ui/PlatformLed";
import { PlatformTile, PlatformTiles } from "~/ui/PlatformTile";
import { ProductCard } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { ReleaseBand, type ReleaseItem } from "~/ui/ReleaseBand";
import { revealFocusedItem, revealProps } from "~/ui/reveal";
import { SectionHead } from "~/ui/SectionHead";
import { TextLink } from "~/ui/TextLink";
import { TrustStrip } from "~/ui/TrustStrip";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { toast } from "~/ui/toast-store";
import { forgetRecentlyViewed, handDeviceListToAccount, readRecentlyViewed } from "./personal";
import { MIN_SHELF, RELEASE_LIMIT, releaseItemOf, tileArt, type StripItem } from "./view";

/** How wide a card's picture is drawn: 2.15 cards on phones, 3.2 from 768, 4-up from 1024, 5-up (240px) from 1280. */
const CARD_SIZES = "(min-width: 1280px) 240px, (min-width: 1024px) 22vw, (min-width: 768px) 30vw, 46vw";

/** «عرض الكل» (or the section's own words) as a clay key at the end of a section head — v2.1 G2, client note 1. */
export function ViewAll({ to, children }: { to: string; children?: ReactNode }) {
  const shop = useT("ui-shop");
  return (
    <Key as={LocaleLink} to={to} size="sm" iconEnd="arrow-right" className="home-viewall">
      {children ?? shop("shelf.viewAll")}
    </Key>
  );
}

// ───────────────────────────────────────────────────────────────── the icon strip

/**
 * The departments as the client's reference draws them under the hero: glass icon tiles (the shell's `IconTile`, the
 * categories sheet's own tile — one look for the same doors) with the kinds' red line icons, no counts. One scrolling
 * row below 1024 (the fifth tile peeks on phones); from 1024 the same tiles drawn as one row of 48px clay pills, the
 * icon beside the name (home.css), so the platform tiles show on a laptop's first screen. Dark: glass, with the hero's
 * banner colour spilling under it (Hero.tsx `.home-hero__spill`).
 */
export function CategoryStrip({ items }: { items: readonly StripItem[] }) {
  const t = useT("home");
  if (items.length === 0) return null;
  return (
    <nav aria-label={t("strip.label")} className="home-strip">
      {/* a tile that takes the keyboard focus scrolls fully into the row (the row only, never the page): the browser's
          own scroll left the fourth tile half out of a 390px row */}
      <ul className="home-strip__list" onFocus={revealFocusedItem}>
        {items.map((item, index) => (
          <IconTile key={item.key} to={item.href} icon={item.icon} label={t(`strip.${item.key}`)} order={index} />
        ))}
      </ul>
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────── platform tiles

export function PlatformDoors({ platforms, heroArt }: { platforms: readonly NavPlatform[]; heroArt: string | null }) {
  const t = useT("home");
  const nameOf = usePlatformName();
  const id = useId();
  const tiles = platforms.filter((platform): platform is NavPlatform & { accent: Platform } => isPlatform(platform.accent));
  if (tiles.length === 0) return null;
  return (
    // the tiles stand on the ambient light (v2.1 G3: glass needs something to show; dark: the floor's colour light)
    <section aria-labelledby={id} className="home-platforms glow glow--wide min-w-0" {...revealProps()}>
      <SectionHead id={id} title={t("platforms.title")} />
      <PlatformTiles label={t("platforms.title")}>
        {tiles.map((platform) => (
          <PlatformTile
            key={platform.slug}
            platform={platform.accent}
            to={platform.href}
            name={nameOf(platform)}
            count={platform.productCount}
            art={tileArt(platform.artKey, heroArt) ?? undefined}
          />
        ))}
      </PlatformTiles>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── trust strip

export function TrustFacts({ deliveryFeeIqd, payments }: { deliveryFeeIqd: number | null; payments: ShellPayments | null }) {
  const t = useT("home");
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0" {...revealProps()}>
      <VisuallyHidden as="h2" id={id}>
        {t("trust.title")}
      </VisuallyHidden>
      {/* guest checkout is how the store works (no setting turns it off); the transfer fact names the methods that
          are switched on — both, or the one that is */}
      <TrustStrip deliveryIqd={deliveryFeeIqd} cod={payments?.cod ?? false} transfer={{ zaincash: payments?.zaincash ?? false, card: payments?.card ?? false }} guest />
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── new arrivals

export type NewArrivalsProps = {
  /** The platforms whose new arrivals the chips offer, in the store's order, with their cards. */
  shelves: readonly { platform: Platform; cards: ProductCardData[] }[];
  focus: Platform | null;
  onFocus: (platform: Platform) => void;
  /** The cards arrive after the page is on screen (another chip was chosen): let them bubble in. */
  inflate: boolean;
  /** Product ids the shopper keeps in the wishlist (filled hearts); null when it could not be read — no hearts then. */
  wished: readonly string[] | null;
};

/** A card inside «وصل حديثاً» never says «جديد» — the whole shelf is new (v2 §4.7). */
function withoutNewBadge(card: ProductCardData): ProductCardData {
  return card.badge === "new" || card.isNew ? { ...card, badge: card.badge === "new" ? null : card.badge, isNew: false } : card;
}

export function NewArrivals({ shelves, focus, onFocus, inflate, wished }: NewArrivalsProps) {
  const t = useT("home");
  const ui = useT("ui");
  const id = useId();
  const kept = new Set(wished ?? []);
  const current = shelves.find((shelf) => shelf.platform === focus) ?? shelves[0];
  if (!current || current.cards.length < MIN_SHELF) return null;
  const chips =
    shelves.length > 1 ? (
      <ChipGroup
        rail
        bleed
        aria-label={t("shelf.platformChips")}
        options={shelves.map((shelf) => ({ value: shelf.platform, label: ui(`platform.${shelf.platform}`), platform: shelf.platform as Gel }))}
        value={current.platform}
        onChange={(value) => {
          if (isPlatform(value)) onFocus(value);
        }}
      />
    ) : undefined;
  return (
    <section aria-labelledby={id} className="min-w-0" data-shelf="new-arrivals" {...revealProps()}>
      <SectionHead id={id} title={t("shelf.newArrivals")} reason={t("shelf.newArrivalsReason")} action={<ViewAll to={`/platform/${current.platform}?sort=newest`} />} chips={chips} />
      <BubbleGroup key={current.platform}>
        <Rail aria-labelledby={id}>
          {current.cards.map((card, index) => (
            <Bubble key={card.id} index={index} always={inflate} className="grid h-full min-w-0">
              <ProductCard card={withoutNewBadge(card)} slot="new" sizes={CARD_SIZES} wishlist={wished !== null} wished={kept.has(card.id)} />
            </Bubble>
          ))}
        </Rail>
      </BubbleGroup>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── release band

/**
 * Every item carries its platform line (the facts come with the coming items, home.server.ts): a pre-order's from its
 * card, a dated later version's from the platform that version is for. A version says «نسخة جديدة» on the line under
 * its name (./view releaseItemOf).
 */
export function Releases({ items, now }: { items: readonly ComingSoonItem[]; now: number }) {
  const t = useT("home");
  if (items.length < 2) return null;
  const releases: ReleaseItem[] = items.slice(0, RELEASE_LIMIT).map((item) => releaseItemOf(item, (count) => t("releases.versions", { count })));
  return (
    <div className="min-w-0" {...revealProps()}>
      <ReleaseBand items={releases} now={now} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── used and inspected

/**
 * «مستعمل ومفحوص»: the kit's shelf (head, honest reason line, rail) with the clay «عرض الكل» → /used — the short words
 * every head uses, so the key stays on the heading's line on a 360px phone. Hidden under 3 units.
 */
export function UsedShelf({ units }: { units: readonly UsedUnitCardData[] }) {
  const t = useT("home");
  const id = useId();
  if (units.length < MIN_SHELF) return null;
  return (
    <section aria-labelledby={id} className="min-w-0" data-shelf="used" {...revealProps()}>
      <SectionHead id={id} title={t("shelf.used")} reason={t("shelf.usedReason")} action={<ViewAll to="/used" />} />
      <Rail aria-labelledby={id}>
        {units.map((unit) => (
          <UsedUnitCard key={unit.id} unit={unit} slot="used" sizes={CARD_SIZES} />
        ))}
      </Rail>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── trade-in and support

export function ServiceEntries({ tradeInArt }: { tradeInArt: string | null }) {
  const t = useT("home");
  return (
    <div className="home-entries" {...revealProps({ stagger: true })}>
      <EntryCard to="/trade-in" headingLevel={2} title={t("entry.tradeIn")} text={t("entry.tradeInText")} cta={t("entry.tradeInCta")} art={tradeInArt ?? "mascot"} />
      <EntryCard to="/support" headingLevel={2} title={t("entry.support")} text={t("entry.supportText")} cta={t("entry.supportCta")} art="mascot" />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── departments

/** The kind icon a department shows when staff gave it no photo (the kit's icon tile, as in the shell's sheet). */
const DEPARTMENT_GLYPH: Record<string, IconName> = {
  controllers: "kind-controller",
  headsets: "kind-headset",
  storage: "kind-storage",
  vr: "eye",
  digital: "kind-topup",
  accessories: "kind-accessory",
};

/** Games live under their platforms on this page (the tiles and the new arrivals): six departments, one row from 1024. */
export function homeDepartments(categories: readonly NavCategory[]): NavCategory[] {
  return sheetCategories(categories).filter((category) => category.kind !== "games");
}

export function Departments({ categories }: { categories: readonly NavCategory[] }) {
  const t = useT("home");
  const id = useId();
  const list = homeDepartments(categories);
  if (list.length === 0) return null;
  return (
    <section aria-labelledby={id} className="min-w-0" {...revealProps()}>
      <SectionHead id={id} title={t("categories.title")} />
      <CategoryTiles label={t("categories.title")}>
        {list.map((category) => (
          <CategoryTile
            key={category.slug}
            to={category.href}
            label={category.label}
            count={category.count}
            art={category.artKey ?? undefined}
            icon={DEPARTMENT_GLYPH[category.kind] ?? "squares-four"}
          />
        ))}
      </CategoryTiles>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── recently viewed (one store, with consent)

type RecentState = { status: "idle" | "loading" | "ready" | "error"; cards: ProductCardData[] };

/**
 * The shopper's ONE recently-viewed list (./personal.ts): a guest's lives on this device; a signed-in customer's in
 * the account (this device's guest list is handed over first, once, then leaves the device). Loaded after the page is
 * on screen; nothing without consent; drawn from three items on.
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
  if (state.status === "ready" && state.cards.length < MIN_SHELF) return null;
  return (
    <section aria-labelledby={id} className="min-w-0" data-shelf="recently-viewed" {...revealProps()}>
      <div className="sechead">
        <div className="sechead__text">
          <h2 id={id} className="sechead__title">
            {t("shelf.recent")}
          </h2>
          <p className="sechead__reason">{t(signedIn ? "shelf.recentReasonAccount" : "shelf.recentReason")}</p>
        </div>
        {state.status === "ready" ? (
          <TextLink as="button" type="button" arrow={false} onClick={clear}>
            {t("shelf.recentClear")}
          </TextLink>
        ) : null}
      </div>
      {state.status === "error" ? (
        <ErrorState title={t("shelf.recentFailed")} onRetry={() => void load()} />
      ) : (
        <BubbleGroup>
          <Rail aria-labelledby={id}>
            {state.cards.map((card, index) => (
              <Bubble key={card.id} index={index} className="grid h-full min-w-0">
                <ProductCard card={card} slot="recent" sizes={CARD_SIZES} />
              </Bubble>
            ))}
          </Rail>
        </BubbleGroup>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── recommendations (devices area)

/**
 * The devices area's shelf built from the shopper's own signals («يكمّل جهازك» and the like — getRecommendations,
 * context "home": what they looked at and, signed in, their saved devices; hard compatibility filter, an honest reason
 * line). The loader streams it only with consent; it disappears the moment the shopper stops personalisation here.
 */
export function RecommendationShelves({ result, consent }: { result: Promise<RecommendationResult> | RecommendationResult | null; consent: boolean | null }) {
  if (consent !== true) return null;
  // no reveal wrapper: the shelf streams in (bubbling in by itself) and is often nothing — an empty grid item would
  // add a section gap
  return <SharedRecommendationShelves result={result} source="home" sizes={CARD_SIZES} />;
}

/** The page's column of sections, joined by the section gap (40 → 56 → 72). */
export function Sections({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("page grid min-w-0 gap-section", className)}>{children}</div>;
}
