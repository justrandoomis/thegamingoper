/**
 * Content area — what the content pages and the content service (`~/server/services/content.server`) share.
 * Client-safe: constants and types only, no server import. The service imports it too, so the pages and the
 * service can never disagree about which policies exist or in which order they are shown.
 *
 *   /policies/:slug   POLICY_SLUGS, in this order (the sideways push between policies follows it)
 *   PolicyView        what getPolicy() returns: title, blocks, the `approved` flag the draft notice reads, facts
 *   ContactView       what getContactDetails() returns: only what the owner filled in under `store.contact`
 */
import type { IconName } from "~/art/Icon";
import type { Locale } from "~/lib/locales";
import type { Block } from "~/ui/Blocks";

/** The store's policies, in the order the pages list them. The footer links the first five plus /policies/privacy and /policies/terms. */
export const POLICY_SLUGS = ["shipping", "returns", "warranty", "payment", "privacy", "terms"] as const;
export type PolicySlug = (typeof POLICY_SLUGS)[number];

export function isPolicySlug(value: unknown): value is PolicySlug {
  return typeof value === "string" && (POLICY_SLUGS as readonly string[]).includes(value);
}

/** Position of a policy among its siblings (route handle `order`), or null for a slug that is not one of ours. */
export function policyOrder(slug: string | undefined): number | null {
  const index = POLICY_SLUGS.indexOf(slug as PolicySlug);
  return index >= 0 ? index : null;
}

export const POLICY_ICONS: Record<PolicySlug, IconName> = {
  shipping: "truck",
  returns: "arrow-counter-clockwise",
  warranty: "shield-check",
  payment: "credit-card",
  privacy: "lock",
  terms: "file-text",
};

/** A payment method as the store's settings switch it (`payments.*`). */
export type PaymentMethodKey = "cod" | "wallet" | "card" | "zaincash";
export const PAYMENT_METHOD_KEYS: readonly PaymentMethodKey[] = ["cod", "wallet", "card", "zaincash"];

/**
 * A short fact at the top of a policy ("باختصار"), read live from the store's settings — never from the policy text,
 * so it is right whether the text is the code draft or a page the owner approved. Rendered by the page (money with
 * the shopper's formatter).
 */
export type PolicyFact =
  | { kind: "delivery_fee"; amountIqd: number; varies: boolean }
  | { kind: "governorates"; count: number }
  | { kind: "return_window"; days: number }
  | { kind: "proof_window"; hours: number }
  | { kind: "payment_methods"; methods: PaymentMethodKey[] }
  | { kind: "transfers_checked" }
  | { kind: "store_warranty_pending" }
  | { kind: "maker_warranty" }
  | { kind: "used_warranty" }
  | { kind: "no_tracking" }
  | { kind: "proofs_private" }
  | { kind: "guest_checkout" }
  | { kind: "estimate_valid"; days: number };

export type PolicyView = {
  slug: string;
  title: string;
  /** One or two sentences: the index row and the meta description. */
  summary: string;
  /** The text, as structured blocks (rendered by <Blocks>; strings only ever become text nodes). */
  blocks: Block[];
  /** Where the text came from: a published CMS page (`pages`, kind "policy"), or the draft written in code. */
  source: "cms" | "draft";
  /**
   * The data flag the "draft — awaiting the store owner's review" notice reads: true only for a published,
   * non-demo CMS page inside its schedule. Drafts are also kept out of search engines (noindex, no sitemap entry).
   */
  approved: boolean;
  /** Language of `title` and `blocks`: differs from the page's language when the CMS page lacks a translation. */
  textLocale: Locale;
  /** When the approved page was published (or last changed); null for a draft. */
  updatedAt: number | null;
  facts: PolicyFact[];
  /** Keep out of search engines: always for a draft; for an approved page when its SEO settings say so. */
  noindex: boolean;
};

/** One row of the policy index and of the "other policies" list. */
export type PolicySummary = { slug: string; title: string; summary: string; approved: boolean; icon: IconName };

/** A way to reach the store, ready to render. Only what the owner filled in under `store.contact` exists here. */
export type ContactChannel = {
  kind: "phone" | "whatsapp" | "email" | "instagram" | "facebook" | "tiktok" | "telegram" | "map";
  /** What is shown: "0770 123 4567", "info@…", "instagram.com/…" — always left-to-right. */
  value: string;
  href: string;
  /** Opens another site (new tab). */
  external: boolean;
};

export type ContactView = {
  channels: ContactChannel[];
  address: string | null;
  hours: string | null;
  /** Nothing filled in yet: the page says "coming soon" and points to the help centre instead. */
  isEmpty: boolean;
};

/** Facts the about page shows, from the store's settings. */
export type StoreFactsView = {
  deliveryFeeIqd: number;
  deliveryVaries: boolean;
  payments: PaymentMethodKey[];
  /** A person checks bank-card and Zain Cash transfers (true when either is switched on). */
  transfersChecked: boolean;
};

/** Text from a published CMS page shown in place of (about) or above (contact) the page's own copy. */
export type CmsText = { title: string; blocks: Block[]; textLocale: Locale; updatedAt: number | null };
