/**
 * The shell's strings. They travel with the layout's loader data — and, when the layout's own loader fails (an
 * unknown language prefix → 404, the database down → 503), with the thrown data — so <ShellFrame> hands them down
 * through context instead of relying on `useT("shell")` finding them in the route matches.
 *
 *   const t = useShellT();
 *   t("tabs.home")
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useLocale } from "~/i18n/react";
import { makeT, type MessageTree, type TFunction } from "~/i18n/translate";

const ShellMessagesContext = createContext<MessageTree | undefined>(undefined);

export function ShellMessages({ messages, children }: { messages: MessageTree | undefined; children: ReactNode }) {
  return <ShellMessagesContext value={messages}>{children}</ShellMessagesContext>;
}

/** `t()` for the "shell" namespace (inside <ShellFrame>). */
export function useShellT(): TFunction {
  const messages = useContext(ShellMessagesContext);
  const locale = useLocale();
  return useMemo(() => makeT(messages, locale, "shell"), [messages, locale]);
}
