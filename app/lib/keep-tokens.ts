/**
 * keepTokens — a name whose protected tokens never break across lines (design v2 §4.18: «Switch 2», «PS5 Pro»,
 * «Go 2», «Z-A», «USB-C» never break). Shared, pure and client-safe: the product page's h1 and quick look, the kit's
 * cart lines (app/ui/CartLineRow), and every surface that prints a name it did not write itself — an order line's
 * snapshot taken before the catalogue gained its non-breaking hyphens (QA 2026-11-13: «…Battery + USB-» / «C Cable» at
 * 360–390), or a name the owner typed in the admin.
 *
 * Copied from app/routes/storefront/product/text.ts (polish round 2026-11-13, the data review's request): the product
 * page keeps its own copy until it switches to this module; tests/product.test.ts runs every catalogue text through
 * the kit's splitBidi and MixedText with it, tests/kit-polish.test.ts checks this copy.
 *
 *   <BidiText text={keepTokens(line.name)} />
 */

/** A hyphen inside a Latin or number token: "Z-A", "USB-C", "Joy-Con", "BEE-001" (not "(-01)", not a spaced one). */
const TOKEN_HYPHEN = /(?<=[\p{Script=Latin}\d])-(?=[\p{Script=Latin}\d])/gu;
/**
 * The space before a short Latin or number token — one to three characters ("2", "Pro", "S", "Z-A", "AI+", "(L)",
 * "2)") that ends there: not a longer word, not a decimal ("7.9"), not a token glued to Arabic or Sorani ("PS5ی") —
 * and a NAME's token: it has a digit, a capital or a "+" («Switch 2», «PS5 Pro», «Xbox One», «4K HDR»), or it is a
 * unit after a number («3.5 mm», «401 g»). The small words of a sentence ("a", "of", "at", "up", "to", "and") stay
 * breakable: glued too, English prose became runs like «GPU: 4K at up to 120 FPS and 8K HDR» (47 characters that
 * cannot break — wider than a phone; review 2026-11-13).
 */
const BEFORE_SHORT =
  /(?<=\S) (?=\(?[\p{Script=Latin}\d][\p{Script=Latin}\d\u2011+]{0,2}\)?(?![\p{Script=Latin}\d\u2011+]|[.,\u066b]\d|[\u0600-\u06ff]))(?:(?=\(?[\p{Script=Latin}\d\u2011+]{0,2}[\p{Lu}\d+])|(?<=\d ))/gu;

/**
 * A name — or a sentence with names in it — whose protected tokens never break across lines: the space before a short
 * name token becomes a no-break space (U+00A0), so "2" never starts a line of its own («Nintendo Switch» / «2 Dock»),
 * and a hyphen inside a Latin token becomes a non-breaking hyphen (U+2011), so «Z-» or «USB-» never ends one
 * («Pokémon Legends: Z-» / «A – …»). Longer words still wrap at their spaces. Both characters stay inside a Latin run
 * for the kit's splitBidi and for MixedText, so the text is isolated exactly as before. Idempotent; pure. Screen
 * readers read both characters as the plain ones: accessible names may keep the raw text.
 */
export function keepTokens(text: string): string {
  return text.replace(TOKEN_HYPHEN, "\u2011").replace(BEFORE_SHORT, "\u00a0");
}
