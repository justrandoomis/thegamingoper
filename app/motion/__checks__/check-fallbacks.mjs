// @ts-nocheck — node app/motion/__checks__/check-fallbacks.mjs
// The engine on browsers that lack pieces of the platform:
//   A. no View Transitions API at all (older Safari / Firefox)
//   B. View Transitions without document.activeViewTransition (the engine then relies on React's callbacks,
//      :active-view-transition and finishing the pseudo-element animations)
import { centre, goto, launch, openPage, report, scrollY, sleep, tap, url } from "./lib.mjs";

const browser = await launch();
const checks = [];
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);

try {
  // ── A. no View Transitions ─────────────────────────────────────────────────
  const plain = await openPage(browser);
  await plain.evaluateOnNewDocument(() => {
    delete Document.prototype.startViewTransition;
    delete Document.prototype.activeViewTransition;
  });
  await goto(plain, "/motion?tab=flow");
  await plain.evaluate(() => window.scrollTo(0, 240));
  await sleep(150);
  await plain.evaluate(() => {
    window.__pageFade = [];
    window.__flips = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.hasAttribute?.("data-motion-page")) window.__pageFade.push({ keys: Object.keys(keyframes[0] ?? {}), duration: options?.duration });
      if (this.hasAttribute?.("data-share")) window.__flips.push({ share: this.getAttribute("data-share"), from: keyframes[0]?.transform, to: keyframes[1]?.transform, width: Math.round(this.getBoundingClientRect().width) });
      return original.call(this, keyframes, options);
    };
  });
  const cardWidth = await plain.$eval('[data-testid="card-c"] [data-share]', (el) => Math.round(el.getBoundingClientRect().width));
  await tap(plain, '[data-testid="card-c"]', { scroll: false });
  await plain.waitForSelector('[data-testid="lab-detail"][data-item="c"]');
  await sleep(500);
  const fade = await plain.evaluate(() => window.__pageFade);
  add("no view transitions: navigation works and the new page fades in (opacity only, 120 ms)", url(plain) === "/motion/item/c" && fade.length === 1 && fade[0].keys.join() === "opacity" && fade[0].duration === 120, [url(plain), fade]);
  const flipIn = await plain.evaluate(() => window.__flips);
  const scaleOf = (transform) => Number(/scale\(([\d.]+)\)/.exec(transform ?? "")?.[1] ?? NaN);
  add(
    "no view transitions: the shared element FLIPs from the card's box (one scale, never stretched)",
    flipIn.length === 1 && flipIn[0].share === "lab-item:c" && Math.abs(scaleOf(flipIn[0].from) - cardWidth / flipIn[0].width) < 0.01 && flipIn[0].to === "none",
    { cardWidth, flipIn },
  );
  await plain.evaluate(() => (window.__flips.length = 0));
  await plain.goBack();
  await plain.waitForSelector('[data-testid="lab-home"]');
  await sleep(500);
  add("no view transitions: Back restores URL and scroll", url(plain) === "/motion?tab=flow" && (await scrollY(plain)) === 240, [url(plain), await scrollY(plain)]);
  const flipBack = await plain.evaluate(() => window.__flips);
  add("no view transitions: Back FLIPs the card from the detail picture's box", flipBack.length === 1 && flipBack[0].share === "lab-item:c" && scaleOf(flipBack[0].from) > 1.5, flipBack);
  await tap(plain, '[data-testid="tab-system"]');
  await plain.waitForSelector('[data-testid="panel-system"]');
  await sleep(1200);
  await tap(plain, '[data-testid="theme-dark"]');
  await sleep(100);
  add("no view transitions: theme switches instantly", (await plain.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await tap(plain, '[data-testid="theme-light"]');
  add("no view transitions: no console errors", plain.motionErrors().length === 0, plain.motionErrors());
  await plain.close();

  // ── B. view transitions without document.activeViewTransition ─────────────
  const older = await openPage(browser);
  await older.evaluateOnNewDocument(() => {
    delete Document.prototype.activeViewTransition;
  });
  await goto(older, "/motion?tab=flow");
  add("no activeViewTransition: the property really is absent", await older.evaluate(() => !("activeViewTransition" in document)));
  await tap(older, '[data-testid="card-b"]');
  await older.waitForSelector('[data-testid="lab-detail"][data-item="b"]');
  await older.waitForFunction(() => !document.documentElement.matches(":active-view-transition"), { timeout: 10000 });
  await sleep(100);
  let vt = await older.vt();
  const marks = await older.evaluate(() => ({ nav: document.documentElement.getAttribute("data-nav"), name: document.documentElement.style.viewTransitionName }));
  add("no activeViewTransition: the zoom transition still runs on the root snapshots", vt.length === 1 && vt[0].nav === "zoom" && vt[0].root.new.includes("tt-zoom-in"), vt.map((v) => [v.nav, v.root]));
  add("no activeViewTransition: marks are cleared when React reports the transition finished", marks.nav === null && marks.name === "", marks);
  await older.clearVt();
  await older.goBack();
  await older.waitForSelector('[data-testid="lab-home"]');
  await older.waitForFunction(() => !document.documentElement.matches(":active-view-transition"), { timeout: 10000 });
  vt = await older.vt();
  add("no activeViewTransition: Back plays the reverse", vt.length === 1 && vt[0].nav === "zoom" && vt[0].dir === "back", vt.map((v) => [v.nav, v.dir]));

  // interrupt: a tap during a slowed-down transition ends it and lands
  const client = await older.createCDPSession();
  await client.send("Animation.enable");
  await client.send("Animation.setPlaybackRate", { playbackRate: 0.08 });
  await tap(older, '[data-testid="card-a"]');
  await older.waitForSelector('[data-testid="lab-detail"]');
  await sleep(350);
  const during = await older.evaluate(() => document.documentElement.matches(":active-view-transition"));
  const point = await centre(older, '[data-testid="detail-add"]');
  await older.touchscreen.tap(point.x, point.y);
  await sleep(250);
  const after = await older.evaluate(() => ({ active: document.documentElement.matches(":active-view-transition"), count: document.querySelector('[data-testid="lab-cart-count"] .tt-num-sr')?.textContent }));
  add("no activeViewTransition: a tap still ends the running transition and lands", during && !after.active && after.count === "1", { during, ...after });
  add("no activeViewTransition: no console errors", older.motionErrors().length === 0, older.motionErrors());
  await older.close();
} finally {
  await browser.close();
}
process.exitCode = report("check-fallbacks", checks) ? 1 : 0;
