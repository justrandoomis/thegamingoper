import { useId } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { DeviceHub } from "~/server/services/devices.server";
import { CompatBadge } from "~/ui/CompatBadge";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { ProductCard } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { TextLink } from "~/ui/TextLink";
import { isolate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Setup, troubleshooting, repair, spare parts and warranty (DESIGN.md §8.7: guides as rows on paper, then the row
 * link to the repair assistant). Every destination belongs to the support or content area:
 *   /support/article/<slug>                         an approved public knowledge article (support area)
 *   /support/assistant?device=<slug>[&symptom=<key>] the maintenance assistant, opened on this device / symptom
 *   /support/repair?device=<slug>                   a repair request for this device
 *   /policies/warranty                              the store's warranty policy (content area)
 * The warranty line says what the store has decided — and, while it has not, exactly that.
 */
export function HelpSection({ hub, platformName }: { hub: DeviceHub; platformName: string }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const guidesId = useId();
  const partsId = useId();
  const warrantyId = useId();
  const slug = hub.model.slug;
  const device = isolate(hub.model.name);
  const months = hub.warrantyMonths;

  return (
    <section id="help" aria-labelledby={titleId} className={cx("grid gap-4", SECTION_SCROLL_MARGIN)}>
      <h2 id={titleId} className="type-section text-ink">
        {t("help.title")}
      </h2>
      <div className="grid items-start gap-card lg:grid-cols-2">
        <section aria-labelledby={guidesId} className="grid gap-2">
          <h3 id={guidesId} className="type-sub text-ink">
            {t("help.guides")}
          </h3>
          {hub.articles.length === 0 ? (
            <p className="panel px-4 py-5 type-body text-ink-2">{t("help.noGuides")}</p>
          ) : (
            <ul role="list" className="grid gap-2">
              {hub.articles.map((article) => (
                <li key={article.slug}>
                  <RowLink
                    to={`/support/article/${article.slug}`}
                    icon={article.kind === "troubleshooting" ? "lifebuoy" : "book-open"}
                    kicker={[
                      t(`help.kind.${article.kind}`),
                      article.scope === "platform" ? t("help.scopePlatform", { platform: isolate(platformName) }) : null,
                      article.scope === "sibling" && article.writtenFor ? t("help.scopeSibling", { device: isolate(article.writtenFor) }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    title={article.title}
                    hint={article.summary}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="grid gap-2">
          <RowLink to={`/support/assistant?device=${slug}`} icon="robot" title={t("help.assistant")} hint={t("help.assistantHint")} />
          <RowLink to={`/support/repair?device=${slug}`} icon="wrench" title={t("help.repair", { device })} hint={t("help.repairHint")} />
          {hub.trees.length > 0 ? (
            <div className="grid gap-2 pt-2">
              <p className="type-sub text-ink">{t("help.trees")}</p>
              <p className="type-caption text-ink-2">{t("help.treesHint")}</p>
              <ul role="list" className="grid gap-2">
                {hub.trees.map((tree) => (
                  <li key={tree.symptomKey}>
                    <RowLink
                      to={`/support/assistant?device=${slug}&symptom=${encodeURIComponent(tree.symptomKey)}`}
                      icon="first-aid-kit"
                      kicker={tree.scope === "all" ? t("help.treeAll") : tree.scope === "platform" ? t("help.treePlatform", { platform: isolate(platformName) }) : null}
                      title={tree.title}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid items-start gap-card lg:grid-cols-2">
        <section aria-labelledby={partsId} className="grid min-w-0 gap-2">
          <h3 id={partsId} className="type-sub text-ink">
            {t("help.parts")}
          </h3>
          {hub.parts.length === 0 ? (
            <EmptyState
              title={t("help.noParts")}
              text={t("help.noPartsHint")}
              action={
                <Key as={LocaleLink} to={`/support/repair?device=${slug}`} size="sm" icon="wrench">
                  {t("help.repairShort")}
                </Key>
              }
            />
          ) : (
            <Rail aria-labelledby={partsId}>
              {hub.parts.map((item) => (
                <div key={item.card.id} className="flex w-full min-w-0 flex-col gap-2">
                  <ProductCard card={item.card} slot="parts" />
                  <CompatBadge status={item.status} note={item.note} />
                </div>
              ))}
            </Rail>
          )}
        </section>
        <section aria-labelledby={warrantyId} className="panel grid gap-2 p-4">
          <h3 id={warrantyId} className="flex items-center gap-2 type-sub text-ink">
            <Icon name="shield-check" size={20} className="text-ink-2" />
            {t("help.warranty")}
          </h3>
          <p className="type-body text-ink">
            {months.length === 1 ? t("help.warrantyStore", { count: months[0], n: f.number(months[0]) }) : months.length > 1 ? t("help.warrantyMixed") : t("help.warrantyNone")}
          </p>
          <TextLink as={LocaleLink} to="/policies/warranty">
            {t("help.warrantyPolicy")}
          </TextLink>
        </section>
      </div>
    </section>
  );
}

/** A row link on a flat niche: icon at the start, the words, the arrow at the end (DESIGN.md §8.2, §8.7). */
function RowLink({ to, icon, title, hint, kicker }: { to: string; icon: IconName; title: string; hint?: string | null; kicker?: string | null }) {
  return (
    <Niche variant="panel" as={MotionLink} to={to} data-press="soft" className="flex min-h-[4.5rem] items-center gap-3 rounded-lg px-4 py-3 outline-offset-2">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-paper text-ink" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        {kicker ? <span className="type-caption text-ink-2">{kicker}</span> : null}
        <span className="type-strong text-ink">{title}</span>
        {hint ? <span className="line-clamp-2 type-caption text-ink-2">{hint}</span> : null}
      </span>
      <Icon name="arrow-right" size={20} className="shrink-0 text-ink-2" />
    </Niche>
  );
}
