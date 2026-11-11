/**
 * The admin shell's strings ("admin" namespace). They travel with the admin layout's loader data — and, when that
 * loader fails, with the data thrown alongside the error — so the shell hands them down through context instead of
 * relying on `useT("admin")` finding them in the route matches. Module pages can use either: inside the layout both
 * resolve to the same strings.
 *
 *   const t = useAdminT();
 *   t("nav.label")
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useLocale, useT } from "~/i18n/react";
import { makeT, type MessageTree, type TFunction } from "~/i18n/translate";

const AdminMessagesContext = createContext<MessageTree | undefined>(undefined);

export function AdminMessages({ messages, children }: { messages: MessageTree | undefined; children: ReactNode }) {
  return <AdminMessagesContext value={messages}>{children}</AdminMessagesContext>;
}

/** `t()` for the "admin" namespace inside the admin shell. */
export function useAdminT(): TFunction {
  const messages = useContext(AdminMessagesContext);
  const locale = useLocale();
  const fromMatches = useT("admin");
  return useMemo(() => (messages ? makeT(messages, locale, "admin") : fromMatches), [messages, locale, fromMatches]);
}
