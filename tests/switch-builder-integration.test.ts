/**
 * The Switch bundle builder's integration (docs/switch-builder.md §8 — owner: integration). Pure, no database:
 *   · CSP: `frame-src` names exactly one origin, YouTube's privacy-enhanced player — the trailer embed uses that very
 *     origin — and every other directive is what it was; our pages still may not be framed;
 *   · edge cache: /build/switch (every language, and its .data twin) and GET /api/switch-library (its exact address, no
 *     query, no store cookie) are answered from the colo's cache;
 *   · shell: the builder shows the header's search KEY (its own library search is the page's one field) and belongs
 *     to the «التصنيفات» tab;
 *   · entry links: `switchBuilderHref` is the only door to /build/switch outside the builder, and it answers null while
 *     SWITCH_BUILDER_PUBLIC is false (shipped false) — so the footer, the Nintendo mega menu, the Nintendo hub, the
 *     Switch 1 device hubs and the Switch 1 console pages draw nothing; with the flag on (mocked) the footer and the
 *     menu do draw it, in every language; the sitemap lists the page only once it is public;
 *   · privacy: the policy draft names the builder's localStorage keys — every `tt.sb.*` key in the builder's code —
 *     and says a trailer loads from youtube-nocookie.com only after a tap.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import shellMessages from "~/i18n/messages/shell";
import { makeT } from "~/i18n/translate";
import { LOCALE_CODES, LOCALES, localePath, type Locale } from "~/lib/locales";
import { SWITCH_BUILDER_PATH, SWITCH_BUILDER_PUBLIC, switchBuilderHref, type SwitchBuilderPlace } from "~/routes/storefront/builder/flags";
import { MEGA_LINKS, searchMode, tabOf } from "~/routes/storefront/shell/chrome";
import { Footer } from "~/routes/storefront/shell/Footer";
import { ShellMessages } from "~/routes/storefront/shell/i18n";
import { MegaContent } from "~/routes/storefront/shell/MegaMenu";
import type { NavPlatform } from "~/routes/storefront/shell/types";
import type { RequestCtx } from "~/server/context.server";
import { applySecurityHeaders, buildCsp, YOUTUBE_EMBED_ORIGIN } from "~/server/security.server";
import { buildPolicyDraft, PRIVACY_BUILDER_KEYS, staticSitemapPaths } from "~/server/services/content.server";
import { edgeCacheable } from "../workers/edge-cache";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Every .ts/.tsx file under a folder of the repo (repo-relative, forward slashes). */
function filesUnder(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(relative(ROOT, full).replace(/\\/g, "/"));
    }
  };
  walk(join(ROOT, folder));
  return out;
}
/** Source without its comments (they may name what the code does not do). */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
/**
 * The builder's own code (other owners' files, read as text — never imported, so a file still being written cannot
 * break these checks): the storefront page and its components, and the shared client-safe modules.
 */
const builderFiles = () => [...filesUnder("app/routes/storefront/builder"), ...filesUnder("app/lib/switch-builder")];

// ───────────────────────────────────────────────────────────────── CSP

describe("CSP — one frame origin, for the trailer, and nothing else", () => {
  const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";
  const ctx = (isHttps: boolean) => ({ nonce: NONCE, isHttps, isDev: false, storeMode: "live", cookie: () => null }) as unknown as RequestCtx;
  const directives = (csp: string) =>
    Object.fromEntries(
      csp
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/);
          return [name, values];
        }),
    );

  it("frame-src is exactly https://www.youtube-nocookie.com; every other directive is the policy SECURITY.md §3 lists", () => {
    expect(YOUTUBE_EMBED_ORIGIN).toBe("https://www.youtube-nocookie.com");
    const policy = directives(buildCsp(ctx(true)));
    expect(policy["frame-src"]).toEqual(["https://www.youtube-nocookie.com"]);
    expect(policy).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", `'nonce-${NONCE}'`],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "worker-src": ["'self'", "blob:"],
      "manifest-src": ["'self'"],
      "frame-src": ["https://www.youtube-nocookie.com"],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "upgrade-insecure-requests": [],
    });
    // YouTube is named once: no script, image (poster), media or connect source of it
    expect(buildCsp(ctx(true)).match(/youtube|google|ytimg/gi)).toEqual(["youtube"]);
    expect(directives(buildCsp(ctx(false)))).not.toHaveProperty("upgrade-insecure-requests");
  });

  it("the trailer embed frames exactly that origin (every privacy-enhanced host the builder's page code names)", () => {
    // a plain link out to youtube.com would be a navigation, not a frame: only embed hosts are checked here (the
    // privacy section below refuses youtube.com/embed, ytimg posters and the iframe API)
    const hosts = new Set<string>();
    for (const file of filesUnder("app/routes/storefront/builder")) {
      for (const match of code(read(file)).matchAll(/https?:\/\/[a-z0-9.-]*nocookie[a-z0-9.-]*/gi)) hosts.add(match[0]);
    }
    expect([...hosts]).toEqual([YOUTUBE_EMBED_ORIGIN]);
  });

  it("the builder's HTML carries it in production, and still may not be framed itself", () => {
    const page = new Response("<html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    applySecurityHeaders(page, ctx(true), new URL("https://tamtamgames.com/build/switch"));
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    // the builder's public JSON keeps the caching its route asks for (an /api answer without one is no-store)
    const json = new Response("{}", { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
    applySecurityHeaders(json, ctx(true), new URL("https://tamtamgames.com/api/switch-library"));
    expect(json.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(json.headers.get("Content-Security-Policy")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── edge cache

describe("edge cache — the builder's first step and its public JSON", () => {
  const req = (path: string, init: RequestInit = {}) => new Request(`https://tamtamgames.com${path}`, init);

  it("covers /build/switch in every language with its .data twin, and GET /api/switch-library at its own address", () => {
    for (const path of ["/build/switch", "/en/build/switch", "/ckb/build/switch", "/build/switch.data", "/ckb/build/switch.data?_routes=routes%2Fstorefront%2Fbuilder%2Fswitch-builder", "/api/switch-library"]) {
      expect(edgeCacheable(req(path)), path).toBe(true);
    }
  });

  it("renders fresh: a step's address, any query on the JSON, a locale prefix on the API, a store cookie, a POST", () => {
    for (const path of ["/build/switch?step=memory", "/en/build/switch?step=review", "/api/switch-library?rev=2", "/en/api/switch-library", "/api/switch-library.data"]) {
      expect(edgeCacheable(req(path)), path).toBe(false);
    }
    expect(edgeCacheable(req("/build/switch", { headers: { Cookie: "tt_cart=x" } }))).toBe(false);
    expect(edgeCacheable(req("/api/switch-library", { headers: { Cookie: "tt_sid=x" } }))).toBe(false);
    expect(edgeCacheable(req("/build/switch", { method: "POST" }))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── shell

describe("shell — the builder's header search and tab", () => {
  it("shows the round search key (the page searches its own library: one field per page) and marks «التصنيفات»", () => {
    expect(searchMode("/build/switch")).toBe("key");
    expect(tabOf("/build/switch")).toBe("categories");
    // whole segments only
    expect(searchMode("/builders")).toBe("field");
    expect(tabOf("/builders")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── entry links

const FLAGS = "~/routes/storefront/builder/flags";
const BUILD_WORDS = Object.fromEntries(LOCALE_CODES.map((locale) => [locale, makeT(shellMessages[locale], locale, "shell")("links.buildSwitch")])) as Record<Locale, string>;

const NINTENDO: NavPlatform = {
  id: "plt_nintendo",
  slug: "nintendo",
  name: "نينتندو",
  accent: "nintendo",
  artKey: null,
  href: "/platform/nintendo",
  productCount: 12,
  devices: ["switch-2", "switch-oled", "switch", "switch-lite", "switch-2-pro"].map((slug) => ({ label: slug, href: `/device/${slug}` })),
  accessories: [],
  games: [{ label: "ألعاب Nintendo", href: "/c/nintendo-games" }],
  consoles: [{ label: "Nintendo Switch OLED", href: "/p/nintendo-switch-oled" }],
  allConsoles: { label: "أجهزة Nintendo", href: "/c/nintendo-consoles" },
  used: null,
  featured: null,
};
const PLAYSTATION: NavPlatform = { ...NINTENDO, id: "plt_playstation", slug: "playstation", name: "PlayStation", accent: "playstation", href: "/platform/playstation", devices: [{ label: "ps5-slim", href: "/device/ps5-slim" }] };

const rootData = (locale: Locale) => ({ locale, dir: LOCALES[locale].dir, fx: null, storeMode: "live", i18n: messagesFor(locale, "ui", "ui-shop", "ui-overlays", "ui-card") });

/** Server HTML of a component on a store page (/about) in the locale. */
function serverHtml(locale: Locale, Page: ComponentType): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: Page }] }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [localePath("/about", locale)], hydrationData: { loaderData: { root: rootData(locale) } } }));
}

type ShellParts = { Footer: typeof Footer; MegaContent: typeof MegaContent; ShellMessages: typeof ShellMessages };

/** The footer, the menu and their strings' provider in a fresh module graph, with the flag mocked to `enabled`. */
async function shellWithFlag(enabled: boolean): Promise<ShellParts> {
  vi.resetModules();
  vi.doMock(FLAGS, async (importOriginal) => {
    const real = await importOriginal<typeof import("~/routes/storefront/builder/flags")>();
    return { ...real, SWITCH_BUILDER_PUBLIC: enabled, switchBuilderHref: (place: SwitchBuilderPlace) => real.switchBuilderHref(place, enabled) };
  });
  const [footer, mega, i18n] = await Promise.all([import("~/routes/storefront/shell/Footer"), import("~/routes/storefront/shell/MegaMenu"), import("~/routes/storefront/shell/i18n")]);
  return { Footer: footer.Footer, MegaContent: mega.MegaContent, ShellMessages: i18n.ShellMessages };
}

const footerHtml = (parts: ShellParts, locale: Locale) =>
  serverHtml(locale, () => createElement(parts.ShellMessages, { messages: messagesFor(locale, "shell").shell, children: createElement(parts.Footer, { shell: null, demo: false }) }) as ReactElement);
const menuHtml = (parts: ShellParts, locale: Locale, platform: NavPlatform) =>
  serverHtml(locale, () => createElement(parts.ShellMessages, { messages: messagesFor(locale, "shell").shell, children: createElement(parts.MegaContent, { platform, name: platform.name }) }) as ReactElement);
/** The device links of the menu's first column (its «كل أجهزة …» link has a class of its own). */
const deviceLinks = (html: string) => (html.split("<section")[1] ?? "").match(/<a[^>]*class="shell-mega__link"[^>]*>/g) ?? [];

describe("entry links — nothing while SWITCH_BUILDER_PUBLIC is false", () => {
  afterEach(() => {
    vi.doUnmock(FLAGS);
    vi.resetModules();
  });

  it("ships hidden until the owner has added sizes for the popular games (turning it on: update this test and docs/STATUS.md)", () => {
    expect(SWITCH_BUILDER_PUBLIC).toBe(false);
    expect(SWITCH_BUILDER_PATH).toBe("/build/switch");
  });

  it("the sitemap lists the builder only once it is public (the same switch)", () => {
    expect(staticSitemapPaths()).not.toContain("/build/switch");
    expect(staticSitemapPaths(false)).not.toContain("/build/switch");
    expect(staticSitemapPaths(true)).toEqual([...staticSitemapPaths(false), "/build/switch"]);
    expect(staticSitemapPaths(false)).toEqual(["/", "/used", "/trade-in", "/support", "/policies", "/about", "/contact", "/accessibility"]);
  });

  it("switchBuilderHref answers null everywhere while the flag is off; on, only the footer, Nintendo and Switch 1 models", () => {
    const places: SwitchBuilderPlace[] = [
      "footer",
      { platform: "nintendo" },
      { platform: "playstation" },
      { deviceModel: "switch-oled" },
      { deviceModel: "switch" },
      { deviceModel: "switch-lite" },
      { deviceModel: "switch-2" },
      { deviceModel: "ps5-slim" },
      { deviceModel: null },
      { deviceModel: undefined },
    ];
    for (const place of places) {
      expect(switchBuilderHref(place), JSON.stringify(place)).toBeNull();
      expect(switchBuilderHref(place, false), JSON.stringify(place)).toBeNull();
    }
    expect(places.map((place) => switchBuilderHref(place, true))).toEqual(["/build/switch", "/build/switch", null, "/build/switch", "/build/switch", "/build/switch", null, null, null, null]);
  });

  it("the footer and the Nintendo mega menu draw no link to the builder (the shipped flag)", () => {
    const shipped: ShellParts = { Footer, MegaContent, ShellMessages };
    for (const locale of LOCALE_CODES) {
      const footer = footerHtml(shipped, locale);
      expect(footer, locale).toContain(`href="${localePath("/trade-in", locale)}"`);
      expect(footer, locale).not.toContain("/build/switch");
      expect(footer, locale).not.toContain(BUILD_WORDS[locale]);
      const menu = menuHtml(shipped, locale, NINTENDO);
      expect(menu, locale).not.toContain("/build/switch");
      expect(deviceLinks(menu), locale).toHaveLength(MEGA_LINKS);
    }
  });

  it("with the flag on, the footer links it after trade-in and Nintendo's devices column ends with it — five links at most", async () => {
    const on = await shellWithFlag(true);
    for (const locale of LOCALE_CODES) {
      const href = `href="${localePath("/build/switch", locale)}"`;
      const footer = footerHtml(on, locale);
      expect(footer, locale).toContain(href);
      expect(footer, locale).toContain(BUILD_WORDS[locale]);
      expect(footer.indexOf(`href="${localePath("/trade-in", locale)}"`), locale).toBeLessThan(footer.indexOf(href));
      const menu = menuHtml(on, locale, NINTENDO);
      const links = deviceLinks(menu);
      expect(links, locale).toHaveLength(MEGA_LINKS);
      expect(links.at(-1), locale).toContain(href);
      expect(menu, locale).toContain(BUILD_WORDS[locale]);
      // another platform's menu never links it
      expect(menuHtml(on, locale, PLAYSTATION), locale).not.toContain("/build/switch");
    }
  });

  it("the flag mocked off draws nothing either (the mock above is what turned it on)", async () => {
    const off = await shellWithFlag(false);
    expect(footerHtml(off, "ar")).not.toContain("/build/switch");
    expect(menuHtml(off, "ar", NINTENDO)).not.toContain("/build/switch");
  });

  it("the hubs and the console page link only through switchBuilderHref, each for its own place", () => {
    const doors: Record<string, string> = {
      "app/routes/storefront/shell/Footer.tsx": 'switchBuilderHref("footer")',
      "app/routes/storefront/shell/MegaMenu.tsx": "switchBuilderHref({ platform: platform.slug })",
      "app/routes/storefront/catalog/platform.tsx": "switchBuilderHref({ platform: platform.slug })",
      "app/routes/storefront/devices/device.tsx": "switchBuilderHref({ deviceModel: hub.model.slug })",
      "app/routes/storefront/product/product.tsx": "switchBuilderHref({ deviceModel: product.deviceModel?.slug })",
    };
    for (const [file, call] of Object.entries(doors)) {
      const source = code(read(file));
      expect(source, file).toContain(call);
      // the link's target is the helper's answer, drawn only when it gave one
      expect(source, file).toMatch(/\bbuild \? /);
    }
    // nowhere else in the storefront: no file outside the builder names its address or takes it from the flag module
    const outside = filesUnder("app/routes/storefront").filter((file) => !file.startsWith("app/routes/storefront/builder/"));
    const users = outside.filter((file) => /switchBuilderHref|SWITCH_BUILDER_PATH|SWITCH_BUILDER_PUBLIC|\/build\/switch/.test(code(read(file))));
    expect(users.sort()).toEqual(Object.keys(doors).sort());
    for (const file of users) expect(code(read(file)), file).not.toMatch(/SWITCH_BUILDER_PATH|\/build\/switch/);
  });
});

// ───────────────────────────────────────────────────────────────── privacy

describe("privacy — the builder's browser storage and the trailer", () => {
  const FACTS = { feeIqd: 5_000, overridesEnabled: false, methods: ["cod"], card: null, zaincash: null, proofHours: 24, returnDays: 7, estimateDays: 3 };
  const draft = (locale: Locale) => JSON.stringify(buildPolicyDraft("privacy", { t: serverT(locale, "content"), locale, facts: FACTS, coverage: null, storeMode: "live" } as Parameters<typeof buildPolicyDraft>[1]));

  it("names both localStorage keys (left to right) and says a trailer loads from youtube-nocookie.com only after a tap, in every language", () => {
    for (const locale of LOCALE_CODES) {
      const text = draft(locale);
      expect(text, locale).toContain(`⁦${PRIVACY_BUILDER_KEYS.plan}⁩`);
      expect(text, locale).toContain(`⁦${PRIVACY_BUILDER_KEYS.tour}⁩`);
      expect(text, locale).toContain("youtube-nocookie.com");
      expect(text, locale).not.toContain("{key}");
    }
    expect(draft("en")).toContain("only after you tap play; until then the page requests nothing from YouTube");
    expect(draft("ar")).toContain("فقط بعد أن تضغط تشغيل");
  });

  it("names exactly the tt.sb.* keys the builder's code uses (a new key there must be added to the policy)", () => {
    const used = new Set<string>();
    for (const file of builderFiles()) {
      for (const match of code(read(file)).matchAll(/["'`](tt\.sb\.[A-Za-z0-9._-]+)["'`]/g)) used.add(match[1]);
    }
    expect([...used].sort()).toEqual(Object.values(PRIVACY_BUILDER_KEYS).sort());
  });

  it("keeps nothing else in the browser: every storage call's key is one of those, by any name (review 2026-11-21)", () => {
    // string constants of the builder's code, so a call that takes its key by a constant is followed to the key
    const constants = new Map<string, string>();
    const sources = builderFiles().map((file) => [file, code(read(file))] as const);
    for (const [, source] of sources) {
      for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*["'`]([^"'`$]+)["'`]/g)) constants.set(match[1], match[2]);
    }
    const keys = new Set<string>();
    for (const [file, source] of sources) {
      // the policy lists localStorage only: no session storage, database, cache or cookie of the builder's own
      expect(source, file).not.toMatch(/\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\.open\b|\bcookieStore\b/);
      for (const match of source.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*([^,)\s]+)/g)) {
        const argument = match[1];
        const literal = /^["'`]([^"'`$]+)["'`]$/.exec(argument)?.[1];
        keys.add(literal ?? constants.get(argument) ?? `${file}: ${argument}`);
      }
    }
    expect([...keys].sort()).toEqual(Object.values(PRIVACY_BUILDER_KEYS).sort());
  });

  it("nothing in the builder asks Google for anything before the tap (no YouTube poster, script or stream URLs)", () => {
    for (const file of builderFiles()) {
      expect(code(read(file)), file).not.toMatch(/ytimg\.com|googlevideo\.com|youtube\.com\/(embed|iframe_api)|img\.youtube/);
    }
  });
});
