// @ts-nocheck — node app/motion/__checks__/check-nav.mjs
// Navigation grammar on the real lab: forward / Back / Forward keep URL, history length and scroll position,
// every navigation runs exactly one view transition with the right data-nav, shared elements pair, RTL mirrors LTR.
import { captureTransition, centre, goto, historyLength, launch, openPage, record, report, scrollY, settled, sleep, tap, url } from "./lib.mjs";

const browser = await launch();
const checks = [];
const frames = {};
const add = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);
const marks = (page) => page.evaluate(() => ({ nav: document.documentElement.getAttribute("data-nav"), name: document.documentElement.style.viewTransitionName }));
const shared = (vt) => (vt?.groups ?? []).filter((g) => !g.includes("(root)") && !g.includes("tt-persist") && !/_t_/.test(g));

try {
  // ── Arabic (RTL) ────────────────────────────────────────────────────────────
  const page = await openPage(browser);
  await goto(page, "/motion?tab=flow");
  add("no view transition is started by loading or hydrating the page", (await page.vt()).length === 0, await page.vt());
  add("tier attribute is set", (await page.evaluate(() => document.documentElement.getAttribute("data-motion"))) === "full");

  await page.evaluate(() => window.scrollTo(0, 260));
  await sleep(200);
  const h0 = await historyLength(page);

  // forward: zoom into card c (frames captured from the frozen transition)
  frames.zoomForward = await captureTransition(page, "zoom-forward", () => tap(page, '[data-testid="card-c"]', { scroll: false }));
  await page.waitForSelector('[data-testid="lab-detail"][data-item="c"]');
  await settled(page);
  let vt = await page.vt();
  add("forward: exactly one view transition", vt.length === 1, vt.length);
  add("forward: data-nav=zoom, forward", vt[0]?.nav === "zoom" && vt[0]?.dir === "forward", [vt[0]?.nav, vt[0]?.dir]);
  add(
    "forward: the page animation is the two root snapshots (list lets go, page inflates behind the morph)",
    vt[0]?.root?.old.includes("tt-zoom-away") && vt[0]?.root?.old.includes("tt-fade-out") && vt[0]?.root?.new.includes("tt-zoom-in") && vt[0]?.root?.new.includes("tt-fade-in"),
    vt[0]?.root,
  );
  add("forward: one shared element pair morphs", shared(vt[0]).length === 1, shared(vt[0]));
  add("forward: lab bar is its own persistent layer", vt[0]?.persist === true, vt[0]?.persist);
  add("forward: URL", url(page) === "/motion/item/c", url(page));
  add("forward: scrolled to top", (await scrollY(page)) === 0, await scrollY(page));
  add("forward: history grew by one", (await historyLength(page)) === h0 + 1, [(await historyLength(page)) - h0]);
  add("forward: marks cleared afterwards", JSON.stringify(await marks(page)) === JSON.stringify({ nav: null, name: "" }), await marks(page));

  // browser Back
  await page.clearVt();
  frames.zoomBack = await captureTransition(page, "zoom-back", () => page.goBack());
  await page.waitForSelector('[data-testid="lab-home"]');
  await settled(page);
  vt = await page.vt();
  add("Back: exactly one view transition", vt.length === 1, vt.length);
  add("Back: data-nav=zoom, back (reverse of forward)", vt[0]?.nav === "zoom" && vt[0]?.dir === "back", [vt[0]?.nav, vt[0]?.dir]);
  add("Back: shared element morphs back into its card", shared(vt[0]).length === 1, shared(vt[0]));
  add("Back: URL", url(page) === "/motion?tab=flow", url(page));
  add("Back: scroll position restored", (await scrollY(page)) === 260, await scrollY(page));
  add("Back: history length unchanged", (await historyLength(page)) === h0 + 1, [(await historyLength(page)) - h0]);
  // React Router re-runs the list's loader on Back, so the commit happens after popstate, as an ordinary transition.
  const popToTransition = await page.evaluate((start) => Math.round(start - window.__popAt), vt[0]?.start);
  add("Back (a data navigation): React starts the view transition after popstate, once the loader has answered", popToTransition > 0 && popToTransition < 1000, popToTransition + " ms after popstate");

  // browser Forward
  await page.clearVt();
  await page.goForward();
  await page.waitForSelector('[data-testid="lab-detail"][data-item="c"]');
  await settled(page);
  vt = await page.vt();
  add("Forward: one transition, zoom forward again", vt.length === 1 && vt[0]?.nav === "zoom" && vt[0]?.dir === "forward", vt.map((v) => [v.nav, v.dir]));
  add("Forward: URL and scroll", url(page) === "/motion/item/c" && (await scrollY(page)) === 0, [url(page), await scrollY(page)]);

  // siblings by route handle order: Next → push-forward, Previous → push-back, no link props involved
  await page.clearVt();
  frames.pushForwardRtl = await captureTransition(page, "push-forward-rtl", () => tap(page, '[data-testid="detail-next"]'));
  await page.waitForSelector('[data-testid="lab-detail"][data-item="d"]');
  await settled(page);
  vt = await page.vt();
  add("Next item: push-forward chosen from handle order", vt.length === 1 && vt[0]?.nav === "push-forward", vt.map((v) => v.nav));
  await page.clearVt();
  await tap(page, '[data-testid="detail-previous"]');
  await page.waitForSelector('[data-testid="lab-detail"][data-item="c"]');
  await settled(page);
  vt = await page.vt();
  add("Previous item: push-back", vt.length === 1 && vt[0]?.nav === "push-back", vt.map((v) => v.nav));
  await page.clearVt();
  await page.goBack();
  await page.waitForSelector('[data-testid="lab-detail"][data-item="d"]');
  await settled(page);
  vt = await page.vt();
  add("Back over a push-back plays push-forward", vt.length === 1 && vt[0]?.nav === "push-forward", vt.map((v) => v.nav));

  // in-page back button uses real history Back: list returns at its scroll position
  await page.goBack(); // d → c
  await page.waitForSelector('[data-testid="lab-detail"][data-item="c"]');
  await settled(page);
  await page.clearVt();
  await tap(page, '[data-testid="detail-back"]');
  await page.waitForSelector('[data-testid="lab-home"]');
  await settled(page);
  vt = await page.vt();
  add("detail Back button: zoom back, list scroll restored", vt.length === 1 && vt[0]?.nav === "zoom" && vt[0]?.dir === "back" && (await scrollY(page)) === 260, [vt.map((v) => [v.nav, v.dir]), await scrollY(page)]);

  // tabs: plain links, direction from ?tab= order
  await page.clearVt();
  await tap(page, '[data-testid="tab-reveal"]');
  await page.waitForSelector('[data-testid="panel-reveal"]');
  await settled(page);
  vt = await page.vt();
  add("tab later in order: push-forward", vt.length === 1 && vt[0]?.nav === "push-forward", vt.map((v) => v.nav));
  await page.clearVt();
  await tap(page, '[data-testid="tab-touch"]');
  await page.waitForSelector('[data-testid="panel-touch"]');
  await settled(page);
  vt = await page.vt();
  add("tab earlier in order: push-back", vt.length === 1 && vt[0]?.nav === "push-back", vt.map((v) => v.nav));

  // rise and fade links
  await tap(page, '[data-testid="tab-flow"]');
  await page.waitForSelector('[data-testid="panel-flow"]');
  await settled(page);
  await page.clearVt();
  frames.rise = await captureTransition(page, "rise", () => tap(page, '[data-testid="link-rise"]'));
  await page.waitForSelector('[data-testid="lab-detail"][data-item="d"]');
  await settled(page);
  vt = await page.vt();
  add("MotionLink nav=rise", vt.length === 1 && vt[0]?.nav === "rise" && vt[0]?.dir === "forward", vt.map((v) => [v.nav, v.dir]));
  await page.clearVt();
  await page.goBack();
  await page.waitForSelector('[data-testid="lab-home"]');
  await settled(page);
  vt = await page.vt();
  add("Back over rise: rise, back", vt.length === 1 && vt[0]?.nav === "rise" && vt[0]?.dir === "back", vt.map((v) => [v.nav, v.dir]));
  await page.clearVt();
  await tap(page, '[data-testid="link-fade"]');
  await page.waitForSelector('[data-testid="lab-detail"][data-item="e"]');
  await settled(page);
  vt = await page.vt();
  add("MotionLink nav=fade", vt.length === 1 && vt[0]?.nav === "fade", vt.map((v) => v.nav));
  await page.goBack();
  await page.waitForSelector('[data-testid="lab-home"]');
  await settled(page);

  // hash state (#viewer → #viewer-2): no data is needed, so React Router finishes Back synchronously inside popstate.
  // React alone would commit that without a view transition; the pop gate keeps it.
  // centre the opener first and tap without scrolling: Back must return to exactly where the shopper was
  await centre(page, '[data-testid="viewer-open"]');
  const before = await scrollY(page);
  await page.clearVt();
  await tap(page, '[data-testid="viewer-open"]', { scroll: false });
  await page.waitForSelector('[data-testid="viewer"][data-slide="0"]');
  await settled(page);
  vt = await page.vt();
  add("open #viewer: rise forward, URL has the hash", vt.length === 1 && vt[0]?.nav === "rise" && url(page) === "/motion?tab=flow#viewer", [vt.map((v) => v.nav), url(page)]);
  await page.clearVt();
  await tap(page, '[data-testid="viewer-next"]');
  await page.waitForSelector('[data-testid="viewer"][data-slide="1"]');
  await settled(page);
  vt = await page.vt();
  add("#viewer → #viewer-2: push-forward", vt.length === 1 && vt[0]?.nav === "push-forward" && url(page) === "/motion?tab=flow#viewer-2", [vt.map((v) => v.nav), url(page)]);
  await page.clearVt();
  // Measured inside the page: from the popstate event to the DOM change that shows the first picture again.
  await page.evaluate(() => {
    window.__gate = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="viewer"][data-slide="0"]')) return;
        observer.disconnect();
        resolve(performance.now() - window.__popAt);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-slide"] });
    });
  });
  await page.goBack();
  const gateMs = Math.round(await page.evaluate(() => window.__gate));
  await settled(page);
  vt = await page.vt();
  add("Back #viewer-2 → #viewer (synchronous popstate): still one view transition, push-back", vt.length === 1 && vt[0]?.nav === "push-back", vt.map((v) => [v.nav, v.dir]));
  add("synchronous Back: DOM updated within 100 ms of popstate", gateMs < 100, gateMs + " ms");
  await page.clearVt();
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('[data-testid="viewer"]'));
  await settled(page);
  vt = await page.vt();
  add("Back from #viewer: rise back, URL and scroll kept", vt.length === 1 && vt[0]?.nav === "rise" && vt[0]?.dir === "back" && url(page) === "/motion?tab=flow" && (await scrollY(page)) === before, [vt.map((v) => [v.nav, v.dir]), url(page), await scrollY(page), before]);

  // real-time frames of one navigation (not frozen), to look at
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(150);
  await page.clearVt();
  frames.realtime = await record(page, "zoom-realtime", () => tap(page, '[data-testid="card-a"]', { scroll: false }), 700);
  await page.waitForSelector('[data-testid="lab-detail"][data-item="a"]');
  await settled(page);
  vt = await page.vt();
  const played = Math.round(vt[0].finished - vt[0].ready);
  // The longest pieces are the `settle` spring (410 ms): the shared element's morph and the page settling behind it.
  add("an undisturbed card → page transition plays its full length, ≈ 410 ms (nothing hurries or cuts it)", vt.length === 1 && played >= 380 && played <= 520, played + " ms");

  add("no console errors (Arabic run)", page.motionErrors().length === 0, page.motionErrors());
  const knownApp = page.errors.length - page.motionErrors().length;
  await page.close();

  // ── English (LTR): the same push is mirrored ───────────────────────────────
  const en = await openPage(browser);
  await goto(en, "/en/motion/item/c");
  const push = async (p, selector) => {
    await p.freezeNext();
    await tap(p, selector);
    await p.waitForFunction(() => window.__frozen !== null, { timeout: 15000 });
    await p.evaluate(() => {
      for (const a of window.__frozen.animations) a.currentTime = 0;
    });
    const tx = await p.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.documentElement, "::view-transition-new(root)").transform).m41);
    await p.evaluate(() => {
      for (const a of window.__frozen.animations) a.finish();
      window.__frozen = null;
    });
    await settled(p);
    return Math.round(tx);
  };
  const ltrStart = await push(en, '[data-testid="detail-next"]');
  add("LTR push-forward: the next page enters 24px from the inline end (the right)", ltrStart === 24, ltrStart);
  add("no console errors (English run)", en.motionErrors().length === 0, en.motionErrors());
  await en.close();

  const ar = await openPage(browser);
  await goto(ar, "/motion/item/c");
  const rtl = await push(ar, '[data-testid="detail-next"]');
  add("RTL push-forward: the next page enters 24px from the inline end (the left)", rtl === -24, rtl);

  // deep link: no history to go back to → the Back link navigates with its own zoom-back intent
  await goto(ar, "/motion/item/b");
  await ar.clearVt();
  await tap(ar, '[data-testid="detail-back"]');
  await ar.waitForSelector('[data-testid="lab-home"]');
  await settled(ar);
  vt = await ar.vt();
  add("deep link: Back link pushes with zoom, back", vt.length === 1 && vt[0]?.nav === "zoom" && vt[0]?.dir === "back" && url(ar) === "/motion?tab=flow", [vt.map((v) => [v.nav, v.dir]), url(ar)]);
  await ar.close();

  console.log("frames:", JSON.stringify({ ...frames, realtime: { count: frames.realtime.files.length, times: frames.realtime.times } }, null, 1));
  if (knownApp > 0) console.log(`note: ${knownApp} known app-level hydration warning(s) ignored (critical CSS nonce, app/root.tsx)`);
} finally {
  await browser.close();
}
process.exitCode = report("check-nav", checks) ? 1 : 0;
