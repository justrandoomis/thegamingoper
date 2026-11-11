/**
 * Outgoing messages (SMS, WhatsApp, email, push) — the boundary to delivery providers.
 *
 * NO PROVIDER IS CONFIGURED. There is no SMS gateway, WhatsApp Business account or mail service
 * connected to this project, so every message is stored with status `held`: written down, visible
 * to staff as "not sent", and never reported as delivered. Nothing here pretends otherwise.
 *
 *   await db.batch([ …the change…, outboxStatement(db, { channel: "sms", recipient: phone, template: "order_confirmed", payload: { ref }, now }) ]);
 *
 * Connecting a provider later means implementing `MessageProvider` for a channel and passing it in
 * `providers` (from the integrations module, with credentials from Worker secrets): the same calls
 * then store `queued`, `deliverOutbox()` sends them and records `sent` / `failed` with retries.
 *
 * One-time codes are special: the code must never rest in this table. `sendOrHold()` takes the
 * secret part as `transient` — it reaches the provider in memory only, and when no provider exists
 * the held row simply records that a code was requested.
 *
 * This module must not import "cloudflare:workers".
 */
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { newId } from "~/lib/ids";
import type { BatchStatement, Db } from "./db/drizzle.server";
import { outbox, type OutboxChannel, type OutboxStatus } from "./db/schema";
import { isUniqueViolation } from "./db/tx.server";

export type OutboxMessageInput = {
  channel: OutboxChannel;
  /** E.164 phone for sms / whatsapp, address for email, device token for push. */
  recipient: string;
  /** Key of a message template (`message_templates.key`). */
  template: string;
  /** Template variables. Stored as written: never put a secret here (see `transient`). */
  payload?: Record<string, unknown>;
  locale?: string | null;
  customerId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** The same notification is never stored twice (UNIQUE). */
  dedupeKey?: string | null;
  now: number;
  /** Default: a new id. */
  id?: string;
};

export type OutgoingMessage = {
  id: string;
  channel: OutboxChannel;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  locale: string | null;
};

/** What a delivery integration implements. `send` throws when the provider refuses the message. */
export type MessageProvider = {
  send(message: OutgoingMessage): Promise<{ providerMessageId?: string | null }>;
};

/** Providers by channel. Empty today — see the note at the top of this file. */
export type MessageProviders = Partial<Record<OutboxChannel, MessageProvider>>;

export const NO_PROVIDERS: MessageProviders = Object.freeze({});

/** `queued` when a provider exists for the channel, otherwise `held`. */
export function initialStatus(channel: OutboxChannel, providers: MessageProviders = NO_PROVIDERS): Extract<OutboxStatus, "held" | "queued"> {
  return providers[channel] ? "queued" : "held";
}

function row(input: OutboxMessageInput, status: OutboxStatus, id: string) {
  return {
    id,
    channel: input.channel,
    recipient: input.recipient,
    template: input.template,
    payload: input.payload ?? {},
    status,
    locale: input.locale ?? null,
    customerId: input.customerId ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    createdAt: input.now,
    nextAttemptAt: status === "queued" ? input.now : null,
  };
}

/**
 * A batch item that stores a message next to the change that caused it. With a `dedupeKey`, a
 * repeat is silently skipped (so retried requests do not notify twice).
 */
export function outboxStatement(db: Db, input: OutboxMessageInput, providers: MessageProviders = NO_PROVIDERS): BatchStatement {
  const insert = db.insert(outbox).values(row(input, initialStatus(input.channel, providers), input.id ?? newId("msg")));
  return input.dedupeKey ? insert.onConflictDoNothing({ target: outbox.dedupeKey }) : insert;
}

export type EnqueueResult = { id: string; status: OutboxStatus; duplicate: boolean };

/** Stores one message on its own. Returns the existing row when the `dedupeKey` was already used. */
export async function enqueueMessage(db: Db, input: OutboxMessageInput, providers: MessageProviders = NO_PROVIDERS): Promise<EnqueueResult> {
  const id = input.id ?? newId("msg");
  const status = initialStatus(input.channel, providers);
  try {
    await db.insert(outbox).values(row(input, status, id));
    return { id, status, duplicate: false };
  } catch (error) {
    if (!input.dedupeKey || !isUniqueViolation(error)) throw error;
    const existing = await db.select({ id: outbox.id, status: outbox.status }).from(outbox).where(eq(outbox.dedupeKey, input.dedupeKey)).get();
    if (!existing) throw error;
    return { id: existing.id, status: existing.status, duplicate: true };
  }
}

const MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt 2, 3, 4, 5. */
const BACKOFF_MINUTES = [1, 5, 30, 120];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

async function attempt(db: Db, provider: MessageProvider, message: OutgoingMessage, attempts: number, now: number, retry: boolean): Promise<OutboxStatus> {
  try {
    const result = await provider.send(message);
    await db
      .update(outbox)
      .set({ status: "sent", sentAt: now, attempts, lastError: null, nextAttemptAt: null, providerMessageId: result.providerMessageId ?? null })
      .where(eq(outbox.id, message.id));
    return "sent";
  } catch (error) {
    const giveUp = !retry || attempts >= MAX_ATTEMPTS;
    await db
      .update(outbox)
      .set({
        status: giveUp ? "failed" : "queued",
        attempts,
        lastError: errorText(error),
        nextAttemptAt: giveUp ? null : now + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60_000,
      })
      .where(eq(outbox.id, message.id));
    return giveUp ? "failed" : "queued";
  }
}

export type SendOrHoldResult = { id: string; status: OutboxStatus };

/**
 * For messages that carry a secret and only make sense right now (one-time codes).
 *   · no provider for the channel → the message is stored `held` (without the secret) and nothing is sent
 *   · provider configured         → sent immediately with `transient` merged into the payload in
 *                                   memory; the stored row never contains it; no retry (a late code is useless)
 */
export async function sendOrHold(
  db: Db,
  input: OutboxMessageInput,
  transient: Record<string, unknown> = {},
  providers: MessageProviders = NO_PROVIDERS,
): Promise<SendOrHoldResult> {
  const id = input.id ?? newId("msg");
  const provider = providers[input.channel];
  // Stored as `held` either way: deliverOutbox() only picks up `queued` rows, so a message whose
  // secret part lives in memory can never be re-sent later without it.
  await db.insert(outbox).values(row(input, "held", id));
  if (!provider) return { id, status: "held" };
  const message: OutgoingMessage = { id, channel: input.channel, recipient: input.recipient, template: input.template, payload: { ...(input.payload ?? {}), ...transient }, locale: input.locale ?? null };
  return { id, status: await attempt(db, provider, message, 1, input.now, false) };
}

export type DeliverResult = { sent: number; failed: number; retrying: number; skipped: number };

/**
 * Sends queued messages that are due, oldest first. A message is claimed (attempt counted, next
 * attempt pushed out) before it is sent, so two overlapping runs do not send it twice.
 * With no providers this does nothing — held messages stay held.
 */
export async function deliverOutbox(db: Db, providers: MessageProviders, now: number, limit = 20): Promise<DeliverResult> {
  const result: DeliverResult = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
  const channels = (Object.keys(providers) as OutboxChannel[]).filter((channel) => providers[channel]);
  if (channels.length === 0) return result;

  const due = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, "queued"), or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now))))
    .orderBy(asc(outbox.createdAt))
    .limit(limit);

  for (const message of due) {
    const provider = providers[message.channel];
    if (!provider) {
      result.skipped++;
      continue;
    }
    const attempts = message.attempts + 1;
    // Claim: only one run moves `attempts` from n to n + 1.
    const claimed = await db
      .update(outbox)
      .set({ attempts, nextAttemptAt: now + 10 * 60_000 })
      .where(and(eq(outbox.id, message.id), eq(outbox.status, "queued"), eq(outbox.attempts, message.attempts)))
      .returning({ id: outbox.id });
    if (claimed.length === 0) {
      result.skipped++;
      continue;
    }
    const outcome = await attempt(
      db,
      provider,
      { id: message.id, channel: message.channel, recipient: message.recipient, template: message.template, payload: message.payload ?? {}, locale: message.locale },
      attempts,
      now,
      true,
    );
    if (outcome === "sent") result.sent++;
    else if (outcome === "failed") result.failed++;
    else result.retrying++;
  }
  return result;
}
