import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/page";
import { adminSecrets } from "~/routes/admin/shell/env.server";
import { archivePage, discardPageDraft, getPageEditor, publishPage, savePageDraft, schedulePage, startPageDraft } from "~/server/services/admin/cms/pages.server";
import { previewLink } from "~/server/services/admin/cms/preview.server";
import { PAGE_TEXT } from "~/server/services/admin/cms/rules";
import { textToBlocks } from "~/server/services/admin/settings/policy-text";
import { invalid } from "~/server/errors";
import type { L10n, Locale } from "~/lib/locales";
import { Checkbox, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Segmented } from "~/ui/Segmented";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { checked, failed, l10n, ok, openCms, orRespond, raw, text } from "./cms.server";
import { PagePreview } from "./preview-parts";
import { ActionDialog, CONTENT_LANGS, Code, DemoTag, FormError, L10nFields, Note, PageHead, Pair, PreviewFrames, Section, StateBadge, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/pages/:slug — 17.01 / 17.04 / 17.06 and the owner's approval of the policies: start a draft (a policy
 * from the code's current draft, with today's settings filled in), edit the title, the text as lines (headings, lists,
 * steps, notes, tables — never HTML) and the search-engine words in ar/en/ckb, preview it at phone and desktop width,
 * then approve it — which publishes it on the store — or schedule it (a page not live yet), or withdraw it.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now, ctx } = await openCms(context, ["cms.page.manage", "cms.page.publish"]);
  return { editor: await orRespond(() => getPageEditor(db, actor, params.slug, locale, now, ctx.storeMode)) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openCms(context, ["cms.page.manage", "cms.page.publish"]);
  const form = await request.formData();
  const intent = text(form, "intent");
  const slug = params.slug;
  const version = text(form, "version");
  try {
    switch (intent) {
      case "start":
        return ok(intent, await startPageDraft(req.db, req.actor, { slug, version, reason: text(form, "reason"), from: text(form, "from") || undefined }, req.now, req.ctx.storeMode));
      case "save":
        return ok(
          intent,
          await savePageDraft(
            req.db,
            req.actor,
            { slug, version, title: l10n(form, "title"), description: l10n(form, "description"), noindex: checked(form, "noindex"), textAr: raw(form, "textAr"), textEn: raw(form, "textEn"), textCkb: raw(form, "textCkb") },
            req.now,
          ),
        );
      case "discard":
        return ok(intent, await discardPageDraft(req.db, req.actor, { slug, version, reason: text(form, "reason") }, req.now));
      case "publish":
        return ok(intent, await publishPage(req.db, req.actor, { slug, version, reason: text(form, "reason"), endsAt: text(form, "endsAt") }, req.now));
      case "schedule":
        return ok(intent, await schedulePage(req.db, req.actor, { slug, version, reason: text(form, "reason"), startsAt: text(form, "startsAt"), endsAt: text(form, "endsAt") }, req.now));
      case "archive":
        return ok(intent, await archivePage(req.db, req.actor, { slug, version, reason: text(form, "reason") }, req.now));
      case "link":
        return ok(intent, await previewLink(req.db, req.actor, { kind: "page", id: slug }, adminSecrets().SESSION_SECRET, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, null, undefined, args.loaderData ? args.loaderData.editor.title.ar : null);

type Dialog = "start" | "startApproved" | "publish" | "schedule" | "archive" | "discard" | null;

export default function PageEditorPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { editor } = loaderData;
  const version = editor.version === null ? "" : String(editor.version);
  const [title, setTitle] = useState<Partial<Record<Locale, string>>>(editor.title);
  const [texts, setTexts] = useState(editor.text);
  const [description, setDescription] = useState<Partial<Record<Locale, string>>>(editor.description ?? {});
  const [noindex, setNoindex] = useState(editor.noindex);
  const [lang, setLang] = useState<Locale>("ar");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  // a new version came from the server (started, saved, approved): the form follows it
  const [seen, setSeen] = useState(editor.version);
  if (seen !== editor.version) {
    setSeen(editor.version);
    setTitle(editor.title);
    setTexts(editor.text);
    setDescription(editor.description ?? {});
    setNoindex(editor.noindex);
  }
  const save = useFetcher<Record<string, unknown>>();
  const link = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", t("page.saved"));
  const made = useResult(link, "link", t("preview.linkMade"));
  const madePath = link.data && (link.data as { path?: string }).path ? String((link.data as { path: string }).path) : null;
  const editable = editor.can.edit && editor.row?.hasDraft === true;
  const dirty = JSON.stringify(texts) !== JSON.stringify(editor.text) || JSON.stringify(title) !== JSON.stringify(editor.title) || JSON.stringify(description) !== JSON.stringify(editor.description ?? {}) || noindex !== editor.noindex;
  const blocks = { ar: textToBlocks(texts.ar), en: textToBlocks(texts.en), ckb: textToBlocks(texts.ckb) };
  const previewTitle = { ar: title.ar || "—", ...(title.en ? { en: title.en } : {}), ...(title.ckb ? { ckb: title.ckb } : {}) } as L10n;
  const live = editor.row?.state === "live";

  if (editor.inSettings) {
    return (
      <>
        <PageHead title={editor.live.title || editor.slug} lead={t("page.inSettingsLead")} />
        <Note>
          <p>{t("page.inSettings")}</p>
          <Link to={`/admin/settings/policies/${editor.slug}`} className="adm-link type-label">
            {t("pages.inSettings")}
          </Link>
        </Note>
      </>
    );
  }

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/cms/pages" className="adm-link">
            {t("pages.title")}
          </Link>
        }
        title={editor.title.ar || editor.slug}
        lead={editor.kind === "policy" ? t("page.policyLead") : t("page.lead")}
        actions={
          // landing pages have no storefront route yet (/pages/… answers 404 until the storefront adds it: the aside says so)
          editor.kind !== "landing" ? (
            <Key as="a" href={editor.storePath} size="sm" iconEnd="arrow-square-out" target="_blank" rel="noopener">
              {t("page.onStore")}
            </Key>
          ) : undefined
        }
      />

      <div className="cms-split">
        <div className="grid min-w-0 gap-5">
          {!editor.row?.hasDraft ? (
            <Note icon="file-text">
              <p>{editor.kind === "policy" ? (editor.fromApproved ? t("page.noDraftPolicy") : t("page.noRowPolicy")) : t("page.noDraft")}</p>
              {editor.can.edit ? (
                <div className="flex flex-wrap gap-2">
                  {/* an approved policy is revised from its approved text; the code's draft stays the other start */}
                  {editor.kind === "policy" && editor.fromApproved ? (
                    <Key size="sm" icon="copy" onClick={() => setDialog("startApproved")}>
                      {t("page.startFromApproved")}
                    </Key>
                  ) : null}
                  <Key size="sm" icon="copy" onClick={() => setDialog("start")}>
                    {editor.kind === "policy" ? t("page.startFromCode") : t("page.start")}
                  </Key>
                </div>
              ) : null}
            </Note>
          ) : null}

          {editor.row?.hasDraft || editor.source === "published" ? (
            <Section id="edit" title={t("page.edit")}>
              <save.Form method="post" className="cms-editor grid gap-4">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="version" value={version} />
                <L10nFields name="title" label={t("page.pageTitle")} values={title} onChange={(code, value) => setTitle({ ...title, [code]: value })} errors={saved.fields} required maxLength={PAGE_TEXT.title} readOnly={!editable} />
                <TextArea name="textAr" rows={14} label={t("page.textAr")} value={texts.ar} onChange={(event) => setTexts({ ...texts, ar: event.currentTarget.value })} readOnly={!editable} error={saved.fields.textAr} required lang="ar" dir="rtl" />
                <TextArea name="textEn" rows={10} label={t("page.textEn")} value={texts.en} onChange={(event) => setTexts({ ...texts, en: event.currentTarget.value })} readOnly={!editable} optional lang="en" dir="ltr" />
                <TextArea name="textCkb" rows={10} label={t("page.textCkb")} value={texts.ckb} onChange={(event) => setTexts({ ...texts, ckb: event.currentTarget.value })} readOnly={!editable} optional lang="ckb" dir="rtl" hint={t("common.sorani")} />
                <p className="type-caption text-ink-2">{t("page.syntax")}</p>
                <L10nFields name="description" label={t("page.description")} values={description} onChange={(code, value) => setDescription({ ...description, [code]: value })} errors={saved.fields} multiline maxLength={PAGE_TEXT.description} readOnly={!editable} />
                <Checkbox name="noindex" label={t("page.noindex")} hint={t("page.noindexHint")} checked={noindex} onChange={(event) => setNoindex(event.currentTarget.checked)} disabled={!editable} />
                <FormError message={saved.message} />
                {editable ? (
                  <div className="cms-actions">
                    <Key type="submit" variant="ink" icon="floppy-disk" disabled={!dirty} loading={saved.pending}>
                      {t("page.saveDraft")}
                    </Key>
                    <Key size="sm" variant="ghost" onClick={() => setDialog("discard")}>
                      {t("page.discard")}
                    </Key>
                    {editor.kind === "policy" ? (
                      <Key size="sm" icon="copy" onClick={() => setDialog("start")}>
                        {t("page.restartFromCode")}
                      </Key>
                    ) : null}
                  </div>
                ) : editor.can.edit ? (
                  <p className="type-caption text-ink-2">{t("page.startToEdit")}</p>
                ) : null}
              </save.Form>
            </Section>
          ) : null}

        </div>

        <aside className="grid min-w-0 gap-3">
          <div className="adm-card gap-1.5">
            <Pair label={t("page.onStoreNow")}>
              {editor.kind === "policy" ? <Status tone={editor.live.approved ? "ok" : "warn"}>{editor.live.approved ? t("pages.approved") : t("pages.codeDraft")}</Status> : editor.row ? <StateBadge state={editor.row.state} /> : "—"}
            </Pair>
            <Pair label={t("page.path")}>
              <Code>{editor.storePath}</Code>
            </Pair>
            <Pair label={t("page.published")}>{editor.row?.publishedAt ? <When at={editor.row.publishedAt} /> : "—"}</Pair>
            <Pair label={t("common.updated")}>{editor.row ? <When at={editor.row.updatedAt} /> : "—"}</Pair>
            {editor.row?.endsAt ? (
              <Pair label={t("common.endsAt")}>
                <When at={editor.row.endsAt} />
              </Pair>
            ) : null}
            {editor.row?.isDemo ? <DemoTag show /> : null}
          </div>
          {editor.can.publish ? (
            <div className="adm-card gap-2">
              <Key variant="ink" icon="seal-check" disabled={!editor.row?.hasDraft || dirty} onClick={() => setDialog("publish")}>
                {editor.kind === "policy" ? t("page.approve") : t("page.publish")}
              </Key>
              {dirty ? <p className="type-caption text-ink-2">{t("page.saveFirst")}</p> : null}
              {editor.row?.hasDraft && !live ? (
                <Key size="sm" icon="calendar" disabled={dirty} onClick={() => setDialog("schedule")}>
                  {t("page.schedule")}
                </Key>
              ) : null}
              {editor.row?.status === "published" || editor.row?.status === "scheduled" ? (
                <Key size="sm" variant="ghost" onClick={() => setDialog("archive")}>
                  {editor.kind === "policy" ? t("page.withdraw") : t("page.archive")}
                </Key>
              ) : null}
            </div>
          ) : (
            <p className="type-caption text-ink-2">{t("page.approveNeeds")}</p>
          )}
          {editor.row ? (
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
          {editor.kind === "landing" ? (
            <Note>
              <p>{t("page.landingNote")}</p>
            </Note>
          ) : null}
        </aside>
      </div>

      <Section
        id="preview"
        className="mt-8"
        title={dirty ? t("preview.unsaved") : editor.row?.hasDraft ? t("preview.draft") : t("preview.live")}
        aside={<Segmented aria-label={t("preview.language")} inline value={lang} onChange={(value) => setLang(value as Locale)} options={CONTENT_LANGS.map((entry) => ({ value: entry.code, label: entry.name, lang: entry.code }))} />}
      >
        <PreviewFrames lang={lang}>
          {editor.row?.hasDraft || editor.source === "published" ? (
            <PagePreview title={previewTitle} blocks={blocks} lang={lang} emptyText={t("preview.emptyText")} />
          ) : (
            <PagePreview title={{ ar: editor.live.title || "—" }} blocks={{ ar: editor.live.blocks }} lang="ar" emptyText={t("preview.emptyText")} />
          )}
        </PreviewFrames>
      </Section>

      <ActionDialog
        open={dialog === "start"}
        onClose={() => setDialog(null)}
        title={editor.kind === "policy" ? t("page.startTitle") : t("page.startPlainTitle")}
        consequence={editor.row?.hasDraft ? t("page.startReplace") : editor.kind === "policy" ? t("page.startConsequence") : t("page.startPlain")}
        confirmLabel={editor.kind === "policy" ? t("page.startFromCode") : t("page.start")}
        fields={{ intent: "start", version }}
        successMessage={t("page.started")}
      />
      <ActionDialog
        open={dialog === "startApproved"}
        onClose={() => setDialog(null)}
        title={t("page.startPlainTitle")}
        consequence={t("page.startPlain")}
        confirmLabel={t("page.startFromApproved")}
        fields={{ intent: "start", version, from: "approved" }}
        successMessage={t("page.started")}
      />
      <ActionDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        title={editor.kind === "policy" ? t("page.approveTitle", { title: editor.title.ar }) : t("page.publishTitle", { title: editor.title.ar })}
        consequence={editor.kind === "policy" ? t("page.approveConsequence") : t("page.publishConsequence")}
        confirmLabel={editor.kind === "policy" ? t("page.approve") : t("page.publish")}
        impact={[
          { label: t("page.blocks"), value: String(blocks.ar.length) },
          { label: t("page.languages"), value: CONTENT_LANGS.filter((entry) => blocks[entry.code].length > 0).map((entry) => entry.name).join(" · ") || "—" },
          { label: t("page.noindexShort"), value: noindex ? t("common.yes") : t("common.no") },
        ]}
        fields={{ intent: "publish", version }}
        extra={(): Record<string, string> => (editor.kind === "landing" && endsAt ? { endsAt } : {})}
        successMessage={editor.kind === "policy" ? t("page.approvedDone") : t("page.publishedDone")}
      >
        {editor.kind === "landing" ? <TextField label={t("common.endsAt")} hint={t("common.optionalEnd")} type="datetime-local" ltr value={endsAt} onChange={(event) => setEndsAt(event.currentTarget.value)} /> : null}
      </ActionDialog>
      <ActionDialog
        open={dialog === "schedule"}
        onClose={() => setDialog(null)}
        title={t("page.scheduleTitle")}
        consequence={t("page.scheduleConsequence")}
        confirmLabel={t("page.schedule")}
        fields={{ intent: "schedule", version }}
        extra={() => ({ startsAt, endsAt })}
        successMessage={t("page.scheduledDone")}
      >
        <div className="grid gap-3">
          <TextField label={t("common.startsAt")} hint={t("common.iraqTime")} type="datetime-local" ltr value={startsAt} onChange={(event) => setStartsAt(event.currentTarget.value)} required />
          {editor.kind === "landing" ? <TextField label={t("common.endsAt")} hint={t("common.optionalEnd")} type="datetime-local" ltr value={endsAt} onChange={(event) => setEndsAt(event.currentTarget.value)} /> : null}
        </div>
      </ActionDialog>
      <ActionDialog
        open={dialog === "archive"}
        onClose={() => setDialog(null)}
        tone="destructive"
        title={editor.kind === "policy" ? t("page.withdrawTitle") : t("page.archiveTitle")}
        consequence={editor.kind === "policy" ? t("page.withdrawConsequence") : t("page.archiveConsequence")}
        confirmLabel={editor.kind === "policy" ? t("page.withdraw") : t("page.archive")}
        fields={{ intent: "archive", version }}
        successMessage={t("page.archivedDone")}
      />
      <ActionDialog open={dialog === "discard"} onClose={() => setDialog(null)} tone="destructive" title={t("page.discardTitle")} consequence={t("page.discardConsequence")} confirmLabel={t("page.discard")} fields={{ intent: "discard", version }} successMessage={t("page.discarded")} />
    </>
  );
}
