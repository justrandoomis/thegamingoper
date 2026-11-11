/**
 * Interpolated text in its own direction (client- and server-safe; used by the translators of components/ui.tsx and
 * route-kit.server.ts): a name or code typed in Arabic inside an English sentence (or the reverse) stays in one
 * piece — "Change ‹زينب (كاشير)›'s roles?" — instead of its brackets and words being reordered. Each text value is
 * wrapped in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE; `count` stays as given (plural forms are picked from it).
 */
export function isolateVars(vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars) return vars;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) out[name] = typeof value === "string" && value !== "" && name !== "count" ? `\u2068${value}\u2069` : value;
  return out;
}
