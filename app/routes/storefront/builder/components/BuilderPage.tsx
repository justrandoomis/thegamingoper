/**
 * The builder's page (docs/switch-builder.md §6): the step rail, the step, and — from 1024 — the sticky aside with the
 * plan so far, the space bar, the chosen games and the step keys; below 1024 the same keys in the shell's task bar
 * (with the compact space bar and «ألعابك (n)» on the games step). Never two sticky bars at one edge.
 *
 * State: the plan (./lib/use-plan: localStorage, restored after hydration), the library (./lib/use-library: the open
 * list + TamTam's data, fetched at idle on the earlier steps), the games step's search/filters/sort (kept for the
 * visit), the details sheet (the game's details chunk loads when it opens) and the review's quote (the route's action,
 * intent=quote). Every change of the plan is computed with the pure helpers (~/lib/switch-builder/plan), so a refused
 * change can say why: a game without a size, or one that does not fit (both figures, and «بطاقة أكبر» when a bigger
 * card would make room).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLocation } from "react-router";

import { LocaleLink, useFormat } from "~/i18n/react";
import { addGame, cardThatFits, biggerCardExists, encodePlan, planUsage, prunePlan, remainingWithout, removeGame, setCard, setDevice, toggleGame, type FitRefusal } from "~/lib/switch-builder/plan";
import { DEFAULT_CAPACITY, digitsToTell } from "~/lib/switch-builder/storage";
import type { BuilderCatalog, BuilderQuote, BuilderStep, GameDetails, GameFormat, LibraryExtras } from "~/lib/switch-builder/types";
import { PLAN_LIMITS } from "~/lib/switch-builder/types";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import { isolate, BidiText } from "~/ui/BidiText";
import { announce } from "~/ui/cart-client";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { LIBRARY_AS_OF } from "../library.manifest";
import { cardLabel, gbText, useBuilderT } from "../lib/format";
import { mergeLibrary, needOf, type LibraryEntry } from "../lib/library";
import { stepHref, stepIndex, stepOf } from "../lib/steps";
import { cachedGameDetails, loadGameDetails, useLibrary } from "../lib/use-library";
import { usePlan } from "../lib/use-plan";
import { tourOn, useWide } from "../lib/use-wide";
import { AddAllKey, type AddAllRefusal } from "./AddAllKey";
import { useBuilderTour } from "./BuilderTour";
import { ChosenList, ChosenSheet, type ChosenItem } from "./ChosenList";
import { DeviceStep, keepDashes } from "./DeviceStep";
import { GameSheet } from "./GameSheet";
import { GamesStep, INITIAL_VIEW, type GamesView } from "./GamesStep";
import { MemoryStep } from "./MemoryStep";
import { ReviewStep, type QuoteView } from "./ReviewStep";
import { SpaceMeter } from "./SpaceMeter";
import { StepKeys } from "./StepKeys";

const NO_EXTRAS: Readonly<Record<string, LibraryExtras>> = {};
const STEP_LIST: readonly BuilderStep[] = ["device", "memory", "games", "review"];
/** Each step's h1: where focus goes after a move between steps. */
const STEP_HEADING = { tabIndex: -1, "data-step-heading": "" } as const;

type QuoteAnswer = { ok: true; quote: BuilderQuote } | { ok: false; code: string };

export function BuilderPage({ catalog }: { catalog: BuilderCatalog }) {
  const t = useBuilderT();
  const f = useFormat();
  const location = useLocation();
  const step = stepOf(location.search);
  const wide = useWide();
  const { plan, restored, setPlan, reset } = usePlan(catalog);
  const library = useLibrary(step === "games" || step === "review" ? "now" : "idle");
  const payload = library.data?.payload ?? null;
  const extras = payload?.extras ?? NO_EXTRAS;
  const capacity = payload?.capacity ?? DEFAULT_CAPACITY;
  const entries = useMemo(() => (library.data ? mergeLibrary(library.data.list.games, extras, catalog.cartridges) : []), [library.data, extras, catalog.cartridges]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.game.id, entry])), [entries]);
  const usage = useMemo(() => planUsage(plan, extras, capacity), [plan, extras, capacity]);
  const chosen = useMemo(() => new Map<string, GameFormat>(plan.games.map((game) => [game.id, game.format])), [plan.games]);
  const chosenItems: ChosenItem[] = plan.games.flatMap((game) => {
    const entry = byId.get(game.id);
    return entry ? [{ entry, format: game.format, need: needOf(entry, game.format) }] : [];
  });
  const [view, setView] = useState<GamesView>(INITIAL_VIEW);
  const [chosenOpen, setChosenOpen] = useState(false);
  const [refusal, setRefusal] = useState<AddAllRefusal | null>(null);

  // A restored plan keeps only games the list still has, visible, with a size (a game can never join without one).
  useEffect(() => {
    if (!restored || library.status !== "ready") return;
    const next = prunePlan(plan, (game) => {
      const entry = byId.get(game.id);
      return entry !== undefined && needOf(entry, game.format) !== null;
    });
    if (next !== plan) setPlan(next);
  }, [restored, library.status, byId, plan, setPlan]);

  // ── the review's quote (the route's action; re-asked whenever the plan changed)
  const quoter = useFetcher<QuoteAnswer>();
  const encoded = encodePlan(plan);
  const quotedFor = useRef<string | null>(null);
  const [quoteOffline, setQuoteOffline] = useState(false);
  const askQuote = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setQuoteOffline(true);
      return;
    }
    setQuoteOffline(false);
    quotedFor.current = encoded;
    void quoter.submit({ intent: "quote", plan: encoded }, { method: "post" });
  };
  useEffect(() => {
    if (step !== "review" || !restored || quotedFor.current === encoded) return;
    askQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once per plan
  }, [step, restored, encoded]);
  const answer = quoter.data;
  // the request left but never reached the store while the device went offline (the route's clientAction says so)
  const answeredOffline = quoter.state === "idle" && quotedFor.current === encoded && answer !== undefined && !answer.ok && answer.code === "offline";
  const offline = quoteOffline || answeredOffline;
  useEffect(() => {
    if (!offline) return;
    const again = () => askQuote();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- askQuote reads only the plan (`encoded`): the listener asks for the current one
  }, [offline, encoded]);
  useEffect(() => setRefusal(null), [encoded]);
  // «أضف الكل» answered yes for this plan: both copies of the key (the task bar's, the aside's) say «عرض السلة», so the
  // copy that comes into view after a resize or a turned tablet never offers the same add again
  const [addedFor, setAddedFor] = useState<string | null>(null);
  const added = addedFor === encoded;
  const onAdded = () => setAddedFor(encoded);
  const quoteView: QuoteView = {
    status: quoteOffline ? "error" : quoter.state !== "idle" || quotedFor.current !== encoded ? "loading" : answer?.ok ? "ready" : answer ? "error" : "idle",
    quote: quoter.state === "idle" && quotedFor.current === encoded && answer?.ok ? answer.quote : null,
    offline,
    retry: askQuote,
  };

  // ── the details sheet
  const [sheet, setSheet] = useState<{ open: boolean; entry: LibraryEntry | null }>({ open: false, entry: null });
  const [details, setDetails] = useState<GameDetails | null | "loading" | "error">(null);
  const sheetId = useRef<string | null>(null);
  const loadDetails = (entry: LibraryEntry) => {
    const list = library.data?.list;
    sheetId.current = entry.game.id;
    if (!list) return setDetails(null);
    const cached = cachedGameDetails(entry.game.id);
    if (cached !== undefined) return setDetails(cached);
    setDetails("loading");
    loadGameDetails(list, entry.game).then(
      (value) => {
        if (sheetId.current === entry.game.id) setDetails(value);
      },
      () => {
        if (sheetId.current === entry.game.id) setDetails("error");
      },
    );
  };
  const openSheet = (entry: LibraryEntry) => {
    setSheet({ open: true, entry });
    loadDetails(entry);
  };

  // ── changes to the plan
  const gb = (bytes: number, digits: 1 | 2 = 1) => gbText(f, bytes, digits);
  const explain = (refusal: FitRefusal, entry: LibraryEntry) => {
    const title = isolate(entry.game.title);
    if (refusal.reason === "no_size") {
      toast.info(t("fit.noSize", { title }), { id: "sb-fit", detail: t("fit.noSizeDetail") });
      return;
    }
    if (refusal.reason === "limit") {
      toast.warning(t("fit.limit", { max: f.number(PLAN_LIMITS.maxGames) }), { id: "sb-fit" });
      return;
    }
    const digits = digitsToTell(refusal.needBytes, refusal.leftBytes);
    // counted without the game itself: a chosen cartridge going digital in the sheet must not count twice
    const bigger = cardThatFits(removeGame(plan, entry.game.id), refusal.needBytes, extras, capacity);
    toast.warning(t("fit.noRoom", { title }), {
      id: "sb-fit",
      detail: t("fit.noRoomDetail", { need: gb(refusal.needBytes, digits), left: gb(refusal.leftBytes, digits) }),
      action: bigger !== null && step !== "memory" ? { label: t("fit.biggerCard"), href: stepHref("memory") } : undefined,
    });
  };
  const said = (change: "added" | "removed", entry: LibraryEntry, next: typeof plan) =>
    announce(t(change === "added" ? "fit.added" : "fit.removed", { title: isolate(entry.game.title), left: gb(planUsage(next, extras, capacity).usage.remainingBytes) }));
  const toggle = (entry: LibraryEntry) => {
    const result = toggleGame(plan, entry.game.id, chosen.get(entry.game.id) ?? entry.format, extras, capacity);
    if (!result.ok) return explain(result, entry);
    setPlan(result.plan);
    said(result.change, entry, result.plan);
  };
  const choose = (entry: LibraryEntry, format: GameFormat) => {
    const result = addGame(plan, entry.game.id, format, extras, capacity);
    if (!result.ok) return explain(result, entry);
    setPlan(result.plan);
    said("added", entry, result.plan);
  };
  const drop = (entry: LibraryEntry) => {
    const next = removeGame(plan, entry.game.id);
    setPlan(next);
    said("removed", entry, next);
  };
  const startOver = () => {
    const previous = plan;
    reset();
    setView(INITIAL_VIEW);
    toast.info(t("startedOver"), { id: "sb-reset", action: { label: t("undo"), onAction: () => setPlan(previous) } });
  };

  // ── the guide: each step's targets are on screen once its data is
  const ready = restored && (step === "games" ? library.status !== "idle" && library.status !== "loading" : step === "review" ? quoteView.status === "ready" || quoteView.status === "error" : true);
  const tour = useBuilderTour(step, { ready });

  // After a move between steps (not the first view), the new step's heading takes focus (screen readers read it).
  const main = useRef<HTMLDivElement>(null);
  const shown = useRef(location.search);
  useEffect(() => {
    if (shown.current === location.search) return;
    shown.current = location.search;
    main.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
    setChosenOpen(false);
    // a new visit of the review offers «أضف الكل» again, as before the key's state lived here
    setAddedFor(null);
  }, [location.search]);

  const index = stepIndex(step);
  const steps = STEP_LIST.map((name, at) => ({ label: t(`steps.${name}`), href: at < index ? stepHref(name) : undefined }));
  const biggerCard =
    usage.usage.overBytes > 0 && biggerCardExists(plan) ? (
      <TextLink as={LocaleLink} to={stepHref("memory")}>
        {t("fit.biggerCard")}
      </TextLink>
    ) : null;
  const sheetEntry = sheet.entry;
  const sheetChosen = sheetEntry ? (chosen.get(sheetEntry.game.id) ?? null) : null;
  const consoleArt = plan.device.owned ? undefined : (catalog.devices[plan.device.model]?.variants.find((variant) => variant.variantId === plan.device.variantId)?.art ?? catalog.devices[plan.device.model]?.art);
  const quoteLines = quoteView.quote?.lines ?? [];

  return (
    <div className="page sb-page pt-4 pb-6 lg:pt-8">
      <div className="sb-layout" data-step={step}>
        <div ref={main} className="sb-main">
          <header className="sb-head">
            <div data-tour="steps">
              <ProgressSteps steps={steps} current={index} aria-label={t("steps.label")} labels="under" />
            </div>
            <div className="sb-head__title">
              <h1 {...STEP_HEADING} className="type-h1 text-ink outline-none">
                {step === "device" ? t("title") : t(`${step}.title`)}
              </h1>
              <IconKey icon="question" label={t("help")} onClick={tour.replay} data-tour="help" className="shrink-0" />
            </div>
            <p className="sb-lead">{t(`${step}.lead`)}</p>
          </header>

          {step === "device" ? (
            <DeviceStep catalog={catalog} plan={plan} capacity={capacity} onDevice={(device) => setPlan(setDevice(plan, device))} />
          ) : step === "memory" ? (
            <MemoryStep catalog={catalog} plan={plan} extras={extras} capacity={capacity} onCard={(card) => setPlan(setCard(plan, card))} />
          ) : step === "games" ? (
            <GamesStep
              library={library}
              entries={entries}
              usage={usage}
              chosen={chosen}
              view={view}
              onView={setView}
              onToggle={toggle}
              onOpen={openSheet}
              meterTour={!wide}
              meterAction={biggerCard}
              asOf={library.data?.list.asOf ?? LIBRARY_AS_OF}
            />
          ) : (
            <ReviewStep plan={plan} byId={byId} quote={quoteView} refusal={refusal} />
          )}

          {restored && (plan.games.length > 0 || plan.card.sizeGB !== 0 || step !== "device") ? (
            <p className="sb-restart">
              <TextLink as="button" type="button" icon="arrow-counter-clockwise" arrow={false} onClick={startOver}>
                {t("startOver")}
              </TextLink>
            </p>
          ) : null}
        </div>

        <aside className="sb-aside" aria-label={t("plan.title")}>
          {/* the step's keys come before the (possibly long) list of chosen games, so they are always in view */}
          <div className="sb-aside__card surface">
            <h2 className="sb-aside__title">{t("plan.title")}</h2>
            <PlanSummary catalog={catalog} plan={plan} step={step} games={step !== "games"} />
            <SpaceMeter usage={usage} tour={wide && step === "games" ? "meter" : undefined} action={biggerCard} />
            <StepKeys step={step} tour={wide}>
              {step === "review" ? <AddAllKey lines={quoteLines} pending={quoteView.status === "loading"} tour={wide} art={consoleArt} added={added} onAdded={onAdded} onRefused={setRefusal} /> : null}
            </StepKeys>
            {step === "games" ? (
              <div className="sb-aside__chosen" {...tourOn("chosen", wide)}>
                <h3 className="sb-aside__subtitle nums">
                  {t("chosen.title")} · {t("chosen.count", { count: chosenItems.length, n: f.number(chosenItems.length) })}
                </h3>
                <ChosenList items={chosenItems} onRemove={drop} onOpen={openSheet} />
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <TaskBar aria-label={t("steps.label")} className="lg:hidden">
        <div className="sb-taskbar">
          {step === "games" ? (
            <div className="sb-taskbar__summary">
              <SpaceMeter usage={usage} compact className="min-w-0 flex-1" />
              <Key size="sm" fit="compact" aria-haspopup="dialog" onClick={() => setChosenOpen(true)} className="shrink-0" {...tourOn("chosen", !wide)}>
                <span className="nums">{t("chosen.chip", { n: f.number(chosenItems.length) })}</span>
              </Key>
            </div>
          ) : null}
          <StepKeys step={step} compact tour={!wide}>
            {step === "review" ? <AddAllKey lines={quoteLines} pending={quoteView.status === "loading"} compact tour={!wide} art={consoleArt} added={added} onAdded={onAdded} onRefused={setRefusal} /> : null}
          </StepKeys>
        </div>
      </TaskBar>

      <GameSheet
        open={sheet.open}
        onClose={() => setSheet((current) => ({ ...current, open: false }))}
        game={sheetEntry?.game ?? null}
        extras={sheetEntry?.extras}
        details={details}
        cartridge={sheetEntry?.cartridge ?? null}
        selected={sheetChosen ? { format: sheetChosen } : null}
        remainingBytes={sheetEntry ? remainingWithout(plan, sheetEntry.game.id, extras, capacity) : usage.usage.remainingBytes}
        onSelect={(format) => (sheetEntry ? choose(sheetEntry, format) : undefined)}
        onRemove={() => (sheetEntry ? drop(sheetEntry) : undefined)}
        onRetryDetails={() => (sheetEntry ? loadDetails(sheetEntry) : undefined)}
      />
      <ChosenSheet open={chosenOpen} onClose={() => setChosenOpen(false)} items={chosenItems} usedBytes={usage.usage.usedBytes} onRemove={drop} />
      {tour.element}
    </div>
  );
}

/**
 * The plan so far in the aside: the console (its colour on a line of its own), the card and — except on the games step,
 * where the list itself follows — how many games, each with the way back to its step.
 */
function PlanSummary({ catalog, plan, step, games }: { catalog: BuilderCatalog; plan: ReturnType<typeof usePlan>["plan"]; step: BuilderStep; games: boolean }) {
  const t = useBuilderT();
  const f = useFormat();
  const device = catalog.devices[plan.device.model];
  const variant = device?.variants.find((option) => option.variantId === plan.device.variantId);
  const deviceText = plan.device.owned ? t("review.deviceOwned", { name: t(`device.models.${plan.device.model}`) }) : (device?.name ?? t(`device.models.${plan.device.model}`));
  const cardText = plan.card.sizeGB === 0 ? t("review.cardNone") : plan.card.owned ? t("review.cardOwned", { size: cardLabel(plan.card.sizeGB) }) : cardLabel(plan.card.sizeGB);
  const rows: Array<{ key: BuilderStep; label: string; value: string; detail?: string }> = [
    { key: "device", label: t("plan.device"), value: deviceText, detail: plan.device.owned ? undefined : variant?.variantTitle },
    { key: "memory", label: t("plan.card"), value: cardText },
    ...(games ? [{ key: "games" as const, label: t("plan.games"), value: t("chosen.count", { count: plan.games.length, n: f.number(plan.games.length) }) }] : []),
  ];
  return (
    <dl className="sb-plan">
      {rows.map((row) => (
        <div key={row.key} className="sb-plan__row">
          <dt className="sb-plan__label">{row.label}</dt>
          <dd className="sb-plan__value">
            <BidiText text={keepDashes(row.value)} />
            {row.detail ? (
              <span className="sb-plan__detail">
                <BidiText text={row.detail} />
              </span>
            ) : null}
          </dd>
          {row.key !== step ? (
            <dd className="sb-plan__edit">
              <TextLink as={LocaleLink} to={stepHref(row.key)} arrow={false} aria-label={`${t("plan.change")}: ${row.label}`}>
                {t("plan.change")}
              </TextLink>
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
