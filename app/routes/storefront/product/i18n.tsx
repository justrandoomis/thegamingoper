/**
 * The "product" strings for every piece of this folder. On /p/:slug they come with the page's loader data; inside the
 * quick-preview sheet (opened on any page) they come with the preview answer and are handed down through
 * <ProductMessages>. Components call useProductT() and never care which.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useLocale, useT } from "~/i18n/react";
import { makeT, type MessageTree, type TFunction } from "~/i18n/translate";

const ProductMessagesContext = createContext<MessageTree | null>(null);

export function ProductMessages({ messages, children }: { messages: MessageTree | null | undefined; children: ReactNode }) {
  return <ProductMessagesContext.Provider value={messages ?? null}>{children}</ProductMessagesContext.Provider>;
}

export function useProductT(): TFunction {
  const handed = useContext(ProductMessagesContext);
  const locale = useLocale();
  const fromRoute = useT("product");
  return useMemo(() => (handed ? makeT(handed, locale, "product") : fromRoute), [handed, locale, fromRoute]);
}
