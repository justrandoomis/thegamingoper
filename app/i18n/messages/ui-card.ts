import { defineMessages } from "../translate";

/**
 * "ui-card" — the product card's own words that the kit's "ui-shop" does not have (app/ui/ProductCard.tsx; added by
 * the integration pass, which owns the card for now — the design-system owner may fold these into "ui-shop").
 * Loaded on every page by the root loader, like every "ui-*" namespace. Read with `useT("ui-card")`.
 *
 *   soon       the tag and status of a product that is announced but not in stock yet ("preorder" in the data). The
 *              cart refuses it (no pre-order flow in the commerce core), so the card says "coming soon" and offers no
 *              add key — never "pre-order", which would promise an order the store cannot take.
 *   soonNote   the status line under the name: when it can be ordered.
 *
 * Same keys in all three locales (tests/i18n.test.ts). The Sorani column needs a native reader (docs/DESIGN.md §11).
 */
export default defineMessages({
  ar: {
    soon: "قريباً",
    soonNote: "يُطلب عندما يتوفّر لدينا",
  },
  en: {
    soon: "Coming soon",
    soonNote: "Can be ordered once we have it",
  },
  ckb: {
    soon: "بەم زووانە",
    soonNote: "کاتێک لامان بەردەست بوو داوا دەکرێت",
  },
});
