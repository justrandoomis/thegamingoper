/**
 * The bell after the polish round's audit of every module's count functions (2026-11-13): the queues it was missing,
 * each from the module's own count, shown only to who may act on it and open its page, linking to the list that shows
 * the counted rows — and what the whole bell costs (shell/queues.server.ts, docs/areas/admin-shell.md "Queues").
 *
 *   order_reviews        orders.risk.review                 /admin/orders/review                (listReviewQueue)
 *   catalog_review       catalog.product.publish (+ .read)  /admin/catalog?status=review        (the list's status)
 *   used_prices          pricing.price.approve              /admin/pricing/special?tab=used     (countUsedDecidable)
 *   wallet_payouts       customers.wallet.adjust + finance.wallet.read  /admin/finance/wallets?tab=payouts (walletQueue)
 *   refund_reviews       security.fraud.review              /admin/security/refunds?view=unreviewed (unreviewedCount)
 *   rma_quarantine       returns.rma.inspect | supplier_return.manage  /admin/returns/quarantine (queueCounts)
 *   repairs_late         returns.repair.manage              /admin/returns/repairs?view=late    (queueCounts)
 *   campaign_approvals   marketing.campaign.send            /admin/marketing/campaigns?view=decide (marketingQueueCounts)
 *   campaigns_due        marketing.campaign.send            /admin/marketing/campaigns?view=due (countDueCampaigns)
 *   review_moderation    marketing.review.moderate          /admin/marketing/reviews            (marketingQueueCounts)
 *   webhooks_gave_up     channels.webhook.manage            /admin/channels/monitor?status=gave_up (channelsQueueCounts)
 *   reorder_suggestions  automation.suggestion.approve + .read  /admin/automation/suggestions (automationQueueCounts)
 *   rules_to_activate    automation.workflow.activate + .read   /admin/automation/rules?ready=1
 *   automation_notices   a notice's audience (automation.*.read) /admin/automation#notices
 *   knowledge_review     support.knowledge.approve          /admin/support/knowledge?view=review (countArticlesToApprove,
 *                                                          follow-ups 2026-11-17)
 *
 * The module functions without an easy fixture here are wrapped (pass-through unless a test sets a figure): the rules
 * tests prove the bell asks them only for the employees they concern; the modules' own tests prove their counts.
 */
import { matchPath } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { adminModuleRoutes } from "~/routes/admin/_routes";
import { loadWaiting, QUEUE_HREF, type ShellQueueId, type ShellWaiting } from "~/routes/admin/shell/queues.server";
import type { EmployeeActor } from "~/server/actor";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { createDb } from "~/server/db/drizzle.server";
import { approvals, orders, products, repairTickets, webhookDeliveries, webhooks } from "~/server/db/schema";
import { defaultRolePermissions, type Permission } from "~/server/permissions";
import { listProducts, parseProductFilters } from "~/server/services/admin/catalog/product.server";
import { listDeliveries } from "~/server/services/admin/channels/webhooks.server";
import { parseDeliveryFilters } from "~/server/services/admin/channels/types";
import { countDecidablePayouts, listPayouts } from "~/server/services/admin/finance/wallets.server";
import { listReviewQueue } from "~/server/services/admin/orders/risk.server";
import { listRepairs } from "~/server/services/admin/returns/repair.server";
import { countArticlesToApprove, decideArticle, getArticleEditor, listArticles, saveArticle, submitArticle } from "~/server/services/admin/support/knowledge.server";
import { parseRepairFilters } from "~/server/services/admin/returns/types";
import { eq } from "drizzle-orm";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** Figures a test puts in place of a module's own count ("throw" = the module's count fails); undefined = the real one. */
const fake = vi.hoisted(() => ({
  refundReviews: undefined as number | "throw" | undefined,
  usedPrices: undefined as number | undefined,
  marketing: undefined as { campaignsToDecide: number | null; reviewsToModerate: number | null } | undefined,
  due: undefined as number | undefined,
  automation: undefined as { suggestions: number | null; rulesToActivate: number | null; notices: number | null } | "throw" | undefined,
  returns: undefined as Record<string, number | null> | undefined,
  calls: [] as string[],
  returnsOnly: [] as (readonly string[] | undefined)[],
}));
vi.mock("~/server/services/admin/security/refund-reviews.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/security/refund-reviews.server")>();
  return {
    ...real,
    unreviewedCount: async (...args: Parameters<typeof real.unreviewedCount>) => {
      fake.calls.push("unreviewedCount");
      if (fake.refundReviews === "throw") throw new Error("the security counts are down (test)");
      return fake.refundReviews ?? real.unreviewedCount(...args);
    },
  };
});
vi.mock("~/server/services/admin/pricing/special.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/pricing/special.server")>();
  return {
    ...real,
    countUsedDecidable: async (...args: Parameters<typeof real.countUsedDecidable>) => {
      fake.calls.push("countUsedDecidable");
      return fake.usedPrices ?? real.countUsedDecidable(...args);
    },
  };
});
vi.mock("~/server/services/admin/marketing/overview.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/marketing/overview.server")>();
  return {
    ...real,
    marketingQueueCounts: async (...args: Parameters<typeof real.marketingQueueCounts>) => {
      fake.calls.push("marketingQueueCounts");
      return fake.marketing ?? real.marketingQueueCounts(...args);
    },
  };
});
vi.mock("~/server/services/admin/marketing/campaigns.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/marketing/campaigns.server")>();
  return {
    ...real,
    countDueCampaigns: async (...args: Parameters<typeof real.countDueCampaigns>) => {
      fake.calls.push("countDueCampaigns");
      return fake.due ?? real.countDueCampaigns(...args);
    },
  };
});
vi.mock("~/server/services/admin/automation/overview.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/automation/overview.server")>();
  return {
    ...real,
    automationQueueCounts: async (...args: Parameters<typeof real.automationQueueCounts>) => {
      fake.calls.push("automationQueueCounts");
      if (fake.automation === "throw") throw new Error("the automation counts are down (test)");
      return fake.automation ?? real.automationQueueCounts(...args);
    },
  };
});
vi.mock("~/server/services/admin/returns/rma.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/returns/rma.server")>();
  return {
    ...real,
    queueCounts: async (...args: Parameters<typeof real.queueCounts>) => {
      fake.calls.push("returnsQueueCounts");
      fake.returnsOnly.push(args[3]?.only);
      const counts = await real.queueCounts(...args);
      return fake.returns ? { ...counts, ...fake.returns } : counts;
    },
  };
});

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});
afterEach(() => {
  fake.refundReviews = undefined;
  fake.usedPrices = undefined;
  fake.marketing = undefined;
  fake.due = undefined;
  fake.automation = undefined;
  fake.returns = undefined;
  fake.calls.length = 0;
  fake.returnsOnly.length = 0;
});

// ───────────────────────────────────────────────────────────────── helpers

type Person = { id: string; actor: EmployeeActor & { permissions: ReadonlySet<string> } };

/** An employee row holding exactly these permissions (the bell reads the session's actor). */
async function employeeWith(permissions: readonly string[]): Promise<Person> {
  const id = await make.employee({ name: "موظف الجرس" });
  return { id, actor: { kind: "employee", id, permissions: new Set(permissions), branchId: null } };
}

function sessionOf(person: Person): EmployeeSession {
  return {
    employee: { id: person.id, email: `${person.id}@bell.test`, name: "موظف الجرس", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: true, passwordChangedAt: null },
    actor: person.actor,
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
  };
}

const queueOf = (waiting: ShellWaiting, id: ShellQueueId) => waiting.queues.find((entry) => entry.id === id) ?? null;
const waitingFor = async (person: Person) => loadWaiting(t.db, sessionOf(person), NOW);

const NEW_QUEUES = ["order_reviews", "catalog_review", "used_prices", "wallet_payouts", "refund_reviews", "rma_quarantine", "repairs_late", "campaign_approvals", "campaigns_due", "review_moderation", "webhooks_gave_up", "reorder_suggestions", "rules_to_activate", "automation_notices", "knowledge_review"] as const satisfies readonly ShellQueueId[];

// ───────────────────────────────────────────────────────────────── rules

describe("who gets each new queue: the permission to act and to open its page — and nobody else is even counted for", () => {
  test("the links are admin pages of the route config, each with the view that lists the counted rows", () => {
    const patterns: string[] = [];
    const walk = (entries: typeof adminModuleRoutes, base: string) => {
      for (const entry of entries) {
        const path = entry.index ? base : entry.path ? `${base}/${entry.path}` : base;
        if (entry.path !== ":module" && entry.path !== "*") patterns.push(path);
        if (entry.children) walk(entry.children, path);
      }
    };
    walk(adminModuleRoutes, "/admin");
    for (const id of NEW_QUEUES) {
      const pathname = QUEUE_HREF[id].split(/[?#]/)[0]!;
      expect(patterns.some((pattern) => matchPath({ path: pattern, end: true }, pathname)), `${id}: ${QUEUE_HREF[id]}`).toBe(true);
    }
  });

  test("security: flagged refunds to review — only for security.fraud.review", async () => {
    fake.refundReviews = 2;
    const reviewer = await employeeWith(["security.fraud.review"]);
    expect(queueOf(await waitingFor(reviewer), "refund_reviews")).toEqual({ id: "refund_reviews", module: "security", count: 2, href: "/admin/security/refunds?view=unreviewed" });
    fake.calls.length = 0;
    const watcher = await employeeWith(["security.auth_event.read"]);
    expect(queueOf(await waitingFor(watcher), "refund_reviews")).toBeNull();
    expect(fake.calls).not.toContain("unreviewedCount");
  });

  test("pricing: used-device prices to decide — only for pricing.price.approve", async () => {
    fake.usedPrices = 3;
    const approver = await employeeWith(["pricing.price.approve"]);
    expect(queueOf(await waitingFor(approver), "used_prices")).toEqual({ id: "used_prices", module: "pricing", count: 3, href: "/admin/pricing/special?tab=used" });
    fake.calls.length = 0;
    const editor = await employeeWith(["pricing.price.update", "pricing.used.update"]);
    expect(queueOf(await waitingFor(editor), "used_prices")).toBeNull();
    expect(fake.calls).not.toContain("countUsedDecidable");
  });

  test("marketing: campaigns to decide and due (campaign.send), reviews to moderate (review.moderate) — each to its own", async () => {
    fake.marketing = { campaignsToDecide: 2, reviewsToModerate: null };
    fake.due = 1;
    const sender = await employeeWith(["marketing.campaign.send"]);
    const forSender = await waitingFor(sender);
    expect(queueOf(forSender, "campaign_approvals")).toEqual({ id: "campaign_approvals", module: "marketing", count: 2, href: "/admin/marketing/campaigns?view=decide" });
    expect(queueOf(forSender, "campaigns_due")).toEqual({ id: "campaigns_due", module: "marketing", count: 1, href: "/admin/marketing/campaigns?view=due" });
    expect(queueOf(forSender, "review_moderation")).toBeNull();

    fake.calls.length = 0;
    fake.marketing = { campaignsToDecide: null, reviewsToModerate: 4 };
    const moderator = await employeeWith(["marketing.review.moderate"]);
    const forModerator = await waitingFor(moderator);
    expect(queueOf(forModerator, "review_moderation")).toEqual({ id: "review_moderation", module: "marketing", count: 4, href: "/admin/marketing/reviews" });
    expect(queueOf(forModerator, "campaigns_due")).toBeNull();
    expect(fake.calls).not.toContain("countDueCampaigns");

    fake.calls.length = 0;
    const writer = await employeeWith(["marketing.campaign.manage"]);
    expect((await waitingFor(writer)).queues.filter((entry) => entry.module === "marketing")).toEqual([]);
    expect(fake.calls.filter((call) => call === "marketingQueueCounts" || call === "countDueCampaigns")).toEqual([]);
  });

  test("automation: suggestions (approve + read), rules to switch on (activate + read), notices (their audience)", async () => {
    fake.automation = { suggestions: 2, rulesToActivate: 5, notices: 1 };
    const buyer = await employeeWith(["automation.suggestion.approve", "automation.suggestion.read"]);
    const forBuyer = await waitingFor(buyer);
    expect(queueOf(forBuyer, "reorder_suggestions")).toEqual({ id: "reorder_suggestions", module: "automation", count: 2, href: "/admin/automation/suggestions" });
    // suggestion.read is one of the notices' audiences; switching rules on is not theirs
    expect(queueOf(forBuyer, "automation_notices")).toEqual({ id: "automation_notices", module: "automation", count: 1, href: "/admin/automation#notices" });
    expect(queueOf(forBuyer, "rules_to_activate")).toBeNull();

    const switcher = await employeeWith(["automation.workflow.activate", "automation.workflow.read"]);
    expect(queueOf(await waitingFor(switcher), "rules_to_activate")).toEqual({ id: "rules_to_activate", module: "automation", count: 5, href: "/admin/automation/rules?ready=1" });
    // without workflow.read the rules list does not open: no queue — and nothing is counted for them at all
    fake.calls.length = 0;
    const blind = await employeeWith(["automation.workflow.activate"]);
    expect((await waitingFor(blind)).queues.filter((entry) => entry.module === "automation")).toEqual([]);
    expect(fake.calls).not.toContain("automationQueueCounts");
  });

  test("returns: quarantine and late repairs — the module's own counts, and only the counts the bell shows (its `only`)", async () => {
    fake.returns = { quarantine: 2, repairsLate: 3 };
    const supplier = await employeeWith(["returns.supplier_return.manage"]);
    expect(queueOf(await waitingFor(supplier), "rma_quarantine")).toEqual({ id: "rma_quarantine", module: "returns", count: 2, href: "/admin/returns/quarantine" });
    expect(fake.returnsOnly.at(-1)).toEqual(["quarantine"]);
    const technician = await employeeWith(["returns.repair.manage"]);
    expect(queueOf(await waitingFor(technician), "repairs_late")).toEqual({ id: "repairs_late", module: "returns", count: 3, href: "/admin/returns/repairs?view=late" });
    expect(fake.returnsOnly.at(-1)).toEqual(["repairsLate"]);
    // an inspector with the list: decide is not theirs; inspect and quarantine are
    const inspector = await employeeWith(["returns.rma.inspect", "returns.rma.read"]);
    await waitingFor(inspector);
    expect(fake.returnsOnly.at(-1)).toEqual(["inspect", "quarantine"]);
    // nobody of the returns module: not asked
    fake.calls.length = 0;
    await waitingFor(await employeeWith(["returns.warranty.read"]));
    expect(fake.calls).not.toContain("returnsQueueCounts");
  });

  test("a new module whose count fails hides only its own queues; the others and the page stand", async () => {
    fake.automation = "throw";
    fake.refundReviews = 4;
    const both = await employeeWith(["automation.suggestion.approve", "automation.suggestion.read", "security.fraud.review"]);
    const waiting = await waitingFor(both);
    expect(waiting.queues.filter((entry) => entry.module === "automation")).toEqual([]);
    expect(queueOf(waiting, "refund_reviews")?.count).toBe(4);
  });
});

// ───────────────────────────────────────────────────────────────── truth

describe("each count is what its link's list shows that employee", () => {
  test("catalog: products waiting in review — the product list's «review» status, demo ones included as the list does", async () => {
    const one = await make.product();
    const two = await make.product({ isDemo: true });
    await t.db.update(products).set({ status: "review" }).where(eq(products.id, one.productId));
    await t.db.update(products).set({ status: "review" }).where(eq(products.id, two.productId));
    const publisher = await employeeWith(["catalog.product.publish", "catalog.product.read"]);
    const queue = queueOf(await waitingFor(publisher), "catalog_review");
    expect(queue).toMatchObject({ module: "catalog", count: 2, href: "/admin/catalog?status=review" });
    const list = await listProducts(t.db, publisher.actor, parseProductFilters(new URL(queue!.href, ORIGIN).searchParams), "ar", NOW);
    expect(list.total).toBe(queue!.count);
    // who may only read the catalogue, or publish without opening the list, is not asked
    expect(queueOf(await waitingFor(await employeeWith(["catalog.product.read", "catalog.product.update"])), "catalog_review")).toBeNull();
    expect(queueOf(await waitingFor(await employeeWith(["catalog.product.publish"])), "catalog_review")).toBeNull();
  });

  test("orders: flagged and held orders — the review page's two lists, row for row", async () => {
    const product = await make.product({ priceIqd: 90_000, stock: 9 });
    const flagged = await make.order([{ ...product }], { status: "confirmed", placedAt: NOW - HOUR });
    const held = await make.order([{ ...product }], { status: "confirmed", placedAt: NOW - HOUR });
    const cleared = await make.order([{ ...product }], { status: "confirmed", placedAt: NOW - HOUR });
    await t.db.update(orders).set({ reviewStatus: "needs_review" }).where(eq(orders.id, flagged.orderId));
    await t.db.update(orders).set({ reviewStatus: "blocked" }).where(eq(orders.id, held.orderId));
    await t.db.update(orders).set({ reviewStatus: "cleared" }).where(eq(orders.id, cleared.orderId));
    const reviewer = await employeeWith(["orders.risk.review", "orders.order.read"]);
    const queue = queueOf(await waitingFor(reviewer), "order_reviews");
    const page = await listReviewQueue(t.db, reviewer.actor, NOW);
    expect(queue).toMatchObject({ module: "orders", href: "/admin/orders/review" });
    expect(queue!.count).toBe(page.needsReview.length + page.onHold.length);
    expect(page.needsReview.map((row) => row.id)).toContain(flagged.orderId);
    expect(page.onHold.map((row) => row.id)).toContain(held.orderId);
    expect(queueOf(await waitingFor(await employeeWith(["orders.order.read", "orders.order.note"])), "order_reviews")).toBeNull();
  });

  test("finance: wallet payouts waiting for a second person — never one's own request; the payouts tab lists them", async () => {
    const asker = await employeeWith(["customers.wallet.adjust", "finance.wallet.read"]);
    const decider = await employeeWith(["customers.wallet.adjust", "finance.wallet.read"]);
    const customerId = await make.customer();
    await t.db.insert(approvals).values({ id: "apr_bell_payout_1", kind: "wallet_payout", entityType: "customer", entityId: customerId, requestedBy: asker.id, payload: { amountIqd: 15_000, method: "cash" }, status: "pending", reason: "صرف رصيد تجريبي", createdAt: NOW - HOUR });
    const queue = queueOf(await waitingFor(decider), "wallet_payouts");
    expect(queue).toEqual({ id: "wallet_payouts", module: "finance", count: 1, href: "/admin/finance/wallets?tab=payouts" });
    const listed = (await listPayouts(t.db, decider.actor, 50)).filter((row) => row.status === "pending" && !row.mine);
    expect(listed).toHaveLength(queue!.count);
    // the asker is not asked to decide their own request; who only reads the wallets is not asked at all
    expect(queueOf(await waitingFor(asker), "wallet_payouts")).toBeNull();
    expect(queueOf(await waitingFor(await employeeWith(["finance.wallet.read"])), "wallet_payouts")).toBeNull();
    // the figure is finance's own countDecidablePayouts (null = no right: the queue is hidden)
    expect(await countDecidablePayouts(t.db, decider.actor)).toBe(queue!.count);
    expect(await countDecidablePayouts(t.db, asker.actor)).toBe(0);
    expect(await countDecidablePayouts(t.db, (await employeeWith(["finance.wallet.read"])).actor)).toBeNull();
  });

  test("support: help articles waiting for approval — articles in review and pending revisions, never to who wrote that version (follow-ups 2026-11-17)", async () => {
    const writer = await employeeWith(["support.knowledge.manage", "support.knowledge.approve"]);
    const reviewer = await employeeWith(["support.knowledge.approve"]);
    const agent = await employeeWith(["support.ticket.read"]);
    const article = (slug: string, titleAr: string) => ({ slug, kind: "guide" as const, audience: "public" as const, titleAr, bodyAr: "## قبل أن تبدأ\nافصل الجهاز عن الكهرباء.", reason: "مقال" });
    expect(queueOf(await waitingFor(reviewer), "knowledge_review")).toBeNull();

    // an article submitted for review
    const first = await saveArticle(t.db, writer.actor, article("bell-review-one", "تنظيف مراوح الجهاز"), NOW);
    await submitArticle(t.db, writer.actor, { articleId: first.articleId, expectedUpdatedAt: (await getArticleEditor(t.db, writer.actor, first.articleId)).updatedAt }, NOW + 1);
    expect(queueOf(await waitingFor(reviewer), "knowledge_review")).toEqual({ id: "knowledge_review", module: "support", count: 1, href: "/admin/support/knowledge?view=review" });
    // an approved article with a revision waiting (the help centre keeps the approved text until it is decided)
    const second = await saveArticle(t.db, writer.actor, article("bell-review-two", "تحديث برنامج اليد"), NOW);
    await submitArticle(t.db, writer.actor, { articleId: second.articleId, expectedUpdatedAt: (await getArticleEditor(t.db, writer.actor, second.articleId)).updatedAt }, NOW + 1);
    await decideArticle(t.db, reviewer.actor, { articleId: second.articleId, decision: "approve", expectedUpdatedAt: (await getArticleEditor(t.db, reviewer.actor, second.articleId)).updatedAt }, NOW + 2);
    expect(queueOf(await waitingFor(reviewer), "knowledge_review")?.count).toBe(1);
    await saveArticle(t.db, writer.actor, { ...article("bell-review-two", "تحديث برنامج اليد (نسخة جديدة)"), articleId: second.articleId, expectedUpdatedAt: (await getArticleEditor(t.db, writer.actor, second.articleId)).updatedAt }, NOW + 3);
    const queue = queueOf(await waitingFor(reviewer), "knowledge_review");
    expect(queue?.count).toBe(2);
    expect(await countArticlesToApprove(t.db, reviewer.actor)).toBe(2);
    // the link's list shows exactly those rows
    expect((await listArticles(t.db, reviewer.actor, { view: "review", q: "" }, "ar")).rows.map((row) => row.slug).sort()).toEqual(["bell-review-one", "bell-review-two"]);
    // who wrote both versions may not approve them: not asked; an agent who only reads is not asked either
    expect(queueOf(await waitingFor(writer), "knowledge_review")).toBeNull();
    expect(await countArticlesToApprove(t.db, writer.actor)).toBe(0);
    expect(queueOf(await waitingFor(agent), "knowledge_review")).toBeNull();
    expect(await countArticlesToApprove(t.db, agent.actor)).toBeNull();
    // approved: nothing waits any more
    await decideArticle(t.db, reviewer.actor, { articleId: first.articleId, decision: "approve", expectedUpdatedAt: (await getArticleEditor(t.db, reviewer.actor, first.articleId)).updatedAt }, NOW + 4);
    expect(queueOf(await waitingFor(reviewer), "knowledge_review")?.count).toBe(1);
  });

  test("returns: repairs past their target date — the repairs list's «late» view", async () => {
    await t.db.insert(repairTickets).values([
      { id: "rep_bell_late", ref: "RP-BELL0001", phoneE164: "+9647700000101", issue: "الشاشة لا تعمل", status: "diagnosing", slaDueAt: NOW - DAY, createdAt: NOW - 3 * DAY },
      { id: "rep_bell_ok", ref: "RP-BELL0002", phoneE164: "+9647700000102", issue: "الشحن متقطع", status: "received", slaDueAt: NOW + DAY, createdAt: NOW - DAY },
      { id: "rep_bell_ready", ref: "RP-BELL0003", phoneE164: "+9647700000103", issue: "أزرار عالقة", status: "ready", slaDueAt: NOW - DAY, createdAt: NOW - 3 * DAY },
    ]);
    const technician = await employeeWith(["returns.repair.manage"]);
    const queue = queueOf(await waitingFor(technician), "repairs_late");
    expect(queue).toMatchObject({ module: "returns", count: 1, href: "/admin/returns/repairs?view=late" });
    const list = await listRepairs(t.db, technician.actor, parseRepairFilters(new URL(queue!.href, ORIGIN).searchParams), "ar", NOW);
    expect(list.total).toBe(queue!.count);
  });

  test("channels: webhook deliveries that stopped retrying — the monitor's «gave up» list", async () => {
    await t.db.insert(webhooks).values({ id: "whk_bell", name: "مستقبل تجريبي", url: "https://example.test/hook", secretEnc: "enc", events: ["order.confirmed"], createdAt: NOW - DAY });
    await t.db.insert(webhookDeliveries).values([
      { id: "whd_bell_1", webhookId: "whk_bell", event: "order.confirmed", eventId: "evt_bell_1", payload: {}, status: "gave_up", attempts: 8, createdAt: NOW - DAY },
      { id: "whd_bell_2", webhookId: "whk_bell", event: "order.confirmed", eventId: "evt_bell_2", payload: {}, status: "failed", attempts: 2, createdAt: NOW - HOUR },
    ]);
    const manager = await employeeWith(["channels.webhook.manage"]);
    const queue = queueOf(await waitingFor(manager), "webhooks_gave_up");
    expect(queue).toMatchObject({ module: "channels", count: 1, href: "/admin/channels/monitor?status=gave_up#ch-deliveries" });
    const list = await listDeliveries(t.db, manager.actor, parseDeliveryFilters(new URL(queue!.href, ORIGIN).searchParams));
    expect(list.total).toBe(queue!.count);
    expect(queueOf(await waitingFor(await employeeWith(["channels.integration.read"])), "webhooks_gave_up")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── cost

/** One statement sent through the recording binding: its SQL, when it started and finished. */
type Recorded = { sql: string; params: unknown[]; rows: number; startedAt: number; finishedAt: number | null };

/** A D1 binding that writes down every statement (a batch counts as one); each waits a macrotask before it runs. */
function recordingD1(real: D1Database): { d1: D1Database; log: Recorded[] } {
  const log: Recorded[] = [];
  let tick = 0;
  const REAL = Symbol("the real statement");
  const timed = async <T>(sql: string, params: unknown[], call: () => Promise<T>, rows: (value: T) => number): Promise<T> => {
    const entry: Recorded = { sql, params, rows: 0, startedAt: ++tick, finishedAt: null };
    log.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = await call();
    entry.rows = rows(value);
    entry.finishedAt = ++tick;
    return value;
  };
  const wrap = (statement: D1PreparedStatement, sql: string, params: unknown[]): D1PreparedStatement =>
    ({
      [REAL]: statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql, values),
      all: () => timed(sql, params, () => statement.all(), (result) => result.results.length),
      raw: () => timed(sql, params, () => statement.raw(), (result) => result.length),
      first: (column?: string) => timed(sql, params, () => (column === undefined ? statement.first() : statement.first(column)), (row) => (row === null ? 0 : 1)),
      run: () => timed(sql, params, () => statement.run(), () => 0),
    }) as unknown as D1PreparedStatement;
  const unwrap = (statement: D1PreparedStatement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? statement;
  const d1 = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch: (statements: D1PreparedStatement[]) => timed("batch", [], () => real.batch(statements.map(unwrap)), (results) => results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0)),
    exec: (sql: string) => real.exec(sql),
  };
  return { d1: d1 as unknown as D1Database, log };
}

describe("what the bell costs", () => {
  test("the owner's bell: the shell's one batch and every module's first statement sent at once — the new ones too", async () => {
    const owner = await employeeWith([...defaultRolePermissions("owner")] as Permission[]);
    const recording = recordingD1(t.d1);
    const db = createDb(recording.d1);
    const started = Date.now();
    const waiting = await loadWaiting(db, sessionOf(owner), NOW);
    const elapsedMs = Date.now() - started;
    const statements = recording.log;
    const firstBack = Math.min(...statements.map((entry) => entry.finishedAt ?? Infinity));
    const firstWave = statements.filter((entry) => entry.startedAt < firstBack);
    const sent = (pattern: RegExp, param?: string) => firstWave.some((entry) => pattern.test(entry.sql) && (param === undefined || entry.params.includes(param)));
    expect(sent(/^batch$/)).toBe(true);
    expect(statements.filter((entry) => entry.sql === "batch")).toHaveLength(1);
    // the polish round's modules: the orders review list, used prices, refund reviews, marketing's three, the
    // webhooks, automation's three, the returns counts — all in the first wave, never one after the other
    for (const [pattern, param] of [
      [/review_status/, undefined],
      [/"approvals"/, "used_price"],
      [/WITH w AS/, undefined],
      [/marketing_campaign|FROM campaigns/, undefined],
      [/FROM reviews/, undefined],
      [/webhook_deliveries/, undefined],
      [/reorder_suggestions/, undefined],
      [/"workflows"/, undefined],
      [/workflow_runs/, undefined],
      [/"repair_tickets"/, undefined],
    ] as const) expect(sent(pattern, param), String(pattern)).toBe(true);
    // the returns module reads only the counts the bell shows: never its SLA setting
    expect(statements.some((entry) => /"settings"/.test(entry.sql) && entry.params.includes("returns.sla"))).toBe(false);
    // the measure, for the area doc (docs/areas/admin-shell.md)
    console.info(`[bell cost] owner: ${statements.length} statements (1 batch), ${firstWave.length} sent before the first came back, ${statements.reduce((sum, entry) => sum + entry.rows, 0)} rows, ${waiting.queues.length} queues, ${elapsedMs} ms`);
    expect(firstWave.length).toBeGreaterThan(statements.length / 2);
  });
});
