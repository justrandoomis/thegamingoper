/**
 * Admin 01.07 — the activity feed: the latest price changes, returns and approvals, read from the audit trail
 * (`audit_events`, append-only and hash-chained — nothing here writes it), each line filtered by the reader's
 * permissions (feed.ts: the permission that opens that record's own screen; an unlisted action never shows).
 *
 * What a line carries, and what it never does:
 *   · who (their name at the time; "the system" for a job; "a customer" — never a customer's name), what (the action),
 *     which record (a reference resolved here — a SKU, an RMA, an order reference — and a link only to a page this
 *     employee may open), when, and the reason given;
 *   · price changes: the selling price before and after (the store's public price, never a cost);
 *   · never a before/after snapshot: only those two price fields and a top-up's reference are read, in SQL, so the rest
 *     of a snapshot never leaves the database. Lines of the cost families (purchasing, finance — module 20's
 *     `snapshotWithheld`) lose their reason too without cost.read.
 * Newest first, `FEED_PAGE` lines a page, older pages by `before` (an event's sequence number).
 */
import { sql } from "drizzle-orm";
import { assertCan, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { snapshotWithheld } from "~/server/services/admin/security/shared.server";
import { FEED_RULES, feedHref, type FeedRule } from "./feed";
import { FEED_KINDS, type FeedFilters, type FeedKind, type FeedLine, type FeedPage } from "./types";

export const FEED_PAGE = 25;
export const FEED_PREVIEW = 8;

type Row = {
  seq: number;
  id: string;
  at: number;
  actorKind: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  reason: string | null;
  beforePrice: unknown;
  afterPrice: unknown;
  afterRef: unknown;
};

const isBranchLimited = (actor: Actor) => actor.kind === "employee" && Boolean(actor.branchId);

/** The actions this reader may see (of one kind, or all), and the kinds they have at all. */
export function readableActions(actor: Actor, kind: FeedKind | null): { actions: string[]; kinds: FeedKind[] } {
  const limited = isBranchLimited(actor);
  const allowed = (rule: FeedRule) => canAny(actor, rule.read) && !(limited && rule.branchScoped);
  const kinds = FEED_KINDS.filter((k) => Object.values(FEED_RULES).some((rule) => rule.kind === k && allowed(rule)));
  const actions = Object.entries(FEED_RULES)
    .filter(([, rule]) => (kind === null || rule.kind === kind) && allowed(rule))
    .map(([action]) => action);
  return { actions, kinds };
}

const asInt = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
const asText = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** The feed for this employee (dashboard.activity.read): newest first, `limit` lines, then `next` for older ones. */
export async function activityFeed(db: Db, actor: Actor, filters: FeedFilters, limit: number = FEED_PAGE): Promise<FeedPage> {
  assertCan(actor, "dashboard.activity.read");
  const { actions, kinds } = readableActions(actor, filters.kind);
  if (actions.length === 0) return { lines: [], next: null, kinds, kind: filters.kind };
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  // an action that is a line only when its snapshot carries a field (a gift card issued after an approval)
  const conditional = actions.flatMap((action) => {
    const path = FEED_RULES[action]?.onlyWith;
    return path ? [sql`AND NOT (action = ${action} AND json_extract(after, ${path}) IS NULL)`] : [];
  });
  const rows = await db.all<Row>(sql`
    SELECT seq, id, at, actor_kind AS actorKind, actor_id AS actorId, actor_label AS actorLabel, action, entity_type AS entityType, entity_id AS entityId,
           summary, reason,
           CASE WHEN action LIKE 'pricing.%' THEN json_extract(before, '$.priceIqd') END AS beforePrice,
           CASE WHEN action LIKE 'pricing.%' THEN json_extract(after, '$.priceIqd') END AS afterPrice,
           CASE WHEN action LIKE 'finance.wallet.topup%' THEN json_extract(after, '$.ref') END AS afterRef
    FROM audit_events
    WHERE action IN (SELECT value FROM json_each(${JSON.stringify(actions)}))
      ${sql.join(conditional, sql` `)}
      ${filters.before ? sql`AND seq < ${filters.before}` : sql``}
    ORDER BY seq DESC
    LIMIT ${size + 1}`);
  const page = rows.slice(0, size);
  const labels = await recordLabels(db, page);
  const lines = page.map((row): FeedLine => {
    const rule = FEED_RULES[row.action] as FeedRule;
    const label = labels.get(row.id) ?? null;
    const withheld = snapshotWithheld(actor, row.action);
    return {
      id: row.id,
      seq: Number(row.seq),
      at: Number(row.at),
      kind: rule.kind,
      action: row.action,
      actor: { label: row.actorKind === "employee" ? row.actorLabel : null, system: row.actorKind === "system" },
      record: { entity: rule.entity, label, href: feedHref(rule.entity, row.entityId, label) },
      reason: withheld ? null : row.reason,
      price: rule.price ? { fromIqd: asInt(row.beforePrice), toIqd: asInt(row.afterPrice) } : null,
    };
  });
  return { lines, next: rows.length > size ? Number(page[page.length - 1]?.seq ?? 0) || null : null, kinds, kind: filters.kind };
}

/**
 * A readable reference for each line's record: the SKU of a price change (the event's summary is the SKU, or a
 * request id for a decision — the variant is looked up), the RMA of a return, the order reference of a refund or a
 * payment, a top-up's reference, a purchase order's or a payroll run's reference, a setting's key.
 */
async function recordLabels(db: Db, rows: readonly Row[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const variantIds = new Set<string>();
  const refundIds = new Set<string>();
  const paymentIds = new Set<string>();
  for (const row of rows) {
    const rule = FEED_RULES[row.action];
    if (!rule || !row.entityId) continue;
    switch (rule.entity) {
      case "variant":
        variantIds.add(row.entityId);
        break;
      case "refund":
        refundIds.add(row.entityId);
        break;
      case "payment":
        paymentIds.add(row.entityId);
        break;
      default:
        break;
    }
  }
  const lookup = <T>(ids: Set<string>, query: (json: string) => Promise<T[]>) => (ids.size > 0 ? query(JSON.stringify([...ids])) : Promise.resolve([] as T[]));
  const [skus, refundRefs, paymentRefs] = await Promise.all([
    lookup(variantIds, (json) => db.all<{ id: string; label: string }>(sql`SELECT id, sku AS label FROM variants WHERE id IN (SELECT value FROM json_each(${json}))`)),
    lookup(refundIds, (json) => db.all<{ id: string; label: string }>(sql`SELECT r.id AS id, o.ref AS label FROM refunds AS r JOIN orders AS o ON o.id = r.order_id WHERE r.id IN (SELECT value FROM json_each(${json}))`)),
    lookup(paymentIds, (json) => db.all<{ id: string; label: string }>(sql`SELECT p.id AS id, o.ref AS label FROM payments AS p JOIN orders AS o ON o.id = p.order_id WHERE p.id IN (SELECT value FROM json_each(${json}))`)),
  ]);
  const byId = (list: { id: string; label: string }[]) => new Map(list.map((item) => [item.id, item.label]));
  const sku = byId(skus);
  const refund = byId(refundRefs);
  const payment = byId(paymentRefs);
  for (const row of rows) {
    const rule = FEED_RULES[row.action];
    if (!rule) continue;
    const id = row.entityId ?? "";
    let label: string | null = null;
    switch (rule.entity) {
      case "variant":
        label = sku.get(id) ?? null;
        break;
      case "refund":
        label = refund.get(id) ?? null;
        break;
      case "payment":
        label = payment.get(id) ?? null;
        break;
      case "return":
        label = asText(row.summary?.split(" · ")[0]);
        break;
      case "wallet_topup":
        label = asText(row.afterRef);
        break;
      case "setting":
        label = row.entityId;
        break;
      case "used_unit":
      case "purchase_order":
      case "supplier_invoice":
      case "payroll_run":
      case "knowledge_article":
        label = asText(row.summary);
        break;
      default:
        break;
    }
    if (label) out.set(row.id, label);
  }
  return out;
}
