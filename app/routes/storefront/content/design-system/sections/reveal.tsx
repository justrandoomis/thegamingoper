import { Suspense } from "react";
import { Await, useLoaderData } from "react-router";

import { Bubble, BubbleGroup } from "~/motion";
import { BidiText } from "~/ui/BidiText";
import { Niche } from "~/ui/Niche";
import { Render } from "~/ui/Stage";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import type { loader } from "../../design-system";
import { DsBlock, defineCopy, useCopy, type DsSectionMeta } from "../kit";

/**
 * Content that arrives (docs/MOTION.md §4 "Bubble"): a shelf the page's loader streams (a promise it does not await),
 * behind <Suspense> with the same geometry as its fallback. On a full page load the shelf is part of the server's
 * stream and hydrates as it is — no animation classes, so no hydration mismatch. After a client navigation it
 * arrives later and inflates into the reserved space.
 */
export const section: DsSectionMeta = {
  id: "reveal",
  order: 6,
  title: { ar: "محتوى يصل بعد الصفحة", en: "Content that arrives", ckb: "ناوەڕۆکێک کە دوای پەڕەکە دێت" },
};

const COPY = defineCopy({
  ar: {
    stream: "رفّ يصل متدفّقاً",
    streamNote:
      "يرسل الخادم الصفحة أولاً ثم هذا الرفّ بعد نحو نصف ثانية (وعد لا ينتظره المحمِّل). عند فتح الصفحة كاملةً يصل الرفّ مع البثّ ويُستكمل كما هو، بلا حركة ولا اختلاف بين الخادم والمتصفح؛ وعند الوصول إليها من صفحة أخرى ينتفخ في مكانه المحجوز.",
    loading: "يُحمَّل الرفّ",
  },
  en: {
    stream: "A streamed shelf",
    streamNote:
      "The server sends the page first and this shelf about half a second later (a promise the loader does not await). On a full page load the shelf comes with the stream and hydrates as it is — no animation, nothing that differs between server and browser; when you arrive from another page, it inflates into its reserved space.",
    loading: "Loading the shelf",
  },
  ckb: {
    stream: "ڕەفێک کە بە بەردەوامی دێت",
    streamNote:
      "ڕاژەکار سەرەتا پەڕەکە دەنێرێت و نزیکەی نیو چرکە دواتر ئەم ڕەفە (بەڵێنێک کە بارکەر چاوەڕێی ناکات). کاتێک پەڕەکە بە تەواوی دەکرێتەوە، ڕەفەکە لەگەڵ ستریمەکە دێت و وەک خۆی تەواو دەبێت — بێ جووڵە و بێ جیاوازی لە نێوان ڕاژەکار و وێبگەڕدا؛ کاتێک لە پەڕەیەکی ترەوە دێیت، لە شوێنە پارێزراوەکەیدا دەئاوسێت.",
    loading: "ڕەفەکە بار دەکرێت",
  },
});

/** Example names (the page says names and prices are examples). */
const ITEMS = [
  { art: "playstation-5-pro--1", name: "PlayStation 5 Pro" },
  { art: "nintendo-switch-2--1", name: "Nintendo Switch 2" },
  { art: "xbox-series-x--1", name: "Xbox Series X" },
  { art: "steam-deck-oled--1", name: "Steam Deck OLED" },
  { art: "dualsense-edge--1", name: "DualSense Edge" },
  { art: "mario-kart-world--1", name: "Mario Kart World" },
];

const GRID = "grid grid-cols-3 gap-card sm:grid-cols-6";

export default function RevealSection() {
  const c = useCopy(COPY);
  const { reveal } = useLoaderData<typeof loader>();
  return (
    <DsBlock id="reveal-stream" title={c.stream} note={c.streamNote}>
      <Suspense fallback={<Placeholder label={c.loading} />}>
        <Await resolve={reveal}>
          {() => (
            <BubbleGroup stagger className={GRID} data-reveal="">
              {ITEMS.map((item) => (
                <Bubble key={item.art} className="grid min-w-0 gap-2">
                  <Niche as="span" ratio="1/1" tagZone={false}>
                    <Render name={item.art} alt="" sizes="120px" />
                  </Niche>
                  <span className="min-h-[2lh] type-caption text-ink">
                    <BidiText text={item.name} />
                  </span>
                </Bubble>
              ))}
            </BubbleGroup>
          )}
        </Await>
      </Suspense>
    </DsBlock>
  );
}

/** The same geometry, empty (no grey skeleton — DESIGN.md §7.2). */
function Placeholder({ label }: { label: string }) {
  return (
    <div className={GRID} aria-busy="true">
      <VisuallyHidden role="status">{label}</VisuallyHidden>
      {ITEMS.map((item) => (
        <div key={item.art} className="grid min-w-0 gap-2" aria-hidden="true">
          <Niche as="span" ratio="1/1" tagZone={false} />
          <span className="block min-h-[2lh] type-caption" />
        </div>
      ))}
    </div>
  );
}
