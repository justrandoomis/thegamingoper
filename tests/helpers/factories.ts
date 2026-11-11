/**
 * Small builders for rows that almost every database test needs. They write through the real
 * schema, so foreign keys, CHECK constraints and triggers all apply — a fixture that the database
 * would refuse in production is refused here too.
 *
 *   const make = fixtures(t.db);
 *   const console5 = await make.product({ priceIqd: 749_000, stock: 2 });
 *   const customerId = await make.customer();
 *   const order = await make.order([{ ...console5, qty: 1 }], { customerId });
 *   const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "cod", status: "paid" });
 *
 * Everything gets a unique id / slug / SKU / phone per call. Stock goes to the seeded main
 * location (DEFAULT_LOCATION_ID); orders ship to Baghdad with the flat 5,000 IQD fee.
 */
import { newId } from "~/lib/ids";
import type { Db } from "~/server/db/drizzle.server";
import { customers, employees, orderItems, orders, payments, products, stockLevels, variants, type NewCustomer, type NewEmployee, type NewOrder, type NewPayment, type ProductKind } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, governorateId } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { TEST_NOW } from "./db";

export type ProductFixture = { productId: string; variantId: string; sku: string; priceIqd: number };
export type OrderLineInput = { variantId: string; sku: string; qty?: number; unitPriceIqd?: number; priceIqd?: number; usedUnitId?: string };
export type OrderFixture = { orderId: string; ref: string; itemIds: string[]; subtotalIqd: number; totalIqd: number };

export function fixtures(db: Db, now: number = TEST_NOW) {
  let counter = 0;
  /** "prefix-0001", unique within this fixture set. */
  const next = (prefix: string) => `${prefix}-${String(++counter).padStart(4, "0")}`;
  /** A valid, unique Iraqi mobile number in E.164 form. */
  const phone = () => `+96477${String(10_000_000 + ++counter).slice(-8)}`;

  return {
    next,
    phone,
    now,

    /** A published product with one default variant; `stock` puts that many units on hand at the main location. */
    async product(options: { kind?: ProductKind; priceIqd?: number; trackSerials?: boolean; stock?: number; allowOversell?: boolean; isDemo?: boolean } = {}): Promise<ProductFixture> {
      const productId = newId("prd");
      const variantId = newId("var");
      const sku = next("SKU");
      const priceIqd = options.priceIqd ?? 500_000;
      const statements: BatchStatement[] = [
        db.insert(products).values({
          id: productId,
          slug: next("product"),
          kind: options.kind ?? "console",
          name: { ar: "جهاز للاختبار", en: "Test console", ckb: "ئامێری تاقیکردنەوە" },
          status: "published",
          isDemo: options.isDemo ?? false,
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(variants).values({ id: variantId, productId, sku, priceIqd, isDefault: true, trackSerials: options.trackSerials ?? false }),
      ];
      if (options.stock !== undefined || options.allowOversell) {
        statements.push(db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: options.stock ?? 0, allowOversell: options.allowOversell ?? false }));
      }
      await runBatch(db, statements);
      return { productId, variantId, sku, priceIqd };
    },

    async customer(overrides: Partial<NewCustomer> = {}): Promise<string> {
      const id = overrides.id ?? newId("cus");
      await db.insert(customers).values({ id, phoneE164: phone(), name: "زبون للاختبار", createdAt: now, ...overrides });
      return id;
    },

    async employee(overrides: Partial<NewEmployee> = {}): Promise<string> {
      const id = overrides.id ?? newId("emp");
      await db.insert(employees).values({ id, email: `${next("employee")}@tamtam.test`, name: "موظف للاختبار", createdAt: now, ...overrides });
      return id;
    },

    /** A web order with its lines. Totals satisfy the CHECK constraints: total = subtotal − discount + shipping. */
    async order(lines: OrderLineInput[], overrides: Partial<NewOrder> = {}): Promise<OrderFixture> {
      const orderId = overrides.id ?? newId("ord");
      const ref = overrides.ref ?? next("TT");
      const priced = lines.map((line) => ({ ...line, qty: line.qty ?? 1, unit: line.unitPriceIqd ?? line.priceIqd ?? 500_000 }));
      const subtotalIqd = priced.reduce((sum, line) => sum + line.unit * line.qty, 0);
      const shippingIqd = overrides.shippingIqd ?? 5000;
      const discountIqd = overrides.discountIqd ?? 0;
      const totalIqd = subtotalIqd - discountIqd + shippingIqd;
      const itemIds = priced.map(() => newId("oit"));
      await runBatch(db, [
        db.insert(orders).values({
          id: orderId,
          ref,
          idempotencyKey: next("idem"),
          contactPhoneE164: phone(),
          governorateId: governorateId("baghdad"),
          addressText: "شارع للاختبار، قرب المدرسة",
          placedAt: now,
          ...overrides,
          subtotalIqd,
          discountIqd,
          shippingIqd,
          totalIqd,
        }),
        ...priced.map((line, index) =>
          db.insert(orderItems).values({
            id: itemIds[index],
            orderId,
            variantId: line.variantId,
            usedUnitId: line.usedUnitId ?? null,
            sku: line.sku,
            nameSnapshot: { ar: "جهاز للاختبار", en: "Test console" },
            unitPriceIqd: line.unit,
            qty: line.qty,
            totalIqd: line.unit * line.qty,
          }),
        ),
      ]);
      return { orderId, ref, itemIds, subtotalIqd, totalIqd };
    },

    /**
     * A payment row. Defaults to a collected cash-on-delivery payment. Manual transfers
     * (bank_transfer, zaincash) can only be `paid` with `verifiedBy` and `verifiedAt` — pass them,
     * or create the payment as `pending_verification`.
     */
    async payment(orderId: string, amountIqd: number, overrides: Partial<NewPayment> = {}): Promise<string> {
      const id = overrides.id ?? newId("pay");
      await db.insert(payments).values({ id, orderId, method: "cod", status: "paid", amountIqd, idempotencyKey: next("pay-idem"), createdAt: now, ...overrides });
      return id;
    },
  };
}

export type Fixtures = ReturnType<typeof fixtures>;
