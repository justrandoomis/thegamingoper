import { useId } from "react";

import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { CompatGroup, CompatItem } from "~/server/services/devices.server";
import { CompatBadge } from "~/ui/CompatBadge";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { BidiText, ProductCard, ProductImage } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { isolate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Games or accessories of the device, grouped by what the records say (compatibility is a stated fact, never
 * inferred — DESIGN.md §8.7, brief §6):
 *   verified, partial   rails of product cards (they can be bought for this device). The group's head says what the
 *                       status means; a card carries the rule's note under it, and a partial card always shows its
 *                       condition — partial is never rounded up to "works"
 *   unverified, incompatible   plain rows (no add key), named so nobody buys them for this device by mistake; long
 *                       lists start folded
 * The rails are `[data-shelf]` regions, so a click on a card is a click-through signal of that group (signals.ts).
 */
export function CompatSection({ id, title, note, groups, deviceName, emptyText }: { id: "accessories" | "games"; title: string; note?: string; groups: readonly CompatGroup[]; deviceName: string; emptyText: string }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const device = isolate(deviceName);
  const reasonOf = (group: CompatGroup) => `${t("compat.count", { count: group.items.length, n: f.number(group.items.length) })} · ${t(`compat.reason.${group.status}`)}`;

  return (
    <section id={id} aria-labelledby={titleId} className={cx("grid min-w-0 gap-5", SECTION_SCROLL_MARGIN)}>
      <div className="grid gap-0.5">
        <h2 id={titleId} className="type-section text-ink">
          {title}
        </h2>
        {note && groups.length > 0 ? <p className="type-caption text-ink-2">{note}</p> : null}
      </div>
      {groups.length === 0 ? (
        <EmptyState
          title={emptyText}
          text={t("compat.askHint")}
          action={
            <Key as={LocaleLink} to="/contact" size="sm">
              {t("compat.ask")}
            </Key>
          }
        />
      ) : null}
      {groups.map((group) =>
        group.status === "verified" || group.status === "partial" ? (
          <CompatRail key={group.status} shelfKey={`device_hub:${id}:${group.status}`} group={group} title={t(`compat.group.${group.status}`, { device })} reason={reasonOf(group)} />
        ) : (
          <CompatRows key={group.status} group={group} title={t(`compat.group.${group.status}`, { device })} reason={reasonOf(group)} />
        ),
      )}
    </section>
  );
}

function CompatRail({ shelfKey, group, title, reason }: { shelfKey: string; group: CompatGroup; title: string; reason: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-3" data-shelf={shelfKey}>
      <div className="grid gap-0.5">
        <h3 id={headingId} className="type-sub text-ink">
          {title}
        </h3>
        <p className="type-caption text-ink-2">{reason}</p>
      </div>
      <Rail aria-labelledby={headingId} railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
        {group.items.map((item) => (
          <CompatCard key={item.card.id} item={item} slot={shelfKey} />
        ))}
      </Rail>
    </section>
  );
}

function CompatCard({ item, slot }: { item: CompatItem; slot: string }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <ProductCard card={item.card} slot={slot} />
      {/* the group's head already says "works with …"; a verified card speaks only when its rule has something to add */}
      {item.status !== "verified" || item.note ? <CompatBadge status={item.status} note={item.note} /> : null}
    </div>
  );
}

function CompatRows({ group, title, reason }: { group: CompatGroup; title: string; reason: string }) {
  return (
    <Disclosure
      variant="panel"
      defaultOpen={group.items.length <= 4}
      icon={group.status === "incompatible" ? "x-circle" : "question"}
      summary={
        <span className="grid gap-0.5">
          <span className="type-strong text-ink">{title}</span>
          <span className="type-caption font-normal text-ink-2">{reason}</span>
        </span>
      }
    >
      <ul role="list" className="grid">
        {group.items.map((item) => (
          <li key={item.card.id} className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
            <span className="render-slot size-14 shrink-0 rounded-md bg-paper" aria-hidden="true">
              <ProductImage image={item.card.image} alt="" sizes="56px" shadow={false} pose={0} />
            </span>
            <span className="grid min-w-0 gap-1">
              <LocaleLink to={`/p/${item.card.slug}`} className="inline-flex min-h-11 items-center type-strong text-ink hover:underline">
                <span>
                  <BidiText text={item.card.name} />
                </span>
              </LocaleLink>
              <CompatBadge status={item.status} note={item.note} />
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
