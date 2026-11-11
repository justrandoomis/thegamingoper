import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/key";
import { useDir } from "~/i18n/react";
import { decideSettingChange, getSettingItem, proposeSettingChange, type PendingChange } from "~/server/services/admin/settings/changes.server";
import { viewOf } from "~/server/services/admin/settings/catalog";
import { invalid } from "~/server/errors";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Note, PageHead, Pair, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { json, newKey, ok, optional, text } from "../security/route-kit.server";
import { EditorFields, ValueView, changeRows, draftOf, numberingBag, valueOf, type Draft } from "./components/values";
import { ChangeLog } from "./components/log";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/keys/:key — one setting: its value in force, where it takes effect, who changed it and why (its
 * history), and the form to change it. The confirm dialog shows every field that changes (before → after) and needs
 * a reason. A control limit changed by someone without settings.change.approve becomes a REQUEST: another person who
 * may approve it decides here (never the requester, who may withdraw it).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await settingsKit.open(context, "settings.read");
  return { item: await settingsKit.orRespond(() => getSettingItem(db, actor, params.key, locale, now)), formKey: newKey() };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await settingsKit.open(context, "settings.read");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "change":
        return ok(intent, await proposeSettingChange(req.db, req.actor, { key: params.key, value: json(form, "value"), expected: json(form, "expected"), reason: text(form, "reason"), idempotencyKey: text(form, "formKey") }, req.now));
      case "decide":
        return ok(intent, await decideSettingChange(req.db, req.actor, { approvalId: text(form, "approvalId"), decision: text(form, "decision"), note: optional(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return settingsKit.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "key.title", { label: args.loaderData?.item.label ?? "" });

type Item = Route.ComponentProps["loaderData"]["item"];

export default function SettingKeyPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { item, formKey } = loaderData;
  const view = viewOf(item.key, item.editor);
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/settings" className="adm-link">
            {t("home.title")}
          </Link>
        }
        title={item.label}
        lead={t(`help.${item.key.replace(/\./g, "_")}`)}
      />
      <div className="sec-split mt-5">
        <div className="grid min-w-0 gap-5">
          <Section id="current" title={t("key.current")}>
            <div className="adm-card gap-2">
              {item.broken !== null ? (
                <Note tone="bad" icon="warning-circle">
                  <p>{t("key.broken", { reason: item.broken })}</p>
                </Note>
              ) : (
                <ValueView editor={view} value={item.key === "locale.numbering" ? numberingBag(item.value) : item.value} t={t} />
              )}
              {item.isDefault ? <p className="type-caption text-ink-2">{t("key.isDefault")}</p> : null}
            </div>
          </Section>
          {item.pending ? <Pending change={item.pending} item={item} /> : null}
          <Editor item={item} formKey={formKey} />
          <Section id="history" title={t("key.history")}>
            <ChangeLog rows={item.history} editor={view} />
          </Section>
        </div>
        <aside className="grid min-w-0 gap-3">
          <div className="adm-card gap-1.5">
            <Pair label={t("key.key")}>
              <bdi dir="ltr" className="break-all">
                {item.key}
              </bdi>
            </Pair>
            <Pair label={t("key.group")}>{t(`group.${item.group}`)}</Pair>
            <Pair label={t("key.permission")}>
              <bdi dir="ltr">{item.permission}</bdi>
            </Pair>
            <Pair label={t("key.approver")}>{item.approver ? <bdi dir="ltr">{item.approver}</bdi> : t("key.noApprover")}</Pair>
            <Pair label={t("key.shown")}>{item.public ? t("key.public") : t("key.internal")}</Pair>
            <Pair label={t("key.lastChange")}>{item.updatedAt ? <When at={item.updatedAt} /> : t("home.neverChanged")}</Pair>
          </div>
        </aside>
      </div>
    </>
  );
}

function Editor({ item, formKey }: { item: Item; formKey: string }) {
  const t = useModuleT();
  const dir = useDir();
  const arrow = dir === "rtl" ? "←" : "→";
  // a broken stored value is replaced: the form starts from the default, and says it saw "broken" (expected: null)
  const initial = useMemo(() => draftOf(item.editor, item.broken !== null ? item.defaultValue : item.value), [item.editor, item.value, item.broken, item.defaultValue]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [open, setOpen] = useState(false);
  const [shownErrors, setShownErrors] = useState<Record<string, string>>({});
  const read = valueOf(item.editor, draft);
  const rows = changeRows(item.editor, item.broken !== null ? null : item.value, read.value, t, arrow, item.broken !== null ? { beforeText: t("key.brokenShort") } : undefined);
  if (item.editor.kind === "linked") {
    return (
      <Section id="edit" title={t("key.change")}>
        <Note>
          <p>{t(`key.linked.${item.editor.module}`)}</p>
          <p>
            <Link to={item.editor.href} className="adm-link">
              {t(`home.editIn.${item.editor.module}`)}
            </Link>
          </p>
        </Note>
      </Section>
    );
  }
  if (item.editor.kind === "unused") {
    return (
      <Section id="edit" title={t("key.change")}>
        <Note tone="warn" icon="info">
          <p>{t(`key.unused.${item.key.replace(/\./g, "_")}`)}</p>
        </Note>
      </Section>
    );
  }
  if (!item.canEdit) {
    return (
      <Section id="edit" title={t("key.change")}>
        <p className="type-body text-ink-2">{t("key.readOnly", { permission: item.permission })}</p>
      </Section>
    );
  }
  return (
    <Section id="edit" title={item.needsApproval ? t("key.requestTitle") : t("key.change")}>
      {item.needsApproval ? (
        <Note icon="scales">
          <p>{t("key.needsApproval")}</p>
        </Note>
      ) : null}
      <form
        className="adm-card grid gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setShownErrors(read.errors);
          if (Object.keys(read.errors).length === 0 && rows.length > 0) setOpen(true);
        }}
      >
        <EditorFields editor={item.editor} draft={draft} setDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))} errors={shownErrors} t={t} />
        <div className="sec-actions">
          {/* only a LIVE request holds the key: an expired one is shown to be closed, never a lock (review 2026-11-11) */}
          <Key type="submit" size="sm" variant="ink" disabled={rows.length === 0 || item.blocked}>
            {item.needsApproval ? t("key.request") : t("key.review")}
          </Key>
          <Key size="sm" onClick={() => setDraft(initial)} disabled={rows.length === 0}>
            {t("key.undo")}
          </Key>
        </div>
        {item.blocked ? <p className="type-caption text-ink-2">{t("key.onePending")}</p> : null}
      </form>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={item.needsApproval ? t("key.requestDialog", { label: item.label }) : t("key.applyDialog", { label: item.label })}
        consequence={item.needsApproval ? t("key.requestConsequence") : t(`key.applyConsequence.${item.public ? "public" : "internal"}`)}
        confirmLabel={item.needsApproval ? t("key.request") : t("key.apply")}
        impact={rows}
        reason={{ label: t("common.reason"), hint: t("key.reasonHint") }}
        fields={{ intent: "change", value: JSON.stringify(read.value ?? null), expected: JSON.stringify(item.value ?? null), formKey }}
        successMessage={(data) => {
          const status = (data as { status?: string }).status;
          return t(status === "requested" ? "key.requested" : status === "unchanged" ? "key.unchanged" : "key.applied");
        }}
      />
    </Section>
  );
}

function Pending({ change, item }: { change: PendingChange; item: Item }) {
  const t = useModuleT();
  const dir = useDir();
  const arrow = dir === "rtl" ? "←" : "→";
  const [decision, setDecision] = useState<"approve" | "reject" | "withdraw" | null>(null);
  // a request made while the stored value was broken was made against "broken" (null), never against a value
  const rows = changeRows(item.editor, change.before, change.value, t, arrow, change.before === null ? { beforeText: t("key.brokenShort") } : undefined);
  // only approving changes the value: rejecting, closing or withdrawing shows what was ASKED, never "what will change"
  const asked = (
    <div className="panel px-4 py-3">
      <p className="type-caption text-ink-2">{t("key.asked")}</p>
      <dl className="mt-1 grid gap-1">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="type-label text-ink">{row.label}</dt>
            <dd className="type-data min-w-0 text-ink">
              <bdi>{row.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
  return (
    <Section id="pending" title={t("key.pending")}>
      <div className="adm-card adm-card--act gap-2">
        <p className="type-body">{t("key.pendingBy", { who: change.requestedBy.name ?? "—" })}</p>
        <ul role="list" className="grid gap-1">
          {rows.map((row) => (
            <li key={row.label} className="flex flex-wrap justify-between gap-2">
              <span className="type-caption text-ink-2">{row.label}</span>
              <bdi className="type-data">{row.value}</bdi>
            </li>
          ))}
        </ul>
        {change.reason ? <p className="type-caption">{t("key.because", { reason: change.reason })}</p> : null}
        <p className="type-caption text-ink-2">
          <When at={change.requestedAt} />
          {change.expired ? (
            <>
              {" "}
              · <Status tone="warn">{t("key.expired")}</Status>
            </>
          ) : null}
        </p>
        <div className="sec-actions">
          {change.canDecide ? (
            <Key size="sm" variant="ink" icon="check" onClick={() => setDecision("approve")}>
              {t("key.approve")}
            </Key>
          ) : null}
          {/* an expired request can no longer be approved, but a decider closes it (rejected, with a note) */}
          {change.canReject ? (
            <Key size="sm" onClick={() => setDecision("reject")}>
              {change.expired ? t("key.closeExpired") : t("key.reject")}
            </Key>
          ) : null}
          {change.mine ? (
            <Key size="sm" onClick={() => setDecision("withdraw")}>
              {t("key.withdraw")}
            </Key>
          ) : null}
          {!change.canDecide && !change.canReject && !change.mine ? <span className="type-caption text-ink-2">{t(change.expired ? "key.expiredWaits" : "key.waitsFor")}</span> : null}
        </div>
      </div>
      <ActionDialog
        open={decision !== null}
        onClose={() => setDecision(null)}
        tone={decision === "reject" ? "destructive" : "neutral"}
        // closing an expired request is a rejection in the books, but it says what it is
        title={decision ? t(`key.decision.${decision === "reject" && change.expired ? "close" : decision}.title`) : ""}
        consequence={decision ? t(`key.decision.${decision === "reject" && change.expired ? "close" : decision}.text`) : ""}
        // short labels: the title already names the action, and a phone's dialog key cuts long ones
        confirmLabel={decision ? (decision === "reject" && change.expired ? t("key.confirmClose") : decision === "withdraw" ? t("key.confirmWithdraw") : t(`key.${decision}`)) : ""}
        impact={decision === "approve" ? rows : asked}
        reason={decision === "reject" ? { label: t("common.reason") } : decision === "approve" ? { label: t("key.note"), noteRequired: false } : false}
        fields={{ intent: "decide", approvalId: change.id, decision: decision ?? "" }}
        successMessage={t("key.decided")}
      />
    </Section>
  );
}
