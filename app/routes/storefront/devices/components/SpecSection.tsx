import { useId } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import type { DeviceHub, SpecGroupId } from "~/server/services/devices.server";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { TextLink } from "~/ui/TextLink";
import { isolate, SECTION_SCROLL_MARGIN } from "./format";

const GROUP_ICON: Record<SpecGroupId, IconName> = {
  performance: "cpu",
  display: "monitor",
  storage: "hard-drives",
  battery: "battery-high",
  connectivity: "plugs-connected",
  design: "scales",
  software: "translate",
  more: "clipboard-text",
};

/**
 * The researched spec sheet (device_models.specs), grouped — performance, screen, storage and expansion, battery,
 * connectivity, design, system and language — as plain rows on paper (DESIGN.md §0 law 5: flat is for reading).
 * Labels and values are the research's own words in the page's language. Where it comes from is one tap away.
 */
export function SpecSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  const device = isolate(hub.model.name);
  return (
    <section id="specs" aria-labelledby={titleId} className={cx("grid gap-3", SECTION_SCROLL_MARGIN)}>
      <h2 id={titleId} className="type-section text-ink">
        {t("specs.title", { device })}
      </h2>
      {hub.specs.length === 0 ? (
        <p className="panel px-4 py-6 type-body text-ink-2">{t("specs.none")}</p>
      ) : (
        <div className="grid items-start gap-card md:grid-cols-2">
          {hub.specs.map((group) => (
            <SpecGroupPanel key={group.id} id={group.id} title={t(`specs.groups.${group.id}`)} rows={group.rows} />
          ))}
        </div>
      )}
      {hub.sources.length > 0 ? (
        <Disclosure summary={t("specs.sources")} icon="book-open" variant="panel">
          <p className="type-caption text-ink-2">{t("specs.sourcesNote")}</p>
          <ul role="list" className="mt-2 grid gap-0.5">
            {hub.sources.map((source) => (
              <li key={source.url}>
                <TextLink href={source.url} external className="type-caption">
                  <bdi>{[source.publisher, source.title].filter(Boolean).join(" — ") || hostOf(source.url)}</bdi>
                </TextLink>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

function SpecGroupPanel({ id, title, rows }: { id: SpecGroupId; title: string; rows: { key: string; label: string; value: string }[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="panel panel--paper grid gap-1 px-4 pt-3 pb-1">
      <h3 id={headingId} className="flex items-center gap-2 type-sub text-ink">
        <Icon name={GROUP_ICON[id]} size={20} className="text-ink-2" />
        {title}
      </h3>
      <dl className="grid">
        {rows.map((row) => (
          <div key={row.key} className="grid gap-0.5 border-b border-line py-3 last:border-b-0 sm:grid-cols-[minmax(7rem,2fr)_5fr] sm:gap-4">
            <dt className="type-label text-ink-2">{row.label}</dt>
            <dd className="type-body text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
