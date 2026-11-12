/**
 * Admin 16.02 — abandoned-cart recovery with sending limits.
 *
 *   listAbandonedCarts(db, actor, filters, now)                    marketing.cart_recovery.manage
 *   prepareCartReminders(db, actor, { cartIds?, idempotencyKey }, now, origin)
 *
 * Which carts: lines in them, not turned into an order, untouched for CART_RECOVERY.idleHours and younger than
 * maxAgeDays, belonging to a KNOWN customer (a signed-in account — a guest's cart has no number until checkout) who
 * passes every rule of audience.server.ts on SMS (explicit, current marketing consent; account open; channel on).
 * Not when the customer ordered since, when nothing in the cart can be bought now, when the cart was reminded already
 * (one reminder per cart, `cart_reminders` UNIQUE cart + step), when the person had a cart reminder in the last
 * perPersonDays, or when SEND_LIMITS is reached. A reminder prepared in the quiet hours is scheduled for the morning.
 *
 * BOUNDARY: no SMS provider — a prepared reminder is a `cart_reminders` row "held" with a HELD outbox message
 * (template "cart_reminder", payload name / items / link / text). Nothing is sent. A cart that turns into an order
 * after its reminder is marked "converted" — and the page says plainly that the shopper never received the reminder,
 * so it says nothing about the reminder's effect. The rules are checked again inside the write.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import { newId, sha256Hex } from "~/lib/ids";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { initialStatus } from "~/server/outbox.server";
import { phoneView } from "~/server/services/admin/customers/shared.server";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { loadPeople, personBlock, recentMarketing, recipientGuard, type Person } from "./audience.server";
import { actorId, assertAny, ID, num, SECTION_READ } from "./shared.server";
import { CART_RECOVERY, CART_REMINDER_TEMPLATE, DAY_MS, SEND_LIMITS, baghdadHour, dayStart, baghdadDay, firstName, type CartFilters, type CartRow, type CartVerdict, type MessageLocale } from "./types";

const HOUR_MS = 3_600_000;
const PAGE_SIZE = 25;

type CartDbRow = { id: string; customer_id: string | null; updated_at: number; locale: string | null; lines: number; units: number; value: number | null; reminder_status: string | null; reminder_at: number | null; reminder_created: number | null; converted_order_id: string | null; customer_demo: number | null };
type LineRow = { cart_id: string; variant_id: string; used_unit_id: string | null; variant_active: number; product_status: string; used_status: string | null };

export type RecoveryStats = { reminded: number; convertedAfter: number; recoveredIqd: number; windowDays: number };

type Evaluated = { cart: CartDbRow; verdict: CartVerdict; person: Person | null; items: number };

/** Where a reminder's time falls: now, or the next morning when now is inside the quiet hours (Baghdad). */
export function reminderTime(now: number): number {
  const hour = baghdadHour(now);
  if (hour >= CART_RECOVERY.quietTo && hour < CART_RECOVERY.quietFrom) return now;
  const today = dayStart(baghdadDay(now)) ?? now;
  const morning = today + CART_RECOVERY.quietTo * HOUR_MS;
  return hour < CART_RECOVERY.quietTo ? morning : morning + DAY_MS;
}

async function candidateCarts(db: Db, now: number, includeDemo: boolean): Promise<CartDbRow[]> {
  const idle = now - CART_RECOVERY.idleHours * HOUR_MS;
  const oldest = now - CART_RECOVERY.maxAgeDays * DAY_MS;
  return db.all<CartDbRow>(sql`
    SELECT c.id, c.customer_id, c.updated_at, c.locale,
      (SELECT COUNT(*) FROM cart_items ci WHERE ci.cart_id = c.id) AS lines,
      (SELECT COALESCE(SUM(ci.qty), 0) FROM cart_items ci WHERE ci.cart_id = c.id) AS units,
      (SELECT SUM(ci.qty * COALESCE(uu.price_iqd, v.price_iqd)) FROM cart_items ci JOIN variants v ON v.id = ci.variant_id LEFT JOIN used_units uu ON uu.id = ci.used_unit_id WHERE ci.cart_id = c.id) AS value,
      (SELECT cr.status FROM cart_reminders cr WHERE cr.cart_id = c.id ORDER BY cr.step DESC LIMIT 1) AS reminder_status,
      (SELECT cr.scheduled_at FROM cart_reminders cr WHERE cr.cart_id = c.id ORDER BY cr.step DESC LIMIT 1) AS reminder_at,
      (SELECT cr.created_at FROM cart_reminders cr WHERE cr.cart_id = c.id ORDER BY cr.step DESC LIMIT 1) AS reminder_created,
      c.converted_order_id,
      cu.is_demo AS customer_demo
    FROM carts c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.converted_order_id IS NULL AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
      AND c.updated_at <= ${idle} AND c.updated_at >= ${oldest}
      AND (${includeDemo ? 1 : 0} = 1 OR cu.is_demo IS NULL OR cu.is_demo = 0)
    ORDER BY c.updated_at DESC
    LIMIT 2000`);
}

/** Every rule of the file header for each cart, in order; the first that applies is its verdict. */
async function evaluate(db: Db, carts: readonly CartDbRow[], now: number): Promise<Evaluated[]> {
  const owned = carts.filter((cart) => cart.customer_id);
  const people = await loadPeople(
    db,
    owned.map((cart) => ({ customer_id: cart.customer_id, guest_contact_id: null, phone: null, locale: cart.locale })),
    { demoFromOrders: null },
  );
  const personOf = new Map(people.filter((person) => person.customerId).map((person) => [person.customerId as string, person]));
  const ids = owned.map((cart) => cart.id);
  const customerIds = [...personOf.keys()];
  const phones = people.map((person) => person.phone).filter((phone): phone is string => Boolean(phone));
  const [lines, lastOrders, reminded, recent] = await Promise.all([
    ids.length > 0
      ? db.all<LineRow>(sql`
          SELECT ci.cart_id, ci.variant_id, ci.used_unit_id, v.is_active AS variant_active, p.status AS product_status, uu.status AS used_status
          FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN used_units uu ON uu.id = ci.used_unit_id
          WHERE ci.cart_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
      : Promise.resolve([] as LineRow[]),
    customerIds.length > 0
      ? db.all<{ customer_id: string; last_at: number }>(sql`SELECT customer_id, MAX(placed_at) AS last_at FROM orders WHERE customer_id IN (SELECT value FROM json_each(${JSON.stringify(customerIds)})) GROUP BY customer_id`)
      : Promise.resolve([] as { customer_id: string; last_at: number }[]),
    phones.length > 0
      ? db.all<{ phone_e164: string; n: number }>(sql`SELECT phone_e164, COUNT(*) AS n FROM cart_reminders WHERE phone_e164 IN (SELECT value FROM json_each(${JSON.stringify(phones)})) AND created_at > ${now - CART_RECOVERY.perPersonDays * DAY_MS} GROUP BY phone_e164`)
      : Promise.resolve([] as { phone_e164: string; n: number }[]),
    recentMarketing(db, phones, now),
  ]);
  const availability = await getAvailability(db, [...new Set(lines.filter((line) => !line.used_unit_id).map((line) => line.variant_id))]);
  const buyable = new Map<string, number>();
  for (const line of lines) {
    const ok = line.used_unit_id ? line.used_status === "listed" : num(line.variant_active) === 1 && line.product_status === "published" && (availability.get(line.variant_id)?.available ?? 0) > 0;
    if (ok) buyable.set(line.cart_id, (buyable.get(line.cart_id) ?? 0) + 1);
  }
  const lastOrder = new Map(lastOrders.map((row) => [row.customer_id, num(row.last_at)]));
  const remindedPhones = new Set(reminded.filter((row) => num(row.n) > 0).map((row) => row.phone_e164));
  const seenPeople = new Set<string>();

  return carts.map((cart) => {
    const items = num(cart.units);
    if (cart.reminder_status) return { cart, verdict: "reminded" as const, person: cart.customer_id ? (personOf.get(cart.customer_id) ?? null) : null, items };
    if (!cart.customer_id) return { cart, verdict: "guest_cart" as const, person: null, items };
    const person = personOf.get(cart.customer_id) ?? null;
    if (!person) return { cart, verdict: "account_closed" as const, person: null, items };
    const block = personBlock(person, "sms", person.isDemo);
    if (block === "account_closed" || block === "blocked" || block === "no_consent" || block === "consent_withdrawn" || block === "channel_off") return { cart, verdict: block, person, items };
    if (!person.phone) return { cart, verdict: "no_address" as const, person, items };
    if ((lastOrder.get(cart.customer_id) ?? 0) > num(cart.updated_at)) return { cart, verdict: "recent_order" as const, person, items };
    if ((buyable.get(cart.id) ?? 0) === 0) return { cart, verdict: "nothing_available" as const, person, items };
    if (remindedPhones.has(person.phone) || seenPeople.has(person.key)) return { cart, verdict: "person_limit" as const, person, items };
    if ((recent.get(person.phone) ?? 0) >= SEND_LIMITS.maxPerWindow) return { cart, verdict: "frequency_cap" as const, person, items };
    seenPeople.add(person.key);
    return { cart, verdict: "eligible" as const, person, items };
  });
}

export type CartListPage = { rows: CartRow[]; total: number; page: number; pageCount: number; counts: { eligible: number; all: number; reminded: number }; verdicts: Partial<Record<CartVerdict, number>>; stats: RecoveryStats };

export async function listAbandonedCarts(db: Db, actor: Actor, filters: CartFilters, now: number): Promise<CartListPage> {
  assertAny(actor, SECTION_READ.carts);
  const carts = await candidateCarts(db, now, filters.demo);
  const evaluated = await evaluate(db, carts, now);
  const verdicts: Partial<Record<CartVerdict, number>> = {};
  for (const entry of evaluated) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
  const reminded = await remindedCarts(db, now, filters.demo);
  // known customers first (newest first inside, as read); guests' carts — never reminded — after them
  const known = [...evaluated.filter((entry) => entry.cart.customer_id), ...evaluated.filter((entry) => !entry.cart.customer_id)];
  const shown = filters.view === "eligible" ? evaluated.filter((entry) => entry.verdict === "eligible") : filters.view === "reminded" ? reminded : known;
  const total = shown.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const full = can(actor, "customer.phone.read_full");
  const rows: CartRow[] = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((entry) => ({
    id: entry.cart.id,
    customer: entry.person
      ? { name: entry.person.name, phone: phoneView(entry.person.phone, full), profileId: customerProfileId(actor, entry.person.customerId), isDemo: entry.person.isDemo }
      : entry.cart.customer_id
        ? { name: null, phone: null, profileId: customerProfileId(actor, entry.cart.customer_id), isDemo: num(entry.cart.customer_demo) === 1 }
        : null,
    lines: num(entry.cart.lines),
    units: num(entry.cart.units),
    valueIqd: entry.cart.value === null ? null : num(entry.cart.value),
    updatedAt: num(entry.cart.updated_at),
    verdict: entry.verdict,
    reminder: entry.cart.reminder_status
      ? { status: entry.cart.reminder_status, scheduledAt: num(entry.cart.reminder_at), createdAt: num(entry.cart.reminder_created), converted: entry.cart.reminder_status === "converted" || entry.cart.converted_order_id !== null }
      : null,
  }));
  return { rows, total, page, pageCount, counts: { eligible: verdicts.eligible ?? 0, all: evaluated.length, reminded: reminded.length }, verdicts, stats: await recoveryStats(db, now, filters.demo) };
}

/** Carts reminded in the last 30 days, whatever their age now. */
async function remindedCarts(db: Db, now: number, includeDemo: boolean): Promise<Evaluated[]> {
  const rows = await db.all<CartDbRow>(sql`
    SELECT c.id, c.customer_id, c.updated_at, c.locale,
      (SELECT COUNT(*) FROM cart_items ci WHERE ci.cart_id = c.id) AS lines,
      (SELECT COALESCE(SUM(ci.qty), 0) FROM cart_items ci WHERE ci.cart_id = c.id) AS units,
      (SELECT SUM(ci.qty * COALESCE(uu.price_iqd, v.price_iqd)) FROM cart_items ci JOIN variants v ON v.id = ci.variant_id LEFT JOIN used_units uu ON uu.id = ci.used_unit_id WHERE ci.cart_id = c.id) AS value,
      cr.status AS reminder_status, cr.scheduled_at AS reminder_at, cr.created_at AS reminder_created, c.converted_order_id, cu.is_demo AS customer_demo
    FROM cart_reminders cr JOIN carts c ON c.id = cr.cart_id LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE cr.created_at > ${now - 30 * DAY_MS} AND (${includeDemo ? 1 : 0} = 1 OR cu.is_demo IS NULL OR cu.is_demo = 0)
    ORDER BY cr.created_at DESC LIMIT 500`);
  const people = await loadPeople(
    db,
    rows.filter((row) => row.customer_id).map((row) => ({ customer_id: row.customer_id, guest_contact_id: null, phone: null, locale: row.locale })),
    { demoFromOrders: null },
  );
  const personOf = new Map(people.filter((person) => person.customerId).map((person) => [person.customerId as string, person]));
  return rows.map((cart) => ({ cart, verdict: "reminded" as const, person: cart.customer_id ? (personOf.get(cart.customer_id) ?? null) : null, items: num(cart.units) }));
}

async function recoveryStats(db: Db, now: number, includeDemo: boolean): Promise<RecoveryStats> {
  const windowDays = 30;
  const [row] = await db.all<{ reminded: number; converted: number; recovered: number | null }>(sql`
    SELECT COUNT(*) AS reminded,
      SUM(CASE WHEN o.id IS NOT NULL AND o.placed_at > cr.created_at THEN 1 ELSE 0 END) AS converted,
      SUM(CASE WHEN o.id IS NOT NULL AND o.placed_at > cr.created_at AND o.status <> 'cancelled' THEN o.total_iqd ELSE 0 END) AS recovered
    FROM cart_reminders cr JOIN carts c ON c.id = cr.cart_id LEFT JOIN orders o ON o.id = c.converted_order_id LEFT JOIN customers cu ON cu.id = cr.customer_id
    WHERE cr.created_at > ${now - windowDays * DAY_MS} AND (${includeDemo ? 1 : 0} = 1 OR cu.is_demo IS NULL OR cu.is_demo = 0) AND (o.id IS NULL OR o.is_demo = 0 OR ${includeDemo ? 1 : 0} = 1)`);
  return { reminded: num(row?.reminded), convertedAfter: num(row?.converted), recoveredIqd: num(row?.recovered), windowDays };
}

const PrepareInput = z.object({
  cartIds: z.preprocess((value) => (Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []), z.array(z.string().regex(ID, "invalid")).max(CART_RECOVERY.maxPerRun, "too_big")),
  idempotencyKey: z.string().min(16, "invalid").max(128, "invalid").regex(/^[A-Za-z0-9_-]+$/, "invalid"),
  includeDemo: z.preprocess((value) => value === true || value === "1" || value === "on", z.boolean()),
});

/**
 * Prepares one held reminder for each eligible cart named (or, with none named, the eligible carts in view, at most
 * CART_RECOVERY.maxPerRun). Reminded carts are skipped; every rule is checked again inside the write. Also marks the
 * reminders whose cart has since become an order as "converted".
 */
export async function prepareCartReminders(db: Db, actor: Actor, raw: unknown, now: number, origin: string): Promise<{ prepared: number; skipped: number; replayed: boolean }> {
  assertAny(actor, SECTION_READ.carts);
  const input = PrepareInput.parse(raw ?? {});
  const runKey = `crr_${(await sha256Hex(`tamtam.marketing.cart_reminders|${input.idempotencyKey}`)).slice(0, 24)}`;
  const replay = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'marketing.cart_reminder.prepare' AND entity_type = 'cart_reminder_run' AND entity_id = ${runKey}`);
  if (num(replay[0]?.n) > 0) return { prepared: 0, skipped: 0, replayed: true };
  const carts = await candidateCarts(db, now, input.includeDemo);
  const wanted = input.cartIds.length > 0 ? new Set(input.cartIds) : null;
  const evaluated = (await evaluate(db, wanted ? carts.filter((cart) => wanted.has(cart.id)) : carts, now)).filter((entry) => entry.verdict === "eligible").slice(0, CART_RECOVERY.maxPerRun);
  const requested = wanted ? wanted.size : evaluated.length;
  if (evaluated.length === 0) throw new AppError("nothing_to_prepare", 409);
  const at = reminderTime(now);
  const status = initialStatus("sms");
  const specs = evaluated.map((entry) => {
    const person = entry.person as Person;
    const locale: MessageLocale = person.locale;
    const t = serverT(locale, "admin-marketing");
    const name = firstName(person.name) ?? t("customerText.nameFallback");
    const link = `${origin.replace(/\/+$/, "")}${locale === "ar" ? "" : `/${locale}`}/cart?utm_source=sms&utm_medium=cart_reminder&utm_campaign=cart_recovery`;
    return {
      rid: newId("crm"),
      oid: newId("msg"),
      cartId: entry.cart.id,
      customerId: person.customerId,
      guestIds: person.guestIds,
      phone: person.phone,
      recipient: person.phone,
      locale,
      name,
      items: entry.items,
      link,
      text: t("customerText.cartReminder", { name, items: entry.items, link }),
    };
  });
  const json = JSON.stringify(specs);
  const statements: BatchStatement[] = [
    batchSql(
      db,
      sql`UPDATE cart_reminders SET status = 'converted', recovered_order_id = (SELECT c.converted_order_id FROM carts c WHERE c.id = cart_reminders.cart_id)
        WHERE status IN ('scheduled', 'held', 'sent') AND EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_reminders.cart_id AND c.converted_order_id IS NOT NULL)`,
    ),
    batchSql(
      db,
      sql`INSERT INTO cart_reminders (id, cart_id, customer_id, phone_e164, channel, step, status, scheduled_at, outbox_id, created_at)
        SELECT json_extract(r.value, '$.rid'), json_extract(r.value, '$.cartId'), json_extract(r.value, '$.customerId'), json_extract(r.value, '$.phone'), 'sms', 1,
          ${status === "queued" ? "scheduled" : "held"}, ${at}, json_extract(r.value, '$.oid'), ${now}
        FROM json_each(${json}) AS r
        WHERE ${recipientGuard(now, null)}
          AND EXISTS (SELECT 1 FROM carts c WHERE c.id = json_extract(r.value, '$.cartId') AND c.converted_order_id IS NULL AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id))
          AND NOT EXISTS (SELECT 1 FROM cart_reminders cr WHERE cr.phone_e164 = json_extract(r.value, '$.phone') AND cr.created_at > ${now - CART_RECOVERY.perPersonDays * DAY_MS})
        ON CONFLICT DO NOTHING`,
    ),
    batchSql(
      db,
      sql`INSERT INTO outbox (id, channel, recipient, template, payload, status, attempts, created_at, locale, customer_id, ref_type, ref_id, dedupe_key, next_attempt_at)
        SELECT json_extract(r.value, '$.oid'), 'sms', json_extract(r.value, '$.recipient'), ${CART_REMINDER_TEMPLATE},
          json_object('name', json_extract(r.value, '$.name'), 'items', json_extract(r.value, '$.items'), 'link', json_extract(r.value, '$.link'), 'text', json_extract(r.value, '$.text')),
          ${status}, 0, ${now}, json_extract(r.value, '$.locale'), json_extract(r.value, '$.customerId'), 'cart_reminder', json_extract(r.value, '$.rid'),
          'cart_reminder:' || json_extract(r.value, '$.cartId') || ':1', ${status === "queued" ? at : null}
        FROM json_each(${json}) AS r JOIN cart_reminders cr ON cr.id = json_extract(r.value, '$.rid')
        WHERE 1 = 1
        ON CONFLICT DO NOTHING`,
    ),
  ];
  await runBatch(db, statements);
  const made = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM cart_reminders WHERE id IN (SELECT value FROM json_each(${JSON.stringify(specs.map((spec) => spec.rid))}))`);
  const prepared = num(made[0]?.n);
  await runBatch(db, [
    auditStatement(db, { actor, action: "marketing.cart_reminder.prepare", entityType: "cart_reminder_run", entityId: runKey, after: { prepared, requested, eligible: evaluated.length, scheduledAt: at, outbox: status, by: actorId(actor) }, at: now }),
  ]);
  return { prepared, skipped: requested - prepared, replayed: false };
}
