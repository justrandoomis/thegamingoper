// @ts-nocheck — node app/motion/__checks__/check-touch.mjs
// Press feedback (timing, depth, cancel, keyboard), haptics, number morph, materialize, and interrupting a transition.
import { centre, goto, launch, openPage, report, settled, sleep, tap } from "./lib.mjs";

const checks = [];
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const style = (page, selector, props) =>
  page.$eval(selector, (el, list) => Object.fromEntries(list.map((p) => [p, getComputedStyle(el)[p]])), props);
const attrs = (page, selector) => page.$eval(selector, (el) => ({ pressed: el.hasAttribute("data-pressed"), released: el.hasAttribute("data-released") }));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

/** Five presses on the clay button: when does the press animation start, relative to the touch? */
async function pressTiming(page) {
  await page.evaluate(() => {
    window.__press = [];
    window.__frames = [];
    let last = 0;
    const loop = (t) => {
      if (last) window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 60) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__pressProbe = (event) => {
      const el = event.target.closest?.("[data-press]");
      if (!el) return;
      // Registered after <MotionRoot>'s own capture listener, so the engine has already handled this event.
      const record = { down: event.timeStamp, handled: performance.now(), attribute: el.hasAttribute("data-pressed") };
      window.__press.push(record);
      requestAnimationFrame((frame) => {
        record.frame = frame;
        const animation = el.getAnimations().find((a) => a.animationName === "tt-press-in");
        record.running = animation?.playState ?? null;
        animation?.ready.then(
          () => (record.started = animation.startTime),
          () => {},
        );
      });
    };
    document.addEventListener("pointerdown", window.__pressProbe, true);
  });
  const point = await centre(page, '[data-testid="press-clay"]');
  for (let i = 0; i < 5; i++) {
    await page.touchscreen.touchStart(point.x, point.y);
    await sleep(170);
    await page.touchscreen.touchEnd();
    await sleep(500);
  }
  const records = await page.evaluate(() => {
    document.removeEventListener("pointerdown", window.__pressProbe, true);
    return window.__press;
  });
  const frameInterval = await page.evaluate(() => [...window.__frames].sort((a, b) => a - b)[Math.floor(window.__frames.length / 2)]);
  return {
    records,
    frameInterval: +frameInterval.toFixed(1),
    firstFrame: records.length === 5 && records.every((r) => r.running !== null && r.started !== undefined && r.started <= r.frame + 0.5),
    attribute: records.length === 5 && records.every((r) => r.attribute === true),
    fromTouch: records.map((r) => +(r.started - r.down).toFixed(1)),
    fromHandler: records.map((r) => +(r.started - r.handled).toFixed(1)),
  };
}

// Headless Chromium paces frames at whatever the (virtual) display reports — about 23 fps on the build machine —
// so milliseconds measured there are two slow frames, not the engine. A second browser with the frame-rate limit
// lifted runs at ~60 fps, the frame budget of the phones this is for. Both are measured and printed.
const fast = await launch(["--disable-frame-rate-limit"]);
try {
  const page = await openPage(fast);
  await goto(page, "/motion?tab=touch");
  const timing = await pressTiming(page);
  add("press @60fps: the animation starts in the first frame after the event (5 of 5)", timing.firstFrame, { "frame interval (ms)": timing.frameInterval, "event handled → animation start (ms)": timing.fromHandler });
  add("press @60fps: response starts within 80 ms of the touch timestamp (all 5)", timing.fromTouch.every((ms) => ms <= 80), { median: median(timing.fromTouch), all: timing.fromTouch });
} finally {
  await fast.close();
}

const browser = await launch();
try {
  const page = await openPage(browser);
  await page.evaluateOnNewDocument(() => {
    window.__vibrations = [];
    navigator.vibrate = (pattern) => {
      window.__vibrations.push(pattern);
      return true;
    };
  });
  await goto(page, "/motion?tab=touch");

  // ── press: when does the visual response start? ───────────────────────────
  const timing = await pressTiming(page);
  add("press: data-pressed is set inside the pointerdown event (5 of 5)", timing.attribute, timing.records.length);
  add("press: the animation starts in the first frame after the event (5 of 5)", timing.firstFrame, {
    "this browser's frame interval (ms)": timing.frameInterval,
    "event handled → animation start (ms)": timing.fromHandler,
    "touch timestamp → animation start (ms)": timing.fromTouch,
  });

  const clay = await centre(page, '[data-testid="press-clay"]');
  await page.touchscreen.touchStart(clay.x, clay.y);
  await sleep(170);
  const held = await style(page, '[data-testid="press-clay"]', ["scale", "translate"]);
  add("press clay: compresses 3 % and sinks 1px", held.scale === "0.97" && held.translate === "0px 1px", held);
  await page.touchscreen.touchEnd();
  await sleep(30);
  const afterRelease = await attrs(page, '[data-testid="press-clay"]');
  add("release: data-pressed → data-released (spring back)", !afterRelease.pressed && afterRelease.released, afterRelease);
  await sleep(600);
  const rest = { ...(await attrs(page, '[data-testid="press-clay"]')), ...(await style(page, '[data-testid="press-clay"]', ["scale"])) };
  add("release: back at rest, attributes cleaned up", !rest.pressed && !rest.released && rest.scale === "none", rest);
  add("press: every tap still clicked", (await page.$eval('[data-testid="press-count"]', (el) => el.textContent)).includes("6"));

  for (const [kind, scale] of [
    ["soft", "0.98"],
    ["icon", "0.94"],
  ]) {
    const point = await centre(page, `[data-testid="press-${kind}"]`);
    await page.touchscreen.touchStart(point.x, point.y);
    await sleep(160);
    const s = await style(page, `[data-testid="press-${kind}"]`, ["scale", "translate"]);
    await page.touchscreen.touchEnd();
    add(`press ${kind}: scale ${scale}, no sink`, s.scale === scale && (s.translate === "0px" || s.translate === "0px 0px" || s.translate === "none"), s);
    await sleep(80);
  }

  // cancel when the finger leaves
  const before = await page.$eval('[data-testid="press-count"]', (el) => el.textContent);
  await page.touchscreen.touchStart(clay.x, clay.y);
  await sleep(60);
  await page.touchscreen.touchMove(clay.x, clay.y + 90);
  await sleep(60);
  const left = await attrs(page, '[data-testid="press-clay"]');
  await page.touchscreen.touchEnd();
  await sleep(100);
  add("press: cancelled when the pointer leaves the element", !left.pressed, left);
  add("press: a cancelled press does not click", (await page.$eval('[data-testid="press-count"]', (el) => el.textContent)) === before);

  // keyboard
  await page.focus('[data-testid="press-soft"]');
  await page.keyboard.down("Space");
  await sleep(120);
  const keyHeld = await attrs(page, '[data-testid="press-soft"]');
  await page.keyboard.up("Space");
  await sleep(60);
  const keyUp = await attrs(page, '[data-testid="press-soft"]');
  add("press: Space gives the same feedback", keyHeld.pressed && !keyUp.pressed, [keyHeld, keyUp]);

  // haptics (navigator.vibrate is stubbed above; headless Chromium has no vibrator)
  const vibrations = await page.evaluate(() => window.__vibrations);
  add("haptic: data-haptic vibrates once the page has had a tap", vibrations.length >= 1 && vibrations.every((v) => v === 8 || v === 12), vibrations);

  // ── number morph ──────────────────────────────────────────────────────────
  const sr = (testid) => page.$eval(`[data-testid="${testid}"] .tt-num-sr`, (el) => el.textContent);
  const width = (testid) => page.$eval(`[data-testid="${testid}"]`, (el) => el.getBoundingClientRect().width);
  await tap(page, '[data-testid="qty-plus"]');
  const immediate = await page.evaluate(() => ({
    sr: document.querySelector('[data-testid="total"] .tt-num-sr').textContent,
    rolling: document.querySelectorAll('[data-testid="total"] .tt-num-in').length,
    leaving: document.querySelectorAll('[data-testid="total"] .tt-num-out').length,
    names: [...document.querySelectorAll('[data-testid="total"] .tt-num-in')].flatMap((el) => el.getAnimations().map((a) => a.animationName)),
  }));
  add("number: assistive text has the final value at once", immediate.sr.includes("1,498,000"), immediate.sr);
  add("number: changed digits roll (in and out)", immediate.rolling >= 4 && immediate.leaving >= 3 && immediate.names.includes("tt-num-in"), immediate);
  await sleep(350);
  const w2 = await width("total");
  await tap(page, '[data-testid="qty-plus"]');
  await sleep(350);
  const w3 = await width("total");
  add("number: same digit count → same width (tabular figures)", Math.abs(w2 - w3) < 0.6, [w2, w3]);
  add("number: value after two steps", (await sr("total")).includes("2,247,000") && (await sr("qty")) === "3", [await sr("total"), await sr("qty")]);
  for (let i = 0; i < 5; i++) await page.touchscreen.tap((await centre(page, '[data-testid="qty-plus"]')).x, (await centre(page, '[data-testid="qty-plus"]')).y);
  await sleep(400);
  add("number: rapid changes end on the right value", (await sr("qty")) === "8" && (await sr("total")).includes("5,992,000"), [await sr("qty"), await sr("total")]);
  // Read the number the way the eye does: the slots' current glyphs ordered by their position on screen.
  const visible = await page.$eval('[data-testid="total"] .tt-num-run', (run) =>
    [...run.querySelectorAll(".tt-num-slot")]
      .map((slot) => ({ x: slot.getBoundingClientRect().left, char: slot.lastElementChild.textContent }))
      .sort((a, b) => a.x - b.x)
      .map((s) => s.char)
      .join(""),
  );
  add("number: digits read left to right on screen inside Arabic text", visible === "5,992,000", visible);
  const order = await page.$eval('[data-testid="total"]', (el) => {
    const run = el.querySelector(".tt-num-run").getBoundingClientRect();
    const currency = [...el.querySelectorAll("span")].find((s) => s.textContent.trim() === "د.ع").getBoundingClientRect();
    return { numberLeft: run.left, currencyRight: currency.right };
  });
  add("number: currency sits after the number in reading order (to its left in RTL)", order.currencyRight <= order.numberLeft + 1, order);
  await tap(page, '[data-testid="currency"]');
  await sleep(350);
  add("number: currency switch morphs to the converted amount", (await sr("total")).startsWith("$"), await sr("total"));

  // ── materialize ────────────────────────────────────────────────────────────
  // Recorded inside the page in the frame the menu appears (a round trip to the test runner could miss a 140 ms fade).
  await page.evaluate(() => {
    window.__menu = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="menu"]');
        if (!el) return;
        observer.disconnect();
        requestAnimationFrame(() =>
          resolve({
            animations: el.getAnimations().length,
            origin: el.style.transformOrigin,
            properties: [...new Set(el.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
          }),
        );
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });
  await tap(page, '[data-testid="menu-open"]');
  await page.waitForSelector('[data-testid="menu"]');
  const opening = await page.evaluate(() => window.__menu);
  add("materialize: menu grows from its trigger (scale + opacity only)", opening.animations === 2 && opening.origin !== "" && opening.properties.sort().join() === "opacity,scale", opening);
  await sleep(500);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="menu"]'), { timeout: 3000 });
  add("dematerialize: Escape closes the menu and focus returns to the trigger", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "menu-open"));
  await tap(page, '[data-testid="toast-open"]');
  await page.waitForSelector('[data-testid="toast"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="toast"]'), { timeout: 5000 });
  add("toast: appears and dismisses itself", true);

  add("no console errors (touch tab)", page.motionErrors().length === 0, page.motionErrors());
  await page.close();

  // ── interrupting a page transition ───────────────────────────────────────
  for (const input of ["touch", "mouse"]) {
    const p = await openPage(browser, { touch: input === "touch" });
    await goto(p, "/motion?tab=flow");
    const client = await p.createCDPSession();
    await client.send("Animation.enable");
    await client.send("Animation.setPlaybackRate", { playbackRate: 0.08 }); // a 320 ms transition now lasts 4 s
    if (input === "touch") await tap(p, '[data-testid="card-a"]');
    else await p.click('[data-testid="card-a"]');
    await p.waitForSelector('[data-testid="lab-detail"]');
    await sleep(350);
    const during = await p.evaluate(() => ({ active: document.documentElement.matches(":active-view-transition"), hit: document.elementFromPoint(195, 600)?.tagName }));
    const point = await centre(p, '[data-testid="detail-add"]');
    const t0 = Date.now();
    if (input === "touch") await p.touchscreen.tap(point.x, point.y);
    else await p.mouse.click(point.x, point.y);
    await sleep(200);
    const after = await p.evaluate(() => ({
      active: document.documentElement.matches(":active-view-transition"),
      count: document.querySelector('[data-testid="lab-cart-count"] .tt-num-sr')?.textContent,
      nav: document.documentElement.getAttribute("data-nav"),
    }));
    add(`interrupt (${input}): the transition was animating and covering the page`, during.active && during.hit === "HTML", during);
    add(`interrupt (${input}): one tap ends the transition and still lands on the button`, !after.active && after.count === "1" && after.nav === null, { ...after, ms: Date.now() - t0 });
    add(`interrupt (${input}): no console errors`, p.motionErrors().length === 0, p.motionErrors());
    await p.close();
  }
} finally {
  await browser.close();
}
process.exitCode = report("check-touch", checks) ? 1 : 0;
