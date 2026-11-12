/**
 * Overlay, navigation and state primitives (app/ui) — the pure logic only: the toast store (queue, importance,
 * clock, holds), the toast payload adapter, menu placement and typeahead, the pagination window, DataTable
 * selection, the Blocks parser (against the demo seed's real articles) and the breadcrumb JSON-LD.
 * Rendering and interaction are verified in a browser (docs/ui/overlays.md "Verifying").
 */
import { describe, expect, it } from "vitest";

import { DEMO_ARTICLES } from "~/server/db/seed/demo/knowledge";
import { localizeBlocks } from "~/server/db/seed/demo/blocks";
import { parseBlocks, toBlock, type Block } from "~/ui/Blocks";
import { breadcrumbJsonLd } from "~/ui/Breadcrumbs";
import { pageSelection, toggleAllOnPage, toggleOne, toggleRange } from "~/ui/DataTable";
import { placeMenu, typeaheadIndex } from "~/ui/Menu";
import { pageWindow, showMoreVisible } from "~/ui/Pagination";
import { createToastStore, toastFromPayload, toastRank, type ToastTimers } from "~/ui/toast-store";

/** A clock the test moves by hand. */
function manualTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: ToastTimers = {
    set: (run, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { timers, advance, pending: () => pending.size };
}

describe("toast store", () => {
  it("shows one toast at a time; a new one of equal importance replaces it", () => {
    const store = createToastStore({ timers: manualTimers().timers });
    store.show({ kind: "info", title: "a" });
    store.show({ kind: "success", title: "b" });
    expect(store.getState().current?.title).toBe("b");
    expect(store.getState().queue).toHaveLength(0);
  });

  it("a less important toast waits behind a more important one, and shows when it is dismissed", () => {
    const store = createToastStore({ timers: manualTimers().timers });
    const error = store.show({ kind: "error", title: "failed" });
    store.show({ kind: "cart", title: "added", name: "Xbox Series X" });
    expect(store.getState().current?.kind).toBe("error");
    expect(store.getState().queue.map((t) => t.kind)).toEqual(["cart"]);
    store.dismiss(error);
    expect(store.getState().current?.kind).toBe("cart");
  });

  it("ranks error > warning > info, success and cart", () => {
    expect(toastRank("error")).toBeGreaterThan(toastRank("warning"));
    expect(toastRank("warning")).toBeGreaterThan(toastRank("info"));
    expect(toastRank("info")).toBe(toastRank("success"));
    expect(toastRank("success")).toBe(toastRank("cart"));
  });

  it("keeps at most `limit` toasts waiting, dropping the oldest", () => {
    const store = createToastStore({ limit: 2, timers: manualTimers().timers });
    store.show({ kind: "error", title: "e" });
    for (const title of ["1", "2", "3"]) store.show({ kind: "info", title });
    expect(store.getState().queue.map((t) => t.title)).toEqual(["2", "3"]);
  });

  it("the most important waiting toast goes next, the oldest among equals", () => {
    const store = createToastStore({ timers: manualTimers().timers });
    const first = store.show({ kind: "error", title: "e1" });
    store.show({ kind: "info", title: "i" });
    store.show({ kind: "warning", title: "w" });
    store.dismiss(first);
    expect(store.getState().current?.title).toBe("w");
    store.dismiss(store.getState().current!.id);
    expect(store.getState().current?.title).toBe("i");
  });

  it("the same id updates in place: new content, announced again (revision), its clock restarts", () => {
    const clock = manualTimers();
    const store = createToastStore({ timers: clock.timers });
    const detach = store.attach();
    store.show({ id: "cart", kind: "cart", name: "A" });
    clock.advance(3000);
    store.show({ id: "cart", kind: "cart", name: "B" });
    expect(store.getState().current).toMatchObject({ name: "B", revision: 1 });
    clock.advance(3000);
    expect(store.getState().current?.name).toBe("B"); // 6 s since the first, 3 s since the update
    clock.advance(1000);
    expect(store.getState().current).toBeNull();
    detach();
  });

  it("leaves after 4 s, but only while a toaster shows it and nothing holds it", () => {
    const clock = manualTimers();
    const store = createToastStore({ timers: clock.timers });
    store.show({ kind: "info", title: "x" });
    clock.advance(10_000);
    expect(store.getState().current?.title).toBe("x"); // no toaster attached: the clock never ran
    const detach = store.attach();
    clock.advance(1000);
    store.hold("hover");
    clock.advance(10_000);
    expect(store.getState().current?.title).toBe("x"); // paused while hovered
    store.hold("focus");
    store.release("hover");
    clock.advance(10_000);
    expect(store.getState().current?.title).toBe("x"); // still focused
    store.release("focus");
    clock.advance(2999);
    expect(store.getState().current?.title).toBe("x"); // 1 s + 2.999 s
    clock.advance(1);
    expect(store.getState().current).toBeNull();
    detach();
  });

  it("an Infinity duration stays until it is dismissed", () => {
    const clock = manualTimers();
    const store = createToastStore({ timers: clock.timers });
    const detach = store.attach();
    const id = store.show({ kind: "warning", title: "sticky", duration: Infinity });
    clock.advance(60_000);
    expect(store.getState().current?.id).toBe(id);
    expect(clock.pending()).toBe(0);
    store.dismiss();
    expect(store.getState()).toEqual({ current: null, queue: [] });
    detach();
  });

  it("dismissing a waiting toast removes it without touching the visible one", () => {
    const store = createToastStore({ timers: manualTimers().timers });
    store.show({ kind: "error", title: "e" });
    const waiting = store.show({ kind: "info", title: "i" });
    store.dismiss(waiting);
    expect(store.getState().current?.title).toBe("e");
    expect(store.getState().queue).toHaveLength(0);
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const store = createToastStore({ timers: manualTimers().timers });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.show({ kind: "info", title: "a" });
    store.dismiss();
    off();
    store.show({ kind: "info", title: "b" });
    expect(calls).toBe(2);
  });
});

describe("toast payload (the shape app/ui/cart-client.ts sends)", () => {
  it("maps tone, detail, action and an art thumbnail", () => {
    const onAction = () => {};
    expect(
      toastFromPayload({ tone: "success", title: "أُضيف إلى السلة", detail: "Xbox Series X · 1TB", image: { artKey: "xbox-series-x--1", mediaKey: null }, action: { label: "تراجع", onAction } }),
    ).toEqual({ kind: "success", title: "أُضيف إلى السلة", detail: "Xbox Series X · 1TB", art: "xbox-series-x--1", action: { label: "تراجع", onAction, href: undefined } });
  });

  it("uses the uploaded file when there is no art key, and maps warn to warning", () => {
    expect(toastFromPayload({ tone: "warn", title: "t", image: { artKey: null, mediaKey: "pub_a1.webp", width: 640, height: 480 } })).toEqual({
      kind: "warning",
      title: "t",
      image: { src: "/media/pub_a1.webp", width: 640, height: 480 },
    });
    expect(toastFromPayload({ title: "t", detail: null, image: null, action: null })).toEqual({ kind: "info", title: "t" });
  });
});

describe("menu placement", () => {
  const viewport = { width: 390, height: 844 };
  const size = { width: 220, height: 200 };

  it("opens below the trigger, its inline-start edge on the trigger's (LTR: left edges)", () => {
    const place = placeMenu({ top: 100, bottom: 144, left: 16, right: 60 }, size, viewport, { rtl: false, align: "start" });
    expect(place).toEqual({ inlineStart: 16, blockStart: 150, maxHeight: 686, above: false });
  });

  it("in RTL the inline-start edge is the right edge, measured from the right of the viewport", () => {
    const place = placeMenu({ top: 100, bottom: 144, left: 330, right: 374 }, size, viewport, { rtl: true, align: "start" });
    expect(place.inlineStart).toBe(390 - 374); // the menu's right edge on the trigger's right edge
    expect(place.above).toBe(false);
  });

  it("align end meets the other edges, and stays 8px inside the viewport", () => {
    const ltr = placeMenu({ top: 100, bottom: 144, left: 16, right: 60 }, size, viewport, { rtl: false, align: "end" });
    expect(ltr.inlineStart).toBe(8); // would start at 60 − 220 < 8: pushed back in
    const rtl = placeMenu({ top: 100, bottom: 144, left: 16, right: 60 }, size, viewport, { rtl: true, align: "end" });
    expect(390 - rtl.inlineStart - 220).toBe(16); // its left edge on the trigger's left edge
  });

  it("goes above when there is not enough room below and more above", () => {
    const place = placeMenu({ top: 700, bottom: 744, left: 16, right: 60 }, size, viewport, { rtl: false, align: "start" });
    expect(place.above).toBe(true);
    expect(place.blockStart).toBe(700 - 6 - 200);
    expect(place.maxHeight).toBe(700 - 6 - 8);
  });

  it("caps its height to the room it has", () => {
    const place = placeMenu({ top: 300, bottom: 344, left: 16, right: 60 }, { width: 220, height: 2000 }, viewport, { rtl: false, align: "start" });
    expect(place.above).toBe(false);
    expect(place.maxHeight).toBe(844 - 8 - 350);
  });
});

describe("menu typeahead", () => {
  const rows = ["Edit the order", "Copy the tracking link", null, "Cancel the order", "Print the invoice"];

  it("jumps to the next row starting with the letter, cycling on repeats", () => {
    expect(typeaheadIndex(rows, 0, "c")).toBe(1);
    expect(typeaheadIndex(rows, 1, "c")).toBe(3);
    expect(typeaheadIndex(rows, 3, "c")).toBe(1); // wraps
    expect(typeaheadIndex(rows, 1, "cc")).toBe(3); // the same letter again = the next one
  });

  it("matches a typed word from the current row, case-insensitively, and skips separators", () => {
    expect(typeaheadIndex(rows, 3, "CAN")).toBe(3);
    expect(typeaheadIndex(rows, -1, "print")).toBe(4);
    expect(typeaheadIndex(rows, 0, "z")).toBe(-1);
    expect(typeaheadIndex(rows, 0, " ")).toBe(-1);
  });

  it("works with Arabic and Sorani labels (no case)", () => {
    const ar = ["عدّل الطلب", "انسخ رابط التتبّع", "اطبع الفاتورة", "ألغِ الطلب"];
    expect(typeaheadIndex(ar, 3, "ا")).toBe(1);
    expect(typeaheadIndex(ar, 1, "ا")).toBe(2);
    expect(typeaheadIndex(ar, 0, "أل")).toBe(3);
    expect(typeaheadIndex(["دەستکاری بکە", "پسوولە چاپ بکە"], 0, "پ")).toBe(1);
  });
});

describe("pagination window", () => {
  it("keeps seven slots wherever the current page is", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(6, 20)).toEqual([1, "gap", 5, 6, 7, "gap", 20]);
    expect(pageWindow(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  it("shows every page when they fit, and never hides a single page behind a gap", () => {
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(1, 1)).toEqual([1]);
    for (let count = 1; count <= 30; count++) {
      for (let page = 1; page <= count; page++) {
        const slots = pageWindow(page, count);
        expect(slots).toContain(page);
        const numbers = slots.filter((s): s is number => s !== "gap");
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b)); // ascending
        slots.forEach((slot, i) => {
          if (slot === "gap") expect((slots[i + 1] as number) - (slots[i - 1] as number)).toBeGreaterThan(2);
        });
      }
    }
  });

  it("clamps a page out of range and rejects nonsense counts", () => {
    expect(pageWindow(99, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(-4, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([]);
    expect(pageWindow(1, Number.NaN)).toEqual([]);
  });

  it("widens with more siblings", () => {
    expect(pageWindow(10, 20, 2)).toEqual([1, "gap", 8, 9, 10, 11, 12, "gap", 20]);
  });
});

describe("show more (§4.22)", () => {
  it("says nothing under a list that fits on its first page — no «عرضنا 1 من منتج واحد» under one card", () => {
    expect(showMoreVisible({ shown: 1, total: 1, step: 24, canLoad: false })).toBe(false);
    expect(showMoreVisible({ shown: 24, total: 24, step: 24, canLoad: false })).toBe(false);
    expect(showMoreVisible({ shown: 0, total: 0, step: 24, canLoad: false })).toBe(false);
    expect(showMoreVisible({ shown: 0, total: 0, canLoad: false })).toBe(false);
  });

  it("counts and offers the next page while there is one, and says «لا يوجد المزيد» after paging to the end", () => {
    expect(showMoreVisible({ shown: 24, total: 42, step: 24, canLoad: true })).toBe(true);
    expect(showMoreVisible({ shown: 42, total: 42, step: 24, canLoad: false })).toBe(true);
    // a cursor list that does not know its total, and a list without a page size, keep their row
    expect(showMoreVisible({ shown: 12, total: null, canLoad: true })).toBe(true);
    expect(showMoreVisible({ shown: 3, total: 3, canLoad: false })).toBe(true);
  });
});

describe("DataTable selection", () => {
  const page = ["a", "b", "c", "d"];

  it("says whether all, some or none of the page is selected", () => {
    expect(pageSelection([], page)).toBe("none");
    expect(pageSelection(["b", "x"], page)).toBe("some");
    expect(pageSelection(["a", "b", "c", "d", "x"], page)).toBe("all");
    expect(pageSelection(["a"], [])).toBe("none");
  });

  it("toggles one id, keeping the order of the rest", () => {
    expect(toggleOne(["x", "a"], "b", true)).toEqual(["x", "a", "b"]);
    expect(toggleOne(["x", "a", "b"], "a", false)).toEqual(["x", "b"]);
    expect(toggleOne(["a"], "a", true)).toEqual(["a"]);
  });

  it("shift-click sets the whole range, in either direction", () => {
    expect(toggleRange(["x"], page, "b", "d", true)).toEqual(["x", "b", "c", "d"]);
    expect(toggleRange(["a", "b", "c", "d"], page, "c", "a", false)).toEqual(["d"]);
    expect(toggleRange([], page, "zzz", "c", true)).toEqual(["c"]); // anchor not on this page: just the row
  });

  it("the page box selects the page, or clears it when it is all selected; other pages untouched", () => {
    expect(toggleAllOnPage(["x", "b"], page)).toEqual(["x", "a", "b", "c", "d"]);
    expect(toggleAllOnPage(["x", "a", "b", "c", "d"], page)).toEqual(["x"]);
  });
});

describe("Blocks parser", () => {
  it("accepts every block of every demo article in all three languages, unchanged", () => {
    let total = 0;
    for (const article of DEMO_ARTICLES) {
      const localized = localizeBlocks(article.blocks);
      for (const locale of ["ar", "en", "ckb"] as const) {
        const raw = localized[locale] ?? [];
        const parsed = parseBlocks(raw);
        expect(parsed, `${article.slug} (${locale})`).toEqual(raw);
        total += parsed.length;
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it("covers all seven block types with the seed's exact shapes", () => {
    const blocks: Block[] = [
      { type: "h2", text: "عنوان" },
      { type: "p", text: "فقرة" },
      { type: "ul", items: ["أ", "ب"] },
      { type: "ol", items: ["1"] },
      { type: "steps", items: [{ title: "افصل الكهرباء", text: "دقيقة كاملة" }, { title: "جرّب كيبلاً آخر" }] },
      { type: "callout", tone: "danger", title: "توقف", text: "رائحة احتراق" },
      { type: "callout", tone: "info", text: "خطوات آمنة" },
      { type: "table", head: ["المؤشر", "المعنى"], rows: [["أبيض", "يعمل"]] },
      { type: "art", name: "playstation-5-slim--1", alt: "PlayStation 5 Slim" },
    ];
    expect(parseBlocks(blocks)).toEqual(blocks);
  });

  it("drops what is malformed, unknown or not text — it never renders markup", () => {
    expect(toBlock({ type: "html", html: "<script>alert(1)</script>" })).toBeNull();
    expect(toBlock({ type: "p", text: { __html: "<b>x</b>" } })).toBeNull();
    expect(toBlock({ type: "p", text: "  " })).toBeNull();
    expect(toBlock({ type: "ul", items: ["a", 2] })).toBeNull();
    expect(toBlock({ type: "ul", items: [] })).toBeNull();
    expect(toBlock({ type: "steps", items: [{ text: "no title" }] })).toBeNull();
    expect(toBlock({ type: "callout", tone: "red", text: "x" })).toBeNull();
    expect(toBlock({ type: "callout", tone: "info", title: 5, text: "x" })).toBeNull();
    expect(toBlock({ type: "table", head: ["a"], rows: [[1]] })).toBeNull();
    expect(toBlock({ type: "art", name: "", alt: "x" })).toBeNull();
    expect(toBlock(null)).toBeNull();
    expect(toBlock("p")).toBeNull();
    expect(parseBlocks({ type: "p", text: "not an array" })).toEqual([]);
    expect(parseBlocks([{ type: "p", text: "kept" }, { type: "x" }, null])).toEqual([{ type: "p", text: "kept" }]);
  });

  it("copies what it keeps (the renderer never holds a reference to the stored object)", () => {
    const stored = { type: "ul", items: ["a"] };
    const [block] = parseBlocks([stored]);
    (stored.items as string[]).push("injected later");
    expect(block).toEqual({ type: "ul", items: ["a"] });
  });
});

describe("breadcrumb JSON-LD", () => {
  it("lists the crumbs with absolute URLs in the page's language; the current page may have no URL", () => {
    const json = JSON.parse(
      breadcrumbJsonLd([{ label: "Home", href: "/" }, { label: "Consoles", href: "/c/consoles" }, { label: "PlayStation 5 Pro" }], "https://tamtamgames.com", "en"),
    );
    expect(json).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://tamtamgames.com/en" },
        { "@type": "ListItem", position: 2, name: "Consoles", item: "https://tamtamgames.com/en/c/consoles" },
        { "@type": "ListItem", position: 3, name: "PlayStation 5 Pro" },
      ],
    });
    const ar = JSON.parse(breadcrumbJsonLd([{ label: "الرئيسية", href: "/" }], "https://tamtamgames.com", "ar"));
    expect(ar.itemListElement[0].item).toBe("https://tamtamgames.com/");
  });

  it("cannot close the script element or start markup: < > & and line separators are escaped", () => {
    const out = breadcrumbJsonLd([{ label: `</script><img src=x onerror=alert(1)> & ${String.fromCharCode(0x2028)}` }], "https://tamtamgames.com", "ar");
    expect(out).not.toMatch(new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`));
    expect(JSON.parse(out).itemListElement[0].name).toBe(`</script><img src=x onerror=alert(1)> & ${String.fromCharCode(0x2028)}`);
  });
});
