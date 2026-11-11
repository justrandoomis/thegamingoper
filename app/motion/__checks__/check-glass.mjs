// @ts-nocheck — node app/motion/__checks__/check-glass.mjs   (MOTION_SHOTS=<dir> to choose where pictures go)
// Design System v2 §2.10b, §2.11, §11: "no element with a view-transition-name may contain .glass" (CI check, owner M).
//
// An element with a view-transition-name is a backdrop root: glass inside it frosts only what is painted inside that
// element, so page text shows sharply through the header and the mega menu. The engine therefore names its chrome
// (data-motion-persist) and the language-switch anchors only while a view transition runs (motion.css). On the real
// pages of the running dev server this check proves:
//   1. at rest no element but <html> carries a name — so none that is or contains glass — on storefront pages at 390
//      and 1440, light and dark, at the top and scrolled (the header's live glass is up), with the mega menu open,
//      after page transitions and after a language switch (whose anchor marks are released);
//   2. while a transition runs the chrome still stays put: it is its own layer with an OLD and a NEW snapshot (each
//      rendered alone shows the chrome; an element is captured in exactly one place, so it is not in the page
//      snapshots), and a language-switch anchor is marked, named and captured the same way;
//   3. what shows through every live glass pane of the chrome, and through the open mega menu, is frosted: the pane is
//      photographed with its own content hidden and its high-pass has no edges (p99.9 ≤ 3 of 255 levels). Two controls
//      prove the measure sees the bug: the same pane with the old resting name put back on its chrome element, and the
//      same pane with its backdrop-filter removed, both show sharp text (p99.9 ≫ 3);
//   4. the admin (local demo account from .dev.seed-credentials — never printed): /admin and one module page at 1440,
//      light and dark — no names at rest, panes frosted.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { goto, launch, openPage, ORIGIN, report, settled, SHOTS, sleep } from "./lib.mjs";

const { default: sharp } = await import("sharp");
const checks = [];
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const shot = (name) => path.join(SHOTS, `glass-${name}.png`);

/** The old engine: the chrome named at rest (what this fix removed). Put on the chrome element only. */
const RESTING_NAME = (persist) => `[data-motion-persist="${persist}"] { view-transition-name: tt-control-${persist} !important; }`;
/** Photograph one pane alone: every other piece of chrome and the pane's own content are hidden; the page stays. */
const PANE_ONLY = `[data-motion-persist] *, [data-tt-pane] * { visibility: hidden !important; } [data-tt-pane] { visibility: visible !important; }`;
/**
 * Show one view-transition pseudo-element of a frozen transition. No `animation: none`: removing the animations would
 * end the transition; !important declarations win over the paused animations in the cascade.
 */
const ONLY_PSEUDO = (pseudo) => `::view-transition-old(*), ::view-transition-new(*) { opacity: 0 !important; } ${pseudo} { display: block !important; opacity: 1 !important; transform: none !important; }`;

const STORE_PAGES = ["/", "/support", "/platform/playstation", "/p/splatoon-raiders", "/cart", "/used", "/search?q=zelda", "/en", "/ckb", "/motion"];

/* ───────────────────────────── helpers ───────────────────────────── */

/** Elements that carry a view-transition-name now (<html> aside), whether they are or contain glass, and leftover marks. */
const namesNow = (page) =>
  page.evaluate(() => {
    const isGlass = (el) => el.classList?.contains("glass") || !["none", ""].includes(getComputedStyle(el).backdropFilter || "none");
    const label = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
    const named = [];
    for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
      const name = getComputedStyle(el).viewTransitionName;
      if (!name || name === "none") continue;
      named.push({ element: label(el), name, isGlass: isGlass(el), containsGlass: [...el.querySelectorAll("*")].filter(isGlass).map(label).slice(0, 3) });
    }
    return { named, marks: document.querySelectorAll("[data-motion-anchored]").length, active: document.documentElement.matches(":active-view-transition") };
  });

/** Collects resting-name findings per context so each rule is one PASS/FAIL line with every offender listed. */
const rest = { visited: [], named: [], containsGlass: [], marks: [] };
async function atRest(page, where) {
  const now = await namesNow(page);
  rest.visited.push(where);
  if (now.active) return; // never judged mid-transition
  for (const n of now.named) {
    rest.named.push(`${where}: ${n.element} → ${n.name}`);
    if (n.containsGlass.length > 0) rest.containsGlass.push(`${where}: ${n.element} → ${n.name} contains ${n.containsGlass.join(", ")}`);
  }
  if (now.marks > 0) rest.marks.push(`${where}: ${now.marks} element(s) still marked data-motion-anchored`);
}

const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
  const step = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(count);
}), n);

/** Screenshot of a viewport rectangle (clip coordinates are document coordinates; never re-render beyond the viewport). */
async function grab(page, box, inset = 0, file) {
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY }));
  const x = Math.max(0, box.x + inset);
  const y = Math.max(0, box.y + inset);
  const width = Math.min(view.w, box.x + box.w - inset) - x;
  const height = Math.min(view.h, box.y + box.h - inset) - y;
  if (width < 8 || height < 8) return null;
  return page.screenshot({ clip: { x: x + view.sx, y: y + view.sy, width, height }, captureBeyondViewport: false, ...(file ? { path: file } : {}) });
}

/** Luminance statistics of a picture: high-pass (|L − 3×3 mean|) percentiles and the share of edge pixels, plus spread. */
async function picture(png) {
  const { data, info } = await sharp(png).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const high = [];
  let edges = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    sq += data[i] * data[i];
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let around = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around += data[(y + dy) * w + (x + dx)];
      const value = Math.abs(data[y * w + x] - around / 9);
      high.push(value);
      if (value > 6) edges++;
    }
  }
  high.sort((a, b) => a - b);
  const at = (q) => +(high[Math.min(high.length - 1, Math.floor(high.length * q))] ?? 0).toFixed(2);
  const mean = sum / data.length;
  return { p999: at(0.999), p995: at(0.995), edgesPct: +((edges / Math.max(1, high.length)) * 100).toFixed(3), sd: +Math.sqrt(Math.max(0, sq / data.length - mean * mean)).toFixed(2) };
}
// Measured in Chromium 157 (2026-11-11): frosted panes p999 ≤ 0.5 with no edge pixels; the controls (old resting name,
// unfrosted) p999 7.9–34 with 0.7–10 % edge pixels.
const frosted = (m) => m && m.p999 <= 3 && m.edgesPct <= 0.1;
const sharpText = (m) => m && (m.p999 >= 5 || m.edgesPct >= 0.3);

/**
 * The panes to judge: live glass (backdrop-filter) of the persistent chrome that is on screen, plus `extra` (the open
 * mega menu, judged whether it is glass or opaque). Each gets an id; `inside` = the chrome element it sits strictly in.
 */
const panesOf = (page, extra = null) =>
  page.evaluate((extraSelector) => {
    const live = (el) => !["none", ""].includes(getComputedStyle(el).backdropFilter || "none");
    const onScreen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const found = new Set([...document.querySelectorAll("[data-motion-persist], [data-motion-persist] *")].filter(live));
    if (extraSelector) for (const el of document.querySelectorAll(extraSelector)) found.add(el);
    return [...found]
      .filter((el) => onScreen(el.getBoundingClientRect()))
      .map((el, i) => {
        el.setAttribute("data-tt-pane-id", String(i));
        const r = el.getBoundingClientRect();
        const chrome = el.closest("[data-motion-persist]");
        return {
          id: i,
          label: el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\s+/).slice(0, 3).join("."),
          live: live(el),
          extra: extraSelector ? el.matches(extraSelector) : false,
          box: { x: r.x, y: r.y, w: r.width, h: r.height },
          persist: chrome?.getAttribute("data-motion-persist") ?? null,
          inside: chrome !== null && chrome !== el,
        };
      });
  }, extra);

/** Photograph each pane alone and measure what shows through; with `control`, re-run under the two bug controls. */
async function measurePanes(page, label, { extra = null, control = false } = {}) {
  const results = [];
  for (const pane of await panesOf(page, extra)) {
    const one = async (css, suffix) => {
      const tag = await page.addStyleTag({ content: PANE_ONLY + "\n" + css });
      await page.evaluate((id) => document.querySelector(`[data-tt-pane-id="${id}"]`)?.setAttribute("data-tt-pane", ""), pane.id);
      await frames(page);
      const png = await grab(page, pane.box, 8, suffix === "" ? shot(`${label}-pane${pane.id}`) : undefined);
      await page.evaluate((id) => document.querySelector(`[data-tt-pane-id="${id}"]`)?.removeAttribute("data-tt-pane"), pane.id);
      await tag.evaluate((el) => el.remove());
      return png ? picture(png) : null;
    };
    const result = { pane: pane.label, live: pane.live, extra: pane.extra, now: await one("", "") };
    if (control && pane.live) {
      // the old engine: the chrome element named at rest (only a backdrop root ABOVE the glass breaks it)
      if (pane.inside) result.restingName = await one(RESTING_NAME(pane.persist), "-name");
      // glass that frosts nothing: what the bug looks like, whatever the DOM
      result.unfrosted = await one(`[data-tt-pane-id="${pane.id}"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`, "-unfrosted");
    }
    results.push(result);
  }
  return results;
}

/** Scroll so that the first section heading (else sub-heading, else paragraph) below `minTop` sits under the header. */
async function textUnderHeader(page, minTop = 300) {
  const aim = (min) => {
    const header = document.querySelector('[data-motion-persist="header"]');
    const bar = header ? header.getBoundingClientRect() : { top: 0, height: 56 };
    const below = (selector) => [...document.querySelectorAll(selector)].find((el) => el.getBoundingClientRect().top + scrollY > min && el.textContent.trim().length > 4);
    const text = below("main h2") ?? below("main h3") ?? below("main p");
    if (!text) return;
    const r = text.getBoundingClientRect();
    // the header sticks at its own top once scrolled: the text's middle goes to the bar's middle
    window.scrollBy(0, r.top + r.height / 2 - (Math.max(0, bar.top) + bar.height / 2));
  };
  await page.evaluate(aim, minTop);
  await sleep(450); // the header's scrolled state (IntersectionObserver) and its glass layer
  await page.evaluate(aim, minTop); // once more: the header may have changed height when it stuck
  await sleep(300);
}

/** Freeze the transition started by `click`, then render each listed pseudo-element alone and measure it. */
async function frozenLayers(page, click, layers) {
  await page.freezeNext();
  await click();
  await page.waitForFunction(() => window.__frozen !== null, { timeout: 30000 });
  const tag = await page.addStyleTag({ content: "/* probe */" });
  const out = {};
  for (const [key, pseudo, box] of layers()) {
    await tag.evaluate((el, css) => (el.textContent = css), ONLY_PSEUDO(pseudo));
    await frames(page);
    const png = await grab(page, await box(), 0, shot(`snapshot-${key}`));
    out[key] = png ? await picture(png) : null;
  }
  await tag.evaluate((el) => el.remove());
  const during = await namesNow(page);
  await page.evaluate(() => {
    for (const a of window.__frozen?.animations ?? []) {
      try {
        a.finish();
      } catch {}
    }
    window.__frozen = null;
  });
  await settled(page, 250);
  return { layers: out, during };
}

const boxOf = (page, selector) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
  }, selector);

/** A picture with content in it (a snapshot that exists), against an empty one (a snapshot that does not). */
const hasContent = (m) => m && m.sd > 4;

function adminCredentials() {
  const file = path.resolve(".dev.seed-credentials");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const read = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.trim();
  const email = read("ADMIN_EMAIL");
  const password = read("ADMIN_PASSWORD");
  return email && password ? { email, password } : null;
}

/* ───────────────────────────── run ───────────────────────────── */

const browser = await launch();
const errors = [];
const adminErrors = [];
try {
  console.log("browser:", await browser.version(), "· pictures:", SHOTS);

  // ── 1. names at rest on storefront pages ─────────────────────────────────
  for (const [width, height, touch] of [
    [390, 844, true],
    [1440, 900, false],
  ]) {
    for (const dark of [false, true]) {
      const page = await openPage(browser, { width, height, touch, dark, dpr: 1 });
      for (const url of STORE_PAGES) {
        await goto(page, url);
        await atRest(page, `${url} ${width} ${dark ? "dark" : "light"} top`);
        await page.evaluate(() => window.scrollTo(0, Math.min(900, document.documentElement.scrollHeight - innerHeight)));
        await sleep(450);
        await atRest(page, `${url} ${width} ${dark ? "dark" : "light"} scrolled`);
      }
      errors.push(...page.motionErrors().map((e) => `${width} ${dark ? "dark" : "light"}: ${e}`));
      await page.close();
    }
  }

  // ── 3. frost: the spec's three views, light and dark, with the controls ────
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";

    const desk = await openPage(browser, { width: 1440, height: 900, touch: false, dark, dpr: 1 });
    await goto(desk, "/support");
    await desk.evaluate(() => window.scrollTo(0, 1500));
    await sleep(500);
    await desk.screenshot({ path: shot(`support-1440-${theme}-scrolled1500`), captureBeyondViewport: false });
    const support = await measurePanes(desk, `support-1440-${theme}`, { control: true });
    add(`/support at 1440 scrolled 1500px (${theme}): every live pane of the chrome is frosted — no legible text behind the header`, support.length > 0 && support.every((r) => frosted(r.now)), support);
    add(
      `/support at 1440 (${theme}) controls: the old resting name and an unfrosted pane both show sharp text, so the measure sees the bug`,
      support.some((r) => sharpText(r.restingName)) && support.every((r) => !r.live || sharpText(r.unfrosted)),
      support.map((r) => ({ pane: r.pane, restingName: r.restingName?.p999, unfrosted: r.unfrosted?.p999 })),
    );
    {
      // the old engine, for the picture: the header named at rest
      const tag = await desk.addStyleTag({ content: RESTING_NAME("header") });
      await frames(desk);
      await desk.screenshot({ path: shot(`support-1440-${theme}-scrolled1500-OLD-resting-name`), captureBeyondViewport: false });
      await tag.evaluate((el) => el.remove());
    }

    // the mega menu over the hero
    await goto(desk, "/");
    const trigger = await desk.$('[data-motion-persist="header"] button[aria-expanded="false"]');
    if (trigger) {
      await trigger.click();
      await sleep(700);
    }
    const panelId = await desk.evaluate(() => document.querySelector('button[aria-expanded="true"][aria-controls]')?.getAttribute("aria-controls") ?? null);
    const panel = panelId ? `[id="${panelId}"]` : null;
    await atRest(desk, `/ 1440 ${theme} mega menu open`);
    await desk.screenshot({ path: shot(`mega-1440-${theme}-over-hero`), captureBeyondViewport: false });
    const mega = panel ? await measurePanes(desk, `mega-1440-${theme}`, { extra: panel, control: true }) : [];
    const panelResult = mega.find((r) => r.extra);
    add(`mega menu open over the hero at 1440 (${theme}): no text over text — the page behind the menu is frosted or covered`, panel !== null && frosted(panelResult?.now), panel ? mega : "no mega-menu trigger ([data-motion-persist=header] button[aria-expanded]) or panel (aria-controls) found");
    if (panel && panelResult?.live) {
      add(`mega menu (${theme}) controls: with the old resting name / unfrosted, hero text shows through it`, sharpText(panelResult.unfrosted) && (panelResult.restingName === undefined || sharpText(panelResult.restingName)), { restingName: panelResult.restingName, unfrosted: panelResult.unfrosted });
      const tag = await desk.addStyleTag({ content: RESTING_NAME("header") });
      await frames(desk);
      await desk.screenshot({ path: shot(`mega-1440-${theme}-over-hero-OLD-resting-name`), captureBeyondViewport: false });
      await tag.evaluate((el) => el.remove());
    }
    errors.push(...desk.motionErrors().map((e) => `frost 1440 ${theme}: ${e}`));
    await desk.close();

    const phone = await openPage(browser, { width: 390, height: 844, dark, dpr: 2 });
    await goto(phone, "/");
    await textUnderHeader(phone);
    await phone.screenshot({ path: shot(`home-390-${theme}-scrolled`), captureBeyondViewport: false });
    const home = await measurePanes(phone, `home-390-${theme}`, { control: true });
    add(`/ at 390 scrolled (${theme}): every live pane of the chrome is frosted — no legible text behind the header`, home.length > 0 && home.every((r) => frosted(r.now)), home);
    add(
      `/ at 390 (${theme}) controls: sharp text under the old resting name / unfrosted`,
      home.some((r) => sharpText(r.restingName) || sharpText(r.unfrosted)),
      home.map((r) => ({ pane: r.pane, restingName: r.restingName?.p999, unfrosted: r.unfrosted?.p999 })),
    );
    {
      const tag = await phone.addStyleTag({ content: RESTING_NAME("header") });
      await frames(phone);
      await phone.screenshot({ path: shot(`home-390-${theme}-scrolled-OLD-resting-name`), captureBeyondViewport: false });
      await tag.evaluate((el) => el.remove());
    }
    errors.push(...phone.motionErrors().map((e) => `frost 390 ${theme}: ${e}`));
    await phone.close();
  }

  // ── 2. transitions: the chrome keeps both snapshots; names go when they end ─
  for (const [width, height, touch] of [
    [1440, 900, false],
    [390, 844, true],
  ]) {
    const page = await openPage(browser, { width, height, touch, dpr: 1 });
    await goto(page, "/");
    await page.evaluate(() => window.scrollTo(0, 600));
    await sleep(450);
    const chrome = await page.evaluate(() =>
      [...document.querySelectorAll("[data-motion-persist]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-motion-persist")),
    );
    const { layers, during } = await frozenLayers(
      page,
      () => page.evaluate(() => document.querySelector('a[href="/support"]').click()),
      () => [
        ...chrome.flatMap((persist) => [
          [`${width}-${persist}-old`, `::view-transition-old(tt-persist-${persist})`, () => boxOf(page, `[data-motion-persist="${persist}"]`)],
          [`${width}-${persist}-new`, `::view-transition-new(tt-persist-${persist})`, () => boxOf(page, `[data-motion-persist="${persist}"]`)],
        ]),
        [`${width}-nothing-old`, "::view-transition-old(tt-no-such-layer)", () => boxOf(page, '[data-motion-persist="header"]')],
      ],
    );
    const named = during.named.map((n) => `${n.element} → ${n.name}`);
    // chrome drawn on both pages has both snapshots; chrome only on the page left has its old one
    const after = await page.evaluate(() => [...document.querySelectorAll("[data-motion-persist]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-motion-persist")));
    add(
      `transition at ${width}: the chrome (${chrome.join(", ")}) is named while it runs and has an old and a new snapshot, so it stays put`,
      during.active &&
        chrome.includes("header") &&
        chrome.every((p) => named.some((n) => n.endsWith(`tt-persist-${p}`))) &&
        chrome.every((p) => hasContent(layers[`${width}-${p}-old`]) && (!after.includes(p) || hasContent(layers[`${width}-${p}-new`]))) &&
        !hasContent(layers[`${width}-nothing-old`]),
      { named, after, layers },
    );
    await atRest(page, `/support ${width} after a page transition`);
    errors.push(...page.motionErrors().map((e) => `transition ${width}: ${e}`));
    await page.close();
  }

  // the language switch: the anchor is marked, named and captured only while it runs
  {
    const page = await openPage(browser, { width: 1440, height: 900, touch: false, dpr: 1 });
    await goto(page, "/platform/playstation");
    const hasAnchor = await page.evaluate(() => document.querySelector("[data-motion-anchor]") !== null);
    const { layers, during } = await frozenLayers(
      page,
      () => page.evaluate(() => [...document.querySelectorAll('a[hreflang^="en"]')].find((a) => a.getClientRects().length > 0).click()),
      () => [
        ["lang-anchor-old", "::view-transition-old(tt-anchor-0)", () => boxOf(page, "[data-motion-anchor]")],
        ["lang-header-old", "::view-transition-old(tt-persist-header)", () => boxOf(page, '[data-motion-persist="header"]')],
      ],
    );
    const anchorDuring = during.named.find((n) => n.name === "tt-anchor-0");
    add(
      "language switch: the on-screen anchor is marked and named tt-anchor-0 only while the switch runs, with its own old snapshot; the chrome cross-fades as its own layer",
      hasAnchor && anchorDuring !== undefined && hasContent(layers["lang-anchor-old"]) && hasContent(layers["lang-header-old"]),
      { hasAnchor, anchorDuring, layers },
    );
    const after = await namesNow(page);
    add("language switch: afterwards the marks are released and nothing is named", page.url().startsWith(ORIGIN + "/en/") && after.marks === 0 && after.named.length === 0, { url: page.url(), ...after });
    await atRest(page, "/en/platform/playstation 1440 after a language switch");
    errors.push(...page.motionErrors().map((e) => `language: ${e}`));
    await page.close();
  }

  // ── 4. the admin ─────────────────────────────────────────────────────────
  const credentials = adminCredentials();
  if (!credentials) add("admin: local demo credentials found (.dev.seed-credentials)", false, "file missing — run scripts/dev-accounts.ts");
  else {
    const context = await browser.createBrowserContext();
    for (const dark of [false, true]) {
      const theme = dark ? "dark" : "light";
      const page = await openPage(context, { width: 1440, height: 900, touch: false, dark, dpr: 1 });
      if (!dark) {
        // one sign-in for both themes (same browser context); the values are typed, never printed
        await page.goto(ORIGIN + "/admin/login", { waitUntil: "networkidle2", timeout: 60000 });
        await page.type('input[name="email"]', credentials.email);
        await page.type('input[name="password"]', credentials.password);
        await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }), page.click('form[action="/admin/login"] button[type="submit"]')]);
      }
      for (const url of ["/admin", "/admin/orders"]) {
        await page.goto(ORIGIN + url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector("html[data-motion-ready]", { timeout: 15000 }).catch(() => {});
        await sleep(400);
        const where = `${url} 1440 ${theme}`;
        const landed = new URL(page.url()).pathname;
        add(`admin ${where}: signed in and on the page`, landed === url, landed);
        await page.screenshot({ path: shot(`admin${url.replace(/\//g, "-")}-1440-${theme}`), captureBeyondViewport: false });
        await atRest(page, `admin ${where}`);
        await page.evaluate(() => window.scrollTo(0, 600));
        await sleep(300);
        await atRest(page, `admin ${where} scrolled`);
        const panes = await measurePanes(page, `admin${url.replace(/\//g, "-")}-1440-${theme}`);
        add(`admin ${where}: live glass of the chrome frosted (${panes.length} pane(s) on screen)`, panes.every((r) => frosted(r.now)), panes);
      }
      adminErrors.push(...page.motionErrors().map((e) => `admin ${theme}: ${e}`));
      await page.close();
    }
    await context.close();
  }

  // ── the resting-name rules over everything visited ────────────────────────
  add(`at rest no element that has a view-transition-name contains glass (v2 §11) — ${rest.visited.length} page states`, rest.containsGlass.length === 0, rest.containsGlass);
  add("at rest nothing carries a view-transition-name (the engine names chrome and anchors only while a transition runs)", rest.named.length === 0, rest.named.slice(0, 12));
  add("no language-switch anchor stays marked at rest", rest.marks.length === 0, rest.marks);
  add("no console errors on the storefront pages", errors.length === 0, errors.slice(0, 8));
  add("no console errors on the admin pages", adminErrors.length === 0, adminErrors.slice(0, 8));
} finally {
  await browser.close();
}
process.exitCode = report("check-glass", checks) ? 1 : 0;
