import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import type { ContactChannel } from "../content-model";

/**
 * The channels the kit's <ContactCard> draws itself: WhatsApp, the phone, the e-mail address and the store's pages
 * elsewhere (its `email` and `links`); the map link beside the address.
 */
const CARD_KINDS: ReadonlySet<ContactChannel["kind"]> = new Set(["phone", "whatsapp", "email", "instagram", "facebook", "tiktok", "telegram"]);

const ICON: Record<ContactChannel["kind"], IconName> = {
  phone: "phone",
  whatsapp: "whatsapp-logo",
  email: "envelope-simple",
  instagram: "link",
  facebook: "link",
  tiktok: "link",
  telegram: "paper-plane-tilt",
  map: "map-pin",
};

/**
 * The channels beside the contact card: today only the map link when there is no address for the card to hang it on
 * (the card draws e-mail and the store's pages elsewhere itself since the kit's `email` / `links`). Only what the owner
 * filled in. Whatever the card draws is left out, so nothing shows twice.
 */
export function otherChannels(channels: readonly ContactChannel[], hasAddress: boolean): ContactChannel[] {
  return channels.filter((channel) => !CARD_KINDS.has(channel.kind) && !(channel.kind === "map" && hasAddress));
}

/**
 * Those channels as rows (the content pages' link-row anatomy): an icon, what it is, the address left-to-right under
 * it, and the new-tab mark for another site (said to screen readers too). The whole row is the link.
 */
export function ContactChannels({ channels, className }: { channels: readonly ContactChannel[]; className?: string }) {
  const t = useT("content");
  const ui = useT("ui");
  if (channels.length === 0) return null;
  return (
    <ul className={cx("crows crows--card", className)}>
      {channels.map((channel) => (
        <li key={channel.href}>
          <a href={channel.href} className="crow" data-press="soft" {...(channel.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            <span className="clay-disc crow__disc" aria-hidden="true">
              <Icon name={ICON[channel.kind]} size={20} mirror={false} />
            </span>
            <span className="crow__copy">
              <span className="crow__title">{t(`contact.kind.${channel.kind}`)}</span>
              {/* the line follows the page's alignment; the value inside keeps its left-to-right order */}
              <span className="cchannel__value break-all nums">
                <bdi dir="ltr">{channel.value}</bdi>
              </span>
            </span>
            <span className="crow__end">
              {channel.external ? (
                <>
                  <Icon name="arrow-square-out" size={18} />
                  <VisuallyHidden>{ui("link.external")}</VisuallyHidden>
                </>
              ) : (
                <Icon name="caret-right" size={18} className="crow__go" />
              )}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
