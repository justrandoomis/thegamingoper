import { useId } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import type { DeviceHub, SpecGroupId } from "~/server/services/devices.server";
import { BidiText } from "~/ui/BidiText";
import { Disclosure } from "~/ui/Disclosure";
import { SectionHead } from "~/ui/SectionHead";
import { TextLink } from "~/ui/TextLink";
import { deviceIn } from "./format";

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
 * connectivity, design, system and language — as paper panels of rows between hairlines: the label 14/600 in ink-2,
 * the value 14 in ink (v2 §6.6, the PDP's spec rows). Labels and values are the research's own words in the page's
 * language; where they come from is one tap away (a disclosure with the sources). No sheet → no section.
 */
export function SpecSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  if (hub.specs.length === 0) return null;
  const device = deviceIn(hub.model.name);
  return (
    <section id="specs" aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={t("specs.title", { device })} />
      <div className="grid items-start gap-card md:grid-cols-2">
        {hub.specs.map((group) => (
          <SpecGroupPanel key={group.id} id={group.id} title={t(`specs.groups.${group.id}`)} rows={group.rows} />
        ))}
      </div>
      {hub.sources.length > 0 ? (
        <Disclosure summary={t("specs.sources")} icon="book-open" variant="panel" className="mt-(--gap-card)">
          <p className="type-sm text-ink-2">{t("specs.sourcesNote")}</p>
          <ul role="list" className="mt-2 grid">
            {hub.sources.map((source) => (
              <li key={source.url}>
                <TextLink href={source.url} external>
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
    <section aria-labelledby={headingId} className="panel min-w-0 px-5 pt-4 pb-1">
      <h3 id={headingId} className="flex items-center gap-2 type-h3 text-ink">
        <Icon name={GROUP_ICON[id]} size={20} className="text-ink-2" />
        {title}
      </h3>
      <dl className="devhub-specs mt-1">
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            {/* Latin runs isolated («Joy-Con 2», «USB-C»): a value that wraps inside one keeps its order */}
            <dd>
              <BidiText text={row.value} />
            </dd>
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
