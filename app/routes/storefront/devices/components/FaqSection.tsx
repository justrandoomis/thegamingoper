import { useId } from "react";

import { useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { Accordion } from "~/ui/Accordion";
import { SectionHead } from "~/ui/SectionHead";
import { deviceIn } from "./format";

/**
 * Questions answered only from the facts on this page (storage, discs, battery, language, TV, the store's games, the
 * box) — devices.server.ts → buildFaq leaves out every question it has no fact for. The kit's accordion: 56px rows
 * between hairlines, native <details> (keyboard, find-in-page, before JavaScript). No question → no section.
 */
export function FaqSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const titleId = useId();
  if (hub.faq.length === 0) return null;
  const name = hub.model.name;
  const device = deviceIn(name);
  return (
    <section id="faq" aria-labelledby={titleId} className="min-w-0 lg:max-w-[52rem]">
      <SectionHead id={titleId} title={t("faq.title", { device })} reason={t("faq.note")} />
      <Accordion
        items={hub.faq.map((entry) => ({
          id: entry.id,
          // the service writes the name in, isolated as one run: isolate its Latin runs only (an Arabic qualifier stays in
          // the sentence) and keep its short last word with it («Switch 2؟» never splits)
          summary: entry.question.includes(`\u2068${name}\u2069`) ? entry.question.replace(`\u2068${name}\u2069`, device) : entry.question.replace(name, device),
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
