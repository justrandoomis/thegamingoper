/**
 * Notification preferences and consents (brief §3.10 settings, §4 "save contact consent separately and never pre-check
 * marketing consent", §6 "guest privacy controls").
 *
 *   const prefs = await getPreferences(db, customerId);
 *   await setNotificationChannels(db, actor, { sms: true, whatsapp: false, email: false }, ctx.now);
 *   await recordConsent(db, { subjectType: "customer", subjectId, kind: "marketing", granted: true, source: "account", ip, now });
 *
 * CHANNELS: what the customer wants per channel for messages about their own orders and account. NO PROVIDER IS
 * CONFIGURED for SMS, WhatsApp or e-mail (docs/STATUS.md open item 4): the choice is stored, `providers` says that
 * nothing can be delivered yet, and the screens say so — never "we will text you".
 *
 * CONSENTS are an append-only history (`consents`): every change is a new row; the newest row per subject and kind is
 * the current answer; null = never asked. Marketing and personalization are separate questions and nothing is ever
 * assumed: a missing answer is "no" wherever it matters.
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { CustomerActor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { consents, customers, type ConsentKind } from "~/server/db/schema";
import { notFound, unauthorized } from "~/server/errors";
import { initialStatus } from "~/server/outbox.server";
import { NOTIFICATION_CHANNELS, type AccountPreferences, type NotificationChannel } from "./types";

/** The cookie that carries a device's personalization answer ("1" / "0"); read by the shell loader. */
export const CONSENT_COOKIE = "tt_consent";
/** One year. */
export const CONSENT_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
/** Bump when the privacy policy text people agree to changes. */
export const CONSENT_POLICY_VERSION = "2026-11";

export type ConsentSubject = { subjectType: "customer" | "guest_contact" | "session" | "order"; subjectId: string };

/** The newest answer of a subject to one consent question; null = never asked. */
export async function getConsent(db: Db, subject: ConsentSubject, kind: ConsentKind): Promise<boolean | null> {
  const row = await db
    .select({ granted: consents.granted })
    .from(consents)
    .where(and(eq(consents.subjectType, subject.subjectType), eq(consents.subjectId, subject.subjectId), eq(consents.kind, kind)))
    .orderBy(desc(consents.at), desc(consents.id))
    .limit(1)
    .get();
  return row ? row.granted : null;
}

export type ConsentRecord = ConsentSubject & { kind: ConsentKind; granted: boolean; source: string; ip?: string | null; now: number };

/** Batch item: one consent row. */
export function consentStatement(db: Db, record: ConsentRecord): BatchStatement {
  return db.insert(consents).values({
    id: newId("cns"),
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    kind: record.kind,
    granted: record.granted,
    source: record.source.slice(0, 40),
    at: record.now,
    ip: record.ip ?? null,
    policyVersion: CONSENT_POLICY_VERSION,
  });
}

/** Stores an answer when it differs from the current one. Returns true when a row was written. */
export async function recordConsent(db: Db, record: ConsentRecord): Promise<boolean> {
  const current = await getConsent(db, record, record.kind);
  if (current === record.granted) return false;
  await db.batch([consentStatement(db, record)]);
  return true;
}

const flag = z.preprocess((value) => value === true || value === "1" || value === "on" || value === "true", z.boolean());
export const ChannelsInput = z.object({ sms: flag.optional(), whatsapp: flag.optional(), email: flag.optional() });
export type ChannelsInput = z.input<typeof ChannelsInput>;

function channelsOf(prefs: Partial<Record<NotificationChannel | "push", boolean>> | null | undefined): Record<NotificationChannel, boolean> {
  return { sms: prefs?.sms === true, whatsapp: prefs?.whatsapp === true, email: prefs?.email === true };
}

/** What a customer chose, and what can actually be delivered (nothing, today). */
export async function getPreferences(db: Db, customerId: string): Promise<AccountPreferences> {
  const row = await db.select({ prefs: customers.notificationPrefs }).from(customers).where(eq(customers.id, customerId)).get();
  if (!row) throw notFound("customer");
  const subject: ConsentSubject = { subjectType: "customer", subjectId: customerId };
  const [marketing, personalization] = await Promise.all([getConsent(db, subject, "marketing"), getConsent(db, subject, "personalization")]);
  const providers = Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, initialStatus(channel) === "queued"])) as Record<NotificationChannel, boolean>;
  return { channels: channelsOf(row.prefs), providers, marketing, personalization };
}

/** Saves the per-channel choice. Unticked boxes are "no" (an HTML form sends nothing for them). */
export async function setNotificationChannels(db: Db, actor: CustomerActor, raw: ChannelsInput, now: number): Promise<Record<NotificationChannel, boolean>> {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  const input = ChannelsInput.parse(raw ?? {});
  const row = await db.select({ prefs: customers.notificationPrefs }).from(customers).where(eq(customers.id, actor.id)).get();
  if (!row) throw notFound("customer");
  const next = { ...(row.prefs ?? {}), sms: input.sms === true, whatsapp: input.whatsapp === true, email: input.email === true };
  await db.update(customers).set({ notificationPrefs: next, updatedAt: now }).where(eq(customers.id, actor.id));
  return channelsOf(next);
}
