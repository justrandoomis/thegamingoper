import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { getHomeLayoutEditor, listHeroPins, saveHomeLayout } from "~/server/services/admin/cms/home.server";
import { HERO_PLATFORMS, type HomeSectionKind } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import { EmptyState } from "~/ui/EmptyState";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Switch } from "~/ui/Field";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { failed, json, ok, openCms, orRespond, text } from "./cms.server";
import { ActionDialog, DemoTag, Note, PageHead, ResponsiveList, Section, StateBadge, When, useCmsT } from "./ui";

/**
 * /admin/cms/home — 17.01: the home page's sections (order, shown or hidden; the privacy panel always stays) and the
 * pinned heroes (a product and a headline per platform stage for a period). The storefront reads both through
 * getHomeLayout / getHomeHero once its home page is wired to them (docs/areas/admin-cms.md, requests).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, "cms.home.manage");
  const [layout, pins] = await orRespond(() => Promise.all([getHomeLayoutEditor(db, actor), listHeroPins(db, actor, locale, now)]));
  return { layout, pins, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.home.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "layout") throw invalid({ intent: "invalid" });
    const result = await saveHomeLayout(req.db, req.actor, { order: json(form, "order"), hidden: json(form, "hidden"), version: text(form, "version"), reason: text(form, "reason") }, req.now);
    return ok(intent, result);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "homePage.title");

export default function HomeContentPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { layout, pins } = loaderData;
  const [order, setOrder] = useState(layout.sections);
  const [dialog, setDialog] = useState(false);
  const dirty = JSON.stringify(order) !== JSON.stringify(layout.sections);
  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };
  const toggle = (kind: HomeSectionKind) => setOrder(order.map((section) => (section.kind === kind && !section.locked ? { ...section, visible: !section.visible } : section)));
  const shown = order.filter((section) => section.visible);

  return (
    <>
      <PageHead title={t("homePage.title")} lead={t("homePage.lead")} />

      <Section
        id="pins"
        title={t("pins.title")}
        aside={
          <Key as={Link} to="/admin/cms/home/pins/new" size="sm" icon="plus">
            {t("pins.new")}
          </Key>
        }
      >
        <p className="max-w-[72ch] type-body text-ink-2">{t("pins.lead")}</p>
        <ResponsiveList
          caption={t("pins.title")}
          rows={pins}
          rowKey={(row) => row.id}
          empty={<EmptyState icon="flag" title={t("pins.empty")} text={t("pins.emptyText", { count: HERO_PLATFORMS.length })} />}
          columns={[
            { key: "platform", header: t("pins.platform"), cell: (row) => (row.platform ? t(`platform.${row.platform}`) : "—") },
            {
              key: "headline",
              header: t("pins.headline"),
              cell: (row) => (
                <span className="grid gap-0.5">
                  <Link to={`/admin/cms/home/pins/${row.id}`} className="adm-link">
                    {row.headline || "—"}
                  </Link>
                  <span className="type-caption text-ink-2">{row.productName ?? "—"}</span>
                </span>
              ),
            },
            {
              key: "window",
              header: t("pins.window"),
              cell: (row) => (
                <span className="type-caption">
                  <When at={row.startsAt} /> → <When at={row.endsAt} />
                </span>
              ),
            },
            {
              key: "state",
              header: t("common.state"),
              cell: (row) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <StateBadge state={row.state} />
                  {row.pending ? <Status tone="warn">{t("pins.pending")}</Status> : null}
                  <DemoTag show={row.isDemo} />
                </span>
              ),
            },
          ]}
          card={(row) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-caption text-ink-2">{row.platform ? t(`platform.${row.platform}`) : "—"}</span>
                <StateBadge state={row.state} />
              </div>
              <Link to={`/admin/cms/home/pins/${row.id}`} className="adm-link type-strong">
                {row.headline || "—"}
              </Link>
              <p className="type-caption text-ink-2">{row.productName ?? "—"}</p>
              <p className="type-caption">
                <When at={row.startsAt} /> → <When at={row.endsAt} />
              </p>
              {row.pending ? <Status tone="warn">{t("pins.pending")}</Status> : null}
              <DemoTag show={row.isDemo} />
            </>
          )}
        />
      </Section>

      <Section id="layout" title={t("homePage.layout")}>
        <p className="max-w-[72ch] type-body text-ink-2">{t("homePage.layoutLead")}</p>
        <div className="cms-split">
          <ol className="cms-order" aria-label={t("homePage.layout")}>
            <li>
              <span className="cms-order__n">·</span>
              <span className="cms-order__name type-strong">{t("homeSection.hero")}</span>
              <span className="type-caption text-ink-2">{t("homePage.heroFixed")}</span>
            </li>
            {order.map((section, index) => (
              <li key={section.kind} data-hidden={section.visible ? undefined : ""}>
                <span className="cms-order__n">
                  <bdi className="nums">{index + 1}</bdi>
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="cms-order__name type-strong">{t(`homeSection.${section.kind}`)}</span>
                  {section.locked ? <span className="type-caption text-ink-2">{t("homePage.locked")}</span> : null}
                </span>
                <span className="cms-order__keys">
                  <IconKey icon="arrow-up" label={t("common.moveUp", { name: t(`homeSection.${section.kind}`) })} size="sm" disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconKey icon="arrow-down" label={t("common.moveDown", { name: t(`homeSection.${section.kind}`) })} size="sm" disabled={index === order.length - 1} onClick={() => move(index, 1)} />
                  <Switch label={t("homePage.shown")} aria-label={t("nav.shownName", { name: t(`homeSection.${section.kind}`) })} checked={section.visible} disabled={section.locked} onChange={() => toggle(section.kind)} />
                </span>
              </li>
            ))}
          </ol>
          <aside className="grid gap-3">
            <div className="adm-card gap-2">
              <h3 className="adm-h3">{t("homePage.previewTitle")}</h3>
              <p className="type-caption text-ink-2">{t("homePage.previewLead")}</p>
              <ol className="cms-schematic__phone" aria-label={t("homePage.previewTitle")}>
                <li className="cms-schematic__item" data-featured="">
                  {t("homeSection.hero")}
                </li>
                {shown.map((section) => (
                  <li key={section.kind} className="cms-schematic__item">
                    {t(`homeSection.${section.kind}`)}
                  </li>
                ))}
              </ol>
            </div>
            <div className="adm-card gap-2">
              <p className="type-caption text-ink-2">{layout.updatedAt ? t("homePage.savedAt") : t("homePage.ownOrder")}</p>
              {layout.updatedAt ? <When at={layout.updatedAt} /> : null}
              <div className="cms-actions">
                <Key variant="ink" icon="floppy-disk" disabled={!dirty} onClick={() => setDialog(true)}>
                  {t("homePage.save")}
                </Key>
                <Key variant="ghost" disabled={!dirty} onClick={() => setOrder(layout.sections)}>
                  {t("common.undo")}
                </Key>
              </div>
            </div>
          </aside>
        </div>
        <Note>
          <p>{t("homePage.storefrontNote")}</p>
        </Note>
      </Section>

      <ActionDialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={t("homePage.saveTitle")}
        consequence={t("homePage.saveConsequence")}
        confirmLabel={t("homePage.save")}
        impact={[
          { label: t("homePage.shownCount"), value: String(shown.length + 1) },
          { label: t("homePage.hiddenCount"), value: String(order.length - shown.length) },
        ]}
        fields={{ intent: "layout", order: JSON.stringify(order.map((section) => section.kind)), hidden: JSON.stringify(order.filter((section) => !section.visible).map((section) => section.kind)), version: String(layout.version) }}
        successMessage={t("homePage.saved")}
      />
    </>
  );
}
