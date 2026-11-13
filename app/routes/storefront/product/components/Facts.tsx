/**
 * The facts a buyer asks before ordering — design v2.1 (client note 5: "the note look better"; brief §2.5, G5): the
 * side information as the kit's calm <Note>s — a neutral soft card each, an icon in a clay disc, a short bold title,
 * muted 16px text, an action on its own line with its arrow — never a bold paragraph under the price:
 *
 *   طرق الدفع            the methods the owner switched on (the TamTam wallet only for a signed-in shopper) and, when a
 *                        transfer is offered, the rule «الحوالة تبقى بانتظار التحقق حتى يراجعها موظف.»
 *   التوصيل … لكل المحافظات   the fee from settings (or «حسب محافظتك»), and «اطلب بدون حساب — …»; a code: «يصلك الرمز
 *                        بعد تأكيد الدفع.»
 *   الإرجاع خلال 7 أيام   from settings, with «سياسة الإرجاع ←»
 *   الضمان               the STORE's once the owner sets one, the manufacturer's when the research states it (always
 *                        labelled as theirs), else a question: «اسألنا عن شروط الضمان ←» (the one hand-off form)
 *
 * Only what is true: no delivery time, no call promise, no admission. Digital codes take their own facts: no delivery
 * fee, returns or warranty notes (spec §6.7 states, §13 row 11).
 */
import { useId, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Note } from "~/ui/Note";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { useProductT } from "../i18n";

/** The store's payment switches (layout loader `shell.payments`). */
export type PaymentSwitches = { cod: boolean; wallet: boolean; card: boolean; zaincash: boolean };
export type PaymentMethod = "cod" | "zaincash" | "card" | "wallet";

/** The one "talk to a person" destination (spec §6.13): the warranty question goes there. */
export const ASK_HREF = "/support/assistant?handoff=1#handoff";

/**
 * The methods to name, in the sentence's order (spec §6.7 item 8): cash on delivery, Zain Cash, the card transfer —
 * and the TamTam wallet only for a signed-in shopper. Only what the owner switched on. Pure.
 */
export function paymentMethods(switches: PaymentSwitches | null | undefined, signedIn: boolean): PaymentMethod[] {
  if (!switches) return [];
  const methods: PaymentMethod[] = [];
  if (switches.cod) methods.push("cod");
  if (switches.zaincash) methods.push("zaincash");
  if (switches.card) methods.push("card");
  if (switches.wallet && signedIn) methods.push("wallet");
  return methods;
}

/** A transfer (card or Zain Cash) waits for a person to verify it: the rule is said whenever one is offered. Pure. */
export const offersTransfer = (methods: readonly PaymentMethod[]) => methods.includes("card") || methods.includes("zaincash");

/** "a, b or c" in the page's language (the names come lower-case in English: the sentence starts with a capital). Pure. */
export function methodsList(names: readonly string[], join: string, last: string): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(join)}${last}${names[names.length - 1]}`;
}

/** The first letter of a Latin sentence in upper case; Arabic and Sorani have no case. Pure. */
export function sentenceStart(text: string, locale: string): string {
  return locale === "en" && text.length > 0 ? text.charAt(0).toLocaleUpperCase("en") + text.slice(1) : text;
}

export type SideNotesProps = {
  delivery: { flatFeeIqd: number; overridesEnabled: boolean };
  methods: readonly PaymentMethod[];
  returnsWindowDays: number;
  makerWarranty: string | null;
  storeWarrantyMonths: number | null;
  /** A digital code: its own delivery fact, no fee, no returns and no warranty notes. */
  digital?: boolean;
  className?: string;
};

type NoteEntry = { id: string; icon: IconName; title: ReactNode; text?: ReactNode; action?: ReactNode };

/** The side information as calm notes, headed «التوصيل والدفع والإرجاع» (an h2 for the page's outline). */
export function SideNotes({ delivery, methods, returnsWindowDays, makerWarranty, storeWarrantyMonths, digital = false, className }: SideNotesProps) {
  const t = useProductT();
  const f = useFormat();
  const locale = useLocale();
  const titleId = useId();
  const link = (label: string, to: string): ReactNode => (
    <TextLink as={LocaleLink} to={to}>
      {label}
    </TextLink>
  );

  const notes: NoteEntry[] = [];
  if (methods.length > 0) {
    const list = methodsList(
      methods.map((method) => t(`pay.${method}`)),
      t("pay.join"),
      t("pay.last"),
    );
    notes.push({
      id: "pay",
      icon: "credit-card",
      title: t("pay.title"),
      text: (
        <>
          {sentenceStart(t("pay.list", { methods: list }), locale)}
          {offersTransfer(methods) ? <> {t("pay.rule")}</> : null}
        </>
      ),
    });
  }
  if (digital) {
    notes.push({ id: "code", icon: "qr-code", title: t("facts.code"), text: t("facts.guest") });
  } else {
    notes.push({
      id: "delivery",
      icon: "truck",
      title: delivery.overridesEnabled ? t("facts.deliveryVaries") : fillNodes(t("facts.delivery"), { fee: <bdi className="nums">{iqdText(f, delivery.flatFeeIqd)}</bdi> }),
      text: t("facts.guest"),
    });
    notes.push({
      id: "returns",
      icon: "arrow-counter-clockwise",
      title: returnsWindowDays > 0 ? t("facts.returns", { count: returnsWindowDays, n: f.number(returnsWindowDays) }) : t("facts.returnsNone"),
      action: link(t("facts.returnsPolicy"), "/policies/returns"),
    });
    const ask = link(t("facts.askWarranty"), ASK_HREF);
    if (storeWarrantyMonths) {
      notes.push({
        id: "warranty",
        icon: "shield-check",
        title: t("facts.storeWarranty", { count: storeWarrantyMonths, n: f.number(storeWarrantyMonths) }),
        text: makerWarranty ? t("facts.makerWarranty", { terms: makerWarranty }) : undefined,
        action: ask,
      });
    } else if (makerWarranty) {
      notes.push({ id: "warranty", icon: "shield-check", title: t("facts.makerWarranty", { terms: makerWarranty }), text: t("facts.makerWarrantyNote"), action: ask });
    } else {
      notes.push({ id: "warranty", icon: "shield-check", title: t("facts.warranty"), action: ask });
    }
  }

  return (
    <section aria-labelledby={titleId} className={cx("pp-notes", className)} data-facts-card="">
      <h2 id={titleId} className="type-h3 text-ink">
        {t("facts.title")}
      </h2>
      {notes.map((note) => (
        <Note key={note.id} icon={note.icon} title={note.title} action={note.action}>
          {note.text}
        </Note>
      ))}
    </section>
  );
}
