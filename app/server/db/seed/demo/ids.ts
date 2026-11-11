/**
 * Stable ids of the DEMO rows. They are derived from slugs and SKUs (like the reference seed's
 * `gov_baghdad`, `loc_main`), not random: running the seed again finds the same rows, and tests or
 * other seeds can name a demo row without looking it up.
 *
 *   demoId.product("nintendo-switch-2")   → "prd_nintendo-switch-2"
 *   demoId.variant("PS5-SLIM-DISC")       → "var_ps5-slim-disc"
 */
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const demoId = {
  platform: (slug: string) => `plt_${slug}`,
  generation: (slug: string) => `gen_${slug}`,
  deviceModel: (slug: string) => `dvm_${slug}`,
  category: (slug: string) => `cat_${slug}`,
  product: (slug: string) => `prd_${slug}`,
  variant: (sku: string) => `var_${key(sku)}`,
  /** Gallery row `index` of an owner ("product" | "variant" | "device_model" | "used_unit"). */
  media: (ownerType: string, ownerKey: string, index: number) => `med_${key(ownerType)}_${key(ownerKey)}_${index + 1}`,
  compatibility: (subjectKey: string, targetKey: string) => `cmp_${key(subjectKey)}__${key(targetKey)}`,
  synonym: (locale: string, group: string) => `syn_${locale}_${key(group)}`,
  serial: (serial: string) => `ser_${key(serial)}`,
  openingMovement: (sku: string, serial?: string) => (serial ? `smv_open_${key(serial)}` : `smv_open_${key(sku)}`),
  openingCostLayer: (sku: string) => `cly_open_${key(sku)}`,
  usedUnit: (slug: string) => `usd_${slug}`,
  tradeInGuide: (deviceModelSlug: string) => `tpg_${deviceModelSlug}`,
  article: (slug: string) => `kba_${slug}`,
  tree: (symptomKey: string) => `tst_${key(symptomKey)}`,
  coupon: (code: string) => `cpn_${key(code)}`,
  fxRate: (quote: string) => `fxr_demo_${key(quote)}`,
} as const;

/** What the seed writes into `actor_id`, `source_ref` and `ref_type` columns so demo rows can be told apart. */
export const DEMO_ACTOR_ID = "seed:demo";
export const DEMO_REF_TYPE = "demo_seed";
