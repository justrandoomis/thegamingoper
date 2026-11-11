/**
 * FIFO costing — pure helpers (no database). [P]: everything here is protected cost data; it is
 * computed on the server and written to [P] columns, never returned to shoppers.
 *
 * A sale or a write-off takes units from the OLDEST cost layer of that variant at that location
 * first (`cost_layers` ordered by received_at, then id). When the layers run out — stock that was
 * added by an adjustment without a cost — the remaining units are costed at the variant's standard
 * landed cost (`variant_costs.landed_cost_iqd`) when there is one, and left uncosted (null) when
 * there is not: an unknown cost is recorded as unknown, never as zero.
 */

export type CostLayerState = {
  id: string;
  /** Units left in the layer. Mutated by takeFifo as units are taken. */
  qtyRemaining: number;
  unitCostIqd: number;
};

export type FifoSlice = {
  /** The layer the units came from; null when no layer covered them. */
  layerId: string | null;
  qty: number;
  /** Cost per unit of this slice; null when nothing is known about the cost. */
  unitCostIqd: number | null;
  /** True when the cost is the standard cost, not a layer's. */
  fallback: boolean;
};

/**
 * Takes `qty` units from `layers` (oldest first, already sorted) and returns the slices, consuming
 * the layers in place so the next call for the same variant and location continues where this one
 * stopped.
 */
export function takeFifo(layers: CostLayerState[], qty: number, fallbackCostIqd: number | null): FifoSlice[] {
  if (!Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`takeFifo: qty must be a whole number ≥ 0, got ${qty}`);
  const slices: FifoSlice[] = [];
  let left = qty;
  for (const layer of layers) {
    if (left === 0) break;
    if (layer.qtyRemaining <= 0) continue;
    const take = Math.min(layer.qtyRemaining, left);
    layer.qtyRemaining -= take;
    left -= take;
    slices.push({ layerId: layer.id, qty: take, unitCostIqd: layer.unitCostIqd, fallback: false });
  }
  if (left > 0) slices.push({ layerId: null, qty: left, unitCostIqd: fallbackCostIqd, fallback: true });
  return slices;
}

/** Total cost of slices; null when any unit has no known cost. */
export function costOfSlices(slices: readonly FifoSlice[]): number | null {
  let total = 0;
  for (const slice of slices) {
    if (slice.unitCostIqd === null) return null;
    total += slice.unitCostIqd * slice.qty;
    if (!Number.isSafeInteger(total)) throw new RangeError("costOfSlices: total is too large to compute exactly");
  }
  return total;
}
