/**
 * Admin search and the catalogue's kept tokens (polish round, 2026-11-13).
 *
 * Product names keep Latin tokens whole with U+2011 NON-BREAKING HYPHEN («USB‑C», «Joy‑Con», «Z‑A» — the catalogue
 * refuses a plain hyphen there, catalog/README.md), while staff type a plain "-" (U+002D). The admin's two product
 * searches — the command centre's global search (01.06, its SKU group) and the catalogue's product list (02.01) —
 * fold both sides, so "USB-C", "usb-c" and the kept form itself all find the battery; a name typed with a plain hyphen
 * is found by a kept-hyphen needle too (and the global search's NFKC turns U+2011 into U+2010, folded the same way).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { EmployeeActor } from "~/server/actor";
import { products } from "~/server/db/schema";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { listProducts, parseProductFilters } from "~/server/services/admin/catalog/product.server";
import { globalSearch } from "~/server/services/admin/dashboard/search.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type ProductFixture } from "./helpers/factories";

let t: TestDb;
let battery: ProductFixture;
let grip: ProductFixture;

const actorOf = (role: DefaultRoleKey): EmployeeActor => ({ kind: "employee", id: `emp_hyphen_${role}`, permissions: defaultRolePermissions(role), label: role });
const KEPT = "‑";

beforeAll(async () => {
  t = await createTestDb();
  const make = fixtures(t.db, TEST_NOW);
  battery = await make.product({ kind: "accessory", priceIqd: 25_000, stock: 3 });
  grip = await make.product({ kind: "accessory", priceIqd: 40_000, stock: 1 });
  // the catalogue's own name (catalog/products/xbox-rechargeable-battery-usb-c.json): the token kept with U+2011
  const name = `Xbox Rechargeable Battery + USB${KEPT}C Cable`;
  await t.db.update(products).set({ name: { ar: name, en: name, ckb: name } }).where(eq(products.id, battery.productId));
  // an owner-typed name with a plain hyphen (an older record, or typed in the editor)
  await t.db.update(products).set({ name: { ar: "قبضة شحن Joy-Con 2", en: "Joy-Con 2 Charging Grip", ckb: "Joy-Con 2 Charging Grip" } }).where(eq(products.id, grip.productId));
}, 120_000);

afterAll(async () => {
  await t?.dispose();
});

describe("a plain hyphen finds a kept token (and the other way round)", () => {
  test("global search (01.06): «USB-C» and «usb-c» find the battery in the SKU group, in Arabic and in English", async () => {
    for (const q of ["USB-C", "usb-c", `USB${KEPT}C`, "battery + usb-c"]) {
      for (const locale of ["ar", "en"] as const) {
        const found = await globalSearch(t.db, actorOf("inventory"), { q }, locale, TEST_NOW);
        expect(found.groups.skus?.map((hit) => hit.sku), `${q} (${locale})`).toContain(battery.sku);
      }
    }
    // a kept hyphen typed (or pasted from the storefront) still finds a plain-hyphen name
    const kept = await globalSearch(t.db, actorOf("inventory"), { q: `joy${KEPT}con` }, "en", TEST_NOW);
    expect(kept.groups.skus?.map((hit) => hit.sku)).toContain(grip.sku);
    // the fold does not widen the match: another token is not found
    const other = await globalSearch(t.db, actorOf("inventory"), { q: "USB-A" }, "en", TEST_NOW);
    expect(other.groups.skus?.map((hit) => hit.sku)).not.toContain(battery.sku);
  });

  test("the catalogue's product list (02.01): «USB-C» and «usb-c» find the battery", async () => {
    for (const q of ["USB-C", "usb-c", `USB${KEPT}C`, `usb‐c`]) {
      const page = await listProducts(t.db, actorOf("content"), parseProductFilters(new URLSearchParams({ q })), "ar", TEST_NOW);
      expect(page.rows.map((row) => row.id), q).toContain(battery.productId);
    }
    const kept = await listProducts(t.db, actorOf("content"), parseProductFilters(new URLSearchParams({ q: `Joy${KEPT}Con` })), "en", TEST_NOW);
    expect(kept.rows.map((row) => row.id)).toContain(grip.productId);
    const other = await listProducts(t.db, actorOf("content"), parseProductFilters(new URLSearchParams({ q: "USB-A" })), "ar", TEST_NOW);
    expect(other.rows.map((row) => row.id)).not.toContain(battery.productId);
  });
});
