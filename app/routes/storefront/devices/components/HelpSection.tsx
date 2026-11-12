import { useId, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { DeviceHub } from "~/server/services/devices.server";
import { Accordion } from "~/ui/Accordion";
import { CompatBadge } from "~/ui/CompatBadge";
import { FactList, type Fact } from "~/ui/FactList";
import { SectionHead } from "~/ui/SectionHead";
import { TextLink } from "~/ui/TextLink";
import { CardGrid } from "./CardGrid";
import { deviceIn, isolateName } from "./format";

/** The one "talk to a person" destination of the store (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";

/**
 * Setup and repair — v2 §6.6 "setup guides (disclosure rows); a row link to the assistant": the approved guides as
 * disclosure rows (the kind, who it was written for, the title; opened: its summary and «اقرأ الدليل»), then the
 * service rows — the row link «شيء لا يعمل؟ اسأل مساعد الصيانة» to the assistant and «اطلب صيانة لـ …» to a repair
 * request for this device — and the diagnosis trees as rows into the assistant, then the spare parts the store sells
 * (cards with their compatibility), and the warranty as a fact — or, while the store has set none, as a question
 * (never an admission). Every destination belongs to the support or content area:
 *   /support/article/<slug>                          an approved public knowledge article
 *   /support/assistant?device=<slug>[&symptom=<key>]  the maintenance assistant, opened on this device / symptom
 *   /support/repair?device=<slug>                    a repair request for this device
 *   /support/assistant?handoff=1#handoff             talk to a person · /policies/warranty  the warranty policy
 */
export function HelpSection({ hub, platformName }: { hub: DeviceHub; platformName: string }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const guidesId = useId();
  const treesId = useId();
  const partsId = useId();
  const slug = hub.model.slug;
  const device = deviceIn(hub.model.name);
  const months = hub.warrantyMonths;

  const warranty: Fact =
    months.length === 1
      ? { icon: "shield-check", title: t("help.warrantyStore", { count: months[0], n: f.number(months[0]) }), link: { label: t("help.warrantyPolicy"), to: "/policies/warranty" } }
      : months.length > 1
        ? { icon: "shield-check", title: t("help.warranty"), text: t("help.warrantyMixed"), link: { label: t("help.warrantyPolicy"), to: "/policies/warranty" } }
        : { icon: "shield-check", title: t("help.warranty"), link: { label: t("help.warrantyAsk"), to: HANDOFF } };

  return (
    <section id="help" aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={t("help.title")} reason={t("help.reason")} />
      <div className="grid items-start gap-10 lg:grid-cols-2">
        {hub.articles.length > 0 ? (
          <section aria-labelledby={guidesId} className="min-w-0">
            <h3 id={guidesId} className="mb-2 type-h3 text-ink">
              {t("help.guides")}
            </h3>
            <Accordion
              items={hub.articles.map((article) => ({
                id: article.slug,
                icon: article.kind === "troubleshooting" ? "lifebuoy" : "book-open",
                summary: (
                  <span className="grid gap-0.5">
                    <span className="type-xs text-ink-2">
                      {[
                        t(`help.kind.${article.kind}`),
                        article.scope === "platform" ? t("help.scopePlatform", { platform: isolateName(platformName) }) : null,
                        article.scope === "sibling" && article.writtenFor ? t("help.scopeSibling", { device: isolateName(article.writtenFor) }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span>{article.title}</span>
                  </span>
                ),
                content: (
                  <div className="grid justify-items-start gap-2">
                    {article.summary ? <p className="type-sm text-ink-2">{article.summary}</p> : null}
                    <TextLink as={MotionLink} to={`/support/article/${article.slug}`}>
                      {t("help.read")}
                    </TextLink>
                  </div>
                ),
              }))}
            />
          </section>
        ) : null}

        <div className="grid min-w-0 gap-10">
          {/* the service rows: the assistant (the row link §6.6 asks for) and a repair request for this device */}
          <ul role="list" className="panel devhub-rows grid px-4">
            <li>
              <HelpRow to={`/support/assistant?device=${slug}`} icon="chat-circle" title={t("help.assistant")} text={t("help.assistantHint")} />
            </li>
            <li>
              <HelpRow to={`/support/repair?device=${slug}`} icon="wrench" title={t("help.repair", { device })} text={t("help.repairHint")} />
            </li>
          </ul>

          {hub.trees.length > 0 ? (
            <section aria-labelledby={treesId} className="min-w-0">
              <h3 id={treesId} className="type-h3 text-ink">
                {t("help.trees")}
              </h3>
              <p className="mb-3 type-sm text-ink-2">{t("help.treesHint")}</p>
              <ul role="list" className="panel devhub-rows grid px-4">
                {hub.trees.map((tree) => {
                  const scope = tree.scope === "all" ? t("help.treeAll") : tree.scope === "platform" ? t("help.treePlatform", { platform: isolateName(platformName) }) : null;
                  return (
                    <li key={tree.symptomKey}>
                      <HelpRow to={`/support/assistant?device=${slug}&symptom=${encodeURIComponent(tree.symptomKey)}`} icon="first-aid-kit" title={tree.title} kicker={scope} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      {hub.parts.length > 0 ? (
        <section aria-labelledby={partsId} className="mt-10 min-w-0" data-shelf="parts">
          <h3 id={partsId} className="mb-4 type-h3 text-ink">
            {t("help.parts")}
          </h3>
          <CardGrid
            items={hub.parts.map((item) => ({ card: item.card, note: <CompatBadge status={item.status} note={item.note} /> }))}
            slot="parts"
            anchor="help"
            headingLevel={4}
            allLabel={t("help.allParts", { n: f.number(hub.parts.length) })}
          />
        </section>
      ) : null}

      <FactList facts={[warranty]} className="mt-10 max-w-[40rem]" />
    </section>
  );
}

/**
 * One row link of the section (§6.6 "a row link"): a 20px icon, the title (14/600) with an optional line above it
 * (who it is for) or under it (what happens), and the arrow toward the reading end. 56px at least; the whole row is
 * the link.
 */
function HelpRow({ to, icon, title, text, kicker }: { to: string; icon: IconName; title: ReactNode; text?: ReactNode; kicker?: ReactNode }) {
  return (
    <MotionLink to={to} data-press="soft" className="group flex min-h-14 items-center gap-3 py-3 text-ink no-underline">
      <Icon name={icon} size={20} className="shrink-0 text-ink-2" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        {kicker ? <span className="type-xs text-ink-2">{kicker}</span> : null}
        <span className="type-sm-strong group-hover:underline group-hover:underline-offset-4">{title}</span>
        {text ? <span className="type-xs text-ink-2">{text}</span> : null}
      </span>
      <Icon name="arrow-right" size={20} className="shrink-0 text-ink-2" />
    </MotionLink>
  );
}
