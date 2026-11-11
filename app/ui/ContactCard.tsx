import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { Key } from "./Key";
import { Status } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * The contact card — Design System v2 §4.25: ONLY the channels the owner configured, from settings — WhatsApp (the
 * action «راسلنا على واتساب» → wa.me), a phone (a tel: link, the number isolated left-to-right), the address with
 * «افتح في الخرائط», opening hours with «مفتوح الآن / مغلق الآن» computed from the configured schedule (Iraq time), and
 * the usual reply time only when configured. With no channel configured it renders NOTHING — the caller shows «اكتب
 * لموظف» (the assistant hand-off) instead. Never «قريباً», never an invented number.
 *
 *   <ContactCard channels={settings.contact} primary now={loaderNow} />     the contact page (WhatsApp is its primary)
 *   <ContactCard channels={settings.contact} layout="row" />                 the footer's one-row form
 */
export type OpeningSlot = {
  /** Weekdays, Sunday = 0 (Iraq time). */
  days: readonly number[];
  /** "10:00" */
  open: string;
  /** "22:00" (a close before the open runs past midnight). */
  close: string;
};

export type ContactChannels = {
  /** WhatsApp number, international digits ("9647701234567"). */
  whatsapp?: string | null;
  /** Phone, E.164 ("+9647701234567"). */
  phone?: string | null;
  address?: string | null;
  /** A maps link for the address. */
  mapsUrl?: string | null;
  /** The schedule the open/closed state is computed from. */
  hours?: readonly OpeningSlot[] | null;
  /** The schedule in words, as the owner wrote it («السبت–الخميس، 10 صباحاً – 10 مساءً»). */
  hoursText?: string | null;
  /** The usual reply time, as the owner wrote it («خلال ساعة»). */
  replyTime?: string | null;
};

export type ContactCardProps = {
  channels: ContactChannels | null | undefined;
  /** WhatsApp is the view's one primary action (the contact page). Default: a secondary key. */
  primary?: boolean;
  layout?: "card" | "row";
  /** "Now" for the open/closed state (the loader's clock). Default: the browser's. */
  now?: number;
  className?: string;
};

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

/** Open at `now` (Iraq time) by the configured schedule; null when there is no usable schedule. Pure. */
export function openNow(hours: readonly OpeningSlot[] | null | undefined, now: number): boolean | null {
  if (!hours || hours.length === 0) return null;
  const clock = new Date(now + 3 * 3_600_000);
  const day = clock.getUTCDay();
  const at = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  let usable = false;
  for (const slot of hours) {
    const open = minutes(slot.open);
    const close = minutes(slot.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    usable = true;
    if (close > open) {
      if (slot.days.includes(day) && at >= open && at < close) return true;
    } else {
      // past midnight: open from `open` today, or until `close` on the day after an open day
      if (slot.days.includes(day) && at >= open) return true;
      if (slot.days.includes((day + 6) % 7) && at < close) return true;
    }
  }
  return usable ? false : null;
}

/** Whether any channel is configured (the caller shows «اكتب لموظف» when not). Pure. */
export function hasContact(channels: ContactChannels | null | undefined): boolean {
  return Boolean(channels && (channels.whatsapp || channels.phone || channels.address));
}

export function ContactCard({ channels, primary = false, layout = "card", now, className }: ContactCardProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!channels || !hasContact(channels)) return null;
  const open = openNow(channels.hours, now ?? Date.now());
  const digits = channels.whatsapp?.replace(/\D/g, "") ?? "";
  const phone = channels.phone ? (f.phone(channels.phone) ?? channels.phone) : null;
  const telHref = channels.phone ? `tel:${channels.phone.replace(/[^\d+]/g, "")}` : null;

  const rows = [
    digits ? (
      <li key="wa" className="contact__row">
        <Key as="a" href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer" variant={primary ? "primary" : "secondary"} icon="whatsapp-logo">
          {t("contact.whatsapp")}
        </Key>
        {channels.replyTime ? <span className="type-xs text-ink-2">{t("contact.reply", { time: channels.replyTime })}</span> : null}
      </li>
    ) : null,
    telHref && phone ? (
      <li key="tel" className="contact__row">
        <Icon name="phone" size={20} className="text-ink-2" />
        <a href={telHref} className="link">
          <span className="link__text">
            <bdi dir="ltr" className="nums">
              {phone}
            </bdi>
          </span>
        </a>
      </li>
    ) : null,
    channels.address ? (
      <li key="addr" className="contact__row">
        <Icon name="map-pin" size={20} className="text-ink-2" />
        <span className="min-w-0 flex-1">{channels.address}</span>
        {channels.mapsUrl ? (
          <TextLink as="a" href={channels.mapsUrl} external>
            {t("contact.maps")}
          </TextLink>
        ) : null}
      </li>
    ) : null,
    channels.hoursText || open !== null ? (
      <li key="hours" className="contact__row">
        <Icon name="clock" size={20} className="text-ink-2" />
        {channels.hoursText ? <span className="min-w-0 flex-1">{channels.hoursText}</span> : null}
        {open !== null ? <Status tone={open ? "ok" : "out"}>{t(open ? "contact.openNow" : "contact.closedNow")}</Status> : null}
      </li>
    ) : null,
  ].filter(Boolean);

  return <ul className={cx("contact", layout === "row" && "border-0 bg-transparent md:flex md:flex-wrap md:items-center", className)}>{rows}</ul>;
}
