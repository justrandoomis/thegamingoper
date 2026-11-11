import { useId } from "react";

import { useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { Accordion } from "~/ui/Accordion";
import { cx } from "~/ui/cx";
import { isolate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Questions answered only from the facts on this page (storage, discs, battery, language, TV, the store's games, the
 * box) — devices.server.ts → buildFaq leaves out every question it has no fact for. Native <details> rows.
 */
export function FaqSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  if (hub.faq.length === 0) return null;
  return (
    <section id="faq" aria-labelledby={titleId} className={cx("grid gap-3", SECTION_SCROLL_MARGIN)}>
      <div className="grid gap-0.5">
        <h2 id={titleId} className="type-section text-ink">
          {t("faq.title", { device: isolate(hub.model.name) })}
        </h2>
        <p className="type-caption text-ink-2">{t("faq.note")}</p>
      </div>
      <Accordion
        items={hub.faq.map((entry) => ({
          id: entry.id,
          summary: entry.question,
          content: (
            <div className="grid gap-2">
              {entry.answer.map((line, index) => (
                <p key={index} className="type-body text-ink">
                  {line}
                </p>
              ))}
            </div>
          ),
        }))}
      />
    </section>
  );
}
