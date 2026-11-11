import type { MetaDescriptor } from "react-router";

import { makeT, type MessageTree } from "~/i18n/translate";
import { DEFAULT_LOCALE, isLocale } from "~/lib/locales";
import { shellMeta, type ShellMetaArgs } from "../../shell/meta";

type Args = ShellMetaArgs & { loaderData?: unknown };

/**
 * Meta for an account page: "<page> — طمطم" through the shell's helper (canonical, hreflang, Open Graph), always
 * `noindex` — personal pages never belong in search results. The title comes from the "account" strings of the page
 * or of the account layout.
 */
export function accountMeta(args: Args, key: string, vars?: Record<string, string | number>): MetaDescriptor[] {
  const sources = [args.loaderData, ...args.matches.map((match) => match?.loaderData)];
  let tree: MessageTree | undefined;
  for (const source of sources) {
    const found = (source as { i18n?: { account?: MessageTree } } | undefined)?.i18n?.account;
    if (found) {
      tree = found;
      break;
    }
  }
  const rootLocale = (args.matches.find((match) => match?.id === "root")?.loaderData as { locale?: string } | undefined)?.locale;
  const locale = isLocale(rootLocale) ? rootLocale : DEFAULT_LOCALE;
  const t = makeT(tree, locale, "account");
  return shellMeta(args, { title: tree ? t(`meta.${key}`, vars) : null, description: tree ? t("meta.description") : null, noindex: true });
}
