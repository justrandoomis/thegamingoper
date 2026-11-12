/**
 * The row link to a device's hub, for other pages (Design System v2 §6.7 "the device-hub link row"): a paper card with a
 * hairline (no shadow, nothing lifts), a 72px product well at the start, the title and one line, the arrow toward the
 * reading end — on the product page of a device, a used unit, the help centre's device panel.
 *
 *   const device = await getDeviceLink(db, ctx.locale, slug);       // services/devices.server — null: no hub, no link
 *   <DeviceHubLink device={device} title={t("hub.title", { device: device.name })} text={t("hub.text")} />
 *
 * The well is the shared element `device-image:<slug>`: pressed, it grows into the hub head's photo (HubHead is the
 * target); reduced motion and browsers without View Transitions get the engine's fallbacks. The words come from the
 * host page's own namespace, so the link speaks on any page without loading the devices strings. Styled with the kit
 * and utilities only (no stylesheet of this area), so it looks the same wherever it is imported; `className` wins
 * (e.g. `bg-ground` on a paper panel).
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
    <MotionLink
      nav="zoom"
      to={`/device/${device.slug}`}
      data-press="soft"
      className={cx("group grid min-h-[96px] grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3 text-ink no-underline", className)}
    >
      <SharedElement name={`device-image:${device.slug}`} slot={slot} as="span" className="block">
        <Niche as="span" size="sm">
          {device.artKey ? <Render name={device.artKey} alt="" sizes="72px" /> : null}
        </Niche>
      </SharedElement>
      <span className="grid min-w-0 gap-0.5">
        <span className="type-card text-ink group-hover:underline group-hover:underline-offset-4">{title}</span>
        {text ? <span className="type-xs text-ink-2">{text}</span> : null}
      </span>
      <Icon name="arrow-right" size={20} className="text-ink-2" />
    </MotionLink>
  );
}
