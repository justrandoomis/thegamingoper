/**
 * What the new-order and edit-draft pages share on the server: the choices (active suppliers, the locations this
 * employee may receive at), the form's defaults, and reading the posted form into savePurchaseOrder's input.
 */
import { data } from "react-router";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { defaultRateMicros } from "~/server/services/admin/pricing/costs.server";
import { baghdadDate, rateToText } from "~/server/services/admin/purchasing/rules";
import { supplierOptions } from "~/server/services/admin/purchasing/suppliers.server";
import { rows, text } from "./purchasing.server";

/** Prices are supplier cost data: writing an order needs cost.read too (403 inside the shell otherwise). */
export function assertCostReader(actor: Actor): void {
  if (!can(actor, "cost.read")) throw data({ error: "forbidden", permission: "cost.read" }, { status: 403 });
}

export async function orderChoices(db: Db, actor: Actor) {
  const [suppliers, tree] = await Promise.all([supplierOptions(db, actor), locationTree(db)]);
  const branch = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const locations = locationOptions(tree.filter((node) => node.isActive && (branch === null || node.branchId === branch)));
  return { suppliers: suppliers.map((option) => ({ value: option.value, label: option.label, currency: option.currency, paymentTerms: option.paymentTerms })), locations: locations.map((option) => ({ value: option.value, label: option.label })) };
}

export async function defaultRateText(db: Db, currency: string, now: number): Promise<string> {
  if (currency === "IQD") return "";
  return rateToText(await defaultRateMicros(db, currency, baghdadDate(now)));
}

export function defaultLocation(locations: readonly { value: string }[]): string {
  return locations.some((option) => option.value === DEFAULT_LOCATION_ID) ? DEFAULT_LOCATION_ID : (locations[0]?.value ?? "");
}

/** The posted order form as savePurchaseOrder's input. */
export function orderInput(form: FormData) {
  return {
    supplierId: text(form, "supplierId"),
    locationId: text(form, "locationId"),
    currency: text(form, "currency"),
    fxRate: text(form, "fxRate"),
    expectedOn: text(form, "expectedOn"),
    paymentTerms: text(form, "paymentTerms"),
    notes: text(form, "notes"),
    shipping: text(form, "shipping"),
    other: text(form, "other"),
    lines: rows(form, "lines", ["code", "qty", "unitCost"] as const),
  };
}
