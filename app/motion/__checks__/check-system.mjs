// @ts-nocheck — node app/motion/__checks__/check-system.mjs
// Quality tier (override, OS reduced motion, Save-Data, low memory), what 'reduced' and 'lite' actually change,
// theme morph (transform-only reveal, state and scroll kept) and direction morph (language switch).
import { captureTransition, centre, frozen, goto, historyLength, launch, openPage, release, report, scrollY, seek, settled, sleep, tap, url } from "./lib.mjs";

const browser = await launch();
const checks = [];
const frames = {};
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const tier = (page) => page.evaluate(() => document.documentElement.getAttribute("data-motion"));

try {
  // ── tier switcher ──────────────────────────────────────────────────────────
  const page = await openPage(browser);
  await goto(page, "/motion?tab=system");
  add("tier: 'full' on a capable device", (await tier(page)) === "full", await tier(page));
  await tap(page, '[data-testid="tier-lite"]');
  add("tier: override 'lite' applies at once and is stored", (await tier(page)) === "lite" && (await page.evaluate(() => localStorage.getItem("tt:motion"))) === "lite", await tier(page));
  await tap(page, '[data-testid="tier-reduced"]');
  add("tier: override 'reduced'", (await tier(page)) === "reduced", await tier(page));

  // ── everything still works under 'reduced', without movement ─────────────
  await page.clearVt();
  await tap(page, '[data-testid="tab-flow"]');
  await page.waitForSelector('[data-testid="panel-flow"]');
  await tap(page, '[data-testid="card-b"]');
  await page.waitForSelector('[data-testid="lab-detail"][data-item="b"]');
  await page.goBack();
  await page.waitForSelector('[data-testid="lab-home"]');
  await sleep(300);
  add("reduced: navigation, detail and Back work with no view transition at all", (await page.vt()).length === 0 && url(page) === "/motion?tab=flow", [(await page.vt()).length, url(page)]);

  await tap(page, '[data-testid="tab-touch"]');
  await page.waitForSelector('[data-testid="panel-touch"]');
  const clay = await centre(page, '[data-testid="press-clay"]');
  await page.touchscreen.touchStart(clay.x, clay.y);
  await sleep(120);
  const pressed = await page.$eval('[data-testid="press-clay"]', (el) => ({ attr: el.hasAttribute("data-pressed"), animation: getComputedStyle(el).animationName, scale: getComputedStyle(el).scale, opacity: getComputedStyle(el).opacity }));
  await page.touchscreen.touchEnd();
  add("reduced: press feedback is an opacity change, not a movement", pressed.attr && pressed.animation === "none" && pressed.scale === "none" && pressed.opacity === "0.72", pressed);
  await tap(page, '[data-testid="qty-plus"]');
  const digit = await page.$eval('[data-testid="total"] .tt-num-in', (el) => getComputedStyle(el).animationName);
  add("reduced: numbers cross-fade instead of rolling", digit === "tt-fade-in", digit);

  await tap(page, '[data-testid="tab-reveal"]');
  await page.waitForSelector('[data-testid="panel-reveal"]');
  await tap(page, '[data-testid="reveal-load"]');
  await page.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
  const chip = await page.$eval('[data-testid="chip-3"]', (el) => ({ names: getComputedStyle(el).animationName, delay: getComputedStyle(el).animationDelay, duration: getComputedStyle(el).animationDuration }));
  add("reduced: bubbles are a 120 ms fade with no scale and no stagger", chip.names === "tt-bubble-fade" && parseFloat(chip.delay) === 0 && chip.duration === "0.12s", chip);
  const ambient = await page.$eval('[data-testid="ambient"]', (el) => getComputedStyle(el).animationName);
  add("reduced: ambient motion is off", ambient === "none", ambient);

  await tap(page, '[data-testid="tab-cart"]');
  await page.waitForSelector('[data-testid="panel-cart"]');
  await sleep(1200);
  await page.evaluate(() => {
    window.__received = [];
    document.addEventListener("tt:cart-received", (e) => window.__received.push(e.detail.flown));
  });
  await tap(page, '[data-testid="fly-add"]');
  const fly = await page.evaluate(() => ({ pucks: document.querySelectorAll(".tt-fly").length, received: window.__received, count: document.querySelector('[data-testid="lab-cart-count"] .tt-num-sr').textContent }));
  add("reduced: add-to-cart has no flight; the cart is told immediately and the count is right", fly.pucks === 0 && fly.received.length === 1 && fly.received[0] === false && fly.count === "1", fly);
  await tap(page, '[data-testid="sheet-open"]');
  await page.waitForSelector('[data-testid="sheet"]');
  const sheet = await page.$eval('[data-testid="sheet"]', (el) => ({
    top: Math.round(el.getBoundingClientRect().top),
    expected: window.innerHeight - Math.round(el.offsetHeight * 0.5),
    moving: el.getAnimations().some((a) => a.effect.getKeyframes().some((k) => "translate" in k || "transform" in k)),
  }));
  add("reduced: the sheet is placed at its snap point without travelling", sheet.top === sheet.expected && !sheet.moving, sheet);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="sheet"]'));

  await tap(page, '[data-testid="tab-system"]');
  await page.waitForSelector('[data-testid="panel-system"]');
  await page.clearVt();
  await tap(page, '[data-testid="theme-dark"]');
  await sleep(150);
  add("reduced: theme switches instantly (no transition)", (await page.vt()).length === 0 && (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await tap(page, '[data-testid="theme-light"]');
  await tap(page, '[data-testid="tier-auto"]');
  add("tier: 'automatic' removes the override", (await tier(page)) === "full" && (await page.evaluate(() => localStorage.getItem("tt:motion"))) === null, await tier(page));
  add("no console errors (reduced run)", page.motionErrors().length === 0, page.motionErrors());
  await page.close();

  // ── signals ────────────────────────────────────────────────────────────────
  const os = await openPage(browser, { reducedMotion: true });
  await goto(os, "/motion?tab=flow");
  add("signal: prefers-reduced-motion → 'reduced'", (await tier(os)) === "reduced", await tier(os));
  await os.clearVt();
  await tap(os, '[data-testid="card-a"]');
  await os.waitForSelector('[data-testid="lab-detail"]');
  await sleep(300);
  add("signal: reduced-motion emulation removes page movement (no view transition)", (await os.vt()).length === 0, (await os.vt()).length);
  await os.evaluate(() => localStorage.setItem("tt:motion", "full"));
  await goto(os, "/motion?tab=flow");
  add("signal: the shopper's explicit 'full' override wins over the OS setting", (await tier(os)) === "full", await tier(os));
  await os.evaluate(() => localStorage.removeItem("tt:motion"));
  await os.close();

  for (const [label, patch] of [
    ["Save-Data", () => Object.defineProperty(Navigator.prototype, "connection", { configurable: true, get: () => ({ saveData: true, addEventListener() {} }) })],
    ["2 GB of memory", () => Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 2 })],
    ["4 GB and 4 cores", () => {
      Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 4 });
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { configurable: true, get: () => 4 });
    }],
  ]) {
    const p = await openPage(browser);
    await p.evaluateOnNewDocument(patch);
    await goto(p, "/motion?tab=flow");
    add(`signal: ${label} → 'lite'`, (await tier(p)) === "lite", await tier(p));
    if (label === "Save-Data") {
      // what 'lite' changes
      await p.clearVt();
      await tap(p, '[data-testid="tab-reveal"]');
      await p.waitForSelector('[data-testid="panel-reveal"]');
      await settled(p);
      const vt = await p.vt();
      add("lite: the page still pushes, but the page underneath only fades (no parallax layer)", vt.length === 1 && vt[0].nav === "push-forward" && vt[0].root.old.join() === "tt-fade-out" && vt[0].root.new.includes("tt-push-over-in"), vt[0]?.root);
      await tap(p, '[data-testid="reveal-load"]');
      await p.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
      const chip = await p.$eval('[data-testid="chip-4"]', (el) => ({ names: getComputedStyle(el).animationName, delay: getComputedStyle(el).animationDelay }));
      add("lite: bubbles fade in together (no stagger, no overshoot)", chip.names === "tt-bubble-fade" && parseFloat(chip.delay) === 0, chip);
      const ambient = await p.$eval('[data-testid="ambient"]', (el) => getComputedStyle(el).animationName);
      add("lite: ambient motion is off", ambient === "none", ambient);
      add("no console errors (lite run)", p.motionErrors().length === 0, p.motionErrors());
    }
    await p.close();
  }

  // ── theme morph ────────────────────────────────────────────────────────────
  const theme = await openPage(browser);
  await goto(theme, "/motion?tab=system");
  await sleep(1200); // on-demand chunk
  await theme.evaluate(() => window.scrollTo(0, 140));
  await sleep(200);
  const y0 = await scrollY(theme);
  const button = await theme.$eval('[data-testid="theme-dark"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await theme.freezeNext();
  await theme.touchscreen.tap(button.x, button.y);
  await frozen(theme);
  const reveal = {};
  for (const p of [0.15, 0.4, 0.7]) {
    await seek(theme, p);
    reveal[p] = await theme.evaluate(() => {
      const root = document.documentElement;
      const group = new DOMMatrixReadOnly(getComputedStyle(root, "::view-transition-group(tt-theme-new)").transform);
      const image = new DOMMatrixReadOnly(getComputedStyle(root, "::view-transition-new(tt-theme-new)").transform);
      return { clipScale: +group.a.toFixed(4), product: +(group.a * image.a).toFixed(5), theme: root.dataset.theme };
    });
    await theme.screenshot({ path: `.shots/motion/theme-circle-${String(Math.round(p * 100)).padStart(3, "0")}.png` });
  }
  const during = await theme.evaluate(() => ({
    morph: document.documentElement.getAttribute("data-morph"),
    names: window.__vt.at(-1).animations,
    properties: [...new Set(window.__frozen.animations.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
    origin: [getComputedStyle(document.documentElement).getPropertyValue("--morph-x"), getComputedStyle(document.documentElement).getPropertyValue("--morph-y")],
  }));
  await release(theme);
  await settled(theme);
  add("theme: circular reveal from the pressed control", during.morph === "circle" && Math.abs(parseFloat(during.origin[0]) - button.x) < 2 && Math.abs(parseFloat(during.origin[1]) - button.y) < 2, during.origin);
  add("theme: only transforms are animated (no clip-path, mask or blur)", during.properties.join() === "transform", during.properties);
  add("theme: the clip grows while the picture counter-scales — product stays 1 (picture stands still)", Object.values(reveal).every((r) => Math.abs(r.product - 1) < 0.002) && reveal[0.15].clipScale < reveal[0.4].clipScale && reveal[0.4].clipScale < reveal[0.7].clipScale, reveal);
  const after = await theme.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    morph: document.documentElement.getAttribute("data-morph"),
    name: document.documentElement.style.viewTransitionName,
    cookie: document.cookie.includes("tt_prefs=dark"),
    checked: document.querySelector('[data-testid="theme-dark"]').getAttribute("aria-checked"),
  }));
  add("theme: applied, remembered (cookie), control updated, marks cleaned up", after.theme === "dark" && after.morph === null && after.name === "" && after.cookie && after.checked === "true", after);
  add("theme: scroll position untouched", (await scrollY(theme)) === y0, [await scrollY(theme), y0]);

  // sweep at the 'lite' tier
  await theme.evaluate(() => localStorage.setItem("tt:motion", "lite"));
  await theme.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "tt:motion" })));
  await sleep(100);
  const light = await centre(theme, '[data-testid="theme-light"]');
  await theme.freezeNext();
  await theme.touchscreen.tap(light.x, light.y);
  await frozen(theme);
  await seek(theme, 0.4);
  const sweep = await theme.evaluate(() => {
    const root = document.documentElement;
    const group = new DOMMatrixReadOnly(getComputedStyle(root, "::view-transition-group(tt-theme-new)").transform);
    const image = new DOMMatrixReadOnly(getComputedStyle(root, "::view-transition-new(tt-theme-new)").transform);
    return { morph: root.getAttribute("data-morph"), clip: Math.round(group.e), picture: Math.round(image.e) };
  });
  await theme.screenshot({ path: ".shots/motion/theme-sweep-040.png" });
  await release(theme);
  await settled(theme);
  add("theme (lite): light sweep — the clip slides, the picture counter-slides by exactly the same amount", sweep.morph === "sweep" && sweep.clip !== 0 && sweep.clip === -sweep.picture, sweep);
  await theme.evaluate(() => localStorage.removeItem("tt:motion"));
  add("no console errors (theme run)", theme.motionErrors().length === 0, theme.motionErrors());
  await theme.close();

  // ── direction morph ────────────────────────────────────────────────────────
  const lang = await openPage(browser);
  await goto(lang, "/motion?tab=system");
  await centre(lang, '[data-testid="language-field"]');
  await lang.type('[data-testid="language-field"]', "طمطم 123");
  const ly = await scrollY(lang);
  const lh = await historyLength(lang);
  frames.direction = await captureTransition(lang, "direction", () => tap(lang, '[data-testid="lang-en"]', { scroll: false }), [0.1, 0.35, 0.6, 0.9]);
  await lang.waitForFunction(() => document.documentElement.dir === "ltr");
  await settled(lang);
  let vt = await lang.vt();
  const state = await lang.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    field: document.querySelector('[data-testid="language-field"]').value,
    title: document.querySelector(".lab-bar__title").textContent,
  }));
  add("language: one transition, data-nav=direction", vt.length === 1 && vt[0].nav === "direction", vt.map((v) => v.nav));
  add("language: URL, lang and dir switched; strings are English", url(lang) === "/en/motion?tab=system" && state.lang === "en-IQ" && state.dir === "ltr" && state.title === "Motion lab", [url(lang), state]);
  add("language: form state survived", state.field === "طمطم 123", state.field);
  add("language: scroll position kept", Math.abs((await scrollY(lang)) - ly) <= 1, [await scrollY(lang), ly]);
  add("language: history entry replaced (Back leaves the page, not the language)", (await historyLength(lang)) === lh, [(await historyLength(lang)) - lh]);
  add("language: old page leaves toward the RTL end (left), new one enters from the LTR start (left)", vt[0].root.old.includes("tt-dir-out") && vt[0].root.new.includes("tt-dir-in"), vt[0]?.root);
  // RTL → RTL (Arabic ↔ Kurdish) and LTR → RTL signs
  await lang.clearVt();
  await lang.evaluate(() => {
    window.__signs = [];
    new MutationObserver(() => {
      const s = document.documentElement.style;
      if (s.getPropertyValue("--nav-out")) window.__signs.push([s.getPropertyValue("--nav-out"), s.getPropertyValue("--nav-in")]);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  });
  await tap(lang, '[data-testid="lang-ckb"]', { scroll: false });
  await lang.waitForFunction(() => document.documentElement.lang === "ckb-IQ");
  await settled(lang);
  const toRtl = await lang.evaluate(() => window.__signs.at(-1));
  add("language: LTR → RTL leaves to the right and enters from the right", toRtl?.[0] === "1" && toRtl?.[1] === "1" && url(lang) === "/ckb/motion?tab=system", [toRtl, url(lang)]);
  add("no console errors (language run)", lang.motionErrors().length === 0, lang.motionErrors());
  await lang.close();

  console.log("frames:", JSON.stringify(frames));
} finally {
  await browser.close();
}
process.exitCode = report("check-system", checks) ? 1 : 0;
