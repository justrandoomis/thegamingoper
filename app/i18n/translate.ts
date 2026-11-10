/**
 * Message lookup + interpolation — pure and client-safe.
 *
 * Message values:
 *   "Hello {name}"                                     simple interpolation
 *   { one: "{count} item", other: "{count} items" }    plural, selected by `vars.count` with Intl.PluralRules
 * Arabic uses up to six plural categories (zero, one, two, few, many, other); `other` is mandatory.
 */
import { LOCALES, type Locale } from "~/lib/locales";

export type PluralMessage = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type MessageValue = string | PluralMessage;
export type MessageTree = { [key: string]: MessageValue | MessageTree };
export type NamespaceMessages = Record<Locale, MessageTree>;
export type Vars = Record<string, string | number>;
export type TFunction = (key: string, vars?: Vars) => string;

const pluralRules = new Map<Locale, Intl.PluralRules>();
function rules(locale: Locale): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(LOCALES[locale].bcp47);
    pluralRules.set(locale, r);
  }
  return r;
}

function isPlural(value: unknown): value is PluralMessage {
  return typeof value === "object" && value !== null && typeof (value as PluralMessage).other === "string";
}

export function lookup(tree: MessageTree | undefined, key: string): MessageValue | undefined {
  let node: MessageValue | MessageTree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || isPlural(node)) return undefined;
    node = (node as MessageTree)[part];
  }
  if (typeof node === "string" || isPlural(node)) return node;
  return undefined;
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function translate(tree: MessageTree | undefined, locale: Locale, key: string, vars?: Vars): string | undefined {
  const value = lookup(tree, key);
  if (value === undefined) return undefined;
  if (typeof value === "string") return interpolate(value, vars);
  const count = typeof vars?.count === "number" ? vars.count : Number(vars?.count ?? 0);
  const category = rules(locale).select(count);
  return interpolate(value[category] ?? value.other, vars);
}

/** Build a `t()` bound to one namespace. Missing keys return the key itself and warn in development. */
export function makeT(tree: MessageTree | undefined, locale: Locale, namespace: string): TFunction {
  return (key, vars) => {
    const out = translate(tree, locale, key, vars);
    if (out !== undefined) return out;
    if (import.meta.env?.DEV) {
      console.warn(`[i18n] missing ${tree ? "key" : "namespace"} "${namespace}:${key}" (${locale})`);
    }
    return key;
  };
}

/** Identity helper that gives namespace files type checking and editor completion. */
export function defineMessages<const T extends NamespaceMessages>(messages: T): T {
  return messages;
}
