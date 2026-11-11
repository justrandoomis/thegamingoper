/**
 * Admin 22.06 (and the editor of every key) — settings changes with a log and approvals.
 *
 *   · Every key has a permission (~/server/settings.server SETTINGS). A change applies through setSetting with the value
 *     the person saw on the screen as `expected` — checked before the batch and inside it, so two people changing the
 *     same key at once never overwrite each other silently (`setting_changed`) — with a reason, audited before/after.
 *   · Keys with an `approver` (the money-control limits: price cuts, purchase orders, top-ups, expenses) are changed
 *     directly only by someone who holds that permission (settings.change.approve: the owner by default). Anyone else
 *     who may change the key REQUESTS the change: an `approvals` row (kind "settings") with the value, the value in force
 *     when asked and the reason. Another employee who holds both permissions approves it — the requester never decides
 *     their own request (`approver_is_requester`) — and the approval and the setting are written in ONE batch, guarded
 *     on the value the request was made against (a value changed since makes the request stale: reject it, ask again).
 *     One open request per key; the requester may withdraw it.
 *   · The log is the audit trail of every "settings.*" action (values, requests, decisions, custom fields, templates,
 *     policies), newest first, filterable by key.
 */
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, auditEvents, employees, settings } from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { SETTINGS, SETTING_KEYS, isSettingChangedError, isSettingKey, parseSettingValue, readSettingState, setSetting, settingChangeStatements, settingDefault, type SettingKey } from "~/server/settings.server";
import { SETTING_EDITORS, type ChangeFilters, type SettingEditor } from "./catalog";

export const SETTINGS_APPROVAL_KIND = "settings";
const PAGE_SIZE = 40;
/** A request nobody decided in this long can no longer be approved (it is shown as expired). */
export const REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Def = { permission: Permission; approver?: Permission; group: string; public: boolean; label: { ar: string; en: string } };
const defOf = (key: SettingKey): Def => SETTINGS[key] as unknown as Def;
const labelOf = (key: SettingKey, locale: Locale) => pick(defOf(key).label, locale);

export type PendingChange = {
  id: string;
  key: SettingKey;
  label: string;
  value: unknown;
  before: unknown;
  reason: string | null;
  requestedBy: { id: string; name: string | null };
  requestedAt: number;
  expiresAt: number | null;
  expired: boolean;
  /** Whether this employee may approve it (both permissions, not their own, not expired). */
  canDecide: boolean;
  /** Whether this employee may reject it — an expired request too, so it can be closed (both permissions, not their own). */
  canReject: boolean;
  mine: boolean;
};

export type SettingItem = {
  key: SettingKey;
  group: string;
  label: string;
  /** The value in force; null when the stored value is broken (see `broken`). */
  value: unknown;
  isStored: boolean;
  isDefault: boolean;
  defaultValue: unknown;
  /**
   * Why the stored value no longer fits the key's schema (its first complaint), or null. Every other reader refuses a
   * broken value; this page shows it and lets who may change the key replace it (the form's `expected` is null).
   */
  broken: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  editor: SettingEditor;
  permission: Permission;
  approver: Permission | null;
  /** May change it at all (holds the key's permission and the key is edited here). */
  canEdit: boolean;
  /** A change by this employee waits for a second person. */
  needsApproval: boolean;
  /** The newest open request for the key (an expired one too, so it can be closed). */
  pending: PendingChange | null;
  /** A live (not expired) request exists: a new request waits until it is decided or withdrawn. */
  blocked: boolean;
  public: boolean;
};

async function namesOf(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

const editable = (editor: SettingEditor) => editor.kind === "value" || editor.kind === "object";

export async function pendingChanges(db: Db, actor: Actor, locale: Locale, now: number, key?: SettingKey): Promise<PendingChange[]> {
  assertCan(actor, "settings.read");
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, SETTINGS_APPROVAL_KIND), eq(approvals.status, "pending"), key ? eq(approvals.entityId, key) : undefined))
    .orderBy(desc(approvals.createdAt))
    .limit(100);
  const names = await namesOf(
    db,
    rows.map((row) => row.requestedBy),
  );
  const me = actor.kind === "employee" ? actor.id : null;
  return rows
    .filter((row) => isSettingKey(row.entityId))
    .map((row) => {
      const settingKey = row.entityId as SettingKey;
      const payload = (row.payload ?? {}) as { value?: unknown; before?: unknown };
      const def = defOf(settingKey);
      const expired = row.expiresAt !== null && row.expiresAt <= now;
      const decider = me !== row.requestedBy && can(actor, "settings.change.approve") && can(actor, def.permission);
      return {
        id: row.id,
        key: settingKey,
        label: labelOf(settingKey, locale),
        value: payload.value ?? null,
        before: payload.before ?? null,
        reason: row.reason,
        requestedBy: { id: row.requestedBy, name: names.get(row.requestedBy) ?? null },
        requestedAt: row.createdAt,
        expiresAt: row.expiresAt,
        expired,
        canDecide: !expired && decider,
        canReject: decider,
        mine: me === row.requestedBy,
      };
    });
}

/** Every key with its value in force, who changed it last, how this employee may change it, and its open request. */
export async function listSettingItems(db: Db, actor: Actor, locale: Locale, now: number): Promise<SettingItem[]> {
  assertCan(actor, "settings.read");
  const [rows, pending] = await Promise.all([db.select().from(settings), pendingChanges(db, actor, locale, now)]);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const names = await namesOf(
    db,
    rows.map((row) => row.updatedBy),
  );
  // read from the rows above, never throwing: one broken value must not take the whole module (the place to fix it) down
  const states = await Promise.all(SETTING_KEYS.map((key) => readSettingState(db, key, byKey.get(key) ?? null)));
  return SETTING_KEYS.map((key, index) => {
    const def = defOf(key);
    const row = byKey.get(key);
    const editor = SETTING_EDITORS[key] ?? ({ kind: "unused" } as const);
    const defaultValue = settingDefault(key);
    const state = states[index];
    const requests = pending.filter((change) => change.key === key);
    return {
      key,
      group: def.group,
      label: labelOf(key, locale),
      value: state.value,
      isStored: row !== undefined,
      isDefault: state.broken === null && JSON.stringify(state.value) === JSON.stringify(defaultValue),
      defaultValue,
      broken: state.broken,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ? (names.get(row.updatedBy) ?? null) : null,
      editor,
      permission: def.permission,
      approver: def.approver ?? null,
      canEdit: editable(editor) && can(actor, def.permission),
      needsApproval: Boolean(def.approver) && !can(actor, def.approver as Permission),
      pending: requests[0] ?? null,
      blocked: requests.some((change) => !change.expired),
      public: def.public,
    };
  });
}

export async function getSettingItem(db: Db, actor: Actor, key: string, locale: Locale, now: number): Promise<SettingItem & { history: ChangeLogRow[] }> {
  assertCan(actor, "settings.read");
  if (!isSettingKey(key)) throw notFound("setting");
  const [items, history] = await Promise.all([listSettingItems(db, actor, locale, now), listChanges(db, actor, { key, page: 1 }, locale)]);
  const item = items.find((entry) => entry.key === key);
  if (!item) throw notFound("setting");
  return { ...item, history: history.rows };
}

const ProposeInput = z.object({
  key: z.string(),
  value: z.unknown(),
  expected: z.unknown(),
  reason: z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long"),
  idempotencyKey: z.string().trim().min(8, "invalid").max(120, "invalid"),
});

const KeyOnly = z.object({ key: z.string() });

/**
 * Changes a key — at once when this employee may, or as a request a second person decides. `expected` is the value the
 * form showed (null: the form showed the stored value as broken). Returns what happened.
 */
export async function proposeSettingChange(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "applied" | "requested" | "unchanged"; requestId?: string; replayed?: boolean }> {
  assertCan(actor, "settings.read");
  // the key's permission before anything else the form carries: a role that may not change the key gets 403, never a
  // field error (review 2026-11-11: the reason used to be read first)
  const named = KeyOnly.safeParse(raw);
  if (!named.success || !isSettingKey(named.data.key)) throw notFound("setting");
  const key = named.data.key;
  const def = defOf(key);
  assertCan(actor, def.permission);
  const input = ProposeInput.parse(raw);
  const editor = SETTING_EDITORS[key];
  if (!editor || !editable(editor)) throw new AppError("not_editable", 409);
  const next = parseSettingValue(key, input.value);
  const direct = !def.approver || can(actor, def.approver);
  const requester = actor.kind === "employee" ? actor.id : "system";
  const requestId = `apr_set_${(await sha256Hex(`settings:${requester}:${input.idempotencyKey}`)).slice(0, 24)}`;
  if (!direct) {
    // the same form sent again (a double click, a retry): the request it already made — checked before anything
    // else, since that request is now the open one for this key
    const earlier = await db.select({ entityId: approvals.entityId, payload: approvals.payload }).from(approvals).where(eq(approvals.id, requestId)).get();
    if (earlier) {
      if (earlier.entityId !== key || JSON.stringify((earlier.payload as { value?: unknown } | null)?.value) !== JSON.stringify(next)) throw new AppError("idempotency_mismatch", 409);
      return { status: "requested", requestId, replayed: true };
    }
  }
  // the value in force, never throwing: a stored value that no longer fits is "broken" (null) and can only be replaced
  const state = await readSettingState(db, key);
  const inForce = state.value;
  if (state.broken === null && JSON.stringify(next) === JSON.stringify(inForce)) {
    // already in force although the form showed another value: someone (or this same form, sent twice) set it
    if (direct && input.expected !== undefined && JSON.stringify(parseExpected(key, input.expected)) !== JSON.stringify(inForce)) return { status: "unchanged" };
    throw invalid({ value: "no_change" });
  }

  if (direct) {
    await setSetting(db, actor, key, next, input.reason, now, { expected: input.expected });
    return { status: "applied" };
  }

  // a request: made against the value in force (the form's), one open request per key
  const seen = state.broken !== null ? input.expected === null : JSON.stringify(parseExpected(key, input.expected)) === JSON.stringify(inForce);
  if (!seen) throw new AppError("setting_changed", 409, { detail: key });
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${SETTINGS_APPROVAL_KIND} AND entity_id = ${key} AND status = 'pending' AND (expires_at IS NULL OR expires_at > ${now}))`, { code: "CHANGE_PENDING", detail: key }),
      db.insert(approvals).values({
        id: requestId,
        kind: SETTINGS_APPROVAL_KIND,
        entityType: "setting",
        entityId: key,
        requestedBy: requester,
        payload: { value: next, before: inForce },
        status: "pending",
        reason: input.reason,
        requiredPermission: def.approver,
        createdAt: now,
        expiresAt: now + REQUEST_TTL_MS,
      }),
      auditStatement(db, { actor, action: "settings.change.request", entityType: "setting", entityId: key, summary: requestId, before: { value: inForce }, after: { value: next }, reason: input.reason, at: now, redact: { phones: false } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "requested", requestId, replayed: true };
    if (mapDbError(error)?.code === "CHANGE_PENDING") {
      // two sends of the same form at once: the first one's request is the open one
      if (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.id, requestId)).get()) return { status: "requested", requestId, replayed: true };
      throw new AppError("change_pending", 409, { detail: key });
    }
    throw error;
  }
  return { status: "requested", requestId, replayed: false };
}

/** The value a form showed, normalized like a stored one (undefined when it does not fit the key). */
function parseExpected(key: SettingKey, value: unknown): unknown {
  try {
    return parseSettingValue(key, value);
  } catch {
    return undefined;
  }
}

const DecideInput = z.object({
  approvalId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "invalid"),
  decision: z.enum(["approve", "reject", "withdraw"], { error: "invalid" }),
  note: z.string().trim().max(500, "too_long").optional(),
});

/**
 * Approves, rejects or (the requester) withdraws a pending request. Approving writes the setting and closes the request
 * in one batch, guarded on the value the request was made against.
 */
export async function decideSettingChange(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "rejected" | "withdrawn"; replayed: boolean }> {
  assertCan(actor, "settings.read");
  const input = DecideInput.parse(raw);
  const row = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, SETTINGS_APPROVAL_KIND))).get();
  if (!row || !isSettingKey(row.entityId)) throw notFound("approval");
  const key = row.entityId as SettingKey;
  const def = defOf(key);
  const me = actor.kind === "employee" ? actor.id : null;
  const decided = input.decision === "approve" ? "approved" : "rejected";
  if (row.status !== "pending") {
    if (row.status === decided && row.decidedBy === me) return { status: input.decision === "withdraw" ? "withdrawn" : decided, replayed: true };
    throw new AppError("change_not_pending", 409);
  }
  const payload = (row.payload ?? {}) as { value?: unknown; before?: unknown };
  const close = (status: "approved" | "rejected", note: string | null): BatchStatement[] => [
    db.update(approvals).set({ status, decidedBy: me, decidedAt: now, decisionNote: note }).where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: row.id }),
  ];
  const run = async (statements: BatchStatement[]) => {
    try {
      await runBatch(db, statements);
    } catch (error) {
      if (mapDbError(error)?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
      if (isSettingChangedError(error)) throw new AppError("setting_changed", 409, { detail: key });
      throw error;
    }
  };

  if (input.decision === "withdraw") {
    if (me !== row.requestedBy) throw new AppError("forbidden", 403);
    await run([...close("rejected", "withdrawn"), auditStatement(db, { actor, action: "settings.change.withdraw", entityType: "setting", entityId: key, summary: row.id, reason: input.note || null, at: now })]);
    return { status: "withdrawn", replayed: false };
  }

  assertCan(actor, "settings.change.approve");
  assertCan(actor, def.permission);
  if (me === row.requestedBy) throw new AppError("approver_is_requester", 403);
  if (input.decision === "reject") {
    if (!input.note || input.note.length < 3) throw invalid({ note: "reason_required" });
    await run([...close("rejected", input.note), auditStatement(db, { actor, action: "settings.change.reject", entityType: "setting", entityId: key, summary: row.id, after: { value: payload.value ?? null }, reason: input.note, at: now, redact: { phones: false } })]);
    return { status: "rejected", replayed: false };
  }

  if (row.expiresAt !== null && row.expiresAt <= now) throw new AppError("change_not_pending", 409, { detail: "expired" });
  const requester = await db.select({ name: employees.name }).from(employees).where(eq(employees.id, row.requestedBy)).get();
  const reason = `${row.reason ?? ""}${input.note ? ` — ${input.note}` : ""}`.trim() || "approved";
  const change = await settingChangeStatements(db, actor, key, payload.value, reason, now, { expected: payload.before });
  await run([
    ...close("approved", input.note || null),
    ...change.statements,
    auditStatement(db, { actor, action: "settings.change.approve", entityType: "setting", entityId: key, summary: row.id, before: { value: payload.before ?? null }, after: { value: change.next, requestedBy: requester?.name ?? row.requestedBy }, reason: input.note || null, at: now, redact: { phones: false } }),
  ]);
  return { status: "approved", replayed: false };
}

export type ChangeLogRow = { id: string; at: number; action: string; key: string | null; label: string | null; actor: string | null; before: unknown; after: unknown; reason: string | null; summary: string | null };

/** The settings module's part of the audit trail ("settings.*" actions), newest first. */
export async function listChanges(db: Db, actor: Actor, filters: ChangeFilters, locale: Locale = "ar"): Promise<{ rows: ChangeLogRow[]; total: number; page: number; pageCount: number }> {
  assertCan(actor, "settings.read");
  const where = and(like(auditEvents.action, "settings.%"), filters.key ? eq(auditEvents.entityId, filters.key) : undefined);
  const [rows, count] = await Promise.all([
    db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.seq)).limit(PAGE_SIZE).offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(where).get(),
  ]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      at: row.at,
      action: row.action,
      key: row.entityId,
      label: row.entityType === "setting" && row.entityId && isSettingKey(row.entityId) ? labelOf(row.entityId, locale) : null,
      actor: row.actorLabel,
      before: (row.before as { value?: unknown } | null)?.value ?? row.before,
      after: (row.after as { value?: unknown } | null)?.value ?? row.after,
      reason: row.reason,
      summary: row.summary,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/** Requests this employee may decide (not their own, not expired) — for the admin bell (asked of the shell owner). */
export async function countDecidableSettingChanges(db: Db, actor: Actor, now: number = Date.now()): Promise<number | null> {
  if (!can(actor, "settings.change.approve")) return null;
  const me = actor.kind === "employee" ? actor.id : "";
  const rows = await db
    .select({ key: approvals.entityId })
    .from(approvals)
    .where(and(eq(approvals.kind, SETTINGS_APPROVAL_KIND), eq(approvals.status, "pending"), sql`${approvals.requestedBy} <> ${me}`, sql`(${approvals.expiresAt} IS NULL OR ${approvals.expiresAt} > ${now})`));
  return rows.filter((row) => row.key && isSettingKey(row.key) && can(actor, defOf(row.key as SettingKey).permission)).length;
}
