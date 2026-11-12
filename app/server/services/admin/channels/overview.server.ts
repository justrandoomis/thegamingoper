/**
 * The module's front page and 21.04's monitor — figures, each only for an employee who may open the page behind it.
 *
 *   integrationMonitor(db, actor, now)   channels.integration.read | channels.webhook.manage | channels.integration.manage
 *       webhook deliveries by status (the oldest waiting, failures of 24 hours, what is due), incoming provider events
 *       by status with the latest failures (never their payload), the outbox's held / failed counts (module 23 lists
 *       them), providers with something saved, and the boundaries: no delivery transport, no provider connected.
 *   channelsOverview(db, actor, now)     any permission of the module — what waits for a person (given-up deliveries,
 *       keys about to expire) and the figures; null where the employee may not open the page. Each figure counts what
 *       its page lists: a branch-limited employee's branches (their own), keys that work (not suspended), deliveries
 *       waiting as the webhook list counts them (pending and failed).
 *   channelsQueueCounts(db, actor, now)  for the shell's bell: given-up deliveries, only for who may retry them.
 *
 * Must not import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import { activeKeyCount, keysExpiringSoon } from "./apikeys.server";
import { inboundHealth } from "./inbound.server";
import { providerCounts } from "./providers.server";
import { channelsAccess, hasAnyChannelsPermission } from "./shared.server";
import type { ChannelsAccess, DeliveryStatus } from "./types";
import { deliveryHealth } from "./webhooks.server";

const MONITOR = ["channels.integration.read", "channels.webhook.manage", "channels.integration.manage"] as const;

export type IntegrationMonitor = {
  deliveries: { counts: Record<DeliveryStatus, number>; oldestPendingAt: number | null; failed24h: number; due: number };
  /** Always false today: nothing sends a webhook to an outside address (webhooks.server.ts, the boundary). */
  transport: false;
  inbound: { counts: Record<string, number>; failures: { id: string; provider: string; eventType: string | null; error: string | null; receivedAt: number }[] };
  outbox: { held: number; queued: number; failed: number; list: string | null };
  providers: { withSecret: number; connected: 0; errors: { provider: string; kind: string; error: string; at: number | null }[] };
  webhooks: { active: number; paused: number; failing: number };
  canRetry: boolean;
};

export async function integrationMonitor(db: Db, actor: Actor, now: number): Promise<IntegrationMonitor> {
  if (!canAny(actor, MONITOR)) throw forbidden(MONITOR.join("|"));
  const [deliveries, inbound, outbox, providers, hooks] = await Promise.all([
    deliveryHealth(db, now),
    inboundHealth(db),
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM outbox WHERE status IN ('held', 'queued', 'failed') GROUP BY status`),
    providerCounts(db),
    db.all<{ active: number; paused: number; failing: number }>(sql`
      SELECT coalesce(sum(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active, coalesce(sum(CASE WHEN is_active = 0 THEN 1 ELSE 0 END), 0) AS paused,
             coalesce(sum(CASE WHEN failure_count > 0 THEN 1 ELSE 0 END), 0) AS failing FROM webhooks`),
  ]);
  const outboxCount = (status: string) => Number(outbox.find((row) => row.status === status)?.n ?? 0);
  return {
    deliveries,
    transport: false,
    inbound,
    outbox: { held: outboxCount("held"), queued: outboxCount("queued"), failed: outboxCount("failed"), list: can(actor, "ops.job.read") ? "/admin/ops/outbox" : null },
    providers: { withSecret: providers.withSecret, connected: 0, errors: providers.errors },
    webhooks: { active: Number(hooks[0]?.active ?? 0), paused: Number(hooks[0]?.paused ?? 0), failing: Number(hooks[0]?.failing ?? 0) },
    canRetry: can(actor, "channels.webhook.manage"),
  };
}

export type ChannelsOverview = {
  access: ChannelsAccess;
  branches: { active: number; inactive: number } | null;
  channels: { total: number; added: number } | null;
  apiKeys: { active: number; expiringSoon: number } | null;
  webhooks: { active: number; pending: number; gaveUp: number } | null;
  providers: { withSecret: number } | null;
};

export async function channelsOverview(db: Db, actor: Actor, now: number): Promise<ChannelsOverview> {
  if (!hasAnyChannelsPermission(actor)) throw forbidden("channels");
  const access = channelsAccess(actor);
  // the branch list shows a branch-limited employee their own branch only: so does its figure
  const ownBranch = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const [branches, channels, keys, expiring, hooks, saved] = await Promise.all([
    access.branches
      ? db.all<{ active: number; inactive: number }>(
          sql`SELECT coalesce(sum(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active, coalesce(sum(CASE WHEN is_active = 0 THEN 1 ELSE 0 END), 0) AS inactive FROM branches ${ownBranch ? sql`WHERE id = ${ownBranch}` : sql``}`,
        )
      : Promise.resolve(null),
    access.channels ? db.all<{ total: number; added: number }>(sql`SELECT count(*) AS total, coalesce(sum(CASE WHEN is_system = 0 THEN 1 ELSE 0 END), 0) AS added FROM channels`) : Promise.resolve(null),
    access.apiKeys ? activeKeyCount(db, now) : Promise.resolve(null),
    access.apiKeys ? keysExpiringSoon(db, now) : Promise.resolve(null),
    access.monitor
      ? db.all<{ active: number; pending: number; gaveUp: number }>(sql`
          SELECT (SELECT count(*) FROM webhooks WHERE is_active = 1) AS active,
                 (SELECT count(*) FROM webhook_deliveries WHERE status IN ('pending', 'failed')) AS pending,
                 (SELECT count(*) FROM webhook_deliveries WHERE status = 'gave_up') AS gaveUp`)
      : Promise.resolve(null),
    access.providers ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM integrations WHERE secret_enc IS NOT NULL`) : Promise.resolve(null),
  ]);
  return {
    access,
    branches: branches ? { active: Number(branches[0]?.active ?? 0), inactive: Number(branches[0]?.inactive ?? 0) } : null,
    channels: channels ? { total: Number(channels[0]?.total ?? 0), added: Number(channels[0]?.added ?? 0) } : null,
    apiKeys: keys === null ? null : { active: keys, expiringSoon: Number(expiring ?? 0) },
    webhooks: hooks ? { active: Number(hooks[0]?.active ?? 0), pending: Number(hooks[0]?.pending ?? 0), gaveUp: Number(hooks[0]?.gaveUp ?? 0) } : null,
    providers: saved ? { withSecret: Number(saved[0]?.n ?? 0) } : null,
  };
}

/** Given-up deliveries — a decision (retry or fix the receiver) for who manages webhooks; null for everyone else. */
export async function channelsQueueCounts(db: Db, actor: Actor): Promise<{ deliveriesGaveUp: number | null }> {
  if (!can(actor, "channels.webhook.manage")) return { deliveriesGaveUp: null };
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM webhook_deliveries WHERE status = 'gave_up'`);
  return { deliveriesGaveUp: Number(rows[0]?.n ?? 0) };
}
