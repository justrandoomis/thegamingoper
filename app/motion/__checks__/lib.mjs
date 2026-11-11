// @ts-nocheck — Node-side helpers for the motion checks (run with `node`; never bundled or imported by the app).
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ORIGIN = process.env.MOTION_ORIGIN ?? "http://localhost:5173";
export const SHOTS = path.resolve(process.env.MOTION_SHOTS ?? ".shots/motion");

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  (process.env.LOCALAPPDATA || "") + "/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findBrowser() {
  const executablePath = candidates.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No Chrome/Edge found; set CHROME_PATH");
  return executablePath;
}

export async function launch(extraArgs = []) {
  mkdirSync(SHOTS, { recursive: true });
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ["--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-extensions", ...extraArgs],
  });
}

/**
 * The storefront currently logs one hydration warning on every page in development (the dev-only critical CSS
 * <link> gets a nonce on the server and none on the client — app/root.tsx, not the motion engine).
 * It is reported separately instead of failing every motion check.
 */
export const isKnownAppError = (text) => text.includes("A tree hydrated but some attributes of the server rendered HTML");

/**
 * Open a 390×844 touch page with console/page-error capture and view-transition instrumentation.
 *   page.errors            console.error + uncaught errors + failed requests
 *   page.motionErrors()    the same without the known app-level hydration warning
 *   page.vt()              every document.startViewTransition call: { start, ready, finished, skipped, nav, dir, groups }
 *   page.freezeNext()      pause the next view transition as soon as it is ready (see seek / release)
 */
export async function openPage(browser, options = {}) {
  const { width = 390, height = 844, reducedMotion = false, dark = false, touch = true, dpr = 2 } = options;
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: touch, hasTouch: touch });
  const media = [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }];
  if (reducedMotion) media.push({ name: "prefers-reduced-motion", value: "reduce" });
  await page.emulateMediaFeatures(media);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e?.message ?? e).slice(0, 400)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 400));
  });
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "";
    if (failure.includes("ERR_ABORTED")) return; // navigations cancel in-flight prefetches; not an error
    errors.push("requestfailed: " + r.url().slice(0, 200) + " " + failure);
  });
  await page.evaluateOnNewDocument(() => {
    const log = [];
    window.__vt = log;
    window.__frozen = null;
    // Registered before the router's own listener, so this is the earliest moment a Back/Forward is visible to script.
    window.addEventListener("popstate", () => (window.__popAt = performance.now()));
    const original = Document.prototype.startViewTransition;
    if (typeof original !== "function") return;
    const pseudoAnimations = () =>
      document.documentElement.getAnimations({ subtree: true }).filter((a) => String(a.effect?.pseudoElement).startsWith("::view-transition"));
    Document.prototype.startViewTransition = function (arg) {
      const entry = { start: performance.now() };
      log.push(entry);
      const transition = original.call(this, arg);
      transition.ready.then(
        // One microtask later, so that animations created by the engine's own `ready` handler are included.
        () => queueMicrotask(() => {
          entry.ready = performance.now();
          const root = document.documentElement;
          entry.nav = root.getAttribute("data-nav");
          entry.dir = root.getAttribute("data-nav-dir");
          entry.morph = root.getAttribute("data-morph");
          const animations = pseudoAnimations();
          entry.groups = [...new Set(animations.map((a) => a.effect.pseudoElement).filter((p) => p.includes("-group(")))];
          entry.animations = animations.map((a) => `${a.effect.pseudoElement} ${a.animationName ?? "waapi"}`);
          // Which keyframes drive the two root snapshots (the page animation).
          entry.root = { old: [], new: [] };
          for (const a of animations) {
            const pseudo = a.effect.pseudoElement;
            if (pseudo === "::view-transition-old(root)") entry.root.old.push(a.animationName ?? "waapi");
            if (pseudo === "::view-transition-new(root)") entry.root.new.push(a.animationName ?? "waapi");
          }
          // A persistent layer exists when its snapshot pseudo-element has a real box.
          entry.persist = getComputedStyle(root, "::view-transition-new(tt-persist-lab)").position === "absolute";
          if (window.__freezeNext) {
            window.__freezeNext = false;
            for (const a of animations) a.pause();
            const end = Math.max(...animations.map((a) => Number(a.effect.getComputedTiming().endTime) || 0));
            window.__frozen = { animations, end };
          }
        }),
        (e) => (entry.skipped = String(e?.name ?? e)),
      );
      transition.finished.then(() => (entry.finished = performance.now()));
      return transition;
    };
  });
  page.errors = errors;
  page.motionErrors = () => errors.filter((e) => !isKnownAppError(e));
  page.vt = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__vt ?? [])));
  page.clearVt = () => page.evaluate(() => void (window.__vt.length = 0));
  page.freezeNext = () => page.evaluate(() => void (window.__freezeNext = true));
  return page;
}

/** Wait until a frozen transition exists; returns its length in ms. */
export async function frozen(page) {
  await page.waitForFunction(() => window.__frozen !== null, { timeout: 15000 });
  return page.evaluate(() => window.__frozen.end);
}

/** Move a frozen transition to `progress` (0–1) of its total length. */
export async function seek(page, progress) {
  await page.evaluate((p) => {
    for (const a of window.__frozen.animations) a.currentTime = p * window.__frozen.end;
  }, progress);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Let a frozen transition run to its end. */
export async function release(page) {
  await page.evaluate(() => {
    for (const a of window.__frozen?.animations ?? []) {
      try {
        a.finish();
      } catch {}
    }
    window.__frozen = null;
  });
}

/** Freeze the transition started by `action`, screenshot it at each progress value, then release it. */
export async function captureTransition(page, name, action, steps = [0, 0.25, 0.5, 0.75, 1]) {
  await page.freezeNext();
  await action();
  const length = await frozen(page);
  const files = [];
  for (const p of steps) {
    await seek(page, Math.min(p, 0.999));
    const file = path.join(SHOTS, `${name}-${String(Math.round(p * 100)).padStart(3, "0")}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  await release(page);
  return { files, length };
}

/** Record real-time frames (CDP screencast) while `action` runs and for `tailMs` after; saves JPEGs. */
export async function record(page, name, action, tailMs = 600) {
  const client = await page.createCDPSession();
  const frames = [];
  client.on("Page.screencastFrame", (frame) => {
    frames.push({ data: frame.data, t: frame.metadata.timestamp });
    client.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await client.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  await action();
  await sleep(tailMs);
  await client.send("Page.stopScreencast");
  await client.detach();
  const files = frames.map((frame, i) => {
    const file = path.join(SHOTS, `${name}-rt-${String(i).padStart(2, "0")}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    return file;
  });
  const t0 = frames[0]?.t ?? 0;
  return { files, times: frames.map((f) => Math.round((f.t - t0) * 1000)) };
}

export async function goto(page, pathname) {
  const response = await page.goto(ORIGIN + pathname, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // <MotionRoot> marks <html data-motion-ready> once it is live (after hydration).
  await page.waitForSelector("html[data-motion-ready]", { timeout: 30000 });
  await sleep(250);
  return response;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function centre(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  await el.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await sleep(60);
  const box = await el.boundingBox();
  if (!box) throw new Error("not visible: " + selector);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Tap an element with real touch events (pointerdown → pointerup → click). Scrolls it into view first unless told not to. */
export async function tap(page, selector, { scroll = true } = {}) {
  let point;
  if (scroll) point = await centre(page, selector);
  else {
    const el = await page.waitForSelector(selector, { timeout: 10000 });
    const box = await el.boundingBox();
    if (!box) throw new Error("not visible: " + selector);
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  await page.touchscreen.tap(point.x, point.y);
  return point;
}

export const url = (page) => page.url().replace(ORIGIN, "");
export const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));
export const historyLength = (page) => page.evaluate(() => window.history.length);

/** Wait until no view transition is active and React has settled. */
export async function settled(page, extra = 120) {
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"), { timeout: 15000 });
  await sleep(extra);
}

export function report(name, checks) {
  let failed = 0;
  for (const [label, ok, detail] of checks) {
    if (!ok) failed++;
    const extra = detail === undefined ? "" : "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail));
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
  }
  console.log(`${name}: ${checks.length - failed}/${checks.length} passed\n`);
  return failed;
}
