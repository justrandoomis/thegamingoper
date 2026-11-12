import { useState } from "react";
import { data } from "react-router";

import type { Route } from "./+types/replies";
import { can } from "~/server/actor";
import { forbidden, invalid, throwAsResponse } from "~/server/errors";
import { listCannedReplies, saveCannedReply, type CannedReplyRow } from "~/server/services/admin/support/replies.server";
import { CANNED_VARIABLES, TICKET_CATEGORIES, checkTemplate } from "~/server/services/admin/support/types";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { supportMeta } from "./meta";
import { checked, failure, openSupport, text } from "./support.server";
import { Boundary, Failure, listOf, Section, useIntent, useSupportT, When } from "./ui";

/**
 * /admin/support/replies — canned replies (14.04) with a fixed list of SAFE variables (`{customer_name}`, …) filled from
 * the ticket on the server; no template code (conditions, loops, filters, markup) is accepted. On a ticket a canned
 * reply only fills the composer: the agent reads and edits it, and a text that still holds a `{variable}` is refused.
 * Using them: support.ticket.reply; writing them: support.canned_reply.manage.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openSupport(context, ["support.ticket.reply", "support.canned_reply.manage"]);
  try {
    return await listCannedReplies(db, actor);
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openSupport(context, ["support.ticket.reply", "support.canned_reply.manage"]);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "save") throw invalid({ intent: "invalid" });
    if (!can(actor, "support.canned_reply.manage")) throw forbidden("support.canned_reply.manage");
    const expected = Number(text(form, "expectedUpdatedAt"));
    const result = await saveCannedReply(
      db,
      actor,
      {
        id: text(form, "replyId") || undefined,
        key: text(form, "key"),
        title: text(form, "title"),
        bodyAr: text(form, "bodyAr"),
        bodyEn: text(form, "bodyEn"),
        bodyCkb: text(form, "bodyCkb"),
        category: (text(form, "category") || null) as never,
        isActive: checked(form, "isActive"),
        expectedUpdatedAt: text(form, "expectedUpdatedAt") && Number.isFinite(expected) ? expected : undefined,
        reason: text(form, "reason"),
      },
      now,
    );
    return { ok: true as const, intent, created: result.created };
  } catch (error) {
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "replies.title");

export default function RepliesPage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const { rows, canManage } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("replies.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("replies.lead")}</p>
      </header>
      <Boundary icon="shield-check">{t("replies.safety")}</Boundary>

      <Section id="replies-vars" title={t("replies.variables")}>
        <dl className="sup-facts">
          {CANNED_VARIABLES.map((name) => (
            <div key={name}>
              <dt>
                <bdi dir="ltr" className="nums">{`{${name}}`}</bdi>
              </dt>
              <dd>{t(`replies.var.${name}`)}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="replies-list" title={t("replies.list")}>
        {rows.length === 0 ? <p className="type-body text-ink-2">{t("replies.empty")}</p> : null}
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li key={row.id}>
              <ReplyCard row={row} canManage={canManage} />
            </li>
          ))}
        </ul>
        {canManage ? (
          <Disclosure summary={t("replies.new")} variant="panel" defaultOpen={rows.length === 0}>
            <ReplyForm row={null} />
          </Disclosure>
        ) : (
          <p className="type-caption text-ink-2">{t("replies.readOnly")}</p>
        )}
      </Section>
    </>
  );
}

function ReplyCard({ row, canManage }: { row: CannedReplyRow; canManage: boolean }) {
  const t = useSupportT();
  return (
    <article className="sup-rule" data-active={row.isActive ? "true" : "false"}>
      <div className="sup-rule__head">
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="type-strong">{row.title}</span>
          <bdi dir="ltr" className="sup-tag nums">
            {row.key}
          </bdi>
          <span className="sup-tag">{row.category ? t(`category.${row.category}`) : t("replies.anyCategory")}</span>
          <Status tone={row.isActive ? "ok" : "neutral"}>{t(row.isActive ? "routing.active" : "routing.off")}</Status>
        </span>
        <span className="type-caption text-ink-2">
          <When at={row.updatedAt} />
        </span>
      </div>
      <p className="sup-msg__body">{row.body.ar}</p>
      <p className="type-caption text-ink-2">{t("replies.languages", { languages: listOf(["ar", ...(row.body.en ? ["en"] : []), ...(row.body.ckb ? ["ckb"] : [])].map((locale) => t(`language.${locale}`)), t("listSep")) })}</p>
      {row.variables.length ? (
        <p className="sup-chips">
          {row.variables.map((name) => (
            <bdi key={name} dir="ltr" className="sup-tag nums">{`{${name}}`}</bdi>
          ))}
        </p>
      ) : null}
      {canManage ? (
        <Disclosure summary={t("replies.edit")} variant="row">
          <ReplyForm row={row} />
        </Disclosure>
      ) : null}
    </article>
  );
}

/** What the client can say about a body before it is sent (the server checks the same and decides). */
function BodyCheck({ value }: { value: string }) {
  const t = useSupportT();
  if (!value.trim()) return null;
  const check = checkTemplate(value);
  if (check.code) return <p className="type-caption text-red-ink">{t("errors.template_code")}</p>;
  if (check.unknown.length) return <p className="type-caption text-red-ink">{t("replies.unknown", { names: listOf(check.unknown.map((name) => `{${name}}`), t("listSep")) })}</p>;
  if (check.variables.length) return <p className="type-caption text-ink-2">{t("replies.uses", { names: listOf(check.variables.map((name) => `{${name}}`), t("listSep")) })}</p>;
  return null;
}

function ReplyForm({ row }: { row: CannedReplyRow | null }) {
  const t = useSupportT();
  const save = useIntent("save", (result) => (result.created ? "done.replyCreated" : "done.replySaved"));
  const fields = save.fields;
  const [bodies, setBodies] = useState({ ar: row?.body.ar ?? "", en: row?.body.en ?? "", ckb: row?.body.ckb ?? "" });
  return (
    <save.fetcher.Form method="post" className="grid gap-3 pt-2 md:grid-cols-2" key={row ? `${row.id}-${row.updatedAt}` : "new"}>
      <input type="hidden" name="intent" value="save" />
      {row ? <input type="hidden" name="replyId" value={row.id} /> : null}
      {row ? <input type="hidden" name="expectedUpdatedAt" value={row.updatedAt} /> : null}
      <TextField name="title" label={t("replies.form.title")} defaultValue={row?.title ?? ""} required error={fields.title} />
      <TextField name="key" label={t("replies.form.key")} hint={t("replies.form.keyHint")} defaultValue={row?.key ?? ""} ltr required error={fields.key} />
      <Select name="category" label={t("inbox.category")} defaultValue={row?.category ?? ""} options={[{ value: "", label: t("replies.anyCategory") }, ...TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))]} error={fields.category} />
      <Checkbox name="isActive" label={t("routing.form.active")} defaultChecked={row ? row.isActive : true} />
      {(["ar", "en", "ckb"] as const).map((locale) => {
        const name = locale === "ar" ? "bodyAr" : locale === "en" ? "bodyEn" : "bodyCkb";
        return (
          <div key={locale} className="grid gap-1 md:col-span-2">
            <TextArea
              name={name}
              label={t("replies.form.body", { language: t(`language.${locale}`) })}
              hint={locale === "ar" ? t("replies.form.bodyHint") : t("replies.form.bodyOptional")}
              value={bodies[locale]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setBodies((current) => ({ ...current, [locale]: value }));
              }}
              rows={4}
              dir={locale === "en" ? "ltr" : "rtl"}
              required={locale === "ar"}
              optional={locale !== "ar"}
              error={fields[name]}
            />
            <BodyCheck value={bodies[locale]} />
          </div>
        );
      })}
      <TextField name="reason" label={t("dialog.reason")} hint={t("replies.form.reasonHint")} required className="md:col-span-2" error={fields.reason} />
      <div className="grid gap-2 md:col-span-2">
        <Failure message={save.message} />
        <div>
          <Key type="submit" variant="ink" icon="floppy-disk" loading={save.pending}>
            {t("replies.form.save")}
          </Key>
        </div>
      </div>
    </save.fetcher.Form>
  );
}
