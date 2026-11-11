import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { useT } from "~/i18n/react";
import type { StockState } from "~/lib/dto";
import { cx } from "./cx";
import { Status, type StatusTone } from "./Tag";

/**
 * Stock as words — Design System v2 §4.7: an 8px dot and words, never colour alone, never an exact number (the
 * services send a state).
 *
 *   <StockNote stock="in_stock" detail={t("warranty")} />   «● متوفر · ضمان سنة»
 *   <StockNote stock="low_stock" />                         «● الكمية محدودة» (warn) — real stock only: «متوفر» in demo mode
 *   <StockNote stock="out_of_stock" />                      «● نفد حالياً» (ink-2)
 *   <StockNote stock="preorder" />                          «● قريباً» (ink) — the store takes no pre-orders
 *
 * There is no back-in-stock service, so there is no notify-me link (`notifyTo` is accepted and ignored, §0.2).
 */
export type StockNoteProps = {
  stock: StockState;
  /** Appended after " · " (the warranty, a delivery fact). */
  detail?: ReactNode;
  /** 1.0 — ignored: no notify-me until a back-in-stock service exists. */
  notifyTo?: string;
  size?: "md" | "lg";
  className?: string;
};

const TONE: Record<StockState, StatusTone> = { in_stock: "ok", low_stock: "warn", out_of_stock: "out", preorder: "soon" };
const WORD: Record<StockState, string> = { in_stock: "stock.in", low_stock: "stock.low", out_of_stock: "stock.outNow", preorder: "stock.soon" };

type RootStore = { storeMode?: string };

/** The status tone of a stock state (scarcity is shown only from real stock: in demo mode low stock reads «متوفر»). */
export function stockLook(stock: StockState, demo = false): StatusTone {
  if (stock === "low_stock" && demo) return "ok";
  return TONE[stock] ?? "neutral";
}

/** `words(stock)` → «متوفر» · «الكمية محدودة» · «نفد حالياً» · «قريباً», with scarcity hidden in demo mode. */
export function useStockWords() {
  const t = useT("ui-shop");
  const demo = useDemoMode();
  return (stock: StockState) => t(stock === "low_stock" && demo ? WORD.in_stock : (WORD[stock] ?? WORD.in_stock));
}

/** The store runs in demo mode (root loader `storeMode`). */
export function useDemoMode(): boolean {
  const root = useRouteLoaderData("root") as RootStore | undefined;
  return root?.storeMode === "demo";
}

export function StockNote({ stock, detail, size, className }: StockNoteProps) {
  const words = useStockWords();
  const demo = useDemoMode();
  return (
    <span className={cx("inline-flex", className)}>
      <Status tone={stockLook(stock, demo)} size={size}>
        {words(stock)}
        {detail ? <> · {detail}</> : null}
      </Status>
    </span>
  );
}
