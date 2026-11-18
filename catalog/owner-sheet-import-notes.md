# Owner's sheet import (2026-11-18): import and infrastructure notes

## Built

- **Catalogue fields.** These are optional: product `category` (a leaf category slug) and `variants[].sheetRow` (a row of `catalog/owner-sheet-2026-11-18.json`). Types are in `app/server/db/seed/demo/catalog/types.ts` (`OWNER_SHEET_FILE`, `OWNER_SHEET_SKIPPED_ROWS = [233]`). `load.ts` reads the sheet with the catalogue. It also defaults a missing `images`, `related`, `specs` or `highlights` to `[]`.
- **Checks.** Both the importer (`catalogImportProblems`) and `scripts/products/validate.mjs` check that:
  - a `category` is known and is a leaf;
  - each `sheetRow` is a whole number, exists in the sheet, is not row 233, and is used by only one variant in the whole catalogue;
  - the sheet was actually loaded.

  The validator also checks compatibility and `game.platforms` keys against `devices.ts`. A full run warns about unmapped rows; today there are 0. A product with no image is now a warning, not an error, and the importer accepts it.
- **Device.** The `ps4` generation and model ("PlayStation 4", platform playstation, device kind console, `product: null`, summary in ar/en/ckb). `game.platforms ["ps4"]` and compatibility `ps4` import without errors. There is no trade-in guide for it, because `buysDevice` needs a product.
- **Categories.** These are in `categories.ts` (ar/en/ckb), arranged in this tree:
  - **pc-peripherals** «ملحقات الحاسوب»: keyboards, mice, mouse-pads, microphones, speakers, monitors, gaming-glasses
  - **gaming-chairs** (top level)
  - **cables-power**: cables, ups-power
  - **lighting** (top level)

  `categoryOf()` uses `product.category` first. Tile photos come from the built research photos (Redragon K673, M808, P032, HyperX QuadCast, Redragon GS511, ASUS VG249QM1A, DXRacer Master). These have no tile photo yet because no product in them has an image: gaming-glasses, cables-power, cables, ups-power and lighting. The navigation is generic, so no change to the read layer was needed.
- **Owner mode.** `buildDemoData(catalog, { ownerSheet: true })` and `seedDemo(db, now, { ownerSheet: true })`. All four scripts pass it (`db:seed`, `db:reset`, `catalog:import`, `db:owner-sheet`); `db:seed -- --demo` gives the old all-demo catalogue. The tests of other areas call `seedDemo` without it, so for them nothing changes.
  - **A variant with a priced sheet row:** price = `priceIqd`, no "was" price, active. It gets 1 unit at `loc_main`, with an opening movement `smv_sheet_<sku>`: `ref_type owner_sheet`, reason «رصيد افتتاحي من جرد المالك 2026-11-18 (الصف n)», no unit cost, actor `seed:owner-sheet`. Reorder point is null.
  - **Its product:** `is_demo = 0`, published.
  - **Other variants of that product:** these are the ones not on the sheet, or on it without a price.
    - My choice: `is_active = 0` and price 0.
    - Stock is 0, except the unpriced row 173, which keeps its 1 unit.
    - If the researched default variant is not on the sheet, the first sheet variant becomes the default.
  - **A product whose rows have no price at all:** `draft`. Today that is `sandisk-extreme-microsd` (row 173).
  - **Every product on no row, and the demo store set:** `archived` (hidden, not deleted, still `is_demo = 1` with demo prices and stock).
  - **Demo used units:** `status = 'ready'`, so they are not listed.
- **Today's result:** 172 published, 1 draft and 90 archived products. 173 real products with 258 variants: 231 on sale and 27 inactive. Sum of sheet prices: 18,762,250 IQD.

## Cost (not invented)

Sheet items get no `variant_costs` row, no cost layer, and no unit cost on their movement. All of these allow a missing cost (`variant_costs` is a separate table), so nothing had to be invented. The owner enters costs through receiving or the pricing screen. Until then, reports and margin floors show these items as having no cost.

## Serials

The serial-tracked sheet consoles are `NS2-ZELDA40`, `NSW-OLED-WHT` and `NSW-OLED-NEON`. They get no fake serial: staff must scan each unit's real serial in before an order can ship.

**Research to check:** sheet row 54, "SWITCH OLED BLACK", is mapped to the neon variant.

## Production (one command)

```sh
npm run db:owner-sheet -- owner.sql          # = tsx scripts/seed.ts --overwrite --sql owner.sql (in memory, replay-checked; dev DB untouched)
npx wrangler d1 migrations apply DB --remote # if any are pending
npx wrangler d1 execute DB --remote --file owner.sql
```

Generated from the real catalogue just now: 3,664 statements, 5.6 MB; the longest statement is 20 KB. Replayed on an empty migrated database it matches the direct seed exactly.

The file is the usual seed (insert if missing, or with overwrite a refresh of descriptive content), plus `app/server/db/seed/demo/owner.ts`. That file's statements come before the inserts and move existing demo rows to the new state. Each one is a single-table `INSERT … SELECT`, `UPDATE` or `DELETE` with scalar sub-queries, never a compound SELECT. They:

- **Prices and on-sale flags:** set only while the variant has no `price_changes` row and the product has never been saved in the admin (`updated_by IS NULL`).
- **Stock:** set only while every movement of the variant is a seed's (`demo_seed` or `owner_sheet`) and nothing is reserved.
  - One `adjust` movement with a stable id (`smv_sheet_<sku>`, or `smv_sheet_out_<sku>` to take stock to 0) carries the difference.
  - `on_hand` becomes the sum of the movements. The fake DEMO serials are marked `scrapped` with a note.
  - On a new database, the opening movement is written only when the variant has no movement at all.

  Once staff record a sale, receipt, count or adjustment, that level is never touched again. Running the file twice cannot double stock.
- **Demo cost:** removes `variant_costs` rows the seed wrote (`updated_by IS NULL`) and zeroes the demo opening cost layer.
- **Products:** sets `is_demo = 0`, published or draft, and the category, or `archived`. This happens only if the admin never saved the product. `--overwrite` no longer resets `status`, `is_demo`, `updated_by`, `is_active` or `is_default`.
- **Demo used units:** take them off the listing.

Orders, customers and staff are never touched. The test replays the file twice on a demo-seeded database and compares the result with the direct seed. It also checks that a staff price change and a staff stock movement survive.

**Known limit:** if the admin re-publishes an archived demo product without saving it in the editor, a re-run archives it again. Saving it in the admin protects it.

## Local

`npm run db:reset` and `npm run catalog:import` have both been run on the final catalogue (262 files, 0 validator errors, every row except 233 mapped). Dev server checks:

- `/c/gaming-chairs`, `/c/keyboards` and `/en/c/ups-power` respond 200.
- `/p/dualsense` shows 95,000.
- `/p/playstation-5-slim` (archived) returns 404.

## Tests

- **New:** `tests/seed-owner-sheet.test.ts`, 16 tests, all passing. It builds its own catalogue from the research plus test products and a test sheet. It covers:
  - the validation rules, the categories and PS4;
  - owner-mode mapping;
  - a new database run twice;
  - moving a demo database with staff edits;
  - the SQL file applied twice.
- **Updated:** `tests/seed.test.ts` now accepts:
  - the new top-level categories and a catalogue-derived per-category count;
  - the catalogue file count;
  - `status` staying as it is under overwrite;
  - empty options stored as null;
  - an empty qualifier;
  - search ranking within the top 5;
  - pictureless PS4 and the new categories.
- **Results:** 103 of 104 pass across `seed`, `seed-owner-sheet` and `devices`.

**Remaining failure (research content, not code):** `AC4BF‑PS4`. Its variant note says "PS5 Slim Digital Edition need the add‑on Disc Drive" but does not say the original PS5 Digital Edition (2020) cannot play discs. The disc rule in seed.test requires that. The research file needs that one sentence.

## Typecheck

`tsc -p tsconfig.cloudflare.json` is clean. `tests/helpers/tsconfig.check.json` shows only `app/art/index.ts` "virtual:tt-art-lite", which belongs to another owner's work in progress. Earlier transient errors came from `app/art/seed.server.ts` and `vite.config.ts`.

## For the lead

- `app/routes/storefront/shell/chrome.ts` `SHEET_CATEGORY_KINDS` (not my file) lists the categories sheet's kinds. Add `pc`, `chairs`, `cables` and `lighting` if the mobile categories sheet should show them. The header, mega menu and `/c/` pages already show them.
- Trade-in price guides are still demo figures, worked out from placeholder prices. The owner's buy prices are not in the sheet.
- vitest sometimes reports `ECONNRESET` from workerd while the machine is busy. Re-running passes.
- I added the script `db:owner-sheet` to package.json.
