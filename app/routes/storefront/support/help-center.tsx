/**
 * /support — the support centre (Design System v2 §6.13): the support sections' navigation (as on every support page:
 * the assistant and repair tracking one tap away), h1 «كيف نساعدك؟» with a search box for a problem or an error
 * code (guides only — kb.server searchHelp: a danger sign first, an error code, or guides by the words), four task
 * tiles (track an order · repair a device · returns and warranty · talk to a person), the device picker (a platform
 * segmented control, then that platform's device tiles — a rail below 768, a wrapping grid from 768; choosing one shows
 * its guides here, ?device=<slug>), suggested guides (staff order; ?guides=all lists every one), and how to reach a
 * person: the store's ContactCard when the owner configured channels, «اكتب لموظف» (the assistant's hand-off) when not.
 *
 * Data: the device directory and approved public guides. Nothing is invented: a device without guides says so; the
 * contact card shows only configured channels. One red primary: the search key.
 */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Form, useLocation, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/help-center";
import { Icon, type IconName } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { findDevice, getSupportDirectory, listArticlesForDevice, listHelpArticles, searchHelp } from "~/server/services/support/kb.server";
import type { ArticleSummary, HelpSearch, SupportDevice, SupportPlatformGroup } from "~/server/services/support/types";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { BidiLabel } from "~/ui/BidiText";
import { ContactCard } from "~/ui/ContactCard";
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { isPlatform, PlatformLed } from "~/ui/PlatformLed";
import { SectionHead } from "~/ui/SectionHead";
import { Segmented } from "~/ui/Segmented";
import { TextLink } from "~/ui/TextLink";
import { DeviceHubLink } from "~/routes/storefront/devices/components/DeviceHubLink";
import { DeviceArt, DeviceTile, GuideList, PlatformName, SafetyNote, SupportNav } from "./components/parts";
import "./support.css";

export const handle = { nav: "push", order: 0, group: "support" } satisfies MotionHandle;

/** Suggested guides on the first view; ?guides=all lists every approved guide. */
const SUGGESTED = 6;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [directory, guides, search] = await Promise.all([getSupportDirectory(db, ctx.locale), listHelpArticles(db, ctx.locale), searchHelp(db, ctx.locale, url.searchParams.get("q"))]);
  const device = findDevice(directory, url.searchParams.get("device"));
  const deviceGuides = device ? await listArticlesForDevice(db, ctx.locale, device.id, { related: true }) : [];
  return { directory, guides, allGuides: url.searchParams.get("guides") === "all", search, device, deviceGuides, i18n: messagesFor(ctx.locale, "support") };
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { help?: { title?: string; description?: string } } } | undefined;
  // a search result page or a chosen device is a view of this page, not a page of its own
  return shellMeta(args, { title: tree?.meta?.help?.title, description: tree?.meta?.help?.description, noindex: (args.location.search ?? "").length > 1 });
};

export default function HelpCenter({ loaderData }: Route.ComponentProps) {
  const { directory, guides, allGuides, search, device, deviceGuides } = loaderData;
  const t = useT("support");
  const location = useLocation();
  const ids = { devices: useId(), guides: useId(), contact: useId() };
  const demo = guides.some((guide) => guide.isDemo);
  const shown = allGuides ? guides : guides.slice(0, SUGGESTED);
  // A search made on this page (a new query string, not the address the page opened with): the results heading takes
  // focus, so the keyboard and screen readers continue from the answer.
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const opened = useRef(location.search);
  useEffect(() => {
    if (opened.current === location.search) return;
    opened.current = location.search;
    if (!search) return;
    resultsRef.current?.focus({ preventScroll: true });
    resultsRef.current?.scrollIntoView({ block: "nearest" });
  }, [location.search, search]);

  return (
    <div className="page sup sup-help">
      <header className="sup-help__head">
        {/* the four support sections, as on every support page: the assistant and repair tracking one tap away */}
        <SupportNav current="help" className="mb-1" />
        <h1 className="type-h1 text-ink">{t("help.title")}</h1>
        <p className="type-lead text-ink-2">{t("help.lede")}</p>
        <SearchBox query={search?.query ?? ""} />
      </header>

      {search ? <SearchResults search={search} headingRef={resultsRef} /> : null}

      <nav aria-label={t("help.tasks.label")} className="sup-tasks">
        <TaskTile to="/track" icon="package" title={t("help.tasks.track.title")} text={t("help.tasks.track.text")} />
        <TaskTile to="/support/repair" icon="wrench" title={t("help.tasks.repair.title")} text={t("help.tasks.repair.text")} />
        <TaskTile to="/policies/returns" icon="arrow-counter-clockwise" title={t("help.tasks.returns.title")} text={t("help.tasks.returns.text")} />
        <TaskTile to="/support/assistant?handoff=1#handoff" icon="chat-circle" title={t("help.tasks.staff.title")} text={t("help.tasks.staff.text")} />
      </nav>

      <section id="devices" aria-labelledby={ids.devices} className="sup-section">
        <SectionHead id={ids.devices} title={device ? t("help.device.change") : t("help.devices.title")} reason={t("help.devices.hint")} />
        {device ? <DevicePanel device={device} guides={deviceGuides} /> : null}
        <DevicePicker directory={directory} current={device} />
      </section>

      <div className="sup-help__foot">
        <section id="guides" aria-labelledby={ids.guides} className="sup-section">
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

/**
 * The search box: a GET form (works without script), the one red primary of the view inside the field's end. After a
 * search the results heading takes focus (below). `action="."`: the page's own path — without it React Router writes
 * the address bar's query into `action`, which the server spells differently («%20» against «+»), and hydration fails.
 */
function SearchBox({ query }: { query: string }) {
  const t = useT("support");
  const navigation = useNavigation();
  const location = useLocation();
  const searching = navigation.state === "loading" && navigation.location?.pathname === location.pathname && new URLSearchParams(navigation.location.search).has("q");
  return (
    <Form method="get" action="." role="search" className="sup-search" preventScrollReset>
      <TextField
        key={query}
        label={t("help.search.label")}
        name="q"
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        maxLength={300}
        placeholder={t("help.search.placeholder")}
        defaultValue={query}
        inputClassName="sup-search__input"
        end={
          <Key type="submit" variant="primary" size="sm" icon="magnifying-glass" loading={searching}>
            {t("help.search.submit")}
          </Key>
        }
      />
    </Form>
  );
}

function SearchResults({ search, headingRef }: { search: HelpSearch; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useT("support");
  const assistantHref = `/support/assistant?${new URLSearchParams({ q: search.query }).toString()}`;
  const staffHref = `/support/assistant?${new URLSearchParams({ q: search.query, handoff: "1" }).toString()}#handoff`;
  return (
    <section aria-labelledby="search-results" className="sup-results">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="search-results" ref={headingRef} tabIndex={-1} className="type-h3 text-ink">
          <BidiQuery text={t("help.search.results", { query: search.query })} />
        </h2>
        <TextLink as={LocaleLink} to="/support" arrow={false} icon="x">
          {t("help.search.clear")}
        </TextLink>
      </div>
      {search.kind === "danger" ? (
        <SafetyNote tone="danger" title={t("help.search.dangerTitle")}>
          <p>{t("help.search.dangerText")}</p>
          <p className="mt-3 flex flex-wrap gap-x-6">
            <TextLink as={LocaleLink} to="/support/repair">
              {t("assistant.done.repair")}
            </TextLink>
            <TextLink as={LocaleLink} to={staffHref}>
              {t("assistant.done.staff")}
            </TextLink>
          </p>
        </SafetyNote>
      ) : search.kind === "code" ? (
        search.articles.length > 0 ? (
          <>
            <p className="type-sm text-ink-2">{t("help.search.codeFound", { code: ltr(search.code ?? "") })}</p>
            <GuideList articles={search.articles} headingLevel={3} />
          </>
        ) : (
          <EmptyState
            icon="question"
            title={t("help.search.codeNone", { code: ltr(search.code ?? "") })}
            action={
              <Key as={LocaleLink} to={staffHref} size="sm" icon="chat-circle">
                {t("assistant.done.staff")}
              </Key>
            }
            recovery={
              <TextLink as={LocaleLink} to={assistantHref}>
                {t("help.search.ask")}
              </TextLink>
            }
          />
        )
      ) : search.articles.length > 0 ? (
        <>
          <p className="type-sm text-ink-2" role="status">
            {t("help.search.count", { count: search.articles.length })}
          </p>
          <GuideList articles={search.articles} headingLevel={3} className="sup-guides--cols" />
          <TextLink as={LocaleLink} to={assistantHref} className="justify-self-start">
            {t("help.search.ask")}
          </TextLink>
        </>
      ) : (
        <EmptyState
          icon="magnifying-glass"
          title={<BidiQuery text={t("help.search.none", { query: search.query })} />}
          text={t("help.search.noneText")}
          action={
            <Key as={LocaleLink} to={assistantHref} size="sm" icon="lifebuoy">
              {t("help.search.ask")}
            </Key>
          }
        />
      )}
    </section>
  );
}

/** A left-to-right isolate inside a sentence (codes): U+2066 … U+2069. */
const ltr = (text: string) => `${String.fromCharCode(0x2066)}${text}${String.fromCharCode(0x2069)}`;

/** The searched words are the shopper's own, in any script: isolated with their own direction. */
function BidiQuery({ text }: { text: string }) {
  return <span className="[unicode-bidi:plaintext]">{text}</span>;
}

function TaskTile({ to, icon, title, text }: { to: string; icon: IconName; title: string; text: string }) {
  return (
    <LocaleLink to={to} className="sup-task" data-press="soft">
      <span className="sup-task__icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="sup-task__title">{title}</span>
        <span className="sup-task__text">{text}</span>
      </span>
    </LocaleLink>
  );
}

/**
 * The platform segmented control and that platform's device tiles. Every platform's list is in the page: with script
 * the control shows one at a time (support.css hides the others); without script the control is hidden and the lists
 * follow one another under their platform's name, so every device stays one link away.
 */
function DevicePicker({ directory, current }: { directory: readonly SupportPlatformGroup[]; current: SupportDevice | null }) {
  const t = useT("support");
  const ui = useT("ui");
  const [platform, setPlatform] = useState(current?.platform.slug ?? directory[0]?.slug ?? "");
  const group = directory.find((entry) => entry.slug === platform) ?? directory[0];
  if (!group) return null;
  const name = (entry: SupportPlatformGroup) => (isPlatform(entry.slug) ? ui(`platform.${entry.slug}`) : entry.name);
  return (
    <div className="grid gap-4">
      <Segmented
        aria-label={t("help.devices.platforms")}
        value={group.slug}
        onChange={setPlatform}
        className="sup-platforms sup-js"
        options={directory.map((entry) => ({ value: entry.slug, label: name(entry), icon: isPlatform(entry.slug) ? <PlatformLed platform={entry.slug} /> : undefined }))}
      />
      {directory.map((entry) => (
        <div key={entry.id} className="sup-platform" data-current={entry.slug === group.slug ? "" : undefined}>
          <h3 className="sup-nojs type-sm-strong text-ink">
            <PlatformName slug={entry.slug} name={entry.name} />
          </h3>
          <ul role="list" aria-label={t("help.devices.list", { platform: name(entry) })} className="sup-devices">
            {entry.devices.map((device) => (
              <li key={device.id}>
                <DeviceTile name={device.name} artKey={device.artKey} kind={device.kind} href={`/support?device=${device.slug}#device-help`} current={device.slug === current?.slug} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DevicePanel({ device, guides }: { device: SupportDevice; guides: readonly ArticleSummary[] }) {
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
          <h2 id={headingId} className="type-h3 text-ink">
            <BidiLabel>{t("help.device.title", { device: device.name })}</BidiLabel>
          </h2>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Key as={LocaleLink} to={`/support/assistant?device=${device.slug}`} size="sm" icon="lifebuoy">
          {t("help.device.assistant")}
        </Key>
        <Key as={LocaleLink} to={`/support/repair?device=${device.slug}`} size="sm" icon="wrench">
          {t("help.device.repair")}
        </Key>
      </div>
      {/* The device's hub (devices area): every device listed here has one (published model, active platform). */}
      <DeviceHubLink device={device} title={t("help.device.hub", { device: device.name })} text={t("help.device.hubText")} className="border border-line" />
      <div className="grid gap-2">
        <h3 className="type-sm-strong text-ink">{t("help.device.guides")}</h3>
        {own.length + related.length === 0 ? <EmptyState title={t("help.device.empty")} text={t("help.device.emptyText")} /> : <GuideList articles={[...own, ...related]} showScope headingLevel={4} />}
      </div>
      <TextLink as={LocaleLink} to="/support#devices" className="justify-self-start">
        {t("help.device.change")}
      </TextLink>
    </section>
  );
}

/** How to reach a person: the store's channels when the owner configured them, otherwise the hand-off form. */
function ContactSection({ id }: { id: string }) {
  const t = useT("support");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const channels = layout?.shell?.contact?.channels ?? null;
  return (
    <section aria-labelledby={id} className="sup-section sup-contact">
      {/* the hand-off's own sentence belongs to the hand-off: beside the store's channels it would describe the wrong way */}
      <SectionHead id={id} title={t("help.contact.title")} reason={channels ? undefined : t("help.contact.text")} />
      {channels ? (
        <ContactCard channels={channels} />
      ) : (
        <div className="sup-card sup-write">
          <span className="sup-task__icon" aria-hidden="true">
            <Icon name="chat-circle" size={22} />
          </span>
          <p className="type-sm text-ink-2">{t("help.contact.writeText")}</p>
          <Key as={LocaleLink} to="/support/assistant?handoff=1#handoff" icon="chat-circle" className="justify-self-start">
            {t("help.contact.write")}
          </Key>
        </div>
      )}
    </section>
  );
}
