/**
 * DEMO digital codes — so a gift card or a subscription can be ordered in the demo store and, once the order is paid,
 * delivers a code like a real one (orders/digital.server.ts). Design QA 2026-11-12: with no codes and nothing on hand
 * every code product read «نفد حالياً», and the digital template's orderable state could not be seen anywhere.
 *
 *   const rows = await demoDigitalCodeRows(buildDemoData(catalog), { dataKey, now });   // the rows, encrypted
 *   const result = await seedDemoDigitalCodes(db, now, { dataKey });                     // writes them (insert if missing)
 *
 * Every digital variant gets exactly its demo units on hand in codes (./pricing.ts demoCodeCount: DEMO_CODES_PER_VARIANT,
 * the last 2 of a discontinued card): one unit sold, one code delivered. A code says what it is — "DEMO-<SKU>-0001" is redeemable nowhere — and is stored
 * exactly as module 13 stores an imported one (admin/devices/codes.server.ts importCodes): AES-256-GCM with DATA_KEY,
 * bound to its row (context "digital_code:<id>", so it decrypts only there), the sha256 of the normalized text for
 * duplicates, status available, is_demo = 1 (a demo order takes demo codes only), the variant's demo landed cost [P].
 *
 * DATA_KEY is the environment's secret: a code encrypted with another key could never be shown to its buyer. So the
 * codes are not part of seedDemo() (its rows are plain data, replayable as SQL on any database); the local seed passes
 * the local key here, and without a key nothing is written. Ids are stable ("dgc_demo_<sku>_<n>"): a second run finds
 * the same rows and writes nothing (the ciphertext differs per run — a fresh IV — so rows are never rewritten).
 *
 * Node and Workers alike: WebCrypto only, no Node API.
 */
import { sha256Hex } from "~/lib/ids";
import { encryptSecret } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { digitalCodes, type NewDigitalCode } from "~/server/db/schema";
import { chunkRows, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { codeContext, normalizeCode } from "~/server/services/admin/devices/codes.server";
import type { DemoCatalog } from "./catalog/types";
import { loadDemoCatalog } from "./catalog/load";
import { DEMO_ACTOR_ID, demoId } from "./ids";
import { buildDemoData, type DemoData } from "./import";
import { DEMO_CODES_PER_VARIANT, demoCodeCount } from "./pricing";

export { DEMO_CODES_PER_VARIANT, demoCodeCount };

/** Stable id of the n-th (1-based) demo code of a SKU: "dgc_demo_" + the variant id's key + "_" + n. */
export const demoCodeId = (sku: string, n: number) => `dgc_demo_${demoId.variant(sku).slice("var_".length)}_${n}`;

/** The text of the n-th (1-based) demo code of a SKU: "DEMO-PSN-US-10-0001" — plainly not a real code. */
export const demoCodeText = (sku: string, n: number) => `DEMO-${sku.toUpperCase()}-${String(n).padStart(4, "0")}`;

/** The duplicate-detection hash module 13 stores for a code (admin/devices/codes.server.ts importCodes). */
export const codeHashOf = (code: string) => sha256Hex(`tamtam.digital_code.v1|${normalizeCode(code)}`);

export type DemoCodeOptions = { dataKey: string; now: number };

/** The demo codes of every digital variant of the catalogue (rows for `digital_codes`), encrypted with `dataKey`. */
export async function demoDigitalCodeRows(data: DemoData, { dataKey, now }: DemoCodeOptions): Promise<NewDigitalCode[]> {
  const rows: NewDigitalCode[] = [];
  for (const product of data.products) {
    if (product.kind !== "digital" || !product.source) continue;
    // exactly the variant's units on hand (./pricing.ts demoStock): none before release, the last 2 of a discontinued card
    const count = demoCodeCount(product.source);
    for (const variant of product.variants) {
      for (let n = 1; n <= count; n++) {
        const id = demoCodeId(variant.sku, n);
        const text = demoCodeText(variant.sku, n);
        rows.push({
          id,
          variantId: demoId.variant(variant.sku),
          codeEnc: await encryptSecret(text, dataKey, codeContext(id)),
          codeHash: await codeHashOf(text),
          status: "available",
          costIqd: variant.cost?.landedCostIqd ?? null,
          expiresAt: null,
          isDemo: true,
          createdBy: DEMO_ACTOR_ID,
          createdAt: now,
        });
      }
    }
  }
  return rows;
}

export type SeedDemoCodesResult =
  | { written: number; defined: number; skipped?: undefined }
  | { written: 0; defined: 0; skipped: "no_data_key" };

/**
 * Writes the demo codes that are missing (one batch). Needs seedDemo() first (the variants). Without a usable
 * DATA_KEY it writes nothing and says so — never a code that its environment could not decrypt.
 */
export async function seedDemoDigitalCodes(db: Db, now: number, options: { dataKey?: string | null; catalog?: DemoCatalog } = {}): Promise<SeedDemoCodesResult> {
  const dataKey = options.dataKey?.trim();
  if (!dataKey) return { written: 0, defined: 0, skipped: "no_data_key" };
  const data = buildDemoData(options.catalog ?? loadDemoCatalog());
  const rows = await demoDigitalCodeRows(data, { dataKey, now });
  // insert if missing: a code already there (same id, or the same text from module 13) is left as it is
  const statements: BatchStatement[] = chunkRows(digitalCodes, rows).map((chunk) => db.insert(digitalCodes).values(chunk).onConflictDoNothing());
  const results = await runBatch(db, statements);
  const written = results.reduce<number>((sum, result) => {
    const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
    return sum + (typeof changes === "number" ? changes : 0);
  }, 0);
  return { written, defined: rows.length };
}
