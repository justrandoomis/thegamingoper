/**
 * Admin module 03 "pricing" — module follow-up (2026-11-12). The test failed before the follow-up (the helper did not
 * exist; admin 08 kept its own copy of the query):
 *
 *   · referencePrices(db, variantIds, now): the 30-day reference price of a list of SKUs — the highest price in force
 *     during the drop window, never below today's — what a cut is measured from, for every module that cuts prices
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { priceChanges, variants } from "~/server/db/schema";
import { referencePrices } from "~/server/services/admin/pricing/reference.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

describe("admin 03 pricing — follow-up", () => {
  test("the 30-day reference price of several SKUs at once: the highest price in force in the window", async () => {
    const cut = await make.product({ priceIqd: 80_000 });
    const steady = await make.product({ priceIqd: 50_000 });
    const old = await make.product({ priceIqd: 30_000 });
    await t.db.update(variants).set({ createdAt: NOW - 200 * DAY }).where(eq(variants.id, cut.variantId));
    await t.db.update(variants).set({ createdAt: NOW - 200 * DAY }).where(eq(variants.id, old.variantId));
    // cut from 100,000 to 80,000 ten days ago (no second person): the window still remembers 100,000
    await t.db.insert(priceChanges).values({ id: newId("pch"), variantId: cut.variantId, oldPriceIqd: 100_000, newPriceIqd: 80_000, status: "applied", createdAt: NOW - 10 * DAY } as typeof priceChanges.$inferInsert);
    // cut from 45,000 to 30,000 sixty days ago: outside the window
    await t.db.insert(priceChanges).values({ id: newId("pch"), variantId: old.variantId, oldPriceIqd: 45_000, newPriceIqd: 30_000, status: "applied", createdAt: NOW - 60 * DAY } as typeof priceChanges.$inferInsert);
    const reference = await referencePrices(t.db, [cut.variantId, steady.variantId, old.variantId, "var_unknown"], NOW);
    expect(reference.get(cut.variantId)).toBe(100_000);
    expect(reference.get(steady.variantId)).toBe(50_000);
    expect(reference.get(old.variantId)).toBe(30_000);
    expect(reference.has("var_unknown")).toBe(false);
  });
});
