import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/seo-item";
import { getSeoEditor, saveSeo } from "~/server/services/admin/cms/seo.server";
import { SEO_LIMITS, clipText } from "~/server/services/admin/cms/rules";
import type { Locale } from "~/lib/locales";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Segmented } from "~/ui/Segmented";
import { cmsMeta } from "./meta";
import { checked, failed, l10n, ok, openCms, orRespond, text } from "./cms.server";
import { CONTENT_LANGS, Code, FormError, L10nFields, Note, PageHead, Pair, Section, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/seo/:type/:id — 17.04 / 17.06: a product's or a category's search-engine title and description in
 * ar/en/ckb, and whether search engines may list it, with the result as a search engine would show it at a phone's
 * and a desktop's width (a field left empty shows what the storefront uses instead). A product's SEO is saved through
 * the catalogue's own write path (its version, history and audit).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor } = await openCms(context, "cms.seo.manage");
  return { editor: await orRespond(() => getSeoEditor(db, actor, params.type, params.id)) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openCms(context, "cms.seo.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    return ok(
      intent || "save",
      await saveSeo(req.db, req.actor, { type: params.type, id: params.id, version: text(form, "version"), title: l10n(form, "title"), description: l10n(form, "description"), noindex: checked(form, "noindex"), reason: text(form, "reason") }, req.now),
    );
  } catch (error) {
    return failed(error, req.locale, intent || "save");
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, null, undefined, args.loaderData?.editor.name.ar ?? null);

type Words = Partial<Record<Locale, string>>;

function Snippet({ width, url, title, description }: { width: "phone" | "desktop"; url: string; title: string; description: string }) {
  const t = useCmsT();
  return (
    <figure className="grid gap-1">
      <figcaption className="type-caption text-ink-2">{width === "phone" ? t("preview.phone") : t("preview.desktop")}</figcaption>
      <div className="cms-snippet" data-width={width}>
        <span className="cms-snippet__url">
          <bdi dir="ltr">{url}</bdi>
        </span>
        <span className="cms-snippet__title">{clipText(title, width === "phone" ? 55 : SEO_LIMITS.titleIdeal)}</span>
        <span className="cms-snippet__text">{description ? clipText(description, width === "phone" ? 120 : SEO_LIMITS.descriptionIdeal) : t("seo.noDescription")}</span>
      </div>
    </figure>
  );
}

export default function SeoItemPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { editor } = loaderData;
  const [title, setTitle] = useState<Words>(editor.seo.title ?? {});
  const [description, setDescription] = useState<Words>(editor.seo.description ?? {});
  const [noindex, setNoindex] = useState(editor.seo.noindex);
  const [lang, setLang] = useState<Locale>("ar");
  const [seen, setSeen] = useState(editor.version);
  if (seen !== editor.version) {
    setSeen(editor.version);
    setTitle(editor.seo.title ?? {});
    setDescription(editor.seo.description ?? {});
    setNoindex(editor.seo.noindex);
  }
  const save = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", (data) => (data.saved ? t("seo.saved") : t("seo.nothing")));
  const pickWord = (words: Words, fallback: Partial<Record<Locale, string>> | null) => (words[lang] || words.ar || fallback?.[lang] || fallback?.ar || "").trim();
  const shownTitle = pickWord(title, editor.fallback.title);
  const shownDescription = pickWord(description, editor.fallback.description);
  const prefix = lang === "ar" ? "" : `/${lang}`;
  const url = `tamtamgames.com${prefix}${editor.path}`;
  const titleLength = [...(title.ar ?? "")].length;
  const descriptionLength = [...(description.ar ?? "")].length;

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/cms/seo" className="adm-link">
            {t("seo.title")}
          </Link>
        }
        title={editor.name.ar}
        lead={editor.type === "product" ? t("seo.productLead") : t("seo.categoryLead")}
        actions={
          <Key as="a" href={editor.path} size="sm" iconEnd="arrow-square-out" target="_blank" rel="noopener">
            {t("page.onStore")}
          </Key>
        }
      />
      <div className="cms-split">
        <div className="grid min-w-0 gap-5">
          <Section id="form" title={t("seo.edit")}>
            <save.Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="version" value={editor.version} />
              <L10nFields name="title" label={t("seo.searchTitle")} values={title} onChange={(code, value) => setTitle({ ...title, [code]: value })} errors={saved.fields} maxLength={SEO_LIMITS.titleMax} />
              <p className="type-caption text-ink-2">{t("seo.titleCount", { count: titleLength, ideal: SEO_LIMITS.titleIdeal })}</p>
              <L10nFields name="description" label={t("seo.searchDescription")} values={description} onChange={(code, value) => setDescription({ ...description, [code]: value })} errors={saved.fields} multiline maxLength={SEO_LIMITS.descriptionMax} />
              <p className="type-caption text-ink-2">{t("seo.descriptionCount", { count: descriptionLength, min: SEO_LIMITS.descriptionMin, ideal: SEO_LIMITS.descriptionIdeal })}</p>
              <Checkbox name="noindex" label={t("page.noindex")} hint={t("seo.noindexHint")} checked={noindex} onChange={(event) => setNoindex(event.currentTarget.checked)} />
              <TextField name="reason" label={t("common.reason")} hint={noindex ? t("seo.reasonNeeded") : t("common.optional")} error={saved.fields.reason} required={noindex} />
              <FormError message={saved.message && Object.keys(saved.fields).length === 0 ? saved.message : null} />
              <div className="cms-actions">
                <Key type="submit" variant="ink" icon="floppy-disk" loading={saved.pending}>
                  {t("seo.save")}
                </Key>
              </div>
            </save.Form>
          </Section>
          <Section id="preview" title={t("seo.preview")} aside={<Segmented aria-label={t("preview.language")} inline value={lang} onChange={(value) => setLang(value as Locale)} options={CONTENT_LANGS.map((entry) => ({ value: entry.code, label: entry.name, lang: entry.code }))} />}>
            <div className="cms-snippets" lang={lang} dir={lang === "en" ? "ltr" : "rtl"}>
              <Snippet width="phone" url={url} title={shownTitle} description={shownDescription} />
              <Snippet width="desktop" url={url} title={shownTitle} description={shownDescription} />
            </div>
            {noindex ? (
              <Note tone="warn">
                <p>{t("seo.noindexPreview")}</p>
              </Note>
            ) : null}
          </Section>
        </div>
        <aside className="grid min-w-0 gap-3">
          <div className="adm-card gap-1.5">
            <Pair label={t("seo.type")}>{t(`seo.types.${editor.type}`)}</Pair>
            <Pair label={t("page.path")}>
              <Code>{editor.path}</Code>
            </Pair>
            <Pair label={t("common.state")}>{editor.status}</Pair>
          </div>
          <Note>
            <p>{editor.type === "product" ? t("seo.productNote") : t("seo.categoryNote")}</p>
          </Note>
        </aside>
      </div>
    </>
  );
}
