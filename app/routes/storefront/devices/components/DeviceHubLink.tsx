/**
 * The row link to a device's hub, for other pages (DESIGN.md §8.2: "row link to the device hub: a flat niche, render
 * at the start, arrow at the end") — the product page of a device, a used unit, the help centre's device panel.
 *
 *   const device = await getDeviceLink(db, ctx.locale, slug);       // services/devices.server — null: no hub, no link
 *   <DeviceHubLink device={device} title={t("hub.title", { device: device.name })} text={t("hub.text")} />
 *
 * The picture is the shared element `device-image:<slug>`: pressed, it grows into the hub's lit stage (HubHero is the
 * target); reduced motion and browsers without View Transitions get the engine's fallbacks. The words come from the
 * host page's own namespace, so the link speaks on any page without loading the devices strings.
 */
import { Icon } from "~/art/Icon";
import { MotionLink, SharedElement } from "~/motion";
import { cx } from "~/ui/cx";
import { Niche } from "~/ui/Niche";
import { Render } from "~/ui/Stage";

export type DeviceHubLinkProps = {
  device: { slug: string; name: string; artKey: string | null };
  /** The link's name, e.g. "كل شيء عن Nintendo Switch 2". */
  title: string;
  /** One line under it: what the hub has. */
  text?: string | null;
  /** Distinguishes two links to one hub on a page. */
  slot?: string;
  className?: string;
};

export function DeviceHubLink({ device, title, text, slot, className }: DeviceHubLinkProps) {
  return (
    <MotionLink nav="zoom" to={`/device/${device.slug}`} data-press="soft" className={cx("group flex min-h-[68px] items-center gap-3 rounded-lg bg-paper p-3 text-ink no-underline md:gap-4", className)}>
      <SharedElement name={`device-image:${device.slug}`} slot={slot} as="span" className="block w-16 shrink-0 md:w-20">
        <Niche as="span" ratio="1/1" tagZone={false}>
          {device.artKey ? <Render name={device.artKey} alt="" sizes="80px" /> : null}
        </Niche>
      </SharedElement>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="type-strong text-ink group-hover:underline group-hover:underline-offset-4">{title}</span>
        {text ? <span className="type-caption text-ink-2">{text}</span> : null}
      </span>
      <Icon name="arrow-right" size={20} className="shrink-0 text-ink-2" />
    </MotionLink>
  );
}
