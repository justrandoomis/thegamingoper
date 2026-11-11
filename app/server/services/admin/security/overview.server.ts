/**
 * Admin module 20 — the front page's figures, each only for who may open the page behind it (null otherwise): staff
 * without two-step verification, live sessions, sign-in alerts of the last 24 hours, flagged refunds nobody reviewed,
 * the audit chain's last seal, the age of the last passed restore test and the roles whose access review is due.
 */
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { chainHead, type ChainHead } from "./audit-log.server";
import { restoreTestAge } from "./backups.server";
import { unreviewedCount } from "./refund-reviews.server";
import { reviewsDue } from "./retention.server";
import { alertCount } from "./signins.server";
import { staffCounts } from "./staff.server";
import { ACCESS_REVIEW_INTERVAL_DAYS } from "./types";

export type SecurityOverview = {
  staff: { active: number; withTwoStep: number; liveSessions: number } | null;
  alerts: number | null;
  refunds: number | null;
  chain: ChainHead | null;
  restore: { ageDays: number | null; due: boolean } | null;
  reviewsDue: number | null;
};

export async function securityOverview(db: Db, actor: Actor, now: number): Promise<SecurityOverview> {
  const [staff, alerts, refunds, chain, restore, due] = await Promise.all([
    staffCounts(db, actor, now),
    alertCount(db, actor, now),
    unreviewedCount(db, actor, now),
    can(actor, "audit.read") ? chainHead(db) : Promise.resolve(null),
    can(actor, "security.backup.manage") ? restoreTestAge(db, now) : Promise.resolve(null),
    canAny(actor, ["security.access_review.perform", "security.retention.manage"]) ? reviewsDue(db, now, ACCESS_REVIEW_INTERVAL_DAYS) : Promise.resolve(null),
  ]);
  return { staff, alerts, refunds, chain, restore, reviewsDue: due };
}
