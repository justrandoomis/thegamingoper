import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import type { ContactChannel } from "../content-model";

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

const ACTION: Record<ContactChannel["kind"], "phone" | "whatsapp" | "email" | "open"> = {
  phone: "phone",
  whatsapp: "whatsapp",
  email: "email",
  instagram: "open",
  facebook: "open",
  tiktok: "open",
  telegram: "open",
  map: "open",
};

/**
 * The owner's contact channels as rows: what it is, the number or address left-to-right, and one clay key that does
 * the thing (call, message, write, open). Other sites open in a new tab, and the key says so to screen readers.
 */
export function ContactChannels({ channels, compact = false, className }: { channels: readonly ContactChannel[]; compact?: boolean; className?: string }) {
  const t = useT("content");
  const ui = useT("ui");
  return (
    <ul className={cx("grid gap-3", !compact && "sm:grid-cols-2", className)}>
      {channels.map((channel) => (
        <li key={channel.href} className="panel flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-paper text-ink">
            <Icon name={ICON[channel.kind]} size={20} mirror={false} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="type-caption text-ink-2">{t(`contact.kind.${channel.kind}`)}</span>
            {/* the line follows the page's alignment; the value inside keeps its left-to-right order */}
            <span className="type-strong break-all text-ink nums">
              <bdi dir="ltr">{channel.value}</bdi>
            </span>
          </span>
          <Key
            as="a"
            href={channel.href}
            size="sm"
            iconEnd={channel.external ? "arrow-square-out" : undefined}
            {...(channel.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {t(`contact.action.${ACTION[channel.kind]}`)}
            {channel.external ? <VisuallyHidden> ({ui("link.external")})</VisuallyHidden> : null}
          </Key>
        </li>
      ))}
    </ul>
  );
}
