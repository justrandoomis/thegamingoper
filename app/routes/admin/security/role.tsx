import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/role";
import { useFormat } from "~/i18n/react";
import { getRole, saveRolePermissions } from "~/server/services/admin/security/roles.server";
import { performAccessReview } from "~/server/services/admin/security/retention.server";
import { ACCESS_REVIEW_INTERVAL_DAYS, ACCESS_REVIEW_OUTCOMES, DAY_MS } from "~/server/services/admin/security/types";
import { can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { Checkbox, Radio, FieldGroup } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Fact, Note, PageHead, Pair, Section, When, useListSep, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { ok, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/roles/:roleId — 20.02 and 20.07 for one role: what it grants, module by module (the protected-data
 * permissions marked), who holds it, and its access reviews. Editing (staff.manage) shows what is added and removed and
 * whom it reaches before it is saved, with a reason; the owner role (the wildcard) and one's own role are never edited
 * here, and nobody grants what they do not hold. A review (security.access_review.perform) records that the reviewer
 * checked this exact set of permissions and members.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await sec.open(context);
  // Links only to pages this viewer may open: a staff.manage-only viewer (module 15, let in by the gate's ALSO_OPENED_BY)
  // holds neither audit.read nor security.session.read, and was linked to two 403 pages (follow-up 2026-11-12).
  const links = { history: can(actor, "audit.read"), staff: can(actor, "security.session.read") };
  return { detail: await sec.orRespond(() => getRole(db, actor, params.roleId, locale)), now, links };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await sec.open(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "permissions":
        return ok(intent, await saveRolePermissions(req.db, req.actor, { roleId: params.roleId, permissions: text(form, "permissions").split(",").filter(Boolean), fingerprint: text(form, "fingerprint"), reason: text(form, "reason") }, req.now));
      case "review":
        return ok(intent, await performAccessReview(req.db, req.actor, { roleId: params.roleId, outcome: text(form, "outcome"), note: text(form, "reason"), fingerprint: text(form, "fingerprint"), members: text(form, "members") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "role.title", { name: args.loaderData?.detail.role.name ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];

export default function RolePage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { detail, now, links } = loaderData;
  const { role } = detail;
  const last = detail.reviews[0] ?? null;
  const due = !last || now - last.at > ACCESS_REVIEW_INTERVAL_DAYS * DAY_MS;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/security/roles" className="adm-link">
            {t("roles.title")}
          </Link>
        }
        title={role.name}
        lead={role.description ?? undefined}
        actions={
          links.history ? (
            <Key as={Link} to={`/admin/security/audit?type=role&entity=${encodeURIComponent(role.id)}`} size="sm" icon="clipboard-text">
              {t("role.history")}
            </Key>
          ) : undefined
        }
      />
      <div className="sec-split mt-5">
        <div className="grid min-w-0 gap-5">
          <Permissions detail={detail} />
        </div>
        <aside className="grid min-w-0 gap-5">
          <Section id="members" title={t("role.members", { count: detail.members.length })}>
            {detail.members.length === 0 ? (
              <p className="type-body text-ink-2">{t("role.noMembers")}</p>
            ) : (
              <ul role="list" className="grid gap-1">
                {detail.members.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
                    {links.staff ? (
                      <Link to={`/admin/security/staff/${member.id}`} className="adm-link">
                        {member.name}
                      </Link>
                    ) : (
                      <span>{member.name}</span>
                    )}
                    <span className="flex gap-1">
                      {member.status === "disabled" ? <Status tone="bad">{t("staff.status.disabled")}</Status> : null}
                      <Status tone={member.twoStep ? "ok" : "warn"}>{member.twoStep ? t("staff.twoStepOn") : t("staff.twoStepOff")}</Status>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Review detail={detail} due={due} />
          <div className="adm-card gap-1">
            <Pair label={t("role.key")}>
              <bdi dir="ltr">{role.key}</bdi>
            </Pair>
            <Pair label={t("role.kind")}>{role.isSystem ? t("role.system") : t("role.custom")}</Pair>
            <Pair label={t("roles.col.permissions")}>{detail.stored.includes("*") ? t("roles.everything") : f.number(detail.stored.length)}</Pair>
          </div>
        </aside>
      </div>
    </>
  );
}

function Permissions({ detail }: { detail: Detail }) {
  const t = useModuleT();
  const sep = useListSep();
  const f = useFormat();
  const wildcard = detail.stored.includes("*");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(detail.stored));
  const [open, setOpen] = useState(false);
  const grantable = useMemo(() => new Set<string>(detail.grantable), [detail.grantable]);
  const labels = useMemo(() => new Map(detail.groups.flatMap((group) => group.permissions.map((permission) => [permission.key as string, permission] as const))), [detail.groups]);
  const added = [...chosen].filter((p) => !detail.stored.includes(p));
  const removed = detail.stored.filter((p) => !chosen.has(p));
  const fieldChanges = [...added, ...removed].filter((p) => labels.get(p)?.field);
  const editable = detail.can.edit;
  const names = (list: string[]) => (list.length ? list.slice(0, 8).map((p) => labels.get(p)?.label ?? p).join(sep) + (list.length > 8 ? ` ${t("role.andMore", { count: list.length - 8 })}` : "") : "—");
  return (
    <Section id="permissions" title={t("role.permissions")}>
      {wildcard ? (
        <Note>
          <p>{t("role.ownerNote")}</p>
        </Note>
      ) : null}
      {detail.locked === "own_role" ? (
        <Note tone="warn" icon="lock">
          <p>{t("role.ownRole")}</p>
        </Note>
      ) : null}
      {!wildcard ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (added.length || removed.length) setOpen(true);
          }}
          className="grid gap-3"
        >
          <div className="sec-perms">
            {detail.groups
              .filter((group) => group.permissions.length > 0)
              .map((group) => (
                <fieldset key={group.key} className="sec-perm-group">
                  <legend className="type-label">
                    {group.module ? <bdi className="nums">{group.module}</bdi> : null} {group.label}
                  </legend>
                  {group.permissions.map((permission) => {
                    const held = chosen.has(permission.key);
                    const canGrant = grantable.has(permission.key);
                    const label = (
                      <span>
                        {permission.label}
                        {permission.field ? (
                          <>
                            {" "}
                            <Status tone="info">{t("role.protected")}</Status>
                          </>
                        ) : null}
                      </span>
                    );
                    // only one's own permissions are given or taken away (the server refuses the rest both ways): the
                    // rest is shown as a fact, readable — a reviewer must see what the role grants
                    if (!editable || !canGrant) return <Fact key={permission.key} held={held} label={label} />;
                    return (
                      <Checkbox
                        key={permission.key}
                        label={label}
                        checked={held}
                        onChange={(event) => {
                          const on = event.currentTarget.checked;
                          setChosen((current) => {
                            const next = new Set(current);
                            if (on) next.add(permission.key);
                            else next.delete(permission.key);
                            return next;
                          });
                        }}
                      />
                    );
                  })}
                </fieldset>
              ))}
          </div>
          {editable ? (
            <div className="sec-actions sec-taskbar">
              <Key type="submit" size="sm" variant="ink" disabled={!added.length && !removed.length}>
                {t("role.save", { added: added.length, removed: removed.length })}
              </Key>
              <Key size="sm" onClick={() => setChosen(new Set(detail.stored))} disabled={!added.length && !removed.length}>
                {t("role.undo")}
              </Key>
            </div>
          ) : null}
        </form>
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("role.saveTitle", { name: detail.role.name })}
        consequence={t("role.saveConsequence", { count: detail.members.length })}
        confirmLabel={t("role.confirm")}
        impact={[
          { label: t("role.added", { count: added.length }), value: names(added) },
          { label: t("role.removed", { count: removed.length }), value: names(removed), negative: removed.length > 0 },
          { label: t("role.fieldChanges"), value: names(fieldChanges), negative: fieldChanges.length > 0 },
          { label: t("role.reaches"), value: f.number(detail.members.length) },
        ]}
        reason={{ label: t("common.reason"), hint: t("role.reasonHint") }}
        fields={{ intent: "permissions", permissions: [...chosen].sort().join(","), fingerprint: detail.fingerprint }}
        successMessage={t("role.saved")}
      />
    </Section>
  );
}

function Review({ detail, due }: { detail: Detail; due: boolean }) {
  const t = useModuleT();
  const [outcome, setOutcome] = useState<(typeof ACCESS_REVIEW_OUTCOMES)[number]>("confirmed");
  const [open, setOpen] = useState(false);
  const last = detail.reviews[0] ?? null;
  return (
    <Section id="review" title={t("role.review")}>
      <div className="adm-card gap-2">
        {last ? (
          <>
            <Pair label={t("role.lastReview")}>
              <When at={last.at} kind="date" />
            </Pair>
            <Pair label={t("role.reviewer")}>{last.by ?? "—"}</Pair>
            <Pair label={t("role.outcome")}>
              <Status tone={last.outcome === "confirmed" ? "ok" : "warn"}>{t(`role.outcomes.${last.outcome}`)}</Status>
            </Pair>
            {last.note ? <p className="type-caption text-ink-2">{last.note}</p> : null}
          </>
        ) : (
          <p className="type-body text-ink-2">{t("role.neverReviewed")}</p>
        )}
        <p className="type-caption">{due ? <Status tone="warn">{t("role.dueNow", { days: ACCESS_REVIEW_INTERVAL_DAYS })}</Status> : t("role.dueEvery", { days: ACCESS_REVIEW_INTERVAL_DAYS })}</p>
        {detail.can.review ? (
          <div>
            <Key size="sm" icon="seal-check" onClick={() => setOpen(true)}>
              {t("role.doReview")}
            </Key>
          </div>
        ) : null}
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("role.reviewTitle", { name: detail.role.name })}
        consequence={t("role.reviewConsequence", { members: detail.members.length })}
        confirmLabel={t("role.recordReview")}
        reason={{ label: t("role.reviewNote"), hint: t("role.reviewNoteHint") }}
        fields={{ intent: "review", outcome, fingerprint: detail.fingerprint, members: detail.membersFingerprint }}
        successMessage={t("role.reviewDone")}
      >
        <FieldGroup legend={t("role.outcome")}>
          {ACCESS_REVIEW_OUTCOMES.map((value) => (
            <Radio key={value} row name="review-outcome" value={value} label={t(`role.outcomes.${value}`)} checked={outcome === value} onChange={() => setOutcome(value)} />
          ))}
        </FieldGroup>
      </ActionDialog>
    </Section>
  );
}
