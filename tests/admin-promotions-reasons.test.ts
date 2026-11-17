/**
 * Module 08 — the points ledger and the referrals page say the reasons the STORE wrote in the admin's language
 * (polish round, 2026-11-13; the core's half is ~/server/services/orders/loyalty-reasons.ts, C-fix-core).
 *
 * Before: the Arabic ledger printed the stored codes as they are — «TT-XK9DHM64 · cancelled», «expired by 2026-11-13»,
 * «referral LAYLA7Q2» — and an order's own redemption showed its reference twice («TT-X» under «TT-X»); a referral the
 * store closed showed «السبب: TT-… · cancelled». Now each row carries `said` (readLoyaltyReason, read on the server),
 * the page says `points.reason.<code>` in ar / en / ckb with the reference isolated left to right, never repeats the
 * row's own reference, and shows a person's words (a manual adjustment) exactly as typed.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import messages from "~/i18n/messages/admin-promotions";
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { PROMOTIONS_LAYOUT_ID } from "~/routes/admin/promotions/meta";
import CustomerPointsPage from "~/routes/admin/promotions/points-customer";
import { withRejectSaid, withSaid } from "~/routes/admin/promotions/promotions.server";
import { useReasonText } from "~/routes/admin/promotions/ui";
import { DEFAULT_PROGRAM, type LedgerRow } from "~/server/services/admin/promotions/types";
import { LOYALTY_REASON_CODES, loyaltyReasonText, readLoyaltyReason, type LoyaltyReason } from "~/server/services/orders/loyalty-reasons";

const LOCALES = ["ar", "en", "ckb"] as const;
const LRI = "⁦";
const PDI = "⁩";

/** The rows the core and module 08 write (C-fix-core's ledger-reasons.json), plus a person's words. */
const STORED: { reason: string; said: LoyaltyReason | null }[] = [
  { reason: "TT-3XSWR55E", said: { code: "order", ref: "TT-3XSWR55E" } },
  { reason: "TT-XK9DHM64 · cancelled", said: { code: "cancelled", ref: "TT-XK9DHM64" } },
  { reason: "TT-XK9DHM64 · returned", said: { code: "returned", ref: "TT-XK9DHM64" } },
  { reason: "TT-5TQZ9GXP · refund rfd_01JD3M8Z6Q4V7T2K9R5X0BWCEA", said: { code: "refund", ref: "TT-5TQZ9GXP", refundId: "rfd_01JD3M8Z6Q4V7T2K9R5X0BWCEA" } },
  { reason: "expired by 2026-11-13", said: { code: "expired", date: "2026-11-13" } },
  { reason: "referral LAYLA7Q2", said: { code: "referral", referralCode: "LAYLA7Q2" } },
  { reason: "منحة نقاط تجريبية لعرض الصفحة", said: null },
];

const ledgerRow = (id: string, values: Partial<LedgerRow>): LedgerRow => ({
  id,
  at: Date.UTC(2026, 10, 13, 9),
  kind: "redeem",
  points: -100,
  customerId: "cus_reason",
  customer: "زبون تجريبي",
  phone: null,
  refType: "order",
  refLabel: null,
  reason: null,
  expiresAt: null,
  actor: "system",
  ...values,
});

/** A component as the server renders it inside module 08's layout (its strings, the programme), in one language. */
function render(node: () => ReactNode, locale: Locale): string {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      children: [{ id: PROMOTIONS_LAYOUT_ID, path: "admin/promotions", children: [{ id: "page", path: "points/:customerId", Component: () => node() }] }],
    },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/admin/promotions/points/cus_reason"],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", prefs: { theme: "system", currency: "IQD", numbering: "latn" }, i18n: messagesFor(locale, "common", "ui") },
          [PROMOTIONS_LAYOUT_ID]: { i18n: messagesFor(locale, "admin-promotions", "errors"), access: {}, decide: null, program: DEFAULT_PROGRAM },
          page: {},
        },
      },
    }),
  );
}

/** The text of rendered HTML, entities decoded, tags dropped. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the store's own reasons, read back on the server", () => {
  test("withSaid reads every code the core and module 08 write; a person's words stay theirs (null)", () => {
    const rows = withSaid(STORED.map((entry, index) => ledgerRow(`lgr_${index}`, { reason: entry.reason })));
    expect(rows.map((row) => row.said)).toEqual(STORED.map((entry) => entry.said));
    // every code round-trips through the one format the writers use
    for (const entry of STORED) if (entry.said) expect(readLoyaltyReason(loyaltyReasonText(entry.said))).toEqual(entry.said);
    const referrals = withRejectSaid([{ id: "rfr_1", rejectReason: "TT-XK9DHM64 · cancelled" }, { id: "rfr_2", rejectReason: "رقم مكرر" }, { id: "rfr_3", rejectReason: null }]);
    expect(referrals.map((row) => row.rejectSaid)).toEqual([{ code: "cancelled", ref: "TT-XK9DHM64" }, null, null]);
  });

  test("every code has its sentence in ar, en and ckb, with its own placeholder and no stored word left in it", () => {
    const placeholder: Record<(typeof LOYALTY_REASON_CODES)[number], string> = { order: "{ref}", cancelled: "{ref}", returned: "{ref}", refund: "{ref}", expired: "{date}", referral: "{referralCode}" };
    for (const locale of LOCALES) {
      for (const code of LOYALTY_REASON_CODES) {
        const sentence = translate(messages[locale] as MessageTree, locale, `points.reason.${code}`);
        expect(sentence, `${locale} ${code}`).toBeTruthy();
        expect(sentence, `${locale} ${code}`).toContain(placeholder[code]);
        // the stored format's English words are codes, never shown to an Arabic or Sorani reader
        if (locale !== "en") expect(sentence?.replace(/\{\w+\}/g, ""), `${locale} ${code}`).not.toMatch(/cancelled|returned|refund|expired|referral/i);
      }
    }
  });
});

describe("what the page says", () => {
  function Reasons({ entries }: { entries: { said: LoyaltyReason | null; typed: string | null; shownRef: string | null }[] }) {
    const reasonText = useReasonText();
    return createElement(
      "ul",
      null,
      entries.map((entry, index) => createElement("li", { key: index }, reasonText(entry.said, entry.typed, entry.shownRef) ?? "∅")),
    );
  }

  test("ar, en and ckb: the reference isolated, the day formatted, a person's words as typed, the row's own reference never twice", () => {
    const entries = [
      { said: STORED[0]!.said, typed: STORED[0]!.reason, shownRef: "TT-3XSWR55E" },
      { said: STORED[1]!.said, typed: STORED[1]!.reason, shownRef: null },
      { said: STORED[2]!.said, typed: STORED[2]!.reason, shownRef: null },
      { said: STORED[3]!.said, typed: STORED[3]!.reason, shownRef: "TT-5TQZ9GXP" },
      { said: STORED[4]!.said, typed: STORED[4]!.reason, shownRef: null },
      { said: STORED[5]!.said, typed: STORED[5]!.reason, shownRef: "rfr_x" },
      { said: null, typed: STORED[6]!.reason, shownRef: null },
      // an order's reason under ANOTHER reference (its order was erased, or a different row): said, not dropped
      { said: STORED[0]!.said, typed: STORED[0]!.reason, shownRef: null },
      // review 2026-11-17: a cancellation / return under its own order's reference says what happened, not «TT-X» again
      { said: STORED[1]!.said, typed: STORED[1]!.reason, shownRef: "TT-XK9DHM64" },
      { said: STORED[2]!.said, typed: STORED[2]!.reason, shownRef: "TT-XK9DHM64" },
    ];
    const expected: Record<(typeof LOCALES)[number], string[]> = {
      ar: ["∅", `أُلغي الطلب ${LRI}TT-XK9DHM64${PDI}`, `عاد الطلب ${LRI}TT-XK9DHM64${PDI} دون تسليم`, "استرداد على هذا الطلب", "انتهت صلاحيتها في", `مكافأة الإحالة ${LRI}LAYLA7Q2${PDI}`, "منحة نقاط تجريبية لعرض الصفحة", `الطلب ${LRI}TT-3XSWR55E${PDI}`, "أُلغي هذا الطلب", "عاد هذا الطلب دون تسليم"],
      en: ["∅", `Order ${LRI}TT-XK9DHM64${PDI} cancelled`, `Order ${LRI}TT-XK9DHM64${PDI} returned undelivered`, "Refund on this order", "Expired on", `Referral reward ${LRI}LAYLA7Q2${PDI}`, "منحة نقاط تجريبية لعرض الصفحة", `Order ${LRI}TT-3XSWR55E${PDI}`, "This order was cancelled", "This order came back undelivered"],
      ckb: ["∅", `داواکاری ${LRI}TT-XK9DHM64${PDI} هەڵوەشێنرایەوە`, `داواکاری ${LRI}TT-XK9DHM64${PDI} بەبێ گەیاندن گەڕایەوە`, "گەڕاندنەوەی پارە لەسەر ئەم داواکارییە", "بەسەرچوو", `پاداشتی ناساندن ${LRI}LAYLA7Q2${PDI}`, "منحة نقاط تجريبية لعرض الصفحة", `داواکاری ${LRI}TT-3XSWR55E${PDI}`, "ئەم داواکارییە هەڵوەشێنرایەوە", "ئەم داواکارییە بەبێ گەیاندن گەڕایەوە"],
    };
    for (const locale of LOCALES) {
      const items = [...render(() => createElement(Reasons, { entries }), locale).matchAll(/<li>([^<]*)<\/li>/g)].map((match) => textOf(match[1]!).trim());
      expect(items, locale).toHaveLength(entries.length);
      items.forEach((item, index) => expect(item, `${locale} #${index}`).toContain(expected[locale][index]!));
      // the expiry's day is the formatted 13 November, never the stored ISO day; the refund id stays for the machine
      expect(items[4], locale).not.toContain("2026-11-13");
      expect(items[4], locale).toMatch(/13/);
      expect(items.join(" "), locale).not.toContain("rfd_01JD3M8Z6Q4V7T2K9R5X0BWCEA");
      // the row's own reference is never repeated in its caption, whatever the code
      for (const index of [3, 8, 9]) expect(items[index], `${locale} #${index}`).not.toMatch(/TT-/);
    }
  });

  test("the customer's ledger page: «TT-X» once for an order's own redemption, the cancellation in Arabic, nothing raw", () => {
    const entries = withSaid([
      ledgerRow("lgr_a", { kind: "redeem", refType: "order", refLabel: "TT-3XSWR55E", reason: "TT-3XSWR55E" }),
      ledgerRow("lgr_b", { kind: "reversal", refType: "redeem", refLabel: null, reason: "TT-XK9DHM64 · cancelled", points: 100 }),
      ledgerRow("lgr_c", { kind: "adjust", refType: "manual", refLabel: null, reason: "منحة نقاط تجريبية لعرض الصفحة", points: 50, actor: "صاحب المتجر" }),
    ]);
    const points = { customerId: "cus_reason", name: "زبون تجريبي", phone: null, status: "active", balance: 50, valueIqd: 2_500, expiringSoon: 0, multiplierBps: null, entries, pending: [], canAdjust: false, canSeeProfile: false };
    const Page = CustomerPointsPage as unknown as (props: { loaderData: unknown; params: unknown; matches: unknown }) => ReactNode;
    const html = textOf(render(() => createElement(Page, { loaderData: { points }, params: { customerId: "cus_reason" }, matches: [] }), "ar"));
    expect(html.split("TT-3XSWR55E").length - 1).toBe(1);
    expect(html).toContain(`أُلغي الطلب ${LRI}TT-XK9DHM64${PDI}`);
    expect(html).toContain("منحة نقاط تجريبية لعرض الصفحة");
    expect(html).not.toMatch(/· cancelled|points\.reason/);
  });
});
