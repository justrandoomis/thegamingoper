// @ts-nocheck — node app/motion/__checks__/check-content.mjs
// Bubbles (reveal without layout shift, stagger cap), fly-to-cart (non-blocking, curved, capped), sheet physics,
// rails (keyboard, no vertical hijack), ambient pause.
import { centre, goto, launch, openPage, report, scrollY, settled, sleep, tap } from "./lib.mjs";

const browser = await launch();
const checks = [];
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const animatedProperties = (el) =>
  [...new Set(el.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).sort();

try {
  // ── bubbles ────────────────────────────────────────────────────────────────
  const page = await openPage(browser);
  await goto(page, "/motion?tab=flow");
  // Arrive on the reveal tab by navigating, so the tab's bubbles mount as part of a navigation commit.
  await tap(page, '[data-testid="tab-reveal"]');
  await page.waitForSelector('[data-testid="panel-reveal"]');
  const arriving = await page.evaluate(() => ({
    withPage: document.querySelector('[data-testid="bubble-with-page"]').className,
    always: document.querySelector('[data-testid="bubble-always"]').className,
  }));
  add("bubble: content that is part of a navigation does not inflate; `always` does", !arriving.withPage.includes("tt-bubble-in") && arriving.always.includes("tt-bubble-in"), arriving);
  await settled(page);

  await page.evaluate(() => {
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__shifts.push({
          value: entry.value,
          recentInput: entry.hadRecentInput,
          at: Math.round(entry.startTime),
          nodes: entry.sources.map((s) => s.node?.getAttribute?.("data-testid") ?? s.node?.className ?? s.node?.nodeName),
        });
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
  const boxHeight = () => page.$eval('[data-testid="reveal-box"]', (el) => el.getBoundingClientRect().height);
  const h0 = await boxHeight();
  await tap(page, '[data-testid="reveal-load"]');
  await sleep(250);
  const hFallback = await boxHeight();
  await page.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
  const reveal = await page.evaluate((props) => {
    const chips = [...document.querySelectorAll('[data-testid="reveal-grid"] > *')];
    const first = chips[0];
    const keys = [...new Set(first.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !props.includes(k)).sort();
    return {
      count: chips.length,
      classes: first.className,
      names: first.getAnimations().map((a) => a.animationName).sort(),
      properties: keys,
      delays: chips.map((c) => parseFloat(getComputedStyle(c).animationDelay) * 1000),
      height: document.querySelector('[data-testid="reveal-box"]').getBoundingClientRect().height,
      firstOpacity: +getComputedStyle(chips[chips.length - 1]).opacity,
    };
  }, ["offset", "easing", "composite", "computedOffset"]);
  add("bubble: six bubbles inflate with scale + opacity only", reveal.count === 6 && reveal.names.join() === "tt-bubble-fade,tt-bubble-scale" && reveal.properties.join() === "opacity,scale", reveal);
  add("bubble group: staggered, last one starts ≤ 400 ms after the first", Math.max(...reveal.delays) <= 400 && Math.max(...reveal.delays) > 0 && reveal.delays[0] === 0, reveal.delays);
  add("bubble: the last of the wave is still invisible while it waits (no pop)", reveal.firstOpacity < 0.2, reveal.firstOpacity);
  add("bubble: reserved geometry — the box never changes height", h0 === hFallback && hFallback === reveal.height, [h0, hFallback, reveal.height]);
  await sleep(900);
  // Shifts within 500 ms of the tap are the button's own label change (expected, user-initiated);
  // the reveal happens 900 ms later and must move nothing.
  const shifts = await page.evaluate(() => window.__shifts);
  const unexpected = shifts.filter((s) => !s.recentInput);
  add("bubble: zero layout shift when the content is revealed", unexpected.length === 0, shifts);
  const scaleDone = await page.$eval('[data-testid="chip-6"]', (el) => [getComputedStyle(el).scale, getComputedStyle(el).opacity]);
  add("bubble: settles at scale 1 / opacity 1", (scaleDone[0] === "none" || scaleDone[0] === "1") && scaleDone[1] === "1", scaleDone);
  await tap(page, '[data-testid="reveal-insert"]');
  await page.waitForSelector('[data-testid="chip-7"]');
  const inserted = await page.$eval('[data-testid="chip-7"]', (el) => ({ classes: el.className, origin: el.style.transformOrigin, delay: getComputedStyle(el).animationDelay }));
  add("bubble: an item inserted later inflates at once (no stagger delay) from the tap point", inserted.classes.includes("tt-bubble-in") && !inserted.classes.includes("tt-bubble-wave") && inserted.origin !== "" && inserted.delay.split(",").every((d) => parseFloat(d) === 0), inserted);

  // ── rail ───────────────────────────────────────────────────────────────────
  await sleep(600);
  const rail = '[data-testid="rail"]';
  await centre(page, rail);
  // Chromium's horizontal view timelines are wrong in RTL scrollers, so the engine's probe must leave the tilt off here.
  const tiltRtl = await page.$eval(rail, (el) => ({ attr: el.getAttribute("data-rail-tilt"), name: getComputedStyle(el.firstElementChild).animationName, opacity: getComputedStyle(el.firstElementChild).opacity }));
  add("rail (RTL): tilt stays off where the browser's view timeline is wrong — items are flat", tiltRtl.attr === "" && tiltRtl.name === "none" && tiltRtl.opacity === "1", tiltRtl);
  const left = () => page.$eval(rail, (el) => Math.round(el.scrollLeft));
  await page.focus(rail);
  await page.keyboard.press("ArrowLeft"); // RTL: left is forward
  await sleep(700);
  const afterKey = await left();
  add("rail: ← moves forward in RTL", afterKey < -100, afterKey);
  await page.keyboard.press("Home");
  await sleep(700);
  add("rail: Home returns to the start", (await left()) === 0, await left());
  await tap(page, '[data-testid="rail-next"]');
  await sleep(700);
  add("rail: the Next button steps one item", (await left()) < -100, await left());
  await page.keyboard.press("Home");
  await page.focus(rail);
  await page.keyboard.press("Home");
  await sleep(700);
  await tap(page, '[data-testid="rail-prev"]');
  await sleep(60);
  const bump = await page.$eval(rail, (el) => el.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))).filter((k) => k === "translate").length);
  add("rail: pushing past the start gives a rubber bump (transform only)", bump > 0 && (await left()) === 0, bump);

  // ── ambient ────────────────────────────────────────────────────────────────
  const ambient = '[data-testid="ambient"]';
  await centre(page, ambient);
  await sleep(300);
  const state = () => page.$eval(ambient, (el) => ({ attr: el.getAttribute("data-ambient"), play: getComputedStyle(el).animationPlayState, name: getComputedStyle(el).animationName }));
  const onScreen = await state();
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const offScreen = await state();
  await centre(page, ambient);
  await sleep(300);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await state();
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const shownAgain = await state();
  add("ambient: runs while on screen", onScreen.attr === "on" && onScreen.play === "running", onScreen);
  add("ambient: paused off screen", offScreen.attr === "off" && offScreen.play === "paused", offScreen);
  add("ambient: paused in a hidden tab, resumes after", hidden.play === "paused" && shownAgain.play === "running", [hidden, shownAgain]);
  add("no console errors (reveal tab)", page.motionErrors().length === 0, page.motionErrors());
  await page.close();

  // ── content is not held back by a page animation ───────────────────────────
  // React parks Suspense reveals behind a running view transition. Slow the animation 20× (a 320 ms page
  // transition then lasts 6.4 s), start a navigation that keeps this page mounted, and let data become ready
  // 0.9 s into it: the engine must fast-forward the rest instead of making the content wait ~5 s.
  const hold = await openPage(browser);
  await goto(hold, "/motion?tab=reveal");
  const slowdown = await hold.createCDPSession();
  await slowdown.send("Animation.enable");
  await slowdown.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
  await hold.evaluate(() => {
    window.__held = {};
    new MutationObserver(() => {
      if (!window.__held.shown && document.querySelector('[data-testid="chip-1"]')) window.__held.shown = performance.now();
    }).observe(document.body, { childList: true, subtree: true });
    // Same routes in another language: the page (and its Suspense boundary) stays mounted during the transition.
    window.__reactRouterDataRouter.navigate("/en/motion?tab=reveal", { replace: true, preventScrollReset: true });
  });
  await hold.waitForFunction(() => document.documentElement.hasAttribute("data-nav") && window.__vt[0]?.ready, { timeout: 15000 });
  await sleep(150);
  await hold.evaluate(() => {
    window.__held.asked = performance.now();
    document.querySelector('[data-testid="reveal-load"]').click(); // no pointer event: must not count as an interruption
  });
  await hold.waitForSelector('[data-testid="chip-1"]', { timeout: 20000 });
  await sleep(100);
  const held = await hold.evaluate(() => ({ waited: Math.round(window.__held.shown - window.__held.asked), unhurriedEnd: Math.round(window.__vt[0].ready + 320 / 0.05 - window.__held.asked) }));
  add("reveal during a page transition: shown soon after its data is ready, the animation is hurried, not waited for", held.waited >= 850 && held.waited < held.unhurriedEnd - 2000, { "data ready after (ms)": 900, "shown after (ms)": held.waited, "transition would have ended after (ms)": held.unhurriedEnd });
  add("no console errors (hurry run)", hold.motionErrors().length === 0, hold.motionErrors());
  await hold.close();

  // rail on a mouse device: the vertical wheel scrolls the page, never the rail
  const desktop = await openPage(browser, { touch: false, width: 900, height: 700, dpr: 1 });
  await goto(desktop, "/motion?tab=reveal");
  const point = await centre(desktop, rail);
  await sleep(300);
  const y0 = await scrollY(desktop);
  const x0 = await desktop.$eval(rail, (el) => el.scrollLeft);
  await desktop.mouse.move(point.x, point.y);
  await desktop.mouse.wheel({ deltaY: 240 });
  await sleep(500);
  const wheel = { pageMoved: (await scrollY(desktop)) - y0, railBefore: x0, railAfter: await desktop.$eval(rail, (el) => el.scrollLeft) };
  add("rail: vertical wheel over the rail scrolls the page, not the rail", wheel.pageMoved > 100 && wheel.railAfter === wheel.railBefore, wheel);
  await desktop.close();

  // English (LTR): the depth tilt is on, scroll-driven, and only items crossing an edge lean
  const ltr = await openPage(browser);
  await goto(ltr, "/en/motion?tab=reveal");
  await sleep(1500);
  await centre(ltr, rail);
  const tilt = await ltr.$eval(rail, (el) => {
    const box = el.getBoundingClientRect();
    const items = [...el.children].map((c) => {
      const r = c.getBoundingClientRect();
      const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
      return { inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, crossing: r.left < box.right && r.right > box.right, lean: Math.abs(m.m31) > 1e-4 };
    });
    return {
      attr: el.getAttribute("data-rail-tilt"),
      name: getComputedStyle(el.firstElementChild).animationName,
      timeline: getComputedStyle(el.firstElementChild).animationTimeline,
      insideFlat: items.filter((i) => i.inside).every((i) => !i.lean),
      crossingLeans: items.filter((i) => i.crossing).every((i) => i.lean) && items.some((i) => i.crossing),
      start: el.scrollLeft,
    };
  });
  add("rail (LTR): depth tilt is scroll-driven; items inside are flat, the one crossing the edge leans", tilt.attr === "on" && tilt.name === "tt-rail-tilt" && tilt.timeline.includes("view") && tilt.insideFlat && tilt.crossingLeans && tilt.start === 0, tilt);
  await ltr.close();

  // ── fly to cart ────────────────────────────────────────────────────────────
  const cart = await openPage(browser);
  await goto(cart, "/motion?tab=cart");
  await sleep(1200); // the on-demand chunk is fetched at idle
  await cart.evaluate(() => {
    window.__received = [];
    document.addEventListener("tt:cart-received", (e) => window.__received.push({ flown: e.detail.flown, t: Math.round(performance.now()) }));
    // Sample where the puck is on every frame.
    window.__path = [];
    const loop = () => {
      const puck = document.querySelector(".tt-fly");
      if (puck) {
        const r = puck.getBoundingClientRect();
        window.__path.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const count = () => cart.$eval('[data-testid="lab-cart-count"] .tt-num-sr', (el) => el.textContent);
  const addButton = await centre(cart, '[data-testid="fly-add"]');
  await cart.touchscreen.tap(addButton.x, addButton.y);
  const right = await cart.evaluate(() => ({
    count: document.querySelector('[data-testid="lab-cart-count"] .tt-num-sr').textContent,
    pucks: document.querySelectorAll(".tt-fly").length,
    received: window.__received.length,
    properties: [...new Set([...document.querySelectorAll(".tt-fly")].flatMap((p) => p.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k)))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).sort(),
  }));
  add("fly: the cart count is already updated while the puck is still in the air", right.count === "1" && right.pucks === 1 && right.received === 0, right);
  add("fly: the flight animates transform + opacity only", right.properties.join() === "opacity,transform", right.properties);
  await sleep(1100);
  const flight = await cart.evaluate(() => {
    const path = window.__path;
    const target = document.querySelector('[data-testid="lab-cart"]').getBoundingClientRect();
    const a = path[0];
    const b = path[path.length - 1];
    // Largest distance of any sampled point from the straight line a → b.
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const bow = Math.max(...path.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length));
    return {
      samples: path.length,
      bow: Math.round(bow),
      endsAtCart: Math.hypot(b.x - (target.left + target.width / 2), b.y - (target.top + target.height / 2)) < 30,
      startWidth: Math.round(a.w),
      endWidth: Math.round(b.w),
      received: window.__received,
      left: document.querySelectorAll(".tt-fly").length,
    };
  });
  add("fly: travels a curved path into the cart and shrinks to a puck", flight.samples > 5 && flight.bow > 20 && flight.endsAtCart && flight.endWidth < flight.startWidth / 2, flight);
  add("fly: the cart is told on arrival (tt:cart-received, flown) and the puck is removed", flight.received.length === 1 && flight.received[0].flown === true && flight.left === 0, flight.received);

  // rapid taps
  await cart.evaluate(() => {
    window.__received.length = 0;
    window.__maxPucks = 0;
    const watch = () => {
      window.__maxPucks = Math.max(window.__maxPucks, document.querySelectorAll(".tt-fly").length);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  for (let i = 0; i < 7; i++) await cart.touchscreen.tap(addButton.x, addButton.y);
  const rapidNow = await count();
  await sleep(1500);
  const rapid = await cart.evaluate(() => ({ max: window.__maxPucks, received: window.__received.length, flown: window.__received.filter((r) => r.flown).length, left: document.querySelectorAll(".tt-fly").length }));
  add("fly: seven rapid taps all counted immediately", rapidNow === "8", rapidNow);
  add("fly: at most four flights at once, every tap acknowledged, nothing left behind", rapid.max <= 4 && rapid.max >= 2 && rapid.received === 7 && rapid.left === 0, rapid);

  // ── sheet ──────────────────────────────────────────────────────────────────
  const sheet = '[data-testid="sheet"]';
  const top = () => cart.$eval(sheet, (el) => Math.round(el.getBoundingClientRect().top));
  const geometry = async () => cart.$eval(sheet, (el) => ({ height: el.offsetHeight, viewport: window.innerHeight }));
  await tap(cart, '[data-testid="sheet-open"]');
  await cart.waitForSelector(sheet);
  const opening = await cart.$eval(sheet, (el) => ({
    properties: [...new Set(el.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
    frames: el.getAnimations()[0]?.effect.getKeyframes().length ?? 0,
  }));
  add("sheet: opens with one spring animation on translate only", opening.properties.join() === "translate" && opening.frames > 10, opening);
  await sleep(800);
  const g = await geometry();
  const half = g.viewport - Math.round(g.height * 0.5);
  const full = g.viewport - g.height;
  add("sheet: rests at the 50 % snap point", Math.abs((await top()) - half) <= 1, [await top(), half]);
  add("sheet: focus moved into the dialog", await cart.evaluate(() => document.activeElement?.getAttribute("data-testid") === "sheet"));

  const handle = await cart.$eval('[data-testid="sheet-handle"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // slow drag up by 200px: follows the finger 1:1
  await cart.touchscreen.touchStart(handle.x, handle.y);
  for (let i = 1; i <= 10; i++) {
    await cart.touchscreen.touchMove(handle.x, handle.y - i * 20);
    await sleep(40);
  }
  await sleep(150);
  const dragged = await top();
  add("sheet: follows the finger 1:1 from where it was grabbed", Math.abs(dragged - (half - 200)) <= 2, [dragged, half - 200]);
  await cart.touchscreen.touchEnd();
  await sleep(900);
  add("sheet: released nearer the open point with no momentum → settles fully open", Math.abs((await top()) - full) <= 1, [await top(), full]);

  // a small slow drag down from fully open returns to fully open (nearest snap point)
  await cart.touchscreen.touchStart(handle.x, full + 22);
  for (let i = 1; i <= 4; i++) {
    await cart.touchscreen.touchMove(handle.x, full + 22 + i * 15);
    await sleep(40);
  }
  await sleep(150);
  await cart.touchscreen.touchEnd();
  await sleep(900);
  add("sheet: a short slow drag returns to the nearest snap point", Math.abs((await top()) - full) <= 1, [await top(), full]);

  // rubber band past the top
  const handleFull = { x: handle.x, y: full + 22 };
  await cart.touchscreen.touchStart(handleFull.x, handleFull.y);
  for (let i = 1; i <= 5; i++) {
    await cart.touchscreen.touchMove(handleFull.x, handleFull.y - i * 30);
    await sleep(30);
  }
  await sleep(120);
  const stretched = full - (await top());
  await cart.touchscreen.touchEnd();
  await sleep(900);
  add("sheet: rubber-bands past the most open point and springs back", stretched > 20 && stretched < 110 && Math.abs((await top()) - full) <= 1, { pulled: 150, moved: stretched, restedAt: await top() });

  // Interrupt mid-flight: ask for the half snap point and grab the handle while the sheet is travelling.
  // The grab is issued from inside the page, in the same frame the position is read, so the timing is exact.
  const grab = await cart.evaluate(
    (full, half) =>
      new Promise((resolve) => {
        const sheetElement = document.querySelector('[data-testid="sheet"]');
        const handleElement = document.querySelector('[data-testid="sheet-handle"]');
        const pointer = (type, y) => handleElement.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 77, pointerType: "touch", isPrimary: true, clientX: 195, clientY: y, button: 0 }));
        document.querySelector('[data-testid="sheet-half"]').click();
        const started = performance.now();
        const loop = () => {
          const before = sheetElement.getBoundingClientRect().top;
          if (performance.now() - started > 3000) return resolve({ timeout: true, before });
          if (before < full + 50 || before > half - 50) return requestAnimationFrame(loop);
          pointer("pointerdown", before + 22);
          const caught = sheetElement.getBoundingClientRect().top;
          const animations = sheetElement.getAnimations().length;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const still = sheetElement.getBoundingClientRect().top;
              pointer("pointermove", before + 22 + 30);
              const followed = sheetElement.getBoundingClientRect().top;
              pointer("pointerup", before + 22 + 30);
              resolve({ before, caught, animations, still, followed });
            }),
          );
        };
        requestAnimationFrame(loop);
      }),
    full,
    half,
  );
  add("sheet: grabbed mid-flight it stops exactly where it was (no jump, no drift)", !grab.timeout && Math.abs(grab.caught - grab.before) <= 1.5 && Math.abs(grab.still - grab.caught) <= 0.5 && grab.animations === 0, grab);
  add("sheet: and follows the finger again from there", !grab.timeout && Math.abs(grab.followed - (grab.caught + 30)) <= 1.5, grab);
  await sleep(900);
  add("sheet: after the interrupted flight it settles on a snap point", [full, half].some((snap) => Math.abs(snap - Math.round(grab.followed)) < 400) && [full, half].includes(await top()), await top());

  // flick down: momentum carries it past the lowest snap point → dismissed
  const now = await top();
  await cart.touchscreen.touchStart(handle.x, now + 22);
  for (let i = 1; i <= 4; i++) {
    await cart.touchscreen.touchMove(handle.x, now + 22 + i * 45);
    await sleep(16);
  }
  await cart.touchscreen.touchEnd();
  await cart.waitForFunction(() => !document.querySelector('[data-testid="sheet"]'), { timeout: 3000 });
  add("sheet: a downward flick dismisses it (onClose) and focus returns to the opener", await cart.evaluate(() => document.activeElement?.getAttribute("data-testid") === "sheet-open"));

  await tap(cart, '[data-testid="sheet-open"]');
  await cart.waitForSelector(sheet);
  await sleep(700);
  await cart.keyboard.press("Escape");
  await cart.waitForFunction(() => !document.querySelector('[data-testid="sheet"]'), { timeout: 3000 });
  add("sheet: Escape closes it", true);
  add("no console errors (cart tab)", cart.motionErrors().length === 0, cart.motionErrors());
  await cart.close();
} finally {
  await browser.close();
}
process.exitCode = report("check-content", checks) ? 1 : 0;
