import { useId } from "react";

import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { CompatGroup, CompatItem } from "~/server/services/devices.server";
import { CompatBadge } from "~/ui/CompatBadge";
import { Disclosure } from "~/ui/Disclosure";
import { Niche } from "~/ui/Niche";
import { BidiText, ProductImage, wellKind } from "~/ui/ProductCard";
import { SectionHead } from "~/ui/SectionHead";
import { CardGrid } from "./CardGrid";
import { deviceIn } from "./format";

/**
 * Games or accessories of the device, grouped by what the records say — v2 §6.6 (compatibility is a stated fact, never
 * inferred; every state with its word, G17):
 *   verified     the section's cards — the head says they were checked against reliable sources; every card carries
 *                its state word under it («متوافق»), with the rule's note when it adds something
 *   partial      «تعمل بشرط»: cards, each with its condition under it («متوافق جزئياً» + the condition) — partial is
 *                never rounded up to "works"
 *   unverified, incompatible   folded rows on paper (no add button), named so nobody buys them for this device by
 *                mistake: a small well, the name (a link), the state word and the rule's note — GAMES only: the page
 *                passes accessories through `accessoryGroups` (format.ts), because §6.6 lists compatible accessories
 *                only (verified, or with a condition)
 * Cards come in whole rows, two rows at first (CardGrid); one item is a row card. Nothing recorded → no section.
 * The card groups are `[data-shelf]` regions, so opening a card is a click-through signal of that group (signals.ts).
 * The rule's notes and the reasons are reading text: 16 / 1.75 on phones and tablets (v2.1 G7, devices.css
 * `.devhub-read`, `.devhub-note`), 14 (the notes 13) from 1024.
 */
export function CompatSection({
  id,
  title,
  reason,
  allLabel,
  groups,
  deviceName,
}: {
  id: "accessories" | "games";
  title: string;
  reason: string;
  allLabel: (n: string) => string;
  groups: readonly CompatGroup[];
  deviceName: string;
}) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const partialId = useId();
  const items = (status: CompatGroup["status"]) => groups.find((group) => group.status === status)?.items ?? [];
  const verified = items("verified");
  const partial = items("partial");
  const rows = groups.filter((group) => (group.status === "unverified" || group.status === "incompatible") && group.items.length > 0);
  if (verified.length + partial.length + rows.length === 0) return null;
  const reasonOf = (group: CompatGroup) => `${t("compat.count", { count: group.items.length, n: f.number(group.items.length) })} · ${t(`compat.reason.${group.status}`)}`;

  return (
    <section id={id} aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={title} reason={verified.length > 0 ? reason : undefined} />
      {verified.length > 0 ? (
        <div data-shelf={`device_hub:${id}:verified`}>
          {/* every card carries its state word, with or without a note: a card without it beside cards with it would
              read as "not checked" (G17: compatibility with state words) */}
          <CardGrid
            items={verified.map((item) => ({ card: item.card, note: <CompatBadge status="verified" note={item.note} /> }))}
            slot={`${id}:verified`}
            anchor={id}
            allLabel={allLabel(f.number(verified.length))}
          />
        </div>
      ) : null}
      {partial.length > 0 ? (
        <section aria-labelledby={partialId} className={verified.length > 0 ? "mt-10" : undefined} data-shelf={`device_hub:${id}:partial`}>
          <div className="mb-4 grid gap-1">
            <h3 id={partialId} className="type-h3 text-ink">
              {t("compat.group.partial")}
            </h3>
            <p className="devhub-read text-ink-2">{t("compat.reason.partial")}</p>
          </div>
          <CardGrid
            items={partial.map((item) => ({ card: item.card, note: <CompatBadge status="partial" note={item.note} /> }))}
            slot={`${id}:partial`}
            anchor={id}
            headingLevel={4}
            allLabel={t("compat.allPartial", { n: f.number(partial.length) })}
          />
        </section>
      ) : null}
      {rows.length > 0 ? (
        <div className={verified.length + partial.length > 0 ? "mt-10 grid gap-(--gap-card)" : "grid gap-(--gap-card)"}>
          {rows.map((group) => (
            <CompatRows key={group.status} group={group} title={t(`compat.group.${group.status}`, { device: deviceIn(deviceName) })} reason={reasonOf(group)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CompatRows({ group, title, reason }: { group: CompatGroup; title: string; reason: string }) {
  return (
    <Disclosure
      variant="panel"
      defaultOpen={group.items.length <= 3}
      icon={group.status === "incompatible" ? "x-circle" : "question"}
      summary={
        <span className="grid gap-0.5">
          <span className="type-card text-ink">{title}</span>
          <span className="devhub-read text-ink-2">{reason}</span>
        </span>
      }
    >
      <ul role="list" className="devhub-rows grid">
        {group.items.map((item) => (
          <CompatRow key={item.card.id} item={item} />
        ))}
      </ul>
    </Disclosure>
  );
}

function CompatRow({ item }: { item: CompatItem }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <Niche as="span" size="sm" kind={wellKind(item.card)} className="w-14 shrink-0" aria-hidden="true">
        <ProductImage image={item.card.image} alt="" sizes="56px" />
      </Niche>
      <span className="devhub-note grid min-w-0 gap-1">
        <LocaleLink to={`/p/${item.card.slug}`} className="inline-flex min-h-11 items-center type-sm-strong text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
          {/* one inline run: as flex items, the Arabic word and the isolated Latin name would lose the space between them */}
          <span>
            <BidiText text={item.card.name} />
          </span>
        </LocaleLink>
        <CompatBadge status={item.status} note={item.note} />
      </span>
    </li>
  );
}
