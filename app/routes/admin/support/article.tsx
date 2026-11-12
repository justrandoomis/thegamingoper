import { useState } from "react";
import { data, Link, redirect } from "react-router";

import type { Route } from "./+types/article";
import { useLocale } from "~/i18n/react";
import { pick, type L10n } from "~/lib/locales";
import { can } from "~/server/actor";
import { forbidden, invalid, throwAsResponse } from "~/server/errors";
import { textToArticleBlocks } from "~/server/services/admin/support/article-text";
import { archiveArticle, decideArticle, decideRevision, getArticleEditor, knowledgeOptions, restoreArticle, saveArticle, submitArticle, type ArticleEditor, type ArticleForm } from "~/server/services/admin/support/knowledge.server";
import { ARTICLE_AUDIENCES, ARTICLE_KINDS } from "~/server/services/admin/support/types";
import type { LocalizedBlocks } from "~/server/db/schema";
import { Blocks } from "~/ui/Blocks";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Tabs } from "~/ui/Tabs";
import { supportMeta } from "./meta";
import { failure, openSupport, text, whole } from "./support.server";
import { ArticleStatusBadge, Boundary, DemoTag, Failure, listOf, Section, useIntent, useSupportT, When } from "./ui";

/**
 * /admin/support/knowledge/:id (or /new) — one knowledge article (14.06): its preview as the help centre renders it
 * (<Blocks>, the same component), the editor (lines in each language → safe blocks; photos are catalogue keys), and
 * the review workflow — draft → review → approved by someone who did not edit this version; an approved article's
 * edit waits as a revision until a second person approves it, while the help centre keeps the approved text;
 * archive / restore. Agents read approved articles here; writing needs support.knowledge.manage, deciding
 * support.knowledge.approve.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const isNew = params.id === "new";
  const { db, actor, locale } = await openSupport(context, isNew ? "support.knowledge.manage" : ["support.ticket.read", "support.knowledge.manage", "support.knowledge.approve"]);
  try {
    const editor = isNew ? null : await getArticleEditor(db, actor, params.id);
    const options = isNew || editor?.can.edit ? await knowledgeOptions(db, locale) : null;
    return { editor, options };
  } catch (error) {
    throwAsResponse(error);
  }
}

/** A whole number from a hidden field the page wrote (a version stamp); undefined when absent or not a number. */
function stamp(form: FormData, name: string): number | undefined {
  const value = Number(text(form, name));
  return text(form, name) && Number.isSafeInteger(value) ? value : undefined;
}

function formInput(form: FormData) {
  const expected = Number(text(form, "expectedUpdatedAt"));
  return {
    articleId: text(form, "articleId") || undefined,
    slug: text(form, "slug"),
    kind: text(form, "kind") as never,
    audience: text(form, "audience") as never,
    titleAr: text(form, "titleAr"),
    titleEn: text(form, "titleEn"),
    titleCkb: text(form, "titleCkb"),
    summaryAr: text(form, "summaryAr"),
    summaryEn: text(form, "summaryEn"),
    summaryCkb: text(form, "summaryCkb"),
    bodyAr: String(form.get("bodyAr") ?? ""),
    bodyEn: String(form.get("bodyEn") ?? ""),
    bodyCkb: String(form.get("bodyCkb") ?? ""),
    deviceModelId: text(form, "deviceModelId"),
    platformId: text(form, "platformId"),
    tags: text(form, "tags"),
    sort: whole(form, "sort") ?? 0,
    expectedUpdatedAt: text(form, "expectedUpdatedAt") && Number.isFinite(expected) ? expected : undefined,
    revisionSavedAt: stamp(form, "revisionSavedAt"),
    reason: text(form, "reason") || undefined,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now, storeMode } = await openSupport(context, ["support.knowledge.manage", "support.knowledge.approve"]);
  const form = await request.formData();
  const intent = text(form, "intent");
  const articleId = params.id === "new" ? "" : params.id;
  const expected = Number(text(form, "expectedUpdatedAt"));
  try {
    const manage = () => {
      if (!can(actor, "support.knowledge.manage")) throw forbidden("support.knowledge.manage");
    };
    const approve = () => {
      if (!can(actor, "support.knowledge.approve")) throw forbidden("support.knowledge.approve");
    };
    switch (intent) {
      case "save": {
        manage();
        const result = await saveArticle(db, actor, { ...formInput(form), articleId: articleId || undefined }, now, storeMode);
        if (result.created) throw redirect(`/admin/support/knowledge/${encodeURIComponent(result.articleId)}`);
        return { ok: true as const, intent, revision: result.revision };
      }
      case "submit":
        manage();
        await submitArticle(db, actor, { articleId, expectedUpdatedAt: expected }, now);
        return { ok: true as const, intent };
      case "approve":
      case "reject":
        approve();
        await decideArticle(db, actor, { articleId, decision: intent, note: text(form, "note"), expectedUpdatedAt: expected }, now);
        return { ok: true as const, intent };
      case "revision_approve":
      case "revision_reject":
        approve();
        await decideRevision(db, actor, { articleId, revisionId: text(form, "revisionId"), savedAt: stamp(form, "savedAt"), decision: intent === "revision_approve" ? "approve" : "reject", note: text(form, "note") }, now);
        return { ok: true as const, intent };
      case "revision_withdraw":
        manage();
        await decideRevision(db, actor, { articleId, revisionId: text(form, "revisionId"), decision: "withdraw", note: text(form, "note") }, now);
        return { ok: true as const, intent };
      case "archive":
        manage();
        await archiveArticle(db, actor, { articleId, expectedUpdatedAt: expected, reason: text(form, "reason") }, now);
        return { ok: true as const, intent };
      case "restore":
        manage();
        await restoreArticle(db, actor, { articleId, expectedUpdatedAt: expected }, now);
        return { ok: true as const, intent };
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, args.loaderData?.editor ? null : "knowledge.new", undefined, args.loaderData?.editor ? pick(args.loaderData.editor.title, "ar") : null);

type Options = NonNullable<Route.ComponentProps["loaderData"]["options"]>;

const EMPTY_FORM: ArticleForm = { slug: "", kind: "guide", audience: "public", titleAr: "", titleEn: "", titleCkb: "", summaryAr: "", summaryEn: "", summaryCkb: "", bodyAr: "", bodyEn: "", bodyCkb: "", deviceModelId: "", platformId: "", tags: "", sort: 0 };

export default function ArticlePage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const locale = useLocale();
  const { editor, options } = loaderData;
  if (!editor) {
    return (
      <>
        <header className="adm-page-head">
          <p className="adm-eyebrow">
            <Link to="/admin/support/knowledge" className="adm-link">
              {t("knowledge.back")}
            </Link>
          </p>
          <h1 className="adm-title">{t("knowledge.new")}</h1>
          <p className="max-w-[72ch] type-body text-ink-2">{t("knowledge.newLead")}</p>
        </header>
        {options ? <ArticleFormView form={EMPTY_FORM} options={options} editor={null} /> : null}
      </>
    );
  }
  const title = pick(editor.title, locale) || editor.form.slug;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/support/knowledge" className="adm-link">
            {t("knowledge.back")}
          </Link>
        </p>
        <h1 className="adm-title sup-card__title">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ArticleStatusBadge status={editor.status} />
          <span className="sup-tag">{t(`audience.${editor.form.audience}`)}</span>
          <span className="sup-tag">{t(`articleKind.${editor.form.kind}`)}</span>
          <bdi dir="ltr" className="sup-tag">
            {editor.form.slug}
          </bdi>
          <DemoTag show={editor.isDemo} />
          {editor.status === "approved" && editor.form.audience === "public" ? (
            <a href={`/support/article/${editor.form.slug}`} target="_blank" rel="noreferrer" className="adm-link type-caption">
              {t("knowledge.openStorefront")}
            </a>
          ) : null}
        </div>
        <p className="type-caption text-ink-2">
          {editor.approvedAt ? t("knowledge.approvedBy", { name: editor.approvedBy ?? t("knowledge.unknown") }) : t("knowledge.neverApproved")} · {t("knowledge.updated")} <When at={editor.updatedAt} />
        </p>
      </header>

      {editor.isDemo && !editor.approvedBy ? <Boundary icon="info">{t("knowledge.demoUnreviewed")}</Boundary> : null}
      <Workflow editor={editor} />
      {editor.revision ? <RevisionPanel editor={editor} /> : null}

      <Section id="article-preview" title={t("knowledge.preview")}>
        <Preview body={editor.body} title={editor.title} summary={editor.summary} />
      </Section>

      {editor.can.edit && options ? (
        <Section id="article-edit" title={editor.status === "approved" ? t("knowledge.editApproved") : t("knowledge.edit")}>
          {editor.status === "approved" ? <Boundary icon="info">{t("knowledge.editApprovedLead")}</Boundary> : null}
          <ArticleFormView form={editor.revision?.form ?? editor.form} options={options} editor={editor} />
        </Section>
      ) : null}

      {editor.history.length ? (
        <Section id="article-history" title={t("knowledge.history")}>
          <ol className="sup-timeline">
            {editor.history.map((event) => (
              <li key={event.id}>
                <span className="type-body">{t(`knowledgeEvent.${event.action}`, { who: event.actor ?? t("actor.system") })}</span>
                <span className="type-caption text-ink-2">
                  <When at={event.at} />
                </span>
                {event.reason ? <span className="sup-reason">{event.reason}</span> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </>
  );
}

function Preview({ body, title, summary }: { body: LocalizedBlocks; title: L10n; summary: L10n | null }) {
  const t = useSupportT();
  const [tab, setTab] = useState("ar");
  const locales = (["ar", "en", "ckb"] as const).filter((locale) => locale === "ar" || (body[locale]?.length ?? 0) > 0);
  return (
    <Tabs
      aria-label={t("knowledge.preview")}
      value={tab}
      onChange={setTab}
      items={locales.map((locale) => ({
        value: locale,
        label: t(`language.${locale}`),
        content: (
          <div className="sup-article pt-3" lang={locale} dir={locale === "en" ? "ltr" : "rtl"}>
            <h2 className="adm-h2">{title[locale] ?? title.ar}</h2>
            {summary?.[locale] ? <p className="type-body text-ink-2">{summary[locale]}</p> : null}
            <Blocks blocks={body[locale] ?? []} headingLevel={3} />
          </div>
        ),
      }))}
    />
  );
}

function Workflow({ editor }: { editor: ArticleEditor }) {
  const t = useSupportT();
  const [dialog, setDialog] = useState<"approve" | "reject" | "archive" | null>(null);
  const submit = useIntent("submit", "done.articleSubmitted");
  const decide = useIntent(dialog === "reject" ? "reject" : "approve", dialog === "reject" ? "done.articleRejected" : "done.articleApproved", () => setDialog(null));
  const archive = useIntent("archive", "done.articleArchived", () => setDialog(null));
  const restore = useIntent("restore", "done.articleRestored");
  const any = editor.can.submit || editor.can.approve || editor.can.archive || editor.can.restore || editor.approveBlocked;
  if (!any) return null;
  return (
    <section className="sup-panel" aria-labelledby="article-workflow">
      <h2 id="article-workflow" className="adm-h3">
        {t("knowledge.workflow")}
      </h2>
      <p className="type-caption text-ink-2">{t(`knowledge.state.${editor.status}`)}</p>
      {editor.approveBlocked ? <p className="type-caption text-red-ink">{t("knowledge.editorCannotApprove")}</p> : null}
      {editor.editors.length && editor.status === "review" ? <p className="type-caption text-ink-2">{t("knowledge.editors", { names: listOf(editor.editors.map((person) => person.name), t("listSep")) })}</p> : null}
      <div className="sup-actions">
        {editor.can.submit ? (
          <submit.fetcher.Form method="post">
            <input type="hidden" name="intent" value="submit" />
            <input type="hidden" name="expectedUpdatedAt" value={editor.updatedAt} />
            <Key type="submit" variant="ink" icon="paper-plane-tilt" loading={submit.pending}>
              {t("knowledge.submit")}
            </Key>
          </submit.fetcher.Form>
        ) : null}
        {editor.can.approve ? (
          <>
            <Key variant="ink" icon="seal-check" onClick={() => setDialog("approve")}>
              {t("knowledge.approve")}
            </Key>
            <Key icon="x" onClick={() => setDialog("reject")}>
              {t("knowledge.reject")}
            </Key>
          </>
        ) : null}
        {editor.can.restore ? (
          <restore.fetcher.Form method="post">
            <input type="hidden" name="intent" value="restore" />
            <input type="hidden" name="expectedUpdatedAt" value={editor.updatedAt} />
            <Key type="submit" icon="arrow-counter-clockwise" loading={restore.pending}>
              {t("knowledge.restore")}
            </Key>
          </restore.fetcher.Form>
        ) : null}
        {editor.can.archive ? (
          <Key icon="trash" onClick={() => setDialog("archive")}>
            {t("knowledge.archive")}
          </Key>
        ) : null}
      </div>
      <Failure message={submit.message ?? restore.message} />
      {dialog === "approve" || dialog === "reject" ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog === "reject" ? "destructive" : "neutral"}
          title={t(dialog === "approve" ? "knowledge.approveQ" : "knowledge.rejectQ")}
          consequence={t(dialog === "approve" ? (editor.form.audience === "public" ? "knowledge.approveWhatPublic" : "knowledge.approveWhatInternal") : "knowledge.rejectWhat")}
          confirmLabel={t(dialog === "approve" ? "knowledge.approve" : "knowledge.reject")}
          reason={dialog === "reject" ? { label: t("dialog.reason"), hint: t("knowledge.rejectHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={decide.pending}
          error={decide.message}
          onConfirm={({ reason }) => decide.fetcher.submit({ intent: dialog, note: reason, expectedUpdatedAt: String(editor.updatedAt) }, { method: "post" })}
        />
      ) : null}
      {dialog === "archive" ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone="destructive"
          title={t("knowledge.archiveQ")}
          consequence={t("knowledge.archiveWhat")}
          confirmLabel={t("knowledge.archive")}
          reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
          pending={archive.pending}
          error={archive.message}
          onConfirm={({ reason }) => archive.fetcher.submit({ intent: "archive", reason, expectedUpdatedAt: String(editor.updatedAt) }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

function RevisionPanel({ editor }: { editor: ArticleEditor }) {
  const t = useSupportT();
  const locale = useLocale();
  const revision = editor.revision;
  const [dialog, setDialog] = useState<"revision_approve" | "revision_reject" | "revision_withdraw" | null>(null);
  const decide = useIntent(dialog ?? "revision_approve", dialog === "revision_reject" ? "done.revisionRejected" : dialog === "revision_withdraw" ? "done.revisionWithdrawn" : "done.revisionApproved", () => setDialog(null));
  if (!revision) return null;
  return (
    <section className="adm-card adm-card--act" aria-labelledby="article-revision">
      <h2 id="article-revision" className="adm-h3">
        {t("knowledge.revisionTitle")}
      </h2>
      <p className="type-body">
        {t("knowledge.revisionBy", { name: revision.by ?? t("knowledge.unknown") })} · <When at={revision.at} />
      </p>
      <p className="type-caption text-ink-2">{t("knowledge.revisionLead")}</p>
      <Disclosure summary={t("knowledge.revisionPreview")} variant="row">
        <div className="sup-article pt-2">
          <h3 className="adm-h3">{pick(revision.title, locale)}</h3>
          <Blocks blocks={revision.body[locale === "en" ? "en" : "ar"] ?? revision.body.ar} headingLevel={4} />
        </div>
      </Disclosure>
      {editor.approveBlocked === "editor" && !editor.can.decideRevision ? <p className="type-caption text-red-ink">{t("knowledge.editorCannotApprove")}</p> : null}
      <div className="sup-actions">
        {editor.can.decideRevision ? (
          <>
            <Key variant="ink" icon="seal-check" onClick={() => setDialog("revision_approve")}>
              {t("knowledge.revisionApprove")}
            </Key>
            <Key icon="x" onClick={() => setDialog("revision_reject")}>
              {t("knowledge.revisionReject")}
            </Key>
          </>
        ) : null}
        {editor.can.withdrawRevision ? (
          <Key icon="arrow-counter-clockwise" onClick={() => setDialog("revision_withdraw")}>
            {t("knowledge.revisionWithdraw")}
          </Key>
        ) : null}
      </div>
      {dialog ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog === "revision_approve" ? "neutral" : "destructive"}
          title={t(`knowledge.${dialog}Q`)}
          consequence={t(`knowledge.${dialog}What`)}
          confirmLabel={t(dialog === "revision_approve" ? "knowledge.revisionApprove" : dialog === "revision_reject" ? "knowledge.revisionReject" : "knowledge.revisionWithdraw")}
          reason={dialog === "revision_reject" ? { label: t("dialog.reason"), hint: t("knowledge.rejectHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={decide.pending}
          error={decide.message}
          onConfirm={({ reason }) => decide.fetcher.submit({ intent: dialog, revisionId: revision.id, savedAt: String(revision.savedAt), note: reason }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

function ArticleFormView({ form, options, editor }: { form: ArticleForm; options: Options; editor: ArticleEditor | null }) {
  const t = useSupportT();
  const save = useIntent("save", (result) => (result.revision ? "done.revisionSaved" : "done.articleSaved"));
  const fields = save.fields;
  const [tab, setTab] = useState("ar");
  const [bodies, setBodies] = useState({ ar: form.bodyAr, en: form.bodyEn, ckb: form.bodyCkb });
  const fieldFor = (locale: "ar" | "en" | "ckb", base: "title" | "summary" | "body") => `${base}${locale === "ar" ? "Ar" : locale === "en" ? "En" : "Ckb"}`;
  return (
    <save.fetcher.Form method="post" className="grid gap-4" key={editor ? `${editor.id}-${editor.updatedAt}-${editor.revision?.id ?? ""}-${editor.revision?.savedAt ?? ""}` : "new"}>
      <input type="hidden" name="intent" value="save" />
      {editor ? <input type="hidden" name="articleId" value={editor.id} /> : null}
      {editor ? <input type="hidden" name="expectedUpdatedAt" value={editor.updatedAt} /> : null}
      {editor?.revision ? <input type="hidden" name="revisionSavedAt" value={editor.revision.savedAt} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <TextField name="slug" label={t("knowledge.form.slug")} hint={editor?.slugLocked ? t("knowledge.form.slugLocked") : t("knowledge.form.slugHint")} defaultValue={form.slug} ltr required readOnly={editor?.slugLocked} error={fields.slug} />
        <TextField name="sort" label={t("knowledge.form.sort")} hint={t("knowledge.form.sortHint")} inputMode="numeric" defaultValue={String(form.sort)} ltr error={fields.sort} />
        <Select name="kind" label={t("knowledge.form.kind")} defaultValue={form.kind} options={ARTICLE_KINDS.map((kind) => ({ value: kind, label: t(`articleKind.${kind}`) }))} error={fields.kind} />
        <Select name="audience" label={t("knowledge.form.audience")} hint={t("knowledge.form.audienceHint")} defaultValue={form.audience} options={ARTICLE_AUDIENCES.map((audience) => ({ value: audience, label: t(`audience.${audience}`) }))} error={fields.audience} />
        <Select name="deviceModelId" label={t("knowledge.form.device")} hint={t("knowledge.form.deviceHint")} defaultValue={form.deviceModelId} options={[{ value: "", label: t("knowledge.form.noDevice") }, ...options.devices.map((device) => ({ value: device.id, label: device.name }))]} error={fields.deviceModelId} />
        <Select name="platformId" label={t("knowledge.form.platform")} defaultValue={form.platformId} options={[{ value: "", label: t("knowledge.form.noPlatform") }, ...options.platforms.map((platform) => ({ value: platform.id, label: platform.name }))]} error={fields.platformId} />
        <TextField name="tags" label={t("knowledge.form.tags")} hint={t("knowledge.form.tagsHint")} defaultValue={form.tags} optional className="md:col-span-2" error={fields.tags} />
      </div>
      <Tabs
        aria-label={t("knowledge.form.languages")}
        value={tab}
        onChange={setTab}
        keepMounted
        items={(["ar", "en", "ckb"] as const).map((locale) => ({
          value: locale,
          label: t(`language.${locale}`),
          content: (
            <div className="grid gap-3 pt-3" dir={locale === "en" ? "ltr" : "rtl"} lang={locale}>
              <TextField name={fieldFor(locale, "title")} label={t("knowledge.form.title")} defaultValue={form[fieldFor(locale, "title") as keyof ArticleForm] as string} required={locale === "ar"} optional={locale !== "ar"} error={fields[fieldFor(locale, "title")]} />
              <TextField name={fieldFor(locale, "summary")} label={t("knowledge.form.summary")} defaultValue={form[fieldFor(locale, "summary") as keyof ArticleForm] as string} optional error={fields[fieldFor(locale, "summary")]} />
              <TextArea
                name={fieldFor(locale, "body")}
                label={t("knowledge.form.body")}
                hint={t("knowledge.form.bodyHint")}
                value={bodies[locale]}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setBodies((current) => ({ ...current, [locale]: value }));
                }}
                rows={12}
                required={locale === "ar"}
                optional={locale !== "ar"}
                error={fields[fieldFor(locale, "body")]}
              />
              <Disclosure summary={t("knowledge.form.livePreview")} variant="row">
                <div className="sup-article pt-2">
                  <Blocks blocks={textToArticleBlocks(bodies[locale])} headingLevel={4} />
                </div>
              </Disclosure>
            </div>
          ),
        }))}
      />
      <Disclosure summary={t("knowledge.form.syntax")} variant="row">
        <ul className="grid gap-1 pt-2 type-caption">
          {["h2", "ul", "ol", "steps", "callout", "table", "photo"].map((line) => (
            <li key={line}>
              <bdi dir="ltr" className="nums">
                {t(`knowledge.syntax.${line}.code`)}
              </bdi>{" "}
              — {t(`knowledge.syntax.${line}.what`)}
            </li>
          ))}
        </ul>
      </Disclosure>
      <TextField name="reason" label={t("knowledge.form.reason")} hint={t("knowledge.form.reasonHint")} optional error={fields.reason} />
      <Failure message={save.message} />
      <div className="sup-actions">
        <Key type="submit" variant="ink" icon="floppy-disk" loading={save.pending}>
          {editor?.status === "approved" ? t("knowledge.form.saveRevision") : editor ? t("knowledge.form.save") : t("knowledge.form.create")}
        </Key>
      </div>
    </save.fetcher.Form>
  );
}
