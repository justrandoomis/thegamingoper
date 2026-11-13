/**
 * "/" — the home page (Design System v2 §6.1 in v2.1's look — client notes 1–3; brief §3.1–3.2), the branded intro and
 * the optional onboarding. Area notes: docs/areas/home.md.
 *
 * Server-rendered for everyone (crawlers and returning shoppers get the page, never the intro). Top to bottom: the
 * visually hidden <h1> (the store statement — the banners' headlines are h2s because they change per campaign), the
 * hero carousel (./Hero: every platform's hero on its colour, the featured one first, then the trade-in and used
 * banners) with the icon strip of departments under it, the four platform tiles, the trust strip, «وصل حديثاً» with
 * platform chips, the release band, used and inspected, the trade-in and support doors, the departments, the personal
 * shelves (consent only) and the personalisation panel. Everything is read from the catalogue and the settings; shelves
 * say the rule they follow, never "trending". Prices and stock are demo placeholders (the shell's demo strip, and
 * «سعر تجريبي» beside each banner's price).
 *
 * The new-arrivals chip lives in the URL (`?platform=xbox`: shareable, kept by Back) and needs no request — every
 * platform's new arrivals are in the loader data, and shouldRevalidate below skips the loader when only `platform`
 * changed.
 *
 * What staff set in the content module (admin 17.01) arrives here: a pinned hero (getHomeData keeps a pin only while
 * its product can be bought and has a photo), the sections' order and what is hidden (the privacy panel always
 * shows; the trust strip follows the platform tiles when they lead, else the hero), and the banners of the home strip
 * under the trust strip (getStoreBanners: live, never demo, only links the store can open).
 *
 * "/old-name" — one path segment that is not a language — matches this route with an invalid locale (the layout
 * answers 404): a redirect staff set for that path is followed first (./content/redirect.server), and the page's
 * data is never read for it.
 *
 * First visit on this device (no `tt_intro` cookie, landed here, not a bot): the intro overlay plays above the page.
 * Platforms picked there arrange this visit; they are remembered only if the shopper says yes in the row that asks
 * afterwards (`tt_consent`, ./personal.ts). The panel at the bottom shows what is remembered and lets them change or
 * delete it, or watch the intro again.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { data, isRouteErrorResponse, useRevalidator, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/home";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { DEFAULT_LOCALE, isLocale } from "~/lib/locales";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getStoreBanners, type ShopBanner } from "~/server/services/content.server";
import { getHomeData, type HomeData, type HomePageSection } from "~/server/services/home.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { wishedAmong, wishlistWho } from "~/server/services/wishlist.server";
import { StoreBanners } from "~/routes/storefront/content/components/StoreBanners";
import { redirectIfMoved } from "~/routes/storefront/content/redirect.server";
import { usePlatformName } from "~/routes/storefront/shell/MegaMenu";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { toast } from "~/ui/toast-store";
import { HeroCarousel, type HeroSlide } from "./Hero";
import { Intro, type IntroCorner, type IntroResult, type IntroTile } from "./Intro";
import { ConsentRow, PersonalPanel, PlatformsSheet } from "./Onboarding";
import { CONSENT_COOKIE, INTRO_COOKIE, PLATFORMS_COOKIE, parseConsent, parsePlatformList, readIntroSeen, saveConsent, saveIntroSeen, sendOnboarding } from "./personal";
import { CategoryStrip, Departments, NewArrivals, PlatformDoors, Releases, RecentlyViewed, RecommendationShelves, Sections, ServiceEntries, TrustFacts, UsedShelf } from "./Shelves";
import { deviceHubFor, hasShelf, heroSlides, leadArt, MIN_SHELF, RELEASE_LIMIT, resolveFocus, stripItems, tileArt } from "./view";
import "./home.css";

/** The one "talk to a person" destination (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";

/** No navigation data: one empty list, the same on every render (the hero's banners are memoised on it). */
const NO_PLATFORMS: ShellData["nav"]["platforms"] = [];

/**
 * What the page draws, and nothing else: each platform's hero, its lead device (the console the trade-in door and the
 * intro show while a pin holds the stage) and new arrivals (with their cards), the used units and the soonest
 * releases. (The loader asks getHomeData without the games, accessories and deals shelves: `extraShelves: false`.)
 */
function forPage(data: HomeData) {
  const platforms = data.platforms.map(({ slug, name, hero, lead, newArrivals }) => ({ slug, name, hero, lead, newArrivals }));
  const cards: Record<string, ProductCardData> = {};
  for (const platform of platforms) {
    for (const id of [...(platform.hero ? [platform.hero.productId] : []), ...(platform.lead ? [platform.lead.productId] : []), ...platform.newArrivals]) {
      const card = data.cards[id];
      if (card) cards[id] = card;
    }
  }
  return { platforms, cards, used: data.used, comingSoon: data.comingSoon.slice(0, RELEASE_LIMIT), sections: data.layout.sections };
}

export async function loader({ context, params, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  // "/old-name" is this route with locale "old-name": not a page of the store (the layout answers 404 for it) — a
  // redirect staff set for the path wins; the home page's own data is never read for it
  if (params.locale !== undefined && (!isLocale(params.locale) || params.locale === DEFAULT_LOCALE)) {
    await redirectIfMoved(db, url, ctx);
    throw data({ error: "not_found" }, { status: 404 });
  }
  const consent = parseConsent(ctx.cookie(CONSENT_COOKIE));
  const prefs = {
    introSeen: ctx.cookie(INTRO_COOKIE) === "1",
    consent,
    platforms: consent === true ? parsePlatformList(ctx.cookie(PLATFORMS_COOKIE)) : [],
  };
  // the page shows no games, gear or deals shelves: the service leaves those reads out
  const [homeData, session, banners] = await Promise.all([
    getHomeData(db, { locale: ctx.locale, now: ctx.now, extraShelves: false }),
    getCustomer(ctx, db),
    // the content module's home strip: a banner that cannot be read never takes the page down with it
    getStoreBanners(db, ctx.locale, "home_strip", { now: ctx.now, origins: [ctx.origin] }).catch((error: unknown): ShopBanner[] => {
      console.error("[home] banners not read", error);
      return [];
    }),
  ]);
  const home = forPage(homeData);
  const arrivalIds = [...new Set(home.platforms.flatMap((platform) => platform.newArrivals))];
  // which new arrivals the shopper keeps in the wishlist (filled hearts); unreadable → no hearts rather than wrong ones
  const wished =
    arrivalIds.length > 0
      ? await wishedAmong(db, wishlistWho(ctx.cookie, session?.customer.id ?? null), arrivalIds).then(
          (ids) => [...ids],
          () => null,
        )
      : ([] as string[]);
  return {
    home,
    wished,
    banners,
    prefs,
    /** The request's clock: the release band counts days from it on the server and in the browser alike. */
    now: ctx.now,
    /** The chip the new arrivals start on when the URL names none: the shopper's saved platform, else the featured one. */
    defaultFocus: resolveFocus(null, home.platforms, prefs.platforms),
    /**
     * The devices area's shelf built from the shopper's own signals (getRecommendations, context "home") — only with
     * consent, and only that shelf: the store's picks would repeat the page's own shelves. Streamed, never awaited.
     */
    recommendations: recommendationsFor(db, { cookie: ctx.cookie, customerId: session?.customer.id ?? null }, { locale: ctx.locale, context: "home", platformSlugs: prefs.platforms, personalOnly: true, now: ctx.now }, 8),
    i18n: messagesFor(ctx.locale, "home"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { type: "website" });

/** Choosing another new-arrivals chip changes only `?platform=`: the page has its data already, so no loader runs. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) {
    const before = new URLSearchParams(currentUrl.search);
    const after = new URLSearchParams(nextUrl.search);
    before.delete("platform");
    after.delete("platform");
    before.sort();
    after.sort();
    if (before.toString() === after.toString()) return false;
  }
  return defaultShouldRevalidate;
}

type Prefs = Route.ComponentProps["loaderData"]["prefs"];
type RootData = { customer?: unknown; storeMode?: string } | undefined;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { home, defaultFocus, recommendations, now, wished, banners } = loaderData;
  const t = useT("home");
  const nameOf = usePlatformName();
  const shell = (useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined)?.shell ?? null;
  const root = useRouteLoaderData("root") as RootData;
  const signedIn = Boolean(root?.customer);
  const demoMode = root?.storeMode === "demo";

  // ── the new-arrivals chip: the URL, else the server's choice (same on both sides, so hydration matches)
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("platform");
  const focus: Platform | null = isPlatform(requested) && home.platforms.some((platform) => platform.slug === requested && hasShelf(platform)) ? requested : defaultFocus;
  const [firstFocus] = useState(focus);
  const setFocus = (platform: Platform) =>
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.set("platform", platform);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );

  // ── what the shopper has told us: the server's reading of the cookies, then their answers on this page
  const [prefs, setPrefs] = useState<Prefs>(loaderData.prefs);
  useEffect(() => setPrefs(loaderData.prefs), [loaderData.prefs]);

  // ── the intro: first visit on this device, landed on this page, not scrolled yet, not a crawler
  const [intro, setIntro] = useState(false);
  const [askConsent, setAskConsent] = useState<Platform[] | null>(null);
  const [platformsSheet, setPlatformsSheet] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    // landed: the first entry of this tab's history (React Router numbers entries in history.state.idx)
    const landed = ((window.history.state as { idx?: number } | null)?.idx ?? 0) === 0;
    if (loaderData.prefs.introSeen || readIntroSeen() || !landed || window.scrollY > 40) return;
    void import("isbot").then(
      ({ isbot }) => {
        if (!isbot(navigator.userAgent) && !readIntroSeen()) setIntro(true);
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decided once, on the first render in the browser
  }, []);

  const leaveIntro = ({ started, chosen: picked }: IntroResult) => {
    saveIntroSeen();
    setPrefs((current) => ({ ...current, introSeen: true }));
    if (!started || picked.length === 0) {
      void sendOnboarding({ intro: true });
      return;
    }
    const shown = picked.find((platform) => home.platforms.some((entry) => entry.slug === platform && hasShelf(entry)));
    if (shown && shown !== focus) setFocus(shown);
    if (prefs.consent === true) {
      saveConsent(true, picked);
      setPrefs((current) => ({ ...current, platforms: picked }));
      void sendOnboarding({ intro: true, platforms: picked });
      return;
    }
    void sendOnboarding({ intro: true });
    // nothing is kept yet: the row under the hero asks (only when it was never asked before)
    if (prefs.consent === null) setAskConsent(picked);
  };

  const answerConsent = (granted: boolean) => {
    const picked = askConsent ?? [];
    saveConsent(granted, granted ? picked : undefined);
    setPrefs((current) => ({ ...current, consent: granted, platforms: granted ? picked : [] }));
    void sendOnboarding({ consent: granted, platforms: granted ? picked : undefined });
    setAskConsent(null);
    toast.info(t(granted ? "consent.saved" : "consent.declined"));
  };

  const savePlatforms = (picked: Platform[]) => {
    saveConsent(true, picked);
    setPrefs((current) => ({ ...current, consent: true, platforms: picked }));
    void sendOnboarding({ consent: true, platforms: picked });
    setPlatformsSheet(false);
    const shown = picked.find((platform) => home.platforms.some((entry) => entry.slug === platform && hasShelf(entry)));
    if (shown && (focus === null || !picked.includes(focus))) setFocus(shown);
    toast.info(t("consent.saved"));
  };

  const stopRemembering = () => {
    saveConsent(false);
    setPrefs((current) => ({ ...current, consent: false, platforms: [] }));
    setAskConsent(null);
    void sendOnboarding({ consent: false });
    // the server forgets too (POST /api/onboarding consent=0): signals, and a signed-in customer's list
    toast.info(t(signedIn ? "personal.stoppedAccount" : "personal.stopped"));
  };

  // ── what the page shows
  const navPlatforms = shell?.nav.platforms ?? NO_PLATFORMS;
  const shelves = home.platforms.flatMap((platform) => {
    if (!isPlatform(platform.slug)) return [];
    const cards = platform.newArrivals.map((id) => home.cards[id]).filter((card): card is ProductCardData => card !== undefined);
    // a chip only for a shelf the page draws (v2 §4.22: three cards at least)
    return cards.length >= MIN_SHELF ? [{ platform: platform.slug, cards }] : [];
  });
  // the trade-in door shows an upright console that no tile shows: the PlayStation platform's lead device — never a
  // product staff pinned on its stage (a game is no "trade in your device")
  const playstation = home.platforms.find((platform) => platform.slug === "playstation");
  const playstationLead = leadArt(playstation, home.cards);
  const playstationTile = navPlatforms.find((platform) => platform.slug === "playstation")?.artKey ?? null;
  const tradeInArt = playstationLead ?? playstationTile;
  // the hero carousel: every platform's hero, the featured one first, then the trade-in and used banners (./view).
  // Memoised on the page's data: the banners are memoised too (./Hero), so a re-render of this page (a new-arrivals
  // chip, the consent row) leaves the carousel alone
  const slides = useMemo((): HeroSlide[] => {
    const heroCardOf = (platform: (typeof home.platforms)[number]) => (platform.hero ? home.cards[platform.hero.productId] : undefined);
    const plan = heroSlides(home.platforms, (platform) => heroCardOf(platform)?.image.artKey, { usedArt: home.used.map((unit) => unit.image.artKey), fallbackArt: tradeInArt });
    return plan.flatMap((entry): HeroSlide[] => {
      if (entry.kind !== "platform") return [entry];
      const { platform } = entry;
      const card = heroCardOf(platform);
      if (!card || !platform.hero || !isPlatform(platform.slug)) return [];
      const devices = navPlatforms.find((nav) => nav.slug === platform.slug)?.devices ?? [];
      return [{ kind: "product", key: platform.slug, card, platform: platform.slug, mode: platform.hero.mode, pin: platform.hero.pin ?? null, deviceHref: deviceHubFor(card.name, devices), demoPrice: card.isDemo || demoMode }];
    });
  }, [home, navPlatforms, tradeInArt, demoMode]);
  // the first banner's picture: a platform tile shows another view of it (v2 §7.6), on the page and in the intro
  const heroArt = slides[0]?.kind === "product" ? slides[0].card.image.artKey : null;
  const strip = stripItems(shell?.nav.categories ?? [], shell?.nav.usedCount ?? 0);
  // the intro's corner objects are the platforms' consoles: their lead devices, pinned heroes or not
  const corners: IntroCorner[] = home.platforms.flatMap((entry) => {
    const art = leadArt(entry, home.cards);
    return art && isPlatform(entry.slug) ? [{ platform: entry.slug, artKey: art }] : [];
  });
  // the intro's tiles are the page's tiles: the same pictures (stepping away from a corner object's picture would show
  // the next "angle" — for the Xbox Series X, the back of the console with its ports)
  const tiles: IntroTile[] = navPlatforms.flatMap((platform) =>
    isPlatform(platform.accent) ? [{ platform: platform.accent, name: nameOf(platform), count: platform.productCount, artKey: tileArt(platform.artKey, heroArt) }] : [],
  );

  const overlays = (
    <>
      {intro ? <Intro corners={corners} tiles={tiles} onLeave={leaveIntro} onDone={() => setIntro(false)} /> : null}
      <PlatformsSheet open={platformsSheet} initial={prefs.consent === true ? prefs.platforms : []} onSave={savePlatforms} onClose={() => setPlatformsSheet(false)} />
    </>
  );
  const consentRow = askConsent !== null && !intro ? <ConsentRow platforms={askConsent} onAnswer={answerConsent} /> : null;
  const personal = (
    <PersonalPanel consent={prefs.consent} platforms={prefs.consent === true ? prefs.platforms : []} signedIn={signedIn} onChoose={() => setPlatformsSheet(true)} onStop={stopRemembering} onReplay={() => setIntro(true)} />
  );

  if (home.platforms.length === 0) {
    // a store with no catalogue yet: say so plainly, keep the ways to help
    return (
      <div className="home">
        <VisuallyHidden as="h1">{t("title")}</VisuallyHidden>
        <Sections>
          <EmptyState
            layout="stack"
            title={t("empty.title")}
            text={t("empty.text")}
            action={
              <Key as={LocaleLink} to={HANDOFF} variant="primary">
                {t("empty.action")}
              </Key>
            }
          />
          <ServiceEntries tradeInArt={tradeInArt} />
          {personal}
        </Sections>
        {overlays}
      </div>
    );
  }

  // the sections in the order staff arranged (content module 17.01), else the page's own (home.server HOME_PAGE_SECTIONS)
  const sectionOf: Record<HomePageSection, ReactNode> = {
    platforms: <PlatformDoors platforms={navPlatforms} heroArt={heroArt} />,
    new_arrivals: <NewArrivals shelves={shelves} focus={focus} onFocus={setFocus} inflate={focus !== firstFocus} wished={wished} />,
    coming_soon: <Releases items={home.comingSoon} now={now} />,
    used: <UsedShelf units={home.used} />,
    used_repairs: <ServiceEntries tradeInArt={tradeInArt} />,
    accessories: <Departments categories={shell?.nav.categories ?? []} />,
    recently_viewed: <RecentlyViewed consent={prefs.consent} signedIn={signedIn} />,
    recommendations: <RecommendationShelves result={recommendations} consent={prefs.consent} />,
    personal,
  };
  // the trust strip follows the platform tiles when they lead (v2 §6.1), else the hero; the banners follow it
  const tilesLead = home.sections[0] === "platforms";
  const rest = tilesLead ? home.sections.slice(1) : home.sections;

  return (
    <div className="home">
      <VisuallyHidden as="h1">{t("title")}</VisuallyHidden>
      <Sections>
        {/* the first screen: the banners and, right under them, the icon strip of departments (one group, a tighter gap) */}
        <div className="home-top">
          <HeroCarousel slides={slides} />
          <CategoryStrip items={strip} />
        </div>
        {consentRow}
        {tilesLead ? sectionOf.platforms : null}
        <TrustFacts deliveryFeeIqd={shell?.deliveryFeeIqd ?? null} payments={shell?.payments ?? null} />
        <StoreBanners banners={banners} label={t("banners.label")} ctaFallback={t("banners.open")} />
        {rest.map((kind) => (
          <Fragment key={kind}>{sectionOf[kind]}</Fragment>
        ))}
      </Sections>
      {overlays}
    </div>
  );
}

/**
 * The home page could not be read (database down). The shell stays; the space says what failed and offers a retry.
 * The page's own strings came with the failed loader, so the words are the kit's (ui-overlays) and the store's name.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const common = useT("common");
  const revalidator = useRevalidator();
  return (
    <div className="home">
      <Sections>
        <h1 className="type-h1 text-ink">{common("brand.title")}</h1>
        <ErrorState layout="stack" onRetry={() => void revalidator.revalidate()} retrying={revalidator.state === "loading"} code={isRouteErrorResponse(error) ? String(error.status) : undefined} />
      </Sections>
    </div>
  );
}
