import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { CURRENCIES } from "~/lib/money";
import { cx } from "./cx";
import { Price } from "./Price";
import { iqdText, isIqd } from "./PriceTag";
import { Status } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * The wallet (docs/DESIGN.md §9.19, brief §4 B): a paper panel with "رصيد المحفظة", the balance in price type and,
 * on their own line, top-ups still under review; beneath it the ledger — flat rows with the entry, its date and the
 * signed amount (a minus sign and red-ink for money spent). The balance is never an editable number. Guests have no
 * wallet: one sentence and a sign-in link in its place. At payment (`payIqd`) it says what will remain, or by how
 * much the balance falls short.
 *
 *   <WalletBalance balanceIqd={await getWalletBalance(db, id)} entries={page.items} pendingIqd={pendingTopups} />
 *   <WalletBalance balanceIqd={balance} payIqd={cart.totalIqd} compact />          inside the wallet option row
 *   <WalletBalance balanceIqd={null} />                                             a guest
 *
 * `entries` are `WalletEntryView` rows of ~/server/services/wallet.server (listWalletEntries) — the shape is repeated
 * here as `WalletEntry` so this client file never imports server code. The balance must be the ledger's SUM
 * (getWalletBalance); anything that is not whole, non-negative dinars is shown as an error, never as a number.
 */
export type WalletEntry = {
  id: string;
  kind: "topup" | "purchase" | "refund" | "trade_in_credit" | "gift_card" | "adjustment";
  /** Positive = money in, negative = money spent. */
  amountIqd: number;
  at: number;
  orderRef: string | null;
  /** Ledger rows are posted; a top-up still under review can be listed as "pending". Default "posted". */
  status?: "posted" | "pending";
};

export type WalletBalanceProps = {
  /** The ledger's sum. `null` = no wallet (a guest). */
  balanceIqd: number | null;
  /** Top-ups sent and still under review (not spendable yet). */
  pendingIqd?: number | null;
  /** The ledger, newest first. Omit for the balance alone. */
  entries?: readonly WalletEntry[] | null;
  /** Checkout: the amount this wallet would pay. */
  payIqd?: number | null;
  /** Inside a payment option row: no panel, no heading, no ledger. */
  compact?: boolean;
  /** Where a guest signs in (locale-less). Default "/account". */
  signInHref?: string;
  /** Under the ledger ("عرض المزيد", a top-up link). */
  footer?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
};

/** A signed ledger amount: its sign as text and whether it is money spent. Pure. */
export function signedAmount(amountIqd: number): { sign: "+" | "−" | ""; magnitude: number; debit: boolean } | null {
  if (typeof amountIqd !== "number" || !Number.isSafeInteger(amountIqd)) return null;
  if (amountIqd === 0) return { sign: "", magnitude: 0, debit: false };
  return amountIqd < 0 ? { sign: "−", magnitude: -amountIqd, debit: true } : { sign: "+", magnitude: amountIqd, debit: false };
}

/** What paying `payIqd` leaves, or how much is missing. Pure. */
export function walletAfter(balanceIqd: number, payIqd: number): { enough: true; remainsIqd: number } | { enough: false; shortIqd: number } | null {
  if (!isIqd(balanceIqd) || !isIqd(payIqd)) return null;
  return payIqd <= balanceIqd ? { enough: true, remainsIqd: balanceIqd - payIqd } : { enough: false, shortIqd: payIqd - balanceIqd };
}

export function WalletBalance({ balanceIqd, pendingIqd = null, entries = null, payIqd = null, compact = false, signInHref = "/account", footer, headingLevel = 2, className }: WalletBalanceProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;

  if (balanceIqd === null) {
    return (
      <div className={cx(compact ? "grid gap-1" : "grid gap-2 rounded-lg bg-paper p-4", className)}>
        <p className="type-body text-ink-2">{t("wallet.guest")}</p>
        <TextLink as={LocaleLink} to={signInHref} className="justify-self-start">
          {t("wallet.signIn")}
        </TextLink>
      </div>
    );
  }

  if (!isIqd(balanceIqd)) {
    return (
      <p role="alert" className={cx("flex items-start gap-2 type-label font-medium text-red-ink", !compact && "rounded-lg bg-paper p-4", className)}>
        <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
        <span>{t("wallet.error")}</span>
      </p>
    );
  }

  const after = payIqd === null ? null : walletAfter(balanceIqd, payIqd);
  const iqd = (value: number) => "⁦" + iqdText(f, value) + "⁩";
  const pending = isIqd(pendingIqd) && pendingIqd > 0 ? <Status tone="warn">{t("wallet.pending", { amount: iqd(pendingIqd) })}</Status> : null;
  const payment = after ? (
    after.enough ? (
      <p className="type-caption text-ink-2">{t("wallet.remains", { amount: iqd(after.remainsIqd) })}</p>
    ) : (
      <p className="flex items-start gap-1.5 type-caption font-medium text-red-ink">
        <Icon name="warning-circle" size={16} className="mt-0.5 shrink-0" />
        {t("wallet.short", { amount: iqd(after.shortIqd) })}
      </p>
    )
  ) : null;

  if (compact) {
    return (
      <div className={cx("grid gap-0.5", className)}>
        <p className="flex flex-wrap items-baseline gap-x-2 type-caption text-ink-2">
          {t("wallet.label")} <Price amountIqd={balanceIqd} size="sm" approx="off" as="span" />
        </p>
        {pending}
        {payment}
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className={cx("grid gap-4 rounded-lg bg-paper p-4", className)}>
      <div className="grid gap-1">
        <Heading id={headingId} className="type-label text-ink-2">
          {t("wallet.label")}
        </Heading>
        <Price amountIqd={balanceIqd} size="xl" approx="off" />
        {pending}
        {payment}
      </div>
      {entries ? (
        <div className="grid gap-1 border-t border-line pt-3">
          <p className="type-label font-semibold text-ink">{t("wallet.ledger")}</p>
          {entries.length === 0 ? (
            <p className="py-2 type-body text-ink-2">{t("wallet.empty")}</p>
          ) : (
            <ol className="grid">
              {entries.map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
          {footer}
        </div>
      ) : (
        footer
      )}
    </section>
  );
}

function LedgerRow({ entry }: { entry: WalletEntry }) {
  const t = useT("ui-shop");
  const f = useFormat();
  const signed = signedAmount(entry.amountIqd);
  const what = t(`wallet.kinds.${entry.kind}`);
  const status = entry.status ?? "posted";
  return (
    <li className="flex items-start justify-between gap-x-4 border-b border-line py-2.5 last:border-b-0">
      <div className="grid min-w-0 gap-0.5">
        <span className="type-label text-ink">
          {what}
          {entry.orderRef ? (
            <>
              {" · "}
              <bdi className="nums" dir="ltr">
                {entry.orderRef}
              </bdi>
            </>
          ) : null}
        </span>
        <span className="type-caption text-ink-2">
          {Number.isFinite(entry.at) ? <time dateTime={new Date(entry.at).toISOString()}>{f.date(entry.at)}</time> : null}
          {status === "pending" ? <> · {t("wallet.entryStatus.pending")}</> : null}
        </span>
      </div>
      {signed ? (
        <span className={cx("price price--sm shrink-0", signed.debit ? "text-red-ink" : "text-ink")}>
          <bdi className="price__num">
            {signed.sign}
            {f.number(signed.magnitude)}
          </bdi>
          <span className="price__cur">{CURRENCIES.IQD.symbol[f.locale]}</span>
        </span>
      ) : (
        <span className="shrink-0 type-caption font-medium text-red-ink">{t("price.invalid")}</span>
      )}
    </li>
  );
}
