/**
 * Server-side message registry. Every file in ./messages/<namespace>.ts is picked up automatically —
 * there is no central list to edit, so parallel work on different namespaces never conflicts.
 *
 * A route loader hands the namespaces its UI needs to the client:
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const ctx = getCtx(context);
 *     return { product, i18n: messagesFor(ctx.locale, "product", "reviews") };
 *   }
 *
 * Only the active locale's strings are serialized; the dictionaries never enter the client bundle.
 */
import type { Locale } from "~/lib/locales";
import { makeT, type MessageTree, type NamespaceMessages, type TFunction } from "./translate";

const modules = import.meta.glob<{ default: NamespaceMessages }>("./messages/*.ts", { eager: true });

const registry = new Map<string, NamespaceMessages>();
for (const [path, mod] of Object.entries(modules)) {
  const name = path.slice("./messages/".length, -".ts".length);
  registry.set(name, mod.default);
}

export type I18nPayload = Record<string, MessageTree>;

export function messagesFor(locale: Locale, ...namespaces: string[]): I18nPayload {
  const out: I18nPayload = {};
  for (const ns of namespaces) {
    const entry = registry.get(ns);
    if (!entry) throw new Error(`[i18n] unknown namespace "${ns}" — expected app/i18n/messages/${ns}.ts`);
    out[ns] = entry[locale];
  }
  return out;
}

/** `t()` for server code: meta tags, notifications, validation messages, exports. */
export function serverT(locale: Locale, namespace: string): TFunction {
  const entry = registry.get(namespace);
  if (!entry) throw new Error(`[i18n] unknown namespace "${namespace}"`);
  return makeT(entry[locale], locale, namespace);
}

export function listNamespaces(): string[] {
  return [...registry.keys()].sort();
}

export function getNamespace(name: string): NamespaceMessages | undefined {
  return registry.get(name);
}
