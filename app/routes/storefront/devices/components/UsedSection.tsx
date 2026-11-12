import { useId } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { SectionHead } from "~/ui/SectionHead";
import { TextLink } from "~/ui/TextLink";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { deviceIn } from "./format";

/**
 * Used units of this model — v2 §6.6 (the last section), drawn as the kit's used rows (§4.12, G14: a 96px well, the
 * grade, «البطارية 91% · ضمان 30 يوماً», the price and «اعرض تقرير الفحص»; the picture says when it is an illustration),
 * one column on phones and two from 1024, «عرض الكل» to the used list filtered to this model. None listed → no
 * section, only a closing line that keeps the two ways on: every used device of the platform, and trade-in.
 */
export function UsedSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  const device = deviceIn(hub.model.name);
  if (hub.used.length === 0) {
    return (
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3">
        <p className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-2 type-sm text-ink-2">
          <Icon name="recycle" size={20} />
          <span>{t("used.none", { device })}</span>
        </p>
        <TextLink as={LocaleLink} to={`/used?platform=${hub.model.platform.slug}`}>
          {t("used.browse")}
        </TextLink>
        <TextLink as={LocaleLink} to="/trade-in">
          {t("used.tradeIn")}
        </TextLink>
      </div>
    );
  }
  return (
    <section id="used" aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={t("used.title", { device })} reason={t("used.reason")} href={`/used?model=${hub.model.slug}`} />
      <ul role="list" className="grid gap-(--gap-card) lg:grid-cols-2">
        {hub.used.map((unit) => (
          <li key={unit.id} className="min-w-0">
            <UsedUnitCard unit={unit} layout="row" slot="used" />
          </li>
        ))}
      </ul>
    </section>
  );
}
