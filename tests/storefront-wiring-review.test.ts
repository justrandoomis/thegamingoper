/**
 * Review of the storefront wiring (2026-11-12): the defects found after it, each pinned by a test that failed against
 * the wiring's code — against a real local D1 with the demo catalogue where the store reads it:
 *
 *   home      a staff pin takes the hero's stage, never the platform's console elsewhere on the page (the trade-in door
 *             and the intro's corner objects showed a pinned GAME as "trade in your device")
 *   ticket    a rating that never reached the store (offline, a dropped connection) kept nothing: the card turned into
 *             the lookup form and the words typed were gone, while the page said they were kept
 *   ticket    the private link's card holds the rating form but was served `no-referrer`: a browser posts such a form
 *             with `Origin: null`, and the store refuses it — the rating failed without script (400)
 *   landing   a description in another language than the page's (the CMS's Arabic fallback on an English page) was
 *             drawn in the page's direction and language
 */
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import { publicRef, randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { textLangOf } from "~/routes/storefront/content/content-model";
import { leadArt } from "~/routes/storefront/home/view";
import { ticketView, type FormFailure } from "~/routes/storefront/support/client";
import TicketPage, { clientAction as ticketClientAction, loader as ticketLoader } from "~/routes/storefront/support/ticket";
import { requestContextMiddleware } from "~/server/context.server";
import { seedDemo } from "~/server/db/seed/demo";
import { getHomeData } from "~/server/services/home.server";
import { accessTokenHash } from "~/server/services/support/common.server";
import { routeOnArrival } from "~/server/services/support/routing.server";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let seq = 0;
const uid = (prefix: string) => `${prefix}_review_${Date.now().toString(36)}_${++seq}`;
const run = (query: string, ...params: unknown[]) => t.d1.prepare(query).bind(...params).run();

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
}, 120_000);

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── home

describe("home: a pinned hero takes the stage, never the platform's console elsewhere", () => {
  test("getHomeData keeps the platform's own lead device beside a pinned hero; the page's console pictures use it", async () => {
    const before = await getHomeData(t.db, { locale: "ar", now: t.now, extraShelves: false });
    // a platform whose automatic hero is a console, with a photographed buyable product that is not one to pin
    const target = before.platforms.find((platform) => platform.hero && platform.newArrivals.some((id) => id !== platform.hero?.productId && before.cards[id]?.image.artKey && before.cards[id]?.kind !== "console"));
    expect(target, "a platform with an automatic hero and another photographed arrival").toBeTruthy();
    const automatic = target!.hero!;
    const productId = target!.newArrivals.find((id) => id !== automatic.productId && before.cards[id]?.image.artKey && before.cards[id]?.kind !== "console")!;
    await run(
      "INSERT INTO home_sections (id, kind, config, sort, is_active, starts_at, ends_at, is_demo, updated_at) VALUES (?, 'hero_pin', ?, 0, 1, ?, ?, 0, ?)",
      uid("pin"),
      JSON.stringify({ platform: target!.slug, productId, headline: { ar: "عرض المراجعة" }, deck: null }),
      t.now - 60_000,
      t.now + 86_400_000,
      t.now,
    );
    try {
      const pinned = await getHomeData(t.db, { locale: "ar", now: t.now, extraShelves: false });
      const platform = pinned.platforms.find((entry) => entry.slug === target!.slug)!;
      // the stage: the staff's product
      expect(platform.hero).toMatchObject({ productId, pin: { headline: "عرض المراجعة" } });
      // the platform's console stays what the store picks — and its card travels with the page
      expect(platform.lead).toEqual({ productId: automatic.productId, mode: automatic.mode, releasedOn: automatic.releasedOn });
      expect(pinned.cards[automatic.productId]).toBeTruthy();
      // the trade-in door and the intro's corner objects draw the console, never the pinned product
      const consoleArt = pinned.cards[automatic.productId].image.artKey;
      expect(consoleArt).toBeTruthy();
      expect(leadArt(platform, pinned.cards)).toBe(consoleArt);
      expect(leadArt(platform, pinned.cards)).not.toBe(pinned.cards[productId].image.artKey);
      // without a pin the lead device is the hero itself
      const plain = before.platforms.find((entry) => entry.slug === target!.slug)!;
      expect(plain.lead).toEqual(plain.hero);
    } finally {
      await run("DELETE FROM home_sections WHERE id LIKE 'pin_review_%'");
    }
  });

  test("leadArt (pure): the lead device's picture; nothing when the platform has no lead device", () => {
    const cards = { console: { image: { artKey: "ps5--1" } }, game: { image: { artKey: "game--1" } } };
    expect(leadArt({ hero: { productId: "game" }, lead: { productId: "console" } }, cards)).toBe("ps5--1");
    expect(leadArt({ hero: { productId: "game" }, lead: null }, cards)).toBeNull();
    expect(leadArt({ hero: null, lead: { productId: "missing" } }, cards)).toBeNull();
    expect(leadArt(undefined, cards)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── the ticket page: a rating that never reached the store

/** The ticket page as the server renders it, in a router whose root carries the kit's strings. */
function renderTicket(options: { url: string; loaderData: unknown; actionData?: unknown; locale?: Locale }): string {
  const locale = options.locale ?? "ar";
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "/support/ticket", Component: TicketPage as ComponentType<never> as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [options.url],
      hydrationData: {
        loaderData: { root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, origin: "https://tamtamgames.com", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") }, page: options.loaderData as never },
        ...(options.actionData ? { actionData: { page: options.actionData as never } } : {}),
      },
    }),
  );
}

const receiptOf = (patch: Record<string, unknown> = {}) => ({ ref: "SP-7K4M2Q9X", createdAt: Date.UTC(2026, 10, 12, 8), phoneMasked: "0770 ••• 0101", status: "resolved", isDemo: true, replies: [], rating: null, canRate: true, ...patch });

/** What the browser's request for a rating post looks like to the page's clientAction. */
const ratingRequest = () =>
  new Request("http://localhost:5173/support/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "rate", ref: "SP-7K4M2Q9X", tk: "the-private-token", rating: "4", comment: "شكراً جزيلاً" }),
  });

describe("ticket page: a rating that never reached the store keeps its card and what was typed", () => {
  test("clientAction: the failure names the form it came from and keeps the words typed (never the token)", async () => {
    const failure = (await ticketClientAction({ request: ratingRequest(), serverAction: async () => Promise.reject(new TypeError("Failed to fetch")) } as never)) as FormFailure;
    expect(failure).toMatchObject({ ok: false, code: "network", values: { intent: "rate", ref: "SP-7K4M2Q9X", rating: "4", comment: "شكراً جزيلاً" } });
    expect(failure.values?.tk).toBeUndefined();
    // the store's own answers pass through untouched
    const answered = { ok: false, code: "rate_limited", status: 429, values: { intent: "rate" } };
    expect(await ticketClientAction({ request: ratingRequest(), serverAction: async () => answered } as never)).toBe(answered);
  });

  test("ticketView (pure): a rating failure keeps the card it was sent from; a lookup failure shows the form", () => {
    const linked = { id: "link" };
    const looked = { id: "lookup" };
    const rating: FormFailure = { ok: false, code: "network", status: 0, values: { intent: "rate" } };
    const lookup: FormFailure = { ok: false, code: "not_found", status: 200, values: { intent: "lookup" } };
    // nothing posted: the private link's card, or the form
    expect(ticketView({ posted: null, kept: null, fromLink: linked, failure: null })).toEqual({ card: linked, ratingFailure: null, lookupFailure: null });
    expect(ticketView({ posted: null, kept: null, fromLink: null, failure: null })).toEqual({ card: null, ratingFailure: null, lookupFailure: null });
    // a lookup's answer wins
    expect(ticketView({ posted: looked, kept: looked, fromLink: linked, failure: null }).card).toBe(looked);
    // a rating that failed after a lookup by number + phone: that card stays, the failure said inside it
    expect(ticketView({ posted: null, kept: looked, fromLink: null, failure: rating })).toEqual({ card: looked, ratingFailure: rating, lookupFailure: null });
    // …after the private link: the link's card
    expect(ticketView({ posted: null, kept: null, fromLink: linked, failure: rating })).toEqual({ card: linked, ratingFailure: rating, lookupFailure: null });
    // a rating's failure with no card left to show (a page sent without script): said beside the lookup form
    expect(ticketView({ posted: null, kept: null, fromLink: null, failure: rating })).toEqual({ card: null, ratingFailure: null, lookupFailure: rating });
    // a lookup that failed: the form and its sentence (the card of an earlier lookup is not shown again)
    expect(ticketView({ posted: null, kept: looked, fromLink: null, failure: lookup })).toEqual({ card: null, ratingFailure: null, lookupFailure: lookup });
  });

  test("the private link's card stays on screen with the failure inside its rating part, not the lookup form", async () => {
    const failure = await ticketClientAction({ request: ratingRequest(), serverAction: async () => Promise.reject(new TypeError("Failed to fetch")) } as never);
    const strings = messagesFor("ar", "support", "errors");
    const html = renderTicket({
      url: "/support/ticket?ref=SP-7K4M2Q9X&tk=the-private-token",
      loaderData: { receipt: receiptOf(), token: "the-private-token", askedRef: "SP-7K4M2Q9X", meta: { title: "", description: "" }, i18n: strings },
      actionData: failure,
    });
    expect(html).toContain('data-ticket="SP-7K4M2Q9X"');
    expect(html).not.toContain('value="lookup"');
    // the network sentence, inside the rating part (after its heading), and the rating form still there
    const network = (strings.support as { form: { network: string } }).form.network;
    expect(html.indexOf(network)).toBeGreaterThan(html.indexOf('id="rate"'));
    expect(html).toContain('name="intent" value="rate"');
    // the words typed come back into the comment field
    expect(html).toContain("شكراً جزيلاً");
  });
});

// ───────────────────────────────────────────────────────────────── the private link's rating form without script

/** Runs the ticket page's loader the way React Router does (root middleware first) and returns its headers. */
async function ticketHeaders(path: string): Promise<Record<string, string>> {
  const request = new Request(`http://localhost:5173${path}`, { headers: { "CF-Connecting-IP": `203.0.113.${++seq % 250}` } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let value: unknown;
  await requestContextMiddleware({ request, context, url, pattern: "/support/ticket", params: {} } as never, async () => {
    value = await ticketLoader({ request, context, params: {}, url, pattern: "/support/ticket" } as never);
    return new Response(null);
  });
  return Object.fromEntries(new Headers((value as { init?: { headers?: HeadersInit } }).init?.headers).entries());
}

async function ticketRow(status: string, rating: number | null = null) {
  const id = uid("stk");
  const ref = publicRef("SP");
  const token = randomToken();
  await run(
    "INSERT INTO support_tickets (id, ref, phone_e164, channel, subject, category, priority, status, csat_rating, access_token_hash, is_demo, created_at, updated_at) VALUES (?, ?, ?, 'assistant', 'مراجعة', 'other', 'normal', ?, ?, ?, 1, ?, ?)",
    id,
    ref,
    `+96477090${String(10_000 + seq).slice(-5)}`,
    status,
    rating,
    await accessTokenHash(token),
    t.now,
    t.now,
  );
  return { id, ref, token };
}

describe("ticket page: the private link's rating form posts without script", () => {
  test("a card that holds the rating form keeps its address to the store's own origin (a native post carries its Origin)", async () => {
    const solved = await ticketRow("resolved");
    const open = await ticketRow("open");
    const rated = await ticketRow("resolved", 5);
    // the rating form is on the card: `same-origin` (under `no-referrer` the browser posts it with `Origin: null`)
    expect(await ticketHeaders(`/support/ticket?ref=${solved.ref}&tk=${solved.token}`)).toMatchObject({ "referrer-policy": "same-origin", "cache-control": "private, no-store" });
    // a card without a form sends its address nowhere
    expect(await ticketHeaders(`/support/ticket?ref=${open.ref}&tk=${open.token}`)).toMatchObject({ "referrer-policy": "no-referrer", "cache-control": "private, no-store" });
    expect(await ticketHeaders(`/support/ticket?ref=${rated.ref}&tk=${rated.token}`)).toMatchObject({ "referrer-policy": "no-referrer" });
    // the lookup form (no card, or a wrong token)
    expect(await ticketHeaders("/support/ticket")).toMatchObject({ "referrer-policy": "same-origin" });
    expect(await ticketHeaders(`/support/ticket?ref=${solved.ref}&tk=${randomToken()}`)).toMatchObject({ "referrer-policy": "same-origin" });
  });
});

describe("support: a message to staff is routed the moment it arrives", () => {
  test("routeOnArrival routes a new ticket as the system, with the reason in the audit trail (not only 'or the job')", async () => {
    const ticket = await ticketRow("open");
    expect(await routeOnArrival(t.db, ticket.id, t.now)).toBe("routed");
    const audit = (await t.d1.prepare("SELECT actor_kind, action FROM audit_events WHERE entity_id = ? AND action = 'support.ticket.route'").bind(ticket.id).all()).results;
    expect(audit).toEqual([{ actor_kind: "system", action: "support.ticket.route" }]);
    // a ticket that is gone (or closed) is left for nobody: the shopper's request never fails for it
    expect(await routeOnArrival(t.db, "stk_missing", t.now)).toBe("waiting");
  });
});

// ───────────────────────────────────────────────────────────────── landing pages

describe("landing page: words in another language than the page's say which", () => {
  test("textLangOf (pure): Arabic letters on an English page, Latin-only words on an Arabic or Sorani page", () => {
    expect(textLangOf("وصف الصفحة.", "en")).toBe("ar");
    expect(textLangOf("A page about PS5 Pro.", "en")).toBeNull();
    expect(textLangOf("A page about PS5 Pro.", "ar")).toBe("en");
    expect(textLangOf("A page about PS5 Pro.", "ckb")).toBe("en");
    expect(textLangOf("عرض PS5 Pro لفترة محدودة.", "ar")).toBeNull();
    expect(textLangOf("پەڕەیەک", "ckb")).toBeNull();
    // no letters at all: the page's own
    expect(textLangOf("2026 — 5,000", "ar")).toBeNull();
    expect(textLangOf("", "en")).toBeNull();
  });
});
