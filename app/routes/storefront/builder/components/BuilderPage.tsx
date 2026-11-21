/**
 * The builder's page (docs/switch-builder.md §6): the step rail, the step, and — from 1024 — the sticky aside with the
 * plan so far, the space bar, the chosen games and the step keys; below 1024 the same keys in the shell's task bar
 * (with the compact space bar on the memory and games steps, and «ألعابك (n)» on the games step). Never two sticky
 * bars at one edge. The head follows the trade-in wizard: on the first step the title and its line come before the
 * rail; the later steps keep the rail on top.
 *
 * State: the plan (./lib/use-plan: localStorage, restored after hydration), the library (./lib/use-library: the open
 * list + TamTam's data, fetched at idle on the earlier steps), the games step's search/filters/sort (kept for the
 * visit), the details sheet (the game's details chunk loads when it opens) and the review's quote (the route's action,
 * intent=quote). Every change of the plan is computed with the pure helpers (~/lib/switch-builder/plan), so a refused
 * change can say why: a game without a size, or one that does not fit (both figures, and «بطاقة أكبر» when a bigger
 * card would make room).
 *
 * A restored plan knows its games before their sizes and names have loaded: until TamTam's data answers, the space bar
 * draws no figure that depends on them (never a false «0 GB used»), «ألعابك (n)» counts the plan's games, and the lists
 * say they are loading. Changes are said once: the grid, the aside and the chosen-games sheet through the shared live
 * region (cart-client announce); the details sheet says its own inside the dialog, so the page stays quiet for those.
 * A console or card that leaves the chosen games without room (or gives it back) is said there too — the notes and
 * bars that show it are inserted with their words, which a live region would not read.
 * A 404 on the list or a details file means a newer list was published since the page was loaded: the page says so
 * and offers a reload (./LibraryUpdated), never the generic error.
 *
 * The review's quote stays on screen while the same plan is asked again (after a refused add: the reasons stay until
 * the new answer). «أضف الكل» answered yes for a plan: the review keeps «عرض السلة» for that plan for the rest of the
 * visit — back and forth between the steps never offers the same add again (QA 2026-11-21: it doubled the cart) —
 * and another version of the plan says to check the cart first.
 *
 * Focus is never dropped to <body>: «ابدأ من جديد» turns into «مسحنا ما اخترته. تراجع» in place, which takes the focus
 * (and gives it back to «ابدأ من جديد» after the undo); the chosen lists and the filter chips hand it to their
 * neighbours. While a sheet of the page is open, the task bar's keys are not drawn: the sheet's frost would show the red
 * primary through its foot as a pink haze (they are inert under it anyway).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLocation } from "react-router";

import { LocaleLink, useFormat } from "~/i18n/react";
import { addGame, cardThatFits, biggerCardExists, encodePlan, planUsage, prunePlan, remainingWithout, removeGame, setCard, setDevice, toggleGame, type FitRefusal } from "~/lib/switch-builder/plan";
import { DEFAULT_CAPACITY, digitsToTell } from "~/lib/switch-builder/storage";
import type { BuilderCatalog, BuilderPlan, BuilderQuote, BuilderStep, GameDetails, GameFormat, LibraryExtras } from "~/lib/switch-builder/types";
import { PLAN_LIMITS } from "~/lib/switch-builder/types";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import { isolate, BidiText } from "~/ui/BidiText";
import { announce } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { LIBRARY_AS_OF } from "../library.manifest";
import { cardLabel, gbText, shortfallText, useBuilderT } from "../lib/format";
import { mergeLibrary, needOf, type LibraryEntry } from "../lib/library";
import { stepHref, stepIndex, stepOf } from "../lib/steps";
import { cachedGameDetails, isLibraryUpdated, loadGameDetails, useLibrary } from "../lib/use-library";
import { usePlan } from "../lib/use-plan";
import { tourOn, useWide } from "../lib/use-wide";
import { AddAllKey, type AddAllRefusal } from "./AddAllKey";
import { useBuilderTour } from "./BuilderTour";
import { ChosenList, ChosenSheet, type ChosenItem, type ChosenPending } from "./ChosenList";
import { DeviceStep, keepDashes } from "./DeviceStep";
import { GameSheet } from "./GameSheet";
import { GamesStep, INITIAL_VIEW, type GamesView } from "./GamesStep";
import { reloadPage } from "./LibraryUpdated";
import { MemoryStep } from "./MemoryStep";
import { ReviewStep, type QuoteView, type ReviewFacts } from "./ReviewStep";
import { SpaceMeter, type MeterFigures } from "./SpaceMeter";
import { StepKeys } from "./StepKeys";

const NO_EXTRAS: Readonly<Record<string, LibraryExtras>> = {};
const STEP_LIST: readonly BuilderStep[] = ["device", "memory", "games", "review"];
/** Each step's h1: where focus goes after a move between steps. */
const STEP_HEADING = { tabIndex: -1, "data-step-heading": "" } as const;
/** The key that takes focus after «ابدأ من جديد» / «تراجع» swap places. */
const RESTART_TARGET = "data-restart-target";

type QuoteAnswer = { ok: true; quote: BuilderQuote } | { ok: false; code: string };

export function BuilderPage({ catalog }: { catalog: BuilderCatalog }) {
  const t = useBuilderT();
  const f = useFormat();
  const location = useLocation();
  const step = stepOf(location.search);
  const wide = useWide();
  const asideTitle = useId();
  // the step's column (its h1 takes focus after a move between steps, and after an undo with nowhere else to go)
  const main = useRef<HTMLDivElement>(null);
  const { plan, restored, setPlan, reset } = usePlan(catalog);
  const library = useLibrary(step === "games" || step === "review" ? "now" : "idle");
  // TamTam's data (sizes, prices and their dates, the planner's constants) — it may answer before the list file does
  const payload = library.payload;
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
  // A restored plan knows its games before their sizes (TamTam's data) and their names (the list file) have loaded:
  // until then the space bar draws no figure that depends on them — never a false «0 GB used» — «ألعابك (n)» counts the
  // plan's games, and the lists say they are loading (or, when it failed, that the names come with the list)
  const sizesPending = restored && plan.games.length > 0 && payload === null;
  const figures: MeterFigures = !sizesPending ? "known" : library.payloadFailed || library.status === "unbuilt" ? "unknown" : "loading";
  const names: ReviewFacts = library.data ? "ready" : library.status === "idle" || library.status === "loading" ? "loading" : "unavailable";
  const dates: ReviewFacts = payload ? "ready" : library.payloadFailed || library.status === "unbuilt" ? "unavailable" : "loading";
  const chosenPending: ChosenPending = restored && plan.games.length > 0 && chosenItems.length === 0 && names !== "ready" ? (names === "loading" ? "loading" : "unnamed") : null;
  const gameCount = plan.games.length;
  const [view, setView] = useState<GamesView>(INITIAL_VIEW);
  const [chosenOpen, setChosenOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refusal, setRefusal] = useState<AddAllRefusal | null>(null);
  // «ابدأ من جديد» was pressed: the plan before it, for the undo in its place
  const [cleared, setCleared] = useState<BuilderPlan | null>(null);
  /** The shopper changed the plan: the start-over's undo is over. */
  const change = (next: BuilderPlan) => {
    setCleared(null);
    setPlan(next);
  };

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
  // The plan the fetcher's answer belongs to: the one asked last when the answer came. A fetcher keeps its answer while
  // it asks again, so asking for the same plan again keeps the lines on screen until the new answer.
  const answeredFor = useRef<string | null>(null);
  const seenAnswer = useRef<QuoteAnswer | undefined>(undefined);
  if (quoter.state === "idle" && quoter.data !== seenAnswer.current) {
    seenAnswer.current = quoter.data;
    answeredFor.current = quotedFor.current;
  }
  const answer = answeredFor.current === encoded ? quoter.data : undefined;
  const asking = quoter.state !== "idle" || quotedFor.current !== encoded;
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
  // the request left but never reached the store while the device went offline (the route's clientAction says so)
  const answeredOffline = !asking && answer !== undefined && !answer.ok && answer.code === "offline";
  const offline = quoteOffline || answeredOffline;
  useEffect(() => {
    if (!offline) return;
    const again = () => askQuote();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- askQuote reads only the plan (`encoded`): the listener asks for the current one
  }, [offline, encoded]);
  useEffect(() => setRefusal(null), [encoded]);
  // A refusal that names lines (sold out since the quote was worked out): the quote is asked again at once, so the lines
  // and the total follow the store and «أضف الكل» adds the rest. The reasons stay until the new answer is here.
  const requote = useRef<{ from: QuoteAnswer | undefined } | null>(null);
  const onRefused = (next: AddAllRefusal | null) => {
    setRefusal(next);
    requote.current = null;
    if (next && next.problems.length > 0) {
      requote.current = { from: quoter.data };
      askQuote();
    }
  };
  useEffect(() => {
    if (!requote.current || quoter.state !== "idle" || quoter.data === requote.current.from) return;
    requote.current = null;
    setRefusal(null);
  }, [quoter.state, quoter.data]);
  // «أضف الكل» answered yes: for that plan both copies of the key (the task bar's, the aside's) say «عرض السلة» for the
  // rest of the visit — after a resize, a turned tablet, or back and forth between the steps
  const [addedPlans, setAddedPlans] = useState<ReadonlySet<string>>(() => new Set());
  const added = addedPlans.has(encoded);
  const addedBefore = !added && addedPlans.size > 0;
  const onAdded = () => setAddedPlans((current) => new Set(current).add(encoded));
  const quoteView: QuoteView = {
    status: quoteOffline ? "error" : answer?.ok ? "ready" : asking ? "loading" : answer ? "error" : "idle",
    quote: answer?.ok ? answer.quote : null,
    offline,
    retry: askQuote,
  };

  // ── the details sheet
  const [sheet, setSheet] = useState<{ open: boolean; entry: LibraryEntry | null }>({ open: false, entry: null });
  const [details, setDetails] = useState<GameDetails | null | "loading" | "error">(null);
  const sheetId = useRef<string | null>(null);
  // a details file of this page's list is gone (a newer list was published since): the notice above the list
  const [detailsGone, setDetailsGone] = useState(false);
  const goneSaid = useRef(false);
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
      (error: unknown) => {
        if (!isLibraryUpdated(error)) {
          if (sheetId.current === entry.game.id) setDetails("error");
          return;
        }
        // gone, not failed: a retry would ask for the same missing file. The sheet keeps what TamTam's own data says
        // (no details), and the page says why the rest is missing and offers the reload — once, over the open sheet
        if (sheetId.current === entry.game.id) setDetails(null);
        setDetailsGone(true);
        if (!goneSaid.current) {
          goneSaid.current = true;
          toast.info(t("updated.title"), { id: "sb-updated", detail: t("updated.text"), action: { label: t("updated.reload"), onAction: reloadPage } });
        }
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
    change(result.plan);
    said(result.change, entry, result.plan);
  };
  // `quiet`: the change was made in the details sheet, which says it itself inside the dialog (its own status, once the
  // plan has taken it) — the page's live region would say it a second time. A refusal is still explained (a toast).
  const choose = (entry: LibraryEntry, format: GameFormat, { quiet = false }: { quiet?: boolean } = {}) => {
    const result = addGame(plan, entry.game.id, format, extras, capacity);
    if (!result.ok) return explain(result, entry);
    change(result.plan);
    if (!quiet) said("added", entry, result.plan);
  };
  const drop = (entry: LibraryEntry, { quiet = false }: { quiet?: boolean } = {}) => {
    const next = removeGame(plan, entry.game.id);
    change(next);
    if (!quiet) said("removed", entry, next);
  };
  // the grid's, the aside's and the chosen-games sheet's remove keys: said by the page
  const dropAndSay = (entry: LibraryEntry) => drop(entry);
  // A console or card that leaves the chosen games without room is said once, here (the memory step's note and the
  // bars are inserted with their words, which screen readers do not read); so is the room coming back.
  const sayFit = (next: BuilderPlan) => {
    if (figures !== "known") return;
    const before = usage.usage;
    const after = planUsage(next, extras, capacity).usage;
    if (after.overBytes > 0) {
      if (after.overBytes !== before.overBytes) announce(`${t("meter.over", { over: shortfallText(f, after.usedBytes, after.plannableBytes) })} ${t("meter.overHint")}`);
    } else if (before.overBytes > 0) announce(t("meter.left", { left: gb(after.remainingBytes) }));
  };
  const onDevice = (device: BuilderPlan["device"]) => {
    const next = setDevice(plan, device);
    change(next);
    sayFit(next);
  };
  const onCard = (card: BuilderPlan["card"]) => {
    const next = setCard(plan, card);
    change(next);
    sayFit(next);
  };

  // ── «ابدأ من جديد» and its undo, in the same place: the one that appears takes the focus the other had (never <body>)
  const restart = useRef<HTMLParagraphElement>(null);
  const restartFocus = useRef(false);
  const armRestart = () => {
    restartFocus.current = typeof document !== "undefined" && Boolean(restart.current?.contains(document.activeElement));
  };
  useLayoutEffect(() => {
    if (!restartFocus.current) return;
    restartFocus.current = false;
    const target = restart.current?.querySelector<HTMLElement>(`[${RESTART_TARGET}]`) ?? main.current?.querySelector<HTMLElement>("[data-step-heading]");
    target?.focus({ preventScroll: true });
  }, [cleared]);
  const undo = (previous: BuilderPlan) => {
    armRestart();
    setCleared(null);
    setPlan(previous);
    toast.dismiss("sb-reset");
  };
  const startOver = () => {
    const previous = plan;
    armRestart();
    reset();
    setCleared(previous);
    setView(INITIAL_VIEW);
    toast.info(t("startedOver"), { id: "sb-reset", action: { label: t("undo"), onAction: () => undo(previous) } });
  };

  // ── the guide: each step's targets are on screen once its data is
  const ready = restored && (step === "games" ? library.status !== "idle" && library.status !== "loading" : step === "review" ? quoteView.status === "ready" || quoteView.status === "error" : true);
  const tour = useBuilderTour(step, { ready });

  // After a move between steps (not the first view), the new step's heading takes focus (screen readers read it).
  const shown = useRef(location.search);
  useEffect(() => {
    if (shown.current === location.search) return;
    shown.current = location.search;
    main.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
    setChosenOpen(false);
    setFiltersOpen(false);
    setSheet((current) => (current.open ? { ...current, open: false } : current));
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
  // a sheet of the page is open over the task bar
  const covered = sheet.open || chosenOpen || filtersOpen;

  const rail = (
    <div data-tour="steps">
      <ProgressSteps steps={steps} current={index} aria-label={t("steps.label")} labels="under" />
    </div>
  );
  const heading = (
    <>
      <div className="sb-head__title">
        <h1 {...STEP_HEADING} className="type-h1 text-ink outline-none">
          {step === "device" ? t("title") : t(`${step}.title`)}
        </h1>
        <IconKey icon="question" label={t("help")} onClick={tour.replay} data-tour="help" className="shrink-0" />
      </div>
      <p className="sb-lead">{t(`${step}.lead`)}</p>
    </>
  );

  return (
    <div className="page sb-page pt-4 pb-6 lg:pt-8">
      <div className="sb-layout" data-step={step}>
        <div ref={main} className="sb-main">
          {/* as the trade-in wizard: its start page puts the rail under its title and line; the steps keep it on top */}
          <header className="sb-head" data-start={step === "device" ? "" : undefined}>
            {step === "device" ? (
              <>
                {heading}
                {rail}
              </>
            ) : (
              <>
                {rail}
                {heading}
              </>
            )}
          </header>

          {step === "device" ? (
            <DeviceStep catalog={catalog} plan={plan} capacity={capacity} onDevice={onDevice} />
          ) : step === "memory" ? (
            <MemoryStep catalog={catalog} plan={plan} extras={extras} capacity={capacity} onCard={onCard} />
          ) : step === "games" ? (
            <GamesStep
              library={library}
              entries={entries}
              usage={usage}
              figures={figures}
              chosen={chosen}
              view={view}
              onView={setView}
              onToggle={toggle}
              onOpen={openSheet}
              meterTour={!wide}
              meterAction={biggerCard}
              detailsUpdated={detailsGone}
              asOf={library.data?.list.asOf ?? LIBRARY_AS_OF}
              filtersOpen={filtersOpen}
              onFiltersOpen={setFiltersOpen}
            />
          ) : (
            <ReviewStep
              plan={plan}
              byId={byId}
              extras={extras}
              names={names}
              dates={dates}
              updated={library.status === "stale"}
              usage={figures === "known" ? usage : null}
              biggerCard={biggerCardExists(plan)}
              addedBefore={addedBefore}
              quote={quoteView}
              refusal={refusal}
            />
          )}

          {restored && (cleared !== null || plan.games.length > 0 || plan.card.sizeGB !== 0 || step !== "device") ? (
            <p ref={restart} className="sb-restart">
              {cleared !== null ? (
                <>
                  <span className="sb-restart__said">{t("startedOver")}</span>
                  <TextLink as="button" type="button" icon="arrow-counter-clockwise" arrow={false} onClick={() => undo(cleared)} {...{ [RESTART_TARGET]: "" }}>
                    {t("undo")}
                  </TextLink>
                </>
              ) : (
                <TextLink as="button" type="button" icon="arrow-counter-clockwise" arrow={false} onClick={startOver} {...{ [RESTART_TARGET]: "" }}>
                  {t("startOver")}
                </TextLink>
              )}
            </p>
          ) : null}
        </div>

        {/* a labelled section, not a landmark of its own: it sits inside the shell's <main> */}
        <section className="sb-aside" aria-labelledby={asideTitle}>
          {/* the step's keys come before the (possibly long) list of chosen games, so they are always in view */}
          <div className="sb-aside__card surface">
            <h2 id={asideTitle} className="sb-aside__title">
              {t("plan.title")}
            </h2>
            <PlanSummary catalog={catalog} plan={plan} step={step} games={step !== "games"} />
            <SpaceMeter usage={usage} figures={figures} tour={wide && step === "games" ? "meter" : undefined} action={biggerCard} />
            <StepKeys step={step} tour={wide}>
              {step === "review" ? <AddAllKey lines={quoteLines} pending={asking} tour={wide} art={consoleArt} added={added} onAdded={onAdded} onRefused={onRefused} /> : null}
            </StepKeys>
            {step === "games" ? (
              <div className="sb-aside__chosen" {...tourOn("chosen", wide)}>
                <h3 className="sb-aside__subtitle nums">
                  {t("chosen.title")} · {t("chosen.count", { count: gameCount, n: f.number(gameCount) })}
                </h3>
                <ChosenList items={chosenItems} pending={chosenPending} onRemove={dropAndSay} onOpen={openSheet} />
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <TaskBar aria-label={t("keys.label")} className={cx("lg:hidden", covered && "sb-taskbar--covered")}>
        <div className="sb-taskbar">
          {step === "games" ? (
            <div className="sb-taskbar__summary">
              {/* a second copy of the games step's own meter, kept in view: drawn for the eyes only, so screen readers
                  read one meter with its figures, once */}
              <SpaceMeter usage={usage} figures={figures} compact decorative className="min-w-0 flex-1" />
              <Key size="sm" fit="compact" aria-haspopup="dialog" onClick={() => setChosenOpen(true)} className="shrink-0" {...tourOn("chosen", !wide)}>
                <span className="nums">{t("chosen.chip", { n: f.number(gameCount) })}</span>
              </Key>
            </div>
          ) : step === "memory" ? (
            // the memory step's choice changes the space: the bar under the finger says it at once (red when the chosen
            // games no longer fit — the note under the card list may be below the screen on a phone)
            <div className="sb-taskbar__summary">
              <SpaceMeter usage={usage} figures={figures} compact decorative className="min-w-0 flex-1" />
            </div>
          ) : null}
          <StepKeys step={step} compact tour={!wide}>
            {step === "review" ? <AddAllKey lines={quoteLines} pending={asking} compact tour={!wide} art={consoleArt} added={added} onAdded={onAdded} onRefused={onRefused} /> : null}
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
        onSelect={(format) => (sheetEntry ? choose(sheetEntry, format, { quiet: true }) : undefined)}
        onRemove={() => (sheetEntry ? drop(sheetEntry, { quiet: true }) : undefined)}
        onRetryDetails={() => (sheetEntry ? loadDetails(sheetEntry) : undefined)}
      />
      <ChosenSheet
        open={chosenOpen}
        onClose={() => setChosenOpen(false)}
        items={chosenItems}
        count={gameCount}
        usedBytes={figures === "known" ? usage.usage.usedBytes : null}
        pending={chosenPending}
        onRemove={dropAndSay}
      />
      {tour.element}
    </div>
  );
}

/**
 * The plan so far in the aside: the console (its colour on a line of its own — or, for a console TamTam no longer
 * sells, that it is not available now), the card and — except on the games step, where the list itself follows — how
 * many games, each with the way back to its step.
 */
function PlanSummary({ catalog, plan, step, games }: { catalog: BuilderCatalog; plan: ReturnType<typeof usePlan>["plan"]; step: BuilderStep; games: boolean }) {
  const t = useBuilderT();
  const f = useFormat();
  const device = catalog.devices[plan.device.model];
  const variant = device?.variants.find((option) => option.variantId === plan.device.variantId);
  const sold = (device?.variants.length ?? 0) > 0;
  const deviceText = plan.device.owned ? t("review.deviceOwned", { name: t(`device.models.${plan.device.model}`) }) : (device?.name ?? t(`device.models.${plan.device.model}`));
  const deviceDetail = plan.device.owned ? undefined : sold ? variant?.variantTitle : t("device.stock.unavailable");
  const cardText = plan.card.sizeGB === 0 ? t("review.cardNone") : plan.card.owned ? t("review.cardOwned", { size: cardLabel(plan.card.sizeGB) }) : cardLabel(plan.card.sizeGB);
  const rows: Array<{ key: BuilderStep; label: string; value: string; detail?: string }> = [
    { key: "device", label: t("plan.device"), value: deviceText, detail: deviceDetail },
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
