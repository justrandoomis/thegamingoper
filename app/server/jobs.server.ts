/**
 * Scheduled jobs — what the Worker's `scheduled` handler runs (docs/STATUS.md open item 3).
 *
 * CRON EXPRESSIONS — the lead adds them to wrangler.jsonc ("triggers": { "crons": [...] }) and
 * calls runScheduledJobs from workers/app.ts:
 *
 *   "*\/5 * * * *"   FREQUENT — every 5 minutes
 *       orders.expire_unpaid           bank-card / Zain Cash orders whose proof window ended
 *                                      (payment_due_at = placed + checkout.transfer_proof_hours, or
 *                                      the new window after a rejected proof) without a proof are
 *                                      cancelled: stock and used units released, coupon use freed,
 *                                      payment row cancelled, reason recorded (transitionOrder).
 *       inventory.reservations.expire  safety net: any other stock reservation past expires_at is released.
 *       outbox.deliver                 sends queued messages — only when message providers are passed in
 *                                      `env.providers`. None is configured, so it is recorded as skipped.
 *   "30 0 * * *"     DAILY — 00:30 UTC = 03:30 Asia/Baghdad
 *       audit.seal                     seals the audit hash chain. The result's `audit.headHash` must be
 *                                      LOGGED OUTSIDE THE DATABASE (Workers logs) — that is what anchors it.
 *       ratelimits.cleanup             drops rate-limit counters older than one day.
 *       retention                      deletes expired customer/staff sessions and trusted devices (30 days
 *                                      after expiry or revocation), one-time codes (7 days after expiry),
 *                                      sign-in events older than 180 days, outbox rows (sent, failed or
 *                                      held) older than 90 days, and job_runs older than 90 days except
 *                                      the latest run of each job. `consents`, audit events, ledgers and
 *                                      order history are never deleted here.
 *       consistency.daily              stock vs movements, stock vs reservations, wallet ledger vs journal,
 *                                      journal balance, order totals vs lines / payments / refunds, money
 *                                      vs postings → `consistency_findings` (one row per problem, updated
 *                                      while it persists, closed automatically when it is gone).
 *
 *   // workers/app.ts (lead)
 *   async scheduled(controller, env, ctx) {
 *     ctx.waitUntil(runScheduledJobs(getDb(), controller.cron, controller.scheduledTime, env).then((run) => {
 *       if (run.audit?.headHash) console.log(JSON.stringify({ event: "audit_seal", headHash: run.audit.headHash, lastSealedSeq: run.audit.lastSealedSeq }));
 *       if (!run.ok) console.error(JSON.stringify({ event: "scheduled_jobs_failed", cron: run.cron, jobs: run.jobs.filter((job) => job.status === "failed") }));
 *     }));
 *   }
 *
 * Every job run is a `job_runs` row (running → succeeded / failed / skipped, with its counters or
 * error), so the operations module (23.03) can show and re-run them (runJob, with ops.job.run checked
 * by the caller). A failing job never stops the others. Jobs are safe to run twice at the same time:
 * each change they make is guarded.
 *
 * Must not import "cloudflare:workers".
 */
import { and, asc, eq, exists, gt, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { newId } from "~/lib/ids";
import { systemActor } from "./actor";
import { sealAudit } from "./audit.server";
import type { BatchStatement, Db } from "./db/drizzle.server";
import { authEvents, consistencyFindings, customerSessions, employeeSessions, employeeTrustedDevices, jobRuns, orders, otpCodes, outbox, type FindingSeverity, type JobRunOrigin } from "./db/schema";
import { accountId } from "./db/seed/reference";
import { runBatch } from "./db/tx.server";
import { isAppError, toAppError } from "./errors";
import { deliverOutbox, type MessageProviders } from "./outbox.server";
import { cleanupRateLimits } from "./ratelimit.server";
import { expireReservations } from "./services/inventory/stock.server";
import { transitionOrder } from "./services/orders/manage.server";
import { purgeRecommendationEvents } from "./services/recommendations.server";
import { purgeStaleTradeInDrafts } from "./services/tradein.server";
import { getSetting } from "./settings.server";
import { kvBlobStore } from "./storage.server";

// ───────────────────────────────────────────────────────────────── schedules

export const CRON_FREQUENT = "*/5 * * * *";
export const CRON_DAILY = "30 0 * * *";

export const JOB_NAMES = [
  "orders.expire_unpaid",
  "inventory.reservations.expire",
  "outbox.deliver",
  "audit.seal",
  "ratelimits.cleanup",
  "retention",
  "consistency.daily",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Which jobs each cron expression runs, in order. */
export const SCHEDULES: Record<string, readonly JobName[]> = {
  [CRON_FREQUENT]: ["orders.expire_unpaid", "inventory.reservations.expire", "outbox.deliver"],
  [CRON_DAILY]: ["audit.seal", "ratelimits.cleanup", "retention", "consistency.daily"],
};

/** Retention windows (days). Owner-editable settings can replace these later (security.retention.manage). */
export const RETENTION_DAYS = {
  /** Customer and staff sessions, staff trusted devices: after they expired or were revoked. */
  sessions: 30,
  /** One-time codes: after they expired. */
  otpCodes: 7,
  /** Sign-in and verification log. */
  authEvents: 180,
  /** Outgoing messages that were sent, failed for good, or held for lack of a provider. */
  outbox: 90,
  /** Scheduled-job history (`job_runs`, about 900 rows a day). The latest run of each job is kept, however old. */
  jobRuns: 90,
} as const;

/**
 * What the Worker passes as `env` (its `Env` fits: extra bindings are ignored). Everything is optional and nothing
 * here reads secrets; tests pass nothing.
 */
export type ScheduledJobsEnv = {
  /** Message providers from the integrations module. None is configured today, so outbox delivery is skipped. */
  providers?: MessageProviders;
  /** The KV namespace behind the file store (uploads): used to delete abandoned trade-in draft photos. */
  KV?: KVNamespace;
};

export type JobStatus = "succeeded" | "failed" | "skipped";
export type JobOutcome = { job: JobName | "scheduler"; runId: string; status: JobStatus; stats: Record<string, unknown>; error: string | null; durationMs: number };
export type ScheduledRun = {
  cron: string;
  /** False when a job failed or the cron expression is unknown. */
  ok: boolean;
  jobs: JobOutcome[];
  /** Set when the audit chain was sealed in this run: log `headHash` outside the database. */
  audit: { headHash: string | null; lastSealedSeq: number; seals: number; events: number } | null;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type JobContext = { now: number; runId: string; env: ScheduledJobsEnv | undefined };
type JobResult = { status?: JobStatus; stats: Record<string, unknown>; error?: string | null };

// ───────────────────────────────────────────────────────────────── frequent jobs

const EXPIRE_BATCH = 50;

/** Transfer orders whose proof window ended without a proof: cancelled with everything they held released. */
async function expireUnpaidOrders(db: Db, { now }: JobContext): Promise<JobResult> {
  const hours = await getSetting(db, "checkout.transfer_proof_hours");
  const due = await db
    .select({ id: orders.id, ref: orders.ref })
    .from(orders)
    .where(
      and(
        eq(orders.status, "awaiting_payment"),
        inArray(orders.paymentMethod, ["bank_transfer", "zaincash"]),
        or(lte(orders.paymentDueAt, now), and(isNull(orders.paymentDueAt), lte(orders.placedAt, now - hours * HOUR_MS))),
      ),
    )
    .orderBy(asc(orders.placedAt), asc(orders.id))
    .limit(EXPIRE_BATCH);
  const actor = systemActor("orders.expire_unpaid");
  let cancelled = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const order of due) {
    try {
      // `from`: only an order STILL awaiting payment is cancelled. A proof that arrives after the
      // list above was read (payment_review) keeps its order — also when the cancel batch has to be
      // retried after the proof's commit (tests/commerce-adversarial.test.ts).
      await transitionOrder(db, actor, order.id, "cancelled", { reason: `payment_window_expired: no transfer proof within the ${hours} h window`, from: "awaiting_payment" }, now);
      cancelled++;
    } catch (error) {
      // Moved on meanwhile (a proof arrived, staff cancelled it): nothing to do.
      if (isAppError(error, "order_changed") || isAppError(error, "transition_not_allowed")) {
        skipped++;
        continue;
      }
      const appError = toAppError(error);
      failures.push(`${order.ref}: ${appError ? appError.message : error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { stats: { due: due.length, cancelled, skipped, failed: failures.length, more: due.length === EXPIRE_BATCH }, error: failures.length ? failures.join("; ").slice(0, 2000) : null };
}

async function expireStockReservations(db: Db, { now }: JobContext): Promise<JobResult> {
  return { stats: await expireReservations(db, now) };
}

async function deliverMessages(db: Db, { now, env }: JobContext): Promise<JobResult> {
  const providers = env?.providers;
  if (!providers || Object.values(providers).every((provider) => !provider)) return { status: "skipped", stats: { reason: "no_message_provider_configured" } };
  return { stats: await deliverOutbox(db, providers, now) };
}

// ───────────────────────────────────────────────────────────────── daily jobs

async function sealAuditChain(db: Db, { now }: JobContext): Promise<JobResult> {
  const result = await sealAudit(db, now);
  return { stats: { ...result } };
}

async function cleanupLimits(db: Db, { now }: JobContext): Promise<JobResult> {
  return { stats: { deleted: await cleanupRateLimits(db, now) } };
}

const DELETE_BATCH = 500;
const DELETE_ROUNDS = 20;

/** Deletes the rows `ids` selects, a batch at a time (keeps each statement small). */
async function deleteInRounds(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < DELETE_ROUNDS; round++) {
    const changed = await run();
    total += changed;
    if (changed < DELETE_BATCH) break;
  }
  return total;
}

const changesOf = (result: unknown): number => {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === "number" ? changes : 0;
};

async function applyRetention(db: Db, { now, env }: JobContext): Promise<JobResult> {
  const sessionCutoff = now - RETENTION_DAYS.sessions * DAY_MS;
  const ended = (expiresAt: SQL, revokedAt: SQL) => sql`(${expiresAt} < ${sessionCutoff} OR (${revokedAt} IS NOT NULL AND ${revokedAt} < ${sessionCutoff}))`;

  const customerSessionsDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(customerSessions)
        .where(inArray(customerSessions.idHash, db.select({ id: customerSessions.idHash }).from(customerSessions).where(ended(sql`${customerSessions.expiresAt}`, sql`${customerSessions.revokedAt}`)).limit(DELETE_BATCH)))
        .run(),
    ),
  );
  const employeeSessionsDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(employeeSessions)
        .where(inArray(employeeSessions.idHash, db.select({ id: employeeSessions.idHash }).from(employeeSessions).where(ended(sql`${employeeSessions.expiresAt}`, sql`${employeeSessions.revokedAt}`)).limit(DELETE_BATCH)))
        .run(),
    ),
  );
  const trustedDevicesDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(employeeTrustedDevices)
        .where(
          inArray(
            employeeTrustedDevices.id,
            db.select({ id: employeeTrustedDevices.id }).from(employeeTrustedDevices).where(ended(sql`${employeeTrustedDevices.expiresAt}`, sql`${employeeTrustedDevices.revokedAt}`)).limit(DELETE_BATCH),
          ),
        )
        .run(),
    ),
  );
  const otpDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(otpCodes)
        .where(inArray(otpCodes.id, db.select({ id: otpCodes.id }).from(otpCodes).where(lt(otpCodes.expiresAt, now - RETENTION_DAYS.otpCodes * DAY_MS)).limit(DELETE_BATCH)))
        .run(),
    ),
  );
  const authEventsDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(authEvents)
        .where(inArray(authEvents.id, db.select({ id: authEvents.id }).from(authEvents).where(lt(authEvents.at, now - RETENTION_DAYS.authEvents * DAY_MS)).limit(DELETE_BATCH)))
        .run(),
    ),
  );
  const outboxDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(outbox)
        .where(
          inArray(
            outbox.id,
            db
              .select({ id: outbox.id })
              .from(outbox)
              .where(and(lt(outbox.createdAt, now - RETENTION_DAYS.outbox * DAY_MS), ne(outbox.status, "queued")))
              .limit(DELETE_BATCH),
          ),
        )
        .run(),
    ),
  );
  // Job history: an old run goes only when a later run of the same job exists, so the operations
  // screens still show when a job that has been quiet for months last ran (and how it ended).
  const newer = alias(jobRuns, "newer");
  const laterRunExists = exists(
    db
      .select({ id: newer.id })
      .from(newer)
      .where(and(eq(newer.job, jobRuns.job), or(gt(newer.startedAt, jobRuns.startedAt), and(eq(newer.startedAt, jobRuns.startedAt), gt(newer.id, jobRuns.id))))),
  );
  const jobRunsDeleted = await deleteInRounds(async () =>
    changesOf(
      await db
        .delete(jobRuns)
        .where(
          inArray(
            jobRuns.id,
            db
              .select({ id: jobRuns.id })
              .from(jobRuns)
              .where(and(lt(jobRuns.startedAt, now - RETENTION_DAYS.jobRuns * DAY_MS), laterRunExists))
              .limit(DELETE_BATCH),
          ),
        )
        .run(),
    ),
  );
  return {
    stats: {
      customerSessions: customerSessionsDeleted,
      employeeSessions: employeeSessionsDeleted,
      trustedDevices: trustedDevicesDeleted,
      otpCodes: otpDeleted,
      authEvents: authEventsDeleted,
      outbox: outboxDeleted,
      jobRuns: jobRunsDeleted,
      ...(await purgeAreaData(db, now, env)),
      days: RETENTION_DAYS,
    },
  };
}

/**
 * Purges owned by storefront services, run after the core retention above. Each is isolated: a failure is reported
 * in the stats (and the run still succeeds), so one area's cleanup can never stop the others.
 *   recommendationEvents  consented view/add signals older than RECOMMENDATION_EVENT_RETENTION_DAYS (90)
 *   tradeInDrafts         private photos of trade-in wizards abandoned for 2 days (needs the KV file store; null
 *                         when the Worker did not pass its bindings, e.g. in tests that do not provide one)
 */
async function purgeAreaData(db: Db, now: number, env: ScheduledJobsEnv | undefined): Promise<Record<string, number | null | { error: string }>> {
  const attempt = async (run: () => Promise<number>) => {
    try {
      return await run();
    } catch (error) {
      return { error: errorText(error) };
    }
  };
  const kv = env?.KV;
  return {
    recommendationEvents: await attempt(() => purgeRecommendationEvents(db, now)),
    tradeInDrafts: kv ? await attempt(() => purgeStaleTradeInDrafts(db, kvBlobStore(kv), now)) : null,
  };
}

// ───────────────────────────────────────────────────────────────── consistency checks (23.06)

/** At most this many findings per check per run; a check that hits it does not close older findings. */
export const FINDINGS_PER_CHECK = 200;

export type ConsistencyFinding = {
  checkKey: string;
  severity: FindingSeverity;
  entityType: string | null;
  entityId: string | null;
  message: string;
  details: Record<string, unknown>;
};

type Check = { key: string; run: (db: Db) => Promise<ConsistencyFinding[]> };

const num = (value: unknown) => Number(value ?? 0);

/** Every check: name → the problems it finds right now. Exported for tests and the ops module. */
export const CONSISTENCY_CHECKS: readonly Check[] = [
  {
    // on_hand / reserved must be what the movement history adds up to.
    key: "stock.levels_vs_movements",
    run: async (db) => {
      const rows = await db.all<{ variantId: string; locationId: string; onHand: number; reserved: number; movedQty: number; movedReserved: number }>(sql`
        WITH m AS (
          SELECT variant_id, location_id, sum(qty_delta) AS qty, sum(reserved_delta) AS res FROM stock_movements GROUP BY variant_id, location_id
        )
        SELECT s.variant_id AS variantId, s.location_id AS locationId, s.on_hand AS onHand, s.reserved AS reserved, coalesce(m.qty, 0) AS movedQty, coalesce(m.res, 0) AS movedReserved
        FROM stock_levels AS s LEFT JOIN m ON m.variant_id = s.variant_id AND m.location_id = s.location_id
        WHERE s.on_hand <> coalesce(m.qty, 0) OR s.reserved <> coalesce(m.res, 0)
        UNION ALL
        SELECT m.variant_id, m.location_id, 0, 0, m.qty, m.res FROM m
        WHERE (m.qty <> 0 OR m.res <> 0) AND NOT EXISTS (SELECT 1 FROM stock_levels AS s WHERE s.variant_id = m.variant_id AND s.location_id = m.location_id)
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "stock.levels_vs_movements",
        severity: "warning",
        entityType: "stock_level",
        entityId: `${row.variantId}@${row.locationId}`,
        message: `Stock level does not match its movements: on hand ${num(row.onHand)} vs ${num(row.movedQty)}, reserved ${num(row.reserved)} vs ${num(row.movedReserved)}.`,
        details: { variantId: row.variantId, locationId: row.locationId, onHand: num(row.onHand), movedQty: num(row.movedQty), reserved: num(row.reserved), movedReserved: num(row.movedReserved) },
      }));
    },
  },
  {
    // reserved must be what the active reservations hold.
    key: "stock.reserved_vs_reservations",
    run: async (db) => {
      const rows = await db.all<{ variantId: string; locationId: string; reserved: number; held: number }>(sql`
        WITH r AS (
          SELECT variant_id, location_id, sum(qty) AS qty FROM stock_reservations WHERE status = 'active' GROUP BY variant_id, location_id
        )
        SELECT s.variant_id AS variantId, s.location_id AS locationId, s.reserved AS reserved, coalesce(r.qty, 0) AS held
        FROM stock_levels AS s LEFT JOIN r ON r.variant_id = s.variant_id AND r.location_id = s.location_id
        WHERE s.reserved <> coalesce(r.qty, 0)
        UNION ALL
        SELECT r.variant_id, r.location_id, 0, r.qty FROM r
        WHERE NOT EXISTS (SELECT 1 FROM stock_levels AS s WHERE s.variant_id = r.variant_id AND s.location_id = r.location_id)
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "stock.reserved_vs_reservations",
        severity: "warning",
        entityType: "stock_level",
        entityId: `${row.variantId}@${row.locationId}`,
        message: `Reserved quantity ${num(row.reserved)} does not match the active reservations (${num(row.held)}).`,
        details: { variantId: row.variantId, locationId: row.locationId, reserved: num(row.reserved), held: num(row.held) },
      }));
    },
  },
  {
    // The wallet ledger and the wallet liability account must agree to the dinar.
    key: "wallet.ledger_vs_journal",
    run: async (db) => {
      const [row] = await db.all<{ ledger: number; journal: number }>(sql`
        SELECT (SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger) AS ledger,
               (SELECT coalesce(sum(l.credit_iqd), 0) - coalesce(sum(l.debit_iqd), 0)
                  FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
                 WHERE l.account_id = ${accountId("wallet_liability")}) AS journal`);
      if (!row || num(row.ledger) === num(row.journal)) return [];
      return [
        {
          checkKey: "wallet.ledger_vs_journal",
          severity: "critical",
          entityType: "account",
          entityId: "wallet_liability",
          message: `Wallet ledger total ${num(row.ledger)} IQD differs from the wallet liability account (${num(row.journal)} IQD).`,
          details: { ledgerIqd: num(row.ledger), journalIqd: num(row.journal) },
        },
      ];
    },
  },
  {
    key: "wallet.negative_balance",
    run: async (db) => {
      const rows = await db.all<{ customerId: string; balance: number }>(sql`
        SELECT customer_id AS customerId, sum(amount_iqd) AS balance FROM wallet_ledger GROUP BY customer_id HAVING sum(amount_iqd) < 0 LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "wallet.negative_balance",
        severity: "critical",
        entityType: "customer",
        entityId: row.customerId,
        message: `Wallet balance is negative (${num(row.balance)} IQD).`,
        details: { balanceIqd: num(row.balance) },
      }));
    },
  },
  {
    key: "journal.unbalanced_entries",
    run: async (db) => {
      const rows = await db.all<{ entryId: string; debit: number; credit: number }>(sql`
        SELECT e.id AS entryId, coalesce(sum(l.debit_iqd), 0) AS debit, coalesce(sum(l.credit_iqd), 0) AS credit
        FROM journal_entries AS e LEFT JOIN journal_lines AS l ON l.entry_id = e.id
        GROUP BY e.id HAVING coalesce(sum(l.debit_iqd), 0) <> coalesce(sum(l.credit_iqd), 0) OR count(l.id) < 2
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "journal.unbalanced_entries",
        severity: "critical",
        entityType: "journal_entry",
        entityId: row.entryId,
        message: `Journal entry does not balance: debit ${num(row.debit)} vs credit ${num(row.credit)}.`,
        details: { debitIqd: num(row.debit), creditIqd: num(row.credit) },
      }));
    },
  },
  {
    key: "journal.orphan_lines",
    run: async (db) => {
      const rows = await db.all<{ entryId: string; lines: number }>(sql`
        SELECT l.entry_id AS entryId, count(*) AS lines FROM journal_lines AS l
        WHERE NOT EXISTS (SELECT 1 FROM journal_entries AS e WHERE e.id = l.entry_id)
        GROUP BY l.entry_id LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "journal.orphan_lines",
        severity: "warning",
        entityType: "journal_entry",
        entityId: row.entryId,
        message: `${num(row.lines)} journal line(s) without an entry header (not part of the books).`,
        details: { lines: num(row.lines) },
      }));
    },
  },
  {
    // The order's subtotal is the sum of its lines.
    key: "orders.totals_vs_items",
    run: async (db) => {
      const rows = await db.all<{ orderId: string; ref: string; subtotal: number; items: number }>(sql`
        SELECT o.id AS orderId, o.ref AS ref, o.subtotal_iqd AS subtotal, coalesce(i.total, 0) AS items
        FROM orders AS o LEFT JOIN (SELECT order_id, sum(total_iqd) AS total FROM order_items GROUP BY order_id) AS i ON i.order_id = o.id
        WHERE o.subtotal_iqd <> coalesce(i.total, 0)
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "orders.totals_vs_items",
        severity: "critical",
        entityType: "order",
        entityId: row.orderId,
        message: `Order ${row.ref}: subtotal ${num(row.subtotal)} IQD but its lines add up to ${num(row.items)} IQD.`,
        details: { ref: row.ref, subtotalIqd: num(row.subtotal), linesIqd: num(row.items) },
      }));
    },
  },
  {
    // paid_iqd mirrors the paid payments; refunded_iqd mirrors the paid refunds.
    key: "orders.paid_vs_payments",
    run: async (db) => {
      const rows = await db.all<{ orderId: string; ref: string; paid: number; payments: number; refunded: number; refunds: number }>(sql`
        SELECT o.id AS orderId, o.ref AS ref, o.paid_iqd AS paid, coalesce(p.total, 0) AS payments, o.refunded_iqd AS refunded, coalesce(r.total, 0) AS refunds
        FROM orders AS o
        LEFT JOIN (SELECT order_id, sum(amount_iqd) AS total FROM payments WHERE status = 'paid' GROUP BY order_id) AS p ON p.order_id = o.id
        LEFT JOIN (SELECT order_id, sum(amount_iqd) AS total FROM refunds WHERE status = 'paid' GROUP BY order_id) AS r ON r.order_id = o.id
        WHERE o.paid_iqd <> coalesce(p.total, 0) OR o.refunded_iqd <> coalesce(r.total, 0)
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "orders.paid_vs_payments",
        severity: "critical",
        entityType: "order",
        entityId: row.orderId,
        message: `Order ${row.ref}: paid ${num(row.paid)} vs payments ${num(row.payments)}, refunded ${num(row.refunded)} vs refunds ${num(row.refunds)} (IQD).`,
        details: { ref: row.ref, paidIqd: num(row.paid), paymentsIqd: num(row.payments), refundedIqd: num(row.refunded), refundsIqd: num(row.refunds) },
      }));
    },
  },
  {
    // Every paid payment, issued refund and recognised sale is in the books exactly once.
    key: "money.missing_postings",
    run: async (db) => {
      const rows = await db.all<{ kind: string; id: string; amount: number }>(sql`
        SELECT 'payment' AS kind, p.id AS id, p.amount_iqd AS amount FROM payments AS p
        WHERE p.status = 'paid' AND p.amount_iqd > 0
          AND NOT EXISTS (SELECT 1 FROM journal_entries AS e WHERE e.idempotency_key = 'payment:' || p.id || ':received')
        UNION ALL
        SELECT 'refund', r.id, r.amount_iqd FROM refunds AS r
        WHERE r.status = 'paid'
          AND NOT EXISTS (SELECT 1 FROM journal_entries AS e WHERE e.idempotency_key = 'refund:' || r.id)
        UNION ALL
        SELECT 'order', o.id, o.total_iqd FROM orders AS o
        WHERE o.delivered_at IS NOT NULL AND o.total_iqd > 0
          AND NOT EXISTS (SELECT 1 FROM journal_entries AS e WHERE e.idempotency_key = 'order:' || o.id || ':sale')
        LIMIT ${FINDINGS_PER_CHECK + 1}`);
      return rows.map((row) => ({
        checkKey: "money.missing_postings",
        severity: "critical",
        entityType: row.kind,
        entityId: row.id,
        message: row.kind === "order" ? `Delivered order has no revenue posting (${num(row.amount)} IQD).` : `Paid ${row.kind} of ${num(row.amount)} IQD has no journal entry.`,
        details: { amountIqd: num(row.amount) },
      }));
    },
  },
];

const fingerprintOf = (finding: ConsistencyFinding) => `${finding.checkKey}|${finding.entityType ?? ""}|${finding.entityId ?? ""}`;

/** Runs every check, records what it finds and closes findings that are gone. */
async function runConsistencyChecks(db: Db, { now, runId }: JobContext): Promise<JobResult> {
  const perCheck: Record<string, number> = {};
  let recorded = 0;
  let resolved = 0;
  const failures: string[] = [];
  for (const check of CONSISTENCY_CHECKS) {
    let found: ConsistencyFinding[];
    try {
      found = await check.run(db);
    } catch (error) {
      failures.push(`${check.key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const complete = found.length <= FINDINGS_PER_CHECK;
    const findings = found.slice(0, FINDINGS_PER_CHECK);
    perCheck[check.key] = findings.length;
    const statements: BatchStatement[] = findings.map((finding) =>
      db
        .insert(consistencyFindings)
        .values({
          id: newId("cfd"),
          fingerprint: fingerprintOf(finding),
          checkKey: finding.checkKey,
          severity: finding.severity,
          entityType: finding.entityType,
          entityId: finding.entityId,
          message: finding.message,
          details: finding.details,
          status: "open",
          occurrences: 1,
          detectedAt: now,
          lastSeenAt: now,
          runId,
        })
        .onConflictDoUpdate({
          target: consistencyFindings.fingerprint,
          set: {
            severity: finding.severity,
            message: finding.message,
            details: finding.details,
            lastSeenAt: now,
            runId,
            occurrences: sql`${consistencyFindings.occurrences} + 1`,
            // A problem that comes back after being resolved is open again; acknowledged / false positive stay as decided.
            status: sql`CASE WHEN ${consistencyFindings.status} = 'resolved' THEN 'open' ELSE ${consistencyFindings.status} END`,
            resolvedAt: sql`CASE WHEN ${consistencyFindings.status} = 'resolved' THEN NULL ELSE ${consistencyFindings.resolvedAt} END`,
            resolvedBy: sql`CASE WHEN ${consistencyFindings.status} = 'resolved' THEN NULL ELSE ${consistencyFindings.resolvedBy} END`,
          },
        }),
    );
    for (let i = 0; i < statements.length; i += 50) await runBatch(db, statements.slice(i, i + 50));
    recorded += findings.length;
    if (complete) {
      // Gone since the last run: close it (only when this run saw every problem of the check).
      const closed = await db
        .update(consistencyFindings)
        .set({ status: "resolved", resolvedBy: "system:consistency.daily", resolvedAt: now, resolutionNote: "No longer detected by the daily check." })
        .where(
          and(
            eq(consistencyFindings.checkKey, check.key),
            inArray(consistencyFindings.status, ["open", "acknowledged"]),
            or(isNull(consistencyFindings.runId), ne(consistencyFindings.runId, runId)),
          ),
        )
        .run();
      resolved += changesOf(closed);
    }
  }
  return { stats: { findings: perCheck, recorded, resolved, failedChecks: failures.length }, error: failures.length ? failures.join("; ").slice(0, 2000) : null };
}

/** The open findings, worst first (for the ops / finance screens; the caller checks ops.consistency.read). */
export async function listOpenFindings(db: Db, limit = 100) {
  return db
    .select()
    .from(consistencyFindings)
    .where(inArray(consistencyFindings.status, ["open", "acknowledged"]))
    .orderBy(sql`CASE ${consistencyFindings.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, sql`${consistencyFindings.lastSeenAt} DESC`)
    .limit(Math.min(Math.max(limit, 1), 500));
}

// ───────────────────────────────────────────────────────────────── runner

const JOBS: Record<JobName, (db: Db, ctx: JobContext) => Promise<JobResult>> = {
  "orders.expire_unpaid": expireUnpaidOrders,
  "inventory.reservations.expire": expireStockReservations,
  "outbox.deliver": deliverMessages,
  "audit.seal": sealAuditChain,
  "ratelimits.cleanup": cleanupLimits,
  retention: applyRetention,
  "consistency.daily": runConsistencyChecks,
};

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 2000);
}

/**
 * Runs one job and records it in `job_runs`. Never throws for a failing job (the failure is the
 * outcome); throws only when the run itself cannot be recorded (database unreachable).
 */
export async function runJob(db: Db, job: JobName, now: number, options: { origin?: JobRunOrigin; triggeredBy?: string | null; env?: ScheduledJobsEnv } = {}): Promise<JobOutcome> {
  const runId = newId("job");
  const started = Date.now();
  await db.insert(jobRuns).values({ id: runId, job, status: "running", origin: options.origin ?? "cron", startedAt: now, triggeredBy: options.triggeredBy ?? null });
  let status: JobStatus;
  let stats: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const result = await JOBS[job](db, { now, runId, env: options.env });
    stats = result.stats;
    error = result.error ?? null;
    status = result.status ?? (error ? "failed" : "succeeded");
  } catch (caught) {
    status = "failed";
    error = errorText(caught);
  }
  const durationMs = Math.max(0, Date.now() - started);
  await db.update(jobRuns).set({ status, finishedAt: now + durationMs, durationMs, stats, error }).where(eq(jobRuns.id, runId));
  return { job, runId, status, stats, error, durationMs };
}

/**
 * The scheduled handler's entry point: runs the jobs of `cron` (SCHEDULES) one after the other.
 * An unknown cron expression runs nothing and is recorded as a skipped "scheduler" run, so a
 * misconfigured trigger is visible in job_runs.
 */
export async function runScheduledJobs(db: Db, cron: string, now: number, env?: ScheduledJobsEnv): Promise<ScheduledRun> {
  const jobs = SCHEDULES[cron];
  if (!jobs) {
    const runId = newId("job");
    const error = `Unknown cron expression "${cron}". Expected one of: ${Object.keys(SCHEDULES).join(", ")}`;
    await db.insert(jobRuns).values({ id: runId, job: "scheduler", status: "skipped", origin: "cron", startedAt: now, finishedAt: now, durationMs: 0, stats: { cron }, error });
    return { cron, ok: false, jobs: [{ job: "scheduler", runId, status: "skipped", stats: { cron }, error, durationMs: 0 }], audit: null };
  }
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) outcomes.push(await runJob(db, job, now, { origin: "cron", env }));
  const seal = outcomes.find((outcome) => outcome.job === "audit.seal" && outcome.status === "succeeded");
  return {
    cron,
    ok: outcomes.every((outcome) => outcome.status !== "failed"),
    jobs: outcomes,
    audit: seal
      ? { headHash: (seal.stats.headHash as string | null) ?? null, lastSealedSeq: Number(seal.stats.lastSealedSeq ?? 0), seals: Number(seal.stats.seals ?? 0), events: Number(seal.stats.events ?? 0) }
      : null,
  };
}

/** Latest runs of a job (for the ops screens; the caller checks ops.job.read). */
export async function listJobRuns(db: Db, job?: JobName | "scheduler", limit = 50) {
  const query = db.select().from(jobRuns);
  return (job ? query.where(eq(jobRuns.job, job)) : query).orderBy(sql`${jobRuns.startedAt} DESC`, sql`${jobRuns.id} DESC`).limit(Math.min(Math.max(limit, 1), 200));
}

