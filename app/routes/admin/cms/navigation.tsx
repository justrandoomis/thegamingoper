import { useState } from "react";
import { Form, useFetcher } from "react-router";

import type { Route } from "./+types/navigation";
import { discardNavDraft, getFilterEditor, getNavEditor, publishNav, saveFilters, saveNavDraft, type NavEditorEntry } from "~/server/services/admin/cms/navigation.server";
import { NAV_FEATURED_MAX, type ListingFilterGroup } from "~/server/services/admin/cms/rules";
import { invalid, isAppError } from "~/server/errors";
import { Select, Switch } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { failed, json, ok, openCms, orRespond, text } from "./cms.server";
import { ActionDialog, FormError, Note, PageHead, Section, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/navigation — 17.03: the storefront menu stays generated from the catalogue (platforms and top-level
 * categories with products); staff order, hide or feature its entries — saved as a draft, previewed as the phone
 * list and the desktop row, then published. And the listing filters: which groups a category page offers and in
 * what order (a default for every category, or a category's own).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, "cms.navigation.manage");
  const scope = new URL(request.url).searchParams.get("filters");
  const categoryId = scope && scope !== "default" ? scope : null;
  // a stale scope (a category switched off since the link was made) opens the default filters, not a 404 of the page
  const filterEditor = () => getFilterEditor(db, actor, categoryId, locale).catch((error: unknown) => (categoryId && isAppError(error, "not_found") ? getFilterEditor(db, actor, null, locale) : Promise.reject(error)));
  const [nav, filters] = await orRespond(() => Promise.all([getNavEditor(db, actor, locale, now), filterEditor()]));
  return { nav, filters };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.navigation.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "nav-save":
        return ok(intent, await saveNavDraft(req.db, req.actor, { platforms: json(form, "platforms"), categories: json(form, "categories"), version: text(form, "version") }, req.now, req.locale));
      case "nav-publish":
        return ok(intent, await publishNav(req.db, req.actor, { version: text(form, "version"), reason: text(form, "reason") }, req.now));
      case "nav-discard":
        return ok(intent, await discardNavDraft(req.db, req.actor, { version: text(form, "version"), reason: text(form, "reason") }, req.now));
      case "filters":
        return ok(intent, await saveFilters(req.db, req.actor, { categoryId: text(form, "categoryId"), groups: json(form, "groups"), mode: text(form, "mode") || "save", version: text(form, "version"), reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "nav.title");

type Entry = NavEditorEntry;

function EntryList({ title, entries, onChange }: { title: string; entries: Entry[]; onChange: (next: Entry[]) => void }) {
  const t = useCmsT();
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const set = (ref: string, change: Partial<Entry>) => onChange(entries.map((entry) => (entry.ref === ref ? { ...entry, ...change } : entry)));
  return (
    <ol className="cms-order" aria-label={title}>
      {entries.map((entry, index) => (
        <li key={entry.ref} data-hidden={entry.hidden ? "" : undefined}>
          <span className="cms-order__n">
            <bdi className="nums">{index + 1}</bdi>
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="cms-order__name type-strong">{entry.name}</span>
            <span className="flex flex-wrap items-center gap-1.5 type-caption text-ink-2">
              {entry.count > 0 ? t("nav.products", { count: entry.count }) : t("nav.noProducts")}
              {entry.featured && !entry.hidden ? <Status tone="info">{t("nav.featured")}</Status> : null}
              {entry.isNew ? <Status tone="warn">{t("nav.new")}</Status> : null}
            </span>
          </span>
          <span className="cms-order__keys">
            <IconKey icon="arrow-up" label={t("common.moveUp", { name: entry.name })} size="sm" disabled={index === 0} onClick={() => move(index, -1)} />
            <IconKey icon="arrow-down" label={t("common.moveDown", { name: entry.name })} size="sm" disabled={index === entries.length - 1} onClick={() => move(index, 1)} />
            <IconKey icon="star" label={t("nav.feature", { name: entry.name })} size="sm" held={entry.featured} disabled={entry.hidden} onClick={() => set(entry.ref, { featured: !entry.featured })} />
            <Switch label={t("nav.shown")} aria-label={t("nav.shownName", { name: entry.name })} checked={!entry.hidden} onChange={() => set(entry.ref, { hidden: !entry.hidden, featured: entry.hidden ? entry.featured : false })} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function Schematic({ platforms, categories }: { platforms: Entry[]; categories: Entry[] }) {
  const t = useCmsT();
  const visible = (list: Entry[]) => list.filter((entry) => !entry.hidden && entry.count > 0);
  const ordered = (list: Entry[]) => [...visible(list).filter((entry) => entry.featured), ...visible(list).filter((entry) => !entry.featured)];
  return (
    <div className="cms-schematic">
      <div className="grid gap-1">
        <p className="type-caption text-ink-2">{t("preview.phone")}</p>
        <ol className="cms-schematic__phone">
          {[...ordered(platforms), ...ordered(categories)].map((entry) => (
            <li key={entry.ref} className="cms-schematic__item" data-featured={entry.featured ? "" : undefined}>
              {entry.name}
            </li>
          ))}
        </ol>
      </div>
      <div className="grid min-w-0 gap-1">
        <p className="type-caption text-ink-2">{t("preview.desktop")}</p>
        <ol className="cms-schematic__desk">
          {ordered(platforms).map((entry) => (
            <li key={entry.ref} className="cms-schematic__item" data-featured={entry.featured ? "" : undefined}>
              {entry.name}
            </li>
          ))}
        </ol>
        <ol className="cms-schematic__desk">
          {ordered(categories).map((entry) => (
            <li key={entry.ref} className="cms-schematic__item" data-featured={entry.featured ? "" : undefined}>
              {entry.name}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function NavigationPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { nav, filters } = loaderData;
  const [platforms, setPlatforms] = useState(nav.platforms);
  const [categories, setCategories] = useState(nav.categories);
  const [groups, setGroups] = useState(filters.groups);
  const [dialog, setDialog] = useState<"publish" | "discard" | "filters" | "inherit" | null>(null);
  const [seen, setSeen] = useState(`${nav.version}|${filters.version}|${filters.categoryId ?? ""}`);
  const current = `${nav.version}|${filters.version}|${filters.categoryId ?? ""}`;
  if (seen !== current) {
    setSeen(current);
    setPlatforms(nav.platforms);
    setCategories(nav.categories);
    setGroups(filters.groups);
  }
  const save = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "nav-save", t("nav.saved"));
  const strip = (list: Entry[]) => list.map((entry) => ({ ref: entry.ref, hidden: entry.hidden, featured: entry.featured }));
  const navDirty = JSON.stringify(strip(platforms)) !== JSON.stringify(strip(nav.platforms)) || JSON.stringify(strip(categories)) !== JSON.stringify(strip(nav.categories));
  const featuredOver = platforms.filter((entry) => entry.featured && !entry.hidden).length > NAV_FEATURED_MAX || categories.filter((entry) => entry.featured && !entry.hidden).length > NAV_FEATURED_MAX;
  const filtersDirty = JSON.stringify(groups) !== JSON.stringify(filters.groups);
  const moveGroup = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    setGroups(next);
  };
  const toggleGroup = (group: ListingFilterGroup) => setGroups(groups.map((entry) => (entry.group === group ? { ...entry, visible: !entry.visible } : entry)));

  return (
    <>
      <PageHead title={t("nav.title")} lead={t("nav.lead")} />

      <Section id="menu" title={t("nav.menu")}>
        <div className="flex flex-wrap items-center gap-2">
          {nav.hasDraft ? <Status tone="warn">{t("nav.draftWaiting")}</Status> : <Status tone="neutral">{nav.hasPublished ? t("nav.publishedState") : t("nav.catalogueOrder")}</Status>}
          {nav.updatedAt ? (
            <span className="type-caption text-ink-2">
              {t("common.updated")}: <When at={nav.updatedAt} />
            </span>
          ) : null}
        </div>
        <div className="cms-split">
          <div className="grid min-w-0 gap-4">
            <div className="grid gap-2">
              <h3 className="adm-h3">{t("nav.platforms")}</h3>
              <EntryList title={t("nav.platforms")} entries={platforms} onChange={setPlatforms} />
            </div>
            <div className="grid gap-2">
              <h3 className="adm-h3">{t("nav.categories")}</h3>
              <EntryList title={t("nav.categories")} entries={categories} onChange={setCategories} />
            </div>
          </div>
          <aside className="grid gap-3">
            <div className="adm-card gap-2">
              <h3 className="adm-h3">{t("nav.previewTitle")}</h3>
              <Schematic platforms={platforms} categories={categories} />
              <p className="type-caption text-ink-2">{t("nav.previewNote")}</p>
            </div>
            <div className="adm-card gap-2">
              <save.Form method="post" className="grid gap-2">
                <input type="hidden" name="intent" value="nav-save" />
                <input type="hidden" name="version" value={String(nav.version)} />
                <input type="hidden" name="platforms" value={JSON.stringify(strip(platforms))} />
                <input type="hidden" name="categories" value={JSON.stringify(strip(categories))} />
                {featuredOver ? <FormError message={t("errors.nav_featured_max", { count: NAV_FEATURED_MAX })} /> : null}
                <FormError message={saved.message} />
                <Key type="submit" variant="ink" icon="floppy-disk" disabled={!navDirty || featuredOver} loading={saved.pending}>
                  {t("nav.saveDraft")}
                </Key>
              </save.Form>
              <Key icon="seal-check" disabled={!nav.hasDraft || navDirty} onClick={() => setDialog("publish")}>
                {t("nav.publish")}
              </Key>
              {nav.hasDraft ? (
                <Key size="sm" variant="ghost" onClick={() => setDialog("discard")}>
                  {t("nav.discard")}
                </Key>
              ) : null}
              {navDirty && nav.hasDraft ? <p className="type-caption text-ink-2">{t("nav.saveFirst")}</p> : null}
            </div>
          </aside>
        </div>
        <Note>
          <p>{t("nav.storefrontNote")}</p>
        </Note>
      </Section>

      <Section id="filters" title={t("filters.title")}>
        <p className="max-w-[72ch] type-body text-ink-2">{t("filters.lead")}</p>
        <Form method="get" className="cms-filters" preventScrollReset>
          <Select
            name="filters"
            label={t("filters.scope")}
            defaultValue={filters.categoryId ?? "default"}
            options={[{ value: "default", label: t("filters.default") }, ...filters.categories.map((category) => ({ value: category.id, label: category.own ? t("filters.own", { name: category.name }) : category.name }))]}
          />
          <Key type="submit" size="sm">
            {t("common.open")}
          </Key>
        </Form>
        <p className="type-caption text-ink-2">{filters.categoryId ? (filters.own ? t("filters.ownState", { name: filters.categoryName ?? "" }) : t("filters.followsDefault", { name: filters.categoryName ?? "" })) : filters.own ? t("filters.defaultSaved") : t("filters.defaultNone")}</p>
        <ol className="cms-order" aria-label={t("filters.title")}>
          {groups.map((entry, index) => (
            <li key={entry.group} data-hidden={entry.visible ? undefined : ""}>
              <span className="cms-order__n">
                <bdi className="nums">{index + 1}</bdi>
              </span>
              <span className="cms-order__name type-strong">{t(`filters.group.${entry.group}`)}</span>
              <span className="cms-order__keys">
                <IconKey icon="arrow-up" label={t("common.moveUp", { name: t(`filters.group.${entry.group}`) })} size="sm" disabled={index === 0} onClick={() => moveGroup(index, -1)} />
                <IconKey icon="arrow-down" label={t("common.moveDown", { name: t(`filters.group.${entry.group}`) })} size="sm" disabled={index === groups.length - 1} onClick={() => moveGroup(index, 1)} />
                <Switch label={t("nav.shown")} aria-label={t("nav.shownName", { name: t(`filters.group.${entry.group}`) })} checked={entry.visible} onChange={() => toggleGroup(entry.group)} />
              </span>
            </li>
          ))}
        </ol>
        <div className="cms-actions">
          <Key variant="ink" icon="floppy-disk" disabled={!filtersDirty && filters.own} onClick={() => setDialog("filters")}>
            {t("filters.save")}
          </Key>
          {filters.categoryId && filters.own ? (
            <Key size="sm" variant="ghost" onClick={() => setDialog("inherit")}>
              {t("filters.inherit")}
            </Key>
          ) : null}
        </div>
        <Note>
          <p>{t("filters.storefrontNote")}</p>
        </Note>
      </Section>

      <ActionDialog open={dialog === "publish"} onClose={() => setDialog(null)} title={t("nav.publishTitle")} consequence={t("nav.publishConsequence")} confirmLabel={t("nav.publish")} fields={{ intent: "nav-publish", version: String(nav.version) }} successMessage={t("nav.published")} />
      <ActionDialog open={dialog === "discard"} onClose={() => setDialog(null)} tone="destructive" title={t("nav.discardTitle")} consequence={t("nav.discardConsequence")} confirmLabel={t("nav.discard")} fields={{ intent: "nav-discard", version: String(nav.version) }} successMessage={t("nav.discarded")} />
      <ActionDialog
        open={dialog === "filters"}
        onClose={() => setDialog(null)}
        title={t("filters.saveTitle", { name: filters.categoryName ?? t("filters.default") })}
        consequence={t("filters.saveConsequence")}
        confirmLabel={t("filters.save")}
        impact={[
          { label: t("filters.shownCount"), value: String(groups.filter((entry) => entry.visible).length) },
          { label: t("filters.hiddenCount"), value: String(groups.filter((entry) => !entry.visible).length) },
        ]}
        fields={{ intent: "filters", categoryId: filters.categoryId ?? "", groups: JSON.stringify(groups), mode: "save", version: filters.version }}
        successMessage={t("filters.saved")}
      />
      <ActionDialog
        open={dialog === "inherit"}
        onClose={() => setDialog(null)}
        tone="destructive"
        title={t("filters.inheritTitle", { name: filters.categoryName ?? "" })}
        consequence={t("filters.inheritConsequence")}
        confirmLabel={t("filters.inherit")}
        fields={{ intent: "filters", categoryId: filters.categoryId ?? "", groups: "[]", mode: "inherit", version: filters.version }}
        successMessage={t("filters.saved")}
      />
    </>
  );
}
