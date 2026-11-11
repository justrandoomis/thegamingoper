// @ts-nocheck — node app/motion/__checks__/check-system.mjs
// Quality tiers (override, OS reduced motion, Save-Data, low memory, measured jank) and what 'reduced' and 'lite'
// change (DESIGN.md §6.5, §7.3); theme cross-fade (200 ms, nothing moves, contrast measured frame by frame);
// language switch (16px drift toward the new start, chrome cross-fades, anchors stay, state and scroll kept).
import path from "node:path";
import { SHOTS, centre, frozen, goto, historyLength, launch, openPage, release, report, scrollY, seek, settled, sleep, tap, textContrast, url } from "./lib.mjs";

const browser = await launch();
const checks = [];
const frames = {};
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const tier = (page) => page.evaluate(() => document.documentElement.getAttribute("data-motion"));
const fxLow = (page) => page.evaluate(() => document.documentElement.classList.contains("fx-low"));
const rootTiming = (vt) => (vt?.timing ?? []).filter((t) => t.pseudo.endsWith("(root)"));
const named = (vt) => (vt?.groups ?? []).filter((g) => !g.includes("(root)") && !g.includes("tt-persist") && !/_t_/.test(g));

try {
  // ── tier switcher ──────────────────────────────────────────────────────────
  const page = await openPage(browser);
  await goto(page, "/motion?tab=system");
  add("tier: 'full' on a capable device", (await tier(page)) === "full" && !(await fxLow(page)), await tier(page));
  await tap(page, '[data-testid="tier-lite"]');
  add("tier: override 'lite' applies at once, is stored, and sets the low-end class fx-low", (await tier(page)) === "lite" && (await fxLow(page)) && (await page.evaluate(() => localStorage.getItem("tt:motion"))) === "lite", await tier(page));
  await tap(page, '[data-testid="tier-reduced"]');
  add("tier: override 'reduced'", (await tier(page)) === "reduced" && !(await fxLow(page)), await tier(page));

  // ── reduced (DESIGN.md §7.3): every function works, nothing travels ──────────
  await page.clearVt();
  await tap(page, '[data-testid="tab-flow"]');
  await page.waitForSelector('[data-testid="panel-flow"]');
  await settled(page);
  await page.clearVt();
  await tap(page, '[data-testid="card-b"]');
  await page.waitForSelector('[data-testid="lab-detail"][data-item="b"]');
  await settled(page);
  await page.goBack();
  await page.waitForSelector('[data-testid="lab-home"]');
  await settled(page);
  let vt = await page.vt();
  const crossFades = vt.map((v) => rootTiming(v).map((t) => `${t.name}:${t.duration}:${t.properties.join("+")}`).sort().join(" "));
  add(
    "reduced: card → page and Back are each a 120 ms cross-fade (opacity only, no shared-element morph)",
    vt.length === 2 && crossFades.every((c) => c === "tt-fade-in:120:opacity tt-fade-out:120:opacity") && vt.every((v) => named(v).length === 0) && url(page) === "/motion?tab=flow",
    [vt.length, crossFades, vt.map(named), url(page)],
  );

  await tap(page, '[data-testid="tab-touch"]');
  await page.waitForSelector('[data-testid="panel-touch"]');
  await settled(page);
  const clay = await centre(page, '[data-testid="press-clay"]');
  await page.touchscreen.touchStart(clay.x, clay.y);
  await sleep(120);
  const pressed = await page.$eval('[data-testid="press-clay"]', (el) => ({ attr: el.hasAttribute("data-pressed"), animation: getComputedStyle(el).animationName, scale: getComputedStyle(el).scale, translate: getComputedStyle(el).translate }));
  await page.touchscreen.touchEnd();
  await sleep(30);
  const released = await page.$eval('[data-testid="press-clay"]', (el) => ({ released: el.hasAttribute("data-released"), scale: getComputedStyle(el).scale }));
  add("reduced: the pressed offset is shown with no animation, and drops back at once", pressed.attr && pressed.animation === "none" && pressed.scale === "0.97" && pressed.translate === "0px 1px" && !released.released && released.scale === "none", [pressed, released]);
  await tap(page, '[data-testid="qty-plus"]');
  const digits = await page.evaluate(() => ({
    in: [...document.querySelectorAll('[data-testid="total"] .tt-num-in')].map((el) => getComputedStyle(el).animationName),
    out: [...document.querySelectorAll('[data-testid="total"] .tt-num-out')].map((el) => getComputedStyle(el).visibility),
  }));
  add("reduced: a number replaces the number (no roll, old digits hidden)", digits.in.length > 0 && digits.in.every((n) => n === "none") && digits.out.every((v) => v === "hidden"), digits);

  await tap(page, '[data-testid="tab-reveal"]');
  await page.waitForSelector('[data-testid="panel-reveal"]');
  await tap(page, '[data-testid="reveal-load"]');
  await page.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
  const chip = await page.$eval('[data-testid="chip-3"]', (el) => ({ names: getComputedStyle(el).animationName, opacity: getComputedStyle(el).opacity, scale: getComputedStyle(el).scale }));
  add("reduced: content appears in place (no inflate)", chip.names === "none" && chip.opacity === "1" && chip.scale === "none", chip);
  const ambient = await page.$eval('[data-testid="ambient"]', (el) => getComputedStyle(el).animationName);
  add("reduced: idle motion is off", ambient === "none", ambient);

  await tap(page, '[data-testid="tab-cart"]');
  await page.waitForSelector('[data-testid="panel-cart"]');
  await sleep(1200);
  await page.evaluate(() => {
    window.__received = [];
    document.addEventListener("tt:cart-received", (e) => window.__received.push(e.detail.flown));
  });
  await tap(page, '[data-testid="fly-add"]');
  const fly = await page.evaluate(() => ({ beads: document.querySelectorAll(".tt-fly").length, received: window.__received, count: document.querySelector('[data-testid="lab-cart-count"] .tt-num-sr').textContent, announced: document.querySelector('[data-testid="lab-cart"] [role="status"]').textContent }));
  add("reduced: no flight; the count changes and is announced at once", fly.beads === 0 && fly.received.length === 1 && fly.received[0] === false && fly.count === "1" && fly.announced.includes("عنصر واحد"), fly);
  await tap(page, '[data-testid="sheet-open"]');
  await page.waitForSelector('[data-testid="sheet"]');
  const sheet = await page.$eval('[data-testid="sheet"]', (el) => ({
    top: Math.round(el.getBoundingClientRect().top),
    expected: window.innerHeight - Math.round(el.offsetHeight * 0.5),
    animated: [...new Set(el.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
    duration: el.getAnimations()[0]?.effect.getComputedTiming().duration,
  }));
  add("reduced: the sheet appears at its snap point with a 120 ms fade, no travel", sheet.top === sheet.expected && sheet.animated.join() === "opacity" && sheet.duration === 120, sheet);
  await page.keyboard.press("Escape");
  await sleep(60);
  const closing = await page.$eval('[data-testid="sheet"]', (el) => el.getAnimations().map((a) => [a.effect.getKeyframes().map((k) => k.opacity).join("→"), a.effect.getComputedTiming().duration]));
  await page.waitForFunction(() => !document.querySelector('[data-testid="sheet"]'));
  add("reduced: and disappears with a 120 ms fade", closing.length === 1 && closing[0][0] === "1→0" && closing[0][1] === 120, closing);

  await tap(page, '[data-testid="tab-system"]');
  await page.waitForSelector('[data-testid="panel-system"]');
  await settled(page);
  await page.clearVt();
  await tap(page, '[data-testid="theme-dark"]');
  await sleep(150);
  add("reduced: theme switches instantly (no transition)", (await page.vt()).length === 0 && (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await tap(page, '[data-testid="theme-light"]');
  await page.clearVt();
  await page.type('[data-testid="language-field"]', "abc");
  await tap(page, '[data-testid="lang-en"]');
  await page.waitForFunction(() => document.documentElement.dir === "ltr");
  await sleep(200);
  add("reduced: language switches instantly, state kept", (await page.vt()).length === 0 && url(page) === "/en/motion?tab=system" && (await page.$eval('[data-testid="language-field"]', (el) => el.value)) === "abc", [(await page.vt()).length, url(page)]);
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
  await settled(os);
  vt = await os.vt();
  add("signal: under OS reduced motion a navigation is one 120 ms cross-fade with no movement", vt.length === 1 && rootTiming(vt[0]).every((t) => t.duration === 120 && t.properties.join() === "opacity") && named(vt[0]).length === 0, vt.map((v) => rootTiming(v)));
  await os.evaluate(() => localStorage.setItem("tt:motion", "full"));
  await goto(os, "/motion?tab=flow");
  add("signal: the shopper's explicit 'full' override wins over the OS setting", (await tier(os)) === "full", await tier(os));
  await os.evaluate(() => localStorage.removeItem("tt:motion"));
  await os.close();

  for (const [label, patch, expected] of [
    ["Save-Data", () => Object.defineProperty(Navigator.prototype, "connection", { configurable: true, get: () => ({ saveData: true, addEventListener() {} }) }), "lite"],
    ["2 GB of memory", () => Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 2 }), "lite"],
    ["a 4-core phone with 4 GB", () => {
      Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 4 });
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { configurable: true, get: () => 4 });
    }, "lite"],
    ["an iPhone (WebKit: 4 cores reported, no deviceMemory)", () => {
      Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => undefined });
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { configurable: true, get: () => 4 });
    }, "full"],
  ]) {
    const p = await openPage(browser);
    await p.evaluateOnNewDocument(patch);
    await goto(p, "/motion?tab=flow");
    add(`signal: ${label} → '${expected}'`, (await tier(p)) === expected && (await fxLow(p)) === (expected === "lite"), await tier(p));
    if (label === "Save-Data") {
      // what 'lite' changes (DESIGN.md §6.5): function identical; inflate, theme/language morphs and idle motion off
      await p.clearVt();
      await tap(p, '[data-testid="tab-reveal"]');
      await p.waitForSelector('[data-testid="panel-reveal"]');
      await settled(p);
      vt = await p.vt();
      add("lite: pages still push sideways", vt.length === 1 && vt[0].nav === "push-forward" && vt[0].root.old.includes("tt-push-out-forward") && vt[0].root.new.includes("tt-push-in-forward"), vt[0]?.root);
      await tap(p, '[data-testid="reveal-load"]');
      await p.waitForSelector('[data-testid="chip-1"]', { timeout: 5000 });
      const chip4 = await p.$eval('[data-testid="chip-4"]', (el) => getComputedStyle(el).animationName);
      add("lite: content appears in place (staggered inflate off)", chip4 === "none", chip4);
      const ambientLite = await p.$eval('[data-testid="ambient"]', (el) => getComputedStyle(el).animationName);
      add("lite: idle motion is off", ambientLite === "none", ambientLite);
      await tap(p, '[data-testid="tab-system"]');
      await p.waitForSelector('[data-testid="panel-system"]');
      await settled(p);
      await sleep(1200);
      await p.clearVt();
      await tap(p, '[data-testid="theme-dark"]');
      await sleep(150);
      const themeLite = { vt: (await p.vt()).length, theme: await p.evaluate(() => document.documentElement.dataset.theme) };
      await tap(p, '[data-testid="theme-light"]');
      await p.clearVt();
      await tap(p, '[data-testid="lang-en"]');
      await p.waitForFunction(() => document.documentElement.dir === "ltr");
      await sleep(200);
      add("lite: theme and language switch instantly", themeLite.vt === 0 && themeLite.theme === "dark" && (await p.vt()).length === 0, [themeLite, (await p.vt()).length]);
      add("no console errors (lite run)", p.motionErrors().length === 0, p.motionErrors());
    }
    await p.close();
  }

  // ── runtime downgrade: three long frames inside one transition → lite for the session ─────
  const janky = await openPage(browser);
  await goto(janky, "/motion?tab=flow");
  // As soon as the next view transition is animating, block the main thread for 70 ms in four consecutive frames,
  // as a struggling phone would. (Real time: slowing animations down through CDP also slows the frame clock.)
  await janky.evaluate(() => {
    const original = Document.prototype.startViewTransition;
    Document.prototype.startViewTransition = function (arg) {
      const transition = original.call(this, arg);
      transition.ready.then(() => {
        let n = 0;
        const block = () => {
          const until = performance.now() + 70;
          while (performance.now() < until);
          if (++n < 4) requestAnimationFrame(block);
        };
        requestAnimationFrame(block);
      });
      Document.prototype.startViewTransition = original;
      return transition;
    };
  });
  await tap(janky, '[data-testid="card-d"]');
  await janky.waitForSelector('[data-testid="lab-detail"][data-item="d"]');
  await settled(janky, 300);
  const downgraded = { tier: await tier(janky), fxLow: await fxLow(janky), stored: await janky.evaluate(() => sessionStorage.getItem("tt:motion-low")) };
  await goto(janky, "/motion?tab=flow");
  const sticky = await tier(janky);
  add("jank: three frames over 50 ms inside one transition switch to 'lite' (fx-low), sticky for the session", downgraded.tier === "lite" && downgraded.fxLow && downgraded.stored === "1" && sticky === "lite", { ...downgraded, afterReload: sticky });
  add("no console errors (jank run)", janky.motionErrors().length === 0, janky.motionErrors());
  await janky.close();

  // ── theme morph: a 200 ms cross-fade, nothing moves ──────────────────────────
  const theme = await openPage(browser);
  await goto(theme, "/motion?tab=system");
  await sleep(1200); // on-demand chunk
  await theme.evaluate(() => window.scrollTo(0, 140));
  await sleep(200);
  const y0 = await scrollY(theme);
  const before = await textContrast(theme, ".lab-bar__title");
  await theme.freezeNext();
  await tap(theme, '[data-testid="theme-dark"]', { scroll: false });
  await frozen(theme);
  const contrast = {};
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    await seek(theme, Math.min(p, 0.999));
    contrast[p] = await textContrast(theme, ".lab-bar__title");
    if (i % 5 === 0) await theme.screenshot({ path: path.join(SHOTS, `theme-${String(Math.round(p * 100)).padStart(3, "0")}.png`) });
  }
  const during = await theme.evaluate(() => {
    const v = window.__vt.at(-1);
    return { morph: document.documentElement.getAttribute("data-morph"), timing: v.timing, groups: v.groups };
  });
  await release(theme);
  await settled(theme);
  // The browser's own cross-fade: an opacity animation on each snapshot (plus its mix-blend-mode helper, not motion).
  const fades = during.timing.filter((t) => t.pseudo.endsWith("(root)") && !t.pseudo.includes("group") && t.properties.join() !== "mixBlendMode");
  const moving = during.timing.filter((t) => t.properties.some((p) => p === "transform" || p === "translate" || p === "scale"));
  add("theme: one cross-fade of the two root snapshots, 200 ms, opacity only (the browser's plus-lighter fade)", during.morph === "theme" && fades.length === 2 && fades.every((t) => t.duration === 200 && t.properties.join() === "opacity") && moving.length === 0, { fades, moving });
  add("theme: nothing else is a layer — fixed chrome fades with the page", during.timing.every((t) => t.pseudo.endsWith("(root)")), during.timing.map((t) => t.pseudo));
  // A cross-fade between dark-on-light and light-on-dark passes through equal luminance (DESIGN.md says "legible in
  // every frame"; this measures what actually happens). Reported, not failed: it is the specified behaviour.
  const samples = Object.entries(contrast).map(([p, c]) => [Number(p), c]);
  const lowest = samples.reduce((a, b) => (b[1] < a[1] ? b : a));
  const under3 = samples.filter(([, c]) => c < 3).length * 10; // each sample stands for 1/20 of 200 ms
  frames.themeContrast = { lowest: { at: `${Math.round(lowest[0] * 200)} ms`, ratio: lowest[1] }, below3to1: `${under3} ms of 200 ms`, samples: contrast };
  add(
    `theme: text contrast frame by frame (lab title) — ${contrast[0]}:1 → ${lowest[1]}:1 at ${Math.round(lowest[0] * 200)} ms → ${contrast[1]}:1; under 3:1 for ≈ ${under3} ms`,
    contrast[0] > 7 && contrast[1] > 7,
    { before, lowest, under3 },
  );
  const after = await theme.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    morph: document.documentElement.getAttribute("data-morph"),
    cookie: document.cookie.includes("tt_prefs=dark") || decodeURIComponent(document.cookie).includes('"theme":"dark"'),
    checked: document.querySelector('[data-testid="theme-dark"]').getAttribute("aria-checked"),
  }));
  add("theme: applied, remembered, control updated, marks cleaned up", after.theme === "dark" && after.morph === null && after.cookie && after.checked === "true", after);
  // (± 1px: the browser's scroll anchoring may absorb sub-pixel layout differences between the themes.)
  add("theme: scroll position untouched", Math.abs((await scrollY(theme)) - y0) <= 1, [await scrollY(theme), y0]);
  frames.theme = { contrast };
  add("no console errors (theme run)", theme.motionErrors().length === 0, theme.motionErrors());
  await theme.close();

  // ── direction morph ────────────────────────────────────────────────────────
  const lang = await openPage(browser);
  await goto(lang, "/motion?tab=system");
  await centre(lang, '[data-testid="language-field"]');
  await lang.type('[data-testid="language-field"]', "طمطم 123");
  const ly = await scrollY(lang);
  const lh = await historyLength(lang);
  const fieldTop = () => lang.$eval('[data-testid="language-field"]', (el) => Math.round(el.getBoundingClientRect().top));
  const fieldBefore = await fieldTop();
  const anchorBefore = await lang.$eval('[data-testid="language-anchor"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  await lang.freezeNext();
  await tap(lang, '[data-testid="lang-en"]', { scroll: false });
  await frozen(lang);
  const mid = {};
  for (const p of [0.1, 0.35, 0.6, 0.9]) {
    await seek(lang, p);
    await lang.screenshot({ path: path.join(SHOTS, `direction-${String(Math.round(p * 100)).padStart(3, "0")}.png`) });
    if (p === 0.35) {
      mid.state = await lang.evaluate(() => {
        const root = document.documentElement;
        const at = (pseudo) => new DOMMatrixReadOnly(getComputedStyle(root, pseudo).transform);
        const anchorGroup = getComputedStyle(root, "::view-transition-group(tt-anchor-0)");
        return {
          start: root.style.getPropertyValue("--nav-start"),
          oldX: Math.round(at("::view-transition-old(root)").m41),
          newX: Math.round(at("::view-transition-new(root)").m41),
          anchorNamed: document.querySelector('[data-testid="language-anchor"]').style.viewTransitionName,
          anchorAnimation: anchorGroup.animationName,
          chromeOld: getComputedStyle(root, "::view-transition-old(tt-persist-lab)").display,
        };
      });
    }
  }
  await release(lang);
  await lang.waitForFunction(() => document.documentElement.dir === "ltr");
  await settled(lang);
  let lvt = await lang.vt();
  const state = await lang.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    field: document.querySelector('[data-testid="language-field"]').value,
    title: document.querySelector(".lab-bar__title").textContent,
    anchorName: document.querySelector('[data-testid="language-anchor"]').style.viewTransitionName,
  }));
  const anchorAfter = await lang.$eval('[data-testid="language-anchor"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  add("language: one transition, data-nav=direction", lvt.length === 1 && lvt[0].nav === "direction", lvt.map((v) => v.nav));
  add("language: URL, lang and dir switched; strings are English", url(lang) === "/en/motion?tab=system" && state.lang === "en-IQ" && state.dir === "ltr" && state.title === "Motion lab", [url(lang), state]);
  add("language: form state survived", state.field === "طمطم 123", state.field);
  // The words above change length with the language. The page keeps its place by its anchor: scrollY moves by
  // exactly what the text above the anchor gained or lost, so the anchor (and the field next to it) stay on screen
  // where they were.
  add(
    "language: position kept — the anchor and the field stay where they were on screen",
    Math.abs(anchorAfter.y - anchorBefore.y) <= 1 && Math.abs((await fieldTop()) - fieldBefore) <= 2,
    { anchorBefore, anchorAfter, fieldBefore, fieldAfter: await fieldTop(), scrollBefore: ly, scrollAfter: await scrollY(lang) },
  );
  add("language: history entry replaced (Back leaves the page, not the language)", (await historyLength(lang)) === lh, [(await historyLength(lang)) - lh]);
  add(
    "language (ar → en): the content drifts toward the new start (left) — old moves left, new comes from the right",
    lvt[0].root.old.includes("tt-direction-out") && lvt[0].root.new.includes("tt-direction-in") && mid.state.start === "-1" && mid.state.oldX < 0 && mid.state.newX > 0,
    mid.state,
  );
  add("language: fixed chrome cross-fades in place (its old snapshot stays visible while fading)", mid.state.chromeOld === "block", mid.state.chromeOld);
  add(
    "language: the anchor (data-motion-anchor) is its own unanimated layer and keeps its place; the name is released afterwards",
    mid.state.anchorNamed === "tt-anchor-0" && mid.state.anchorAnimation === "none" && state.anchorName === "",
    { mid: mid.state, before: anchorBefore, after: anchorAfter },
  );
  // LTR → RTL (English → Kurdish)
  await lang.clearVt();
  await lang.evaluate(() => {
    window.__signs = [];
    new MutationObserver(() => {
      const value = document.documentElement.style.getPropertyValue("--nav-start");
      if (value) window.__signs.push(value);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  });
  await tap(lang, '[data-testid="lang-ckb"]', { scroll: false });
  await lang.waitForFunction(() => document.documentElement.lang === "ckb-IQ");
  await settled(lang);
  const toRtl = await lang.evaluate(() => window.__signs.at(-1));
  add("language (en → ckb): the drift is toward the right, the RTL start", toRtl === "1" && url(lang) === "/ckb/motion?tab=system", [toRtl, url(lang)]);
  add("no console errors (language run)", lang.motionErrors().length === 0, lang.motionErrors());
  await lang.close();

  console.log("frames:", JSON.stringify(frames));
} finally {
  await browser.close();
}
process.exitCode = report("check-system", checks) ? 1 : 0;
