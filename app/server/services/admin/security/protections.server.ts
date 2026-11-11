/**
 * Admin 20.04 and 20.06 — what protects stored secrets, and what keeps a payment or a webhook from counting twice.
 *
 * ENCRYPTION (security.audit.verify): which kinds of data are encrypted, hashed or stored plainly on purpose, with live
 * counts, and a self-test of DATA_KEY — a probe is sealed and opened again, and each stored authenticator secret is
 * opened in memory to count how many the current key can still read (after a key change they cannot). No secret value,
 * no key and no plaintext ever leaves this function: only booleans and counts.
 *
 * DUPLICATES (security.fraud.review): the database rules that make orders, payments, refunds, wallet entries and
 * postings idempotent — each one checked live in the schema (the unique index must exist) — the transfer proofs that
 * were flagged as copies of an earlier one (same picture or reference), and the inbound webhook log, which no provider
 * writes to yet (no payment gateway or courier is connected: a boundary, not a feature).
 */
import { desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { assertCan, type Actor } from "~/server/actor";
import { decryptSecret, encryptSecret, fromBase64, PASSWORD_ITERATIONS } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { employees, inboundEvents, orders, paymentProofs, payments } from "~/server/db/schema";

export type EncryptionStatus = {
  dataKey: { configured: boolean; validLength: boolean; selfTest: boolean };
  totp: { enabled: number; stored: number; readable: number; unreadable: number };
  digitalCodes: { total: number; byStatus: Record<string, number> };
  giftCardCodes: number;
  integrations: { total: number; withSecret: number; webhooks: number };
  passwords: { set: number; iterations: number; weaker: number };
  sessions: { staff: number; customers: number };
};

async function keyWorks(dataKey: string | undefined): Promise<{ configured: boolean; validLength: boolean; selfTest: boolean }> {
  const configured = typeof dataKey === "string" && dataKey.trim() !== "";
  if (!configured) return { configured, validLength: false, selfTest: false };
  let validLength = false;
  try {
    validLength = fromBase64(dataKey).byteLength === 32;
  } catch {
    validLength = false;
  }
  try {
    const probe = `probe-${Date.now()}`;
    const sealed = await encryptSecret(probe, dataKey, "security:self-test");
    return { configured, validLength, selfTest: (await decryptSecret(sealed, dataKey, "security:self-test")) === probe };
  } catch {
    return { configured, validLength, selfTest: false };
  }
}

export async function encryptionStatus(db: Db, actor: Actor, secrets: { DATA_KEY?: string }): Promise<EncryptionStatus> {
  assertCan(actor, "security.audit.verify");
  const [dataKey, totpRows, codeRows, gift, integrationRows, webhookRows, passwordRows, sessionRows] = await Promise.all([
    keyWorks(secrets.DATA_KEY),
    db.select({ id: employees.id, enabled: employees.totpEnabled, secret: employees.totpSecretEnc }).from(employees).where(isNotNull(employees.totpSecretEnc)),
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM digital_codes GROUP BY status`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM gift_cards WHERE code_enc IS NOT NULL`),
    db.all<{ total: number; withSecret: number }>(sql`SELECT count(*) AS total, coalesce(sum(CASE WHEN secret_enc IS NOT NULL THEN 1 ELSE 0 END), 0) AS withSecret FROM integrations`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM webhooks`),
    db.all<{ set: number; weaker: number }>(sql`SELECT coalesce(sum(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS "set", coalesce(sum(CASE WHEN password_hash IS NOT NULL AND coalesce(password_iters, 0) < ${PASSWORD_ITERATIONS} THEN 1 ELSE 0 END), 0) AS weaker FROM employees`),
    db.all<{ staff: number; customers: number }>(sql`SELECT (SELECT count(*) FROM employee_sessions WHERE revoked_at IS NULL) AS staff, (SELECT count(*) FROM customer_sessions WHERE revoked_at IS NULL) AS customers`),
  ]);
  let readable = 0;
  if (dataKey.selfTest) {
    for (const row of totpRows) {
      try {
        // opened in memory only, to count; the value is dropped at once
        await decryptSecret(row.secret as string, secrets.DATA_KEY, `employee:${row.id}:totp`);
        readable++;
      } catch {
        /* unreadable with this key */
      }
    }
  }
  const byStatus: Record<string, number> = {};
  for (const row of codeRows) byStatus[row.status] = Number(row.n);
  return {
    dataKey,
    totp: { enabled: totpRows.filter((row) => row.enabled).length, stored: totpRows.length, readable, unreadable: totpRows.length - readable },
    digitalCodes: { total: codeRows.reduce((sum, row) => sum + Number(row.n), 0), byStatus },
    giftCardCodes: Number(gift[0]?.n ?? 0),
    integrations: { total: Number(integrationRows[0]?.total ?? 0), withSecret: Number(integrationRows[0]?.withSecret ?? 0), webhooks: Number(webhookRows[0]?.n ?? 0) },
    passwords: { set: Number(passwordRows[0]?.set ?? 0), iterations: PASSWORD_ITERATIONS, weaker: Number(passwordRows[0]?.weaker ?? 0) },
    sessions: { staff: Number(sessionRows[0]?.staff ?? 0), customers: Number(sessionRows[0]?.customers ?? 0) },
  };
}

/** The idempotency rules the database holds, by the unique index (or key) that enforces each. */
export const IDEMPOTENCY_RULES = [
  { key: "orders", index: "orders_idempotency_key_uq" },
  { key: "payments", index: "payments_idempotency_key_uq" },
  { key: "refunds", index: "refunds_idempotency_key_uq" },
  { key: "wallet", index: "wallet_ledger_idempotency_key_uq" },
  { key: "topups", index: "wallet_topups_idempotency_key_uq" },
  { key: "journal", index: "journal_entries_idempotency_key_uq" },
  { key: "cash", index: "cash_movements_idempotency_key_uq" },
  { key: "messages", index: "outbox_dedupe_key_uq" },
  { key: "statements", index: "statement_lines_dedupe_uq" },
  { key: "webhookDeliveries", index: "webhook_deliveries_event_uq" },
] as const;

export type DuplicateProof = { proofId: string; orderRef: string | null; declaredAmountIqd: number; status: string; createdAt: number; reason: "same_picture" | "same_reference"; firstOrderRef: string | null; firstAt: number | null };

export type DuplicatesView = {
  rules: { key: (typeof IDEMPOTENCY_RULES)[number]["key"]; index: string; present: boolean }[];
  /** inbound_events.id is "<provider>:<event id>" (its primary key): a re-delivered event is refused. */
  inboundKey: boolean;
  proofs: { flagged: number; recent: DuplicateProof[] };
  topups: { samePicture: number; sameReference: number };
  inbound: { total: number; byStatus: Record<string, number>; recent: { id: string; provider: string; eventType: string | null; status: string; receivedAt: number }[] };
};

export async function duplicatesView(db: Db, actor: Actor): Promise<DuplicatesView> {
  assertCan(actor, "security.fraud.review");
  const names = IDEMPOTENCY_RULES.map((rule) => rule.index);
  const [indexes, inboundTable, flagged, topups, inboundRows, inboundStatus] = await Promise.all([
    db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (SELECT value FROM json_each(${JSON.stringify(names)}))`),
    db.all<{ pk: number }>(sql`SELECT pk FROM pragma_table_info('inbound_events') WHERE name = 'id'`),
    db
      .select({ id: paymentProofs.id, paymentId: paymentProofs.paymentId, declared: paymentProofs.declaredAmountIqd, status: paymentProofs.status, createdAt: paymentProofs.createdAt, duplicateOf: paymentProofs.duplicateOf, sha256: paymentProofs.sha256, reference: paymentProofs.reference })
      .from(paymentProofs)
      .where(isNotNull(paymentProofs.duplicateOf))
      .orderBy(desc(paymentProofs.createdAt))
      .limit(20),
    db.all<{ samePicture: number; sameReference: number }>(sql`
      SELECT
        (SELECT count(*) FROM wallet_topups t WHERE t.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM wallet_topups o WHERE o.sha256 = t.sha256 AND o.id <> t.id)) AS samePicture,
        (SELECT count(*) FROM wallet_topups t WHERE t.reference IS NOT NULL AND EXISTS (SELECT 1 FROM wallet_topups o WHERE o.reference = t.reference AND o.id <> t.id)) AS sameReference`),
    db.select({ id: inboundEvents.id, provider: inboundEvents.provider, eventType: inboundEvents.eventType, status: inboundEvents.status, receivedAt: inboundEvents.receivedAt }).from(inboundEvents).orderBy(desc(inboundEvents.receivedAt)).limit(10),
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM inbound_events GROUP BY status`),
  ]);
  const count = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM payment_proofs WHERE duplicate_of IS NOT NULL`);
  // the orders of the flagged proofs and of the proofs they copy
  const firstIds = flagged.map((row) => row.duplicateOf).filter((id): id is string => Boolean(id));
  const firsts = firstIds.length ? await db.select({ id: paymentProofs.id, paymentId: paymentProofs.paymentId, createdAt: paymentProofs.createdAt, sha256: paymentProofs.sha256 }).from(paymentProofs).where(inArray(paymentProofs.id, firstIds)) : [];
  const paymentIds = [...new Set([...flagged.map((row) => row.paymentId), ...firsts.map((row) => row.paymentId)])];
  const refs = paymentIds.length ? await db.select({ paymentId: payments.id, ref: orders.ref }).from(payments).innerJoin(orders, eq(orders.id, payments.orderId)).where(inArray(payments.id, paymentIds)) : [];
  const refOf = new Map(refs.map((row) => [row.paymentId, row.ref]));
  const present = new Set(indexes.map((row) => row.name));
  const byStatus: Record<string, number> = {};
  for (const row of inboundStatus) byStatus[row.status] = Number(row.n);
  return {
    rules: IDEMPOTENCY_RULES.map((rule) => ({ key: rule.key, index: rule.index, present: present.has(rule.index) })),
    inboundKey: Number(inboundTable[0]?.pk ?? 0) === 1,
    proofs: {
      flagged: Number(count[0]?.n ?? 0),
      recent: flagged.map((row) => {
        const first = firsts.find((entry) => entry.id === row.duplicateOf);
        return {
          proofId: row.id,
          orderRef: refOf.get(row.paymentId) ?? null,
          declaredAmountIqd: row.declared,
          status: row.status,
          createdAt: row.createdAt,
          reason: first && first.sha256 === row.sha256 ? "same_picture" : "same_reference",
          firstOrderRef: first ? (refOf.get(first.paymentId) ?? null) : null,
          firstAt: first?.createdAt ?? null,
        };
      }),
    },
    topups: { samePicture: Number(topups[0]?.samePicture ?? 0), sameReference: Number(topups[0]?.sameReference ?? 0) },
    inbound: { total: Object.values(byStatus).reduce((sum, n) => sum + n, 0), byStatus, recent: inboundRows },
  };
}
