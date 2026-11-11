# Admin module 04 — Inventory and warehouses

Owner: admin inventory. Blueprint functions 04.01–04.10 and 04.12 (04.11 pick-pack-ship belongs to the orders module).
Arabic first (RTL), English second. Everything that moves stock goes through the commerce core
(`services/inventory/stock.server.ts`) or the core-level transfers file this module added
(`services/inventory/transfers.server.ts`, CONTRACTS §1); the module's own services (`services/admin/inventory/**`)
read, validate, check permissions and write only documents (locations, counts) and planning columns (reorder points).

## Routes (`app/routes/admin/inventory/routes.ts`, all under the module layout)

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/inventory` | waiting decisions (raised cards only when there is one), figures, quick actions, latest movements, `<ModuleFunctions moduleId="04">` | `inventory.stock.read` |
| `/stock` | on hand / reserved / available / incoming per SKU, all locations or one; search, state, sort, page in the URL | `inventory.stock.read` |
| `/stock/:variantId` | one SKU: per location, forecast, reservations, open transfers, serials, cost layers, movements; adjust / damage dialog (oversell exception), reorder dialog | read / `inventory.stock.adjust`, `inventory.reorder.manage` |
| `/locations`, `/locations/:id`, `/locations/labels` | tree, add (warehouse, shop, or aisle → shelf → bin inside), edit, label print view (Code 128 + QR) | read / `inventory.location.manage` |
| `/receive` | receiving session: scan, count, inspect, serials, cost (cost.read) | read / `inventory.stock.receive` |
| `/movements` (+ `/movements/export`) | the immutable log, filters, CSV (≤ 10,000 rows) | `inventory.movement.read` |
| `/counts`, `/counts/:id` | start (all / chosen SKUs / random sample), count (scan), submit, approve, send back, cancel | read / `inventory.count.perform`, `inventory.count.approve` |
| `/reorder` | days of cover, stock-out date, suggested quantity, filters with counts | `inventory.stock.read` |
| `/transfers`, `/transfers/:id` | create (SKU lines, scanned or typed), ship, receive, close a shortfall, cancel, print slip | read / `inventory.transfer.create`, `.receive`, `inventory.stock.adjust` |
| `/reservations` | holds per order, expiry, manual release | read / `inventory.reservation.release` |
| `/oversell` | negative levels now and the authorised exceptions (who, why) | `inventory.stock.read` |
| `/costing` | FIFO layers per batch, valuation | `cost.read` (+ `inventory.stock.read`) |
| `/reports` (+ `/reports/export`) | dead stock, turnover, sales vs inbound; CSV | `inventory.report.read` |
| `/serials`, `/serials/:id` | find a unit, its order links and (with `inventory.movement.read`) its movements | `inventory.serial.read` |
| `/scan` | JSON lookup for the scan fields (SKU, barcode, serial, location) | `inventory.stock.read` |

Every loader and action starts with `requireEmployee(ctx, db, permission)` (`inventory.server.ts → openInventory`);
every service calls `assertCan` again. Branch-limited employees act only on their branch's locations.

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Where / what is missing |
|---|---|---|
| 04.01 | implemented | `/stock`, `/stock/:id` |
| 04.02 | implemented | `/locations` — level = depth (warehouse/shop → aisle → shelf → bin), labels print from the browser |
| 04.03 | implemented | `/receive` — receipts against purchase orders and their posting to the books are purchasing's (09) |
| 04.04 | implemented | `/movements` |
| 04.05 | partial | `/counts` — serial-tracked differences are listed, not posted (no single-serial write-off in the core) |
| 04.06 | implemented | `/reorder` + reorder points on the SKU page; a suggestion becomes a PO in purchasing (09) |
| 04.07 | implemented | `/transfers` |
| 04.08 | implemented | `/reservations` (+ the scheduled job `inventory.reservations.expire`) |
| 04.09 | implemented | `/oversell`, adjust dialog, count approval |
| 04.10 | partial | `/costing` — FIFO per location only; no weighted-average policy to choose |
| 04.12 | implemented | `/reports` |

## Rules this module keeps

- **No serial sold twice** (acceptance #1): serials enter only through `receiveStock` (unique), travel in transfers as
  `intake` (not sellable or packable — the `serials_status_guard` trigger sells only from in_stock/reserved), and a
  used device's serial never travels in a transfer. Tests: `tests/admin-inventory-transfers.test.ts`, `admin-inventory.test.ts`.
- **No negative available stock without an authorised, documented exception** (acceptance #1, 04.09): transfers never
  take reserved units; adjustments and count approvals that would oversell need an explicit request plus
  `inventory.oversell.authorize`, and a reason in the audit trail; the exception closes when the level is whole.
- **Every movement has a reason, a reference, an actor and a time** (acceptance #3): transfer movements carry
  "TR-…: FROM → TO" (+ the employee's words for a shortfall), receipts "RCV-… · #doc · inspection…", count postings
  "CC-… [line]: counted x, expected y — reason" — the generated words in the employee's admin language (ar/en).
  Core sale/reserve rows without a reason show their kind and order reference in the log.
- **Cost privacy** (acceptance #5): value, unit costs, cost layers, COGS and standard costs are selected only for
  `cost.read` — absent (not blank) from loader data, JSON (`/scan`) and both CSV exports otherwise. A clerk without
  `cost.read` receives at the variant's standard landed cost without seeing it; with no standard cost the line is
  refused (`cost_unknown`), never received at zero.
- **The movement log is `inventory.movement.read`'s**, also as a SKU's latest rows or a unit's history (absent, not
  empty, for cashiers, support and fulfillment); serial numbers only with `inventory.serial.read`.
- **Two people for counts**: whoever started or counted cannot approve (`count_self_approval`), also after a colleague
  re-counted their line. **Blind**: while a count is open nothing that reveals the system quantity reaches a counter —
  not on the count's page, not as the list's "differences" (null). A manual adjustment's reason may not start like a
  count's posting ("CC-… [", `reason_reserved`): the inventory role both counts and adjusts.
- **Postings resume, never repeat**: a line counts as posted when an adjustment "CC-… [line]" is at least as recent as
  its last counting. An approval stopped half way (stock changed, connection lost) is finished by approving again; after
  a send-back a recounted line posts only its new difference (expected = on hand when counted, earlier postings
  included). A count with any posting cannot be cancelled (`count_partially_posted`, re-checked in the batch); the page
  says so and hides "cancel"; the approval dialog's impact and toast count only what is still to post.
- **Double submits**: transfer creation and counts derive their id from the idempotency key; ship/cancel are guarded
  status changes; transfer receipts and shortfalls build the key into their movement ids; receipts, adjustments and
  count postings (per line and counting) are claimed once (`claimOnce`, released on failure).
- **Locations**: switching one off is refused while it holds or expects stock, has an open count or active children —
  checked again inside the writing batch (a transfer shipped meanwhile would be stranded).
- **Dates** in Asia/Baghdad; money integer IQD; RTL first; dense tables from 768px, cards on phones. Number fields keep
  Arabic-Indic digits typed on an Arabic keyboard (as 0–9).

## Adversarial review (2026-11-11) — defects found and fixed

Tests: `tests/admin-inventory-adversarial.test.ts` (18; each failed before its fix). The route-level and UX fixes were
checked over HTTP and in the browser instead.
- Transfers (core file): a receipt racing a shortfall close brought written-off units in again; a close racing a
  receipt wrote off units that had arrived. The shortfall dialog showed the whole transfer's value, not the missing
  units' (and only `cost.read` sees it).
- Receiving: a serial registered again in other letters ("sn-1" / "SN-1"); a receipt retried after its inspection record
  failed was received twice.
- Counts: the two-person rule fell to a colleague's re-count; two counts opened at once for one location; the counter's
  data carried the system quantity; the home page asked supervisors to approve their own count; a half-posted count could
  be cancelled as "nothing posted" and a recounted line never posted its new difference; an approval racing a send-back
  posted every line and answered "replayed"; the list's "differences" told a counter whether the count matched; a
  hand-typed "CC-… [line]" reason made the approval skip a difference.
- Reservations: a branch-limited employee released another branch's stock; a release racing the start of packing; the
  release dialog counted only the rows on the page.
- Authorization: a SKU's page and a unit's history carried the movement log to roles without
  `inventory.movement.read`; `/costing` and `/serials` answered 500 instead of 403 to a role missing their second
  permission.
- Locations: a location could be switched off while a transfer to it shipped.
- UX: Arabic-Indic digits typed into count/receive/adjust quantities were dropped; the transfer slip printed light text
  from a dark screen (now light while printing, `usePrintInLight`); a failed scan lookup read "unknown code"; the release
  toast claimed units when nothing was held any more; an empty "Actions" column for read-only roles; plural wording.

## Boundaries (honest)

- Barcode/QR readers: keyboard-wedge input only (the reader types and presses Enter); no camera scanning.
- Printers: labels and the transfer slip print from the browser (print CSS); no printer integration.
- Receipts made here are not posted to the journal (`receiveStock` does not post); purchasing (09) posts PO receipts.
- The weekly/periodic schedule of counts is a person's decision; nothing schedules counts automatically.
- Blind counting hides the system quantity on the count's own screens; the stock pages still show on-hand figures to
  holders of `inventory.stock.read`.
- Left open (narrow windows, documented): two receipts of one serial in different letters at the same instant (the
  database index is case-sensitive); a send-back landing while an approval is posting a line (at most that line).
- A refused form returns 400/409, which the browser logs in the console.
- Demo records (local dev database only): locations `DEMO-SHOP-*`/`DEMO-A*`/`DEMO-RV-*`, serials `DEMO-SN-*`, sessions
  `RCV-*`, transfers `TR-*`, counts `CC-*`, employees `demo.inventory.*@tamtam.local`.
- Checked in Chromium (Edge) only; the Sorani strings need a native reader.

## Requests to other owners

- **Commerce core**: (1) a single-serial write-off/registration operation (status → scrapped with a 'count'/'damage'
  movement, FIFO layer consumed; found units re-registered) so serial count differences can be posted (04.05 → done);
  (2) `adjustStock` could accept `ref: { type, id }` and kind `'count'`, so count postings reference the count id
  instead of carrying it in the reason (the reason prefix is reserved meanwhile); (3) add the texts of
  `TRANSFER_ERROR_KEYS` to `app/i18n/messages/errors.ts` (they live in `admin-inventory` meanwhile).
- **Schema owner**: a unique index on `upper(serial)` (or `COLLATE NOCASE`), so no two rows can name one unit in
  different letters even at the same instant.
- **Purchasing (09)**: keep `po_items.qty_received` and PO statuses current — this module's "incoming" reads them.
- **Shell**: a queue entry for counts awaiting approval (`cycle_counts.status = 'review'`, holders of
  `inventory.count.approve`, never the counter) and transfers in transit (holders of `inventory.transfer.receive`).

## Verify

```
npx vitest run tests/admin-inventory-transfers.test.ts tests/admin-inventory.test.ts tests/admin-inventory-adversarial.test.ts   # 9 + 20 + 18
npx vitest run tests/i18n.test.ts                                                      # admin-inventory namespace
node scripts/lint-design.mjs app/routes/admin/inventory                                # 0 findings
```

Browser (puppeteer-core + Edge; demo inventory clerk, manager and cashier): HTTP matrix per role (pages, `.data`, CSV,
JSON, actions → 403; POST without Origin → 403); flows (finishing a half-posted count with keyboard-only dialog checks,
Arabic digits, the reserved reason); screenshots `.shots/admin-inventory/review/` (26 views × 390/1440 × ar/en ×
light/dark, error states, and the labels and transfer slip printed at A4 from light and dark screens).
