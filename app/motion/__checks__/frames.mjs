// @ts-nocheck — node app/motion/__checks__/frames.mjs
// Captures still frames from the middle of each animation into .shots/motion/ so they can be looked at.
// (check-nav.mjs and check-system.mjs capture the page transitions, theme and language morphs.)
import path from "node:path";
import { SHOTS, centre, goto, launch, openPage, sleep, tap } from "./lib.mjs";

const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
/** Pause every running animation under `selector` at `progress` of its own duration. */
const freeze = (page, selector, progress) =>
  page.evaluate(
    (sel, p) => {
      for (const el of document.querySelectorAll(sel)) {
        for (const a of el.getAnimations()) {
          const timing = a.effect.getComputedTiming();
          a.pause();
          a.currentTime = Number(timing.delay) + p * Number(timing.duration);
        }
      }
    },
    selector,
    progress,
  );

try {
  // press held + number mid-roll
  const touch = await openPage(browser);
  await goto(touch, "/motion?tab=touch");
  const clay = await centre(touch, '[data-testid="press-clay"]');
  await touch.touchscreen.touchStart(clay.x, clay.y);
  await sleep(200);
  await shot(touch, "press-held");
  await touch.touchscreen.touchEnd();
  await sleep(500);
  await tap(touch, '[data-testid="qty-plus"]');
  await freeze(touch, '[data-testid="total"] .tt-num-in, [data-testid="total"] .tt-num-out', 0.45);
  await shot(touch, "number-rolling");
  await touch.close();

  // bubbles mid-wave
  const reveal = await openPage(browser);
  await goto(reveal, "/motion?tab=reveal");
  await tap(reveal, '[data-testid="reveal-load"]');
  await sleep(300);
  await shot(reveal, "bubble-placeholder");
  await reveal.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
  // Freeze the whole wave at one instant: 150 ms after the first bubble started.
  await reveal.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid="reveal-grid"] > *')) for (const a of el.getAnimations()) (a.pause(), (a.currentTime = 150));
  });
  await shot(reveal, "bubble-wave-150ms");
  await reveal.close();

  // fly-to-cart mid-air (three pucks at different points of the arc) and the sheet half way up
  const cart = await openPage(browser);
  await goto(cart, "/motion?tab=cart");
  await sleep(1200);
  const add = await centre(cart, '[data-testid="fly-add"]');
  for (let i = 0; i < 3; i++) {
    await cart.touchscreen.tap(add.x, add.y);
    await cart.evaluate((p) => {
      const pucks = [...document.querySelectorAll(".tt-fly")];
      const puck = pucks[pucks.length - 1];
      for (const a of puck?.getAnimations() ?? []) (a.pause(), (a.currentTime = p * Number(a.effect.getComputedTiming().duration)));
    }, [0.12, 0.3, 0.6][i]);
  }
  await shot(cart, "fly-arc");
  await cart.evaluate(() => document.querySelectorAll(".tt-fly").forEach((p) => p.getAnimations().forEach((a) => a.finish())));
  await sleep(700);
  await tap(cart, '[data-testid="sheet-open"]');
  await cart.waitForSelector('[data-testid="sheet"]');
  await freeze(cart, '[data-testid="sheet"], [data-testid="sheet-scrim"]', 0.25);
  await shot(cart, "sheet-opening");
  await cart.close();

  // dark theme, English: the lab in its other skin
  const dark = await openPage(browser, { dark: true });
  await goto(dark, "/en/motion?tab=cart");
  await shot(dark, "lab-cart-en-dark");
  await dark.close();
  console.log("frames written to", SHOTS);
} finally {
  await browser.close();
}
