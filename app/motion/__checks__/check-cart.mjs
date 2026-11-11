// @ts-nocheck — node app/motion/__checks__/check-cart.mjs [product path, default /p/splatoon-raiders]
// Fly to cart on the real storefront (Design System v2 §2.11, §5.2), each run in a fresh browser context (a new guest
// cart: an add writes one guest cart line to the dev database and reserves nothing):
//   · the bead lands on the cart bead — `[data-cart-badge]` inside the first on-screen `[data-cart-target]`, the
//     contract the shell keeps — also on the FIRST add, when the empty cart draws its bead only after the tap (the
//     flight aims again once the page has rendered the new count); the cart bead squishes and the count is already
//     up while the bead is in the air;
//   · the flying bead is the v2 bead: a flat 22px red disc with the cart bead's 2px ring, no wall;
//   · reduced motion: no flight at all, the count changes at once and the add is announced in the polite live region.
import path from "node:path";
import { goto, launch, openPage, report, SHOTS, sleep } from "./lib.mjs";

const PRODUCT = process.argv[2] ?? "/p/splatoon-raiders";
const checks = [];
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);

/** Watches every flight: where each bead is aimed at the end (its last keyframe), and the cart bead when it lands. */
const instrument = (page) =>
  page.evaluate(() => {
    window.__flights = [];
    window.__landings = [];
    const beads = new Map();
    const centre = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    };
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.classList.contains("tt-fly")) {
            const style = getComputedStyle(node);
            const entry = { t: performance.now(), background: style.backgroundColor, radius: style.borderRadius, width: style.width, shadow: style.boxShadow, ring: `${style.outlineStyle} ${style.outlineWidth}`, end: null };
            beads.set(node, entry);
            window.__flights.push(entry);
          }
    }).observe(document.body, { childList: true, subtree: true });
    // the end point of each flight, read every frame from its (possibly re-aimed) keyframes
    const loop = () => {
      for (const [node, entry] of beads) {
        if (!node.isConnected) continue;
        const animation = node.getAnimations()[0];
        const last = animation?.effect.getKeyframes().at(-1)?.transform ?? "";
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(last);
        if (m) entry.end = { x: parseFloat(node.style.left) + parseFloat(m[1]), y: parseFloat(node.style.top) + parseFloat(m[2]) };
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    document.addEventListener("tt:cart-received", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const badge = target?.querySelector("[data-cart-badge]");
      const drawn = badge && badge.getBoundingClientRect().width > 0 ? badge : target;
      window.__landings.push({
        t: performance.now(),
        flown: event.detail.flown,
        bead: drawn ? centre(drawn) : null,
        isBadge: drawn === badge,
        squish: badge ? badge.getAnimations().some((a) => JSON.stringify(a.effect.getKeyframes()).includes("scale(1.4, 0.68)")) : false,
      });
    });
  });

const cartState = (page) =>
  page.evaluate(() => {
    const target = [...document.querySelectorAll("[data-cart-target]")].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    const badge = target?.querySelector("[data-cart-badge]");
    return {
      label: target?.getAttribute("aria-label") ?? null,
      badge: badge && badge.getBoundingClientRect().width > 0 ? badge.textContent.trim() : null,
      announced: document.querySelector("[data-shop-announcer]")?.textContent ?? "",
      flying: document.querySelectorAll(".tt-fly").length,
    };
  });

/** The product page's add key (the first one on screen). */
async function pressAdd(page, touch) {
  const point = await page.evaluate(() => {
    const key = [...document.querySelectorAll('button[data-state="ready"][data-press]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    });
    if (!key) return null;
    const r = key.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!point) {
    const seen = await page.evaluate(() => ({
      view: innerHeight,
      scroll: scrollY,
      keys: [...document.querySelectorAll('button[data-state="ready"][data-press]')].map((el) => `${Math.round(el.getBoundingClientRect().top)}+${Math.round(el.getBoundingClientRect().height)}`),
    }));
    await page.screenshot({ path: path.join(SHOTS, "cart-no-key.png") });
    throw new Error(`no add-to-cart key on screen at ${PRODUCT}: ${JSON.stringify(seen)}`);
  }
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

const browser = await launch();
try {
  console.log("browser:", await browser.version(), "· product:", PRODUCT);
  for (const [width, height, touch] of [
    [390, 844, true],
    [1440, 900, false],
  ]) {
    // ── full tier ───────────────────────────────────────────────────────────
    const context = await browser.createBrowserContext();
    const page = await openPage(context, { width, height, touch, dpr: 1 });
    await goto(page, PRODUCT);
    await sleep(1500); // <MotionRoot> fetches the on-demand chunk (fly) at idle
    await instrument(page);
    const before = await cartState(page);
    await pressAdd(page, touch);
    await sleep(40);
    const inAir = await cartState(page);
    await sleep(1400);
    const first = await page.evaluate(() => ({ flights: window.__flights.slice(), landings: window.__landings.slice() }));
    const firstMiss = first.flights[0]?.end && first.landings[0]?.bead ? Math.round(Math.hypot(first.flights[0].end.x - first.landings[0].bead.x, first.flights[0].end.y - first.landings[0].bead.y) * 10) / 10 : null;
    add(
      `${width}: first add to an empty cart (no bead drawn at the tap) — the bead flies and lands on the cart bead drawn after the tap`,
      before.badge === null && first.flights.length === 1 && first.landings.length === 1 && first.landings[0].flown && first.landings[0].isBadge && firstMiss !== null && firstMiss <= 1.5,
      { before: before.badge, miss: firstMiss, flight: first.flights[0], landing: first.landings[0] },
    );
    add(`${width}: the count is up while the bead is still in the air; the cart bead squishes on landing`, inAir.flying === 1 && inAir.badge === "1" && first.landings[0]?.squish, { inAir, squish: first.landings[0]?.squish });
    const bead = first.flights[0];
    add(
      `${width}: the flying bead is the v2 bead — a flat 22px red disc with the cart bead's 2px ring, no wall`,
      bead && bead.width === "22px" && parseFloat(bead.radius) >= 11 && bead.shadow === "none" && bead.ring === "solid 2px",
      bead && { background: bead.background, radius: bead.radius, shadow: bead.shadow, ring: bead.ring },
    );
    await page.screenshot({ path: path.join(SHOTS, `cart-${width}-after-first-add.png`), captureBeyondViewport: false });
    // a second add: the bead is already drawn and lands on it
    await page.evaluate(() => {
      window.__flights.length = 0;
      window.__landings.length = 0;
    });
    await pressAdd(page, touch);
    await sleep(1400);
    const second = await page.evaluate(() => ({ flights: window.__flights.slice(), landings: window.__landings.slice() }));
    const secondMiss = second.flights[0]?.end && second.landings[0]?.bead ? Math.round(Math.hypot(second.flights[0].end.x - second.landings[0].bead.x, second.flights[0].end.y - second.landings[0].bead.y) * 10) / 10 : null;
    add(`${width}: second add lands on the cart bead too (count 2)`, second.flights.length === 1 && secondMiss !== null && secondMiss <= 1.5 && (await cartState(page)).badge === "2", { miss: secondMiss, landing: second.landings[0] });
    add(`${width}: no console errors (full tier)`, page.motionErrors().length === 0, page.motionErrors());
    await page.close();
    await context.close();

    // ── reduced motion ──────────────────────────────────────────────────────
    const quiet = await browser.createBrowserContext();
    const still = await openPage(quiet, { width, height, touch, dpr: 1, reducedMotion: true });
    await goto(still, PRODUCT);
    await sleep(1500);
    await instrument(still);
    const tier = await still.evaluate(() => document.documentElement.getAttribute("data-motion"));
    const empty = await cartState(still);
    await pressAdd(still, touch);
    await sleep(40);
    const atOnce = await cartState(still);
    await sleep(1400);
    const after = await cartState(still);
    const reduced = await still.evaluate(() => ({ flights: window.__flights.length, landings: window.__landings.slice() }));
    add(
      `${width} reduced motion: no flight; the count changes at once and the add is announced (polite live region, cart label)`,
      tier === "reduced" &&
        reduced.flights === 0 &&
        reduced.landings.length === 1 &&
        reduced.landings[0].flown === false &&
        empty.badge === null &&
        atOnce.badge === "1" &&
        after.announced.trim().length > 0 &&
        after.label !== null &&
        after.label !== empty.label,
      { tier, flights: reduced.flights, landing: reduced.landings[0], atOnce: atOnce.badge, announced: after.announced, label: [empty.label, after.label] },
    );
    add(`${width}: no console errors (reduced)`, still.motionErrors().length === 0, still.motionErrors());
    await still.close();
    await quiet.close();
  }
} finally {
  await browser.close();
}
process.exitCode = report("check-cart", checks) ? 1 : 0;
