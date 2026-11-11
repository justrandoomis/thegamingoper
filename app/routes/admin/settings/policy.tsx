import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/policy";
import { archivePolicy, getPolicyEditor, publishPolicy, savePolicyDraft, startPolicyDraft } from "~/server/services/admin/settings/policies.server";
import { textToBlocks } from "~/server/services/admin/settings/policy-text";
import { invalid } from "~/server/errors";
import { Blocks } from "~/ui/Blocks";
import { TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, FormError, Note, PageHead, Pair, Section, When, failureText, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { ok, text } from "../security/route-kit.server";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/policies/:slug — 22.02 for the returns and warranty texts: start a draft from the code's current text
 * (today's settings filled in, in Arabic, English and Sorani), edit it as lines (headings, paragraphs, lists, steps,
 * notes, tables — never HTML), preview it as the storefront renders it, and approve it — which publishes it on the store
 * (cms.page.publish) — or withdraw the approved text so the code's draft (marked as awaiting the owner) returns.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { ctx, db, actor, locale, now } = await settingsKit.open(context, "settings.read");
  return { editor: await settingsKit.orRespond(() => getPolicyEditor(db, actor, params.slug, locale, now, ctx.storeMode)) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await settingsKit.open(context, "settings.read");
  const form = await request.formData();
  const intent = text(form, "intent");
  const version = text(form, "version");
  try {
    switch (intent) {
      case "start":
        return ok(intent, await startPolicyDraft(req.db, req.actor, { slug: params.slug, reason: text(form, "reason"), version }, req.now, req.ctx.storeMode));
      case "save":
        return ok(intent, await savePolicyDraft(req.db, req.actor, { slug: params.slug, version, textAr: text(form, "textAr"), textEn: text(form, "textEn"), textCkb: text(form, "textCkb") }, req.now));
      case "publish":
        return ok(intent, await publishPolicy(req.db, req.actor, { slug: params.slug, version, reason: text(form, "reason") }, req.now));
      case "archive":
        return ok(intent, await archivePolicy(req.db, req.actor, { slug: params.slug, version, reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return settingsKit.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "policy.title", { title: args.loaderData?.editor.title ?? "" });

export default function PolicyPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { editor } = loaderData;
  const version = editor.version === null ? "" : String(editor.version);
  const [texts, setTexts] = useState(editor.text);
  const [dialog, setDialog] = useState<"start" | "publish" | "archive" | null>(null);
  const save = useFetcher<{ ok: boolean } & Record<string, unknown>>();
  const preview = textToBlocks(texts.ar);
  const dirty = texts.ar !== editor.text.ar || texts.en !== editor.text.en || texts.ckb !== editor.text.ckb;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/settings/policies" className="adm-link">
            {t("policies.title")}
          </Link>
        }
        title={editor.title}
        lead={t("policy.lead")}
        actions={
          <Key as="a" href={`/policies/${editor.slug}`} size="sm" iconEnd="arrow-square-out" target="_blank" rel="noopener">
            {t("policies.onStore")}
          </Key>
        }
      />
      <div className="sec-split mt-5">
        <div className="grid min-w-0 gap-5">
          {editor.source === "none" || !editor.row?.hasDraft ? (
            <Note icon="file-text">
              <p>{editor.source === "none" ? t("policy.noRow") : t("policy.noDraft")}</p>
              {editor.can.edit ? (
                <div>
                  <Key size="sm" icon="copy" onClick={() => setDialog("start")}>
                    {t("policy.start")}
                  </Key>
                </div>
              ) : null}
            </Note>
          ) : null}

          {editor.row?.hasDraft || editor.source === "published" ? (
            <Section id="edit" title={t("policy.edit")}>
              <save.Form method="post" className="adm-card sec-editor grid gap-3">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="version" value={version} />
                <TextArea name="textAr" label={t("policy.textAr")} value={texts.ar} onChange={(event) => setTexts({ ...texts, ar: event.currentTarget.value })} readOnly={!editor.can.edit || !editor.row?.hasDraft} required />
                <TextArea name="textEn" label={t("policy.textEn")} value={texts.en} onChange={(event) => setTexts({ ...texts, en: event.currentTarget.value })} readOnly={!editor.can.edit || !editor.row?.hasDraft} optional dir="ltr" />
                <TextArea name="textCkb" label={t("policy.textCkb")} value={texts.ckb} onChange={(event) => setTexts({ ...texts, ckb: event.currentTarget.value })} readOnly={!editor.can.edit || !editor.row?.hasDraft} optional />
                <p className="type-caption text-ink-2">{t("policy.syntax")}</p>
                <FormError message={save.data && !save.data.ok ? failureText(t, save.data) : null} />
                {save.data?.ok && save.state === "idle" ? (
                  <p role="status" className="type-label text-ok">
                    {t("policy.saved")}
                  </p>
                ) : null}
                {editor.can.edit && editor.row?.hasDraft ? (
                  <div className="sec-actions">
                    <Key type="submit" size="sm" variant="ink" icon="floppy-disk" disabled={!dirty} loading={save.state !== "idle"}>
                      {t("policy.saveDraft")}
                    </Key>
                    <Key size="sm" icon="copy" onClick={() => setDialog("start")}>
                      {t("policy.restart")}
                    </Key>
                  </div>
                ) : null}
              </save.Form>
            </Section>
          ) : null}

          <Section id="preview" title={dirty ? t("policy.previewUnsaved") : editor.row?.hasDraft ? t("policy.previewDraft") : t("policy.previewLive")}>
            <div className="adm-card gap-2">
              <Blocks blocks={editor.row?.hasDraft || editor.source === "published" ? preview : editor.live.blocks} headingLevel={3} />
            </div>
          </Section>
        </div>

        <aside className="grid min-w-0 gap-3">
          <div className="adm-card gap-1.5">
            <Pair label={t("policy.onStoreNow")}>
              <Status tone={editor.live.approved ? "ok" : "warn"}>{editor.live.approved ? t("policies.approved") : t("policies.draft")}</Status>
            </Pair>
            <Pair label={t("policy.row")}>{editor.row ? t(`policies.row.${editor.row.status}`) : "—"}</Pair>
            <Pair label={t("policy.published")}>{editor.row?.publishedAt ? <When at={editor.row.publishedAt} /> : "—"}</Pair>
            <Pair label={t("policy.updated")}>{editor.row ? <When at={editor.row.updatedAt} /> : "—"}</Pair>
          </div>
          {editor.can.publish ? (
            <div className="adm-card gap-2">
              <Key variant="ink" icon="seal-check" disabled={!editor.row?.hasDraft || dirty} onClick={() => setDialog("publish")}>
                {t("policy.publish")}
              </Key>
              {dirty ? <p className="type-caption text-ink-2">{t("policy.saveFirst")}</p> : null}
              {editor.row?.status === "published" ? (
                <Key size="sm" onClick={() => setDialog("archive")}>
                  {t("policy.archive")}
                </Key>
              ) : null}
            </div>
          ) : (
            <p className="type-caption text-ink-2">{t("policy.publishOwner")}</p>
          )}
        </aside>
      </div>

      <ActionDialog
        open={dialog === "start"}
        onClose={() => setDialog(null)}
        title={t("policy.startTitle")}
        consequence={editor.row?.hasDraft ? t("policy.startReplace") : t("policy.startConsequence")}
        confirmLabel={t("policy.start")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "start", version }}
        successMessage={t("policy.started")}
      />
      <ActionDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        title={t("policy.publishTitle", { title: editor.title })}
        consequence={t("policy.publishConsequence")}
        confirmLabel={t("policy.publish")}
        impact={[
          { label: t("policy.blocks"), value: String(preview.length) },
          { label: t("policy.languages"), value: [texts.ar && "العربية", texts.en && "English", texts.ckb && "کوردی"].filter(Boolean).join(" · ") },
        ]}
        reason={{ label: t("common.reason"), hint: t("policy.publishHint") }}
        fields={{ intent: "publish", version }}
        successMessage={t("policy.publishedDone")}
      />
      <ActionDialog
        open={dialog === "archive"}
        onClose={() => setDialog(null)}
        tone="destructive"
        title={t("policy.archiveTitle")}
        consequence={t("policy.archiveConsequence")}
        confirmLabel={t("policy.archive")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "archive", version }}
        successMessage={t("policy.archived")}
      />
    </>
  );
}
