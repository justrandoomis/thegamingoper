/**
 * HTTP security: CSRF origin checks and response headers.
 * Edge-level protections (TLS, WAF rules, bot fight mode, rate limiting) are configured in Cloudflare;
 * see docs/SECURITY.md for the full list and how the two layers fit together.
 */
import { env } from "cloudflare:workers";
import type { RequestCtx } from "./context.server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated mutations: the browser must tell us the request comes from
 * our own origin. Modern browsers always send `Origin` on POST; `Sec-Fetch-Site` covers the rest.
 * Requests with neither header are refused — there is no public unauthenticated write API.
 */
export function isSameOriginMutation(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === "same-origin";
}

export function buildCsp(ctx: RequestCtx): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Cloudflare's injected scripts (bot detection, email decoding) are same-origin under /cdn-cgi/
    // and Cloudflare copies our nonce onto the inline snippets it adds.
    "script-src": ["'self'", `'nonce-${ctx.nonce}'`],
    // React writes style="" attributes (transforms, CSS variables); stylesheets are same-origin files.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  if (ctx.isHttps) directives["upgrade-insecure-requests"] = [];
  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

export function applySecurityHeaders(response: Response, ctx: RequestCtx, url: URL): void {
  const h = response.headers;
  const isHtml = (h.get("Content-Type") ?? "").includes("text/html");

  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  // Camera: barcode/serial scanning and proof photos. Everything else is off.
  h.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");

  if (isHtml) {
    // Vite's dev client needs inline scripts, eval and websockets, so the policy is enforced only
    // outside development. `npm run preview` serves the production build with the real policy.
    if (!ctx.isDev) h.set("Content-Security-Policy", buildCsp(ctx));
    if (!h.has("Cache-Control")) h.set("Cache-Control", "private, no-cache");
  }

  // HSTS is opt-in: the owner decides (it cannot be undone quickly once browsers have seen it).
  const hsts = Number(env.HSTS_MAX_AGE ?? 0);
  if (ctx.isHttps && Number.isFinite(hsts) && hsts > 0) {
    h.set("Strict-Transport-Security", `max-age=${Math.floor(hsts)}`);
  }

  // Demo data must not be indexed; admin and account areas never are.
  const path = url.pathname;
  const isPrivateArea = /^\/(admin|api)(\/|$)/.test(path) || /\/(account|checkout|cart|order|track)(\/|$)/.test(path);
  // Preview hosts (*.workers.dev) are never indexed either — only the canonical domain is.
  const isPreviewHost = url.hostname.endsWith(".workers.dev");
  if (ctx.storeMode === "demo" || isPrivateArea || isPreviewHost) h.set("X-Robots-Tag", "noindex, nofollow");
}
