/**
 * Admin 22.04 — message templates and uploaded files.
 *
 * TEMPLATES (settings.read to see, settings.template.manage to change): the texts of the messages the code queues
 * (catalog.ts TEMPLATE_CATALOG: order statuses, payment decisions, pre-order dates, sign-in codes), per language, in
 * `message_templates` (key, channel, locale). A body may use only its message's {variables} (anything else is refused),
 * must keep the ones the message needs ({code} for a sign-in code), and stays within one long SMS. BOUNDARY, said on
 * the page: no SMS/WhatsApp/e-mail provider is connected, so every message is HELD in the outbox (counted here per
 * template) and no template is sent yet — the provider integration (module 21) will read these rows. Printed invoices
 * and slips are module 05's documents and keep their own layout.
 *
 * FILES (settings.file.manage): what is stored (counts and sizes by kind and visibility), the newest uploads (kind,
 * size, who, when — never a private file's bytes or link here; each module serves its own private files after its own
 * permission check) and uploads that nothing refers to any more.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { files, messageTemplates } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { TEMPLATE_CATALOG, TEMPLATE_LOCALES, TEMPLATE_MAX_LENGTH, templateVariables, type TemplateLocale } from "./catalog";

export type TemplateRow = {
  key: string;
  channel: string;
  variables: readonly string[];
  required: readonly string[];
  /** Messages queued with this template in the last 30 days, by outbox status (all "held" while no provider exists). */
  queued: { held: number; sent: number; failed: number };
  texts: Record<TemplateLocale, { body: string; isActive: boolean; updatedAt: number; updatedBy: string | null } | null>;
};

export async function listTemplates(db: Db, actor: Actor, now: number): Promise<{ rows: TemplateRow[]; canManage: boolean }> {
  assertCan(actor, "settings.read");
  const [stored, queued] = await Promise.all([
    db.select().from(messageTemplates),
    db.all<{ template: string; status: string; n: number }>(sql`SELECT template, status, count(*) AS n FROM outbox WHERE created_at > ${now - 30 * 86_400_000} GROUP BY template, status`),
  ]);
  const rows = TEMPLATE_CATALOG.map((entry) => {
    const texts = {} as TemplateRow["texts"];
    for (const locale of TEMPLATE_LOCALES) {
      const row = stored.find((item) => item.key === entry.key && item.channel === entry.channel && item.locale === locale);
      texts[locale] = row ? { body: row.body, isActive: row.isActive, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
    }
    const count = (status: string) => Number(queued.find((item) => item.template === entry.key && item.status === status)?.n ?? 0);
    return { key: entry.key, channel: entry.channel, variables: entry.variables, required: entry.required, queued: { held: count("held"), sent: count("sent"), failed: count("failed") }, texts };
  });
  return { rows, canManage: can(actor, "settings.template.manage") };
}

export async function getTemplate(db: Db, actor: Actor, key: string, now: number): Promise<TemplateRow & { versions: Record<TemplateLocale, number | null> }> {
  const { rows } = await listTemplates(db, actor, now);
  const row = rows.find((entry) => entry.key === key);
  if (!row) throw notFound("template");
  const versions = {} as Record<TemplateLocale, number | null>;
  for (const locale of TEMPLATE_LOCALES) versions[locale] = row.texts[locale]?.updatedAt ?? null;
  return { ...row, versions };
}

const SaveInput = z.object({
  key: z.string(),
  locale: z.enum(TEMPLATE_LOCALES, { error: "invalid" }),
  body: z.string({ error: "required" }).trim().min(2, "required").max(TEMPLATE_MAX_LENGTH, "too_long"),
  isActive: z.boolean(),
  /** updated_at of the row the form was built on (null: there was none). */
  version: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : Number(value)), z.number().int().nullable()),
  reason: z.string().trim().max(500, "too_long").optional(),
});

/** Saves one language of a template, checked against the message's variables. */
export async function saveTemplate(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ created: boolean }> {
  assertCan(actor, "settings.template.manage");
  const input = SaveInput.parse(raw);
  const entry = TEMPLATE_CATALOG.find((item) => item.key === input.key);
  if (!entry) throw notFound("template");
  const used = templateVariables(input.body);
  const unknown = used.filter((name) => !(entry.variables as readonly string[]).includes(name));
  if (unknown.length > 0) throw new AppError("template_variable_unknown", 400, { fields: { body: "template_variable_unknown" }, detail: unknown.join(", ") });
  const missing = entry.required.filter((name) => !used.includes(name));
  if (missing.length > 0) throw new AppError("template_variable_missing", 400, { fields: { body: "template_variable_missing" }, detail: missing.join(", ") });
  const existing = await db.select().from(messageTemplates).where(and(eq(messageTemplates.key, entry.key), eq(messageTemplates.channel, entry.channel), eq(messageTemplates.locale, input.locale))).get();
  if ((existing?.updatedAt ?? null) !== input.version) throw new AppError("template_changed", 409);
  const updatedBy = actor.kind === "employee" ? actor.id : null;
  const audit = auditStatement(db, { actor, action: "settings.template.save", entityType: "template", entityId: `${entry.key}:${input.locale}`, before: existing ? { body: existing.body, isActive: existing.isActive } : null, after: { body: input.body, isActive: input.isActive }, reason: input.reason || null, at: now });
  try {
    if (!existing) {
      await runBatch(db, [db.insert(messageTemplates).values({ id: newId("tpl"), key: entry.key, channel: entry.channel, locale: input.locale, body: input.body, variables: [...entry.variables], isActive: input.isActive, updatedBy, updatedAt: now }), audit]);
      return { created: true };
    }
    if (existing.body === input.body && existing.isActive === input.isActive) throw invalid({ body: "no_change" });
    await runBatch(db, [
      db
        .update(messageTemplates)
        .set({ body: input.body, isActive: input.isActive, variables: [...entry.variables], updatedBy, updatedAt: now })
        .where(and(eq(messageTemplates.id, existing.id), eq(messageTemplates.updatedAt, existing.updatedAt))),
      expectChanged(db, 1, { code: "TEMPLATE_CHANGED", detail: existing.id }),
      audit,
    ]);
  } catch (error) {
    const info = mapDbError(error);
    if (info?.code === "TEMPLATE_CHANGED" || info?.kind === "unique") throw new AppError("template_changed", 409);
    throw error;
  }
  return { created: false };
}

// ───────────────────────────────────────────────────────────────── files

export type FilesView = {
  byKind: { kind: string; visibility: string; files: number; bytes: number; deleted: number }[];
  total: { files: number; bytes: number };
  recent: { id: string; kind: string; visibility: string; mime: string; bytes: number; width: number | null; height: number | null; createdAt: number; createdByKind: string | null; deleted: boolean }[];
  /** Uploads of a kind that nothing refers to (a proof without its proof row, a product photo no gallery uses). */
  unreferenced: { kind: string; files: number; bytes: number }[];
};

export async function filesView(db: Db, actor: Actor): Promise<FilesView> {
  assertCan(actor, "settings.file.manage");
  const [byKind, recent, unreferenced] = await Promise.all([
    db.all<{ kind: string; visibility: string; files: number; bytes: number; deleted: number }>(sql`
      SELECT kind, visibility, count(*) AS files, coalesce(sum(bytes), 0) AS bytes, coalesce(sum(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted
      FROM files GROUP BY kind, visibility ORDER BY files DESC`),
    db
      .select({ id: files.id, kind: files.kind, visibility: files.visibility, mime: files.mime, bytes: files.bytes, width: files.width, height: files.height, createdAt: files.createdAt, createdByKind: files.createdByKind, deletedAt: files.deletedAt })
      .from(files)
      .orderBy(desc(files.createdAt))
      .limit(30),
    db.all<{ kind: string; files: number; bytes: number }>(sql`
      SELECT kind, count(*) AS files, coalesce(sum(bytes), 0) AS bytes FROM files f
      WHERE f.deleted_at IS NULL AND (
        (f.kind = 'payment_proof' AND NOT EXISTS (SELECT 1 FROM payment_proofs p WHERE p.file_id = f.id))
        OR (f.kind = 'wallet_topup_proof' AND NOT EXISTS (SELECT 1 FROM wallet_topups w WHERE w.proof_file_id = f.id))
        OR (f.kind = 'product_image' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.file_id = f.id))
      ) GROUP BY kind`),
  ]);
  return {
    byKind: byKind.map((row) => ({ kind: row.kind, visibility: row.visibility, files: Number(row.files), bytes: Number(row.bytes), deleted: Number(row.deleted) })),
    total: { files: byKind.reduce((sum, row) => sum + Number(row.files), 0), bytes: byKind.reduce((sum, row) => sum + Number(row.bytes), 0) },
    recent: recent.map((row) => ({ id: row.id, kind: row.kind, visibility: row.visibility, mime: row.mime, bytes: row.bytes, width: row.width, height: row.height, createdAt: row.createdAt, createdByKind: row.createdByKind, deleted: row.deletedAt !== null })),
    unreferenced: unreferenced.map((row) => ({ kind: row.kind, files: Number(row.files), bytes: Number(row.bytes) })),
  };
}
