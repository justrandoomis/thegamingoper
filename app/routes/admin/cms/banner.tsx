import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/banner";
import { Art } from "~/art/Art";
import { adminSecrets } from "~/routes/admin/shell/env.server";
import { changeBannerStatus, getBannerEditor, saveBanner, searchProductPhotos } from "~/server/services/admin/cms/banners.server";
import { previewLink } from "~/server/services/admin/cms/preview.server";
import { BANNER_ACCENTS, BANNER_PLACEMENTS, BANNER_TEXT, CATEGORY_PLACEMENT_PREFIX, baghdadLocal } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import type { L10n, Locale } from "~/lib/locales";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Segmented } from "~/ui/Segmented";
import { cmsMeta } from "./meta";
import { failed, l10n, ok, openCms, orRespond, text } from "./cms.server";
import { BannerPreview } from "./preview-parts";
import { ActionDialog, CONTENT_LANGS, Code, DemoTag, FormError, L10nFields, LinkState, Note, PageHead, Pair, PreviewFrames, Section, StateBadge, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/banners/:bannerId ("new") — 17.01 / 17.02 / 17.06: one banner — where it stands, its words in ar/en/ckb,
 * a catalogue photo, its link and key, its window (Iraq time) — with a live phone and desktop preview of what is
 * typed, then publish now, schedule, take off the store, archive. A live banner changes on the store as soon as it is
 * saved (banners have no separate draft): the page says so above the form.
 */
export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, "cms.banner.manage");
  const url = new URL(request.url);
  const photosQ = (url.searchParams.get("photos") ?? "").slice(0, 80);
  const [editor, photos] = await orRespond(() => Promise.all([getBannerEditor(db, actor, params.bannerId, locale, now), searchProductPhotos(db, actor, photosQ, locale)]));
  return { editor, photos, photosQ, now };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openCms(context, "cms.banner.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  const bannerId = params.bannerId === "new" ? undefined : params.bannerId;
  try {
    switch (intent) {
      case "save":
        return ok(
          intent,
          await saveBanner(
            req.db,
            req.actor,
            {
              bannerId,
              version: text(form, "version") || undefined,
              placement: text(form, "placement"),
              title: l10n(form, "title"),
              subtitle: l10n(form, "subtitle"),
              ctaLabel: l10n(form, "ctaLabel"),
              link: text(form, "link"),
              artKey: text(form, "artKey"),
              accent: text(form, "accent") || undefined,
              sort: text(form, "sort") || undefined,
              startsAt: text(form, "startsAt"),
              endsAt: text(form, "endsAt"),
            },
            req.now,
            // a full address of this very host is a store path, like tamtamgames.com's
            { origins: [req.ctx.origin] },
          ),
        );
      case "publish":
      case "schedule":
      case "unpublish":
      case "archive":
      case "restore":
        if (!bannerId) throw invalid({ intent: "invalid" });
        return ok(intent, await changeBannerStatus(req.db, req.actor, { bannerId, version: text(form, "version"), action: intent, startsAt: text(form, "startsAt"), endsAt: text(form, "endsAt"), reason: text(form, "reason") }, req.now));
      case "link":
        if (!bannerId) throw invalid({ intent: "invalid" });
        return ok(intent, await previewLink(req.db, req.actor, { kind: "banner", id: bannerId }, adminSecrets().SESSION_SECRET, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, args.params.bannerId === "new" ? "banner.newTitle" : "banner.title");

type Dialog = "publish" | "schedule" | "unpublish" | "archive" | "restore" | null;
type Words = Partial<Record<Locale, string>>;

const toL10n = (words: Words): L10n | null => (words.ar ? ({ ar: words.ar, ...(words.en ? { en: words.en } : {}), ...(words.ckb ? { ckb: words.ckb } : {}) } as L10n) : null);

export default function BannerPage({ loaderData, params }: Route.ComponentProps) {
  const t = useCmsT();
  const { editor, photos, photosQ } = loaderData;
  const banner = editor.banner;
  const [search] = useSearchParams();
  const [title, setTitle] = useState<Words>(banner?.title ?? {});
  const [subtitle, setSubtitle] = useState<Words>(banner?.subtitle ?? {});
  const [cta, setCta] = useState<Words>(banner?.ctaLabel ?? {});
  const [artKey, setArtKey] = useState(search.get("art") ?? banner?.artKey ?? "");
  const [accent, setAccent] = useState(banner?.accent ?? "brand");
  const [lang, setLang] = useState<Locale>("ar");
  const [dialog, setDialog] = useState<Dialog>(null);
  const save = useFetcher<Record<string, unknown>>();
  const link = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", t("banner.saved"));
  const made = useResult(link, "link", t("preview.linkMade"));
  const isNew = params.bannerId === "new";
  const version = banner ? String(banner.version) : "";
  const running = banner?.status === "published" || banner?.status === "scheduled";
  const navigate = useNavigate();
  const createdId = save.data && (save.data as { created?: boolean }).created ? String((save.data as { bannerId: string }).bannerId) : null;
  useEffect(() => {
    if (createdId && save.state === "idle") navigate(`/admin/cms/banners/${createdId}`, { replace: true });
  }, [createdId, save.state, navigate]);
  // a new version came from the server: the form follows it
  const [seen, setSeen] = useState(banner?.version ?? null);
  if (seen !== (banner?.version ?? null)) {
    setSeen(banner?.version ?? null);
    setTitle(banner?.title ?? {});
    setSubtitle(banner?.subtitle ?? {});
    setCta(banner?.ctaLabel ?? {});
    setArtKey(banner?.artKey ?? "");
    setAccent(banner?.accent ?? "brand");
  }
  const madePath = link.data && (link.data as { path?: string }).path ? String((link.data as { path: string }).path) : null;
  const windowFields = { startsAt: baghdadLocal(banner?.startsAt ?? null), endsAt: baghdadLocal(banner?.endsAt ?? null) };
  const placements = [...BANNER_PLACEMENTS.map((value) => ({ value, label: t(`placement.${value}`) })), ...editor.categories.map((category) => ({ value: `${CATEGORY_PLACEMENT_PREFIX}${category.id}`, label: t("placement.category", { name: category.name }) }))];

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/cms/banners" className="adm-link">
            {t("banners.title")}
          </Link>
        }
        title={isNew ? t("banner.newTitle") : t("banner.title")}
        lead={t("banner.lead")}
        actions={
          banner ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StateBadge state={banner.state} />
              <DemoTag show={banner.isDemo} />
            </span>
          ) : null
        }
      />

      {running ? (
        <Note tone="warn" icon="warning-circle" className="mb-5">
          <p>{t("banner.liveNote")}</p>
        </Note>
      ) : null}

      <div className="cms-split">
        <div className="grid min-w-0 gap-5">
          <Section id="form" title={t("banner.content")}>
            <save.Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="version" value={version} />
              <Select name="placement" label={t("banners.placement")} defaultValue={banner?.placement ?? "home_strip"} options={placements} error={saved.fields.placement} required />
              <L10nFields name="title" label={t("banner.bannerTitle")} values={title} onChange={(code, value) => setTitle({ ...title, [code]: value })} errors={saved.fields} required maxLength={BANNER_TEXT.title} />
              <L10nFields name="subtitle" label={t("banner.subtitle")} values={subtitle} onChange={(code, value) => setSubtitle({ ...subtitle, [code]: value })} errors={saved.fields} multiline maxLength={BANNER_TEXT.subtitle} />
              <L10nFields name="ctaLabel" label={t("banner.cta")} values={cta} onChange={(code, value) => setCta({ ...cta, [code]: value })} errors={saved.fields} maxLength={BANNER_TEXT.cta} />
              <TextField name="link" label={t("banners.link")} hint={t("banner.linkHint")} defaultValue={banner?.link ?? ""} error={saved.fields.link} ltr />
              {editor.link ? (
                <p className="flex flex-wrap items-center gap-2 type-caption">
                  <span className="text-ink-2">{t("banner.linkNow")}</span>
                  <LinkState state={editor.link.state} />
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField name="artKey" label={t("banner.photo")} hint={t("banner.photoHint")} value={artKey} onChange={(event) => setArtKey(event.currentTarget.value)} error={saved.fields.artKey} ltr />
                <Select name="accent" label={t("banner.accent")} value={accent} onChange={(event) => setAccent(event.currentTarget.value)} options={BANNER_ACCENTS.map((value) => ({ value, label: t(`accent.${value}`) }))} />
                <TextField name="sort" label={t("banner.sort")} hint={t("banner.sortHint")} inputMode="numeric" defaultValue={String(banner?.sort ?? 0)} error={saved.fields.sort} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField name="startsAt" type="datetime-local" ltr label={t("common.startsAt")} hint={t("common.iraqTime")} defaultValue={windowFields.startsAt} error={saved.fields.startsAt} />
                <TextField name="endsAt" type="datetime-local" ltr label={t("common.endsAt")} hint={t("common.optionalEnd")} defaultValue={windowFields.endsAt} error={saved.fields.endsAt} />
              </div>
              <FormError message={saved.message} />
              <div className="cms-actions">
                <Key type="submit" variant="ink" icon="floppy-disk" loading={saved.pending}>
                  {running ? t("banner.saveLive") : isNew ? t("banner.create") : t("banner.save")}
                </Key>
              </div>
            </save.Form>
          </Section>

          <Section id="photos" title={t("banner.findPhoto")}>
            <Form method="get" className="cms-filters" preventScrollReset>
              <TextField name="photos" label={t("banner.photoSearch")} defaultValue={photosQ} />
              <Key type="submit" size="sm" icon="magnifying-glass">
                {t("common.find")}
              </Key>
            </Form>
            {photosQ && photos.length === 0 ? <p className="type-body text-ink-2">{t("banner.noPhotos")}</p> : null}
            <ul role="list" className="grid gap-3">
              {photos.map((choice) => (
                <li key={choice.productId} className="adm-card gap-2">
                  <span className="type-strong">{choice.name}</span>
                  <div className="flex flex-wrap gap-2">
                    {choice.keys.map((key) => (
                      <button key={key} type="button" className="cms-tag hit-44" onClick={() => setArtKey(key)} aria-pressed={artKey === key}>
                        <span className="inline-block size-12 overflow-hidden rounded-xs bg-niche">
                          <Art name={key} alt="" sizes="48px" />
                        </span>
                        <Code>{key}</Code>
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

        </div>

        <aside className="grid min-w-0 gap-3">
          {banner ? (
            <div className="adm-card gap-2">
              <Pair label={t("common.state")}>
                <StateBadge state={banner.state} />
              </Pair>
              <Pair label={t("common.startsAt")}>
                <When at={banner.startsAt} />
              </Pair>
              <Pair label={t("common.endsAt")}>
                <When at={banner.endsAt} />
              </Pair>
              <div className="grid gap-2">
                {banner.status === "draft" || banner.status === "scheduled" ? (
                  <Key variant="ink" icon="seal-check" onClick={() => setDialog("publish")}>
                    {t("banner.publish")}
                  </Key>
                ) : null}
                {banner.status !== "archived" ? (
                  <Key size="sm" icon="calendar" onClick={() => setDialog("schedule")}>
                    {t("banner.schedule")}
                  </Key>
                ) : null}
                {running ? (
                  <Key size="sm" variant="ghost" onClick={() => setDialog("unpublish")}>
                    {t("banner.unpublish")}
                  </Key>
                ) : null}
                {banner.status !== "archived" ? (
                  <Key size="sm" variant="ghost" onClick={() => setDialog("archive")}>
                    {t("banner.archive")}
                  </Key>
                ) : (
                  <Key size="sm" onClick={() => setDialog("restore")}>
                    {t("banner.restore")}
                  </Key>
                )}
              </div>
              <p className="type-caption text-ink-2">{t("banner.windowFromForm")}</p>
            </div>
          ) : (
            <Note>
              <p>{t("banner.newNote")}</p>
            </Note>
          )}
          {banner ? (
            <div className="adm-card gap-2">
              <h3 className="adm-h3">{t("preview.linkTitle")}</h3>
              <p className="type-caption text-ink-2">{t("preview.linkLead")}</p>
              <link.Form method="post">
                <input type="hidden" name="intent" value="link" />
                <Key type="submit" size="sm" icon="link" loading={made.pending}>
                  {t("preview.makeLink")}
                </Key>
              </link.Form>
              <FormError message={made.message} />
              {madePath ? (
                <Link to={madePath} className="adm-link type-label">
                  {t("preview.openLink")}
                </Link>
              ) : null}
            </div>
          ) : null}
          <Note>
            <p>{t("banner.storefrontNote")}</p>
          </Note>
        </aside>
      </div>

      <Section
        id="preview"
        className="mt-8"
        title={t("preview.title")}
        aside={<Segmented aria-label={t("preview.language")} inline value={lang} onChange={(value) => setLang(value as Locale)} options={CONTENT_LANGS.map((entry) => ({ value: entry.code, label: entry.name, lang: entry.code }))} />}
      >
        <p className="type-caption text-ink-2">{t("preview.bannerNote")}</p>
        <PreviewFrames lang={lang}>
          <BannerPreview title={toL10n(title) ?? { ar: "—" }} subtitle={toL10n(subtitle)} ctaLabel={toL10n(cta)} artKey={artKey || null} accent={accent} lang={lang} />
        </PreviewFrames>
      </Section>

      <ActionDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        title={t("banner.publishTitle")}
        consequence={t("banner.publishConsequence")}
        confirmLabel={t("banner.publish")}
        impact={[
          { label: t("banners.placement"), value: placements.find((entry) => entry.value === banner?.placement)?.label ?? "—" },
          { label: t("common.endsAt"), value: windowFields.endsAt ? windowFields.endsAt.replace("T", " ") : t("common.noEnd") },
        ]}
        fields={{ intent: "publish", version, startsAt: "", endsAt: windowFields.endsAt }}
        successMessage={t("banner.publishedDone")}
      />
      <ActionDialog
        open={dialog === "schedule"}
        onClose={() => setDialog(null)}
        title={t("banner.scheduleTitle")}
        consequence={windowFields.startsAt ? t("banner.scheduleConsequence") : t("banner.scheduleNeedsStart")}
        confirmLabel={t("banner.schedule")}
        impact={[
          { label: t("common.startsAt"), value: windowFields.startsAt ? windowFields.startsAt.replace("T", " ") : "—" },
          { label: t("common.endsAt"), value: windowFields.endsAt ? windowFields.endsAt.replace("T", " ") : t("common.noEnd") },
        ]}
        fields={{ intent: "schedule", version, ...windowFields }}
        successMessage={t("banner.scheduledDone")}
      />
      <ActionDialog open={dialog === "unpublish"} onClose={() => setDialog(null)} tone="destructive" title={t("banner.unpublishTitle")} consequence={t("banner.unpublishConsequence")} confirmLabel={t("banner.unpublish")} fields={{ intent: "unpublish", version }} successMessage={t("banner.unpublishedDone")} />
      <ActionDialog open={dialog === "archive"} onClose={() => setDialog(null)} tone="destructive" title={t("banner.archiveTitle")} consequence={t("banner.archiveConsequence")} confirmLabel={t("banner.archive")} fields={{ intent: "archive", version }} successMessage={t("banner.archivedDone")} />
      <ActionDialog open={dialog === "restore"} onClose={() => setDialog(null)} title={t("banner.restoreTitle")} consequence={t("banner.restoreConsequence")} confirmLabel={t("banner.restore")} fields={{ intent: "restore", version }} successMessage={t("banner.restoredDone")} />
    </>
  );
}
