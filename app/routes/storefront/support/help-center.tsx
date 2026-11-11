/**
 * /support — the help centre (brief §7; DESIGN.md §8 "floor, keys, shelf"): three ways forward (the assistant, a repair
 * request, tracking one), the devices — choosing one shows its guides here (?device=<slug>) with honest scope labels —
 * every approved guide, and how to reach a person (the assistant's handoff and the store's own contact details, only
 * what the owner published).
 *
 * Data: the device directory and approved public guides (services/support/kb.server). Nothing here is invented: a
 * device without guides says so; the store's contact block shows only filled-in settings.
 */
import { useId } from "react";
import { useRouteLoaderData } from "react-router";

import type { Route } from "./+types/help-center";
import { Icon, type IconName } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { findDevice, getSupportDirectory, listArticlesForDevice, listHelpArticles } from "~/server/services/support/kb.server";
import type { ArticleSummary, SupportDevice, SupportPlatformGroup } from "~/server/services/support/types";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { DemoNote } from "~/ui/DemoNote";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { Rail } from "~/ui/Rail";
import { TextLink } from "~/ui/TextLink";
import { DeviceArt, DeviceTile, GuideList, PlatformName, SupportTabs } from "./components/parts";

export const handle = { nav: "push", order: 0, group: "support" } satisfies MotionHandle;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [directory, guides] = await Promise.all([getSupportDirectory(db, ctx.locale), listHelpArticles(db, ctx.locale)]);
  const device = findDevice(directory, url.searchParams.get("device"));
  const deviceGuides = device ? await listArticlesForDevice(db, ctx.locale, device.id, { related: true }) : [];
  return { directory, guides, device, deviceGuides, i18n: messagesFor(ctx.locale, "support") };
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { help?: { title?: string; description?: string } } } | undefined;
  return shellMeta(args, { title: tree?.meta?.help?.title, description: tree?.meta?.help?.description });
};

export default function HelpCenter({ loaderData }: Route.ComponentProps) {
  const { directory, guides, device, deviceGuides } = loaderData;
  const t = useT("support");
  const devicesId = useId();
  const guidesId = useId();
  const contactId = useId();
  const demo = guides.some((guide) => guide.isDemo);

  return (
    <div className="page grid gap-section pb-12 pt-4 lg:pt-6">
      <header className="grid gap-4">
        <SupportTabs current="help" />
        <div className="grid max-w-[68ch] gap-2">
          <h1 className="type-title text-ink">{t("help.title")}</h1>
          <p className="type-body text-ink-2">{t("help.lede")}</p>
        </div>
        <ul role="list" className="grid gap-card md:grid-cols-3">
          <PathCard to="/support/assistant" icon="lifebuoy" title={t("help.paths.assistant.title")} text={t("help.paths.assistant.text")} />
          <PathCard to="/support/repair" icon="wrench" title={t("help.paths.repair.title")} text={t("help.paths.repair.text")} />
          <PathCard to="/support/repair/status" icon="clipboard-text" title={t("help.paths.status.title")} text={t("help.paths.status.text")} />
        </ul>
      </header>

      {device ? <DevicePanel device={device} guides={deviceGuides} /> : null}

      <section aria-labelledby={devicesId} className="grid gap-4">
        <div className="grid gap-1">
          <h2 id={devicesId} className="type-section text-ink">
            {device ? t("help.device.change") : t("help.devices.title")}
          </h2>
          <p className="type-caption text-ink-2">{t("help.devices.hint")}</p>
        </div>
        {directory.map((group) => (
          <PlatformDevices key={group.id} group={group} current={device?.slug ?? null} />
        ))}
      </section>

      <div className="grid gap-section lg:grid-cols-12">
        <section aria-labelledby={guidesId} className="grid content-start gap-3 lg:col-span-7">
          <div className="grid gap-1">
            <h2 id={guidesId} className="type-section text-ink">
              {t("help.guides.title")}
            </h2>
            <p className="type-caption text-ink-2">{t("help.guides.hint")}</p>
          </div>
          {guides.length > 0 ? (
            <GuideList articles={guides} headingLevel={3} />
          ) : (
            <EmptyState icon="book-open" title={t("help.guides.empty")} text={t("help.guides.emptyText")} action={<Key as={LocaleLink} to="/support/assistant" size="sm">{t("nav.assistant")}</Key>} />
          )}
          {demo ? <DemoNote>{t("help.demo")}</DemoNote> : null}
        </section>
        <ContactBlock id={contactId} className="lg:col-span-5" />
      </div>
    </div>
  );
}

function PathCard({ to, icon, title, text }: { to: string; icon: IconName; title: string; text: string }) {
  return (
    <li className="flex">
      <Niche as={LocaleLink} to={to} variant="panel" data-press="soft" className="group flex w-full items-center gap-3 p-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-paper text-ink" aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="type-strong text-ink group-hover:underline">{title}</span>
          <span className="type-caption text-ink-2">{text}</span>
        </span>
        <Icon name="arrow-right" size={18} className="shrink-0 text-ink-2" />
      </Niche>
    </li>
  );
}

function PlatformDevices({ group, current }: { group: SupportPlatformGroup; current: string | null }) {
  const headingId = useId();
  return (
    <div className="grid gap-2">
      <h3 id={headingId} className="type-label text-ink">
        <PlatformName slug={group.slug} name={group.name} />
      </h3>
      <Rail aria-labelledby={headingId} itemClassName="flex w-[30%] sm:w-[22%] md:w-[18%] lg:w-[14%] xl:w-[12%]">
        {group.devices.map((device) => (
          <DeviceTile key={device.id} name={device.name} artKey={device.artKey} platform={group.slug} href={`/support?device=${device.slug}#device-help`} current={device.slug === current} />
        ))}
      </Rail>
    </div>
  );
}

function DevicePanel({ device, guides }: { device: SupportDevice; guides: readonly ArticleSummary[] }) {
  const t = useT("support");
  const headingId = useId();
  const own = guides.filter((guide) => guide.scope !== "related");
  const related = guides.filter((guide) => guide.scope === "related");
  return (
    <section id="device-help" aria-labelledby={headingId} className="grid scroll-mt-24 gap-4 rounded-panel bg-paper p-4 md:grid-cols-12 md:p-6">
      <div className="grid content-start gap-3 md:col-span-4">
        <div className="w-32 md:w-full md:max-w-[220px]">
          <DeviceArt artKey={device.artKey} platform={device.platform.slug} sizes="(min-width: 768px) 220px, 128px" />
        </div>
        <p className="type-caption text-ink-2">
          <PlatformName slug={device.platform.slug} name={device.platform.name} />
        </p>
        <h2 id={headingId} className="type-section text-ink">
          {t("help.device.title", { device: device.name })}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Key as={LocaleLink} to={`/support/assistant?device=${device.slug}`} variant="ink" size="sm" icon="lifebuoy">
            {t("help.device.assistant")}
          </Key>
          <Key as={LocaleLink} to={`/support/repair?device=${device.slug}`} size="sm" icon="wrench">
            {t("help.device.repair")}
          </Key>
        </div>
        <TextLink as={LocaleLink} to="/support" preventScrollReset>
          {t("help.device.change")}
        </TextLink>
        {/* Integration slot (devices area): a link to this device's hub, /device/<slug>, once that page exists. */}
      </div>
      <div className="grid content-start gap-2 md:col-span-8">
        <h3 className="type-sub text-ink">{t("help.device.guides")}</h3>
        {own.length + related.length === 0 ? (
          <EmptyState title={t("help.device.empty")} text={t("help.device.emptyText")} />
        ) : (
          <GuideList articles={[...own, ...related]} showScope headingLevel={4} />
        )}
      </div>
    </section>
  );
}

function ContactBlock({ id, className }: { id: string; className?: string }) {
  const t = useT("support");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const contact = layout?.shell?.contact;
  const ICONS: Record<string, IconName> = { phone: "phone", whatsapp: "whatsapp-logo", email: "envelope-simple", map: "map-pin" };
  return (
    <section aria-labelledby={id} className={`grid content-start gap-4 ${className ?? ""}`}>
      <div className="grid gap-3 rounded-panel bg-paper p-4 md:p-6">
        <h2 id={id} className="type-section text-ink">
          {t("help.contact.title")}
        </h2>
        <p className="type-body text-ink-2">{t("help.contact.text")}</p>
        <div>
          <Key as={LocaleLink} to="/support/assistant?handoff=1" variant="ink" icon="chat-circle">
            {t("help.contact.staff")}
          </Key>
        </div>
        <div className="grid gap-2 border-t border-line pt-3">
          <h3 className="type-label text-ink">{t("help.contact.store")}</h3>
          {contact && contact.links.length > 0 ? (
            <ul role="list" className="grid">
              {contact.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="flex min-h-11 items-center gap-2 text-ink hover:underline" {...(/^https?:/.test(link.href) ? { target: "_blank", rel: "noopener noreferrer" } : null)}>
                    <Icon name={ICONS[link.kind] ?? "link"} size={18} className="text-ink-2" />
                    <bdi dir={link.kind === "phone" || link.kind === "whatsapp" ? "ltr" : undefined}>{link.label}</bdi>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-caption text-ink-2">{t("help.contact.none")}</p>
          )}
          {contact?.address ? (
            <p className="type-caption text-ink-2">
              <b className="font-semibold text-ink">{t("help.contact.address")}</b> · {contact.address}
            </p>
          ) : null}
          {contact?.hours ? (
            <p className="type-caption text-ink-2">
              <b className="font-semibold text-ink">{t("help.contact.hours")}</b> · {contact.hours}
            </p>
          ) : null}
          <TextLink as={LocaleLink} to="/contact">
            {t("help.contact.page")}
          </TextLink>
        </div>
      </div>
    </section>
  );
}
