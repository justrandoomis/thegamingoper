/**
 * /build/switch — «جهّز جهاز Switch», the Switch bundle builder (contract: docs/switch-builder.md).
 *
 * console → memory card → games → review, one address per step: `/build/switch` (the console), `?step=memory`,
 * `?step=games`, `?step=review`. Like the trade-in wizard, the first step is a store page (the tab bar gives way to the
 * page's task bar) and the steps are a task flow (`chrome: "task"`); steps push sideways in their own group, in order.
 * A step change re-runs nothing on the server (shouldRevalidate): the plan lives in the browser (localStorage
 * `tt.sb.plan.v1`, restored after hydration — the server renders the default plan) and the game library is static
 * files plus GET /api/switch-library, fetched by the page.
 *
 * The loader reads only what the store sells for the builder (builder.server.ts loadBuilderCatalog: consoles, cards,
 * cartridges, eShop cards — no stock counts) and never a cookie: the page is edge-cached for anonymous visitors. The
 * meta asks search engines not to index the page until the builder is public (./flags), and never a `?step=` page; each
 * step has its own document title («اختر ألعابك · جهّز جهاز Switch — طمطم»), read from the address, since a step
 * change runs no loader.
 * The action (intent=quote, plan = JSON) prices a plan for the review step (quoteBuilderPlan with TamTam's library data),
 * at most QUOTES_PER_IP a minute per address (429 rate_limited with Retry-After — each quote reads the library and the
 * catalogue); a quote request that never reaches the store comes back as a value (clientAction), never as the error page.
 *
 * The page itself: ./components/BuilderPage.tsx.
 */
import { data, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/switch-builder";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import type { MotionHandle } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { readFormData } from "~/server/body.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { limitKey, rateLimit, type RateLimitRule } from "~/server/ratelimit.server";
import { getLibraryPrices } from "~/server/services/switch-library.server";
import { loadBuilderCatalog, parsePlan, quoteBuilderPlan } from "./builder.server";
import { BuilderPage } from "./components/BuilderPage";
import { SWITCH_BUILDER_PUBLIC } from "./flags";
import { stepOrder, stepTitle } from "./lib/steps";
import "./builder.css";

/**
 * Quotes one address may ask for in a minute (QA security 2026-11-21: none was counted, and each one reads the library
 * and the catalogue). The review asks once per plan, so a shopper never meets it; the cart's own changes count 60 too.
 */
const QUOTES_PER_IP: RateLimitRule = { limit: 60, windowSec: 60 };

export const handle = {
  shell: { chrome: ({ search }) => (new URLSearchParams(search).has("step") ? "task" : "store"), offline: "form" },
  nav: "push",
  group: "switch-builder",
  order: ({ search }) => stepOrder(search),
} satisfies ShellHandle & MotionHandle;

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const catalog = await loadBuilderCatalog(getDb(), ctx.locale, ctx.now);
  const t = serverT(ctx.locale, "switch-builder");
  return {
    catalog,
    meta: { title: t("title"), description: t("metaDescription"), steps: { memory: t("memory.title"), games: t("games.title"), review: t("review.title") } },
    i18n: messagesFor(ctx.locale, "switch-builder", "switch-builder-sheet", "errors"),
  };
}

export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, {
    title: stepTitle(args.loaderData?.meta.title, args.loaderData?.meta.steps, args.location.search),
    description: args.loaderData?.meta.description,
    noindex: !SWITCH_BUILDER_PUBLIC || args.location.search !== "",
  });

/**
 * The parent routes' headers as they are (the edge cache's rules live there), plus the wait a refused quote names: an
 * action's headers are sent only through this export.
 */
export function headers({ actionHeaders, parentHeaders }: Route.HeadersArgs) {
  const wait = actionHeaders.get("Retry-After");
  if (!wait) return parentHeaders;
  const out = new Headers(parentHeaders);
  out.set("Retry-After", wait);
  return out;
}

/** Nothing the loader read changes with the step or with a quote: only a new address (another language) reloads it. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return false;
  if (currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

/** A quote request is the intent and one plan (parsePlan refuses a plan over 32 KB): anything bigger is refused unread. */
const MAX_QUOTE_BODY_BYTES = 40 * 1024;

/** intent=quote: the review step's lines and totals for the plan the browser sends (prices read now, on the server). */
export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_QUOTE_BODY_BYTES) return data({ ok: false as const, code: "invalid_plan" }, { status: 413 });
  let form: FormData;
  try {
    // read with a running count: a body sent without a Content-Length is cut off at the limit too, and a body that is
    // not a form is a refusal (400), never an unhandled error
    form = await readFormData(request, MAX_QUOTE_BODY_BYTES);
  } catch {
    return data({ ok: false as const, code: "invalid" }, { status: 400 });
  }
  if (form.get("intent") !== "quote") return data({ ok: false as const, code: "invalid" }, { status: 400 });
  const plan = parsePlan(form.get("plan"));
  if (!plan) return data({ ok: false as const, code: "invalid_plan" }, { status: 400 });
  try {
    const db = getDb();
    const verdict = await rateLimit(db, await limitKey("sb-quote", "ip", ctx.ip), QUOTES_PER_IP, ctx.now);
    if (!verdict.ok) return data({ ok: false as const, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } });
    // only the plan's own games: their eShop price, its date and the hidden flag — never the whole table
    const extras = await getLibraryPrices(db, plan.games.map((game) => game.id));
    const quote = await quoteBuilderPlan(db, ctx.locale, plan, extras, ctx.now);
    return { ok: true as const, quote };
  } catch (error) {
    // the review says the prices could not be worked out and offers a retry; the page stays as it is
    console.error("[switch-builder] quote failed", error);
    return data({ ok: false as const, code: "quote_failed" }, { status: 503 });
  }
}

/**
 * The quote from the browser (the review step's fetcher). A request that never reached the store or never came back —
 * no connection, a dropped request, a refusal thrown before the action ran — is answered with a value instead of an
 * error: `{ ok: false, code: "offline" | "network" }`. A fetcher's failed action would put the error boundary in place
 * of the whole builder (review 2026-11-21: one dropped quote request showed «لا يوجد اتصال بالإنترنت» over the page —
 * the cart's coupon read learned the same, checkout/cart.tsx). The review then offers its retry, and the root skips its
 * reload after such an answer (root.tsx shouldRevalidate), which would fail too.
 */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  try {
    return await serverAction();
  } catch {
    return { ok: false as const, code: typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "network" };
  }
}

export default function SwitchBuilder({ loaderData }: Route.ComponentProps) {
  return <BuilderPage catalog={loaderData.catalog} />;
}
