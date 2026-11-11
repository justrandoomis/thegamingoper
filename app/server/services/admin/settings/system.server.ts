/**
 * Admin 22.01, 22.05, 22.06 — read views of the settings module (settings.read for all of them):
 *
 *   currencyView     the base currency (IQD — every amount in the system is a whole number of dinars, by design, so it
 *                    is not a choice) and the store's USD rate with the date it took effect, who set it, the rates
 *                    scheduled and the history. The rate is changed in pricing (/admin/pricing/fx, pricing.fx_rate.manage),
 *                    which dates every change; this page links there.
 *   localeView       Iraq time (Asia/Baghdad, UTC+3, no daylight saving: every business day, report and due time uses
 *                    it), how dates read in each language, the languages of the store and of the admin.
 *   environmentView  the deployment's mode — STORE_MODE (demo | live) and APP_ENV are deploy variables (wrangler), so the
 *                    page shows them and how much demo data exists; it never offers a switch it cannot perform.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { LOCALE_CODES, pick, type Locale } from "~/lib/locales";
import { formatDateTime } from "~/lib/dates";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employees, fxRates, taxRates } from "~/server/db/schema";
import { storeRateAt } from "~/server/services/admin/pricing/fx.server";

export type RateView = { id: string; iqdPerUnit: number; source: string; isDemo: boolean; effectiveAt: number; createdAt: number; by: string | null };

export type CurrencyView = { base: "IQD"; quote: "USD"; current: RateView | null; scheduled: RateView[]; history: RateView[]; canManage: boolean };

export async function currencyView(db: Db, actor: Actor, now: number): Promise<CurrencyView> {
  assertCan(actor, "settings.read");
  const [current, scheduled, history] = await Promise.all([
    storeRateAt(db, "USD", now),
    db.select().from(fxRates).where(and(eq(fxRates.quote, "USD"), gt(fxRates.effectiveAt, now))).orderBy(fxRates.effectiveAt).limit(10),
    db.select().from(fxRates).where(eq(fxRates.quote, "USD")).orderBy(desc(fxRates.effectiveAt), desc(fxRates.createdAt)).limit(12),
  ]);
  const people = [...new Set([current, ...scheduled, ...history].map((row) => row?.createdBy).filter((id): id is string => Boolean(id)))];
  const names = people.length ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, people)) : [];
  const view = (row: typeof fxRates.$inferSelect): RateView => ({ id: row.id, iqdPerUnit: row.iqdPerUnit, source: row.source, isDemo: row.isDemo, effectiveAt: row.effectiveAt, createdAt: row.createdAt, by: row.createdBy ? (names.find((entry) => entry.id === row.createdBy)?.name ?? null) : null });
  return { base: "IQD", quote: "USD", current: current ? view(current) : null, scheduled: scheduled.map(view), history: history.map(view), canManage: can(actor, "pricing.fx_rate.manage") };
}

export type TaxSummary = { active: { code: string; name: string; rateBps: number; inclusive: boolean }[]; total: number };

export async function taxSummary(db: Db, actor: Actor, locale: Locale): Promise<TaxSummary> {
  assertCan(actor, "settings.read");
  const rows = await db.select({ code: taxRates.code, name: taxRates.name, rateBps: taxRates.rateBps, inclusive: taxRates.isInclusive, active: taxRates.isActive }).from(taxRates).orderBy(taxRates.code);
  return { active: rows.filter((row) => row.active).map((row) => ({ code: row.code, name: pick(row.name, locale), rateBps: row.rateBps, inclusive: row.inclusive })), total: rows.length };
}

export type LocaleView = {
  timeZone: "Asia/Baghdad";
  offset: "+03:00";
  now: number;
  /** The same instant as each language writes it (Latin and Arabic-Indic digits). */
  samples: { locale: Locale; latn: string; arab: string }[];
  storefrontLanguages: Locale[];
  adminLanguages: Locale[];
};

export function localeView(actor: Actor, now: number): LocaleView {
  assertCan(actor, "settings.read");
  return {
    timeZone: "Asia/Baghdad",
    offset: "+03:00",
    now,
    samples: LOCALE_CODES.map((locale) => ({ locale, latn: formatDateTime(now, locale, "latn"), arab: formatDateTime(now, locale, "arab") })),
    storefrontLanguages: [...LOCALE_CODES],
    adminLanguages: ["ar", "en"],
  };
}

export type EnvironmentView = {
  storeMode: "demo" | "live";
  appEnv: "development" | "production";
  demo: { products: number; orders: number; employees: number; usedUnits: number; customers: number };
};

/** STORE_MODE and APP_ENV come from the deployment (the route reads them); the counts are the demo rows still stored. */
export async function environmentView(db: Db, actor: Actor, vars: { STORE_MODE?: string; APP_ENV?: string }): Promise<EnvironmentView> {
  assertCan(actor, "settings.read");
  const rows = await db.all<{ products: number; orders: number; employees: number; usedUnits: number; customers: number }>(sql`
    SELECT (SELECT count(*) FROM products WHERE is_demo = 1) AS products, (SELECT count(*) FROM orders WHERE is_demo = 1) AS orders,
           (SELECT count(*) FROM employees WHERE is_demo = 1) AS employees, (SELECT count(*) FROM used_units WHERE is_demo = 1) AS usedUnits,
           (SELECT count(*) FROM customers WHERE is_demo = 1) AS customers`);
  const row = rows[0];
  return {
    // anything but "live" is the demo mode (noindex, the demo ribbon, demo orders) — the same reading as the storefront's
    storeMode: vars.STORE_MODE === "live" ? "live" : "demo",
    // only "development" exactly is development (SECURITY.md §4); anything else runs as production
    appEnv: vars.APP_ENV === "development" ? "development" : "production",
    demo: { products: Number(row?.products ?? 0), orders: Number(row?.orders ?? 0), employees: Number(row?.employees ?? 0), usedUnits: Number(row?.usedUnits ?? 0), customers: Number(row?.customers ?? 0) },
  };
}
