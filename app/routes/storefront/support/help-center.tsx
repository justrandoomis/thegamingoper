/**
 * /support — the support centre, in the before's arrangement (client feedback round 1, note 9: "the before is look
 * better … the feature of search about problems is good to notice — add improvement and more features"):
 *
 *   1. the support pages' underline tabs (مركز الدعم · مساعد الصيانة · احجز صيانة · تابع طلب; a sliding underline)
 *   2. h1 «الدعم والمساعدة» (the before's heading — the glossary's one exception) and its line
 *   3. the problem search (./components/HelpSearch): suggestions while typing, device chips, common problems — a GET
 *      form, so it works without script; `?q=` shows the grouped results under it (danger · error code · guides ·
 *      policies, the searched words marked), `?platform=` keeps them to one platform
 *   4. the before's big list cards (the kit's EntryCard rows: a clay icon disc, the title, one line, an arrow) in two
 *      short groups — «مشكلة في جهازك؟» (diagnose step by step · book a repair · track a repair) and «طلبك وأسئلتك»
 *      (track your order · returns and warranty · talk to a person)
 *   5. «اختر جهازك»: every platform's devices under its colour line and name (a rail of tiles on phones, a grid from
 *      768); `?device=<slug>` opens the device's panel (photo, the assistant and a repair, the hub link, its guides)
 *   6. suggested guides in staff order (`?guides=all` lists every one), and the store's ContactCard when the owner
 *      configured channels (the hand-off is already the «تحدّث مع موظف» card above)
 *
 * Data: the device directory, the approved public guides (and their search index: no bodies), the store's policies
 * (content area, import only). Nothing is invented: a device without guides says so; a chip is offered only while a
 * guide answers it; the contact card shows only configured channels. One red primary: the search key.
 */
import { useEffect, useId, useRef, type FocusEvent, type ReactNode, type RefObject } from "react";
import { useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/help-center";
import { Logo } from "~/art/Logo";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listPolicies } from "~/server/services/content.server";
import { commonProblemsFor, matchPolicies, type PolicyEntry } from "~/server/services/support/helpsearch";
import { findDevice, getHelpIndex, getSupportDirectory, listArticlesForDevice, listHelpArticles, searchHelp } from "~/server/services/support/kb.server";
import type { ArticleSummary, SupportDevice, SupportPlatformGroup } from "~/server/services/support/types";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData, ShellHandle } from "~/routes/storefront/shell/types";
import { BidiLabel } from "~/ui/BidiText";
import { ContactCard } from "~/ui/ContactCard";
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { EntryCard } from "~/ui/EntryCard";
import { Key } from "~/ui/Key";
import { isPlatform, PlatformLed } from "~/ui/PlatformLed";
import { revealInRow, revealProps } from "~/ui/reveal";
import { SectionHead } from "~/ui/SectionHead";
import { TextLink } from "~/ui/TextLink";
import { DeviceHubLink } from "~/routes/storefront/devices/components/DeviceHubLink";
import { HelpResults, HelpSearchForm, keepsFocus } from "./components/HelpSearch";
import { DeviceArt, DeviceTile, GuideList, PlatformName, SupportNav } from "./components/parts";
import "./support.css";

// A page built around its search: offline, the shell's banner says what was typed stays (the search's own line says
// why the key is flat), never «سلتك محفوظة…» (round-1 fixes).
export const handle = { shell: { offline: "form" }, nav: "push", order: 0, group: "support" } satisfies ShellHandle & MotionHandle;

/** Suggested guides on the first view; ?guides=all lists every approved guide. */
const SUGGESTED = 6;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [directory, guides, index, policyRows] = await Promise.all([getSupportDirectory(db, ctx.locale), listHelpArticles(db, ctx.locale), getHelpIndex(db), listPolicies(db, ctx.locale, { now: ctx.now })]);
  // the device chips: one of the directory's platforms, else every device
  const asked = url.searchParams.get("platform");
  const platform = directory.some((group) => group.slug === asked) ? asked : null;
  const search = await searchHelp(db, ctx.locale, url.searchParams.get("q"), { platform });
  // kept to one platform and nothing found there: do the same words find guides on every device? (the empty state then
  // offers «ابحث في كل الأجهزة» — a filter never hides an answer silently)
  const elsewhere = platform && search?.kind === "guides" && search.articles.length === 0 ? ((await searchHelp(db, ctx.locale, search.query))?.articles.length ?? 0) : 0;
  const policies: PolicyEntry[] = policyRows.map((policy) => ({ slug: policy.slug, title: policy.title, summary: policy.summary }));
  const device = findDevice(directory, url.searchParams.get("device"));
  const deviceGuides = device ? await listArticlesForDevice(db, ctx.locale, device.id, { related: true }) : [];
  return {
    directory,
    guides,
    allGuides: url.searchParams.get("guides") === "all",
    search,
    platform,
    elsewhere,
    index,
    policies,
    policyHits: search?.kind === "guides" ? matchPolicies(policies, search.query, 3) : [],
    // a common problem is offered only while an approved public guide answers it
    common: commonProblemsFor(index),
    device,
    deviceGuides,
    i18n: messagesFor(ctx.locale, "support"),
  };
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { help?: { title?: string; description?: string } } } | undefined;
  // a search result page or a chosen device is a view of this page, not a page of its own
  return shellMeta(args, { title: tree?.meta?.help?.title, description: tree?.meta?.help?.description, noindex: (args.location.search ?? "").length > 1 });
};

export default function HelpCenter({ loaderData }: Route.ComponentProps) {
  const { directory, guides, allGuides, search, platform, elsewhere, index, policies, policyHits, common, device, deviceGuides } = loaderData;
  const t = useT("support");
  const ui = useT("ui");
  const location = useLocation();
  const ids = { devices: useId(), guides: useId(), contact: useId(), paths: useId() };
  const demo = guides.some((guide) => guide.isDemo);
  const shown = allGuides ? guides : guides.slice(0, SUGGESTED);
  const platformName = (group: { slug: string; name: string }) => (isPlatform(group.slug) ? ui(`platform.${group.slug}`) : group.name);
  const searchedPlatform = platform ? directory.find((group) => group.slug === platform) : undefined;
  // A search made on this page (a new query string, not the address the page opened with): the results heading takes
  // focus, so the keyboard and screen readers continue from the answer. Not when a device chip re-ran the search
  // (KEEP_FOCUS): the focus stays on the chips — the arrow keys walk on — and the results' status line says the outcome.
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const opened = useRef(location.search);
  useEffect(() => {
    if (opened.current === location.search) return;
    opened.current = location.search;
    if (!search || keepsFocus(location.state)) return;
    resultsRef.current?.focus({ preventScroll: true });
    resultsRef.current?.scrollIntoView({ block: "nearest" });
  }, [location.search, location.state, search]);
  // A device chosen on this page (a tile, not the address the page opened with): its panel's heading takes focus — the
  // tile the shopper pressed sits below the panel, out of sight, and nothing said the panel had opened.
  const deviceHeadingRef = useRef<HTMLHeadingElement>(null);
  const shownDevice = useRef(device?.slug ?? null);
  useEffect(() => {
    const slug = device?.slug ?? null;
    if (slug === shownDevice.current) return;
    shownDevice.current = slug;
    if (slug) deviceHeadingRef.current?.focus({ preventScroll: true });
  }, [device?.slug]);

  return (
    <div className="page sup sup-help">
      <SupportNav current="help" />

      <div className="sup-help__top glow">
        <div className="sup-help__intro">
          <header className="sup-help__head">
            <h1 className="type-h1 text-ink">{t("help.title")}</h1>
            <p className="sup-help__lede">{t("help.lede")}</p>
          </header>
          <HelpSearchForm
            query={search?.query ?? ""}
            platform={platform}
            platforms={directory.map((group) => ({ slug: group.slug, name: group.name }))}
            index={index}
            policies={policies}
            guides={guides}
            common={common}
          />
        </div>
        {/* from 1024: the store's mascot (it wears a headset) on a disc of real glass over the ambient light */}
        <div className="sup-help__mascot" aria-hidden="true">
          <span className="surface--glass sup-help__disc">
            <Logo variant="mark" className="sup-help__mark text-logo" />
          </span>
        </div>
      </div>

      {search ? <HelpResults search={search} policies={policyHits} platformName={searchedPlatform ? platformName(searchedPlatform) : null} headingRef={resultsRef} elsewhere={elsewhere} /> : null}

      <nav aria-label={t("help.paths.label")} className="sup-paths">
        <PathGroup title={t("help.paths.device")}>
          <EntryCard to="/support/assistant" icon="lifebuoy" title={t("help.paths.assistant.title")} text={t("help.paths.assistant.text")} />
          <EntryCard to="/support/repair" icon="wrench" title={t("help.paths.repair.title")} text={t("help.paths.repair.text")} />
          <EntryCard to="/support/repair/status" icon="clipboard-text" title={t("help.paths.status.title")} text={t("help.paths.status.text")} />
        </PathGroup>
        <PathGroup title={t("help.paths.orders")}>
          <EntryCard to="/track" icon="package" title={t("help.paths.track.title")} text={t("help.paths.track.text")} />
          <EntryCard to="/policies/returns" icon="arrow-counter-clockwise" title={t("help.paths.returns.title")} text={t("help.paths.returns.text")} />
          <EntryCard to="/support/assistant?handoff=1#handoff" icon="chat-circle" title={t("help.paths.staff.title")} text={t("help.paths.staff.text")} />
        </PathGroup>
      </nav>

      <section id="devices" aria-labelledby={ids.devices} className="sup-section" {...revealProps()}>
        <SectionHead id={ids.devices} title={device ? t("help.device.change") : t("help.devices.title")} reason={t("help.devices.hint")} />
        {device ? <DevicePanel device={device} guides={deviceGuides} headingRef={deviceHeadingRef} /> : null}
        <div className="sup-directory">
          {directory.map((group) => (
            <PlatformDevices key={group.id} group={group} name={platformName(group)} current={device} />
          ))}
        </div>
      </section>

      <div className="sup-help__foot">
        <section id="guides" aria-labelledby={ids.guides} className="sup-section" {...revealProps()}>
          <SectionHead
            id={ids.guides}
            title={allGuides ? t("help.guides.allTitle") : t("help.guides.title")}
            reason={t("help.guides.hint")}
            href={guides.length > SUGGESTED ? (allGuides ? "/support#guides" : "/support?guides=all#guides") : undefined}
            viewAllLabel={allGuides ? t("help.guides.fewer") : t("help.guides.all", { count: guides.length })}
          />
          {shown.length > 0 ? (
            <GuideList articles={shown} headingLevel={3} className="sup-guides--cols" />
          ) : (
            <EmptyState icon="book-open" title={t("help.guides.empty")} text={t("help.guides.emptyText")} action={<Key as={LocaleLink} to="/support/assistant" size="sm">{t("nav.assistant")}</Key>} />
          )}
          {demo ? <DemoNote variant="line">{t("help.demo")}</DemoNote> : null}
        </section>
        <ContactSection id={ids.contact} />
      </div>
    </div>
  );
}

/** One short group of the before's list cards, under a small heading. */
function PathGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="sup-paths__group">
      <h2 id={id} className="sup-paths__title">
        {title}
      </h2>
      <div className="sup-paths__list">{children}</div>
    </section>
  );
}

/**
 * The phone rail of device tiles snaps to the tiles' starts: the tile that takes the KEYBOARD focus comes fully into view
 * at the rail's start edge (a snap point — a "nearest" scroll would be pulled back with the tile cut). Tabbing left it a
 * quarter cut at the screen's edge before (round-1 fixes). Pointer focus never scrolls the rail.
 */
function revealFocusedTile(event: FocusEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof Element) || target === event.currentTarget || !target.matches(":focus-visible")) return;
  revealInRow(event.currentTarget, target.closest("li") ?? target, "start");
}

/**
 * One platform's devices, as the before grouped them: the platform's colour line and name over its tiles (a rail
 * with 2.5 tiles on phones, a wrapping grid from 768). Whole model names, never clamped.
 */
function PlatformDevices({ group, name, current }: { group: SupportPlatformGroup; name: string; current: SupportDevice | null }) {
  const t = useT("support");
  const id = useId();
  return (
    <section aria-labelledby={id} className="sup-platform" data-gel={isPlatform(group.slug) ? group.slug : undefined}>
      <h3 id={id} className="sup-platform__head">
        {isPlatform(group.slug) ? <PlatformLed bar /> : null}
        <BidiLabel className="sup-platform__name">{name}</BidiLabel>
        <span className="sup-platform__count">{t("help.devices.count", { count: group.devices.length })}</span>
      </h3>
      <ul role="list" aria-label={t("help.devices.list", { platform: name })} className="sup-devices" onFocus={revealFocusedTile}>
        {group.devices.map((entry) => (
          <li key={entry.id}>
            <DeviceTile name={entry.name} artKey={entry.artKey} kind={entry.kind} href={`/support?device=${entry.slug}#device-help`} current={entry.slug === current?.slug} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DevicePanel({ device, guides, headingRef }: { device: SupportDevice; guides: readonly ArticleSummary[]; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  const t = useT("support");
  const headingId = useId();
  const own = guides.filter((guide) => guide.scope !== "related");
  const related = guides.filter((guide) => guide.scope === "related");
  return (
    <section id="device-help" aria-labelledby={headingId} className="sup-card sup-device">
      <div className="sup-device__head">
        <DeviceArt artKey={device.artKey} kind={device.kind} sizes="(min-width: 1024px) 160px, 96px" className="sup-device__art" />
        <div className="grid min-w-0 content-center gap-2">
          <p className="type-xs text-ink-2">
            <PlatformName slug={device.platform.slug} name={device.platform.name} />
          </p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-h2 text-ink">
            <BidiLabel>{t("help.device.title", { device: device.name })}</BidiLabel>
          </h2>
          <div className="mt-1 flex flex-wrap gap-2">
            <Key as={LocaleLink} to={`/support/assistant?device=${device.slug}`} size="sm" icon="lifebuoy">
              {t("help.device.assistant")}
            </Key>
            <Key as={LocaleLink} to={`/support/repair?device=${device.slug}`} size="sm" icon="wrench">
              {t("help.device.repair")}
            </Key>
          </div>
        </div>
      </div>
      {/* The device's hub (devices area): every device listed here has one (published model, active platform). */}
      <DeviceHubLink device={device} title={t("help.device.hub", { device: device.name })} text={t("help.device.hubText")} />
      <div className="grid gap-3">
        <h3 className="type-h3 text-ink">{t("help.device.guides")}</h3>
        {own.length + related.length === 0 ? <EmptyState title={t("help.device.empty")} text={t("help.device.emptyText")} /> : <GuideList articles={[...own, ...related]} showScope headingLevel={4} />}
      </div>
      <TextLink as={LocaleLink} to="/support#devices" className="justify-self-start">
        {t("help.device.change")}
      </TextLink>
    </section>
  );
}

/** The store's own channels (phone, WhatsApp…) when the owner configured them; nothing when not (the hand-off is above). */
function ContactSection({ id }: { id: string }) {
  const t = useT("support");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const channels = layout?.shell?.contact?.channels ?? null;
  if (!channels) return null;
  return (
    <section aria-labelledby={id} className="sup-section sup-contact">
      <SectionHead id={id} title={t("help.contact.title")} />
      <ContactCard channels={channels} />
    </section>
  );
}
