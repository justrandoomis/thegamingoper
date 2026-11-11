/**
 * "/" — the home page (brief §3.1–3.2; DESIGN.md §2, §8.1 mobile, §8.9 desktop, §8.11 tablet), the branded intro and
 * the optional onboarding. Area notes: docs/areas/home.md.
 *
 * Server-rendered for everyone (crawlers and returning shoppers get the page, never the intro). Everything on it is
 * read from the catalogue (~/server/services/home.server): the hero is a real product on the lit stage with its
 * official photo; shelves say the rule they follow ("the newest in stock"), never "trending" — the store has no sales
 * or view data to rank by. Prices and stock are demo placeholders (the shell shows the ribbon).
 *
 * The key bank lights the stage for one platform. The choice lives in the URL (`?platform=xbox`: shareable, kept by
 * Back) and needs no request — every platform's hero and shelves are in the loader data, and shouldRevalidate below
 * skips the loader when only `platform` changed.
 *
 * First visit on this device (no `tt_intro` cookie, landed here, not a bot): the intro overlay plays above the page.
 * Platforms picked there light the page for this visit; they are remembered only if the shopper says yes when asked
 * (`tt_consent`, ./personal.ts). The panel at the bottom shows what is remembered and lets them change or delete it.
 */
import { useEffect, useRef, useState } from "react";
import { isRouteErrorResponse, useRevalidator, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/home";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getHomeData } from "~/server/services/home.server";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { ProductCard } from "~/ui/ProductCard";
import { ShelfRail } from "~/ui/ShelfRail";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { toast } from "~/ui/toast-store";
import { Hero } from "./Hero";
import { Intro, type IntroCorner, type IntroResult } from "./Intro";
import { ConsentSheet, PersonalPanel, PlatformsSheet, useNames } from "./Onboarding";
import { CONSENT_COOKIE, INTRO_COOKIE, PLATFORMS_COOKIE, parseConsent, parsePlatformList, readIntroSeen, saveConsent, saveIntroSeen, sendOnboarding } from "./personal";
import { ComingSoon, NewArrivals, PlatformTiles, RecentlyViewed, RecommendationShelves, Sections, ServicesPanel } from "./Shelves";
import { gearFor, isolate, resolveFocus } from "./view";
import "./home.css";

const SHELF_SIZES = "(min-width: 1200px) 210px, (min-width: 768px) 30vw, 46vw";
const GEAR_LIMIT = 8;

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const consent = parseConsent(ctx.cookie(CONSENT_COOKIE));
  const prefs = {
    introSeen: ctx.cookie(INTRO_COOKIE) === "1",
    consent,
    platforms: consent === true ? parsePlatformList(ctx.cookie(PLATFORMS_COOKIE)) : [],
  };
  const home = await getHomeData(getDb(), { locale: ctx.locale, now: ctx.now });
  return {
    home,
    prefs,
    /** Lit when the URL names no platform: the shopper's first saved platform that has a hero, else the store's first. */
    defaultFocus: resolveFocus(null, home.platforms, prefs.platforms),
    /** INTEGRATION SLOT: the devices area's getRecommendations(…, { context: "home" }) shelves (./Shelves.tsx). */
    recommendations: [] as Shelf<ProductCardData>[],
    i18n: messagesFor(ctx.locale, "home"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { type: "website" });

/** Lighting another platform changes only `?platform=`: the page has its data already, so no loader runs. */
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

export default function Home({ loaderData }: Route.ComponentProps) {
  const { home, defaultFocus, recommendations } = loaderData;
  const t = useT("home");
  const names = useNames();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const shell = layout?.shell ?? null;

  // ── the platform in focus: the URL, else the server's choice (same on both sides, so hydration matches)
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("platform");
  const focus: Platform | null = isPlatform(requested) && home.platforms.some((platform) => platform.slug === requested) ? requested : defaultFocus;
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
  /** Platforms picked in the intro without consent: they arrange this visit only. */
  const [visitPlatforms, setVisitPlatforms] = useState<Platform[]>([]);
  const chosen: Platform[] = prefs.consent === true && prefs.platforms.length > 0 ? prefs.platforms : visitPlatforms;

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
    if (picked[0] !== focus) setFocus(picked[0]);
    if (prefs.consent === true) {
      saveConsent(true, picked);
      setPrefs((current) => ({ ...current, platforms: picked }));
      void sendOnboarding({ intro: true, platforms: picked });
      return;
    }
    setVisitPlatforms(picked);
    void sendOnboarding({ intro: true });
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
    if (focus === null || !picked.includes(focus)) setFocus(picked[0]);
    toast.info(t("consent.saved"));
  };

  const stopRemembering = () => {
    saveConsent(false);
    setPrefs((current) => ({ ...current, consent: false, platforms: [] }));
    setVisitPlatforms([]);
    void sendOnboarding({ consent: false });
    toast.info(t("personal.stopped"));
  };

  // ── what the page shows
  const cardsOf = (ids: readonly string[]) => ids.map((id) => home.cards[id]).filter((card): card is ProductCardData => card !== undefined);
  const platform = home.platforms.find((entry) => entry.slug === focus) ?? null;
  const navPlatform = shell?.nav.platforms.find((entry) => entry.slug === focus) ?? null;
  const phrase = focus ? isolate(t(`phrase.${focus}`)) : "";
  const gearChosen = chosen.length > 0 && !(chosen.length === 1 && chosen[0] === focus);
  const corners: IntroCorner[] = home.platforms.flatMap((entry) => {
    const art = entry.hero ? home.cards[entry.hero.productId]?.image.artKey : null;
    return art ? [{ platform: entry.slug, artKey: art }] : [];
  });
  const usedShelf: Shelf<(typeof home.used)[number]> = { key: "used", title: t("shelf.used"), reason: t("shelf.usedReason"), items: home.used };

  const overlays = (
    <>
      {intro ? <Intro corners={corners} platforms={home.platforms.map((entry) => entry.slug)} onLeave={leaveIntro} onDone={() => setIntro(false)} /> : null}
      <ConsentSheet open={askConsent !== null && !intro} platforms={askConsent ?? []} onAnswer={answerConsent} onDismiss={() => setAskConsent(null)} />
      <PlatformsSheet open={platformsSheet} initial={chosen} onSave={savePlatforms} onClose={() => setPlatformsSheet(false)} />
    </>
  );
  const personal = (
    <PersonalPanel consent={prefs.consent} platforms={prefs.consent === true ? prefs.platforms : []} onChoose={() => setPlatformsSheet(true)} onStop={stopRemembering} onReplay={() => setIntro(true)} />
  );

  if (home.platforms.length === 0) {
    // a store with no catalogue yet: say so plainly, keep the ways to help
    return (
      <div className="home">
        <Sections className="pt-6">
          <VisuallyHidden as="h1">{t("empty.title")}</VisuallyHidden>
          <EmptyState
            layout="stack"
            title={t("empty.title")}
            text={t("empty.text")}
            action={
              <Key as={LocaleLink} to="/contact">
                {t("empty.action")}
              </Key>
            }
          />
          <ServicesPanel usedCount={shell?.nav.usedCount ?? null} />
          {personal}
        </Sections>
        {overlays}
      </div>
    );
  }

  return (
    <div className="home">
      <Hero platforms={home.platforms} cards={home.cards} focus={focus} onFocus={setFocus} firstFocus={firstFocus} deliveryFeeIqd={shell?.deliveryFeeIqd ?? null} />
      <Sections>
        <NewArrivals
          cards={cardsOf(platform?.newArrivals ?? [])}
          title={t("shelf.newArrivals")}
          reason={t("shelf.newArrivalsReason", { platform: phrase })}
          href={focus ? `/platform/${focus}` : null}
          linkLabel={t("hero.allOf", { platform: phrase })}
          busyKey={focus ?? "none"}
          inflate={focus !== firstFocus}
        />
        <ServicesPanel usedCount={shell?.nav.usedCount ?? null} />
        <ShelfRail
          shelf={{ key: `games-${focus}`, title: t("shelf.games", { platform: phrase }), reason: t("shelf.gamesReason"), items: cardsOf(platform?.games ?? []) }}
          href={navPlatform?.games[0]?.href ?? null}
          renderItem={(card) => <ProductCard card={card} slot="games" sizes={SHELF_SIZES} />}
        />
        <ShelfRail
          shelf={{ key: "deals", title: t("shelf.deals"), reason: t("shelf.dealsReason"), items: cardsOf(home.deals) }}
          renderItem={(card) => <ProductCard card={card} slot="deals" sizes={SHELF_SIZES} />}
        />
        <ShelfRail shelf={usedShelf} href="/used" renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" sizes={SHELF_SIZES} />} />
        <ShelfRail
          shelf={{
            key: `gear-${gearChosen ? chosen.join(".") : focus}`,
            title: gearChosen ? t("shelf.gearChosen") : t("shelf.gear", { platform: phrase }),
            reason: gearChosen ? t("shelf.gearChosenReason", { platforms: names(chosen) }) : t("shelf.gearReason"),
            items: cardsOf(gearFor(home.platforms, gearChosen ? chosen : [], focus, GEAR_LIMIT)),
          }}
          renderItem={(card) => <ProductCard card={card} slot="gear" sizes={SHELF_SIZES} />}
        />
        <ComingSoon items={home.comingSoon} />
        <PlatformTiles platforms={shell?.nav.platforms ?? []} />
        <RecentlyViewed consent={prefs.consent} />
        <RecommendationShelves shelves={recommendations} />
        {personal}
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
      <Sections className="pt-6">
        <h1 className="type-title text-ink">{common("brand.title")}</h1>
        <ErrorState onRetry={() => void revalidator.revalidate()} retrying={revalidator.state === "loading"} code={isRouteErrorResponse(error) ? String(error.status) : undefined} />
      </Sections>
    </div>
  );
}
