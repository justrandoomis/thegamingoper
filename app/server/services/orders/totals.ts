/**
 * Order and cart totals — pure integer arithmetic, no database, safe to import anywhere.
 *
 *   const totals = computeTotals({ lines: [{ unitPriceIqd: 749_000, qty: 1 }], discountIqd: 25_000, shippingIqd: 5_000 });
 *   // { subtotalIqd: 749000, discountIqd: 25000, shippingIqd: 5000, totalIqd: 729000 }
 *
 * The same rule the database enforces with a CHECK on `orders`:
 *   total = subtotal − discount + shipping          (tax is not configured; prices are tax-inclusive)
 * and on every line:
 *   line total = unit price × qty
 *
 * Every amount is a whole number of Iraqi dinars. Anything else — NaN, Infinity, a fraction, a
 * negative amount, a discount larger than the subtotal, a number too large to add exactly — is a bug
 * upstream, so it throws `TotalsError` instead of producing a wrong total.
 */

export class TotalsError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "TotalsError";
  }
}

export type TotalsLine = { unitPriceIqd: number; qty: number };

export type TotalsInput = {
  lines: readonly TotalsLine[];
  /** Coupon / promotion discount on the whole order. Never more than the subtotal. */
  discountIqd: number;
  shippingIqd: number;
};

export type Totals = { subtotalIqd: number; discountIqd: number; shippingIqd: number; totalIqd: number };

function amount(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TotalsError(`${what} must be a whole number of dinars, got ${String(value)}`);
  if (value < 0) throw new TotalsError(`${what} must not be negative, got ${value}`);
  return value;
}

function exact(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new TotalsError(`${what} is too large to compute exactly`);
  return value;
}

/** unit price × qty, checked. `qty` must be a positive whole number. */
export function lineTotalIqd(unitPriceIqd: number, qty: number): number {
  amount(unitPriceIqd, "Unit price");
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 1) throw new TotalsError(`Quantity must be a positive whole number, got ${String(qty)}`);
  return exact(unitPriceIqd * qty, "Line total");
}

/** Sum of the line totals. An empty list is 0. */
export function subtotalIqd(lines: readonly TotalsLine[]): number {
  let sum = 0;
  lines.forEach((line, index) => {
    sum = exact(sum + lineTotalIqd(line.unitPriceIqd, line.qty), `Subtotal (at line ${index + 1})`);
  });
  return sum;
}

export function computeTotals(input: TotalsInput): Totals {
  if (!input || !Array.isArray(input.lines)) throw new TotalsError("Totals need a list of lines");
  const subtotal = subtotalIqd(input.lines);
  const discount = amount(input.discountIqd, "Discount");
  const shipping = amount(input.shippingIqd, "Shipping");
  if (discount > subtotal) throw new TotalsError(`Discount ${discount} is larger than the subtotal ${subtotal}`);
  const total = exact(subtotal - discount + shipping, "Total");
  return { subtotalIqd: subtotal, discountIqd: discount, shippingIqd: shipping, totalIqd: total };
}
