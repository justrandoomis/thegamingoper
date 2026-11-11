import { useId } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ShelfRail } from "~/ui/ShelfRail";
import { TextLink } from "~/ui/TextLink";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { isolate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Used units of this model (DESIGN.md §8.7, last shelf): the used cards of the catalogue read layer, which say
 * whether the picture is the unit itself or an illustration. None listed → one sentence, the way to all used
 * devices, and trade-in.
 */
export function UsedSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  const device = isolate(hub.model.name);
  const all = `/used?platform=${hub.model.platform.slug}`;
  return (
    <div id="used" className={cx("grid gap-3", SECTION_SCROLL_MARGIN)}>
      {hub.used.length > 0 ? (
        <ShelfRail
          shelf={{ key: "used", title: t("used.title", { device }), reason: t("used.reason"), items: hub.used }}
          href={all}
          viewAllLabel={t("used.browse")}
          renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" />}
        />
      ) : (
        <section aria-labelledby={titleId} className="grid gap-3">
          <h2 id={titleId} className="type-section text-ink">
            {t("used.title", { device })}
          </h2>
          <EmptyState
            title={t("used.none", { device })}
            text={
              <>
                {t("used.noneHint")}{" "}
                <TextLink as={LocaleLink} to="/trade-in" inline>
                  {t("used.tradeIn")}
                </TextLink>
              </>
            }
            action={
              <Key as={LocaleLink} to={all} size="sm">
                {t("used.browse")}
              </Key>
            }
          />
        </section>
      )}
    </div>
  );
}
