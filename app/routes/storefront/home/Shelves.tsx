/**
 * The home page below the hero — Design System v2 §6.1, in its order:
 *
 *   PlatformDoors      «تسوّق حسب المنصّة»: the four platform tiles (2×2 on phones, 4-up from 768) with their real counts
 *   TrustFacts         the trust strip: only facts that are true in the settings (delivery fee, COD, transfers, guest)
 *   NewArrivals        «وصل حديثاً»: platform dot chips that filter the shelf in place (`?platform=`, no request) and
 *                      a rail of cards (5-up whole cards from 1280); never a «جديد» badge inside this shelf
 *   Releases           the release band «قريباً» (only with ≥ 2 dated items): no countdown, no pre-order key
 *   UsedShelf          «مستعمل ومفحوص»: used units (a rail on phones), «كل المستعمل»
 *   ServiceEntries     two entry cards: trade-in and support
 *   Departments        «تسوّق حسب القسم»: category tiles with their counts (3 → 6 columns)
 *   RecentlyViewed     the shopper's ONE list (./personal.ts), only with consent and ≥ 3 items
 *   RecommendationShelves   the devices area's personal shelf (streamed by the loader, consent only)
 *
 * Every shelf says the rule it follows, never "trending" or "customers also bought": the store has no such data.
 * An empty shelf is not drawn.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import type { ProductCardData, UsedUnitCardData } from "~/lib/dto";
import { Bubble, BubbleGroup } from "~/motion";
import { RecommendationShelves as SharedRecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";
import { sheetCategories } from "~/routes/storefront/shell/chrome";
import { usePlatformName } from "~/routes/storefront/shell/MegaMenu";
import type { NavCategory, NavPlatform, ShellPayments } from "~/routes/storefront/shell/types";
import type { ComingSoonItem } from "~/server/services/home.server";
import { CategoryTile, CategoryTiles } from "~/ui/CategoryTile";
import { ChipGroup } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { EntryCard } from "~/ui/EntryCard";
import { ErrorState } from "~/ui/ErrorState";
import { isPlatform, type Gel, type Platform } from "~/ui/PlatformLed";
import { PlatformTile, PlatformTiles } from "~/ui/PlatformTile";
import { ProductCard } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { ReleaseBand, type ReleaseItem } from "~/ui/ReleaseBand";
import { SectionHead } from "~/ui/SectionHead";
import { ShelfRail } from "~/ui/ShelfRail";
import { TextLink } from "~/ui/TextLink";
import { TrustStrip } from "~/ui/TrustStrip";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { toast } from "~/ui/toast-store";
import { forgetRecentlyViewed, handDeviceListToAccount, readRecentlyViewed } from "./personal";
import { MIN_SHELF, RELEASE_LIMIT, tileArt } from "./view";

/** How wide a card's picture is drawn: 2.15 cards on phones, 3.2 from 768, 4-up from 1024, 5-up (240px) from 1280. */
const CARD_SIZES = "(min-width: 1280px) 240px, (min-width: 1024px) 22vw, (min-width: 768px) 30vw, 46vw";

// ───────────────────────────────────────────────────────────────── platform tiles

export function PlatformDoors({ platforms, heroArt }: { platforms: readonly NavPlatform[]; heroArt: string | null }) {
  const t = useT("home");
  const nameOf = usePlatformName();
  const id = useId();
  const tiles = platforms.filter((platform): platform is NavPlatform & { accent: Platform } => isPlatform(platform.accent));
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby={id} className="min-w-0">
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
    <section aria-labelledby={id} className="min-w-0">
      <VisuallyHidden as="h2" id={id}>
        {t("trust.title")}
      </VisuallyHidden>
      {/* guest checkout is how the store works (no setting turns it off); a transfer fact names both methods, so it
          stands only while both are switched on */}
      <TrustStrip deliveryIqd={deliveryFeeIqd} cod={payments?.cod ?? false} transfer={Boolean(payments?.card && payments?.zaincash)} guest />
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
    <section aria-labelledby={id} className="min-w-0" data-shelf="new-arrivals">
      <SectionHead id={id} title={t("shelf.newArrivals")} reason={t("shelf.newArrivalsReason")} href={`/platform/${current.platform}?sort=newest`} chips={chips} />
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

/** What a coming-soon product's card says about its platform (looked up by the loader), by product id. */
export type ReleasePlatform = { platform: Gel | null; label: string | null };

export function Releases({ items, platforms, now }: { items: readonly ComingSoonItem[]; platforms: Readonly<Record<string, ReleasePlatform>>; now: number }) {
  const t = useT("home");
  if (items.length < 2) return null;
  const releases: ReleaseItem[] = items.slice(0, RELEASE_LIMIT).map((item) => {
    // an unreleased version of a released product says so; the catalogue's version titles are not shown (they can
    // carry words the store does not use, such as «طلب مسبق»)
    const versions = item.variantCount > 0 ? t("releases.versions", { count: item.variantCount }) : null;
    const known = item.variantCount === 0 ? platforms[item.productId] : undefined;
    return {
      id: item.key,
      to: `/p/${item.slug}`,
      name: versions ? `${item.name} · ${versions}` : item.name,
      releaseAt: item.releaseAt,
      platform: known?.platform ?? null,
      platformLabel: known?.label ?? undefined,
      priceIqd: item.priceIqd,
      image: item.image,
    };
  });
  return <ReleaseBand items={releases} now={now} />;
}

// ───────────────────────────────────────────────────────────────── used and inspected

export function UsedShelf({ units }: { units: readonly UsedUnitCardData[] }) {
  const t = useT("home");
  return (
    <ShelfRail
      shelf={{ key: "used", title: t("shelf.used"), reason: t("shelf.usedReason"), items: [...units] }}
      href="/used"
      viewAllLabel={t("shelf.usedAll")}
      minItems={MIN_SHELF}
      renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" sizes={CARD_SIZES} />}
    />
  );
}

// ───────────────────────────────────────────────────────────────── trade-in and support

export function ServiceEntries({ tradeInArt }: { tradeInArt: string | null }) {
  const t = useT("home");
  return (
    <div className="home-entries">
      <EntryCard to="/trade-in" headingLevel={2} title={t("entry.tradeIn")} text={t("entry.tradeInText")} cta={t("entry.tradeInCta")} art={tradeInArt ?? "mascot"} />
      <EntryCard to="/support" headingLevel={2} title={t("entry.support")} text={t("entry.supportText")} cta={t("entry.supportCta")} art="mascot" />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── departments

/** The glyph that stands in for a department's photo until the navigation data carries one (as in the shell's sheet). */
const DEPARTMENT_GLYPH: Record<string, IconName> = {
  controllers: "game-controller",
  headsets: "headphones",
  storage: "hard-drives",
  vr: "eye",
  digital: "gift",
  accessories: "plug",
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
    <section aria-labelledby={id} className="min-w-0">
      <SectionHead id={id} title={t("categories.title")} />
      <CategoryTiles label={t("categories.title")}>
        {list.map((category) => {
          const art = (category as NavCategory & { artKey?: string | null }).artKey;
          return (
            <CategoryTile
              key={category.slug}
              to={category.href}
              label={category.label}
              count={category.count}
              art={
                art ?? (
                  <span className="absolute inset-0 grid place-items-center text-ink-2">
                    <Icon name={DEPARTMENT_GLYPH[category.kind] ?? "squares-four"} size={32} />
                  </span>
                )
              }
            />
          );
        })}
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
    <section aria-labelledby={id} className="min-w-0" data-shelf="recently-viewed">
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
  return <SharedRecommendationShelves result={result} source="home" sizes={CARD_SIZES} />;
}

/** The page's column of sections, joined by the section gap (40 → 56 → 72). */
export function Sections({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("page grid min-w-0 gap-section", className)}>{children}</div>;
}
