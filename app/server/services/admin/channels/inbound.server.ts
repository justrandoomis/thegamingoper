/**
 * 21.04 / acceptance "receiving a webhook again does not duplicate the order or the financial entry" — the one way a
 * provider's event is taken in, for the payment and courier connections to come (none is connected today, so nothing
 * calls this from a route yet).
 *
 *   acceptInboundEvent(db, { provider, eventId, eventType, payload, signatureOk }, effects, now)
 *       → { status: "processed" | "replayed" | "refused" }
 *
 * The event's row ("<provider>:<event id>", the primary key of inbound_events) is inserted IN THE SAME BATCH as its
 * effects (an order's payment, a journal entry): the first delivery stores both; a repeat — the provider retrying,
 * two deliveries at once — meets the primary key, the whole batch rolls back and nothing is done twice ("replayed").
 * An event whose signature did not verify is recorded as "failed" with no effect at all ("refused"), so a forged
 * event can neither act nor block the real one with the same id. Payloads are stored as received for the audit of
 * what a provider said; staff screens show them only to who manages integrations.
 *
 *   inboundHealth(db) — counts by status and the latest failures (never the payload), for the monitor.
 *
 * Must not import "cloudflare:workers".
 */
import { desc, eq, sql } from "drizzle-orm";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { inboundEvents } from "~/server/db/schema";
import { isUniqueViolation, runBatch } from "~/server/db/tx.server";

export type InboundEventInput = {
  /** The provider's key ("zaincash", "carrier:<id>"). */
  provider: string;
  /** The provider's own id for the event. */
  eventId: string;
  eventType?: string | null;
  payload?: Record<string, unknown> | null;
  /** Checked by the caller against the provider's signing secret BEFORE this is called. */
  signatureOk: boolean;
};

const PROVIDER = /^[a-z0-9_:.-]{1,80}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function inboundEventId(provider: string, eventId: string): string {
  if (!PROVIDER.test(provider) || !EVENT_ID.test(eventId)) throw new Error("inbound event: provider or event id is not well-formed");
  return `${provider}:${eventId}`;
}

export async function acceptInboundEvent(db: Db, input: InboundEventInput, effects: readonly BatchStatement[], now: number): Promise<{ status: "processed" | "replayed" | "refused"; id: string }> {
  const id = inboundEventId(input.provider, input.eventId);
  if (!input.signatureOk) {
    // a forged or broken event: kept for the record under its own id, never acting, never taking the real event's id
    const refusedId = `${id}#unsigned:${now}`;
    await db
      .insert(inboundEvents)
      .values({ id: refusedId.slice(0, 250), provider: input.provider, eventType: input.eventType ?? null, payload: input.payload ?? null, signatureOk: false, status: "failed", error: "signature_invalid", receivedAt: now, processedAt: now })
      .onConflictDoNothing();
    return { status: "refused", id };
  }
  try {
    await runBatch(db, [db.insert(inboundEvents).values({ id, provider: input.provider, eventType: input.eventType ?? null, payload: input.payload ?? null, signatureOk: true, status: "processed", receivedAt: now, processedAt: now }), ...effects]);
    return { status: "processed", id };
  } catch (error) {
    if (isUniqueViolation(error, "inbound_events.id")) return { status: "replayed", id };
    throw error;
  }
}

export async function inboundHealth(db: Db): Promise<{ counts: Record<string, number>; failures: { id: string; provider: string; eventType: string | null; error: string | null; receivedAt: number }[] }> {
  const [rows, failures] = await Promise.all([
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM inbound_events GROUP BY status`),
    db
      .select({ id: inboundEvents.id, provider: inboundEvents.provider, eventType: inboundEvents.eventType, error: inboundEvents.error, receivedAt: inboundEvents.receivedAt })
      .from(inboundEvents)
      .where(eq(inboundEvents.status, "failed"))
      .orderBy(desc(inboundEvents.receivedAt))
      .limit(10),
  ]);
  const counts: Record<string, number> = { received: 0, processed: 0, ignored: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.n);
  return { counts, failures };
}
